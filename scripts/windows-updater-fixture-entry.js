import { app } from "electron";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// NSIS restarts the app through Explorer, which has its own environment.
// Only the synthetic Windows packages include or use this entry point.
const profile = path.dirname(path.dirname(process.execPath));
const diagnosticFile = path.join(
  os.tmpdir(),
  `intelboard-updater-entry-${process.pid}.json`,
);
const diagnostic = {
  pid: process.pid,
  version: app.getVersion(),
  executable: process.execPath,
  profile,
  temporaryDirectory: os.tmpdir(),
  packaged: app.isPackaged,
};
function record(stage, details = {}) {
  Object.assign(diagnostic, { stage }, details);
  writeFileSync(diagnosticFile, JSON.stringify(diagnostic), { mode: 0o600 });
}
try {
  record("fixture entry");
  if (
    process.platform !== "win32" ||
    !app.isPackaged ||
    realpathSync.native(path.dirname(profile)).toLowerCase() !==
      realpathSync.native(os.tmpdir()).toLowerCase() ||
    !path.basename(profile).startsWith("intelboard-updater-e2e-") ||
    !existsSync(path.join(profile, "update-fixture.json"))
  )
    throw Error(
      "The Windows updater fixture requires a synthetic test profile.",
    );
  process.env.INTELBOARD_SMOKE_DIR = profile;
  process.env.INTELBOARD_UPDATER_E2E = "1";
  app.on("ready", () => record("app ready"));
  app.on("browser-window-created", (_event, window) => {
    record("window created");
    window.webContents.on("did-finish-load", () => record("page loaded"));
    window.webContents.on("did-fail-load", (_event, code, description) =>
      record("page failed", { code, description }),
    );
    window.webContents.on("render-process-gone", (_event, details) =>
      record("renderer exited", { details }),
    );
  });
  record("importing main");
  await import("../desktop/main.js");
} catch (error) {
  record("startup failed", { error: error.stack || error.message });
  console.error(error);
  app.exit(1);
}
