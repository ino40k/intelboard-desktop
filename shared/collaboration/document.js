import * as Y from "yjs";
import diff from "fast-diff";
import { formatRuns } from "../format.js";
import { boardSchema, nodeSchema, edgeSchema } from "../schema.js";
import { manifestSchema } from "./assets.js";

export { Y };
export const LOCAL = "intelboard-local-edit";
export const REMOTE = "intelboard-remote-edit";
export const TEXT_FIELDS = ["text", "title", "description", "caption"];
const observedClocks = new WeakMap();
export function concurrentCreations(a, b) {
  if (!a || !b || a.initial || b.initial || a.actor === b.actor) return false;
  const clocks = (birth) => {
    let value = observedClocks.get(birth);
    if (!value) {
      value = Y.decodeStateVector(unbase64(birth.seen));
      observedClocks.set(birth, value);
    }
    return value;
  };
  return (
    (clocks(a).get(b.client) || 0) <= b.clock &&
    (clocks(b).get(a.client) || 0) <= a.clock
  );
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (value) => JSON.parse(JSON.stringify(value));
export function base64(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i += 8192)
    str += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(str);
}
export function unbase64(text, limit = 2 * 1024 * 1024) {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil(limit / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    throw new Error("Invalid collaborative update encoding");
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (bytes.length > limit)
    throw new Error("Collaborative update exceeds its limit");
  return bytes;
}
export function textValue(text) {
  let value = "",
    format = [];
  for (const span of text.toDelta()) {
    if (typeof span.insert !== "string")
      throw new Error("Unsupported collaborative text content");
    const start = value.length;
    value += span.insert;
    const a = span.attributes || {};
    const style = (a.bold ? 1 : 0) | (a.italic ? 2 : 0) | (a.underline ? 4 : 0);
    if (style) format.push({ start, end: value.length, style });
  }
  return {
    text: value,
    format: formatRuns(value, format).filter((r) => r.style),
  };
}
// Only the local edit's changed character spans are inserted/deleted. Yjs owns
// character identities and mark expansion; a whole note is never an LWW value.
export function editText(text, value = "", format = []) {
  const old = text.toString();
  let offset = 0;
  for (const [operation, content] of diff(old, value)) {
    if (operation === 0) offset += content.length;
    else if (operation === -1) text.delete(offset, content.length);
    else {
      text.insert(offset, content, {
        bold: null,
        italic: null,
        underline: null,
      });
      offset += content.length;
    }
  }
  const wanted = formatRuns(value, format);
  const actual = textValue(text).format;
  if (
    !same(
      actual,
      wanted.filter((r) => r.style),
    )
  ) {
    const boundaries = [
      ...new Set([
        0,
        value.length,
        ...actual.flatMap((r) => [r.start, r.end]),
        ...wanted.flatMap((r) => [r.start, r.end]),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i],
        end = boundaries[i + 1];
      const oldMask =
        actual.find((r) => r.start <= start && r.end > start)?.style || 0;
      const newMask =
        wanted.find((r) => r.start <= start && r.end > start)?.style || 0;
      const attributes = {};
      for (const [bit, name] of [
        [1, "bold"],
        [2, "italic"],
        [4, "underline"],
      ])
        if ((oldMask ^ newMask) & bit)
          attributes[name] = newMask & bit ? true : null;
      if (Object.keys(attributes).length)
        text.format(start, end - start, attributes);
    }
  }
}
function assign(map, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[key], after[key])) continue;
    if (after[key] === undefined) map.delete(key);
    else map.set(key, clone(after[key]));
  }
}
function props(node) {
  const { data, id, selected, dragging, resizing, measured, ...rest } = node;
  return JSON.parse(JSON.stringify(rest));
}
function metadata(data) {
  const result = { ...data };
  for (const key of [
    ...TEXT_FIELDS,
    "formats",
    "loading",
    "localUrl",
    "uploadError",
  ])
    delete result[key];
  return JSON.parse(JSON.stringify(result));
}
function newNode(doc, node, provenance) {
  const entry = new Y.Map();
  doc.getMap("nodes").set(node.id, entry);
  entry.set("props", new Y.Map());
  entry.set("data", new Y.Map());
  entry.set("texts", new Y.Map());
  entry.set("deleted", false);
  entry.set("birth", provenance);
  for (const field of TEXT_FIELDS) entry.get("texts").set(field, new Y.Text());
  return entry;
}
function updateNode(entry, before, after) {
  assign(entry.get("props"), before ? props(before) : {}, props(after));
  assign(
    entry.get("data"),
    before ? metadata(before.data) : {},
    metadata(after.data),
  );
  for (const field of TEXT_FIELDS) {
    const previous = before?.data?.[field] || "",
      next = after.data[field] || "";
    const prevFormat = before?.data?.formats?.[field] || [],
      nextFormat = after.data.formats?.[field] || [];
    if (previous !== next || !same(prevFormat, nextFormat))
      editText(entry.get("texts").get(field), next, nextFormat);
  }
}
const values = new WeakMap();
const validatedNodes = new WeakSet(),
  validatedGeometry = new WeakMap(),
  validatedAssets = new WeakMap();
function cachedValue(entry, build) {
  let cache = values.get(entry);
  if (!cache) {
    cache = { value: null };
    values.set(entry, cache);
    entry.observeDeep(() => {
      cache.value = null;
      validatedNodes.delete(entry);
    });
  }
  return (cache.value ||= build());
}
export function readNode(id, entry) {
  return cachedValue(entry, () => {
    const data = entry.get("data").toJSON(),
      formats = {};
    for (const field of TEXT_FIELDS) {
      const value = textValue(entry.get("texts").get(field));
      if (value.text || (field === "text" && data.kind === "note"))
        data[field] = value.text;
      if (value.format.length) formats[field] = value.format;
    }
    if (Object.keys(formats).length) data.formats = formats;
    return nodeSchema.parse({ id, ...entry.get("props").toJSON(), data });
  });
}
export function readEdge(id, entry) {
  return cachedValue(entry, () => {
    const value = textValue(entry.get("label"));
    const edge = { id, ...entry.get("props").toJSON(), label: value.text };
    if (value.format.length)
      edge.data = { ...edge.data, labelFormat: value.format };
    return edgeSchema.parse(edge);
  });
}
export function createDocument() {
  return new Y.Doc({ gc: false });
}
export function boardValue(doc, viewport = { x: 100, y: 100, zoom: 1 }) {
  const nodes = [],
    edges = [];
  for (const [id, node] of doc.getMap("nodes"))
    if (!node.get("deleted")) nodes.push(readNode(id, node));
  // A remote reference is not authority to read another board's local UUID.
  // Only content-addressed, explicitly declared shared media reaches the view.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    let data;
    for (const key of ["assetId", "thumbnailId", "faviconId"])
      if (node.data[key] && !doc.getMap("assets").has(node.data[key])) {
        data ||= { ...node.data };
        delete data[key];
      }
    if (data) nodes[i] = { ...node, data };
  }
  const ordering = (root) => (a, b) => {
    const aa = doc.getMap(root).get(a.id).get("birth"),
      bb = doc.getMap(root).get(b.id).get("birth");
    return (
      Number(!aa?.initial) - Number(!bb?.initial) ||
      (aa?.order || 0) - (bb?.order || 0) ||
      a.id.localeCompare(b.id)
    );
  };
  nodes.sort(ordering("nodes"));
  const alive = new Set(nodes.map((n) => n.id));
  for (const [id, edge] of doc.getMap("edges")) {
    if (edge.get("deleted")) continue;
    const item = readEdge(id, edge);
    if (alive.has(item.source) && alive.has(item.target)) edges.push(item);
  }
  edges.sort(ordering("edges"));
  return {
    title: doc.getText("title").toString() || "Untitled board",
    revision: 0,
    viewport,
    nodes,
    edges,
  };
}
export function validateDocument(doc) {
  if (
    [...doc.share.keys()].some(
      (key) => !["nodes", "edges", "geometry", "assets", "title"].includes(key),
    )
  )
    throw new Error("Unknown shared-document root");
  if (
    doc.getMap("nodes").size > 15000 ||
    doc.getMap("edges").size > 30000 ||
    doc.getMap("geometry").size > 50000
  )
    throw new Error(
      "Shared board history exceeds the supported document limit",
    );
  // Validate tombstoned objects too. Otherwise an invalid hidden object could
  // become active later merely by restoring it.
  for (const [id, entry] of doc.getMap("nodes")) {
    if (validatedNodes.has(entry)) continue;
    readNode(id, entry);
    const birth = entry.get("birth");
    if (
      !birth ||
      typeof birth.actor !== "string" ||
      birth.actor.length > 128 ||
      typeof birth.batch !== "string" ||
      birth.batch.length > 128 ||
      !Number.isSafeInteger(birth.client) ||
      !Number.isSafeInteger(birth.clock) ||
      birth.clock < 0 ||
      typeof birth.initial !== "boolean" ||
      Y.decodeStateVector(unbase64(birth.seen, 96000)).size > 4096 ||
      entry.get("props").size > 15 ||
      entry.get("data").size > 40 ||
      entry.get("texts").size !== 4
    )
      throw new Error("Invalid shared object metadata");
    validatedNodes.add(entry);
  }
  for (const [id, entry] of doc.getMap("edges")) readEdge(id, entry);
  for (const [id, geometry] of doc.getMap("geometry")) {
    if (
      geometry &&
      typeof geometry === "object" &&
      validatedGeometry.get(geometry) === id
    )
      continue;
    if (
      id.length > 256 ||
      !geometry ||
      !Number.isFinite(geometry.at) ||
      typeof geometry.actor !== "string" ||
      geometry.actor.length > 128 ||
      !doc.getMap("nodes").has(geometry.node) ||
      JSON.stringify(geometry).length > 2000
    )
      throw new Error("Invalid geometry recovery record");
    for (const state of [geometry.before, geometry.after]) {
      if (
        !state ||
        !Number.isFinite(state.position?.x) ||
        !Number.isFinite(state.position?.y)
      )
        throw new Error("Invalid geometry recovery position");
      for (const key of ["width", "height"])
        if (
          state[key] !== undefined &&
          (!Number.isFinite(state[key]) ||
            state[key] < 30 ||
            state[key] > 20000)
        )
          throw new Error("Invalid geometry recovery dimensions");
      if (
        state.style !== undefined &&
        (!state.style ||
          Object.keys(state.style).some(
            (k) => !["width", "height"].includes(k),
          ) ||
          Object.values(state.style).some(
            (n) => !Number.isFinite(n) || n < 30 || n > 20000,
          ))
      )
        throw new Error("Invalid geometry recovery style");
    }
    validatedGeometry.set(geometry, id);
  }
  if (doc.getMap("assets").size > 10000)
    throw new Error("Too many shared attachments");
  for (const [id, manifest] of doc.getMap("assets")) {
    if (
      manifest &&
      typeof manifest === "object" &&
      validatedAssets.get(manifest) === id
    )
      continue;
    if (manifestSchema.parse(manifest).id !== id)
      throw new Error("Invalid shared attachment reference");
    validatedAssets.set(manifest, id);
  }
  const value = boardSchema.parse(boardValue(doc));
  if (JSON.stringify(value).length > 32 * 1024 * 1024)
    throw new Error("Shared board structure is too large");
  return value;
}
export function patchBoard(doc, before, after, options = {}) {
  const {
    actor = "local",
    batch = "local",
    session,
    initial = false,
    nonceForId = (id) => id,
    inactive = false,
    order,
  } = options;
  const oldNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(
    after.nodes.map((n) => [n.id, nodeSchema.parse(n)]),
  );
  const oldEdges = new Map(before.edges.map((e) => [e.id, e]));
  const nextEdges = new Map(
    after.edges.map((e) => [e.id, edgeSchema.parse(e)]),
  );
  const seen = base64(Y.encodeStateVector(doc));
  doc.transact(() => {
    if (before.title !== after.title)
      editText(doc.getText("title"), after.title);
    for (const [id, previous] of oldNodes)
      if (!nextNodes.has(id)) {
        const entry = doc.getMap("nodes").get(id);
        if (entry) {
          entry.set("deleted", true);
          entry.set("deletedAt", Date.now());
        }
      }
    for (const [id, node] of nextNodes) {
      const previous = oldNodes.get(id);
      let entry = doc.getMap("nodes").get(id);
      if (!entry) {
        const clock =
          Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) || 0;
        entry = newNode(doc, node, {
          actor,
          batch,
          session,
          client: doc.clientID,
          clock,
          seen,
          initial,
          nonce: nonceForId(id),
          order: order ?? doc.getMap("nodes").size,
          position: node.position,
          width: Number(node.width || node.style?.width || 280),
          height: Number(node.height || node.style?.height || 220),
        });
      }
      if (!previous && entry.get("deleted")) entry.set("deleted", false);
      if (
        previous &&
        !same(
          [previous.position, previous.width, previous.height, previous.style],
          [node.position, node.width, node.height, node.style],
        )
      ) {
        const history = doc.getMap("geometry");
        history.set(
          `${actor}:${doc.clientID}:${Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) || 0}`,
          {
            node: id,
            actor,
            before: {
              position: previous.position,
              width: previous.width,
              height: previous.height,
              style: previous.style,
            },
            after: {
              position: node.position,
              width: node.width,
              height: node.height,
              style: node.style,
            },
            at: Date.now(),
          },
        );
        // Arranging a newly created cluster while still offline must not disable
        // collision handling. Pin only after a concurrent creation is known.
        const birth = entry.get("birth");
        if (
          [...doc.getMap("nodes").values()].some(
            (other) =>
              !other.get("deleted") &&
              concurrentCreations(birth, other.get("birth")),
          )
        ) {
          for (const other of doc.getMap("nodes").values()) {
            const provenance = other.get("birth");
            if (
              provenance.actor === birth.actor &&
              provenance.batch === birth.batch
            )
              other.set("positioned", true);
          }
        }
      }
      updateNode(entry, previous, node);
      if (inactive) entry.set("deleted", true);
    }
    for (const [id] of oldEdges)
      if (!nextEdges.has(id)) {
        const entry = doc.getMap("edges").get(id);
        entry?.set("deleted", true);
        entry?.set("deletedAt", Date.now());
      }
    for (const [id, edge] of nextEdges) {
      const previous = oldEdges.get(id);
      let entry = doc.getMap("edges").get(id);
      if (!entry) {
        entry = new Y.Map();
        doc.getMap("edges").set(id, entry);
        entry.set("props", new Y.Map());
        entry.set("label", new Y.Text());
        entry.set("deleted", false);
        entry.set("birth", {
          actor,
          session,
          initial,
          nonce: nonceForId(id),
          order: order ?? doc.getMap("edges").size,
        });
      }
      if (!previous && entry.get("deleted")) entry.set("deleted", false);
      const edgeProps = (e) => {
        if (!e) return {};
        const { id, label, selected, ...p } = e;
        if (p.data) {
          p.data = { ...p.data };
          delete p.data.labelFormat;
        }
        return JSON.parse(JSON.stringify(p));
      };
      assign(entry.get("props"), edgeProps(previous), edgeProps(edge));
      if (
        (previous?.label || "") !== (edge.label || "") ||
        !same(previous?.data?.labelFormat, edge.data?.labelFormat)
      )
        editText(
          entry.get("label"),
          String(edge.label || ""),
          edge.data?.labelFormat || [],
        );
      if (inactive) entry.set("deleted", true);
    }
  }, options.origin || LOCAL);
}
export function recoveryItems(doc, now = Date.now()) {
  const deleted = [];
  for (const [id, entry] of doc.getMap("nodes"))
    if (
      entry.get("deleted") &&
      now - (entry.get("deletedAt") || now) < 30 * 86400000
    )
      deleted.push(readNode(id, entry));
  const edges = [];
  for (const [id, entry] of doc.getMap("edges"))
    if (
      entry.get("deleted") &&
      now - (entry.get("deletedAt") || now) < 30 * 86400000
    )
      edges.push(readEdge(id, entry));
  return {
    deleted,
    edges,
    geometry: [...doc.getMap("geometry").entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-100)
      .map(([id, value]) => ({ id, ...value })),
  };
}
export function textBinding(doc, id, field = "text", edge = false) {
  const entry = doc.getMap(edge ? "edges" : "nodes").get(id);
  return edge ? entry?.get("label") : entry?.get("texts")?.get(field);
}
