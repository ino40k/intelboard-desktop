import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Board, Item, Connection } from "../model";
import { cleanNodes, cleanEdges } from "../model";
import {
  Y,
  LOCAL,
  REMOTE,
  base64,
  unbase64,
  createDocument,
  boardValue,
  patchBoard,
  textBinding,
  textValue,
  editText,
} from "../../shared/collaboration/document.js";
import { mergedLayout } from "../../shared/collaboration/layout.js";
import { boardSchema, BOARD_TITLE_LIMIT } from "../../shared/schema.js";
import { collaborationId } from "../../shared/collaboration/ids.js";

export async function collaboration<T = any>(
  operation: string,
  boardId?: string,
  body?: unknown,
): Promise<T> {
  const result = await window.intelboard.collaboration(
    operation,
    boardId,
    body,
  );
  if (!result.ok)
    throw Object.assign(
      new Error(result.error || "Collaboration operation failed"),
      {
        code: result.code,
      },
    );
  return result.data as T;
}
type Message = { session: string; before: string; data: string };
type Setter<T> = T | ((previous: T) => T);
type Value = {
  text: string;
  format: { start: number; end: number; style: number }[];
};
export type TextBinding = {
  text: Y.Text;
  doc: Y.Doc;
  origin: object;
  read: () => Value;
  apply: (next: Value) => void;
  undo: (redo: boolean) => void;
  compose: (active: boolean) => void;
};
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

export class SharedBoardController {
  doc: Y.Doc = createDocument();
  actor: string;
  session: string;
  boardId: string;
  batch = crypto.randomUUID();
  initial: Board;
  viewport: Board["viewport"];
  network: any;
  listeners = new Set<() => void>();
  presenceListeners = new Set<() => void>();
  ui = new Map<string, any>();
  edgeUI = new Map<string, any>();
  bindings = new Map<string, TextBinding>();
  outbox: Message[] = [];
  draining = false;
  drainPromise?: Promise<void>;
  error = "";
  composing = 0;
  incoming: string[] = [];
  disposed = false;
  resetting = false;
  onReset?: (notice: string, onOpened: () => void) => Promise<void>;
  undoManager: Y.UndoManager;
  cached: Board | null = null;
  statusVersion = 0;
  private before = "";
  private interacting = false;
  private unsubscribe: () => void;
  private heartbeat: ReturnType<typeof setInterval>;
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private lastPresence = 0;
  presenceValue: any = {
    cursor: null,
    selection: [],
    resize: null,
    previews: [],
    editing: null,
  };
  nonces = new Map<string, string>();
  rendered = new Map<string, { raw: Item; signature: string; node: Item }>();
  renderedEdges = new Map<
    string,
    { raw: Connection; selected: unknown; edge: Connection }
  >();
  newId = () => {
    const nonce = crypto.randomUUID(),
      id = collaborationId(this.actor, nonce, this.session);
    this.nonces.set(id, nonce);
    return id;
  };
  constructor(board: Board, opened: any) {
    this.initial = board;
    this.viewport = board.viewport;
    this.boardId = board.id;
    this.actor = opened.actor;
    this.session = opened.session;
    this.network = opened.status;
    Y.applyUpdate(this.doc, unbase64(opened.data, 64 * 1024 * 1024), REMOTE);
    this.doc.clientID = opened.client;
    try {
      this.outbox = JSON.parse(localStorage.getItem(this.outboxKey) || "[]");
    } catch {
      this.error =
        "Local collaborative recovery data could not be read. It has been retained.";
    }
    for (const message of this.outbox)
      Y.applyUpdate(this.doc, unbase64(message.data), REMOTE);
    this.undoManager = new Y.UndoManager(
      [
        this.doc.getMap("nodes"),
        this.doc.getMap("edges"),
        this.doc.getText("title"),
        this.doc.getMap("geometry"),
      ],
      { trackedOrigins: new Set([LOCAL]) },
    );
    this.doc.on("beforeTransaction", (transaction) => {
      if (transaction.origin !== REMOTE)
        this.before = base64(Y.encodeStateVector(this.doc));
    });
    this.doc.on("update", (bytes, origin) => {
      if (origin !== REMOTE) {
        this.outbox.push({
          session: this.session,
          before: this.before,
          data: base64(bytes),
        });
        this.persistOutbox();
        void this.flush();
      }
      this.invalidate();
    });
    this.unsubscribe = window.intelboard.onCollaboration((event) => {
      if (event.boardId !== this.boardId) return;
      if (event.type === "delta") {
        if (event.reset) {
          void this.reconcileReset();
          return;
        } else this.incoming.push(...(event.updates || []));
        if (!this.composing) this.applyIncoming();
      }
      if (
        event.type === "status" ||
        event.type === "presence" ||
        event.assetsChanged
      )
        void this.refreshStatus();
    });
    this.heartbeat = setInterval(() => {
      this.sendPresence();
      void this.refreshStatus();
    }, 2000);
    void this.refreshStatus();
    void this.flush();
  }
  get outboxKey() {
    return "intelboard.collaboration.outbox." + this.boardId;
  }
  persistOutbox() {
    try {
      if (this.outbox.length)
        localStorage.setItem(this.outboxKey, JSON.stringify(this.outbox));
      else localStorage.removeItem(this.outboxKey);
    } catch {
      this.flushSync();
      if (this.outbox.length)
        this.error =
          "Local recovery storage is full. Keep IntelBoard open until changes are saved.";
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribePresence = (listener: () => void) => {
    this.presenceListeners.add(listener);
    return () => {
      this.presenceListeners.delete(listener);
    };
  };
  invalidate = () => {
    this.cached = null;
    this.statusVersion++;
    for (const listener of this.listeners) listener();
  };
  getSnapshot = (): Board => {
    if (this.cached) return this.cached;
    const raw = boardValue(this.doc, this.viewport),
      layout = mergedLayout(this.doc, raw.nodes);
    const authored = new Map<string, Item>(
      raw.nodes.map((n: Item) => [n.id, n]),
    );
    const nodes = layout.nodes.map((node: Item) => {
      const ui = this.ui.get(node.id) || {};
      const remote = this.network?.presence
        ?.find(
          (p: any) =>
            p.identity !== this.actor &&
            p.previews?.some((n: any) => n.id === node.id),
        )
        ?.previews.find((n: any) => n.id === node.id);
      const original = authored.get(node.id)!,
        signature = JSON.stringify([node.position, ui, remote]),
        previous = this.rendered.get(node.id);
      if (previous?.raw === original && previous?.signature === signature)
        return previous.node;
      const rendered = {
        ...node,
        ...(remote && !ui.preview
          ? {
              position: remote.position || node.position,
              width: remote.width || node.width,
              height: remote.height || node.height,
              style: {
                ...node.style,
                width: remote.width || node.style?.width,
                height: remote.height || node.style?.height,
              },
            }
          : {}),
        ...ui,
        data: { ...node.data, ...ui.data },
      };
      this.rendered.set(node.id, { raw: original, signature, node: rendered });
      return rendered;
    });
    this.cached = {
      ...this.initial,
      ...raw,
      nodes,
      edges: raw.edges.map((edge: Connection) => {
        const selected = this.edgeUI.get(edge.id)?.selected,
          previous = this.renderedEdges.get(edge.id);
        if (previous?.raw === edge && previous?.selected === selected)
          return previous.edge;
        const rendered = { ...edge, selected };
        this.renderedEdges.set(edge.id, {
          raw: edge,
          selected,
          edge: rendered,
        });
        return rendered;
      }),
      shared: true,
    } as Board;
    return this.cached;
  };
  async refreshStatus() {
    try {
      if (this.disposed) return;
      const previous = this.network;
      const network = await collaboration("status", this.boardId);
      if (this.disposed) return;
      this.network = network;
      if (
        this.network?.active === false &&
        this.outbox.length &&
        !this.resetting
      )
        void this.reconcileReset();
      if (!equal(previous, this.network)) {
        for (const listener of this.presenceListeners) listener();
        if (
          this.network?.presence?.some((p: any) => p.previews?.length) ||
          previous?.presence?.some((p: any) => p.previews?.length)
        )
          this.invalidate();
      }
    } catch (error) {
      this.error = (error as Error).message;
    }
  }
  async reconcileReset(rejected = false) {
    if (this.resetting || this.disposed) return;
    this.resetting = true;
    this.invalidate();
    try {
      if (!this.onReset) throw new Error("This board cannot reopen yet.");
      let board;
      try {
        board = boardSchema.safeParse(this.getSnapshot());
      } catch {
        // A rejected CRDT value may be impossible to project as a private board.
      }
      if (board?.success)
        await collaboration("preserve-local", this.boardId, {
          board: board.data,
          rejected,
        });
      else
        await collaboration("preserve-draft", this.boardId, {
          data: base64(Y.encodeStateAsUpdate(this.doc)),
        });
      await this.onReset(
        "Unsent edits were saved under Deleted items & recovery.",
        () => {
          this.outbox = [];
          this.persistOutbox();
        },
      );
    } catch (error) {
      this.resetting = false;
      this.error =
        "A recovery copy could not be saved or the board could not reopen. Your edits are retained. " +
        (error as Error).message;
      this.invalidate();
    }
  }
  applyIncoming() {
    const updates = this.incoming.splice(0);
    if (!updates.length) return;
    this.batch = crypto.randomUUID();
    for (const data of updates)
      Y.applyUpdate(this.doc, unbase64(data, 64 * 1024 * 1024), REMOTE);
    this.invalidate();
  }
  flush(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }
  private async drain() {
    if (this.draining || this.disposed || this.resetting) return;
    this.draining = true;
    try {
      const hadEdits = this.outbox.length > 0;
      while (this.outbox.length && !this.disposed && !this.resetting) {
        const next = this.outbox[0];
        await collaboration("update", this.boardId, next);
        if (this.disposed || this.resetting) break;
        if (this.outbox[0] === next) this.outbox.shift();
        this.persistOutbox();
      }
      if (hadEdits && !this.network?.quarantined) this.error = "";
    } catch (error) {
      const failure = error as Error & { code?: string };
      this.error = failure.message;
      if (failure.code === "COLLAB_EDIT_REJECTED")
        await this.reconcileReset(true);
      else if (/unobserved|excluded|permission/.test(this.error))
        await this.reconcileReset();
    } finally {
      this.draining = false;
      this.invalidate();
    }
  }
  flushSync() {
    if (this.resetting) return;
    while (this.outbox.length) {
      const result = window.intelboard.saveCollaboration(
        this.boardId,
        this.outbox[0],
      );
      if (!result.ok) {
        this.error = result.error || "Local changes could not be saved";
        if (result.code === "COLLAB_EDIT_REJECTED" && !this.disposed)
          void this.flush();
        break;
      }
      this.outbox.shift();
    }
    try {
      if (!this.outbox.length) localStorage.removeItem(this.outboxKey);
    } catch {}
  }
  checkpoint = () => {
    this.undoManager.stopCapturing();
  };
  undo = (redo = false) => {
    redo ? this.undoManager.redo() : this.undoManager.undo();
    this.invalidate();
  };
  setTitle = (value: Setter<string>) => {
    if (this.resetting || this.network?.active === false) return;
    const title =
      typeof value === "function" ? value(boardValue(this.doc).title) : value;
    if (!title.trim() || title.length > BOARD_TITLE_LIMIT) return;
    this.doc.transact(() => editText(this.doc.getText("title"), title), LOCAL);
  };
  setNodes = (value: Setter<Item[]>) => {
    if (this.resetting || this.network?.active === false) return;
    const displayed = this.getSnapshot().nodes,
      proposed = typeof value === "function" ? value(displayed) : value;
    const raw = boardValue(this.doc),
      old = new Map(displayed.map((n) => [n.id, n])),
      authored = new Map(raw.nodes.map((n: Item) => [n.id, n]));
    const layout = mergedLayout(this.doc, raw.nodes);
    for (const node of proposed) {
      const previous = this.ui.get(node.id) || {};
      this.ui.set(node.id, {
        ...previous,
        selected: node.selected,
        dragging: node.dragging,
        resizing: node.resizing,
        measured: node.measured,
        data: {
          loading: node.data.loading,
          localUrl: node.data.localUrl,
          uploadError: node.data.uploadError,
        },
        ...(this.interacting
          ? {
              preview: true,
              position: node.position,
              width: node.width,
              height: node.height,
              style: node.style,
            }
          : {}),
      });
    }
    if (this.interacting) {
      this.presence({
        previews: proposed
          .filter(
            (n) => n.selected || !equal(old.get(n.id)?.position, n.position),
          )
          .slice(0, 100)
          .map((n) => ({
            id: n.id,
            position: n.position,
            ...(n.width ? { width: n.width } : {}),
            ...(n.height ? { height: n.height } : {}),
          })),
      });
      this.invalidate();
      return;
    }
    const pin = new Set<string>();
    for (const node of proposed)
      if (
        old.has(node.id) &&
        !equal(old.get(node.id)!.position, node.position) &&
        layout.offsets.has(node.id)
      )
        pin.add(layout.offsets.get(node.id).cluster);
    const created = cleanNodes(proposed).filter(
      (n) => !this.doc.getMap("nodes").has(n.id),
    );
    if (created.length)
      patchBoard(
        this.doc,
        { title: raw.title, nodes: [], edges: [] },
        { title: raw.title, nodes: created, edges: [] },
        {
          actor: this.actor,
          session: this.session,
          batch: this.batch,
          nonceForId: (id: string) => this.nonces.get(id),
          inactive: true,
          origin: "intelboard-create",
        },
      );
    this.doc.transact(() => {
      for (const [id, offset] of layout.offsets)
        if (pin.has(offset.cluster)) {
          const entry = this.doc.getMap<any>("nodes").get(id),
            props = entry.get("props");
          const position = props.get("position");
          props.set("position", {
            x: position.x + offset.x,
            y: position.y + offset.y,
          });
          entry.set("positioned", true);
        }
      const before = boardValue(this.doc);
      const next = cleanNodes(proposed).map((node) => {
        const prior = old.get(node.id),
          original: any = authored.get(node.id),
          offset = layout.offsets.get(node.id);
        if (
          prior &&
          equal(prior.position, node.position) &&
          original &&
          !pin.has(offset?.cluster)
        )
          node = { ...node, position: original.position };
        if (prior && original) {
          if (prior.width === node.width)
            node = { ...node, width: original.width };
          if (prior.height === node.height)
            node = { ...node, height: original.height };
          if (equal(prior.style, node.style))
            node = { ...node, style: original.style };
          if (this.presenceValue.resize === node.id && this.locked(node.id))
            node = {
              ...node,
              position: original.position,
              width: original.width,
              height: original.height,
              style: original.style,
            };
        }
        return node;
      });
      patchBoard(
        this.doc,
        before,
        { ...before, nodes: next },
        {
          actor: this.actor,
          session: this.session,
          batch: this.batch,
          nonceForId: (id: string) => this.nonces.get(id),
        },
      );
    }, LOCAL);
    this.presence({
      selection: proposed
        .filter((n) => n.selected)
        .slice(0, 100)
        .map((n) => n.id),
    });
    this.invalidate();
  };
  setEdges = (value: Setter<Connection[]>) => {
    if (this.resetting || this.network?.active === false) return;
    const displayed = this.getSnapshot().edges,
      next = typeof value === "function" ? value(displayed) : value;
    for (const edge of next)
      this.edgeUI.set(edge.id, { selected: edge.selected });
    const before = boardValue(this.doc),
      created = cleanEdges(next).filter(
        (e) => !this.doc.getMap("edges").has(e.id),
      );
    if (created.length)
      patchBoard(
        this.doc,
        { title: before.title, nodes: [], edges: [] },
        { title: before.title, nodes: [], edges: created },
        {
          actor: this.actor,
          session: this.session,
          batch: this.batch,
          nonceForId: (id: string) => this.nonces.get(id),
          inactive: true,
          origin: "intelboard-create",
        },
      );
    patchBoard(
      this.doc,
      before,
      { ...before, edges: cleanEdges(next) },
      {
        actor: this.actor,
        session: this.session,
        batch: this.batch,
        nonceForId: (id: string) => this.nonces.get(id),
      },
    );
    this.invalidate();
  };
  interact = (active: boolean) => {
    if (active === this.interacting) return;
    if (active) {
      this.interacting = true;
      return;
    }
    const proposal = this.getSnapshot().nodes;
    this.interacting = false;
    for (const [id, ui] of this.ui)
      if (ui.preview) {
        const { preview, position, width, height, style, ...rest } = ui;
        this.ui.set(id, rest);
      }
    this.cached = null;
    this.setNodes(proposal);
    this.presence({ previews: [], resize: null });
  };
  binding = (
    id: string,
    field = "text",
    edge = false,
  ): TextBinding | undefined => {
    const key = `${edge ? "edge" : "node"}:${id}:${field}`;
    if (this.bindings.has(key)) return this.bindings.get(key);
    const text = textBinding(this.doc, id, field, edge);
    if (!text) return;
    const origin = {},
      undo = new Y.UndoManager(text, { trackedOrigins: new Set([origin]) });
    const binding: TextBinding = {
      text,
      doc: this.doc,
      origin,
      read: () => textValue(text),
      apply: (next) => {
        if (!this.resetting && this.network?.active !== false)
          this.doc.transact(
            () => editText(text, next.text, next.format),
            origin,
          );
      },
      undo: (redo) => {
        redo ? undo.redo() : undo.undo();
      },
      compose: (active) => {
        this.composing += active ? 1 : -1;
        this.composing = Math.max(0, this.composing);
        if (!this.composing) this.applyIncoming();
      },
    };
    this.bindings.set(key, binding);
    return binding;
  };
  locked = (id: string) => {
    const lock = this.network?.locks?.[id];
    return lock && lock.identity !== this.actor ? (lock.name as string) : null;
  };
  presence(value: any) {
    this.presenceValue = { ...this.presenceValue, ...value };
    if (performance.now() - this.lastPresence > 50) this.sendPresence();
    else if (!this.presenceTimer)
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = undefined;
        this.sendPresence();
      }, 50);
  }
  sendPresence() {
    this.lastPresence = performance.now();
    void collaboration("presence", this.boardId, this.presenceValue).catch(
      () => {},
    );
  }
  dispose() {
    this.disposed = true;
    if (!this.resetting) this.flushSync();
    this.presence({
      cursor: null,
      selection: [],
      resize: null,
      previews: [],
      editing: null,
    });
    clearInterval(this.heartbeat);
    clearTimeout(this.presenceTimer);
    this.unsubscribe();
    this.undoManager.destroy();
    this.doc.destroy();
  }
}

const noopSubscribe = () => () => {};
export function useSharedBoard(board: Board) {
  const ref = useRef<SharedBoardController | null>(null);
  const [controller, setController] = useState<SharedBoardController | null>(
      null,
    ),
    [error, setError] = useState("");
  useEffect(() => {
    if (!board.shared) return;
    let active = true;
    let current: SharedBoardController | null = null;
    const open = async (notice = "", onOpened?: () => void) => {
      const opened = await collaboration("open", board.id);
      if (!active) return;
      const previous = current;
      onOpened?.();
      current = new SharedBoardController(
        { ...board, viewport: previous?.viewport || board.viewport },
        opened,
      );
      current.onReset = open;
      if (notice) current.error = notice;
      ref.current = current;
      setController(current);
      previous?.dispose();
    };
    void open()
      .then(() => {})
      .catch((error) => setError(error.message));
    return () => {
      active = false;
      current?.dispose();
      ref.current = null;
    };
  }, [board.id, board.shared]);
  const snapshot = useSyncExternalStore(
    controller?.subscribe || noopSubscribe,
    controller?.getSnapshot || (() => board),
  );
  useEffect(() => {
    if (!controller) return;
    const exit = (event: BeforeUnloadEvent) => {
      controller.flushSync();
      if (controller.outbox.length || controller.resetting)
        event.preventDefault();
    };
    window.addEventListener("beforeunload", exit);
    return () => window.removeEventListener("beforeunload", exit);
  }, [controller]);
  return {
    ref,
    controller,
    snapshot,
    error,
    ready: !board.shared || !!controller,
  };
}
