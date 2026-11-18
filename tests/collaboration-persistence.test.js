import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import JSZip from "jszip";
import { createService } from "../desktop/service.js";
import { CollaborationEngine } from "../desktop/collaboration/engine.js";
import { CollaborationManager } from "../desktop/collaboration/manager.js";
import { exportBoards, importBoards } from "../desktop/transfer.js";
import { assetIdForHash } from "../shared/collaboration/assets.js";
import { boardValue } from "../shared/collaboration/document.js";

test("forced process death before and after commit recovers the authoritative journal and projection together", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "intelboard-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let service = createService(dir),
    engine = new CollaborationEngine(service.store);
  const board = service.store.create("Synthetic crash");
  board.nodes = [
    {
      id: randomUUID(),
      type: "research",
      position: { x: 0, y: 0 },
      data: { kind: "note", text: "original" },
    },
  ];
  service.store.save(board.id, board);
  engine.share(board.id);
  engine.close();
  service.close();
  for (const phase of ["before", "after"]) {
    const child = spawnSync(
      process.execPath,
      ["scripts/collaboration-crash-fixture.js", dir, board.id, phase],
      { timeout: 10000, encoding: "utf8" },
    );
    assert.ok(child.signal || child.status !== 0, "Fixture must exit abruptly");
    service = createService(dir);
    engine = new CollaborationEngine(service.store);
    const expected = phase === "before" ? "original" : "durable original";
    assert.equal(
      boardValue(engine.get(board.id).doc).nodes[0].data.text,
      expected,
    );
    assert.equal(service.store.get(board.id).nodes[0].data.text, expected);
    assert.equal(
      service.store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    engine.close();
    service.close();
  }
});

test("a stale checkpoint proof falls back to the signed journal", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "intelboard-checkpoint-"));
  const service = createService(dir);
  let engine = new CollaborationEngine(service.store);
  t.after(async () => {
    engine.close();
    service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const board = service.store.create("Checkpoint");
  engine.share(board.id);
  assert.ok(
    service.store.db.prepare("SELECT proof FROM collab_checkpoints").get()
      .proof,
  );
  engine.edit(board.id, (doc) => doc.getText("title").insert(10, " suffix"));
  engine.close();
  service.store.db
    .prepare("UPDATE collab_boards SET state=? WHERE board_id=?")
    .run(new Uint8Array([255]), board.id);
  engine = new CollaborationEngine(service.store);
  assert.equal(boardValue(engine.get(board.id).doc).title, "Checkpoint suffix");
});

test("shared exports import as private copies, exclude identity/history, and reject missing media", async (t) => {
  const dir = await mkdtemp(
      path.join(os.tmpdir(), "intelboard-shared-export-"),
    ),
    service = createService(dir),
    manager = new CollaborationManager(service, dir, { transport: false });
  service.collaboration = manager;
  t.after(async () => {
    manager.close();
    service.close();
    await rm(dir, { recursive: true, force: true });
  });
  const board = service.store.create("Synthetic shared export");
  board.nodes = [
    {
      id: randomUUID(),
      type: "research",
      position: { x: 1, y: 2 },
      data: { kind: "note", text: "portable" },
    },
  ];
  service.store.save(board.id, board);
  await manager.handle("share", board.id);
  const archive = path.join(dir, "synthetic.intelboard");
  await exportBoards(service, [board.id], archive);
  const zip = await JSZip.loadAsync(await readFile(archive)),
    manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(manifest.boards[0].shared, undefined);
  assert.equal(manifest.boards[0].documentId, undefined);
  assert.ok(
    !JSON.stringify(manifest).includes(manager.engine.identity.publicKey),
  );
  assert.ok(
    !JSON.stringify(manifest).includes(manager.engine.identity.privateKey),
  );
  const [copy] = await importBoards(service, archive);
  assert.equal(service.store.get(copy).shared, undefined);
  assert.equal(service.store.get(copy).nodes[0].data.text, "portable");
  const hash = createHash("sha256")
      .update("missing synthetic bytes")
      .digest("hex"),
    id = assetIdForHash(hash);
  manager.engine.edit(board.id, (doc) => {
    doc.getMap("assets").set(id, {
      id,
      hash,
      size: 23,
      filename: "missing.txt",
      mime: "text/plain",
    });
    doc.getMap("nodes").get(board.nodes[0].id).get("data").set("assetId", id);
  });
  assert.equal(manager.canExport(board.id), false);
  await assert.rejects(
    exportBoards(service, [board.id], archive),
    /still arriving/,
  );
  assert.equal(manager.status(board.id).missing, 1);
  const before = service.store.list().length;
  await assert.rejects(
    service.request(`/boards/${board.id}/duplicate`, "POST"),
    /still arriving/,
  );
  await assert.rejects(
    manager.handle("private-copy", board.id),
    /still arriving/,
  );
  assert.equal(service.store.list().length, before);
});

test("hello verification failures settle the pending request and inventory resumes from its cursor", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "intelboard-cursor-"));
  const service = createService(dir);
  const manager = new CollaborationManager(service, dir, { transport: false });
  t.after(async () => {
    manager.close();
    service.close();
    await rm(dir, { recursive: true, force: true });
  });

  const board = service.store.create("Peer history");
  await manager.handle("share", board.id);
  const context = {
    id: randomUUID(),
    boardId: board.id,
    authenticated: true,
    publicKey: manager.engine.identity.publicKey,
  };
  manager.connections.set(context.id, context);

  const first = await manager.handlePeer(context, "inventory", {
    incremental: true,
  });
  const cursor = {
    incremental: true,
    epoch: first.epoch,
    offset: first.offset,
  };
  assert.equal(first.ids.length, 1);
  const idle = await manager.handlePeer(context, "inventory", cursor);
  assert.deepEqual(idle.ids, []);
  manager.engine.edit(board.id, (doc) => doc.getText("title").insert(12, "!"));
  const appended = await manager.handlePeer(context, "inventory", cursor);
  assert.equal(appended.epoch, first.epoch);
  assert.equal(appended.ids.length, 1);
  assert.notEqual(appended.ids[0], first.ids[0]);

  let request;
  manager.send = async (_, frame) => {
    request = frame.request;
  };
  manager.authenticate = () => {
    throw new Error("Hello verification failed");
  };
  const reply = manager.request(context, "hello");
  const rejected = assert.rejects(reply, /Hello verification failed/);
  await manager.frame({ id: context.id, frame: { type: "reply", request } });
  await rejected;
  assert.equal(manager.pending.size, 0);
});
