import test from "node:test";
import assert from "node:assert/strict";
import {
  updateFixture,
  signingFixture,
  fixtureFetcher,
} from "./helpers/update-fixtures.js";
import {
  candidates,
  verifyManifest,
  compatible,
  digest,
  artifactName,
} from "../desktop/updater/manifest.js";
import {
  ReleaseDiscovery,
  fetchBounded,
  authorizedURL,
} from "../desktop/updater/network.js";

test("semantic upgrades independently select stable and preview, including preview-to-stable transitions", async () => {
  const signer = signingFixture(),
    versions = [
      ["1.0.4", "stable"],
      ["1.1.0-dev.5", "experimental"],
      ["1.1.0", "stable"],
      ["1.1.1", "stable"],
      ["1.2.0-dev.1", "experimental"],
      ["1.2.0", "stable"],
    ];
  const fixtures = versions.map(([v, c]) => updateFixture(v, c, signer));
  let found = await new ReleaseDiscovery({
    keys: signer.keys,
    installed: "1.1.0-dev.5",
    fetcher: fixtureFetcher(fixtures.slice(0, -1)),
  }).check();
  assert.equal(found.stable.manifest.version, "1.1.1");
  assert.equal(found.experimental.manifest.version, "1.2.0-dev.1");
  found = await new ReleaseDiscovery({
    keys: signer.keys,
    installed: "1.2.0-dev.1",
    fetcher: fixtureFetcher(fixtures),
  }).check();
  assert.equal(found.stable.manifest.version, "1.2.0");
  assert.equal(found.experimental, null);
  found = await new ReleaseDiscovery({
    keys: signer.keys,
    installed: "1.2.0",
    fetcher: fixtureFetcher(fixtures),
  }).check();
  assert.deepEqual(found, { stable: null, experimental: null });
});
test("numeric semver is not alphabetical; older stable never downgrades a newer preview", () => {
  const f = ["1.9.0", "1.10.0", "1.2.0"].map((v) => updateFixture(v));
  assert.deepEqual(
    candidates(
      f.map((f) => f.release),
      "1.0.0",
    ).map((r) => r.tag_name),
    ["v1.10.0", "v1.9.0", "v1.2.0"],
  );
  assert.equal(
    candidates([updateFixture("1.0.4").release], "1.1.0-dev.5").length,
    0,
  );
  assert.throws(() => candidates([], "garbage"));
});
test("GitHub prerelease metadata cannot produce a green stable update", () => {
  const f = updateFixture();
  f.release.prerelease = true;
  assert.throws(
    () => verifyManifest(Buffer.from(f.envelope), f.keys, f.release),
    /eligible/,
  );
  const p = updateFixture("2.0.0", "experimental");
  assert.equal(
    verifyManifest(Buffer.from(p.envelope), p.keys, p.release).channel,
    "experimental",
  );
});
test("drafts, superseded previews, missing marker and missing either platform package are not installable", async () => {
  for (const change of [
    (f) => (f.release.draft = true),
    (f) => (f.release.name = "Superseded; no installers"),
    (f) => f.release.assets.pop(),
    (f) =>
      (f.release.assets = f.release.assets.filter(
        (a) => a.name !== artifactName("2.0.0", "win32"),
      )),
  ]) {
    const f = updateFixture();
    change(f);
    const found = await new ReleaseDiscovery({
      keys: f.keys,
      installed: "1.0.0",
      fetcher: fixtureFetcher([f]),
    }).check();
    assert.deepEqual(found, { stable: null, experimental: null });
  }
});
test("signatures, signing keys, repository identity, channel and compatibility fail closed", () => {
  const f = updateFixture();
  assert.equal(
    verifyManifest(Buffer.from(f.envelope), f.keys, f.release).version,
    "2.0.0",
  );
  const changed = JSON.parse(f.envelope);
  changed.payload = Buffer.from("{}").toString("base64");
  assert.throws(() =>
    verifyManifest(Buffer.from(JSON.stringify(changed)), f.keys),
  );
  assert.throws(() => verifyManifest(Buffer.from(f.envelope), {}));
  for (const change of [
    (m) => (m.repository = "attacker/repo"),
    (m) => (m.files[0].name = "../../bad.exe"),
    (m) => m.files.push(m.files[0]),
    (m) => (m.compatibility.collaboration = 999),
    (m) => {
      m.version = "2.0.0-dev.1";
      m.tag = "v2.0.0-dev.1";
    },
  ]) {
    const value = structuredClone(f.manifest);
    change(value);
    assert.throws(() =>
      verifyManifest(Buffer.from(f.envelopeFor(value)), f.keys, f.release),
    );
  }
  assert.equal(compatible(f.manifest, 3), false);
});
test("signed metadata bytes and GitHub artifact digests must match before notification", async () => {
  const f = updateFixture();
  f.bytes.set("latest.yml", Buffer.from("tampered"));
  assert.deepEqual(
    await new ReleaseDiscovery({
      keys: f.keys,
      installed: "1.0.0",
      fetcher: fixtureFetcher([f]),
    }).check(),
    { stable: null, experimental: null },
  );
  const g = updateFixture();
  g.release.assets[0].digest = "sha256:" + "0".repeat(64);
  assert.throws(() =>
    verifyManifest(Buffer.from(g.envelope), g.keys, g.release),
  );
});
test("HTTPS origin restrictions, redirect bounds, response bounds and rate limits are enforced", async () => {
  for (const url of [
    "http://github.com/x",
    "https://attacker.example/x",
    "https://github.com:444/x",
    "https://user@github.com/x",
  ])
    assert.throws(() => authorizedURL(url));
  await assert.rejects(
    fetchBounded("https://github.com/x", {
      limit: 4,
      fetcher: async () => new Response("long response"),
    }),
    /large/,
  );
  await assert.rejects(
    fetchBounded("https://github.com/x", {
      fetcher: async () =>
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/x" },
        }),
    }),
    /Untrusted/,
  );
  await assert.rejects(
    fetchBounded("https://github.com/x", {
      fetcher: fixtureFetcher([], { failure: 429 }),
    }),
    /limited/,
  );
});
test("ETag checks reuse cached JSON only for a real 304, and confirmation can detect withdrawal", async () => {
  const f = updateFixture();
  let requests = 0;
  const real = fixtureFetcher([f]);
  const fetcher = async (url, options) => {
    if (
      String(url).includes("api.github.com") &&
      options.headers["If-None-Match"]
    ) {
      requests++;
      return new Response(null, { status: 304 });
    }
    return real(url, options);
  };
  const d = new ReleaseDiscovery({ keys: f.keys, installed: "1.0.0", fetcher });
  await d.check();
  await d.check();
  assert.ok(requests >= 2);
  f.release.name = "Withdrawn";
  d.fetcher = real;
  d.cache.clear();
  await assert.rejects(d.validate(f), /eligible/);
});
