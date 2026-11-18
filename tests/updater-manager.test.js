import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { UpdateManager } from "../desktop/updater/manager.js";
import { artifactName, digest } from "../desktop/updater/manifest.js";
import { updateFixture } from "./helpers/update-fixtures.js";

function setup(t, overrides = {}) {
  const data = fs.mkdtempSync(
    path.join(os.tmpdir(), "intelboard-update-unit-"),
  );
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const f = updateFixture(),
    counts = { downloads: 0, prepares: 0, installs: 0, checks: 0 };
  const options = {
    data,
    keys: f.keys,
    platform: "linux",
    schema: 2,
    installed: "1.0.0",
    discovery: {
      check: async () => {
        counts.checks++;
        return { stable: f, experimental: null };
      },
    },
    prepare: async () => {
      counts.prepares++;
    },
    apply: async () => {
      counts.installs++;
    },
    nativeFactory: async () => {
      const n = new EventEmitter(),
        token = {
          cancelled: false,
          cancel() {
            this.cancelled = true;
          },
        };
      n.checkForUpdates = async () => ({
        isUpdateAvailable: true,
        cancellationToken: token,
      });
      n.downloadUpdate = async () => {
        counts.downloads++;
        n.emit("download-progress", {
          percent: 42,
          transferred: 42,
          total: 100,
        });
        await new Promise((r) => setTimeout(r, 10));
        if (token.cancelled) throw Error("cancelled");
        const file = path.join(
          data,
          "update-cache",
          artifactName(f.manifest.version, "linux"),
        );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, f.bytes.get(path.basename(file)));
        return [file];
      };
      return n;
    },
    ...overrides,
  };
  const manager = new UpdateManager(options);
  t.after(() => manager.stop());
  return { manager, f, data, counts };
}
test("checks never download; one explicit confirmation downloads, reports progress, verifies, saves and applies", async (t) => {
  const { manager: m, f, counts } = setup(t);
  await m.check();
  await m.check(true);
  assert.equal(counts.downloads, 0);
  assert.ok(m.snapshot().message.includes("available"));
  const phases = [],
    progress = [];
  m.on("state", (s) => {
    phases.push(s.phase);
    if (s.progress) progress.push(s.progress.percent);
  });
  await m.begin("stable", digest(f.envelope));
  await m.job;
  assert.deepEqual(
    [counts.downloads, counts.prepares, counts.installs],
    [1, 1, 1],
  );
  assert.ok(progress.includes(42));
  assert.ok(phases.includes("verifying"));
  assert.ok(phases.indexOf("preparing") < phases.indexOf("installing"));
});
test("checks coalesce, forged/stale confirmation is rejected, and preference hides previews", async (t) => {
  const { manager: m, f, counts } = setup(t);
  await Promise.all([m.check(), m.check(), m.check()]);
  assert.equal(counts.checks, 1);
  await assert.rejects(m.begin("stable", "0".repeat(64)));
  await assert.rejects(m.begin("other", digest(f.envelope)));
  m.selected.experimental = f;
  await m.preference(false);
  assert.equal(m.snapshot().available.experimental, null);
  await assert.rejects(m.begin("experimental", digest(f.envelope)));
});
test("local writes block restart without another confirmation; verified download is retained", async (t) => {
  let blocked = true;
  const {
    manager: m,
    f,
    counts,
  } = setup(t, {
    prepare: async () => {
      if (blocked) throw Error("File import is active");
    },
  });
  await m.check();
  await m.begin("stable", digest(f.envelope));
  await m.job;
  assert.equal(m.state.phase, "waiting");
  assert.equal(counts.installs, 0);
  assert.ok(m.ready);
  blocked = false;
  await m.retry();
  assert.equal(counts.installs, 1);
  assert.equal(counts.downloads, 1);
});
test("download failure and integrity failure keep application usable and support retry", async (t) => {
  const { manager: m, f, counts } = setup(t);
  const original = m.nativeFactory;
  let fail = true;
  m.nativeFactory = async (o) => {
    const n = await original(o),
      download = n.downloadUpdate;
    n.downloadUpdate = async () => {
      if (fail) throw Error("network offline");
      return download();
    };
    return n;
  };
  await m.check();
  await m.begin("stable", digest(f.envelope));
  await assert.rejects(m.job);
  assert.equal(m.state.phase, "error");
  assert.equal(counts.installs, 0);
  fail = false;
  await m.retry();
  await m.job;
  assert.equal(counts.installs, 1);
  const { manager: x, f: g, counts: c } = setup(t);
  const native = x.nativeFactory;
  x.nativeFactory = async (o) => {
    const n = await native(o),
      download = n.downloadUpdate;
    n.downloadUpdate = async () => {
      const files = await download();
      fs.appendFileSync(files[0], "tamper");
      return files;
    };
    return n;
  };
  await x.check();
  await x.begin("stable", digest(g.envelope));
  await assert.rejects(x.job, /verification/);
  assert.equal(c.installs, 0);
});
test("cancelled downloads never install or automatically resume", async (t) => {
  const { manager: m, f, data, counts } = setup(t);
  await m.check();
  await m.begin("stable", digest(f.envelope));
  m.cancel();
  await assert.rejects(m.job);
  assert.equal(counts.installs, 0);
  assert.equal(m.state.phase, "idle");
  assert.equal(fs.existsSync(path.join(data, "update-state.json")), false);
});
test("recovered verified cache requires retry and is revalidated instead of blindly executing", async (t) => {
  const {
    manager: m,
    f,
    data,
  } = setup(t, {
    prepare: async () => {
      throw Error("busy");
    },
  });
  await m.check();
  await m.begin("stable", digest(f.envelope));
  await m.job;
  m.stop();
  let applied = 0;
  const n = new UpdateManager({
    data,
    keys: f.keys,
    platform: "linux",
    schema: 2,
    installed: "1.0.0",
    prepare: async () => {},
    apply: async () => {
      applied++;
    },
    discovery: { check: async () => ({ stable: f, experimental: null }) },
  });
  t.after(() => n.stop());
  await n.resume();
  assert.equal(applied, 0);
  assert.equal(n.state.phase, "error");
  await n.retry();
  assert.equal(applied, 1);
  const record = JSON.parse(
    fs.readFileSync(path.join(data, "update-state.json")),
  );
  record.file = "../../arbitrary.exe";
  fs.writeFileSync(
    path.join(data, "update-state.json"),
    JSON.stringify(record),
  );
  const x = new UpdateManager({
    ...n,
    data,
    keys: f.keys,
    installed: "1.0.0",
    platform: "linux",
    schema: 2,
  });
  t.after(() => x.stop());
  await x.resume();
  assert.match(x.state.error, /cached/);
});

test("overlapping retries share release validation and installation", async (t) => {
  const { manager: m, f, counts } = setup(t);
  const original = m.prepare;
  m.prepare = async () => {
    throw Error("Workspace is busy");
  };
  await m.check();
  await m.begin("stable", digest(f.envelope));
  await m.job;
  assert.equal(m.state.phase, "waiting");
  m.prepare = original;
  let validations = 0;
  let unblock;
  const validation = new Promise((resolve) => {
    unblock = resolve;
  });
  m.discovery.validate = async () => {
    validations++;
    await validation;
  };
  const attempts = [m.retry(), m.install(), m.retry()];
  unblock();
  await Promise.all(attempts);
  assert.deepEqual([validations, counts.prepares, counts.installs], [1, 1, 1]);
});
