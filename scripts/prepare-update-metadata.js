import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";
import providers from "electron-updater/out/providers/Provider.js";
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const directory = process.argv[2] || "release",
  version = process.env.INTELBOARD_PACKAGE_VERSION || pkg.version;
const platform = process.argv[3] || process.platform;
const file = `IntelBoard-${version}-${platform === "win32" ? "win-x64.exe" : "linux-x86_64.AppImage"}`;
const suffix = platform === "linux" ? "-linux" : "";
const channel = semver.prerelease(version)?.[0] || "latest";
const names = [
  `${channel}${suffix}.yml`,
  `latest${suffix}.yml`,
  ...fs.readdirSync(directory).filter((n) => n.endsWith(".yml")),
];
let parsed;
for (const name of [...new Set(names)]) {
  const original = path.join(directory, name);
  if (!fs.existsSync(original)) continue;
  try {
    const value = providers.parseUpdateInfo(
      fs.readFileSync(original, "utf8"),
      original,
      original,
    );
    if (value.version === version && value.files?.some((f) => f.url === file)) {
      parsed = value;
      break;
    }
  } catch {}
}
if (!parsed)
  throw Error(
    "No generated updater metadata matches the actual platform package",
  );
const info = fs.statSync(path.join(directory, file)),
  hash = createHash("sha512");
for await (const chunk of fs.createReadStream(path.join(directory, file)))
  hash.update(chunk);
const sha512 = hash.digest("base64");
if (
  parsed.version !== version ||
  !parsed.files?.some(
    (f) =>
      f.url === file &&
      f.sha512 === sha512 &&
      (!f.size || f.size === info.size),
  )
)
  throw Error("Generated updater metadata does not match the actual package");
const normalized = {
  version,
  files: [{ url: file, sha512, size: info.size }],
  path: file,
  sha512,
  releaseDate: parsed.releaseDate || new Date().toISOString(),
};
for (const target of ["latest", "experimental"])
  fs.writeFileSync(
    path.join(directory, target + suffix + ".yml"),
    JSON.stringify(normalized, null, 2) + "\n",
  );
console.log(
  `Validated ${file}; prepared stable and experimental metadata aliases.`,
);
