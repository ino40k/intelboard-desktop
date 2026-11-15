import { nodeBounds } from "../geometry.js";
import { concurrentCreations } from "./document.js";
const gap = 48;
const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
const concurrent = concurrentCreations;
// A derived view, never a stream of corrective CRDT moves. Equal document state
// produces equal offsets, regardless of message order or which peer rendered it.
export function mergedLayout(doc, nodes) {
  const groups = new Map(),
    births = new Map(),
    offsets = new Map(),
    warnings = [];
  for (const node of nodes) {
    const entry = doc.getMap("nodes").get(node.id),
      birth = entry.get("birth");
    if (!birth || birth.initial || entry.get("positioned")) continue;
    births.set(node.id, birth);
    const key = `${birth.actor}:${birth.batch}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const placed = [];
  const existing = nodes.filter((n) => !births.has(n.id)).map(nodeBounds);
  for (const [key, cluster] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    let dx = 0;
    const collision = placed.some((other) =>
      cluster.some((a) =>
        other.nodes.some(
          (b) =>
            concurrent(births.get(a.id), births.get(b.id)) &&
            overlaps(nodeBounds(a), {
              ...nodeBounds(b),
              x: b.position.x + other.dx,
            }),
        ),
      ),
    );
    if (collision) {
      // Existing regions/groups express intentional containment. Preserve them
      // rather than pulling a new cluster out of an established composition.
      const coupled = cluster.some((a) =>
        nodes.some(
          (b) =>
            !cluster.includes(b) &&
            ((a.data.groupId && a.data.groupId === b.data.groupId) ||
              (b.data.kind === "region" &&
                (!births.has(b.id) ||
                  !concurrent(births.get(a.id), births.get(b.id))) &&
                overlaps(nodeBounds(a), nodeBounds(b)))),
        ),
      );
      if (coupled) warnings.push(key);
      else {
        const occupied = [
          ...existing,
          ...placed.flatMap((g) =>
            g.nodes.map((n) => ({ ...nodeBounds(n), x: n.position.x + g.dx })),
          ),
        ];
        for (let attempt = 0; attempt < 100; attempt++) {
          const hits = cluster.flatMap((n) =>
            occupied.filter((o) =>
              overlaps({ ...nodeBounds(n), x: n.position.x + dx }, o),
            ),
          );
          if (!hits.length) break;
          dx =
            Math.max(...hits.map((r) => r.x + r.width)) -
            Math.min(...cluster.map((n) => n.position.x)) +
            gap;
        }
      }
    }
    for (const node of cluster)
      if (dx) offsets.set(node.id, { x: dx, y: 0, cluster: key });
    placed.push({ nodes: cluster, dx });
  }
  return {
    nodes: nodes.map((n) =>
      offsets.has(n.id)
        ? {
            ...n,
            position: {
              x: n.position.x + offsets.get(n.id).x,
              y: n.position.y,
            },
          }
        : n,
    ),
    offsets,
    warnings,
  };
}
