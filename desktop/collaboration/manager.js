import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  randomUUID,
  randomBytes,
  signed,
  authentic,
  publicId,
  hash,
} from "./identity.js";
import { validName } from "./membership.js";
import { CollaborationEngine } from "./engine.js";
import { CollaborationMedia, manifestSchema } from "./media.js";
import { TailcatTransport } from "./transport.js";
import {
  base64,
  unbase64,
  boardValue,
  recoveryItems,
  patchBoard,
} from "../../shared/collaboration/document.js";
import { mergedLayout } from "../../shared/collaboration/layout.js";
import { boardSchema } from "../../shared/schema.js";
import { RemoteUpdateGuard } from "./decode-guard.js";

const uuid = z.string().uuid();
const point = z.object({
  x: z.number().finite().min(-1e9).max(1e9),
  y: z.number().finite().min(-1e9).max(1e9),
});
const presenceSchema = z
  .object({
    cursor: point.nullable().optional(),
    selection: z.array(uuid).max(100).optional(),
    resize: uuid.nullable().optional(),
    previews: z
      .array(
        z.object({
          id: uuid,
          position: point.optional(),
          width: z.number().min(40).max(20000).optional(),
          height: z.number().min(30).max(20000).optional(),
        }),
      )
      .max(100)
      .optional(),
    editing: uuid.nullable().optional(),
  })
  .strict();
const color = (id) =>
  ["#edab55", "#6da9e8", "#87bd7b", "#d68dad", "#a69be8", "#58bcb7"][
    Number.parseInt(id.slice(0, 6), 16) % 6
  ];

export class CollaborationManager extends EventEmitter {
  constructor(service, dir, options = {}) {
    super();
    this.service = service;
    this.dir = dir;
    this.options = options;
    this.connections = new Map();
    this.pending = new Map();
    this.peers = new Map();
    this.transfers = new Map();
    this.errors = new Map();
    this.presences = new Map();
    this.dialing = new Set();
    this.closed = false;
    if (service.store.db.prepare("SELECT 1 FROM collab_boards LIMIT 1").get())
      this.ensure();
  }
  ensure() {
    if (this.engine) return;
    this.engine = new CollaborationEngine(this.service.store);
    this.media = new CollaborationMedia(this.service, this.dir);
    this.guard = new RemoteUpdateGuard();
    this.cleanup();
    for (const row of this.service.store.db
      .prepare("SELECT public_key,record FROM collab_profiles")
      .all())
      this.peers.set(row.public_key, JSON.parse(row.record));
    this.engine.on("changed", (event) => {
      const entry = this.engine.get(event.boardId);
      const data =
        event.type === "reset"
          ? { reset: event.data }
          : { updates: (event.applied || []).map((r) => r.payload.data) };
      this.emit("delta", { boardId: event.boardId, ...data });
      for (const context of this.connections.values())
        if (context.authenticated && context.boardId === event.boardId) {
          if (
            !entry.members.members.has(context.publicKey) ||
            !entry.members.members.has(this.engine.identity.publicKey)
          ) {
            context.authenticated = false;
            void this.sendRemoval(context, entry)
              .finally(() => {
                const timer = setTimeout(() => {
                  void this.transport?.disconnect(context.id);
                }, 500);
                timer.unref();
              })
              .catch(() => {});
            continue;
          }
          if (event.records?.length && context.id !== event.source)
            void this.send(context, {
              type: "changes",
              records: event.records,
            }).catch(() => {});
        }
      this.notify(event.boardId);
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 4000);
    this.timer.unref();
    if (this.options.transport !== false) this.startNetwork();
  }
  setting(key, value) {
    if (value !== undefined)
      this.service.store.db
        .prepare(
          "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
    const saved = this.service.store.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return saved ? JSON.parse(saved.value) : null;
  }
  startNetwork() {
    if (this.transport) return;
    this.transport =
      this.options.transport ||
      new TailcatTransport({
        ...this.options,
        getConfig: () => this.setting("collaboration.network") || {},
      });
    this.transport.on("identity", (event) => {
      if (!this.closed) this.setting("collaboration.network", event.config);
    });
    this.transport.on("ready", (event) => {
      if (this.closed) return;
      this.setting("collaboration.network", event.config);
      this.address = event.address;
      this.nodeKey = event.nodeKey;
      const sequence = (this.setting("collaboration.profileSequence") || 0) + 1;
      this.setting("collaboration.profileSequence", sequence);
      this.profile = signed(this.engine.identity, {
        v: 1,
        kind: "profile",
        sequence,
        name: this.engine.identity.name,
        address: this.address,
      });
      this.emit("ready");
      void this.tick().catch(() => {});
      this.notifyAll();
    });
    this.transport.on("unavailable", () => {
      this.address = null;
      this.connections.clear();
      this.presences.clear();
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(
          new Error("Peer networking stopped; changes remain saved locally."),
        );
      }
      this.pending.clear();
      this.notifyAll();
    });
    this.transport.on("connected", (event) =>
      this.connections.set(event.id, {
        ...event,
        authenticated: false,
        created: Date.now(),
        remoteKnown: new Set(),
        syncing: false,
      }),
    );
    this.transport.on("frame", (event) => {
      void this.frame(event).catch(() => {
        void this.transport.disconnect(event.id);
      });
    });
    this.transport.on("disconnected", (event) => {
      const context = this.connections.get(event.id);
      this.connections.delete(event.id);
      if (context?.boardId) {
        this.presences.get(context.boardId)?.delete(context.publicKey);
        this.notify(context.boardId);
      }
      for (const [id, request] of this.pending)
        if (request.connection === event.id) {
          clearTimeout(request.timer);
          this.pending.delete(id);
          request.reject(
            new Error("Peer disconnected; changes remain saved locally."),
          );
        }
    });
    this.transport.start(this.setting("collaboration.network") || {});
  }
  async ready() {
    this.ensure();
    if (this.options.transport === false)
      throw new Error("Networking is disabled in this isolated test profile.");
    if (!this.transport) this.startNetwork();
    if (this.address) return;
    await new Promise((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.off("ready", complete);
        reject(
          new Error(
            "Peer networking is not reachable. Local editing is available; retry when networking returns.",
          ),
        );
      }, 18000);
      this.once("ready", complete);
    });
  }
  notify(boardId) {
    if (!this.closed) this.emit("status", { boardId });
  }
  notifyAll() {
    if (!this.closed)
      for (const row of this.engine?.sharedBoards() || [])
        this.notify(row.board_id);
  }
  status(boardId) {
    this.ensure();
    const state = this.engine.status(boardId, false);
    if (!state) return null;
    const entry = this.engine.get(boardId),
      now = Date.now();
    const active = [...this.connections.values()].filter(
      (c) =>
        c.authenticated &&
        c.boardId === boardId &&
        c.lane === "control" &&
        entry.members.members.has(c.publicKey),
    );
    const online = new Set(active.map((c) => c.publicKey));
    const required = this.requiredAssets(entry);
    const missing = [...required].filter((id) => {
      const manifest = entry.doc.getMap("assets").get(id);
      return !manifest || !this.media.complete(manifest, entry.docId);
    });
    const transfer = this.transfers.get(boardId);
    const caughtUp =
      active.length > 0 &&
      active.every((c) =>
        [...entry.heads].every((id) => c.remoteKnown.has(id)),
      ) &&
      !active.some((c) => c.syncing);
    const peers = [...(this.presences.get(boardId)?.entries() || [])]
      .filter(
        ([, p]) =>
          now - p.seen < 5000 &&
          (online.has(p.publicKey) ||
            p.publicKey === this.engine.identity.publicKey),
      )
      .map(([publicKey, p]) => ({
        ...p,
        publicKey,
        identity: publicId(publicKey),
        color: color(publicId(publicKey)),
      }));
    const locks = {};
    for (const p of peers)
      if (
        p.resize &&
        (!locks[p.resize] || p.identity < locks[p.resize].identity)
      )
        locks[p.resize] = {
          identity: p.identity,
          name: entry.members.members.get(p.publicKey)?.name || "Collaborator",
        };
    return {
      ...state,
      identity: this.engine.identity.id,
      name: this.engine.identity.name,
      network: !state.active
        ? "removed"
        : this.errors.has(boardId)
          ? "error"
          : !this.address
            ? "offline"
            : !active.length
              ? "waiting"
              : active.some((c) => c.syncing) || !state.initialComplete
                ? "syncing"
                : missing.length
                  ? "attachments"
                  : caughtUp
                    ? "synced"
                    : "pending",
      error: this.errors.get(boardId) || "",
      connected: online.size,
      missing: missing.length,
      missingAssets: missing,
      availableAssets: [...required].filter((id) => !missing.includes(id)),
      transfer: transfer || null,
      presence: peers,
      locks,
      members: state.members.map((m) => ({
        identity: m.identity,
        name: m.name,
        owner: m.owner,
        online:
          online.has(m.publicKey) ||
          m.publicKey === this.engine.identity.publicKey,
        color: color(m.identity),
      })),
    };
  }
  proof(context, docId) {
    return signed(this.engine.identity, {
      v: 1,
      kind: "session",
      docId,
      transportKey: context.localKey,
      nonce: randomUUID(),
    });
  }
  checkProfile(record) {
    if (
      !authentic(record) ||
      record.payload.kind !== "profile" ||
      record.payload.v !== 1 ||
      !validName(record.payload.name) ||
      !Number.isSafeInteger(record.payload.sequence) ||
      record.payload.sequence < 1 ||
      typeof record.payload.address !== "string" ||
      record.payload.address.length > 4096
    )
      throw new Error("Invalid peer profile");
    return record;
  }
  saveProfile(record) {
    this.checkProfile(record);
    const old = this.peers.get(record.payload.author);
    if (!old || old.payload.sequence < record.payload.sequence) {
      this.peers.set(record.payload.author, record);
      this.service.store.db
        .prepare(
          "INSERT INTO collab_profiles VALUES(?,?) ON CONFLICT(public_key) DO UPDATE SET record=excluded.record",
        )
        .run(record.payload.author, JSON.stringify(record));
    }
  }
  authenticate(context, body, expected) {
    const proof = body.proof;
    if (
      !authentic(proof) ||
      proof.payload.kind !== "session" ||
      proof.payload.transportKey !== context.peerKey ||
      (expected && proof.payload.author !== expected)
    )
      throw new Error("Peer identity does not match the encrypted connection");
    const row = this.service.store.db
      .prepare("SELECT board_id FROM collab_boards WHERE doc_id=?")
      .get(proof.payload.docId);
    if (!row) throw new Error("Board unavailable or access denied");
    const entry = this.engine.get(row.board_id);
    if (body.genesis?.id !== entry.genesis.id)
      throw new Error("Board ownership proof differs");
    if (
      !Array.isArray(body.membership) ||
      body.membership.length > 512 ||
      body.membership.some(
        (r) => !["grant", "policy"].includes(r.payload?.kind),
      )
    )
      throw new Error("Invalid membership proof");
    for (let i = 0; i < body.membership.length; i += 128)
      this.engine.ingest(
        row.board_id,
        body.membership.slice(i, i + 128),
        context.id,
      );
    if (!entry.members.members.has(proof.payload.author)) {
      if (entry.members.revoked.has(publicId(proof.payload.author)))
        void this.sendRemoval(context, entry).catch(() => {});
      throw new Error("Board unavailable or access denied");
    }
    const profile = this.checkProfile(body.profile);
    if (profile.payload.author !== proof.payload.author)
      throw new Error("Mismatched peer profile");
    this.saveProfile(profile);
    context.boardId = row.board_id;
    context.publicKey = proof.payload.author;
    context.authenticated = true;
    return entry;
  }
  hello(context, entry) {
    return {
      proof: this.proof(context, entry.docId),
      genesis: entry.genesis,
      membership: entry.records.filter((r) => r.payload.kind !== "update"),
      profile: this.profile,
    };
  }
  send(context, frame) {
    return this.transport
      ? this.transport.send(context.id, frame)
      : Promise.reject(new Error("Peer networking is not running"));
  }
  async sendRemoval(context, entry) {
    const policies = entry.records.filter((r) => r.payload.kind === "policy");
    for (let i = 0; i < policies.length; i += 64)
      await this.send(context, {
        type: "revoked",
        docId: entry.docId,
        records: policies.slice(i, i + 64),
      });
  }
  request(context, method, body = {}) {
    if (this.pending.size > 128)
      return Promise.reject(
        new Error("Synchronization is busy; retry shortly"),
      );
    return new Promise((resolve, reject) => {
      const request = randomUUID(),
        timer = setTimeout(() => {
          this.pending.delete(request);
          reject(new Error("A collaborator did not respond; retrying later."));
        }, 15000);
      timer.unref();
      this.pending.set(request, {
        resolve,
        reject,
        timer,
        connection: context.id,
        method,
      });
      void this.send(context, { type: "request", request, method, body }).catch(
        (error) => {
          clearTimeout(timer);
          this.pending.delete(request);
          reject(error);
        },
      );
    });
  }
  async frame(event) {
    if (this.closed) return;
    const context = this.connections.get(event.id);
    if (!context) return;
    const frame = event.frame;
    if (
      !frame ||
      typeof frame !== "object" ||
      typeof frame.type !== "string" ||
      JSON.stringify(frame).length > 4 * 1024 * 1024
    )
      throw new Error("Invalid peer message");
    const second = Math.floor(Date.now() / 1000);
    if (context.second !== second) {
      context.second = second;
      context.count = 0;
    }
    if (++context.count > 2000) throw new Error("Peer message rate exceeded");
    // Removal proofs may be learned after ordinary access has already ended.
    // Only signed owner policies for a board already held locally are admitted.
    if (frame.type === "revoked") {
      const row = this.service.store.db
        .prepare("SELECT board_id FROM collab_boards WHERE doc_id=?")
        .get(uuid.parse(frame.docId));
      if (!row) throw new Error("Unknown membership notice");
      const entry = this.engine.get(row.board_id);
      if (
        !Array.isArray(frame.records) ||
        frame.records.length > 64 ||
        frame.records.some(
          (r) =>
            r.payload?.kind !== "policy" ||
            r.payload.author !== entry.genesis.payload.author,
        )
      )
        throw new Error("Invalid membership notice");
      this.engine.ingest(row.board_id, frame.records, context.id);
      return;
    }
    if (frame.type === "reply") {
      const pending = this.pending.get(frame.request);
      if (!pending || pending.connection !== context.id) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.request);
      if (!frame.error && pending.method === "hello")
        this.authenticate(context, frame.body, context.expectedPublic);
      frame.error
        ? pending.reject(new Error(String(frame.error).slice(0, 500)))
        : pending.resolve(frame.body);
      return;
    }
    if (frame.type === "request") {
      uuid.parse(frame.request);
      try {
        const body = await this.handlePeer(context, frame.method, frame.body);
        await this.send(context, {
          type: "reply",
          request: frame.request,
          body,
        });
        if (frame.method === "hello")
          void this.synchronize(context).catch((error) =>
            this.fail(context, error),
          );
      } catch (error) {
        const message =
          /^(Invitation expired|Invitation could|Board unavailable|Access denied|Attachment not available|This file is not|Only current collaborators|This release supports)/.test(
            error.message,
          )
            ? error.message.slice(0, 200)
            : "The peer could not complete this request. Retry synchronization.";
        await this.send(context, {
          type: "reply",
          request: frame.request,
          error: message,
        });
      }
      return;
    }
    const entry = this.engine.get(context.boardId);
    if (
      !context.authenticated ||
      !entry?.members.members.has(context.publicKey)
    )
      throw new Error("Access denied");
    if (frame.type === "changes") {
      await this.guard.check(frame.records);
      if (this.closed) return;
      this.engine.ingest(context.boardId, frame.records, context.id);
      for (const record of frame.records) context.remoteKnown.add(record.id);
      await this.send(context, {
        type: "ack",
        ids: frame.records.map((r) => r.id),
      });
      this.notify(context.boardId);
    } else if (frame.type === "ack") {
      for (const id of z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(128)
        .parse(frame.ids))
        context.remoteKnown.add(id);
      this.notify(context.boardId);
    } else if (frame.type === "presence") {
      const presence = presenceSchema.parse(frame.body);
      if (!this.presences.has(context.boardId))
        this.presences.set(context.boardId, new Map());
      this.presences.get(context.boardId).set(context.publicKey, {
        ...presence,
        publicKey: context.publicKey,
        seen: Date.now(),
        name: entry.members.members.get(context.publicKey).name,
      });
      this.emit("presence", { boardId: context.boardId });
    } else throw new Error("Unsupported peer message");
  }
  async handlePeer(context, method, body) {
    if (method === "hello") {
      const entry = this.authenticate(context, body);
      return this.hello(context, entry);
    }
    if (method === "join") return this.acceptInvitation(context, body);
    const entry = this.engine.get(context.boardId);
    if (
      !context.authenticated ||
      !entry?.members.members.has(context.publicKey)
    )
      throw new Error("Access denied");
    if (method === "inventory") {
      const offset = z
        .number()
        .int()
        .min(0)
        .max(1000000)
        .parse(body.offset || 0);
      const records = entry.records.filter(
        (r) =>
          r.payload.kind !== "update" ||
          entry.members.members.has(r.payload.author) ||
          entry.eligibility.past.has(r.id),
      );
      return {
        ids: records.slice(offset, offset + 256).map((r) => r.id),
        more: offset + 256 < records.length,
        total: records.length,
        profiles: [...this.peers.values()].filter((p) =>
          entry.members.members.has(p.payload.author),
        ),
      };
    }
    if (method === "records") {
      const ids = new Set(
        z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(32)
          .parse(body.ids),
      );
      const records = [];
      let size = 0;
      for (const record of entry.records)
        if (
          ids.has(record.id) &&
          (record.payload.kind !== "update" ||
            entry.members.members.has(record.payload.author) ||
            entry.eligibility.past.has(record.id))
        ) {
          const bytes = JSON.stringify(record).length;
          if (size + bytes > 3 * 1024 * 1024) break;
          records.push(record);
          size += bytes;
        }
      return { records };
    }
    if (method === "chunk") {
      if (context.lane !== "bulk")
        throw new Error("Media requires its own transfer channel");
      const id = uuid.parse(body.id),
        manifest = entry.doc.getMap("assets").get(id);
      if (!manifest)
        throw new Error("This file is not part of the shared board");
      const bytes = await this.media.read(manifest, body.offset, entry.docId);
      return { offset: body.offset, bytes: base64(bytes) };
    }
    throw new Error("Unknown collaboration operation");
  }
  fail(context, error) {
    if (context.boardId) {
      this.errors.set(context.boardId, error.message);
      this.notify(context.boardId);
    }
  }
  async synchronize(context) {
    if (!context.authenticated || context.syncing || context.lane !== "control")
      return;
    context.syncing = true;
    this.notify(context.boardId);
    try {
      const entry = this.engine.get(context.boardId),
        remote = [];
      for (let offset = 0; ; offset += 256) {
        const response = await this.request(context, "inventory", { offset });
        const ids = z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(256)
          .parse(response.ids);
        remote.push(...ids);
        for (const profile of response.profiles || [])
          if (entry.members.members.has(profile.payload?.author))
            this.saveProfile(profile);
        if (response.more !== true) break;
        if (offset >= 1000000)
          throw new Error("Peer history exceeds the supported inventory size");
      }
      context.remoteKnown = new Set(remote);
      const known = new Set(entry.records.map((r) => r.id));
      let missing = remote.filter((id) => !known.has(id));
      while (missing.length) {
        const reply = await this.request(context, "records", {
          ids: missing.slice(0, 32),
        });
        if (!Array.isArray(reply.records) || !reply.records.length)
          throw new Error("Peer could not supply requested history");
        await this.guard.check(reply.records);
        if (this.closed) return;
        this.engine.ingest(context.boardId, reply.records, context.id);
        await this.send(context, {
          type: "ack",
          ids: reply.records.map((r) => r.id),
        });
        const received = new Set(reply.records.map((r) => r.id));
        missing = missing.filter((id) => !received.has(id));
      }
      this.errors.delete(context.boardId);
      if (
        this.engine.initialComplete(entry) &&
        this.setting("collaboration.initial." + entry.docId)
      )
        this.setting("collaboration.initial." + entry.docId, false);
      void this.download(context).catch((error) => this.fail(context, error));
    } finally {
      context.syncing = false;
      this.notify(context.boardId);
    }
  }
  async dial(publicKey, boardId, lane = "control") {
    const profile = this.peers.get(publicKey);
    if (!profile)
      throw new Error("No connection address is known for this collaborator");
    const event = await this.transport.dial(profile.payload.address, lane),
      context = this.connections.get(event.id);
    context.expectedPublic = publicKey;
    const entry = this.engine.get(boardId);
    const reply = await this.request(
      context,
      "hello",
      this.hello(context, entry),
    );
    this.authenticate(context, reply, publicKey);
    this.notify(boardId);
    return context;
  }
  async tick() {
    if (this.closed || !this.address) return;
    if (Date.now() - (this.lastCleanup || 0) > 3600000) this.cleanup();
    for (const context of this.connections.values())
      if (!context.authenticated && Date.now() - context.created > 25000)
        void this.transport.disconnect(context.id);
    for (const row of this.engine.sharedBoards()) {
      const entry = this.engine.get(row.board_id);
      if (!entry.members.members.has(this.engine.identity.publicKey)) continue;
      for (const member of entry.members.members.keys()) {
        if (
          member === this.engine.identity.publicKey ||
          !this.peers.has(member)
        )
          continue;
        const key = row.board_id + ":" + member;
        const context = [...this.connections.values()].find(
          (c) =>
            c.authenticated &&
            c.boardId === row.board_id &&
            c.publicKey === member &&
            c.lane === "control",
        );
        if (context) {
          void this.synchronize(context).catch((error) =>
            this.fail(context, error),
          );
          continue;
        }
        if (this.dialing.has(key)) continue;
        this.dialing.add(key);
        void this.dial(member, row.board_id)
          .then((c) => this.synchronize(c))
          .catch(() => {})
          .finally(() => this.dialing.delete(key));
      }
    }
  }
  cleanup() {
    this.lastCleanup = Date.now();
    const db = this.service.store.db;
    db.prepare("DELETE FROM collab_recovery WHERE created<?").run(
      Date.now() - 30 * 86400000,
    );
    for (const row of this.engine.sharedBoards())
      db.prepare(
        "DELETE FROM collab_recovery WHERE doc_id=? AND id NOT IN (SELECT id FROM collab_recovery WHERE doc_id=? ORDER BY created DESC LIMIT 32)",
      ).run(row.doc_id, row.doc_id);
    db.prepare("DELETE FROM collab_invites WHERE expires<?").run(
      Date.now() - 86400000,
    );
  }
  async download(context) {
    if (this.transfers.has(context.boardId)) return;
    const entry = this.engine.get(context.boardId),
      required = this.requiredAssets(entry),
      manifests = [...entry.doc.getMap("assets").values()]
        .map((m) => manifestSchema.parse(m))
        .filter(
          (m) => required.has(m.id) && !this.media.complete(m, entry.docId),
        );
    if (!manifests.length) return;
    const total = manifests.reduce((n, m) => n + m.size, 0),
      progress = { received: 0, total };
    this.transfers.set(context.boardId, progress);
    this.notify(context.boardId);
    let bulk;
    try {
      bulk = await this.dial(context.publicKey, context.boardId, "bulk");
      for (const manifest of manifests.sort((a, b) => a.size - b.size)) {
        let offset = await this.media.resume(manifest, entry.docId);
        progress.received += offset;
        while (offset < manifest.size) {
          const reply = await this.request(bulk, "chunk", {
            id: manifest.id,
            offset,
          });
          if (reply.offset !== offset)
            throw new Error("Attachment offset mismatch");
          const result = await this.media.chunk(
            manifest,
            offset,
            unbase64(reply.bytes, 65536),
            entry.docId,
          );
          progress.received += result.received - offset;
          offset = result.received;
          this.notify(context.boardId);
        }
        this.emit("delta", { boardId: context.boardId, assetsChanged: true });
        this.service.store.db
          .prepare(
            "INSERT OR IGNORE INTO asset_refs SELECT board_id,id,? FROM elements WHERE board_id=? AND (json_extract(content,'$.data.assetId')=? OR json_extract(content,'$.data.thumbnailId')=? OR json_extract(content,'$.data.faviconId')=?)",
          )
          .run(
            manifest.id,
            context.boardId,
            manifest.id,
            manifest.id,
            manifest.id,
          );
      }
    } finally {
      if (bulk) await this.transport.disconnect(bulk.id);
      this.transfers.delete(context.boardId);
      this.notify(context.boardId);
    }
  }
  async invite(boardId) {
    await this.ready();
    const entry = this.engine.get(boardId);
    if (!entry?.members.members.has(this.engine.identity.publicKey))
      throw new Error("Only current collaborators may invite people");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url"),
      expires = Date.now() + 15 * 60 * 1000;
    const record = signed(this.engine.identity, {
      v: 1,
      kind: "invite",
      docId: entry.docId,
      owner: entry.members.owner,
      address: this.address,
      name: this.engine.identity.name,
      id,
      token,
      expires,
    });
    this.service.store.db
      .prepare(
        "INSERT INTO collab_invites(id,doc_id,token_hash,expires) VALUES(?,?,?,?)",
      )
      .run(id, entry.docId, hash(token), expires);
    return {
      id,
      code:
        "intelboard1." +
        Buffer.from(JSON.stringify(record)).toString("base64url"),
      expires,
    };
  }
  async join(code) {
    await this.ready();
    if (
      typeof code !== "string" ||
      code.length > 16000 ||
      !code.startsWith("intelboard1.")
    )
      throw new Error("Invalid invitation code");
    let invite;
    try {
      invite = JSON.parse(Buffer.from(code.slice(12), "base64url").toString());
    } catch {
      throw new Error("Invalid invitation code");
    }
    if (
      !authentic(invite) ||
      invite.payload.kind !== "invite" ||
      invite.payload.v !== 1 ||
      !Number.isSafeInteger(invite.payload.expires) ||
      invite.payload.expires <= Date.now() ||
      invite.payload.expires > Date.now() + 16 * 60 * 1000 ||
      typeof invite.payload.address !== "string" ||
      invite.payload.address.length > 4096 ||
      typeof invite.payload.token !== "string" ||
      invite.payload.token.length !== 43
    )
      throw new Error(
        "Invitation expired or invalid. Ask a collaborator for a new code.",
      );
    const event = await this.transport.dial(invite.payload.address, "control"),
      context = this.connections.get(event.id);
    const reply = await this.request(context, "join", {
      invite,
      proof: this.proof(context, invite.payload.docId),
      profile: this.profile,
    });
    if (
      !authentic(reply.proof) ||
      reply.proof.payload.author !== invite.payload.author ||
      reply.proof.payload.transportKey !== context.peerKey ||
      reply.genesis.payload.author !== invite.payload.owner ||
      reply.genesis.payload.docId !== invite.payload.docId
    )
      throw new Error("Invitation host identity could not be verified");
    if (
      !Array.isArray(reply.membership) ||
      reply.membership.some(
        (r) => !["grant", "policy"].includes(r.payload?.kind),
      )
    )
      throw new Error("Invalid invitation membership proof");
    const boardId = this.engine.accept(reply.genesis, reply.membership);
    this.setting("collaboration.initial." + reply.genesis.payload.docId, true);
    this.authenticate(context, reply, invite.payload.author);
    void this.synchronize(context).catch((error) => this.fail(context, error));
    return { boardId };
  }
  async acceptInvitation(context, body) {
    const invite = body.invite;
    if (
      !authentic(invite) ||
      invite.payload.author !== this.engine.identity.publicKey ||
      invite.payload.kind !== "invite" ||
      !authentic(body.proof) ||
      body.proof.payload.transportKey !== context.peerKey ||
      body.proof.payload.docId !== invite.payload.docId
    )
      throw new Error("Invitation could not be authenticated");
    const profile = this.checkProfile(body.profile);
    if (profile.payload.author !== body.proof.payload.author)
      throw new Error("Invalid joining identity");
    const saved = this.service.store.db
      .prepare("SELECT * FROM collab_invites WHERE id=?")
      .get(invite.payload.id);
    if (
      !saved ||
      saved.doc_id !== invite.payload.docId ||
      saved.token_hash !== hash(invite.payload.token) ||
      saved.revoked ||
      saved.expires <= Date.now() ||
      (saved.subject && saved.subject !== profile.payload.author)
    )
      throw new Error("Invitation expired, revoked, or already used");
    const row = this.service.store.db
      .prepare("SELECT board_id FROM collab_boards WHERE doc_id=?")
      .get(saved.doc_id);
    const entry = this.engine.get(row.board_id);
    let grant;
    this.service.store.transaction(() => {
      if (saved.grant_id)
        grant = entry.records.find((r) => r.id === saved.grant_id);
      else {
        grant = this.engine.grant(
          row.board_id,
          profile.payload.author,
          profile.payload.name,
        );
        this.service.store.db
          .prepare("UPDATE collab_invites SET subject=?,grant_id=? WHERE id=?")
          .run(profile.payload.author, grant.id, saved.id);
      }
    });
    this.saveProfile(profile);
    context.boardId = row.board_id;
    context.publicKey = profile.payload.author;
    context.authenticated = true;
    return this.hello(context, entry);
  }
  presence(boardId, value) {
    this.ensure();
    const body = presenceSchema.parse(value),
      entry = this.engine.get(boardId);
    if (!entry?.members.members.has(this.engine.identity.publicKey)) return;
    if (!this.presences.has(boardId)) this.presences.set(boardId, new Map());
    this.presences.get(boardId).set(this.engine.identity.publicKey, {
      ...body,
      publicKey: this.engine.identity.publicKey,
      seen: Date.now(),
      name: this.engine.identity.name,
    });
    for (const context of this.connections.values())
      if (
        context.authenticated &&
        context.boardId === boardId &&
        context.lane === "control"
      )
        void this.send(context, { type: "presence", body }).catch(() => {});
  }
  async handle(operation, boardId, body = {}) {
    this.ensure();
    if (boardId) uuid.parse(boardId);
    if (operation === "name") {
      if (!validName(body.name))
        throw new Error("Enter a name between 1 and 80 characters");
      this.engine.identity.name = body.name.trim();
      this.setting("collaboration.identity", this.engine.identity);
      if (this.profile) {
        this.profile = signed(this.engine.identity, {
          ...this.profile.payload,
          name: this.engine.identity.name,
          sequence: this.profile.payload.sequence + 1,
        });
        this.setting(
          "collaboration.profileSequence",
          this.profile.payload.sequence,
        );
      }
      return { name: this.engine.identity.name };
    }
    if (operation === "join") return this.join(body.code);
    if (operation === "share") {
      const prepared = await this.media.prepare(
        this.service.store.get(boardId),
      );
      this.service.store.transaction(() => {
        this.engine.share(boardId, prepared.board);
        for (const m of prepared.manifests)
          this.media.authorize(this.engine.get(boardId).docId, m);
        if (prepared.manifests.length)
          this.engine.edit(boardId, (doc) => {
            for (const m of prepared.manifests)
              doc.getMap("assets").set(m.id, m);
          });
      });
      return this.engine.open(boardId);
    }
    if (operation === "status") return this.status(boardId);
    if (operation === "open") {
      const opened = this.engine.open(boardId);
      return opened ? { ...opened, status: this.status(boardId) } : null;
    }
    if (operation === "update") return this.engine.local(boardId, body);
    if (operation === "presence") {
      this.presence(boardId, body);
      return { ok: true };
    }
    if (operation === "invite") return this.invite(boardId);
    if (operation === "cancel-invite") {
      this.service.store.db
        .prepare(
          "UPDATE collab_invites SET revoked=1 WHERE id=? AND doc_id=(SELECT doc_id FROM collab_boards WHERE board_id=?)",
        )
        .run(uuid.parse(body.id), boardId);
      return { ok: true };
    }
    if (operation === "remove") {
      this.engine.revoke(
        boardId,
        z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(body.identity),
      );
      return this.status(boardId);
    }
    if (operation === "retry") {
      this.errors.delete(boardId);
      void this.tick().catch(() => {});
      return this.status(boardId);
    }
    if (operation === "rename") {
      const title = z.string().trim().min(1).max(200).parse(body.title);
      this.engine.edit(boardId, (doc) => {
        const text = doc.getText("title");
        text.delete(0, text.length);
        text.insert(0, title);
      });
      return { ok: true };
    }
    if (operation === "preserve-local") {
      const board = boardSchema.parse(body);
      if (JSON.stringify(board).length > 32 * 1024 * 1024)
        throw new Error("Recovery copy is too large");
      this.service.store.db
        .prepare("INSERT INTO collab_recovery VALUES(?,?,?,?,?)")
        .run(
          randomUUID(),
          this.engine.get(boardId).docId,
          Date.now(),
          "Unsent local changes retained during membership reconciliation",
          JSON.stringify(board),
        );
      return { ok: true };
    }
    if (operation === "asset") {
      const manifest = await this.media.local(uuid.parse(body.id));
      this.media.authorize(this.engine.get(boardId).docId, manifest);
      this.engine.edit(boardId, (doc) =>
        doc.getMap("assets").set(manifest.id, manifest),
      );
      return manifest;
    }
    if (operation === "recovery") {
      const entry = this.engine.get(boardId),
        layout = mergedLayout(entry.doc, boardValue(entry.doc).nodes);
      return {
        ...recoveryItems(entry.doc),
        layout: {
          shifted: layout.offsets.size,
          warnings: layout.warnings.length,
        },
        forks: this.service.store.db
          .prepare(
            "SELECT id,created,reason FROM collab_recovery WHERE doc_id=? AND created>? ORDER BY created DESC LIMIT 32",
          )
          .all(entry.docId, Date.now() - 30 * 86400000),
      };
    }
    if (operation === "layout-accept" || operation === "layout-authored") {
      const entry = this.engine.get(boardId);
      this.engine.edit(boardId, (doc) => {
        const before = boardValue(doc),
          layout = mergedLayout(doc, before.nodes);
        if (operation === "layout-accept")
          patchBoard(
            doc,
            before,
            { ...before, nodes: layout.nodes },
            { actor: this.engine.identity.id, session: entry.session },
          );
        else
          for (const id of layout.offsets.keys())
            doc.getMap("nodes").get(id).set("positioned", true);
      });
      return { ok: true };
    }
    if (operation === "restore-node" || operation === "restore-edge") {
      this.engine.edit(boardId, (doc) => {
        const node = doc
          .getMap(operation === "restore-edge" ? "edges" : "nodes")
          .get(uuid.parse(body.id));
        if (!node) throw new Error("Item not found");
        node.set("deleted", false);
      });
      return { ok: true };
    }
    if (operation === "restore-geometry") {
      const id = z.string().max(256).parse(body.id);
      this.engine.edit(boardId, (doc) => {
        const recovery = doc.getMap("geometry").get(id);
        if (!recovery) throw new Error("Position history not found");
        const node = doc.getMap("nodes").get(recovery.node);
        if (!node) throw new Error("Item not found");
        const props = node.get("props");
        for (const key of ["position", "width", "height", "style"])
          if (recovery.before[key] === undefined) props.delete(key);
          else props.set(key, recovery.before[key]);
        node.set("positioned", true);
      });
      return { ok: true };
    }
    if (operation === "private-copy") {
      if (!this.canExport(boardId))
        throw new Error(
          "Some shared content or attachments are still arriving. Retry the private copy after synchronization finishes.",
        );
      const board = this.service.store.get(boardId),
        copy = this.service.store.create(
          (board.title + " — private copy").slice(0, 200),
        );
      const nodes = board.nodes.map((node) => {
        const data = { ...node.data };
        for (const key of ["assetId", "thumbnailId", "faviconId"])
          if (data[key] && !this.service.assets.get(data[key]))
            delete data[key];
        return { ...node, data };
      });
      this.service.store.save(copy.id, {
        ...board,
        nodes,
        title: copy.title,
        revision: 0,
      });
      return { boardId: copy.id };
    }
    if (operation === "restore-fork") {
      const row = this.service.store.db
        .prepare("SELECT board FROM collab_recovery WHERE id=? AND doc_id=?")
        .get(uuid.parse(body.id), this.engine.get(boardId).docId);
      if (!row) throw new Error("Recovery copy not found");
      const recovered = JSON.parse(row.board);
      if (
        recovered.nodes.some((n) =>
          ["assetId", "thumbnailId", "faviconId"].some(
            (key) => n.data[key] && !this.service.assets.get(n.data[key]),
          ),
        )
      )
        throw new Error(
          "This recovery copy still references unavailable attachments. Its content has been retained; restore the missing files before opening a complete private copy.",
        );
      const saved = JSON.parse(row.board),
        copy = this.service.store.create(
          (saved.title + " — recovered").slice(0, 200),
        );
      this.service.store.save(copy.id, {
        ...saved,
        revision: 0,
        title: copy.title,
      });
      return { boardId: copy.id };
    }
    if (operation === "viewport") {
      const viewport = z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          zoom: z.number().min(0.05).max(4),
        })
        .parse(body);
      this.service.store.db
        .prepare("UPDATE boards SET viewport=? WHERE id=?")
        .run(JSON.stringify(viewport), boardId);
      return { ok: true };
    }
    throw new Error("Unknown collaboration operation");
  }
  canExport(boardId) {
    if (!this.engine) return true;
    const entry = this.engine.get(boardId);
    if (!entry) return true;
    if (!this.engine.initialComplete(entry)) return false;
    if (this.setting("collaboration.initial." + entry.docId)) return false;
    if (
      [...this.connections.values()].some(
        (c) => c.boardId === boardId && c.syncing,
      )
    )
      return false;
    for (const [, node] of entry.doc.getMap("nodes"))
      if (!node.get("deleted"))
        for (const key of ["assetId", "thumbnailId", "faviconId"]) {
          const id = node.get("data").get(key);
          if (!id) continue;
          const manifest = entry.doc.getMap("assets").get(id);
          if (!manifest || !this.media.complete(manifest, entry.docId))
            return false;
        }
    return true;
  }
  requiredAssets(entry) {
    const ids = new Set();
    for (const [, node] of entry.doc.getMap("nodes"))
      if (!node.get("deleted"))
        for (const key of ["assetId", "thumbnailId", "faviconId"]) {
          const id = node.get("data").get(key);
          if (id) ids.add(id);
        }
    return ids;
  }
  forget(boardId) {
    for (const context of this.connections.values())
      if (context.boardId === boardId)
        void this.transport?.disconnect(context.id);
    const entry = this.engine?.documents.get(boardId);
    entry?.doc.destroy();
    this.engine?.documents.delete(boardId);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.transport?.close();
    this.guard?.close();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("IntelBoard closed"));
    }
    this.pending.clear();
    this.engine?.close();
  }
}
