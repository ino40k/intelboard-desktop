import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  signed,
  authentic,
  hash,
  newIdentity,
  randomUUID,
  publicId,
  validPublicKey,
} from "./identity.js";
import {
  membership,
  membershipRecords,
  eligibleUpdates,
  dependencyOrder,
  validName,
} from "./membership.js";
import {
  Y,
  createDocument,
  boardValue,
  validateDocument,
  patchBoard,
  base64,
  unbase64,
  recoveryItems,
} from "../../shared/collaboration/document.js";
import { mergedLayout } from "../../shared/collaboration/layout.js";
import { collaborationId } from "../../shared/collaboration/ids.js";

const MAX_PENDING_MEMBERSHIP = 512;
const CHECKPOINT_VERSION = 1;
const MAX_CHECKPOINT_PROOF_BYTES = 16 * 1024 * 1024;
function journalHash(records) {
  const digest = createHash("sha256");
  for (const record of records)
    digest.update(JSON.stringify(record)).update("\n");
  return digest.digest("hex");
}
function checkRecord(record, entry) {
  const p = record?.payload;
  if (
    !p ||
    p.docId !== entry.docId ||
    !["update", "grant", "policy"].includes(p.kind) ||
    !authentic(record)
  )
    throw new Error("Invalid signed synchronization record");
  if (p.kind === "policy" && p.author !== entry.genesis.payload.author)
    throw new Error("Only the owner may sign membership removals");
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const updatePayload = z
  .object({
    v: z.literal(1),
    kind: z.literal("update"),
    docId: z.string().uuid(),
    author: z.string().max(100),
    session: z.string().uuid(),
    sequence: z.number().int().positive().safe(),
    writerSequence: z.number().int().positive().safe(),
    writerPrevious: digest.nullable(),
    grant: digest,
    parents: z.array(digest).max(256),
    before: z.string().max(128000),
    data: z.string().max(2800000),
  })
  .strict();
export const clientId = (publicKey, session) =>
  Number.parseInt(hash(publicKey + ":" + session).slice(0, 13), 16);
function decoded(record) {
  const payload = updatePayload.parse(record.payload);
  if (
    new Set(payload.parents).size !== payload.parents.length ||
    payload.parents.includes(record.id)
  )
    throw new Error("Invalid causal parents");
  const bytes = unbase64(payload.data);
  const update = Y.decodeUpdate(bytes);
  const client = clientId(payload.author, payload.session);
  if (update.structs.some((s) => s.id.client !== client))
    throw new Error(
      "An update attempted to impersonate another editing session",
    );
  return {
    payload,
    bytes,
    update,
    client,
    before: Y.decodeStateVector(unbase64(payload.before, 96000)),
  };
}
function vectorAfter(record, info, vectors, records) {
  const known = new Map();
  for (const parent of record.payload.parents) {
    const vector = vectors.get(parent);
    if (!vector) throw new Error("Missing causal parent");
    for (const [client, clock] of vector)
      known.set(client, Math.max(known.get(client) || 0, clock));
  }
  for (const [client, clock] of info.before)
    if (
      !Number.isSafeInteger(clock) ||
      clock < 0 ||
      clock > (known.get(client) || 0)
    )
      throw new Error("Update claims unobserved document history");
  const p = info.payload,
    previous = p.writerPrevious && records.get(p.writerPrevious);
  if (
    p.writerSequence === 1
      ? p.writerPrevious !== null || (info.before.get(info.client) || 0) !== 0
      : !previous ||
        !p.parents.includes(previous.id) ||
        previous.payload.author !== p.author ||
        previous.payload.session !== p.session ||
        previous.payload.writerSequence + 1 !== p.writerSequence ||
        (info.before.get(info.client) || 0) !==
          (vectors.get(previous.id)?.get(info.client) || 0)
  )
    throw new Error("Invalid signed editing-session chain");
  let end = info.before.get(info.client) || 0;
  for (const struct of info.update.structs) {
    if (
      struct.id.clock !== end ||
      !Number.isSafeInteger(struct.length) ||
      struct.length < 1
    )
      throw new Error("Invalid editing-session clock");
    end += struct.length;
  }
  for (const [client, items] of info.update.ds.clients)
    for (const item of items) {
      const observed =
        client === info.client ? end : info.before.get(client) || 0;
      if (
        !Number.isSafeInteger(item.clock + item.len) ||
        item.clock < 0 ||
        item.len < 1 ||
        item.clock + item.len > observed
      )
        throw new Error("Deletion refers to unobserved future edits");
    }
  known.set(info.client, Math.max(known.get(info.client) || 0, end));
  return known;
}
function copyDoc(doc) {
  const result = createDocument();
  Y.applyUpdate(result, Y.encodeStateAsUpdate(doc));
  return result;
}
// The application uses permanent entities with soft deletion. Replacing a root
// or a text container would bypass character merging and destroy recovery data.
function applyChecked(doc, info, genesis) {
  const failures = [],
    roots = ["nodes", "edges"];
  const observers = roots.map((root) => {
    const map = doc.getMap(root),
      listener = (events) => {
        for (const event of events) {
          if (event.path.length === 0)
            for (const [id, change] of event.changes.keys) {
              if (change.action !== "add") {
                failures.push(
                  "Shared entities cannot be replaced or physically deleted",
                );
                continue;
              }
              const birth = map.get(id)?.get("birth"),
                p = info.payload;
              const protectedIds = genesis.payload[root] || [];
              if (
                !birth ||
                birth.actor !== publicId(p.author) ||
                birth.session !== p.session ||
                (birth.initial
                  ? p.author !== genesis.payload.author ||
                    p.session !== genesis.payload.seedSession ||
                    !protectedIds.includes(id)
                  : !z.string().uuid().safeParse(birth.nonce).success ||
                    collaborationId(birth.actor, birth.nonce, p.session) !== id)
              )
                failures.push("Invalid shared entity provenance");
            }
          if (event.path.length === 1)
            for (const [key, change] of event.changes.keys)
              if (
                ["birth", "props", "data", "texts", "label"].includes(key) &&
                change.action !== "add"
              )
                failures.push("Shared entity containers are immutable");
          if (
            root === "nodes" &&
            event.path.length === 2 &&
            event.path[1] === "texts"
          )
            for (const change of event.changes.keys.values())
              if (change.action !== "add")
                failures.push("Collaborative text containers are immutable");
        }
      };
    map.observeDeep(listener);
    return () => map.unobserveDeep(listener);
  });
  try {
    Y.applyUpdate(doc, info.bytes);
  } finally {
    for (const off of observers) off();
  }
  if (failures.length) throw new Error(failures[0]);
  if (doc.store.pendingStructs || doc.store.pendingDs)
    throw new Error("Update references unobserved collaborative content");
}
function hasEquivocation(records) {
  const writers = new Map();
  for (const r of records)
    if (r.payload.kind === "update") {
      const key =
        r.payload.author +
        ":" +
        r.payload.session +
        ":" +
        r.payload.writerSequence;
      if (writers.has(key) && writers.get(key) !== r.id) return true;
      writers.set(key, r.id);
    }
  return false;
}

export class CollaborationEngine extends EventEmitter {
  constructor(store, options = {}) {
    super();
    this.store = store;
    this.documents = new Map();
    const saved = store.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("collaboration.identity");
    this.identity =
      options.identity || (saved ? JSON.parse(saved.value) : newIdentity());
    if (!saved && !options.identity)
      store.db
        .prepare("INSERT INTO settings VALUES(?,?)")
        .run("collaboration.identity", JSON.stringify(this.identity));
  }
  sharedBoards() {
    return this.store.db
      .prepare("SELECT board_id,doc_id FROM collab_boards")
      .all();
  }
  records(docId) {
    return this.store.db
      .prepare(
        "SELECT envelope FROM collab_records WHERE doc_id=? ORDER BY rowid",
      )
      .all(docId)
      .map((r) => JSON.parse(r.envelope));
  }
  get(boardId) {
    if (this.documents.has(boardId)) return this.documents.get(boardId);
    const row = this.store.db
      .prepare("SELECT * FROM collab_boards WHERE board_id=?")
      .get(boardId);
    if (!row) return null;
    const entry = {
      boardId,
      docId: row.doc_id,
      genesis: JSON.parse(row.genesis),
      sequence: row.sequence,
      session: randomUUID(),
    };
    const records = this.records(entry.docId);
    const checkpoint = this.readCheckpoint(entry, records, row.state);
    const rebuilt = this.rebuild(entry, records, false, checkpoint);
    Object.assign(entry, rebuilt);
    this.documents.set(boardId, entry);
    return entry;
  }
  readCheckpoint(entry, records, state) {
    const row = this.store.db
      .prepare("SELECT proof FROM collab_checkpoints WHERE doc_id=?")
      .get(entry.docId);
    if (!row || row.proof.length > MAX_CHECKPOINT_PROOF_BYTES) return null;
    try {
      const proof = JSON.parse(row.proof),
        p = proof.payload;
      if (
        p.kind !== "checkpoint" ||
        p.v !== CHECKPOINT_VERSION ||
        p.author !== this.identity.publicKey ||
        p.genesis !== entry.genesis.id ||
        !Number.isSafeInteger(p.count) ||
        p.count < 0 ||
        p.count > records.length ||
        !authentic(proof) ||
        p.state !== hash(Buffer.from(state)) ||
        p.journal !== journalHash(records.slice(0, p.count))
      )
        return null;
      return {
        count: p.count,
        vectors: new Map(
          p.vectors.map(([id, vector]) => [id, new Map(vector)]),
        ),
        state,
      };
    } catch {
      return null;
    }
  }
  writeCheckpoint(entry, state) {
    // Checkpoints only cover completely resolved histories. The signed proof
    // binds both the snapshot and every journal envelope it replaces in replay.
    if (entry.eligibility.quarantined.length) return false;
    const proof = JSON.stringify(
      signed(this.identity, {
        kind: "checkpoint",
        v: CHECKPOINT_VERSION,
        genesis: entry.genesis.id,
        count: entry.records.length,
        state: hash(Buffer.from(state)),
        journal: journalHash(entry.records),
        vectors: [...entry.vectors].map(([id, vector]) => [id, [...vector]]),
      }),
    );
    if (proof.length > MAX_CHECKPOINT_PROOF_BYTES) return false;
    this.store.db
      .prepare(
        "INSERT INTO collab_checkpoints VALUES(?,?) ON CONFLICT(doc_id) DO UPDATE SET proof=excluded.proof",
      )
      .run(entry.docId, proof);
    return true;
  }
  rebuild(entry, records, strict = false, checkpoint = null) {
    const tail = checkpoint ? records.slice(checkpoint.count) : records;
    for (const record of tail) checkRecord(record, entry);
    const members = membership(entry.genesis, records);
    const updates = records.filter((r) => r.payload.kind === "update");
    const eligibility = eligibleUpdates(members, updates);
    let doc = createDocument();
    const vectors = checkpoint?.vectors || new Map(),
      accepted = new Map();
    if (checkpoint) {
      if ([...vectors.keys()].some((id) => !eligibility.allowed.has(id))) {
        doc.destroy();
        return this.rebuild(entry, records);
      }
      try {
        Y.applyUpdate(doc, checkpoint.state);
        for (const id of vectors.keys())
          accepted.set(id, eligibility.allowed.get(id));
      } catch {
        doc.destroy();
        return this.rebuild(entry, records);
      }
    }
    for (const record of eligibility.allowed.values()) {
      if (accepted.has(record.id)) continue;
      if (record.payload.parents.some((id) => !accepted.has(id))) continue;
      try {
        const info = decoded(record),
          vector = vectorAfter(record, info, vectors, eligibility.allowed);
        applyChecked(doc, info, entry.genesis);
        if (strict) validateDocument(doc);
        vectors.set(record.id, vector);
        accepted.set(record.id, record);
      } catch (error) {
        doc.destroy();
        if (checkpoint) return this.rebuild(entry, records);
        if (!strict) return this.rebuild(entry, records, true);
        doc = createDocument();
        for (const prior of accepted.values())
          Y.applyUpdate(doc, unbase64(prior.payload.data));
      }
    }
    let value;
    try {
      value = validateDocument(doc);
    } catch (error) {
      doc.destroy();
      if (checkpoint) return this.rebuild(entry, records);
      if (!strict) return this.rebuild(entry, records, true);
      throw error;
    }
    eligibility.quarantined.push(
      ...[...eligibility.allowed.values()].filter((r) => !accepted.has(r.id)),
    );
    eligibility.allowed = accepted;
    const heads = new Set(eligibility.allowed.keys());
    for (const record of eligibility.allowed.values())
      for (const parent of record.payload.parents) heads.delete(parent);
    return {
      doc,
      value,
      records,
      members,
      eligibility,
      vectors,
      heads,
      inventoryEpoch: randomUUID(),
      replayRequired: strict,
    };
  }
  share(boardId, initialBoard = this.store.get(boardId)) {
    if (this.get(boardId)) return this.open(boardId);
    if (!initialBoard) throw new Error("Board not found");
    const docId = randomUUID();
    const session = randomUUID();
    const genesis = signed(this.identity, {
      v: 1,
      kind: "genesis",
      docId,
      name: this.identity.name,
      seedSession: session,
      nodes: initialBoard.nodes.map((n) => n.id),
      edges: initialBoard.edges.map((e) => e.id),
    });
    const entry = {
      boardId,
      docId,
      genesis,
      session,
      sequence: 0,
      doc: createDocument(),
      records: [],
      heads: new Set(),
      vectors: new Map(),
    };
    entry.doc.clientID = clientId(this.identity.publicKey, entry.session);
    entry.members = membership(genesis, []);
    const pending = [];
    const seed = (before, after) => {
      const vector = base64(Y.encodeStateVector(entry.doc));
      let bytes;
      const listener = (update) => {
        bytes = update;
      };
      entry.doc.on("update", listener);
      try {
        patchBoard(entry.doc, before, after, {
          actor: this.identity.id,
          session,
          order: pending.length,
          batch: "original",
          initial: true,
        });
      } finally {
        entry.doc.off("update", listener);
      }
      if (bytes) {
        const record = signed(this.identity, {
          v: 1,
          kind: "update",
          docId,
          session: entry.session,
          sequence: ++entry.sequence,
          writerSequence: entry.sequence,
          writerPrevious: pending.at(-1)?.id || null,
          grant: genesis.id,
          parents: pending.length ? [pending.at(-1).id] : [],
          before: vector,
          data: base64(bytes),
        });
        pending.push(record);
      }
    };
    const empty = { title: initialBoard.title, nodes: [], edges: [] };
    seed({ ...empty, title: "" }, empty);
    for (const node of initialBoard.nodes)
      seed(empty, { ...empty, nodes: [node] });
    for (const edge of initialBoard.edges)
      seed(empty, { ...empty, edges: [edge] });
    const rebuilt = this.rebuild(entry, pending);
    Object.assign(entry, rebuilt);
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "INSERT INTO collab_boards(board_id,doc_id,genesis,state,sequence) VALUES(?,?,?,?,?)",
        )
        .run(
          boardId,
          docId,
          JSON.stringify(genesis),
          Y.encodeStateAsUpdate(entry.doc),
          entry.sequence,
        );
      for (const record of pending) this.insert(entry, record, "accepted");
      this.project(entry, true);
    });
    this.documents.set(boardId, entry);
    this.store.afterRollback(() => {
      this.documents.delete(boardId);
      entry.doc.destroy();
    });
    this.store.afterCommit(() =>
      this.emit("changed", { type: "shared", boardId }),
    );
    return this.open(boardId);
  }
  insert(entry, record, status) {
    this.store.db
      .prepare("INSERT OR IGNORE INTO collab_records VALUES(?,?,?,?,?,?)")
      .run(
        entry.docId,
        record.id,
        record.payload.kind,
        record.payload.author,
        JSON.stringify(record),
        status,
      );
  }
  project(entry, checkpoint = false) {
    const board = {
      ...entry.value,
      viewport: JSON.parse(
        this.store.db
          .prepare("SELECT viewport FROM boards WHERE id=?")
          .get(entry.boardId).viewport,
      ),
    };
    board.nodes = mergedLayout(entry.doc, board.nodes).nodes;
    const state =
      !entry.eligibility.quarantined.length &&
      (checkpoint || entry.records.length % 64 === 0)
        ? Y.encodeStateAsUpdate(entry.doc)
        : null;
    this.store.projectShared(
      entry.boardId,
      board,
      state && this.writeCheckpoint(entry, state) ? state : null,
    );
  }
  open(boardId) {
    const entry = this.get(boardId);
    if (!entry) return null;
    const session = randomUUID();
    return {
      documentId: entry.docId,
      data: base64(Y.encodeStateAsUpdate(entry.doc)),
      session,
      client: clientId(this.identity.publicKey, session),
      actor: this.identity.id,
      status: this.status(boardId),
    };
  }
  status(boardId, details = true) {
    const e = this.get(boardId);
    if (!e) return null;
    return {
      boardId,
      documentId: e.docId,
      owner: e.members.owner === this.identity.publicKey,
      active: e.members.members.has(this.identity.publicKey),
      initialComplete: this.initialComplete(e),
      policy: e.members.policy.id,
      members: [...e.members.members.values()].map((m) => ({
        ...m,
        identity: publicId(m.publicKey),
      })),
      quarantined: e.eligibility?.quarantined.length || 0,
      pending: [...e.heads],
      ...(details
        ? {
            recovery: recoveryItems(e.doc),
            layout: mergedLayout(e.doc, boardValue(e.doc).nodes).warnings,
          }
        : {}),
    };
  }
  initialComplete(entry) {
    const end =
      entry.genesis.payload.nodes.length +
      entry.genesis.payload.edges.length +
      1;
    return [...entry.eligibility.allowed.values()].some(
      (r) =>
        r.payload.author === entry.genesis.payload.author &&
        r.payload.session === entry.genesis.payload.seedSession &&
        r.payload.writerSequence >= end,
    );
  }
  authenticateMembership(entry, incoming, author, source) {
    // Evaluate only the proposed proof and trusted history. Pending records
    // cannot help a peer authorize itself and a failed proof has no writes.
    const combined = new Map(
      membershipRecords(entry.members).map((record) => [record.id, record]),
    );
    for (const record of incoming) {
      checkRecord(record, entry);
      combined.set(record.id, record);
    }
    const candidate = membership(entry.genesis, [...combined.values()]);
    if (!candidate.members.has(author)) return false;
    const admitted = new Set(
      membershipRecords(candidate).map((record) => record.id),
    );
    this.ingestRecords(
      entry,
      incoming.filter((record) => admitted.has(record.id)),
      source,
      {
        stageMembership: false,
      },
    );
    return true;
  }

  ingest(boardId, incoming, source = null) {
    const entry = this.get(boardId);
    if (!entry) throw new Error("Shared board not found");
    if (!Array.isArray(incoming) || incoming.length > 128)
      throw new Error("Too many synchronization records");
    return this.ingestRecords(entry, incoming, source);
  }

  ingestRecords(
    entry,
    incoming,
    source,
    { stageMembership = true, requireAccepted = false } = {},
  ) {
    const { boardId } = entry;
    const byId = new Map(entry.records.map((r) => [r.id, r]));
    const added = [];
    const candidates = new Map(stageMembership ? entry.pendingMembership : []);
    let hasMembership = false;
    const add = (record) => {
      if (byId.has(record.id)) return;
      byId.set(record.id, record);
      added.push(record);
    };
    for (const record of incoming) {
      checkRecord(record, entry);
      const limit = { update: 4 * 1024 * 1024, policy: 65536, grant: 2048 }[
        record.payload.kind
      ];
      if (JSON.stringify(record).length > limit) {
        const error = new Error(
          "Synchronization record exceeds its size limit",
        );
        if (requireAccepted) error.code = "COLLAB_EDIT_REJECTED";
        throw error;
      }
      if (byId.has(record.id)) continue;
      if (record.payload.kind === "update") {
        try {
          decoded(record);
        } catch (error) {
          if (requireAccepted) error.code = "COLLAB_EDIT_REJECTED";
          throw error;
        }
        add(record);
      } else {
        candidates.set(record.id, record);
        hasMembership = true;
      }
    }
    let pendingMembership;
    if (hasMembership) {
      const members = membership(entry.genesis, [
        ...membershipRecords(entry.members),
        ...candidates.values(),
      ]);
      for (const record of membershipRecords(members)) {
        add(record);
        candidates.delete(record.id);
      }
      if (stageMembership)
        // Retain a small volatile buffer for proofs received before their parents.
        pendingMembership = new Map(
          [...candidates].slice(-MAX_PENDING_MEMBERSHIP),
        );
    }
    if (!added.length) {
      if (pendingMembership) entry.pendingMembership = pendingMembership;
      return { accepted: [], pending: entry.eligibility.quarantined.length };
    }
    let rebuilt;
    const ids = new Set(added.map((r) => r.id));
    const unblocks = entry.eligibility.quarantined.some((r) =>
      r.payload.parents?.some((id) => ids.has(id)),
    );
    if (
      !unblocks &&
      !entry.replayRequired &&
      !hasEquivocation(byId.values()) &&
      added.every(
        (r) =>
          r.payload.kind === "update" &&
          entry.members.members.has(r.payload.author) &&
          ((r.payload.author === entry.members.owner &&
            r.payload.grant === entry.genesis.id) ||
            entry.members.grants.get(r.payload.grant)?.payload.subject ===
              r.payload.author),
      )
    ) {
      const allowed = new Map(entry.eligibility.allowed),
        vectors = new Map(entry.vectors),
        heads = new Set(entry.heads),
        doc = entry.doc;
      // Apply tentatively, with no renderer/network observers. On failure the
      // committed journal rebuilds the document before any caller regains control.
      const restore = () => {
        doc.destroy();
        entry.doc = this.rebuild(entry, entry.records).doc;
      };
      const ordered = dependencyOrder(added, allowed);
      try {
        for (const record of ordered) {
          const info = decoded(record);
          vectors.set(record.id, vectorAfter(record, info, vectors, byId));
          applyChecked(doc, info, entry.genesis);
          allowed.set(record.id, record);
          heads.add(record.id);
          for (const id of record.payload.parents) heads.delete(id);
        }
      } catch (error) {
        restore();
        if (requireAccepted) error.code = "COLLAB_EDIT_REJECTED";
        throw error;
      }
      if (ordered.length === added.length) {
        try {
          const value = validateDocument(doc);
          rebuilt = {
            doc,
            value,
            members: entry.members,
            records: [...entry.records, ...added],
            eligibility: { ...entry.eligibility, allowed },
            vectors,
            heads,
            inventoryEpoch: entry.inventoryEpoch,
            replayRequired: false,
          };
        } catch (error) {
          restore();
          if (requireAccepted) {
            error.code = "COLLAB_EDIT_REJECTED";
            throw error;
          }
          // Valid branches can collectively exceed a structural limit. Replay
          // both histories in the same causal order before deciding eligibility.
        }
      } else restore();
    }
    if (!rebuilt) {
      try {
        rebuilt = this.rebuild(entry, [...byId.values()]);
      } catch (error) {
        if (requireAccepted) error.code = "COLLAB_EDIT_REJECTED";
        throw error;
      }
    }
    if (
      requireAccepted &&
      added.some((record) => !rebuilt.eligibility.allowed.has(record.id))
    ) {
      if (rebuilt.doc !== entry.doc) rebuilt.doc.destroy();
      throw Object.assign(
        new Error("This edit could not be reconciled with the current board."),
        {
          code: "COLLAB_EDIT_REJECTED",
        },
      );
    }
    const previousAllowed = new Set(entry.eligibility.allowed.keys());
    const removed = [...previousAllowed].some(
      (id) => !rebuilt.eligibility.allowed.has(id),
    );
    const priorDoc = entry.doc;
    try {
      this.store.transaction(() => {
        if (removed) {
          const prior = this.store.get(boardId);
          this.store.db
            .prepare("INSERT INTO collab_recovery VALUES(?,?,?,?,?)")
            .run(
              randomUUID(),
              entry.docId,
              Date.now(),
              rebuilt.members.policy.id !== entry.members.policy.id
                ? "Membership change quarantined an unacknowledged fork"
                : "Journal reconciliation quarantined an edit",
              JSON.stringify(prior),
            );
          this.store.db
            .prepare("DELETE FROM collab_recovery WHERE doc_id=? AND created<?")
            .run(entry.docId, Date.now() - 30 * 86400000);
        }
        for (const record of added)
          this.insert(
            entry,
            record,
            rebuilt.eligibility.allowed.has(record.id) ||
              record.payload.kind !== "update"
              ? "accepted"
              : "pending",
          );
        for (const record of rebuilt.records)
          if (
            record.payload.kind === "update" &&
            !ids.has(record.id) &&
            previousAllowed.has(record.id) !==
              rebuilt.eligibility.allowed.has(record.id)
          )
            this.store.db
              .prepare(
                "UPDATE collab_records SET status=? WHERE doc_id=? AND id=?",
              )
              .run(
                rebuilt.eligibility.allowed.has(record.id)
                  ? "accepted"
                  : "quarantined",
                entry.docId,
                record.id,
              );
        this.project({ ...entry, ...rebuilt });
      });
    } catch (error) {
      if (rebuilt.doc === entry.doc) {
        entry.doc.destroy();
        entry.doc = this.rebuild(entry, entry.records).doc;
      } else rebuilt.doc.destroy();
      throw error;
    }
    this.store.afterCommit(() => {
      if (entry.doc !== rebuilt.doc) entry.doc.destroy();
      Object.assign(entry, rebuilt);
      if (pendingMembership) entry.pendingMembership = pendingMembership;
      this.emit("changed", {
        type: removed ? "reset" : "update",
        boardId,
        source,
        records: added,
        applied: [...entry.eligibility.allowed.values()].filter(
          (r) => !previousAllowed.has(r.id),
        ),
        data: removed ? base64(Y.encodeStateAsUpdate(entry.doc)) : null,
      });
    });
    this.store.afterRollback(() => {
      if (rebuilt.doc === priorDoc) {
        rebuilt.doc.destroy();
        entry.doc = this.rebuild(entry, entry.records).doc;
      } else rebuilt.doc.destroy();
    });
    return {
      accepted: added
        .filter((r) => rebuilt.eligibility.allowed.has(r.id))
        .map((r) => r.id),
      pending: rebuilt.eligibility.quarantined.length,
    };
  }
  local(boardId, message) {
    const entry = this.get(boardId);
    if (!entry?.members.members.has(this.identity.publicKey))
      throw new Error(
        "You no longer have permission to edit this shared board. Your local copy is retained.",
      );
    const duplicate = entry.records.find(
      (r) =>
        r.payload.kind === "update" &&
        r.payload.author === this.identity.publicKey &&
        r.payload.session === message.session &&
        r.payload.data === message.data,
    );
    if (duplicate) {
      if (entry.eligibility.allowed.has(duplicate.id))
        return { id: duplicate.id };
      throw Object.assign(
        new Error("This edit is quarantined in the journal."),
        {
          code: "COLLAB_EDIT_REJECTED",
        },
      );
    }
    const sequence =
      Math.max(
        entry.sequence,
        ...entry.records
          .filter(
            (r) =>
              r.payload.author === this.identity.publicKey &&
              r.payload.kind === "update",
          )
          .map((r) => r.payload.sequence),
      ) + 1;
    const previous = entry.records
      .filter(
        (r) =>
          r.payload.kind === "update" &&
          r.payload.author === this.identity.publicKey &&
          r.payload.session === message.session,
      )
      .sort((a, b) => b.payload.writerSequence - a.payload.writerSequence)[0];
    const record = signed(this.identity, {
      v: 1,
      kind: "update",
      docId: entry.docId,
      session: message.session,
      sequence,
      writerSequence: (previous?.payload.writerSequence || 0) + 1,
      writerPrevious: previous?.id || null,
      grant: entry.members.members.get(this.identity.publicKey).id,
      parents: [
        ...new Set([...entry.heads, ...(previous ? [previous.id] : [])]),
      ].sort(),
      before: message.before,
      data: message.data,
    });
    this.ingestRecords(entry, [record], null, { requireAccepted: true });
    entry.sequence = sequence;
    this.store.db
      .prepare("UPDATE collab_boards SET sequence=? WHERE board_id=?")
      .run(sequence, boardId);
    return { id: record.id };
  }
  edit(boardId, modify) {
    const entry = this.get(boardId),
      doc = copyDoc(entry.doc);
    doc.clientID = clientId(this.identity.publicKey, entry.session);
    const before = base64(Y.encodeStateVector(doc));
    let bytes;
    doc.on("update", (update) => {
      bytes = update;
    });
    doc.transact(() => modify(doc));
    const result = bytes
      ? this.local(boardId, {
          session: entry.session,
          before,
          data: base64(bytes),
        })
      : null;
    doc.destroy();
    return result;
  }
  grant(boardId, subject, name) {
    const entry = this.get(boardId),
      member = entry?.members.members.get(this.identity.publicKey);
    if (
      !member ||
      !validName(name) ||
      !validPublicKey(subject) ||
      subject === entry.members.owner ||
      entry.members.revoked.has(publicId(subject))
    )
      throw new Error("Invalid collaborator invitation");
    const existing = entry.members.members.get(subject);
    if (existing) return entry.members.grants.get(existing.id);
    const record = signed(this.identity, {
      v: 1,
      kind: "grant",
      docId: entry.docId,
      subject,
      name,
      parent: member.id,
      nonce: randomUUID(),
    });
    this.ingest(boardId, [record]);
    return record;
  }
  accept(genesis, records, peer) {
    if (!Array.isArray(records) || records.length > 1000000)
      throw new Error("Invalid initial collaboration records");
    const docId = genesis?.payload?.docId;
    const existing = this.store.db
      .prepare("SELECT board_id FROM collab_boards WHERE doc_id=?")
      .get(docId ?? null);
    const current = existing ? this.get(existing.board_id) : null;
    if (current && current.genesis.id !== genesis.id)
      throw new Error("Board ownership proof differs");
    const entry = current || {
      docId,
      genesis,
      sequence: 0,
      session: randomUUID(),
    };
    const byId = new Map(
      (current?.records || []).map((record) => [record.id, record]),
    );
    for (let offset = 0; offset < records.length; offset += 128)
      for (const record of records.slice(offset, offset + 128)) {
        checkRecord(record, entry);
        byId.set(record.id, record);
      }
    const state = membership(entry.genesis, [...byId.values()]);
    if (
      !state.members.has(this.identity.publicKey) ||
      (peer && !state.members.has(peer))
    )
      throw new Error("This invitation did not grant you access");
    const admitted = new Set(
      membershipRecords(state).map((record) => record.id),
    );
    const verified = [...byId.values()].filter(
      (record) => record.payload.kind === "update" || admitted.has(record.id),
    );
    if (current) {
      this.ingestRecords(current, verified, null, { stageMembership: false });
      return current.boardId;
    }
    const rebuilt = this.rebuild(entry, verified);
    try {
      this.store.transaction(() => {
        entry.boardId = this.store.create("Joining shared board").id;
        Object.assign(entry, rebuilt);
        this.store.db
          .prepare(
            "INSERT INTO collab_boards(board_id,doc_id,genesis,state) VALUES(?,?,?,?)",
          )
          .run(
            entry.boardId,
            docId,
            JSON.stringify(genesis),
            Y.encodeStateAsUpdate(entry.doc),
          );
        for (const record of verified)
          this.insert(
            entry,
            record,
            record.payload.kind !== "update" ||
              rebuilt.eligibility.allowed.has(record.id)
              ? "accepted"
              : "pending",
          );
        this.project(entry, true);
      });
    } catch (error) {
      rebuilt.doc.destroy();
      throw error;
    }
    this.documents.set(entry.boardId, entry);
    this.store.afterRollback(() => {
      this.documents.delete(entry.boardId);
      entry.doc.destroy();
    });
    return entry.boardId;
  }
  revoke(boardId, identity) {
    const entry = this.get(boardId);
    if (entry.members.owner !== this.identity.publicKey)
      throw new Error("Only the board owner can remove collaborators");
    if (
      identity === this.identity.id ||
      ![...entry.members.members.keys()].some(
        (key) => publicId(key) === identity,
      )
    )
      throw new Error("Choose an existing collaborator other than the owner");
    const record = signed(this.identity, {
      v: 1,
      kind: "policy",
      docId: entry.docId,
      sequence: entry.members.policies.length,
      previous: entry.members.policy.id,
      revoked: [...entry.members.revoked, identity].sort(),
      grants: [...entry.members.grants.keys()].sort(),
      heads: [...entry.heads].sort(),
    });
    this.ingest(boardId, [record]);
    return record;
  }
  close() {
    for (const entry of this.documents.values()) entry.doc.destroy();
    this.documents.clear();
  }
}
