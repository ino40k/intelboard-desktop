import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { app } from "electron";
import updaterPackage from "electron-updater";
import executorPackage from "electron-updater/out/electronHttpExecutor.js";
import { authorizedURL } from "./network.js";
import { artifactName, releaseURL } from "./manifest.js";
import {
  managedPaths,
  integrateImage,
  stageImage,
  replaceImage,
  hashFile,
  restartManaged,
} from "./managed-appimage.js";
const { Provider, NsisUpdater, AppImageUpdater } = updaterPackage;
class RestrictedElectronExecutor extends executorPackage.ElectronHttpExecutor {
  constructor(testURL) {
    super();
    this.testOrigin = testURL ? new URL(testURL).origin : null;
  }
  validate(options) {
    const value = new URL(
      `${options.protocol || "https:"}//${options.hostname || options.host}${options.port ? ":" + options.port : ""}${options.path || "/"}`,
    );
    if (
      this.testOrigin &&
      value.origin === this.testOrigin &&
      value.protocol === "http:" &&
      value.hostname === "127.0.0.1"
    )
      return;
    authorizedURL(value.href);
  }
  createRequest(options, callback) {
    this.validate(options);
    return super.createRequest(options, callback);
  }
  addRedirectHandlers(request, options, reject, count, handler) {
    super.addRedirectHandlers(request, options, reject, count, (next) => {
      try {
        this.validate(next);
        handler(next);
      } catch (e) {
        reject(e);
      }
    });
  }
}

// This provider never consumes a mutable, unsigned network YAML. Its package
// identity and digest come only from the authenticated release commit marker.
export class SignedReleaseProvider extends Provider {
  constructor(options, _updater, runtime) {
    super({ ...runtime, isUseMultipleRangeRequest: false });
    this.manifest = options.manifest;
    this.platform = options.platform;
    this.testURL = options.testURL;
  }
  async getLatestVersion() {
    const m = this.manifest,
      file = m.files.find(
        (f) => f.name === artifactName(m.version, this.platform),
      );
    return {
      version: m.version,
      files: [{ url: file.name, sha512: file.sha512, size: file.size }],
      releaseDate: "2026-01-01T00:00:00.000Z",
    };
  }
  resolveFiles(info) {
    return info.files.map((f) => ({
      url: new URL(this.testURL || releaseURL(this.manifest.tag, f.url)),
      info: f,
    }));
  }
}
export function createNativeDownloader({
  manifest,
  data,
  platform = process.platform,
  testURL,
}) {
  const cache = path.join(data, "update-cache");
  const adapter = {
    whenReady: () => app.whenReady(),
    version: app.getVersion(),
    name: app.getName(),
    isPackaged: app.isPackaged,
    appUpdateConfigPath: path.join(process.resourcesPath, "app-update.yml"),
    userDataPath: data,
    baseCachePath: cache,
    quit: () => app.quit(),
    relaunch: () => app.relaunch(),
    onQuit: (handler) => app.once("quit", (_e, code) => handler(code)),
  };
  if (testURL && !process.env.INTELBOARD_SMOKE_DIR)
    throw Error("Test downloads require a disposable smoke profile");
  const Native = platform === "win32" ? NsisUpdater : AppImageUpdater;
  const native = new Native(null, adapter);
  // Supplying an AppAdapter intentionally suppresses the library's default
  // executor. Restore the real Electron transport while retaining private cache
  // isolation; enforce HTTPS/approved GitHub origins on every redirect.
  native.httpExecutor = new RestrictedElectronExecutor(testURL);
  native.setFeedURL({
    provider: "custom",
    updateProvider: SignedReleaseProvider,
    manifest,
    platform,
    testURL,
  });
  native.autoDownload = false;
  native.autoInstallOnAppQuit = false;
  native.allowPrerelease = true;
  native.allowDowngrade = false;
  native.disableDifferentialDownload = true;
  native.disableWebInstaller = true;
  native.logger = null;
  return native;
}
export async function applyNativePackage({
  file,
  manifest,
  data,
  root,
  paths = managedPaths(),
  sourceImage = process.env.APPIMAGE,
  platform = process.platform,
  exe = process.execPath,
  quit = () => app.quit(),
}) {
  if (platform === "linux") {
    if (!sourceImage)
      throw Error("Install the AppImage edition to enable integrated updates.");
    if (path.resolve(sourceImage) !== paths.image)
      integrateImage(
        sourceImage,
        app.getVersion(),
        path.join(root, "build", "icon.png"),
        paths,
      );
    const stage = stageImage(file, paths);
    try {
      if (
        hashFile(stage) !==
        manifest.files.find(
          (f) => f.name === artifactName(manifest.version, platform),
        ).sha256
      )
        throw Error("Staged application verification failed");
      replaceImage(stage, paths, {
        version: manifest.version,
        sha256: hashFile(stage),
      });
      await restartManaged(paths);
    } finally {
      fs.rmSync(stage, { force: true });
    }
  } else if (platform === "win32") {
    const directory = path.dirname(exe);
    fs.accessSync(directory, fs.constants.W_OK);
    // On Windows access(W_OK) does not evaluate ACLs. Probe an exclusive new
    // file before handing control to NSIS, so a protected install stays open.
    const probe = path.join(directory, ".intelboard-update-" + randomUUID());
    const probeFd = fs.openSync(probe, "wx", 0o600);
    try {
      fs.fsyncSync(probeFd);
    } finally {
      fs.closeSync(probeFd);
      fs.rmSync(probe, { force: true });
    }
    // NSIS reads /D= as the unquoted remainder of the command line. Quote
    // the executable explicitly because verbatim mode disables Node's quoting.
    // Wait for successful process creation before quitting; never invoke a shell
    // or request elevation for the existing per-user installation.
    await new Promise((resolve, reject) => {
      const child = spawn(
        file,
        ["--updated", "/S", "--force-run", `/D=${directory}`],
        {
          argv0: `"${file}"`,
          windowsVerbatimArguments: true,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } else
    throw Error(
      "Integrated updates support Windows and AppImage installations.",
    );
  quit();
}
