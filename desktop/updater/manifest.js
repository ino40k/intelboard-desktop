import { createHash, verify, createPublicKey } from "node:crypto";
import semver from "semver";
import {
  databaseCompatibility,
  collaborationFormat,
} from "../../shared/update-compatibility.js";

export const REPOSITORY = "ino40k/intelboard-desktop";
export const DATABASE_VERSION = databaseCompatibility.write;
export const COLLABORATION_FORMAT = collaborationFormat;
export const MARKER = "intelboard-update.json";
export const canonicalVersion = (value) =>
  typeof value === "string" &&
  value.length < 100 &&
  semver.valid(value) === value;
export const releaseChannel = (release) =>
  release.prerelease || semver.prerelease(release.tag_name?.slice(1))
    ? "experimental"
    : "stable";
export const artifactName = (version, platform) =>
  `IntelBoard-${version}-${platform === "win32" ? "win-x64.exe" : "linux-x86_64.AppImage"}`;
export const metadataName = (channel, platform) =>
  `${channel === "stable" ? "latest" : "experimental"}${platform === "linux" ? "-linux" : ""}.yml`;
export const releaseURL = (tag, name) =>
  `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
export const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

export function verifyManifest(bytes, keys, release) {
  if (bytes.length > 128 * 1024) throw Error("Update manifest is too large");
  const envelope = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    envelope.format !== 1 ||
    typeof envelope.keyId !== "string" ||
    !Object.hasOwn(keys, envelope.keyId)
  )
    throw Error("Unknown update signing key");
  if (
    typeof envelope.payload !== "string" ||
    typeof envelope.signature !== "string" ||
    envelope.payload.length > 100000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)
  )
    throw Error("Invalid signed update");
  const payload = Buffer.from(envelope.payload, "base64"),
    signature = Buffer.from(envelope.signature, "base64");
  const key = createPublicKey(keys[envelope.keyId]);
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.length !== 64 ||
    !verify(null, payload, key, signature)
  )
    throw Error("Update signature is invalid");
  const value = JSON.parse(payload.toString("utf8"));
  if (
    value.schema !== 1 ||
    value.repository !== REPOSITORY ||
    !canonicalVersion(value.version) ||
    value.tag !== `v${value.version}` ||
    !["stable", "experimental"].includes(value.channel)
  )
    throw Error("Invalid update identity");
  if (value.channel === "stable" && semver.prerelease(value.version))
    throw Error("A preview cannot be stable");
  if (
    release &&
    (release.draft ||
      release.tag_name !== value.tag ||
      releaseChannel(release) !== value.channel ||
      /superseded|withdrawn|no installers|validation pending/i.test(
        release.name || "",
      ))
  )
    throw Error("Release is not eligible");
  const database = value.compatibility?.database;
  if (
    !database ||
    ![database.readMin, database.readMax, database.write].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000,
    ) ||
    database.readMin > database.readMax ||
    database.write < database.readMin ||
    database.write > database.readMax ||
    value.compatibility?.collaboration !== COLLABORATION_FORMAT
  )
    throw Error("Unsupported update compatibility");
  const required = ["win32", "linux"].flatMap((p) => [
    artifactName(value.version, p),
    metadataName(value.channel, p),
  ]);
  const allowed = new Set([
    ...required,
    ...[
      "latest.yml",
      "latest-linux.yml",
      "experimental.yml",
      "experimental-linux.yml",
    ],
    ...["win32", "linux"].flatMap((p) => [
      artifactName(value.version, p) + ".sha256",
      artifactName(value.version, p) + ".blockmap",
    ]),
    `IntelBoard-${value.version}-dependency-sources.zip`,
    `IntelBoard-${value.version}-dependency-sources.zip.sha256`,
    ...[semver.prerelease(value.version)?.[0]]
      .filter((x) => typeof x === "string" && /^[a-z]+$/.test(x))
      .flatMap((x) => [`${x}.yml`, `${x}-linux.yml`]),
  ]);
  if (!Array.isArray(value.files) || value.files.length > 32)
    throw Error("Invalid update file list");
  const seen = new Set();
  for (const file of value.files) {
    if (
      !file ||
      !allowed.has(file.name) ||
      seen.has(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > 4 * 1024 ** 3 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.sha512 !== "string" ||
      Buffer.from(file.sha512, "base64").length !== 64 ||
      Buffer.from(file.sha512, "base64").toString("base64") !== file.sha512
    )
      throw Error("Invalid update file");
    seen.add(file.name);
    if (
      release &&
      !release.assets?.some(
        (a) =>
          a.name === file.name &&
          a.state === "uploaded" &&
          a.size === file.size &&
          (!a.digest || a.digest === `sha256:${file.sha256}`) &&
          a.browser_download_url === releaseURL(value.tag, file.name),
      )
    )
      throw Error("Release upload is incomplete");
  }
  if (required.some((name) => !seen.has(name)))
    throw Error("Both platform packages and manifests are required");
  return value;
}

export function candidates(releases, installed) {
  if (!canonicalVersion(installed)) throw Error("Invalid installed version");
  return releases
    .filter(
      (r) =>
        !r.draft &&
        typeof r.tag_name === "string" &&
        r.tag_name.startsWith("v") &&
        canonicalVersion(r.tag_name.slice(1)) &&
        semver.gt(r.tag_name.slice(1), installed) &&
        !/superseded|withdrawn|no installers|validation pending/i.test(
          r.name || "",
        ) &&
        r.assets?.some(
          (a) =>
            a.name === MARKER &&
            a.state === "uploaded" &&
            a.size > 0 &&
            a.size <= 128 * 1024,
        ),
    )
    .sort((a, b) => semver.rcompare(a.tag_name.slice(1), b.tag_name.slice(1)));
}

export function compatible(manifest, schema = DATABASE_VERSION) {
  const d = manifest.compatibility.database;
  return d.readMin <= schema && d.readMax >= schema && d.write >= schema;
}
