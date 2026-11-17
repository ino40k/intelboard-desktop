import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  managedPaths,
  integrateImage,
  stageImage,
  replaceImage,
  recoverReplacement,
  hashFile,
  atomicJSON,
  restartManaged,
} from "../desktop/updater/managed-appimage.js";
import {
  prepareDatabase,
  recoveryBackup,
} from "../desktop/updater/recovery.js";
import { openStore } from "../desktop/store.js";
import { CollaborationManager } from "../desktop/collaboration/manager.js";
import { createService } from "../desktop/service.js";
const image = (label) =>
  Buffer.concat([
    Buffer.from("7f454c4602010100414902", "hex"),
    Buffer.from(label),
  ]);
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intelboard-update-fs-"));
  const cleanups = [];
  t.after(() => {
    for (const fn of cleanups.reverse()) fn();
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const source = path.join(dir, "Downloaded board app.AppImage"),
    icon = path.join(dir, "icon.png");
  fs.writeFileSync(source, image("old"));
  fs.writeFileSync(icon, "synthetic icon");
  const paths = managedPaths({
    dataHome: path.join(dir, "data with spaces % value"),
  });
  return { dir, source, icon, paths, cleanup: (fn) => cleanups.push(fn) };
}

test("one-time AppImage integration preserves original and updates keep a stable launcher, modes and previous inode", (t) => {
  if (process.platform !== "linux")
    return t.skip("POSIX AppImage filesystem test");
  const { dir, source, icon, paths, cleanup } = setup(t),
    original = hashFile(source);
  integrateImage(source, "1.0.0", icon, paths);
  assert.equal(hashFile(source), original);
  assert.equal(hashFile(paths.image), original);
  assert.equal(fs.statSync(paths.image).mode & 0o777, 0o755);
  const launcher = fs.readFileSync(paths.launcher, "utf8");
  assert.ok(launcher.includes("%% value"));
  assert.ok(launcher.includes('IntelBoard.AppImage" %U'));
  const fd = fs.openSync(paths.image, "r");
  cleanup(() => fs.closeSync(fd));
  const next = path.join(dir, "new.AppImage");
  fs.writeFileSync(next, image("new"));
  const stage = stageImage(next, paths);
  replaceImage(stage, paths, { version: "1.1.0", sha256: hashFile(stage) });
  const old = Buffer.alloc(image("old").length);
  fs.readSync(fd, old, 0, old.length, 0);
  assert.deepEqual(old, image("old"));
  assert.deepEqual(fs.readFileSync(paths.image), image("new"));
  assert.equal(hashFile(paths.image + ".previous"), original);
  assert.equal(hashFile(source), original);
  assert.equal(fs.readFileSync(paths.launcher, "utf8"), launcher);
  assert.throws(() => integrateImage(source, "1.0.0", icon, paths), /newer/);
});
test("permission, disk-full and symlink failures preserve the running and original AppImages", (t) => {
  if (process.platform !== "linux") return t.skip("POSIX permissions test");
  const { source, icon, paths, dir } = setup(t);
  integrateImage(source, "1.0.0", icon, paths);
  const before = hashFile(paths.image);
  const copy = fs.copyFileSync;
  t.mock.method(fs, "copyFileSync", () => {
    throw Object.assign(Error("Disk full"), { code: "ENOSPC" });
  });
  assert.throws(() => stageImage(source, paths), /Disk full/);
  t.mock.restoreAll();
  assert.equal(hashFile(paths.image), before);
  assert.equal(hashFile(source), before);
  fs.chmodSync(paths.directory, 0o500);
  if (process.getuid() !== 0) assert.throws(() => stageImage(source, paths));
  fs.chmodSync(paths.directory, 0o700);
  const target = path.join(dir, "unrelated");
  fs.writeFileSync(target, "do not touch");
  fs.unlinkSync(paths.image);
  fs.symlinkSync(target, paths.image);
  assert.throws(() => integrateImage(source, "1.1.0", icon, paths));
  assert.equal(fs.readFileSync(target, "utf8"), "do not touch");
  assert.equal(fs.copyFileSync, copy);
});
test("interrupted atomic replacement repairs metadata to the committed image without rolling back the executable", (t) => {
  if (process.platform !== "linux") return t.skip("POSIX rename test");
  const { dir, source, icon, paths } = setup(t);
  integrateImage(source, "1.0.0", icon, paths);
  const previous = JSON.parse(fs.readFileSync(paths.record));
  const file = path.join(dir, "next.AppImage");
  fs.writeFileSync(file, image("next"));
  const stage = stageImage(file, paths),
    next = { version: "1.1.0", sha256: hashFile(stage) };
  fs.linkSync(paths.image, paths.image + ".previous");
  atomicJSON(path.join(paths.directory, "replacement.json"), {
    format: 1,
    previous,
    next,
    stage: path.basename(stage),
  });
  fs.renameSync(stage, paths.image);
  assert.equal(recoverReplacement(paths), true);
  assert.equal(JSON.parse(fs.readFileSync(paths.record)).version, "1.1.0");
  assert.equal(hashFile(paths.image), next.sha256);
  assert.equal(hashFile(paths.image + ".previous"), previous.sha256);
  assert.equal(recoverReplacement(paths), false);
});
test("invalid images and modified restart helper cannot be installed or launched", async (t) => {
  const { dir, source, icon, paths } = setup(t);
  if (process.platform !== "linux") return t.skip("AppImage integration test");
  integrateImage(source, "1.0.0", icon, paths);
  const bad = path.join(dir, "bad.AppImage");
  fs.writeFileSync(bad, "not an application");
  assert.throws(() => stageImage(bad, paths), /not an AppImage/);
  fs.writeFileSync(paths.helper, "unexpected script");
  await assert.rejects(restartManaged(paths), /helper/);
});
test("consistent recovery backup includes committed WAL, settings, collaboration identity and preferences", async (t) => {
  const { dir, cleanup } = setup(t),
    store = openStore(path.join(dir, "workspace"));
  cleanup(() => store.db.close());
  const board = store.create("Synthetic research");
  store.db
    .prepare("INSERT INTO settings VALUES(?,?)")
    .run("collaboration.identity", JSON.stringify({ synthetic: "identity" }));
  const backup = await recoveryBackup({
    data: path.join(dir, "workspace"),
    db: store.db,
    version: "1.0.0",
    target: "1.1.0",
    preferences: { "intelboard.theme": "test-theme" },
  });
  const db = new DatabaseSync(path.join(backup, "intelboard.sqlite"), {
    readOnly: true,
  });
  cleanup(() => db.close());
  assert.equal(
    db.prepare("SELECT title FROM boards WHERE id=?").get(board.id).title,
    "Synthetic research",
  );
  assert.match(
    db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("collaboration.identity").value,
    /synthetic/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(backup, "preferences.json")))[
      "intelboard.theme"
    ],
    "test-theme",
  );
});
test("schema migration retains a pre-migration backup and a future schema never replaces existing recovery data", async (t) => {
  const { dir } = setup(t),
    data = path.join(dir, "workspace");
  fs.mkdirSync(data);
  let db = new DatabaseSync(path.join(data, "intelboard.sqlite"));
  db.exec(
    "CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES('original');PRAGMA user_version=1",
  );
  db.close();
  await prepareDatabase(data);
  const folders = fs.readdirSync(path.join(data, "update-recovery"));
  assert.equal(folders.length, 1);
  const pre = new DatabaseSync(
    path.join(data, "update-recovery", folders[0], "intelboard.sqlite"),
  );
  assert.equal(pre.prepare("PRAGMA user_version").get().user_version, 1);
  assert.equal(
    pre.prepare("SELECT value FROM sentinel").get().value,
    "original",
  );
  pre.close();
  const migrated = openStore(data);
  assert.equal(
    migrated.db.prepare("PRAGMA user_version").get().user_version,
    2,
  );
  assert.equal(
    migrated.db.prepare("SELECT value FROM sentinel").get().value,
    "original",
  );
  migrated.db.exec("PRAGMA user_version=99");
  migrated.db.close();
  const previous = hashFile(path.join(data, "intelboard.previous.sqlite"));
  await assert.rejects(prepareDatabase(data), /newer/);
  assert.equal(
    hashFile(path.join(data, "intelboard.previous.sqlite")),
    previous,
  );
  assert.throws(() => openStore(data), /newer/);
});
test("collaboration quiescence drains local work without waiting for offline peers, then resumes", async (t) => {
  const { dir, cleanup } = setup(t),
    service = createService(path.join(dir, "workspace")),
    manager = new CollaborationManager(service, path.join(dir, "workspace"), {
      transport: false,
    });
  cleanup(() => {
    manager.close();
    service.close();
  });
  let durable = false;
  const work = manager.trackUpdateWork(async () => {
    await new Promise((r) => setTimeout(r, 10));
    durable = true;
  });
  await manager.pauseForUpdate();
  await work;
  assert.equal(durable, true);
  await assert.rejects(manager.request({}, "hello"), /update/);
  let unexpected = false;
  await manager.trackUpdateWork(() => {
    unexpected = true;
  });
  assert.equal(unexpected, false);
  manager.resumeAfterUpdate();
  await manager.trackUpdateWork(() => {
    unexpected = true;
  });
  assert.equal(unexpected, true);
});
