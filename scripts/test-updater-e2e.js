import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import {
  artifactName,
  metadataName,
  releaseURL,
  REPOSITORY,
  digest,
} from "../desktop/updater/manifest.js";
const root = path.resolve(process.argv[2] || "test-results/updater-packages");
const platform = process.platform;
const windowsState = () => {
  const value = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
$ErrorActionPreference = 'Stop'
$locations = @('HKCU:\\Software', 'HKLM:\\Software', 'HKLM:\\Software\\WOW6432Node')
$installs = @(foreach ($root in $locations) {
  $uninstall = Join-Path $root 'Microsoft\\Windows\\CurrentVersion\\Uninstall'
  if (Test-Path -LiteralPath $uninstall) {
    Get-ChildItem -LiteralPath $uninstall | Get-ItemProperty | Where-Object { $_.DisplayName -match '^IntelBoard( [0-9]|$)' } | ForEach-Object {
      # electron-builder stores the install path in a sibling key with the same ID.
      $install = Get-ItemProperty -LiteralPath (Join-Path $root $_.PSChildName) -ErrorAction SilentlyContinue
      @{ key=$_.PSPath; location=$install.InstallLocation; version=$_.DisplayVersion }
    }
  }
})
$shell = New-Object -ComObject WScript.Shell
$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('StartMenu')) | Where-Object { $_ -and (Test-Path $_) }
$shortcuts = @($folders | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'IntelBoard*.lnk' -Recurse -File } | ForEach-Object { @{ path=$_.FullName; target=$shell.CreateShortcut($_.FullName).TargetPath } } | Sort-Object { $_.path })
@{ installs=$installs; shortcuts=$shortcuts } | ConvertTo-Json -Depth 4 -Compress
`,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  return {
    installs: value.installs
      .map(({ key, location, version }) => ({ key, location, version }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    shortcuts: value.shortcuts
      .map(({ path, target }) => ({ path, target }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
};
if (!["linux", "win32"].includes(platform))
  throw Error("Native updater E2E supports Linux or Windows");
if (platform === "win32") {
  if (
    process.env.GITHUB_ACTIONS !== "true" &&
    process.env.INTELBOARD_DISPOSABLE_VM !== "1"
  )
    throw Error(
      "Use a disposable Windows VM and set INTELBOARD_DISPOSABLE_VM=1. This test installs real fixtures.",
    );
  if (
    fs.existsSync(
      path.join(process.env.APPDATA || "", "IntelBoard", "intelboard.sqlite"),
    )
  )
    throw Error(
      "A real IntelBoard workspace exists in this Windows user profile. Use a clean disposable VM/user.",
    );
  if (windowsState().installs.length)
    throw Error(
      "An IntelBoard installation is registered in this Windows profile. Use a clean disposable VM/user.",
    );
}
const hashFile = async (file) => {
  const h = createHash("sha256");
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest("hex");
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sameWindowsPath = (a, b) => {
  if (!a || !b) return false;
  try {
    // TEMP may contain an 8.3 username while Windows shortcuts expand it.
    // Compare actual filesystem paths, retaining the same-location assertion.
    return (
      fs.realpathSync.native(a).toLowerCase() ===
      fs.realpathSync.native(b).toLowerCase()
    );
  } catch {
    return false;
  }
};
const runInstaller = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      // NSIS requires the final /D= path without quotes, even with spaces.
      argv0: `"${file}"`,
      windowsVerbatimArguments: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let text = "";
    child.stdout.on("data", (b) => {
      text = (text + b).slice(-16000);
    });
    child.stderr.on("data", (b) => {
      text = (text + b).slice(-16000);
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(text)
        : reject(Error(`Fixture exited ${code}: ${text}`)),
    );
  });

for (const channel of ["stable", "experimental"]) {
  const profile = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), "intelboard-updater-e2e-"),
  );
  const target = channel === "stable" ? "9.0.1" : "9.1.0-dev.1",
    artifact = path.join(root, target, artifactName(target, platform));
  const body = fs.readFileSync(artifact),
    pair = generateKeyPairSync("ed25519"),
    bytes = {};
  const names = {};
  for (const p of ["linux", "win32"]) {
    const name = artifactName(target, p),
      b =
        p === platform ? body : Buffer.from("synthetic other-platform fixture");
    names[p] = {
      name,
      size: b.length,
      sha256: digest(b),
      sha512: digest(b, "sha512", "base64"),
    };
    const meta = metadataName(channel, p);
    bytes[meta] = Buffer.from(
      JSON.stringify({
        version: target,
        files: [{ url: name, sha512: names[p].sha512, size: b.length }],
      }),
    ).toString("base64");
  }
  const files = [
    ...Object.values(names),
    ...Object.entries(bytes).map(([name, value]) => {
      const b = Buffer.from(value, "base64");
      return {
        name,
        size: b.length,
        sha256: digest(b),
        sha512: digest(b, "sha512", "base64"),
      };
    }),
  ];
  const manifest = {
    schema: 1,
    repository: REPOSITORY,
    version: target,
    tag: "v" + target,
    channel,
    compatibility: {
      database: { readMin: 0, readMax: 2, write: 2 },
      collaboration: 1,
    },
    files,
  };
  const payload = Buffer.from(JSON.stringify(manifest)),
    envelope = JSON.stringify({
      format: 1,
      keyId: "fixture",
      payload: payload.toString("base64"),
      signature: sign(null, payload, pair.privateKey).toString("base64"),
    });
  const release = {
    id: 42,
    tag_name: manifest.tag,
    name: "Synthetic update",
    draft: false,
    prerelease: channel === "experimental",
    assets: [
      ...files.map((f) => ({
        name: f.name,
        size: f.size,
        digest: "sha256:" + f.sha256,
        state: "uploaded",
        browser_download_url: releaseURL(manifest.tag, f.name),
      })),
      {
        name: "intelboard-update.json",
        size: envelope.length,
        state: "uploaded",
        browser_download_url: releaseURL(
          manifest.tag,
          "intelboard-update.json",
        ),
      },
    ],
  };
  let downloads = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== "/package") {
      res.writeHead(404);
      res.end();
      return;
    }
    downloads++;
    fs.writeFileSync(
      path.join(profile, "requests.json"),
      JSON.stringify({ downloads }),
    );
    res.writeHead(200, {
      "Content-Length": body.length,
      "Content-Type": "application/octet-stream",
    });
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const end = Math.min(body.length, offset + 1024 * 1024);
      res.write(body.subarray(offset, end));
      offset = end;
      if (offset === body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 15);
    res.once("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(
    path.join(profile, "requests.json"),
    JSON.stringify({ downloads: 0 }),
  );
  const original = path.join(root, "9.0.0", artifactName("9.0.0", platform));
  const fixture = {
    channel,
    target,
    envelope,
    release,
    bytes,
    keys: { fixture: pair.publicKey.export({ type: "spki", format: "pem" }) },
    url: `http://127.0.0.1:${server.address().port}/package`,
    originalHash: await hashFile(original),
    pendingText: "Saved safely by the integrated updater",
    profile,
  };
  fs.writeFileSync(
    path.join(profile, "update-fixture.json"),
    JSON.stringify(fixture),
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    INTELBOARD_SMOKE_DIR: profile,
    INTELBOARD_UPDATER_E2E: "1",
    XDG_DATA_HOME: path.join(profile, "xdg-data"),
    APPIMAGE_EXTRACT_AND_RUN: "1",
  };
  let initial, installDirectory, originalWindowsState;
  try {
    if (platform === "linux") {
      const downloads = path.join(profile, "Downloads");
      fs.mkdirSync(downloads);
      initial = path.join(
        downloads,
        "IntelBoard original with spaces.AppImage",
      );
      fs.copyFileSync(original, initial);
      fs.chmodSync(initial, 0o755);
    } else {
      installDirectory = path.join(profile, "installed app with spaces");
      await runInstaller(original, ["/S", `/D=${installDirectory}`]);
      initial = path.join(installDirectory, "IntelBoard.exe");
      originalWindowsState = windowsState();
      if (
        originalWindowsState.installs.length !== 1 ||
        originalWindowsState.installs[0].version !== "9.0.0" ||
        !sameWindowsPath(
          originalWindowsState.installs[0].location,
          installDirectory,
        ) ||
        originalWindowsState.shortcuts.length !== 2 ||
        originalWindowsState.shortcuts.some(
          (s) => !sameWindowsPath(s.target, initial),
        )
      )
        throw Error(
          "Initial installer did not register one 9.0.0 installation with two shortcuts: " +
            JSON.stringify(originalWindowsState),
        );
    }
    const child = spawn(initial, ["--disable-gpu"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "",
      childExit = null;
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
    });
    child.stdout.on("data", (b) => {
      output = (output + b).slice(-20000);
    });
    child.stderr.on("data", (b) => {
      output = (output + b).slice(-20000);
    });
    child.once("error", (error) => {
      output += error.stack;
    });
    const deadline = Date.now() + 150000;
    while (
      Date.now() < deadline &&
      !fs.existsSync(path.join(profile, "update-result.json"))
    ) {
      if (fs.existsSync(path.join(profile, "failure.txt")))
        throw Error(
          fs.readFileSync(path.join(profile, "failure.txt"), "utf8") +
            "\n" +
            output,
        );
      await pause(100);
    }
    if (!fs.existsSync(path.join(profile, "update-result.json"))) {
      try {
        child.kill("SIGKILL");
      } catch {}
      const evidence = {
        profile,
        childExit,
        files: fs.readdirSync(profile),
        state: {},
      };
      for (const name of [
        "updater-observed.json",
        "requests.json",
        "e2e-app.pid",
      ])
        if (fs.existsSync(path.join(profile, name)))
          evidence.state[name] = fs
            .readFileSync(path.join(profile, name), "utf8")
            .slice(0, 8000);
      if (platform === "win32") {
        evidence.windows = windowsState();
        evidence.processes = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Process | Where-Object { $_.ProcessName -eq 'explorer' -or $_.ProcessName -like 'IntelBoard*' } | Select-Object ProcessName,Id,SessionId | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8", windowsHide: true },
        );
        evidence.entries = fs
          .readdirSync(os.tmpdir())
          .filter((name) => /^intelboard-updater-entry-\d+\.json$/.test(name))
          .map((name) => {
            try {
              return JSON.parse(
                fs.readFileSync(path.join(os.tmpdir(), name), "utf8"),
              );
            } catch {
              return null;
            }
          })
          .filter((entry) => entry && sameWindowsPath(entry.profile, profile));
      }
      throw Error(
        "Native update/restart deadline exceeded: " +
          output +
          "\nSynthetic diagnostics: " +
          JSON.stringify(evidence),
      );
    }
    const result = JSON.parse(
      fs.readFileSync(path.join(profile, "update-result.json")),
    );
    if (!result.ok || result.version !== target)
      throw Error("Updated process did not report the expected version");
    if (platform === "win32") {
      const after = windowsState();
      const before = originalWindowsState.installs[0];
      if (
        after.installs.length !== 1 ||
        after.installs[0].key !== before.key ||
        after.installs[0].version !== target ||
        !sameWindowsPath(after.installs[0].location, before.location) ||
        JSON.stringify(after.shortcuts) !==
          JSON.stringify(originalWindowsState.shortcuts)
      )
        throw Error(
          "Update failed to retain the installation and shortcuts with the new registry version: " +
            JSON.stringify({ before: originalWindowsState, after }),
        );
      result.shortcuts = true;
      result.sameInstallation = true;
    }
    console.log(JSON.stringify(result));
    console.log(
      `Native ${platform} ${channel} update and restart passed. Synthetic profile: ${profile}`,
    );
  } finally {
    const pidFile = path.join(profile, "e2e-app.pid");
    if (
      platform === "win32" &&
      fs.existsSync(pidFile) &&
      fs.existsSync(path.join(profile, "update-result.json"))
    ) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await pause(100);
      }
    }
    if (
      fs.existsSync(pidFile) &&
      !fs.existsSync(path.join(profile, "update-result.json"))
    ) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    if (
      platform === "win32" &&
      installDirectory &&
      fs.existsSync(path.join(installDirectory, "Uninstall IntelBoard.exe"))
    )
      await runInstaller(
        path.join(installDirectory, "Uninstall IntelBoard.exe"),
        ["/S"],
      ).catch(() => {});
    // Keep synthetic screenshots/results for inspection; never publish profiles.
  }
}
