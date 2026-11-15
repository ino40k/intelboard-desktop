import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const platform =
  process.argv[2] || { win32: "windows" }[process.platform] || process.platform;
if (!["linux", "windows"].includes(platform))
  throw Error("Supported networking targets: linux, windows");
const go = process.env.INTELBOARD_GO || "go";
await mkdir("native/bin", { recursive: true });
const result = spawnSync(
  go,
  [
    "build",
    "-trimpath",
    "-buildvcs=false",
    "-ldflags=-s -w",
    "-o",
    path.resolve(
      "native/bin/intelboard-network" + (platform === "windows" ? ".exe" : ""),
    ),
    ".",
  ],
  {
    cwd: "native/network",
    env: { ...process.env, GOOS: platform, GOARCH: "amd64", CGO_ENABLED: "0" },
    stdio: "inherit",
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
console.log("Built the bundled Tailcat transport for " + platform + " x64.");
