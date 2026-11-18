import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createService } from "../desktop/service.js";
import { CollaborationMedia } from "../desktop/collaboration/media.js";
import { RemoteUpdateGuard } from "../desktop/collaboration/decode-guard.js";
import { Y, base64 } from "../shared/collaboration/document.js";

test("attachment resume survives a restart, truncates uncommitted bytes, verifies corruption, and scopes private media per board", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "intelboard-media-"));
  const source = createService(path.join(root, "a")),
    target = createService(path.join(root, "b"));
  t.after(async () => {
    source.close();
    target.close();
    await rm(root, { recursive: true, force: true });
  });
  const a = new CollaborationMedia(source, path.join(root, "a"));
  let b = new CollaborationMedia(target, path.join(root, "b"));
  const bytes = randomBytes(8 * 1024 * 1024 + 123),
    asset = await source.assets.add(
      bytes,
      "synthetic.bin",
      "application/octet-stream",
    ),
    manifest = await a.local(asset.id),
    docId = "doc-placeholder",
    other = "other-placeholder";
  for (const service of [source, target])
    for (const id of [docId, other]) {
      const board = service.store.create("Synthetic asset scope");
      service.store.db
        .prepare(
          "INSERT INTO collab_boards(board_id,doc_id,genesis,state) VALUES(?,?,?,?)",
        )
        .run(board.id, id, "{}", new Uint8Array());
    }
  a.authorize(docId, manifest);
  assert.equal(await b.resume(manifest, docId), 0);
  await b.chunk(manifest, 0, bytes.subarray(0, 65536), docId);
  await appendFile(
    path.join(b.partialDir, manifest.hash + ".part"),
    Buffer.from("uncommitted crash tail"),
  );
  b = new CollaborationMedia(target, path.join(root, "b"));
  assert.equal(await b.resume(manifest, docId), 65536);
  for (let offset = 65536; offset < bytes.length; offset += 65536)
    await b.chunk(
      manifest,
      offset,
      bytes.subarray(offset, offset + 65536),
      docId,
    );
  assert.deepEqual(
    await readFile(path.join(target.assets.folder, manifest.id)),
    bytes,
  );
  assert.ok(b.complete(manifest, docId));
  assert.equal(b.complete(manifest, other), false);
  await assert.rejects(b.read(manifest, 0, other), /not available/);
  assert.equal(
    await b.resume(manifest, other),
    0,
    "A private/global hash match is not a shared-board permission",
  );
  const corrupt = Buffer.from(bytes);
  corrupt[0] ^= 1;
  const finalOffset = Math.floor((corrupt.length - 1) / 65536) * 65536;
  for (let offset = 0; offset < finalOffset; offset += 65536)
    await b.chunk(
      manifest,
      offset,
      corrupt.subarray(offset, offset + 65536),
      other,
    );
  await assert.rejects(
    b.chunk(manifest, finalOffset, corrupt.subarray(finalOffset), other),
    /integrity/,
  );
  assert.equal(await b.resume(manifest, other), 0);
  assert.equal(b.complete(manifest, other), false);
});

test("validated image previews remain available after temporary transfer records are removed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "intelboard-preview-"));
  const service = createService(root);
  t.after(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  const media = new CollaborationMedia(service, root),
    image = await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#abcdef" },
    })
      .png()
      .toBuffer();
  const asset = await service.assets.add(image, "synthetic.png", "image/png"),
    manifest = await media.local(asset.id);
  await service.assets.remove(asset.id);
  const canonical = service.assets.get(manifest.id);
  assert.ok(canonical.thumbnail);
  assert.ok(
    (await readFile(path.join(service.assets.folder, canonical.thumbnail)))
      .length > 0,
  );
});

test("malformed Yjs decoding is contained in a bounded worker and a subsequent valid update succeeds", async (t) => {
  const guard = new RemoteUpdateGuard();
  t.after(() => guard.close());
  await assert.rejects(
    guard.check([
      {
        payload: { kind: "update", data: base64(Uint8Array.of(255, 255, 255)) },
      },
    ]),
    /Malformed/,
  );
  const doc = new Y.Doc();
  doc.getText("title").insert(0, "Valid");
  await guard.check([
    { payload: { kind: "update", data: base64(Y.encodeStateAsUpdate(doc)) } },
  ]);
  await guard.check([
    { payload: { kind: "update", data: base64(Y.encodeStateAsUpdate(doc)) } },
  ]);
  doc.destroy();
});

test("a fully written checkpoint finalizes after an interrupted registration", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "intelboard-media-finalize-"),
  );
  const source = createService(path.join(root, "source"));
  const targetDir = path.join(root, "target");
  let target = createService(targetDir);
  t.after(async () => {
    source.close();
    target.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from("attachment checkpoint");
  const asset = await source.assets.add(bytes, "attachment.txt", "text/plain");
  const manifest = await new CollaborationMedia(source, root).local(asset.id);
  const receiver = new CollaborationMedia(target, targetDir);
  target.assets.add = async () => {
    throw new Error("Registration interrupted");
  };
  await assert.rejects(
    receiver.chunk(manifest, 0, bytes),
    /Registration interrupted/,
  );
  assert.equal(receiver.complete(manifest), false);
  target.close();
  target = createService(targetDir);
  const restarted = new CollaborationMedia(target, targetDir);
  assert.equal(await restarted.resume(manifest), bytes.length);
  assert.equal(restarted.complete(manifest), true);
  assert.deepEqual(await restarted.read(manifest, 0), bytes);
  assert.equal(
    target.store.db.prepare("SELECT COUNT(*) AS n FROM collab_downloads").get()
      .n,
    0,
  );
});
