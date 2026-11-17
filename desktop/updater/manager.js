import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { ReleaseDiscovery } from "./network.js";
import {
  artifactName,
  verifyManifest,
  digest,
  compatible,
} from "./manifest.js";
import { atomicJSON, hashFile } from "./managed-appimage.js";

export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const active = new Set([
  "downloading",
  "verifying",
  "preparing",
  "installing",
  "waiting",
]);
export function updateError(error) {
  if (error.code === "ENOSPC")
    return "There is not enough free disk space for the update. Free some space and retry.";
  if (["EACCES", "EPERM", "EROFS"].includes(error.code))
    return "IntelBoard could not write the update. Check the installation folder permissions and retry.";
  if (
    ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(
      error.code,
    )
  )
    return "The update connection failed. Check your internet connection and retry.";
  return error.message || "The update could not finish. Please retry.";
}
export class UpdateManager extends EventEmitter {
  constructor(options) {
    super();
    Object.assign(this, options);
    this.discovery = options.discovery || new ReleaseDiscovery(options);
    this.state = {
      installed: options.installed,
      phase: "idle",
      available: { stable: null, experimental: null },
      experimental: options.experimental !== false,
      checked: false,
      error: "",
      message: "",
      progress: null,
    };
    this.selected = { stable: null, experimental: null };
    this.closed = false;
    this.journal = path.join(this.data, "update-state.json");
  }
  snapshot() {
    return structuredClone(this.state);
  }
  publish(patch) {
    Object.assign(this.state, patch);
    this.emit("state", this.snapshot());
  }
  fail(error) {
    this.lastError = error;
    this.publish({
      phase: "error",
      error: updateError(error),
      message: "",
      progress: null,
    });
  }
  start() {
    this.startTimer = setTimeout(
      () =>
        void this.resume()
          .then(() => this.check())
          .catch(() => {}),
      2000,
    );
    this.startTimer.unref?.();
    this.timer = setInterval(
      () => void this.check().catch(() => {}),
      CHECK_INTERVAL,
    );
    this.timer.unref?.();
  }
  stop() {
    this.closed = true;
    clearTimeout(this.startTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.timer);
  }
  async preference(experimental) {
    if (typeof experimental !== "boolean")
      throw Error("Invalid update preference");
    this.state.experimental = experimental;
    await this.savePreference?.(experimental);
    this.publish({ available: this.publicChoices() });
  }
  publicChoices() {
    return Object.fromEntries(
      ["stable", "experimental"].map((channel) => {
        const c = this.selected[channel];
        return [
          channel,
          c && (channel === "stable" || this.state.experimental)
            ? { version: c.manifest.version, id: digest(c.envelope), channel }
            : null,
        ];
      }),
    );
  }
  async check(manual = false) {
    if (this.checking) return this.checking;
    if (
      active.has(this.state.phase) ||
      (this.state.phase === "error" && (this.ready || this.authorized))
    )
      return this.snapshot();
    this.checking = (async () => {
      this.publish({
        phase: "checking",
        message: manual ? "Checking for updates…" : "",
        ...(manual ? { error: "" } : {}),
      });
      try {
        this.selected = await this.discovery.check();
        const available = this.publicChoices();
        this.publish({
          phase: "idle",
          available,
          checked: true,
          error: "",
          message: manual
            ? available.stable || available.experimental
              ? "Updates are available."
              : semver.prerelease(this.installed) && !this.state.experimental
                ? "No newer stable release is available. This preview is kept; no downgrade will be installed."
                : "IntelBoard is up to date."
            : "",
        });
      } catch (error) {
        this.publish({
          phase: "idle",
          checked: true,
          ...(manual ? { error: updateError(error), message: "" } : {}),
        });
      }
      return this.snapshot();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async begin(channel, id) {
    if (
      !["stable", "experimental"].includes(channel) ||
      typeof id !== "string" ||
      !/^[a-f0-9]{64}$/.test(id)
    )
      throw Error("Invalid update selection");
    if (this.beginning || this.job || active.has(this.state.phase))
      throw Error("An update is already in progress");
    const candidate = this.selected[channel];
    if (
      !candidate ||
      digest(candidate.envelope) !== id ||
      (channel === "experimental" && !this.state.experimental)
    )
      throw Error("Check for updates again before continuing.");
    // Recheck withdrawal/completeness at confirmation time, not just startup.
    this.cancelled = false;
    this.beginning = true;
    let fresh;
    try {
      fresh = await this.discovery.check();
    } finally {
      this.beginning = false;
    }
    if (this.cancelled) throw Error("Update cancelled.");
    const current = fresh[channel];
    this.selected = fresh;
    this.publish({ available: this.publicChoices() });
    if (!current || digest(current.envelope) !== id)
      throw Error(
        "The available update changed. Review the new version before continuing.",
      );
    this.job = this.download(current).finally(() => {
      this.job = null;
    });
    // IPC returns promptly while progress arrives through the narrow event bridge.
    void this.job.catch(() => {});
    return this.snapshot();
  }
  journalValue(candidate, phase, file) {
    return {
      format: 1,
      envelope: candidate.envelope,
      releaseId: candidate.releaseId,
      authorizedAt: Date.now(),
      phase,
      ...(file ? { file: path.relative(this.data, file) } : {}),
    };
  }
  cachedFile(relative) {
    if (
      typeof relative !== "string" ||
      relative.length > 2000 ||
      path.isAbsolute(relative)
    )
      throw Error("Invalid cached update");
    const file = path.resolve(this.data, relative),
      cache = path.join(path.resolve(this.data), "update-cache") + path.sep;
    if (
      !file.startsWith(cache) ||
      fs.lstatSync(file).isSymbolicLink() ||
      !fs.statSync(file).isFile() ||
      !fs
        .realpathSync(file)
        .startsWith(
          fs.realpathSync(path.join(this.data, "update-cache")) + path.sep,
        )
    )
      throw Error("Invalid cached update");
    return file;
  }
  verifyFile(file, manifest) {
    const expected = manifest.files.find(
      (f) => f.name === artifactName(manifest.version, this.platform),
    );
    if (
      !expected ||
      fs.statSync(file).size !== expected.size ||
      hashFile(file) !== expected.sha256
    )
      throw Error(
        "Update verification failed. The application was not replaced.",
      );
  }
  async download(candidate) {
    this.cancelled = false;
    this.authorized = candidate;
    try {
      atomicJSON(this.journal, this.journalValue(candidate, "downloading"));
      this.publish({
        phase: "downloading",
        target: {
          version: candidate.manifest.version,
          channel: candidate.manifest.channel,
        },
        error: "",
        message: "",
        progress: { percent: 0, transferred: 0, total: 0 },
      });
      const factory =
        this.nativeFactory ||
        (await import("./native.js")).createNativeDownloader;
      const native = await factory({
        manifest: candidate.manifest,
        data: this.data,
        platform: this.platform,
      });
      this.native = native;
      native.on("error", () => {});
      native.on("download-progress", (p) =>
        this.publish({
          progress: {
            percent: Math.min(100, Math.max(0, p.percent || 0)),
            transferred: p.transferred || 0,
            total: p.total || 0,
          },
        }),
      );
      const checked = await native.checkForUpdates();
      if (!checked?.isUpdateAvailable)
        throw Error("This update no longer upgrades the running application.");
      this.cancellation = checked.cancellationToken;
      if (this.cancelled) this.cancellation.cancel();
      const files = await native.downloadUpdate(this.cancellation);
      if (this.cancelled) throw Error("Update download cancelled.");
      const file = this.cachedFile(path.relative(this.data, files[0]));
      this.publish({ phase: "verifying", message: "Verifying the update…" });
      this.verifyFile(file, candidate.manifest);
      this.ready = { candidate, file };
      atomicJSON(this.journal, this.journalValue(candidate, "ready", file));
      await this.install();
    } catch (error) {
      if (this.cancelled) {
        fs.rmSync(this.journal, { force: true });
        this.ready = null;
        this.authorized = null;
        this.publish({
          phase: "idle",
          progress: null,
          error: "",
          message: "Update cancelled.",
        });
      } else this.fail(error);
      throw error;
    } finally {
      this.cancellation = null;
    }
  }
  cancel() {
    if (this.state.phase === "installing")
      throw Error("Installation has already started.");
    this.cancelled = true;
    clearTimeout(this.retryTimer);
    this.cancellation?.cancel();
    if (!this.job) {
      fs.rmSync(this.journal, { force: true });
      this.ready = null;
      this.authorized = null;
      this.publish({
        phase: "idle",
        progress: null,
        error: "",
        message: "Update cancelled.",
      });
    }
  }
  async install() {
    if (!this.ready || this.cancelled || this.closed) return;
    const { candidate, file } = this.ready;
    this.verifyFile(file, candidate.manifest);
    await this.discovery.validate?.(candidate);
    this.publish({
      phase: "preparing",
      error: "",
      message: "Saving your work before restarting…",
    });
    try {
      await this.prepare(candidate.manifest);
    } catch (error) {
      await this.releasePreparation?.();
      if (this.cancelled) {
        this.ready = null;
        this.authorized = null;
        fs.rmSync(this.journal, { force: true });
        this.publish({
          phase: "idle",
          error: "",
          message: "Update cancelled.",
          progress: null,
        });
        return;
      }
      this.publish({ phase: "waiting", message: error.message, error: "" });
      this.retryTimer = setTimeout(
        () => void this.install().catch((e) => this.fail(e)),
        10000,
      );
      this.retryTimer.unref?.();
      return;
    }
    if (this.cancelled) {
      await this.releasePreparation?.();
      this.ready = null;
      this.authorized = null;
      fs.rmSync(this.journal, { force: true });
      this.publish({
        phase: "idle",
        progress: null,
        error: "",
        message: "Update cancelled.",
      });
      return;
    }
    this.publish({ phase: "installing", message: "Restarting IntelBoard…" });
    try {
      this.verifyFile(file, candidate.manifest);
      await this.apply({ file, manifest: candidate.manifest });
    } catch (error) {
      await this.releasePreparation?.();
      this.fail(error);
      throw error;
    }
  }
  async retry() {
    if (
      this.job ||
      this.beginning ||
      !["error", "waiting"].includes(this.state.phase)
    )
      throw Error("An update operation is already in progress.");
    clearTimeout(this.retryTimer);
    if (this.ready) {
      this.cancelled = false;
      return this.install();
    }
    if (this.authorized) {
      const fresh = await this.discovery.check(),
        channel = this.authorized.manifest.channel;
      if (
        !fresh[channel] ||
        digest(fresh[channel].envelope) !== digest(this.authorized.envelope)
      ) {
        this.selected = fresh;
        this.publish({
          phase: "idle",
          available: this.publicChoices(),
          error: "",
          message: "The available update changed. Review it before continuing.",
        });
        return;
      }
      this.job = this.download(this.authorized).finally(() => {
        this.job = null;
      });
      void this.job.catch(() => {});
      return this.snapshot();
    }
    return this.check(true);
  }
  async resume() {
    try {
      if (!fs.existsSync(this.journal)) return;
      if (fs.statSync(this.journal).size > 256 * 1024)
        throw Error("Invalid update recovery record");
      const record = JSON.parse(fs.readFileSync(this.journal, "utf8"));
      if (record.format !== 1 || !Number.isSafeInteger(record.authorizedAt))
        throw Error("Invalid update recovery record");
      const manifest = verifyManifest(Buffer.from(record.envelope), this.keys);
      if (!semver.gt(manifest.version, this.installed)) {
        fs.rmSync(this.journal, { force: true });
        return;
      }
      if (!compatible(manifest, this.schema))
        throw Error("The saved update is incompatible with this workspace.");
      const candidate = {
        manifest,
        envelope: record.envelope,
        releaseId: record.releaseId,
      };
      this.authorized = candidate;
      if (record.phase === "ready") {
        const file = this.cachedFile(record.file);
        this.verifyFile(file, manifest);
        this.ready = { candidate, file };
        this.publish({
          target: { version: manifest.version, channel: manifest.channel },
        });
        this.publish({
          phase: "error",
          error:
            "The verified update is ready. Retry to finish the interrupted update.",
          progress: null,
        });
      } else
        this.publish({
          phase: "error",
          error:
            "The previous update download was interrupted. Retry to continue.",
        });
    } catch (error) {
      this.fail(error);
    }
  }
}
