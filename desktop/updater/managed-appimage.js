import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import semver from "semver";

export function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function atomicJSON(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
    if (process.platform !== "win32") syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function hashFile(file) {
  const fd = fs.openSync(file, "r"),
    h = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)))
      h.update(buffer.subarray(0, n));
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}
function ownedDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    (process.getuid && st.uid !== process.getuid()) ||
    st.mode & 0o022
  )
    throw Error(
      "The managed application folder must be owned by you and not writable by other users.",
    );
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}
export function managedPaths({
  dataHome = process.env.XDG_DATA_HOME ||
    path.join(os.homedir(), ".local", "share"),
} = {}) {
  if (!path.isAbsolute(dataHome) || /[\r\n\0]/.test(dataHome))
    throw Error("Invalid application data location");
  const directory = path.join(dataHome, "IntelBoard", "app");
  return {
    directory,
    image: path.join(directory, "IntelBoard.AppImage"),
    record: path.join(directory, "installed.json"),
    launcher: path.join(
      dataHome,
      "applications",
      "org.intelboard.desktop",
    ),
    icon: path.join(directory, "icon.png"),
    helper: path.join(directory, "restart.sh"),
  };
}
function regular(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink())
    throw Error("The managed application is not a regular file");
  return st;
}
export function assertAppImage(file) {
  regular(file);
  const fd = fs.openSync(file, "r"),
    header = Buffer.alloc(11);
  try {
    fs.readSync(fd, header, 0, 11, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (
    header.subarray(0, 4).toString("hex") !== "7f454c46" ||
    header[8] !== 65 ||
    header[9] !== 73 ||
    ![1, 2].includes(header[10])
  )
    throw Error("The downloaded file is not an AppImage");
}
export function stageImage(source, paths) {
  ownedDirectory(paths.directory);
  assertAppImage(source);
  const stage = path.join(
    paths.directory,
    ".next-" + randomUUID() + ".AppImage",
  );
  try {
    fs.copyFileSync(source, stage, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stage, 0o755);
    const fd = fs.openSync(stage, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    assertAppImage(stage);
    return stage;
  } catch (e) {
    fs.rmSync(stage, { force: true });
    throw e;
  }
}
export function replaceImage(stage, paths, record) {
  ownedDirectory(paths.directory);
  recoverReplacement(paths);
  regular(stage);
  if (path.dirname(stage) !== paths.directory)
    throw Error("Update staging must use the managed filesystem");
  if (
    !semver.valid(record.version) ||
    !/^[a-f0-9]{64}$/.test(record.sha256) ||
    hashFile(stage) !== record.sha256
  )
    throw Error("Invalid staged application identity");
  let previous = null;
  if (fs.existsSync(paths.image)) {
    regular(paths.image);
    previous = JSON.parse(fs.readFileSync(paths.record, "utf8"));
    if (
      !semver.valid(previous.version) ||
      previous.sha256 !== hashFile(paths.image)
    )
      throw Error(
        "The managed application needs repair; its files have been preserved.",
      );
    if (semver.gt(previous.version, record.version))
      throw Error("A newer managed application is already installed.");
    if (previous.sha256 === record.sha256) return;
  }
  const journal = path.join(paths.directory, "replacement.json");
  atomicJSON(journal, {
    format: 1,
    previous,
    next: record,
    stage: path.basename(stage),
  });
  if (previous) {
    const link = path.join(paths.directory, ".previous-" + randomUUID());
    fs.linkSync(paths.image, link);
    fs.renameSync(link, paths.image + ".previous");
  }
  // Rename replaces a directory entry atomically. The running process retains
  // its original inode; the old executable is never truncated or unlinked first.
  fs.renameSync(stage, paths.image);
  syncDirectory(paths.directory);
  atomicJSON(paths.record, record);
  fs.rmSync(journal, { force: true });
  syncDirectory(paths.directory);
}
export function recoverReplacement(paths) {
  const journal = path.join(paths.directory, "replacement.json");
  if (!fs.existsSync(journal)) return false;
  regular(journal);
  if (fs.statSync(journal).size > 8192)
    throw Error("Invalid application replacement record");
  const value = JSON.parse(fs.readFileSync(journal, "utf8"));
  if (value.format !== 1)
    throw Error(
      "Application replacement needs manual recovery. Previous files have been preserved.",
    );
  if (!fs.existsSync(paths.image) && value.previous === null) {
    fs.rmSync(journal);
    return true;
  }
  if (!fs.existsSync(paths.image))
    throw Error(
      "Application replacement needs manual recovery. Previous files have been preserved.",
    );
  const actual = hashFile(paths.image),
    record = [value.next, value.previous].find(
      (r) => r && semver.valid(r.version) && r.sha256 === actual,
    );
  if (!record)
    throw Error(
      "Application replacement needs manual recovery. Previous files have been preserved.",
    );
  // Repair metadata to match the already committed image. Never roll an
  // executable back automatically after it may have migrated the database.
  atomicJSON(paths.record, record);
  if (
    typeof value.stage === "string" &&
    /^\.next-[a-f0-9-]{36}\.AppImage$/.test(value.stage)
  ) {
    const stage = path.join(paths.directory, value.stage);
    if (
      fs.existsSync(stage) &&
      !fs.lstatSync(stage).isSymbolicLink() &&
      hashFile(stage) === value.next.sha256
    )
      fs.rmSync(stage);
  }
  fs.rmSync(journal);
  syncDirectory(paths.directory);
  return true;
}
const desktopQuote = (value) =>
  '"' + value.replace(/[%]/g, "%%").replace(/[\\"`$]/g, "\\$&") + '"';
export function integrateImage(source, version, icon, paths = managedPaths()) {
  if (!semver.valid(version)) throw Error("Invalid application version");
  ownedDirectory(paths.directory);
  source = fs.realpathSync(source);
  recoverReplacement(paths);
  if (source === path.resolve(paths.image) && !fs.existsSync(paths.record))
    atomicJSON(paths.record, { version, sha256: hashFile(source) });
  if (fs.existsSync(paths.image)) {
    const current = JSON.parse(fs.readFileSync(paths.record, "utf8"));
    if (
      !semver.valid(current.version) ||
      current.sha256 !== hashFile(paths.image)
    )
      throw Error(
        "The managed installation needs repair. Its files have been preserved.",
      );
    if (semver.gt(current.version, version))
      throw Error(
        "A newer managed IntelBoard is already installed. Launch it instead of replacing it with this version.",
      );
  }
  if (fs.realpathSync(source) !== path.resolve(paths.image)) {
    const stage = stageImage(source, paths);
    try {
      replaceImage(stage, paths, { version, sha256: hashFile(stage) });
    } finally {
      fs.rmSync(stage, { force: true });
    }
  }
  if (fs.existsSync(paths.icon)) regular(paths.icon);
  fs.copyFileSync(icon, paths.icon);
  fs.mkdirSync(path.dirname(paths.launcher), { recursive: true });
  const entry = `[Desktop Entry]\nType=Application\nName=IntelBoard\nExec=${process.env.APPIMAGE_EXTRACT_AND_RUN === "1" ? "/usr/bin/env APPIMAGE_EXTRACT_AND_RUN=1 " : ""}${desktopQuote(paths.image)} %U\nIcon=${paths.icon}\nTerminal=false\nCategories=Office;\nStartupWMClass=org.intelboard\n`;
  const temporary = paths.launcher + "." + randomUUID() + ".tmp";
  fs.writeFileSync(temporary, entry, { mode: 0o644 });
  fs.renameSync(temporary, paths.launcher);
  const helper = paths.helper + "." + randomUUID() + ".tmp";
  fs.writeFileSync(helper, RESTART_SCRIPT, { mode: 0o700, flag: "wx" });
  fs.renameSync(helper, paths.helper);
  syncDirectory(paths.directory);
  return paths;
}
const RESTART_SCRIPT = `#!/bin/sh\nparent_pid="$1"\nshift\ncount=0\nwhile kill -0 "$parent_pid" 2>/dev/null; do\n  count=$((count+1))\n  [ "$count" -lt 1200 ] || exit 1\n  /bin/sleep 0.1\ndone\nunset APPIMAGE APPDIR ARGV0 APPIMAGE_SILENT_INSTALL APPIMAGE_EXIT_AFTER_INSTALL LD_LIBRARY_PATH\nexec "$@"\n`;
export async function restartManaged(
  paths,
  parentPid = process.pid,
  args = [],
) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0)
    throw Error("Invalid restart process");
  regular(paths.helper);
  if (fs.readFileSync(paths.helper, "utf8") !== RESTART_SCRIPT)
    throw Error(
      "The update restart helper needs repair. Set up the Linux launcher again.",
    );
  const child = spawn(
    "/bin/sh",
    [paths.helper, String(parentPid), paths.image, ...args],
    {
      detached: true,
      stdio: "ignore",
      cwd: paths.directory,
      env: { ...process.env },
    },
  );
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}
