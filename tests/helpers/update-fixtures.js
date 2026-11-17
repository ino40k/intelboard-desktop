import { generateKeyPairSync, sign } from "node:crypto";
import {
  artifactName,
  metadataName,
  digest,
  releaseURL,
  REPOSITORY,
} from "../../desktop/updater/manifest.js";
export function signingFixture() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    keys: { test: pair.publicKey.export({ type: "spki", format: "pem" }) },
  };
}
export function updateFixture(
  version = "2.0.0",
  channel = "stable",
  signer = signingFixture(),
) {
  const bytes = new Map();
  const image = Buffer.concat([
    Buffer.from("7f454c4602010100414902", "hex"),
    Buffer.from("synthetic-update-" + version),
  ]);
  for (const platform of ["win32", "linux"]) {
    const name = artifactName(version, platform),
      body =
        platform === "linux" ? image : Buffer.from("MZ synthetic " + version);
    bytes.set(name, body);
    const meta = {
      version,
      files: [
        {
          url: name,
          size: body.length,
          sha512: digest(body, "sha512", "base64"),
        },
      ],
    };
    bytes.set(
      metadataName(channel, platform),
      Buffer.from(JSON.stringify(meta)),
    );
  }
  const manifest = {
    schema: 1,
    repository: REPOSITORY,
    version,
    tag: "v" + version,
    channel,
    compatibility: {
      database: { readMin: 0, readMax: 2, write: 2 },
      collaboration: 1,
    },
    files: [...bytes].map(([name, b]) => ({
      name,
      size: b.length,
      sha256: digest(b),
      sha512: digest(b, "sha512", "base64"),
    })),
  };
  const envelopeFor = (value) => {
    const payload = Buffer.from(JSON.stringify(value));
    return JSON.stringify({
      format: 1,
      keyId: "test",
      payload: payload.toString("base64"),
      signature: sign(null, payload, signer.privateKey).toString("base64"),
    });
  };
  const envelope = envelopeFor(manifest),
    release = {
      id: Math.floor(Math.random() * 1e8),
      tag_name: "v" + version,
      name: "IntelBoard " + version,
      draft: false,
      prerelease: channel === "experimental",
      assets: [
        ...manifest.files.map((f) => ({
          name: f.name,
          size: f.size,
          state: "uploaded",
          digest: "sha256:" + f.sha256,
          browser_download_url: releaseURL(manifest.tag, f.name),
        })),
        {
          name: "intelboard-update.json",
          size: Buffer.byteLength(envelope),
          state: "uploaded",
          browser_download_url: releaseURL(
            manifest.tag,
            "intelboard-update.json",
          ),
        },
      ],
    };
  return {
    ...signer,
    manifest,
    envelope,
    release,
    bytes,
    envelopeFor,
    releaseId: release.id,
  };
}
export function fixtureFetcher(fixtures, { count = () => {}, failure } = {}) {
  return async (url, options = {}) => {
    count(url, options);
    if (failure) return new Response("", { status: failure });
    const u = new URL(url),
      headers = { "content-type": "application/json", etag: '"fixture"' };
    if (u.hostname === "api.github.com") {
      const tag = u.pathname.split("/tags/")[1];
      if (tag) {
        const f = fixtures.find(
          (f) => f.manifest.tag === decodeURIComponent(tag),
        );
        return new Response(JSON.stringify(f?.release || {}), {
          status: f ? 200 : 404,
          headers,
        });
      }
      if (u.pathname.endsWith("/latest")) {
        const f = fixtures.find((f) => !f.release.prerelease);
        return new Response(JSON.stringify(f?.release || {}), {
          status: f ? 200 : 404,
          headers,
        });
      }
      return new Response(JSON.stringify(fixtures.map((f) => f.release)), {
        headers,
      });
    }
    const segments = u.pathname.split("/"),
      name = decodeURIComponent(segments.pop()),
      tag = decodeURIComponent(segments.pop()),
      fixture = fixtures.find((f) => f.manifest.tag === tag);
    const body =
      name === "intelboard-update.json"
        ? fixture?.envelope
        : fixture?.bytes.get(name);
    return new Response(body || "", {
      status: body ? 200 : 404,
      headers: { "content-length": String(body?.length || 0) },
    });
  };
}
