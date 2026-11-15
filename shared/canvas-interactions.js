import { nodeBounds, regionContains } from "./geometry.js";

export const connectionHandleScale = (zoom) =>
  Math.min(3, Math.max(1, 1 / zoom));
export function zoomAtPoint(viewport, point, delta, min = 0.05, max = 4) {
  const zoom = Math.min(
    max,
    Math.max(
      min,
      viewport.zoom * Math.exp(-Math.max(-240, Math.min(240, delta)) * 0.002),
    ),
  );
  const ratio = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * ratio,
    y: point.y - (point.y - viewport.y) * ratio,
    zoom,
  };
}

// Expand one rigid drag formation, including groups and region contents. Moving
// a child does not move its containing region; moving a region carries its group.
export function movingNodeIds(nodes, selectedIds) {
  const ids = new Set(selectedIds),
    groups = new Map();
  for (const node of nodes)
    if (node.data.groupId) {
      if (!groups.has(node.data.groupId)) groups.set(node.data.groupId, []);
      groups.get(node.data.groupId).push(node.id);
    }
  const byId = new Map(nodes.map((n) => [n.id, n])),
    queue = [...ids];
  for (let i = 0; i < queue.length; i++) {
    const node = byId.get(queue[i]);
    if (!node) continue;
    const related = [...(groups.get(node.data.groupId) || [])];
    if (node.data.kind === "region")
      for (const other of nodes)
        if (regionContains(node, other)) related.push(other.id);
    for (const id of related)
      if (!ids.has(id)) {
        ids.add(id);
        queue.push(id);
      }
  }
  return ids;
}
function formationBounds(nodes) {
  const rects = nodes.map(nodeBounds),
    x = Math.min(...rects.map((n) => n.x)),
    y = Math.min(...rects.map((n) => n.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((n) => n.x + n.width)) - x,
    height: Math.max(...rects.map((n) => n.y + n.height)) - y,
  };
}
const contains = (a, b) =>
  b.x >= a.x &&
  b.y >= a.y &&
  b.x + b.width <= a.x + a.width &&
  b.y + b.height <= a.y + a.height;
const gap = (a, sizeA, b, sizeB) => Math.max(0, a - b - sizeB, b - a - sizeA);
const anchors = (rect, axis) =>
  axis === "x"
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
export function createAlignmentSession(nodes, selectedIds, anchorId) {
  const ids = movingNodeIds(nodes, selectedIds),
    originals = new Map(
      nodes.filter((n) => ids.has(n.id)).map((n) => [n.id, n]),
    );
  const bounds = formationBounds([...originals.values()]),
    index = { x: [], y: [] };
  for (const node of nodes)
    if (!ids.has(node.id)) {
      const rect = nodeBounds(node);
      if (node.data.kind === "region" && contains(rect, bounds)) continue;
      for (const axis of ["x", "y"])
        anchors(rect, axis).forEach((value, kind) =>
          index[axis].push({ value, kind, id: node.id, rect }),
        );
    }
  for (const axis of ["x", "y"])
    index[axis].sort(
      (a, b) =>
        a.value - b.value || a.id.localeCompare(b.id) || a.kind - b.kind,
    );
  return {
    ids,
    originals,
    bounds,
    index,
    anchorId,
    locks: { x: null, y: null },
  };
}
function lowerBound(items, value) {
  let low = 0,
    high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (items[middle].value < value) low = middle + 1;
    else high = middle;
  }
  return low;
}
// Distances are screen pixels. Query pre-sorted anchor bands instead of scanning
// the whole board on each mouse move; hysteresis keeps a guide steady near its edge.
export function alignDrag(session, delta, zoom) {
  const rect = {
      ...session.bounds,
      x: session.bounds.x + delta.x,
      y: session.bounds.y + delta.y,
    },
    guides = [],
    correction = { x: 0, y: 0 };
  for (const axis of ["x", "y"]) {
    const values = anchors(rect, axis),
      threshold = 6 / zoom,
      release = 9 / zoom;
    const nearby = (target) =>
      axis === "x"
        ? gap(rect.y, rect.height, target.y, target.height) <= 96 / zoom
        : gap(rect.x, rect.width, target.x, target.width) <= 96 / zoom;
    let best = session.locks[axis];
    if (
      !best ||
      Math.abs(best.target.value - values[best.kind]) > release ||
      !nearby(best.target.rect)
    )
      best = null;
    if (!best)
      for (let kind = 0; kind < values.length; kind++) {
        const items = session.index[axis],
          value = values[kind];
        for (
          let i = lowerBound(items, value - threshold);
          i < items.length && items[i].value <= value + threshold;
          i++
        ) {
          const target = items[i];
          if (!nearby(target.rect)) continue;
          const distance = Math.abs(target.value - value),
            priority = kind === target.kind ? 0 : 1;
          if (
            !best ||
            distance < best.distance - 1e-8 ||
            (Math.abs(distance - best.distance) < 1e-8 &&
              (priority < best.priority ||
                (priority === best.priority && target.id < best.target.id)))
          )
            best = { target, kind, distance, priority };
        }
      }
    session.locks[axis] = best;
    if (best) {
      correction[axis] = best.target.value - values[best.kind];
      const other = best.target.rect;
      guides.push({
        axis,
        at: best.target.value,
        from:
          Math.min(
            axis === "x" ? rect.y : rect.x,
            axis === "x" ? other.y : other.x,
          ) -
          10 / zoom,
        to:
          Math.max(
            axis === "x" ? rect.y + rect.height : rect.x + rect.width,
            axis === "x" ? other.y + other.height : other.x + other.width,
          ) +
          10 / zoom,
      });
    }
  }
  return {
    delta: { x: delta.x + correction.x, y: delta.y + correction.y },
    guides,
  };
}
