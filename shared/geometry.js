// Match React Flow's rendered dimensions, including NodeResizer changes.
// Saved width/height survive reopening; style retains the original creation size.
export function nodeBounds(node) {
  const region = node.data.kind === 'region';
  return {
    x: node.position.x,
    y: node.position.y,
    width: Number(node.measured?.width ?? node.width ?? node.style?.width ?? (region ? 720 : 280)),
    height: Number(node.measured?.height ?? node.height ?? node.style?.height ?? (region ? 480 : 220)),
  };
}
export function regionContains(region, node) {
  const outer = nodeBounds(region), inner = nodeBounds(node);
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height;
}
