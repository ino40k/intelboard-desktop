import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionHandleScale,
  zoomAtPoint,
  movingNodeIds,
  createAlignmentSession,
  alignDrag,
} from "../shared/canvas-interactions.js";
const node = (id, x, y, width = 100, height = 80, data = { kind: "note" }) => ({
  id,
  position: { x, y },
  style: { width, height },
  data,
});
test("handle enlargement is continuous, bounded to 3x and unchanged above default zoom", () => {
  for (const [zoom, scale] of [
    [4, 1],
    [1, 1],
    [0.8, 1.25],
    [0.5, 2],
    [1 / 3, 3],
    [0.05, 3],
  ])
    assert.equal(connectionHandleScale(zoom), scale);
  assert.ok(
    Math.abs(connectionHandleScale(0.5001) - connectionHandleScale(0.5)) <
      0.001,
  );
});
test("wheel zoom keeps the world point under the pointer and respects the existing zoom bounds", () => {
  const before = { x: 73, y: -24, zoom: 0.8 },
    point = { x: 600, y: 300 };
  for (const delta of [-100, 100, -10000, 10000]) {
    const after = zoomAtPoint(before, point, delta);
    assert.ok(
      Math.abs(
        (point.x - before.x) / before.zoom - (point.x - after.x) / after.zoom,
      ) < 1e-8,
    );
    assert.ok(
      Math.abs(
        (point.y - before.y) / before.zoom - (point.y - after.y) / after.zoom,
      ) < 1e-8,
    );
    assert.equal(after.zoom > before.zoom, delta < 0);
  }
  assert.equal(zoomAtPoint({ x: 0, y: 0, zoom: 4 }, point, -100).zoom, 4);
  assert.equal(zoomAtPoint({ x: 0, y: 0, zoom: 0.05 }, point, 100).zoom, 0.05);
});
test("nearby edges and centers align across different sizes, without a global grid", () => {
  let session = createAlignmentSession(
    [node("a", 13, 100), node("b", 200, 200, 160, 100)],
    ["a"],
    "a",
  );
  assert.equal(alignDrag(session, { x: 190, y: 0 }, 1).delta.x, 187); // x 203 -> left 200
  session = createAlignmentSession(
    [node("a", 13, 100), node("b", 200, 200, 160, 100)],
    ["a"],
    "a",
  );
  assert.equal(alignDrag(session, { x: 220, y: 0 }, 1).delta.x, 217); // center 283 -> 280
  assert.equal(alignDrag(session, { x: 400, y: 17 }, 1).delta.x, 400); // no target: no quantization
});
test("thresholds use screen pixels at low and high zoom, and far-away nodes never pull a drag", () => {
  for (const zoom of [0.25, 1, 2]) {
    const nodes = [node("a", 0, 0, 1000), node("b", 500, 100, 1000)];
    let s = createAlignmentSession(nodes, ["a"], "a");
    assert.equal(alignDrag(s, { x: 500 + 5 / zoom, y: 0 }, zoom).delta.x, 500);
    s = createAlignmentSession(nodes, ["a"], "a");
    assert.equal(
      alignDrag(s, { x: 500 + 10 / zoom, y: 0 }, zoom).delta.x,
      500 + 10 / zoom,
    );
  }
  const s = createAlignmentSession(
    [node("a", 0, 0), node("b", 500, 10000)],
    ["a"],
    "a",
  );
  assert.equal(alignDrag(s, { x: 503, y: 0 }, 1).delta.x, 503);
});
test("hysteresis holds a guide while the pointer is near it and releases cleanly", () => {
  const s = createAlignmentSession(
    [node("a", 0, 0), node("b", 500, 100)],
    ["a"],
    "a",
  );
  assert.equal(alignDrag(s, { x: 504, y: 0 }, 1).delta.x, 500);
  assert.equal(alignDrag(s, { x: 508, y: 0 }, 1).delta.x, 500);
  const free = alignDrag(s, { x: 511, y: 0 }, 1);
  assert.equal(free.delta.x, 511);
  assert.equal(
    free.guides.some((g) => g.axis === "x"),
    false,
  );
});
test("group and region followers form a rigid selection without pulling ancestors or unrelated nodes", () => {
  const nodes = [
    node("region", 0, 0, 700, 500, { kind: "region" }),
    node("a", 100, 100, 100, 80, { kind: "note", groupId: "g" }),
    node("b", 800, 100, 100, 80, { kind: "note", groupId: "g" }),
    node("outside", 1200, 0),
  ];
  assert.deepEqual([...movingNodeIds(nodes, ["a"])].sort(), ["a", "b"]);
  assert.deepEqual([...movingNodeIds(nodes, ["region"])].sort(), [
    "a",
    "b",
    "region",
  ]);
  const s = createAlignmentSession(nodes, ["a", "b"], "a"),
    snap = alignDrag(s, { x: 302, y: 0 }, 1);
  assert.equal(snap.delta.x, 300);
  for (const n of s.originals.values())
    assert.equal(n.position.x + snap.delta.x - n.position.x, 300);
});
test("containing regions are not magnetic backgrounds; moving formations never snap to their own followers", () => {
  let s = createAlignmentSession(
    [node("r", 0, 0, 1000, 1000, { kind: "region" }), node("a", 200, 200)],
    ["a"],
    "a",
  );
  assert.deepEqual(alignDrag(s, { x: 2, y: 2 }, 1).guides, []);
  s = createAlignmentSession(
    [node("r", 0, 0, 500, 500, { kind: "region" }), node("a", 100, 100)],
    ["r"],
    "r",
  );
  assert.deepEqual(alignDrag(s, { x: 3, y: 3 }, 1).guides, []);
});
test("equidistant targets resolve deterministically regardless of source node order", () => {
  const nodes = [
    node("moving", 0, 0),
    node("z", 500, 100),
    node("b", 510, 100),
  ];
  const one = alignDrag(
      createAlignmentSession(nodes, ["moving"], "moving"),
      { x: 505, y: 0 },
      1,
    ),
    two = alignDrag(
      createAlignmentSession([...nodes].reverse(), ["moving"], "moving"),
      { x: 505, y: 0 },
      1,
    );
  assert.deepEqual(one, two);
  assert.equal(one.delta.x, 510);
});
