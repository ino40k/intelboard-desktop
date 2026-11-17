import { app } from "electron";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// NSIS restarts the app through Explorer, which has its own environment.
// Only the synthetic Windows packages include or use this entry point.
const profile = path.dirname(path.dirname(process.execPath));
if (
  process.platform !== "win32" ||
  !app.isPackaged ||
  realpathSync.native(path.dirname(profile)).toLowerCase() !==
    realpathSync.native(os.tmpdir()).toLowerCase() ||
  !path.basename(profile).startsWith("intelboard-updater-e2e-") ||
  !existsSync(path.join(profile, "update-fixture.json"))
) {
  console.error(
    "The Windows updater fixture requires a synthetic test profile.",
  );
  app.exit(1);
} else {
  process.env.INTELBOARD_SMOKE_DIR = profile;
  process.env.INTELBOARD_UPDATER_E2E = "1";
  await import("../desktop/main.js");
}
