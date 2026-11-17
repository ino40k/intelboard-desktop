import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { publishUpdate } from "../scripts/publish-update.js";
import { verifyManifest, digest } from "../desktop/updater/manifest.js";
import { updateFixture } from "./helpers/update-fixtures.js";

const signer = fileURLToPath(
  new URL("../scripts/sign-updates.js", import.meta.url),
);
function setup(t, version = "2.0.0") {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "intelboard-release-unit-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = updateFixture(
    version,
    version.includes("-") ? "experimental" : "stable",
  );
  fs.mkdirSync(path.join(root, "desktop/updater"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "desktop/updater/trusted-keys.json"),
    JSON.stringify(f.keys),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version }),
  );
  const directory = path.join(root, "installers");
  fs.mkdirSync(directory);
  for (const [name, b] of f.bytes)
    fs.writeFileSync(path.join(directory, name), b);
  for (const suffix of ["", "-linux"]) {
    const from =
      (version.includes("-") ? "experimental" : "latest") + suffix + ".yml";
    const to =
      (version.includes("-") ? "latest" : "experimental") + suffix + ".yml";
    fs.copyFileSync(path.join(directory, from), path.join(directory, to));
  }
  const zip = `IntelBoard-${version}-dependency-sources.zip`;
  fs.writeFileSync(
    path.join(directory, zip),
    "synthetic license sources archive",
  );
  for (const name of [...f.bytes.keys()]
    .filter((n) => /\.(exe|AppImage)$/.test(n))
    .concat(zip))
    fs.writeFileSync(
      path.join(directory, name + ".sha256"),
      `${digest(fs.readFileSync(path.join(directory, name)))}  ${name}\n`,
    );
  const env = {
    ...process.env,
    INTELBOARD_UPDATE_SIGNING_KEY: f.privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
  };
  delete env.GITHUB_EVENT_PATH;
  delete env.INTELBOARD_PACKAGE_VERSION;
  const sign = (overrides = {}) =>
    spawnSync(process.execPath, [signer, directory], {
      cwd: root,
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
  return { root, directory, f, sign };
}
function fakeGitHub(
  { directory, manifest },
  {
    badDigest = false,
    failUpload = false,
    committed = false,
    prerelease = false,
  } = {},
) {
  const calls = [],
    marker = fs.readFileSync(path.join(directory, "intelboard-update.json"));
  const assets = manifest.files.map((f) => ({
    name: f.name,
    size: f.size,
    digest: "sha256:" + f.sha256,
  }));
  let uploaded = committed;
  const gh = (...args) => {
    calls.push(args);
    if (args[1] === "view")
      return JSON.stringify({
        tagName: manifest.tag,
        isDraft: false,
        isPrerelease: prerelease,
        assets: uploaded
          ? [
              ...assets.map((a, i) =>
                badDigest && i === 0 ? { ...a, digest: "sha256:bad" } : a,
              ),
              ...(committed ? [{ name: "intelboard-update.json" }] : []),
            ]
          : [],
      });
    if (args[1] === "download") return marker;
    if (args[1] === "upload") {
      if (failUpload) throw Error("simulated upload failure");
      uploaded = true;
      return "";
    }
    throw Error("Unexpected test call");
  };
  return { calls, gh };
}
test("production signing validates both installers, every alias and checksums; stable and preview markers verify", (t) => {
  for (const version of ["2.0.0", "2.1.0-dev.1"]) {
    const s = setup(t, version),
      result = s.sign();
    assert.equal(result.status, 0, result.stderr);
    const manifest = verifyManifest(
      fs.readFileSync(path.join(s.directory, "intelboard-update.json")),
      s.f.keys,
    );
    assert.equal(manifest.version, version);
    assert.equal(
      manifest.channel,
      version.includes("-") ? "experimental" : "stable",
    );
  }
});
test("signing fails closed for missing key/platform, altered metadata or checksum, and mismatched release tag", (t) => {
  const missingKey = setup(t);
  assert.notEqual(
    missingKey.sign({ INTELBOARD_UPDATE_SIGNING_KEY: "" }).status,
    0,
  );
  for (const kind of ["platform", "metadata", "checksum", "event"]) {
    const s = setup(t);
    if (kind === "platform")
      fs.rmSync(path.join(s.directory, "IntelBoard-2.0.0-win-x64.exe"));
    if (kind === "metadata")
      fs.writeFileSync(path.join(s.directory, "experimental-linux.yml"), "{}");
    if (kind === "checksum")
      fs.writeFileSync(
        path.join(s.directory, "IntelBoard-2.0.0-win-x64.exe.sha256"),
        "bad",
      );
    const event = path.join(s.root, "event.json");
    fs.writeFileSync(
      event,
      JSON.stringify({ release: { tag_name: "v9.0.0", draft: false } }),
    );
    assert.notEqual(
      s.sign(kind === "event" ? { GITHUB_EVENT_PATH: event } : {}).status,
      0,
    );
    assert.equal(
      fs.existsSync(path.join(s.directory, "intelboard-update.json")),
      false,
    );
  }
});
test("publisher uploads readiness marker last only after GitHub confirms every signed hash and size", (t) => {
  const s = setup(t);
  assert.equal(s.sign().status, 0);
  const manifest = verifyManifest(
    fs.readFileSync(path.join(s.directory, "intelboard-update.json")),
    s.f.keys,
  );
  const remote = fakeGitHub({ ...s, manifest });
  publishUpdate({ cwd: s.root, gh: remote.gh });
  assert.deepEqual(
    remote.calls.map((a) => a[1]),
    ["view", "upload", "view", "upload"],
  );
  assert.ok(remote.calls.at(-1).at(-1).endsWith("intelboard-update.json"));
  assert.ok(!remote.calls[1].some((v) => v.endsWith("intelboard-update.json")));
  for (const failure of [{ badDigest: true }, { failUpload: true }]) {
    const bad = fakeGitHub({ ...s, manifest }, failure);
    assert.throws(() => publishUpdate({ cwd: s.root, gh: bad.gh }));
    assert.ok(
      !bad.calls.some(
        (a) => a[1] === "upload" && a.at(-1).endsWith("intelboard-update.json"),
      ),
    );
  }
});
test("publisher rejects local tampering, channel mismatches and changes to already committed feeds", (t) => {
  const s = setup(t);
  assert.equal(s.sign().status, 0);
  const manifest = verifyManifest(
    fs.readFileSync(path.join(s.directory, "intelboard-update.json")),
    s.f.keys,
  );
  const committed = fakeGitHub({ ...s, manifest }, { committed: true });
  publishUpdate({ cwd: s.root, gh: committed.gh });
  assert.equal(committed.calls.filter((a) => a[1] === "upload").length, 0);
  for (const options of [
    { committed: true, badDigest: true },
    { prerelease: true },
  ]) {
    const remote = fakeGitHub({ ...s, manifest }, options);
    assert.throws(() => publishUpdate({ cwd: s.root, gh: remote.gh }));
    assert.equal(remote.calls.filter((a) => a[1] === "upload").length, 0);
  }
  fs.appendFileSync(path.join(s.directory, manifest.files[0].name), "tampered");
  let calls = 0;
  assert.throws(
    () =>
      publishUpdate({
        cwd: s.root,
        gh: () => {
          calls++;
        },
      }),
    /changed/,
  );
  assert.equal(calls, 0);
});
