import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createService } from "../desktop/service.js";
import { CollaborationEngine } from "../desktop/collaboration/engine.js";
import {
  textBinding,
  boardValue,
  Y,
  createDocument,
  base64,
  unbase64,
} from "../shared/collaboration/document.js";
const count = Number(process.argv[2] || 1000),
  dir = await mkdtemp(path.join(os.tmpdir(), "intelboard-benchmark-")),
  service = createService(dir),
  engine = new CollaborationEngine(service.store);
try {
  const board = service.store.create("Synthetic performance");
  board.nodes = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    type: "research",
    position: { x: (i % 50) * 350, y: Math.floor(i / 50) * 250 },
    style: { width: 280, height: 220 },
    data: { kind: "note", text: "Synthetic note " + i },
  }));
  service.store.save(board.id, board);
  let start = performance.now();
  engine.share(board.id);
  const shareMs = performance.now() - start;
  const opened = engine.open(board.id),
    renderer = createDocument();
  Y.applyUpdate(renderer, unbase64(opened.data, 64 * 1024 * 1024));
  renderer.clientID = opened.client;
  let before;
  renderer.on("beforeTransaction", () => {
    before = base64(Y.encodeStateVector(renderer));
  });
  renderer.on("update", (bytes) =>
    engine.local(board.id, {
      session: opened.session,
      before,
      data: base64(bytes),
    }),
  );
  const samples = [];
  for (let i = 0; i < 20; i++) {
    start = performance.now();
    textBinding(renderer, board.nodes[0].id).insert(0, "x");
    samples.push(performance.now() - start);
  }
  start = performance.now();
  for (let i = 0; i < 20; i++) boardValue(engine.get(board.id).doc);
  const projectionMs = (performance.now() - start) / 20;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      nodes: count,
      shareMs: Math.round(shareMs),
      durableEditMedianMs: Math.round(samples[10]),
      durableEditP95Ms: Math.round(samples[19]),
      cachedProjectionMs: Number(projectionMs.toFixed(2)),
    }),
  );
  renderer.destroy();
} finally {
  engine.close();
  service.close();
  await rm(dir, { recursive: true, force: true });
}
