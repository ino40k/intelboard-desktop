import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createService } from "../desktop/service.js";
import {
  CollaborationEngine,
  clientId,
} from "../desktop/collaboration/engine.js";
import {
  newIdentity,
  randomUUID,
  signed,
} from "../desktop/collaboration/identity.js";
import {
  Y,
  LOCAL,
  boardValue,
  patchBoard,
  textBinding,
  editText,
  base64,
  createDocument,
} from "../shared/collaboration/document.js";
import { collaborationId } from "../shared/collaboration/ids.js";
import { mergedLayout } from "../shared/collaboration/layout.js";

const node = (text = "ab", x = 0, y = 0) => ({
  id: randomUUID(),
  type: "research",
  position: { x, y },
  style: { width: 280, height: 220 },
  data: { kind: "note", text },
});
async function replicas(t, count = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), "intelboard-crdt-"));
  const replicas = Array.from({ length: count }, (_, i) => {
    const service = createService(path.join(root, String(i)));
    return {
      service,
      engine: new CollaborationEngine(service.store, {
        identity: newIdentity("User " + i),
      }),
    };
  });
  t.after(async () => {
    for (const r of replicas) {
      r.engine.close();
      r.service.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  const first = replicas[0],
    board = first.service.store.create("Shared synthetic");
  board.nodes = [node()];
  first.service.store.save(board.id, board);
  first.id = board.id;
  first.engine.share(first.id);
  for (const other of replicas.slice(1)) {
    first.engine.grant(
      first.id,
      other.engine.identity.publicKey,
      other.engine.identity.name,
    );
    other.id = other.engine.accept(
      first.engine.get(first.id).genesis,
      first.engine.records(first.engine.get(first.id).docId),
    );
  }
  for (const other of replicas.slice(1)) sync(first, other);
  return replicas;
}
function sync(from, to, reverse = false) {
  const records = from.engine.records(from.engine.get(from.id).docId);
  const ordered = reverse ? records.reverse() : records;
  for (const record of ordered) to.engine.ingest(to.id, [record]);
}
function change(replica, fn, batch = "offline") {
  replica.engine.edit(replica.id, (doc) => {
    const before = boardValue(doc),
      after = structuredClone(before);
    fn(after);
    const nonces = new Map(),
      ids = new Map();
    for (const [previous, next] of [
      [before.nodes, after.nodes],
      [before.edges, after.edges],
    ])
      for (const item of next)
        if (!previous.some((n) => n.id === item.id)) {
          const nonce = randomUUID(),
            id = collaborationId(
              replica.engine.identity.id,
              nonce,
              replica.engine.get(replica.id).session,
            );
          ids.set(item.id, id);
          item.id = id;
          nonces.set(id, nonce);
        }
    for (const e of after.edges) {
      e.source = ids.get(e.source) || e.source;
      e.target = ids.get(e.target) || e.target;
    }
    patchBoard(doc, before, after, {
      actor: replica.engine.identity.id,
      session: replica.engine.get(replica.id).session,
      batch,
      nonceForId: (id) => nonces.get(id),
    });
  });
}
const logical = (r) => boardValue(r.engine.get(r.id).doc);

test("independent offline edits, rich text, geometry and connections converge across three forwarding peers", async (t) => {
  const [a, b, c] = await replicas(t);
  const existing = logical(a).nodes[0].id;
  change(a, (board) => {
    board.nodes[0].data.text = "aXb";
    board.nodes.push(node("A", 500, 400));
  });
  change(b, (board) => {
    board.nodes[0].data.text = "aYb";
    board.nodes[0].position = { x: 10, y: 20 };
    board.nodes.push(node("B", 1000, 400));
    board.edges.push({
      id: randomUUID(),
      source: existing,
      target: board.nodes[1].id,
      type: "research",
    });
  });
  sync(a, b, true);
  sync(b, c, true);
  sync(c, a);
  sync(a, b);
  assert.deepEqual(logical(a), logical(b));
  assert.deepEqual(logical(b), logical(c));
  assert.match(
    logical(a).nodes.find((n) => n.id === existing).data.text,
    /^a(XY|YX)b$/,
  );
  assert.deepEqual(logical(a).nodes.find((n) => n.id === existing).position, {
    x: 10,
    y: 20,
  });
  assert.equal(logical(a).nodes.length, 3);
  assert.equal(logical(a).edges.length, 1);
  // Repeated generations miss each other; no all-peers-online assumption.
  for (let round = 0; round < 4; round++) {
    for (const r of [a, b, c])
      change(
        r,
        (board) => board.nodes.push(node("Round " + round, round * 400, 800)),
        "round-" + round,
      );
    sync(b, a, round % 2);
    sync(a, c, true);
    sync(c, b);
    sync(b, a);
  }
  assert.deepEqual(logical(a), logical(c));
  assert.deepEqual(logical(a), logical(b));
  assert.equal(logical(a).nodes.length, 15);
});

test("simultaneous marks combine independently and selective local undo retains remote characters", async (t) => {
  const [a, b] = await replicas(t, 2),
    id = logical(a).nodes[0].id;
  change(a, (board) => {
    board.nodes[0].data.formats = { text: [{ start: 0, end: 2, style: 1 }] };
  });
  change(b, (board) => {
    board.nodes[0].data.formats = { text: [{ start: 0, end: 2, style: 2 }] };
  });
  sync(a, b);
  sync(b, a);
  assert.deepEqual(logical(a).nodes[0].data.formats.text, [
    { start: 0, end: 2, style: 3 },
  ]);
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.engine.get(a.id).doc));
  const text = textBinding(doc, id),
    origin = {},
    undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
  doc.transact(() => text.insert(1, "local"), origin);
  const remote = new Y.Doc({ gc: false });
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
  textBinding(remote, id).insert(1, "remote");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));
  undo.undo();
  assert.equal(text.toString(), "aremoteb");
  doc.destroy();
  remote.destroy();
});

test("delete versus edit preserves the edited content in recoverable tombstones", async (t) => {
  const [a, b] = await replicas(t, 2),
    id = logical(a).nodes[0].id;
  change(a, (board) => {
    board.nodes = [];
  });
  change(b, (board) => {
    board.nodes[0].data.text = "Edited while offline";
  });
  sync(a, b);
  sync(b, a);
  assert.equal(logical(a).nodes.length, 0);
  assert.equal(
    a.engine.status(a.id).recovery.deleted[0].data.text,
    "Edited while offline",
  );
  a.engine.edit(a.id, (doc) =>
    doc.getMap("nodes").get(id).set("deleted", false),
  );
  sync(a, b);
  assert.equal(logical(b).nodes[0].data.text, "Edited while offline");
});

test("owner revocation has a deterministic causal cut, quarantines dependent forks, and prevents further local updates", async (t) => {
  const [a, b, c] = await replicas(t);
  change(b, (board) => {
    board.nodes.push(node("B unacknowledged"));
  });
  sync(b, c);
  change(c, (board) => {
    board.nodes.push(node("C dependent recovery"));
  });
  a.engine.revoke(a.id, b.engine.identity.id);
  sync(a, c);
  sync(a, b);
  sync(c, a);
  assert.deepEqual(logical(a), logical(c));
  assert.equal(logical(a).nodes.length, 1);
  assert.ok(c.engine.status(c.id).quarantined >= 2);
  assert.equal(
    c.service.store.db
      .prepare("SELECT count(*) AS n FROM collab_recovery")
      .get().n,
    1,
  );
  assert.throws(
    () => change(b, (board) => board.nodes.push(node("Not permitted"))),
    /permission/,
  );
  assert.throws(
    () => c.engine.revoke(c.id, a.engine.identity.id),
    /Only the board owner/,
  );
});

test("a member can invite a third participant without the owner online; forged updates and client identities are rejected", async (t) => {
  const [a, b, c] = await replicas(t);
  const newcomer = newIdentity("Invited by member");
  const grant = b.engine.grant(b.id, newcomer.publicKey, newcomer.name);
  assert.ok(b.engine.get(b.id).members.members.has(newcomer.publicKey));
  sync(b, c);
  assert.ok(c.engine.get(c.id).members.members.has(newcomer.publicKey));
  const forged = structuredClone(grant);
  forged.payload.name = "Changed after signing";
  assert.throws(() => c.engine.ingest(c.id, [forged]), /Invalid signed/);
  const existing = a.engine
    .records(a.engine.get(a.id).docId)
    .find((r) => r.payload.kind === "update");
  const impersonation = signed(b.engine.identity, {
    ...existing.payload,
    author: undefined,
    session: randomUUID(),
  });
  assert.throws(() => c.engine.ingest(c.id, [impersonation]), /impersonate/);
  const badPolicy = signed(b.engine.identity, {
    v: 1,
    kind: "policy",
    docId: b.engine.get(b.id).docId,
    previous: b.engine.get(b.id).members.policy.id,
    sequence: 1,
    revoked: [a.engine.identity.id],
    heads: [],
    grants: [],
  });
  assert.throws(() => c.engine.ingest(c.id, [badPolicy]), /Only the owner/);
});

test("offline-created clusters are separated deterministically, preserving their relative layout and intentional existing overlaps", async (t) => {
  const [a, b] = await replicas(t, 2);
  change(
    a,
    (board) => board.nodes.push(node("A1", 500, 500), node("A2", 800, 500)),
    "A-cluster",
  );
  change(
    b,
    (board) => board.nodes.push(node("B1", 500, 500), node("B2", 800, 500)),
    "B-cluster",
  );
  change(a, (board) => {
    for (const item of board.nodes)
      if (item.data.text.startsWith("A")) item.position.x += 30;
  });
  for (const entry of a.engine.get(a.id).doc.getMap("nodes").values())
    if (entry.get("birth").batch === "A-cluster")
      assert.equal(
        entry.get("positioned"),
        undefined,
        "Offline arrangement must remain eligible for collision reconciliation",
      );
  sync(a, b);
  sync(b, a);
  const left = mergedLayout(a.engine.get(a.id).doc, logical(a).nodes);
  const right = mergedLayout(b.engine.get(b.id).doc, logical(b).nodes);
  assert.deepEqual(left.nodes, right.nodes);
  assert.equal(left.offsets.size, 2);
  for (const prefix of ["A", "B"]) {
    const cluster = left.nodes
      .filter((n) => n.data.text.startsWith(prefix))
      .sort((x, y) => x.data.text.localeCompare(y.data.text));
    assert.equal(cluster[1].position.x - cluster[0].position.x, 300);
  }
  const original = left.nodes.find((n) => n.data.text === "ab");
  assert.deepEqual(original.position, { x: 0, y: 0 });
  const before = JSON.stringify(left.nodes);
  for (let round = 0; round < 3; round++) {
    sync(a, b);
    sync(b, a);
  }
  assert.equal(
    JSON.stringify(
      mergedLayout(a.engine.get(a.id).doc, logical(a).nodes).nodes,
    ),
    before,
  );
});

test("journal replay after restart preserves accepted and pending histories without changing private boards or viewports", async (t) => {
  const [a, b] = await replicas(t, 2);
  const privateBoard = b.service.store.create("Private stays private");
  change(a, (board) => board.nodes.push(node("Delayed first")));
  change(a, (board) => board.nodes.push(node("Delayed second")));
  const updates = a.engine
    .records(a.engine.get(a.id).docId)
    .filter((r) => r.payload.kind === "update")
    .sort((x, y) => x.payload.sequence - y.payload.sequence);
  b.engine.ingest(b.id, [updates.at(-1)]);
  assert.ok(b.engine.status(b.id).quarantined > 0);
  b.engine.close();
  b.engine = new CollaborationEngine(b.service.store, {
    identity: b.engine.identity,
  });
  sync(a, b, true);
  assert.deepEqual(logical(a), logical(b));
  assert.equal(b.service.store.get(privateBoard.id).shared, undefined);
  assert.deepEqual(b.service.store.get(b.id).viewport, {
    x: 100,
    y: 100,
    zoom: 1,
  });
  assert.throws(
    () => b.service.store.save(b.id, b.service.store.get(b.id)),
    /collaborative changes/,
  );
  b.engine.close();
  b.service.store.remove(b.id);
  const source = a.engine.get(a.id),
    records = a.engine.records(source.docId);
  b.id = b.engine.accept(
    source.genesis,
    records.filter((r) => r.payload.kind !== "update"),
  );
  assert.equal(
    b.engine.status(b.id).initialComplete,
    false,
    "Membership acceptance alone must not mark an empty initial board as complete",
  );
  sync(a, b, true);
  assert.equal(b.engine.status(b.id).initialComplete, true);
  assert.deepEqual(logical(a), logical(b));
});

test("creation Undo retains a remote edit in a tombstone and Redo restores it", async (t) => {
  const [a, b] = await replicas(t, 2),
    entry = a.engine.get(a.id),
    doc = createDocument();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));
  const opened = a.engine.open(a.id);
  doc.clientID = opened.client;
  let before;
  doc.on("beforeTransaction", () => {
    before = base64(Y.encodeStateVector(doc));
  });
  doc.on("update", (bytes, origin) => {
    if (origin !== "remote")
      a.engine.local(a.id, {
        session: opened.session,
        before,
        data: base64(bytes),
      });
  });
  const undo = new Y.UndoManager([doc.getMap("nodes"), doc.getMap("edges")], {
    trackedOrigins: new Set([LOCAL]),
  });
  const nonce = randomUUID(),
    item = node("Created"),
    empty = { title: boardValue(doc).title, nodes: [], edges: [] };
  item.id = collaborationId(a.engine.identity.id, nonce, opened.session);
  patchBoard(
    doc,
    empty,
    { ...empty, nodes: [item] },
    {
      actor: a.engine.identity.id,
      session: opened.session,
      nonceForId: () => nonce,
      inactive: true,
      origin: "create",
    },
  );
  patchBoard(
    doc,
    boardValue(doc),
    { ...boardValue(doc), nodes: [...boardValue(doc).nodes, item] },
    { actor: a.engine.identity.id, session: opened.session },
  );
  sync(a, b);
  b.engine.edit(b.id, (d) => textBinding(d, item.id).insert(0, "Remote "));
  sync(b, a);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.engine.get(a.id).doc), "remote");
  undo.undo();
  assert.equal(boardValue(doc).nodes.length, 1);
  assert.equal(
    a.engine.status(a.id).recovery.deleted[0].data.text,
    "Remote Created",
  );
  undo.redo();
  assert.equal(
    boardValue(doc).nodes.find((n) => n.id === item.id).data.text,
    "Remote Created",
  );
  doc.destroy();
});

test("physical deletion, stale root replacement, and whole-text container replacement cannot erase history", async (t) => {
  const [a, b] = await replicas(t, 2),
    id = logical(a).nodes[0].id,
    prior = logical(b);
  assert.throws(
    () => b.engine.edit(b.id, (doc) => doc.getMap("nodes").delete(id)),
    /physically deleted/,
  );
  assert.throws(
    () =>
      b.engine.edit(b.id, (doc) =>
        doc
          .getMap("nodes")
          .get(id)
          .get("texts")
          .set("text", new Y.Text("stale")),
      ),
    /immutable/,
  );
  const rogue = new Y.Map();
  assert.throws(
    () => b.engine.edit(b.id, (doc) => doc.getMap("nodes").set(id, rogue)),
    /replaced/,
  );
  assert.deepEqual(logical(b), prior);
});

test("equivocating signed writer history is quarantined deterministically, including already applied branches", async (t) => {
  const [a, b, c] = await replicas(t),
    entry = b.engine.get(b.id),
    session = randomUUID(),
    doc = createDocument();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));
  doc.clientID = clientId(b.engine.identity.publicKey, session);
  const before = base64(Y.encodeStateVector(doc));
  let data;
  doc.on("update", (bytes) => {
    data = base64(bytes);
  });
  textBinding(doc, logical(b).nodes[0].id).insert(0, "fork");
  const payload = {
    v: 1,
    kind: "update",
    docId: entry.docId,
    session,
    sequence: 1,
    writerSequence: 1,
    writerPrevious: null,
    grant: entry.members.members.get(b.engine.identity.publicKey).id,
    parents: [...entry.heads],
    before,
    data,
  };
  const first = signed(b.engine.identity, payload),
    second = signed(b.engine.identity, { ...payload, sequence: 2 });
  a.engine.ingest(a.id, [first]);
  c.engine.ingest(c.id, [second]);
  a.engine.ingest(a.id, [second]);
  c.engine.ingest(c.id, [first]);
  assert.deepEqual(logical(a), logical(c));
  assert.deepEqual(logical(a), logical(b));
  assert.equal(a.engine.status(a.id).quarantined, 2);
  assert.equal(
    a.service.store.db
      .prepare("SELECT count(*) AS n FROM collab_recovery")
      .get().n,
    1,
  );
  doc.destroy();
});

test("transaction rollback emits no acknowledged update and restart replays only committed state", async (t) => {
  const [a] = await replicas(t, 1),
    prior = logical(a),
    records = a.engine.records(a.engine.get(a.id).docId).length;
  let emitted = 0;
  a.engine.on("changed", () => emitted++);
  assert.throws(
    () =>
      a.service.store.transaction(() => {
        change(a, (board) => {
          board.nodes[0].data.text = "Not committed";
        });
        throw Error("synthetic crash");
      }),
    /synthetic crash/,
  );
  assert.deepEqual(logical(a), prior);
  assert.equal(emitted, 0);
  assert.equal(a.engine.records(a.engine.get(a.id).docId).length, records);
  a.engine.close();
  a.engine = new CollaborationEngine(a.service.store, {
    identity: a.engine.identity,
  });
  assert.deepEqual(logical(a), prior);
});

test("many delayed generations converge under randomized duplicated message order and retain original layering order", async (t) => {
  const peers = await replicas(t, 4),
    original = logical(peers[0]).nodes[0].id;
  for (let round = 0; round < 8; round++) {
    for (const peer of peers)
      change(
        peer,
        (board) => {
          board.nodes.push(
            node("generation " + round, round * 400, round * 300),
          );
          board.nodes.find((n) => n.id === original).data.text += ".";
        },
        "batch" + round,
      );
    sync(peers[round % 4], peers[(round + 1) % 4], true);
  }
  const all = [
    ...new Map(
      peers
        .flatMap((p) => p.engine.records(p.engine.get(p.id).docId))
        .map((r) => [r.id, r]),
    ).values(),
  ];
  let seed = 73;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };
  for (const peer of peers) {
    const shuffled = [...all, ...all]
      .map((r) => [rand(), r])
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1]);
    for (const record of shuffled) peer.engine.ingest(peer.id, [record]);
  }
  for (const peer of peers) {
    assert.deepEqual(logical(peer), logical(peers[0]));
    assert.equal(logical(peer).nodes.length, 33);
    assert.equal(logical(peer).nodes[0].id, original);
    assert.equal(logical(peer).nodes[0].data.text.length, 34);
  }
});

test("a malformed child delivered early cannot poison later legitimate parent synchronization", async (t) => {
  const [a, b, c] = await replicas(t),
    id = logical(a).nodes[0].id;
  change(a, (board) => {
    board.nodes[0].data.text = "Legitimate delayed edit";
  });
  sync(a, b);
  const entry = b.engine.get(b.id),
    session = randomUUID(),
    doc = createDocument();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(entry.doc));
  doc.clientID = clientId(b.engine.identity.publicKey, session);
  const before = base64(Y.encodeStateVector(doc));
  let data;
  doc.on("update", (bytes) => {
    data = base64(bytes);
  });
  doc.getMap("nodes").delete(id);
  const bad = signed(b.engine.identity, {
    v: 1,
    kind: "update",
    docId: entry.docId,
    session,
    sequence: 1,
    writerSequence: 1,
    writerPrevious: null,
    grant: entry.members.members.get(b.engine.identity.publicKey).id,
    parents: [...entry.heads],
    before,
    data,
  });
  c.engine.ingest(c.id, [bad]);
  assert.equal(c.engine.status(c.id).quarantined, 1);
  sync(a, c);
  assert.equal(logical(c).nodes[0].data.text, "Legitimate delayed edit");
  assert.equal(c.engine.status(c.id).quarantined, 1);
  doc.destroy();
});

test("offline regions move with their whole new cluster; containment in an existing region is left for review", async (t) => {
  const [a, b] = await replicas(t, 2);
  for (const [peer, label] of [
    [a, "A"],
    [b, "B"],
  ])
    change(
      peer,
      (board) => {
        const region = node(label + " region", 500, 500);
        region.data.kind = "region";
        region.style = { width: 700, height: 500 };
        const inside = node(label + " inside", 560, 560);
        board.nodes.push(region, inside);
      },
      "new-regions",
    );
  sync(a, b);
  sync(b, a);
  const layout = mergedLayout(a.engine.get(a.id).doc, logical(a).nodes);
  assert.equal(layout.offsets.size, 2);
  assert.equal(layout.warnings.length, 0);
  for (const label of ["A", "B"]) {
    const region = layout.nodes.find((n) => n.data.text === label + " region"),
      inside = layout.nodes.find((n) => n.data.text === label + " inside");
    assert.equal(inside.position.x - region.position.x, 60);
    assert.equal(inside.position.y - region.position.y, 60);
  }
  const [c, d] = await replicas(t, 2);
  change(
    c,
    (board) => {
      const region = node("Known region", 500, 500);
      region.data.kind = "region";
      region.style = { width: 700, height: 500 };
      board.nodes.push(region);
    },
    "known-region",
  );
  sync(c, d);
  change(
    c,
    (board) => board.nodes.push(node("C intentional containment", 560, 560)),
    "C-new",
  );
  change(
    d,
    (board) => board.nodes.push(node("D intentional containment", 560, 560)),
    "D-new",
  );
  sync(c, d);
  sync(d, c);
  const protectedLayout = mergedLayout(
    c.engine.get(c.id).doc,
    logical(c).nodes,
  );
  assert.equal(protectedLayout.offsets.size, 0);
  assert.ok(protectedLayout.warnings.length > 0);
  assert.deepEqual(protectedLayout.nodes, logical(c).nodes);
});

test("concurrent title replacements converge while the full merged text stays in the journal", async (t) => {
  const [a, b] = await replicas(t, 2);
  const rename = (peer, name) =>
    peer.engine.edit(peer.id, (doc) => editText(doc.getText("title"), name));
  rename(a, "X".repeat(195));
  rename(b, "Y".repeat(193));
  sync(a, b);
  sync(b, a);
  const title = a.service.store.get(a.id).title;
  assert.equal(title.length, 200);
  assert.equal(b.service.store.get(b.id).title, title);
  for (const replica of [a, b]) {
    const entry = replica.engine.get(replica.id);
    assert.equal(entry.doc.getText("title").length, 388);
    replica.engine.documents.delete(replica.id);
    entry.doc.destroy();
    assert.equal(boardValue(replica.engine.get(replica.id).doc).title, title);
  }
});

test("joining with long membership history is atomic and retry uses the same board", async (t) => {
  const [a, b] = await replicas(t, 2);
  const entry = a.engine.get(a.id),
    author = a.engine.identity;
  const history = Array.from({ length: 129 }, () =>
    signed(author, {
      v: 1,
      kind: "grant",
      docId: entry.docId,
      parent: entry.genesis.id,
      subject: b.engine.identity.publicKey,
      name: b.engine.identity.name,
      nonce: randomUUID(),
    }),
  );
  const store = b.service.store;
  b.engine.get(b.id).doc.destroy();
  b.engine.documents.delete(b.id);
  store.remove(b.id);
  assert.throws(
    () =>
      store.transaction(() => {
        b.engine.accept(entry.genesis, history, author.publicKey);
        throw new Error("join write interrupted");
      }),
    /interrupted/,
  );
  assert.deepEqual(store.list(), []);
  assert.equal(b.engine.documents.size, 0);
  b.id = b.engine.accept(entry.genesis, history, author.publicKey);
  assert.equal(b.engine.accept(entry.genesis, history, author.publicKey), b.id);
  assert.equal(b.engine.records(entry.docId).length, 129);
  assert.equal(store.list().length, 1);
});

test("membership proof commits valid invitations only for a verified member", async (t) => {
  const [a, b] = await replicas(t, 2);
  const entry = b.engine.get(b.id);
  const newMember = newIdentity("New collaborator");
  const invitation = a.engine.grant(a.id, newMember.publicKey, newMember.name);
  const before = b.engine.records(entry.docId);
  assert.equal(
    b.engine.authenticateMembership(
      entry,
      [invitation],
      newIdentity().publicKey,
    ),
    false,
  );
  assert.deepEqual(b.engine.records(entry.docId), before);
  assert.equal(
    b.engine.authenticateMembership(entry, [invitation], newMember.publicKey),
    true,
  );
  assert.ok(entry.members.members.has(newMember.publicKey));
  assert.ok(
    b.engine.records(entry.docId).some((record) => record.id === invitation.id),
  );
});
