import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app, ipcMain, shell, session, dialog } from "electron";
import { UpdateManager } from "./manager.js";
import { applyNativePackage } from "./native.js";
import { recoveryBackup } from "./recovery.js";
import {
  managedPaths,
  integrateImage,
  restartManaged,
  recoverReplacement,
} from "./managed-appimage.js";
import { DATABASE_VERSION, REPOSITORY } from "./manifest.js";

export async function setupUpdater({
  window,
  service,
  data,
  root,
  trusted,
  smoke,
  isBusy,
}) {
  const keys = JSON.parse(
    fs.readFileSync(
      path.join(root, "desktop/updater/trusted-keys.json"),
      "utf8",
    ),
  );
  const db = service.store.db;
  if (
    process.platform === "linux" &&
    process.env.APPIMAGE &&
    path.resolve(process.env.APPIMAGE) === managedPaths().image
  )
    recoverReplacement(managedPaths());
  let preparation = null,
    preparing = false,
    applying = false;
  const settings = () => {
    try {
      return JSON.parse(
        db
          .prepare("SELECT value FROM settings WHERE key=?")
          .get("updater.preferences")?.value || "{}",
      );
    } catch {
      return {};
    }
  };
  const releasePreparation = async () => {
    preparing = false;
    service.collaboration.resumeAfterUpdate?.();
    if (!window.isDestroyed())
      window.webContents.send("intelboard:update-prepare", {
        action: "release",
      });
  };
  const askRenderer = () =>
    new Promise((resolve, reject) => {
      const nonce = randomUUID(),
        timer = setTimeout(() => {
          preparation = null;
          reject(
            Error(
              "The editor has not finished saving. IntelBoard will wait before restarting.",
            ),
          );
        }, 15000);
      preparation = {
        nonce,
        resolve: (value) => {
          clearTimeout(timer);
          preparation = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          preparation = null;
          reject(error);
        },
      };
      window.webContents.send("intelboard:update-prepare", {
        action: "prepare",
        nonce,
      });
    });
  ipcMain.on("intelboard:update-prepared", (event, body) => {
    try {
      trusted(event);
      if (!preparation || body?.nonce !== preparation.nonce) return;
      if (body.ok !== true)
        throw Error(
          typeof body.error === "string"
            ? body.error.slice(0, 300)
            : "The editor is not ready to restart.",
        );
      const value = body.preferences;
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > 10000 ||
        JSON.stringify(value).length > 32 * 1024 * 1024 ||
        Object.entries(value).some(
          ([k, v]) =>
            !k.startsWith("intelboard.") ||
            k.length > 1000 ||
            typeof v !== "string",
        )
      )
        throw Error("Invalid saved editor preferences");
      preparation.resolve(value);
    } catch (error) {
      preparation?.reject(error);
    }
  });
  const prepare = async (manifest) => {
    if (isBusy())
      throw Error("Wait for the current file operation or capture to finish.");
    preparing = true;
    try {
      let preferences = await askRenderer();
      if (isBusy()) throw Error("A local file operation is still running.");
      await service.collaboration.pauseForUpdate();
      preferences = await askRenderer();
      const safe = await window.webContents.executeJavaScript(
        `(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented&&e.returnValue!==false;})()`,
      );
      if (!safe)
        throw Error("A local editor operation has not finished saving.");
      await session.defaultSession.flushStorageData();
      const checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
      if (checkpoint?.busy) throw Error("The workspace database is busy.");
      await recoveryBackup({
        data,
        db,
        version: app.getVersion(),
        target: manifest.version,
        preferences,
      });
      if (isBusy()) throw Error("A local operation is still running.");
    } catch (error) {
      await releasePreparation();
      throw error;
    }
  };
  let options = {};
  if (smoke && process.env.INTELBOARD_UPDATER_E2E)
    options = (await import("./e2e.js")).testConfiguration({
      data,
      root,
      window,
      service,
    });
  const updater = new UpdateManager({
    data,
    keys,
    installed: app.getVersion(),
    schema: DATABASE_VERSION,
    platform: process.platform,
    experimental: settings().experimental !== false,
    savePreference: async (experimental) => {
      db.prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run("updater.preferences", JSON.stringify({ experimental }));
    },
    prepare,
    releasePreparation,
    apply: async (args) => {
      applying = true;
      try {
        await applyNativePackage({ ...args, data, root });
      } catch (e) {
        applying = false;
        throw e;
      }
    },
    ...options,
  });
  updater.on("state", (state) => {
    if (!window.isDestroyed())
      window.webContents.send("intelboard:updater-state", {
        ...state,
        integrationRequired:
          process.platform === "linux" &&
          !!process.env.APPIMAGE &&
          path.resolve(process.env.APPIMAGE) !== managedPaths().image,
      });
  });
  const supported = () =>
    app.isPackaged &&
    process.arch === "x64" &&
    (process.platform === "linux"
      ? !!process.env.APPIMAGE
      : process.platform === "win32" &&
        fs.existsSync(
          path.join(path.dirname(process.execPath), "Uninstall IntelBoard.exe"),
        ));
  const status = () => ({
    ...updater.snapshot(),
    integrationRequired:
      process.platform === "linux" &&
      !!process.env.APPIMAGE &&
      path.resolve(process.env.APPIMAGE) !== managedPaths().image,
  });
  ipcMain.handle("intelboard:updater", async (event, operation, body) => {
    trusted(event);
    switch (operation) {
      case "status":
        return status();
      case "check":
        if (!supported() && !smoke)
          throw Error(
            "Install the Windows or AppImage edition once to enable integrated updates.",
          );
        return updater.check(true);
      case "begin":
        if (!supported() && !smoke)
          throw Error("This installation does not support integrated updates.");
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "channel,id"
        )
          throw Error("Invalid update confirmation");
        await updater.begin(body.channel, body.id);
        return status();
      case "cancel":
        updater.cancel();
        return status();
      case "retry":
        await updater.retry();
        return status();
      case "experimental":
        await updater.preference(body?.enabled);
        return status();
      case "notes": {
        if (!["stable", "experimental"].includes(body?.channel))
          throw Error("Invalid release selection");
        const candidate = updater.selected[body?.channel];
        if (!candidate || body.id !== status().available[body.channel]?.id)
          throw Error("Invalid release selection");
        await shell.openExternal(
          `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(candidate.manifest.tag)}`,
        );
        return status();
      }
      default:
        throw Error("Unknown update command");
    }
  });
  if (!smoke && supported()) updater.start();
  app.on("will-quit", () => updater.stop());
  return {
    updater,
    isPreparing: () => preparing,
    isApplying: () => applying,
    menu: () => ({
      label: "Updates",
      submenu: [
        {
          label: "Check for updates…",
          click: () =>
            void (
              supported()
                ? updater.check(true)
                : Promise.reject(
                    Error(
                      "Install the Windows or AppImage edition once to enable integrated updates.",
                    ),
                  )
            ).catch((e) =>
              dialog.showMessageBox(window, {
                type: "info",
                message: e.message,
              }),
            ),
        },
        {
          label: "Show experimental update notifications",
          type: "checkbox",
          checked: updater.state.experimental,
          click: (item) => void updater.preference(item.checked),
        },
        ...(process.platform === "linux"
          ? [
              {
                label: "Set up Linux launcher…",
                click: async () => {
                  if (
                    preparing ||
                    updater.beginning ||
                    updater.job ||
                    !["idle", "checking"].includes(updater.state.phase)
                  ) {
                    await dialog.showMessageBox(window, {
                      message:
                        "Finish or cancel the current update before setting up the launcher.",
                    });
                    return;
                  }
                  if (!process.env.APPIMAGE) {
                    await dialog.showMessageBox(window, {
                      message:
                        "Launch the original AppImage to set up its managed launcher.",
                    });
                    return;
                  }
                  const response = await dialog.showMessageBox(window, {
                    message: "Set up IntelBoard for future updates?",
                    detail:
                      "IntelBoard will copy itself to your user application folder, create a launcher, and restart. The original AppImage and your workspace are kept.",
                    buttons: ["Set up and restart", "Cancel"],
                    defaultId: 0,
                    cancelId: 1,
                  });
                  if (response.response !== 0) return;
                  try {
                    await prepare({ version: app.getVersion() });
                    const paths = integrateImage(
                      process.env.APPIMAGE,
                      app.getVersion(),
                      path.join(root, "build/icon.png"),
                    );
                    await restartManaged(paths);
                    applying = true;
                    app.quit();
                  } catch (e) {
                    await releasePreparation();
                    await dialog.showMessageBox(window, {
                      type: "error",
                      message: e.message,
                    });
                  }
                },
              },
            ]
          : []),
      ],
    }),
  };
}
