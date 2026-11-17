import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, backup } from "node:sqlite";
import { DATABASE_VERSION } from "./manifest.js";
import { atomicJSON } from "./managed-appimage.js";

export async function recoveryBackup({
  data,
  db,
  version,
  target,
  preferences = {},
}) {
  const folder = path.join(
    data,
    "update-recovery",
    Date.now() + "-" + randomUUID(),
  );
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // SQLite's backup API includes committed WAL data and all collaboration and
  // identity tables. Assets remain in place and are never garbage-collected here.
  await backup(db, path.join(folder, "intelboard.sqlite"));
  atomicJSON(path.join(folder, "preferences.json"), preferences);
  for (const file of ["window.json"])
    if (fs.existsSync(path.join(data, file)))
      fs.copyFileSync(path.join(data, file), path.join(folder, file));
  atomicJSON(path.join(folder, "recovery.json"), {
    from: version,
    to: target,
    database: db.prepare("PRAGMA user_version").get().user_version,
    assets: "../../assets",
    created: new Date().toISOString(),
  });
  fs.writeFileSync(
    path.join(folder, "RESTORE.txt"),
    "Close IntelBoard before restoring. Keep the entire original user-data folder, including assets. Restore intelboard.sqlite together with its matching application version; remove stale WAL/SHM files only after saving a copy of the entire folder. preferences.json contains application localStorage values to restore through the app. Do not run an older executable against a newer database.\n",
    { mode: 0o600 },
  );
  return folder;
}
export async function prepareDatabase(data) {
  const file = path.join(data, "intelboard.sqlite");
  if (!fs.existsSync(file)) return;
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    const version = source.prepare("PRAGMA user_version").get().user_version;
    if (version > DATABASE_VERSION)
      throw Error(
        "This workspace requires a newer IntelBoard. Your database and recovery backups have been preserved.",
      );
    if (version < DATABASE_VERSION)
      await recoveryBackup({
        data,
        db: source,
        version: "database-" + version,
        target: "database-" + DATABASE_VERSION,
      });
    await backup(source, path.join(data, "intelboard.previous.sqlite"));
  } finally {
    source.close();
  }
}
