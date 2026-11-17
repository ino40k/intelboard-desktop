// Signing deliberately uses only Node built-ins. No npm install, dependency
// module, or package lifecycle script runs with the CI signing secret present.
import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  databaseCompatibility,
  collaborationFormat,
} from "../shared/update-compatibility.js";
const directory = path.resolve(process.argv[2] || "installers");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const version = pkg.version,
  tag = `v${version}`;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
  throw Error("Invalid release version");
let experimental = version.includes("-");
if (process.env.GITHUB_EVENT_PATH) {
  const event = JSON.parse(
    fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  if (event.release) {
    if (event.release.draft || event.release.tag_name !== tag)
      throw Error("Release tag and package version must match");
    experimental ||= event.release.prerelease === true;
  }
}
if (process.argv.includes("--experimental")) experimental = true;
const channel = experimental ? "experimental" : "stable";
const key = createPrivateKey(process.env.INTELBOARD_UPDATE_SIGNING_KEY || "");
if (key.asymmetricKeyType !== "ed25519")
  throw Error("An Ed25519 update signing key is required");
const publicKey = createPublicKey(key).export({ type: "spki", format: "pem" });
const keys = JSON.parse(
  fs.readFileSync("desktop/updater/trusted-keys.json", "utf8"),
);
const keyId = Object.keys(keys).find((id) => keys[id] === publicKey);
if (!keyId)
  throw Error("The signing key is not trusted by this application build");
const files = [];
const artifacts = [
  `IntelBoard-${version}-win-x64.exe`,
  `IntelBoard-${version}-linux-x86_64.AppImage`,
  `IntelBoard-${version}-dependency-sources.zip`,
];
const expected = new Set([
  ...artifacts,
  ...artifacts.map((n) => n + ".sha256"),
  artifacts[0] + ".blockmap",
  "latest.yml",
  "latest-linux.yml",
  "experimental.yml",
  "experimental-linux.yml",
]);
for (const name of fs.readdirSync(directory).sort()) {
  if (!expected.has(name)) continue;
  if (name.includes("/") || name.includes("\\") || name.includes("\0"))
    throw Error("Invalid release filename");
  const file = path.join(directory, name),
    st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.size < 1 ||
    st.size > 4 * 1024 ** 3
  )
    throw Error("Invalid release file");
  const h256 = createHash("sha256"),
    h512 = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) {
    h256.update(chunk);
    h512.update(chunk);
  }
  files.push({
    name,
    size: st.size,
    sha256: h256.digest("hex"),
    sha512: h512.digest("base64"),
  });
}
for (const name of [...artifacts, ...artifacts.map((n) => n + ".sha256")])
  if (!files.some((file) => file.name === name && file.size > 0))
    throw Error(
      "Both platform installers, dependency sources and their checksums are required before signing",
    );
for (const platform of ["win", "linux"]) {
  const artifact = `IntelBoard-${version}-${platform === "win" ? "win-x64.exe" : "linux-x86_64.AppImage"}`;
  const entry = files.find((f) => f.name === artifact);
  if (!entry)
    throw Error("Both platform installers are required before signing");
  for (const alias of ["latest", "experimental"]) {
    const name = alias + (platform === "linux" ? "-linux" : "") + ".yml";
    const meta = JSON.parse(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    if (
      meta.version !== version ||
      meta.files?.length !== 1 ||
      meta.files[0].url !== entry.name ||
      meta.files[0].size !== entry.size ||
      meta.files[0].sha512 !== entry.sha512
    )
      throw Error("Updater manifest/package mismatch");
  }
}
for (const file of files.filter((f) => f.name.endsWith(".sha256"))) {
  const value = fs.readFileSync(path.join(directory, file.name), "utf8").trim(),
    match = value.match(/^([a-f0-9]{64})  (.+)$/);
  if (
    !match ||
    !files.some((f) => f.name === match[2] && f.sha256 === match[1])
  )
    throw Error("Release checksum mismatch");
}
const value = {
  schema: 1,
  repository: "ino40k/intelboard-desktop",
  version,
  tag,
  channel,
  compatibility: {
    database: databaseCompatibility,
    collaboration: collaborationFormat,
  },
  files,
};
const payload = Buffer.from(JSON.stringify(value));
fs.writeFileSync(
  path.join(directory, "intelboard-update.json"),
  JSON.stringify({
    format: 1,
    keyId,
    payload: payload.toString("base64"),
    signature: sign(null, payload, key).toString("base64"),
  }) + "\n",
);
console.log(
  `Signed complete ${channel} release ${tag} with ${files.length} verified files.`,
);
