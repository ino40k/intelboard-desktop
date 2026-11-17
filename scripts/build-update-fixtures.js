import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const output = path.resolve(process.argv[2] || "test-results/updater-packages");
if (!["linux", "win32"].includes(process.platform))
  throw Error("Use Linux or Windows to build native update fixtures");
const target = process.platform === "linux" ? "linux" : "win";
const builder = path.resolve("node_modules/electron-builder/cli.js");
const windowsBuild =
  process.platform === "win32"
    ? JSON.parse(fs.readFileSync("package.json", "utf8")).build
    : null;
const windowsEntry = "scripts/windows-updater-fixture-entry.js";
fs.mkdirSync(output, { recursive: true });
for (const version of ["9.0.0", "9.0.1", "9.1.0-dev.1"]) {
  const directory = path.join(output, version);
  let config = [
    `--config.directories.output=${directory}`,
    `--config.extraMetadata.version=${version}`,
  ];
  if (windowsBuild) {
    fs.mkdirSync(directory, { recursive: true });
    const configFile = path.join(directory, "fixture-builder.json");
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        ...windowsBuild,
        directories: { ...windowsBuild.directories, output: directory },
        files: [...windowsBuild.files, windowsEntry],
        extraMetadata: {
          ...windowsBuild.extraMetadata,
          version,
          main: windowsEntry,
        },
      }),
    );
    config = ["--config", configFile];
  }
  const result = spawnSync(
    process.execPath,
    [
      builder,
      `--${target}`,
      process.platform === "linux" ? "AppImage" : "nsis",
      "--x64",
      "--publish",
      "never",
      ...config,
    ],
    {
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  const metadata = spawnSync(
    process.execPath,
    ["scripts/prepare-update-metadata.js", directory, process.platform],
    {
      stdio: "inherit",
      env: { ...process.env, INTELBOARD_PACKAGE_VERSION: version },
      windowsHide: true,
    },
  );
  if (metadata.status !== 0) process.exit(metadata.status || 1);
}
console.log(
  `Built three native updater fixtures in ${output}. These are test versions, not release artifacts.`,
);
