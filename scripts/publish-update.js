// Built-ins only: this job never installs or executes dependency lifecycle code.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";

export function publishUpdate({
  directory = "installers",
  cwd = process.cwd(),
  gh = (...args) =>
    execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
} = {}) {
  const dir = path.resolve(cwd, directory),
    repo = "ino40k/intelboard-desktop";
  const marker = fs.readFileSync(path.join(dir, "intelboard-update.json"));
  const envelope = JSON.parse(marker);
  const keys = JSON.parse(
    fs.readFileSync(
      path.join(cwd, "desktop/updater/trusted-keys.json"),
      "utf8",
    ),
  );
  const payload = Buffer.from(envelope.payload, "base64");
  if (
    envelope.format !== 1 ||
    !keys[envelope.keyId] ||
    !verify(
      null,
      payload,
      createPublicKey(keys[envelope.keyId]),
      Buffer.from(envelope.signature, "base64"),
    )
  )
    throw Error("Invalid release signature");
  const manifest = JSON.parse(payload),
    tag = manifest.tag;
  const version = JSON.parse(
    fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
  ).version;
  if (
    manifest.repository !== repo ||
    manifest.version !== version ||
    tag !== `v${version}`
  )
    throw Error("Unexpected release identity");
  // Verify local bytes again: signing and upload are separate workflow steps.
  for (const file of manifest.files) {
    if (path.basename(file.name) !== file.name || /[\\/\0]/.test(file.name))
      throw Error("Invalid release filename");
    const filename = path.join(dir, file.name),
      st = fs.lstatSync(filename);
    if (!st.isFile() || st.isSymbolicLink())
      throw Error("Invalid release file");
    const fd = fs.openSync(filename, "r"),
      hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
    } finally {
      fs.closeSync(fd);
    }
    if (st.size !== file.size || hash.digest("hex") !== file.sha256)
      throw Error("Local signed release file changed; nothing was uploaded");
  }
  const read = () =>
    JSON.parse(
      gh(
        "release",
        "view",
        tag,
        "--repo",
        repo,
        "--json",
        "tagName,isDraft,isPrerelease,assets",
      ),
    );
  let release = read();
  if (
    release.tagName !== tag ||
    release.isDraft ||
    (release.isPrerelease || manifest.version.includes("-")
      ? "experimental"
      : "stable") !== manifest.channel
  )
    throw Error("Release channel mismatch");
  const matches = () =>
    manifest.files.every((file) =>
      release.assets.some(
        (a) =>
          a.name === file.name &&
          a.size === file.size &&
          a.digest === `sha256:${file.sha256}`,
      ),
    );
  if (release.assets.some((a) => a.name === "intelboard-update.json")) {
    if (!matches())
      throw Error(
        "This update feed is already committed. Publish changed packages under a new version; existing signed releases are immutable.",
      );
    const remote = gh(
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--pattern",
      "intelboard-update.json",
      "--output",
      "-",
    );
    if (
      createHash("sha256").update(remote).digest("hex") !==
      createHash("sha256").update(marker).digest("hex")
    )
      throw Error("A different signed update marker already exists");
    console.log("Signed release is already complete.");
    return;
  }
  // Clients cannot discover this release yet. Publish the authenticated readiness
  // marker only after GitHub confirms every payload's digest and exact size.
  gh(
    "release",
    "upload",
    tag,
    "--repo",
    repo,
    ...manifest.files.map((f) => path.join(dir, f.name)),
    "--clobber",
  );
  release = read();
  if (!matches())
    throw Error(
      "Uploaded release hashes or sizes do not match; update marker was not published.",
    );
  gh(
    "release",
    "upload",
    tag,
    "--repo",
    repo,
    path.join(dir, "intelboard-update.json"),
  );
  console.log(
    "Verified both platform uploads and published the signed update marker last.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  publishUpdate({ directory: process.argv[2] || "installers" });
