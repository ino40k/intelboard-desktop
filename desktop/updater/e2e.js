import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { createNativeDownloader } from "./native.js";
import { managedPaths, hashFile } from "./managed-appimage.js";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (data) =>
  JSON.parse(fs.readFileSync(path.join(data, "update-fixture.json"), "utf8"));
async function wait(window, code) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await window.webContents.executeJavaScript(code, true)) return;
    await pause(35);
  }
  throw Error("Updater UI check timed out: " + code);
}
async function click(window, selector) {
  const p = await window.webContents.executeJavaScript(
    `(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return null;const r=element.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`,
  );
  assert.ok(p, `Missing updater click target: ${selector}`);
  const coordinates = { x: Math.round(p.x), y: Math.round(p.y) };
  window.webContents.sendInputEvent({ type: "mouseMove", ...coordinates });
  await pause(60);
  for (const type of ["mouseDown", "mouseUp"]) {
    window.webContents.sendInputEvent({
      type,
      ...coordinates,
      button: "left",
      clickCount: 1,
    });
    await pause(60);
  }
}
export function testConfiguration({ data, window, service }) {
  if (!process.env.INTELBOARD_SMOKE_DIR)
    throw Error("Updater fixtures require disposable storage");
  const fixture = read(data);
  const fetcher = async (url) => {
    const u = new URL(url);
    if (u.hostname === "api.github.com") {
      if (u.pathname.endsWith("/latest") && fixture.channel === "experimental")
        return new Response("", { status: 404 });
      return new Response(
        JSON.stringify(u.search ? [fixture.release] : fixture.release),
        { headers: { "content-type": "application/json" } },
      );
    }
    const name = decodeURIComponent(u.pathname.split("/").pop());
    return new Response(
      name === "intelboard-update.json"
        ? fixture.envelope
        : Buffer.from(fixture.bytes[name] || "", "base64"),
    );
  };
  return {
    keys: fixture.keys,
    fetcher,
    nativeFactory: async (options) => {
      const native = createNativeDownloader({
        ...options,
        testURL: fixture.url,
      });
      native.on("download-progress", (p) => {
        if (p.transferred > 0 && p.percent > 0 && p.percent < 100)
          fs.writeFileSync(
            path.join(data, "progress-observed.json"),
            JSON.stringify({ percent: p.percent, transferred: p.transferred }),
          );
      });
      const download = native.downloadUpdate.bind(native);
      native.downloadUpdate = async (token) => {
        const files = await download(token);
        const baseline = JSON.parse(
          fs.readFileSync(path.join(data, "update-baseline.json"), "utf8"),
        );
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-id="${baseline.note}"] .note-content').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}))`,
        );
        await wait(
          window,
          "!!document.querySelector('[contenteditable=true]')",
        );
        await window.webContents.executeJavaScript(
          `(()=>{const e=document.querySelector('[contenteditable=true]');e.focus();const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`,
        );
        await window.webContents.insertText(fixture.pendingText);
        // A genuine native edit is still inside the 450ms save debounce here.
        assert.notEqual(
          service.store.get(baseline.board).nodes[0].data.text,
          fixture.pendingText,
        );
        return files;
      };
      return native;
    },
  };
}
export async function runSmoke(window, service, data, { updater }) {
  fs.writeFileSync(path.join(data, "e2e-app.pid"), String(process.pid));
  updater.on("state", (state) => {
    fs.writeFileSync(
      path.join(data, "updater-observed.json"),
      JSON.stringify({
        phase: state.phase,
        error: state.error,
        message: state.message,
      }),
    );
    if (state.phase === "error")
      fs.writeFileSync(
        path.join(data, "failure.txt"),
        updater.lastError?.stack || state.error,
      );
  });
  const fixture = read(data),
    baselineFile = path.join(data, "update-baseline.json");
  if (app.getVersion() === fixture.target) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    await updater.resume();
    assert.equal(updater.snapshot().installed, fixture.target);
    const board = service.store.get(baseline.board);
    assert.equal(board.nodes[0].data.text, fixture.pendingText);
    assert.equal(
      service.store.get(baseline.shared).title,
      "Offline shared research",
    );
    service.collaboration.ensure();
    assert.equal(
      createHash("sha256")
        .update(JSON.stringify(service.collaboration.engine.identity))
        .digest("hex"),
      baseline.identity,
    );
    assert.equal(
      hashFile(path.join(service.assets.folder, baseline.asset)),
      baseline.assetHash,
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "localStorage.getItem('intelboard.updater-e2e')",
      ),
      "preserved",
    );
    assert.equal(
      await window.webContents.executeJavaScript(
        "localStorage.getItem('intelboard.theme')",
      ),
      "forest",
    );
    assert.ok(fs.readdirSync(path.join(data, "update-recovery")).length > 0);
    assert.ok(fs.existsSync(path.join(data, "progress-observed.json")));
    if (process.platform === "linux") {
      const paths = managedPaths();
      assert.equal(path.resolve(process.env.APPIMAGE), paths.image);
      assert.equal(
        hashFile(paths.image),
        fixture.release.assets
          .find((a) => a.name.endsWith(".AppImage"))
          .digest.slice(7),
      );
      assert.equal(hashFile(paths.image + ".previous"), fixture.originalHash);
      assert.equal(fs.statSync(paths.image).mode & 0o777, 0o755);
      assert.ok(
        fs.readFileSync(paths.launcher, "utf8").includes("IntelBoard.AppImage"),
      );
      assert.equal(hashFile(baseline.original), fixture.originalHash);
    }
    fs.writeFileSync(
      path.join(data, "update-result.json"),
      JSON.stringify({
        ok: true,
        channel: fixture.channel,
        version: app.getVersion(),
        boards: true,
        attachments: true,
        preferences: true,
        offlineCollaboration: true,
        backup: true,
        restart: true,
      }),
    );
    return;
  }
  assert.equal(app.getVersion(), "9.0.0");
  assert.equal(
    fs.existsSync(baselineFile),
    false,
    "The updater must restart into the new executable, not the old one",
  );
  const board = service.store.create("Updater synthetic research"),
    note = randomUUID();
  const asset = await service.assets.add(
    await sharp({
      create: { width: 4, height: 4, channels: 4, background: "#879c87" },
    })
      .png()
      .toBuffer(),
    "Synthetic.png",
    "image/png",
  );
  board.nodes = [
    {
      id: note,
      type: "research",
      position: { x: 50, y: 50 },
      style: { width: 280, height: 220 },
      data: { kind: "note", text: "Before update" },
    },
    {
      id: randomUUID(),
      type: "research",
      position: { x: 400, y: 50 },
      style: { width: 280, height: 220 },
      data: { kind: "image", assetId: asset.id, title: "Preserved attachment" },
    },
  ];
  service.store.save(board.id, board);
  const shared = service.store.create("Shared research");
  await service.collaboration.handle("share", shared.id);
  service.collaboration.engine.edit(shared.id, (doc) => {
    const title = doc.getText("title");
    title.delete(0, title.length);
    title.insert(0, "Offline shared research");
  });
  const baseline = {
    board: board.id,
    note,
    shared: shared.id,
    asset: asset.id,
    assetHash: hashFile(path.join(service.assets.folder, asset.id)),
    identity: createHash("sha256")
      .update(JSON.stringify(service.collaboration.engine.identity))
      .digest("hex"),
    original: process.env.APPIMAGE,
  };
  await window.webContents.executeJavaScript(
    `localStorage.setItem('intelboard.last','${board.id}');localStorage.setItem('intelboard.updater-e2e','preserved');localStorage.setItem('intelboard.theme','forest')`,
  );
  await window.reload();
  await wait(window, `!!document.querySelector('[data-id="${note}"]')`);
  await updater.check(true);
  const selector = `.update-${fixture.channel}.update-icon`;
  const confirmation = `document.querySelector('[aria-label="Confirm application update"]')`;
  await wait(window, `!!document.querySelector('${selector}')`);
  await click(window, selector);
  await wait(window, `!!${confirmation}`);
  const screenshot = await window.webContents.capturePage(undefined, {
    stayHidden: true,
    stayAwake: true,
  });
  fs.writeFileSync(
    path.join(data, "update-confirmation.png"),
    screenshot.toPNG(),
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(data, "requests.json"))).downloads,
    0,
    "Opening confirmation must not download",
  );
  await click(window, ".update-actions button:first-child");
  await wait(window, `!${confirmation}`);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(data, "requests.json"))).downloads,
    0,
  );
  await click(window, selector);
  await wait(window, `!!${confirmation}`);
  fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  await click(window, ".update-actions .primary-button");
  // Real update installation owns shutdown. Do not let the smoke harness exit
  // or simulate a restart; a newly installed process must write the result.
  await new Promise(() => {});
}
