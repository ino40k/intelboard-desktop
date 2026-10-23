import { documentFormat } from '../shared/document.js';
import { regionContains } from '../shared/geometry.js';
import { InlineEditor } from './InlineText';
import { ThemeSelect } from './ThemeSelect';
import { themeMode, type ThemeId } from './themes';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  useReactFlow,
  applyNodeChanges,
  applyEdgeChanges,
  SelectionMode,
  ConnectionMode,
  type NodeChange,
  type EdgeChange,
  type Viewport,
  type Connection as FlowConnection,
} from '@xyflow/react';
import {
  MousePointer2,
  Hand,
  StickyNote,
  Link2,
  Upload,
  Waypoints,
  SquareDashed,
  Search,
  ArrowLeft,
  Check,
  CheckCircle2,
  LoaderCircle,
  AlertCircle,
  Undo2,
  Redo2,
  Minus,
  Plus,
  Maximize,
  Map as MapIcon,
  MoreHorizontal,
  Copy,
  Trash2,
  ArrowUpToLine,
  ArrowDownToLine,
  Pencil,
  Download,
  X,
  ExternalLink,
  Group,
  Ungroup,
  Keyboard,
  RefreshCw,
  LogOut,
} from 'lucide-react';
import { Brand, IconButton, Modal } from './App';
import { ItemNode, ResearchEdge, CanvasContext } from './ItemNode';
import { api, transfer } from './api';
import { nodeSchema, edgeSchema } from '../shared/schema.js';
import { videoMime, youtubeVideo } from '../shared/media.js';
import { usePersistence } from './usePersistence';
import {
  makeItem,
  duplicateItems,
  cleanNodes,
  cleanEdges,
  uuid,
  searchable,
  assetUrl,
  downloadUrl,
  type Board,
  type Item,
  type ItemData,
  type Connection,
  type Kind,
  type Asset,
} from './model';
const nodeTypes = { research: ItemNode },
  edgeTypes = { research: ResearchEdge };
const emptySnapshot = { nodes: [] as Item[], edges: [] as Connection[] };
const isInput = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'input,textarea,select,[contenteditable="true"],dialog,[data-player-surface],video,iframe',
  );
export default function Canvas({
  board,
  theme,
  setTheme,
  onBack,
  maxUploadMB,
}: {
  board: Board;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  onBack: () => Promise<void>;
  maxUploadMB: number;
}) {
  const [nodes, setNodes] = useState<Item[]>(board.nodes),
    [edges, setEdges] = useState<Connection[]>(board.edges),
    [viewport, setViewport] = useState<Viewport>(board.viewport),
    [title, setTitle] = useState(board.title),
    [editing, setEditing] = useState<string | null>(null),
    [tool, setTool] = useState('select'),
    [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [linkOpen, setLinkOpen] = useState(false),
    [linkInput, setLinkInput] = useState(''),
    [inspector, setInspector] = useState<string | null>(null),
    [viewer, setViewer] = useState<string | null>(null),
    [edgeEdit, setEdgeEdit] = useState<string | null>(null),
    [help, setHelp] = useState(false),
    [menu, setMenu] = useState(false),
    [minimap, setMinimap] = useState(false),
    [notice, setNotice] = useState(''),
    [historyVersion, setHistoryVersion] = useState(0),
    [dropActive, setDropActive] = useState(false),
    [space, setSpace] = useState(false),
    [manipulating, setManipulating] = useState(false);
  const flow = useReactFlow<Item, Connection>(),
    fileInput = useRef<HTMLInputElement>(null),
    pointer = useRef<{ x: number; y: number } | null>(null),
    state = useRef({ nodes, edges }),
    past = useRef<(typeof emptySnapshot)[]>([]),
    future = useRef<(typeof emptySnapshot)[]>([]),
    clipboard = useRef<typeof emptySnapshot | null>(null),
    drag = useRef<{ start: { x: number; y: number }; followers: Item[] } | null>(null),
    titleFocus = useRef(title);
  state.current = { nodes, edges };
  const { status, error, save, hasUnsaved } = usePersistence(
    board,
    nodes,
    edges,
    viewport,
    title,
    () => {},
  );
  const checkpoint = useCallback(() => {
    past.current.push({
      nodes: cleanNodes(state.current.nodes),
      edges: cleanEdges(state.current.edges),
    });
    if (past.current.length > 100) past.current.shift();
    future.current = [];
    setHistoryVersion((v) => v + 1);
  }, []);
  const undo = useCallback(() => {
    const snapshot = past.current.pop();
    if (!snapshot) return;
    future.current.push({
      nodes: cleanNodes(state.current.nodes),
      edges: cleanEdges(state.current.edges),
    });
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEditing(null);
    setHistoryVersion((v) => v + 1);
  }, []);
  const redo = useCallback(() => {
    const snapshot = future.current.pop();
    if (!snapshot) return;
    past.current.push({
      nodes: cleanNodes(state.current.nodes),
      edges: cleanEdges(state.current.edges),
    });
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setEditing(null);
    setHistoryVersion((v) => v + 1);
  }, []);
  const update = useCallback(
    (id: string, data: Partial<ItemData>) =>
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id
            ? { ...n, data: { ...n.data, ...data, updatedAt: new Date().toISOString() } }
            : n,
        ),
      ),
    [],
  );
  const beginEdit = useCallback(
    (id: string | null) => {
      if (id) checkpoint();
      setEditing(id);
    },
    [checkpoint],
  );
  const notify = useCallback((message: string) => setNotice(message), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(t);
  }, [notice]);
  const point = useCallback(
    (atPointer = false) =>
      flow.screenToFlowPosition(
        atPointer && pointer.current
          ? pointer.current
          : { x: innerWidth / 2 - 100, y: innerHeight / 2 - 80 },
      ),
    [flow],
  );
  const add = useCallback(
    (kind: Kind, data: Partial<ItemData> = {}, at?: { x: number; y: number }) => {
      checkpoint();
      const n = { ...makeItem(kind, at || point(), data), selected: true };
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), n]);
      if (kind === 'note' || kind === 'region') setEditing(n.id);
      setTool('select');
      return n.id;
    },
    [checkpoint, point],
  );
  const capture = useCallback(
    async (id: string, url: string) => {
      update(id, { loading: true });
      try {
        const metadata = await api<Partial<ItemData>>('/metadata', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        setNodes((ns) =>
          ns.map((n) =>
            n.id === id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    ...metadata,
                    formats: {
                      ...n.data.formats,
                      description:
                        metadata.description === n.data.description
                          ? n.data.formats?.description
                          : undefined,
                      title:
                        (n.data.title && n.data.title !== n.data.domain) ||
                        metadata.title === n.data.title
                          ? n.data.formats?.title
                          : undefined,
                    },
                    title:
                      n.data.title && n.data.title !== n.data.domain
                        ? n.data.title
                        : metadata.title,
                    loading: false,
                  },
                }
              : n,
          ),
        );
        if (metadata.captureStatus !== 'captured')
          notify('Link saved. ' + (metadata.captureStatus || 'Preview unavailable.'));
      } catch (e) {
        update(id, { loading: false, captureStatus: (e as Error).message });
        notify('Link saved. Source preview could not be captured.');
      }
    },
    [update, notify],
  );
  const addLink = useCallback(
    (raw: string, at?: { x: number; y: number }) => {
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        notify('Enter a valid HTTP or HTTPS URL.');
        return;
      }
      const id = add(
        'link',
        { url: url.href, domain: url.hostname, title: url.hostname, loading: true },
        at,
      );
      void capture(id, url.href);
      setLinkInput('');
      setLinkOpen(false);
    },
    [add, capture, notify],
  );
  const uploadFiles = useCallback(
    async (files: File[], at: { x: number; y: number }) => {
      if (!files.length) return;
      checkpoint();
      const documentBatch = files.some((file) => documentFormat(file.name, file.type));
      const videoBatch = files.some((file) => videoMime(file.name, file.type));
      const queued = files
        .filter((file) => {
          if (file.size > maxUploadMB * 1048576) {
            notify(`${file.name} exceeds the ${maxUploadMB} MB file limit.`);
            return false;
          }
          return true;
        })
        .map((file, i) => {
          const isImage = /^image\/(png|jpeg|webp|gif|avif)$/.test(file.type);
          const localUrl =
            isImage || videoMime(file.name, file.type) ? URL.createObjectURL(file) : undefined;
          const n = makeItem(
            isImage ? 'image' : 'file',
            {
              x: at.x + (i % 3) * (documentBatch ? 510 : videoBatch ? 450 : 350),
              y: at.y + Math.floor(i / 3) * (documentBatch ? 590 : videoBatch ? 330 : 290),
            },
            { filename: file.name, size: file.size, mime: file.type, loading: true, localUrl },
          );
          return { file, n };
        });
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        ...queued.map((q) => ({ ...q.n, selected: true })),
      ]);
      for (const { file, n } of queued) {
        try {
          const form = new FormData();
          form.append('file', file);
          const a = await api<Asset>('/assets', { method: 'POST', body: form });
          setNodes((ns) =>
            ns.map((item) =>
              item.id === n.id
                ? {
                    ...item,
                    style: a.thumbnail
                      ? {
                          width: 320,
                          height:
                            Math.max(
                              120,
                              Math.round((320 * (a.height || 240)) / (a.width || 320)),
                            ) + 34,
                        }
                      : item.style,
                    data: {
                      ...item.data,
                      kind: a.thumbnail ? 'image' : 'file',
                      assetId: a.id,
                      mime: a.mime,
                      filename: a.filename,
                      size: a.size,
                      originalWidth: a.width ?? undefined,
                      originalHeight: a.height ?? undefined,
                      preview: a.preview ?? undefined,
                      loading: false,
                      localUrl: undefined,
                    },
                  }
                : item,
            ),
          );
          if (n.data.localUrl) URL.revokeObjectURL(n.data.localUrl);
        } catch (e) {
          update(n.id, {
            loading: false,
            uploadError: 'Upload failed. Drop the file again to retry.',
          });
          notify((e as Error).message);
        }
      }
    },
    [checkpoint, maxUploadMB, notify, update],
  );
  const remove = useCallback(() => {
    checkpoint();
    const ids = new Set(state.current.nodes.filter((n) => n.selected).map((n) => n.id));
    setNodes((ns) => ns.filter((n) => !ids.has(n.id)));
    setEdges((es) => es.filter((e) => !e.selected && !ids.has(e.source) && !ids.has(e.target)));
    setInspector(null);
    setEditing(null);
  }, [checkpoint]);
  const duplicate = useCallback(() => {
    if (state.current.nodes.some((n) => n.selected && n.data.loading)) {
      notify('Wait for the selected capture to finish before duplicating it.');
      return;
    }
    checkpoint();
    const copied = duplicateItems(state.current.nodes, state.current.edges);
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...copied.nodes]);
    setEdges((es) => [...es, ...copied.edges]);
  }, [checkpoint]);
  const grouping = useCallback(
    (ungroup = false) => {
      checkpoint();
      const groupId = ungroup ? undefined : uuid();
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, data: { ...n.data, groupId } } : n)));
    },
    [checkpoint],
  );
  const connect = useCallback(
    (connection: FlowConnection) => {
      if (connection.source === connection.target) return;
      checkpoint();
      setEdges((es) => [
        ...es,
        { ...connection, id: uuid(), type: 'research', data: { directed: true } },
      ]);
      connectionStart.current = null;
      setTool('select');
    },
    [checkpoint],
  );
  const connectionStart = useRef<string | null>(null);
  const changes = useCallback(
    (changes: NodeChange<Item>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [],
  );
  const edgeChanges = useCallback(
    (changes: EdgeChange<Connection>[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const selected = nodes.filter((n) => n.selected),
    selectedEdges = edges.filter((e) => e.selected),
    single = selected.length === 1 ? selected[0] : null;
  const view = useCallback((id: string) => setViewer(id), []),
    editEdge = useCallback(
      (id: string) => {
        checkpoint();
        setEdgeEdit(id);
      },
      [checkpoint],
    );
  const context = useMemo(
    () => ({
      editing,
      edit: beginEdit,
      update,
      checkpoint,
      manipulate: setManipulating,
      view,
      query,
      connectMode: tool === 'connect',
      editEdge,
    }),
    [editing, beginEdit, update, checkpoint, view, query, tool, editEdge],
  );
  const matching = useMemo(
    () => (query ? nodes.filter((n) => searchable(n).includes(query.toLowerCase())) : []),
    [nodes, query],
  );
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        className: query
          ? searchable(n).includes(query.toLowerCase())
            ? 'search-match'
            : 'search-dim'
          : '',
      })),
    [nodes, query],
  );
  const jump = (n: Item) => {
    void flow.setCenter(
      n.position.x + Number(n.style?.width || 280) / 2,
      n.position.y + Number(n.style?.height || 220) / 2,
      { zoom: 1, duration: 350 },
    );
    setNodes((ns) => ns.map((item) => ({ ...item, selected: item.id === n.id })));
  };
  const fit = useCallback(
    () => void flow.fitView({ padding: 0.18, duration: 350, maxZoom: 1, minZoom: 0.05 }),
    [flow],
  );
  useEffect(() => {
    function paste(e: ClipboardEvent) {
      if (isInput(e.target)) return;
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        void uploadFiles(files, point(true));
        return;
      }
      const raw = e.clipboardData?.getData('text/plain') || '';
      if (!raw) return;
      e.preventDefault();
      if (raw.startsWith('intelboard:')) {
        try {
          const parsed = JSON.parse(raw.slice(11));
          if (!Array.isArray(parsed.nodes) || parsed.nodes.length > 1000) throw 0;
          const safeNodes = parsed.nodes.map((n: unknown) => ({
            ...nodeSchema.parse(n),
            selected: true,
          })) as Item[];
          const safeEdges = (parsed.edges || []).map((e: unknown) =>
            edgeSchema.parse(e),
          ) as Connection[];
          const nodeIds = new Set(safeNodes.map((n) => n.id));
          if (safeEdges.some((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target))) throw 0;
          const copied = duplicateItems(safeNodes, safeEdges);
          const origin = point(true),
            minX = Math.min(...copied.nodes.map((n) => n.position.x)),
            minY = Math.min(...copied.nodes.map((n) => n.position.y));
          checkpoint();
          setNodes((ns) => [
            ...ns.map((n) => ({ ...n, selected: false })),
            ...copied.nodes.map((n) => ({
              ...n,
              position: { x: n.position.x - minX + origin.x, y: n.position.y - minY + origin.y },
            })),
          ]);
          setEdges((es) => [...es, ...copied.edges]);
          return;
        } catch {
          notify('The copied board elements could not be read.');
          return;
        }
      }
      if (/^https?:\/\/\S+$/i.test(raw.trim())) addLink(raw.trim(), point(true));
      else add('note', { text: raw }, point(true));
    }
    function copy(e: ClipboardEvent) {
      if (isInput(e.target)) return;
      const ns = state.current.nodes.filter((n) => n.selected);
      if (!ns.length) return;
      if (ns.some((n) => n.data.loading)) {
        e.preventDefault();
        notify('Wait for the selected capture to finish before copying it.');
        return;
      }
      const ids = new Set(ns.map((n) => n.id));
      clipboard.current = {
        nodes: cleanNodes(ns),
        edges: cleanEdges(
          state.current.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
        ),
      };
      e.preventDefault();
      e.clipboardData?.setData('text/plain', 'intelboard:' + JSON.stringify(clipboard.current));
      notify(`${ns.length} ${ns.length === 1 ? 'item' : 'items'} copied`);
    }
    function key(e: KeyboardEvent) {
      if (isInput(e.target)) return;
      const command = e.metaKey || e.ctrlKey,
        key = e.key.toLowerCase();
      if (command && key === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (command && key === 'y') {
        e.preventDefault();
        redo();
      } else if (command && key === 'a') {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (command && key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (command && key === 'g') {
        e.preventDefault();
        grouping(e.shiftKey);
      } else if (command && key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        remove();
      } else if (key === 'escape') {
        setEditing(null);
        setInspector(null);
        setSearchOpen(false);
        setQuery('');
        setLinkOpen(false);
        setMenu(false);
        setTool('select');
        connectionStart.current = null;
        setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
        setEdges((es) => es.map((e) => ({ ...e, selected: false })));
      } else if (!command && !e.altKey) {
        if (key === 'n') {
          e.preventDefault();
          add('note', {}, point(true));
        }
        if (key === 'l') setLinkOpen((v) => !v);
        if (key === 'r') add('region', { title: 'Untitled region' }, point(true));
        if (key === 'v') setTool('select');
        if (key === 'h') setTool('hand');
        if (key === 'c') setTool('connect');
        if (key === 'f') fit();
        if (key === '?') setHelp(true);
        if (key === ' ') {
          e.preventDefault();
          setSpace(true);
        }
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpace(false);
    };
    const blur = () => setSpace(false);
    document.addEventListener('paste', paste);
    document.addEventListener('copy', copy);
    document.addEventListener('keydown', key);
    document.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('paste', paste);
      document.removeEventListener('copy', copy);
      document.removeEventListener('keydown', key);
      document.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [
    add,
    addLink,
    uploadFiles,
    point,
    checkpoint,
    duplicate,
    fit,
    grouping,
    notify,
    redo,
    remove,
    undo,
  ]);
  const closeViewer = useCallback(() => setViewer(null), []),
    closeHelp = useCallback(() => setHelp(false), []),
    closeEdge = useCallback(() => setEdgeEdit(null), []);
  const currentInspector = nodes.find((n) => n.id === inspector),
    currentViewer = nodes.find((n) => n.id === viewer),
    currentEdge = edges.find((e) => e.id === edgeEdit);
  const contextX = single
    ? Math.max(86, Math.min(innerWidth - 430, single.position.x * viewport.zoom + viewport.x))
    : innerWidth / 2 - 180;
  const contextY = single
    ? Math.max(80, Math.min(innerHeight - 110, single.position.y * viewport.zoom + viewport.y + 12))
    : innerHeight - 126;
  async function back() {
    await save();
    if (hasUnsaved()) {
      notify(
        'Wait for source captures, uploads, and pending saves to finish before leaving this board.',
      );
      return;
    }
    await onBack();
  }
  return (
    <CanvasContext.Provider value={context}>
      <main
        className={`workspace ${tool === 'connect' ? 'connecting' : ''} ${manipulating ? 'canvas-manipulating' : ''}`}
      >
        <header className="canvas-header">
          <div className="header-left">
            <IconButton label="All boards" onClick={() => void back()}>
              <ArrowLeft size={18} />
            </IconButton>
            <button className="brand-button" onClick={() => void back()}>
              <Brand />
            </button>
            <span className="header-divider" />
            <input
              className="board-name"
              aria-label="Board title"
              value={title}
              onFocus={() => {
                titleFocus.current = title;
              }}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (!title.trim()) setTitle(titleFocus.current || 'Untitled board');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </div>
          <div className="header-right">
            <button className="secondary-button" onClick={async () => {
              await save();
              if (hasUnsaved()) { notify('Wait for pending saves and file imports before exporting.'); return; }
              try { await transfer('export-board', board.id); } catch(e) { notify((e as Error).message); }
            }}>Export board…</button>
            <div
              className={`save-status ${status === 'error' ? 'error' : ''}`}
              title={error || 'Changes save automatically'}
              role="status"
            >
              {status === 'saved' ? (
                <CheckCircle2 size={15} />
              ) : status === 'error' ? (
                <AlertCircle size={15} />
              ) : (
                <LoaderCircle size={14} className="spin" />
              )}
              <span>
                {status === 'saved'
                  ? 'All changes saved'
                  : status === 'error'
                    ? 'Not saved'
                    : status === 'saving'
                      ? 'Saving…'
                      : 'Saving…'}
              </span>
            </div>
            <span className="header-divider" />
            <IconButton
              label="Search board (Ctrl+F)"
              onClick={() => setSearchOpen((v) => !v)}
              active={searchOpen}
            >
              <Search size={18} />
            </IconButton>
            <IconButton label="Board menu" onClick={() => setMenu((v) => !v)} active={menu}>
              <MoreHorizontal size={20} />
            </IconButton>
          </div>
        </header>
        {error && (
          <div className="save-warning" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
            <button onClick={() => void save()}>Retry save</button>
          </div>
        )}
        <div
          className="canvas"
          data-testid="canvas"
          onDoubleClick={(e) => {
            if (
              (e.target as HTMLElement).classList.contains('react-flow__pane') &&
              tool === 'select'
            )
              add('note', {}, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
          }}
          onMouseMove={(e) => {
            if (!(e.target as HTMLElement).closest('.react-flow__panel'))
              pointer.current = { x: e.clientX, y: e.clientY };
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropActive(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDropActive(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length)
              void uploadFiles(files, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
            else {
              const text =
                e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
              if (text) addLink(text, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
            }
          }}
        >
          <ReactFlow<Item, Connection>
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={changes}
            onEdgesChange={edgeChanges}
            onConnect={connect}
            defaultViewport={board.viewport}
            onMove={(_e, v) => setViewport(v)}
            onMoveStart={() => setManipulating(true)}
            onMoveEnd={() => setManipulating(false)}
            minZoom={0.05}
            maxZoom={4}
            selectionOnDrag={tool === 'select' && !space}
            selectionMode={SelectionMode.Partial}
            onSelectionStart={() => setManipulating(true)}
            onSelectionEnd={() => setManipulating(false)}
            panOnDrag={tool === 'hand' || space ? true : [1, 2]}
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            panActivationKeyCode="Space"
            zoomActivationKeyCode={['Control', 'Meta']}
            multiSelectionKeyCode="Shift"
            selectionKeyCode="Shift"
            deleteKeyCode={null}
            connectionMode={ConnectionMode.Loose}
            onlyRenderVisibleElements
            elevateNodesOnSelect={false}
            colorMode={themeMode(theme)}
            onNodeDragStart={(_e, n, selection) => {
              setManipulating(true);
              checkpoint();
              const selectedIds = new Set(selection.map((n) => n.id));
              const followers = state.current.nodes.filter(
                (other) =>
                  other.id !== n.id &&
                  !selectedIds.has(other.id) &&
                  ((n.data.groupId && other.data.groupId === n.data.groupId) ||
                    (n.data.kind === 'region' && regionContains(n, other))),
              );
              drag.current = { start: n.position, followers };
            }}
            onNodeDrag={(_e, n) => {
              if (!drag.current) return;
              const { start, followers } = drag.current;
              const map = new Map(followers.map((item) => [item.id, item]));
              setNodes((ns) =>
                ns.map((item) => {
                  const original = map.get(item.id);
                  return original
                    ? {
                        ...item,
                        position: {
                          x: original.position.x + n.position.x - start.x,
                          y: original.position.y + n.position.y - start.y,
                        },
                      }
                    : item;
                }),
              );
            }}
            onNodeDragStop={() => {
              drag.current = null;
              setManipulating(false);
            }}
            onSelectionDragStart={() => {
              checkpoint();
              setManipulating(true);
            }}
            onSelectionDragStop={() => setManipulating(false)}
            onNodeClick={(event, n) => {
              // React Flow owns handle clicks and preserves their source/target IDs.
              // Do not also create a second edge with the element-click defaults.
              if ((event.target as Element).closest('.react-flow__handle')) return;
              if (tool === 'connect') {
                if (connectionStart.current && connectionStart.current !== n.id) {
                  connect({
                    source: connectionStart.current,
                    target: n.id,
                    sourceHandle: 'out',
                    targetHandle: 'in',
                  });
                  connectionStart.current = null;
                } else {
                  connectionStart.current = n.id;
                  notify('Choose another item to connect.');
                }
              }
            }}
            onNodeDoubleClick={(_e, n) => {
              if (n.data.kind === 'note' || n.data.kind === 'region') beginEdit(n.id);
              else if (n.data.kind === 'image') setViewer(n.id);
              else if (n.data.kind === 'link' && n.data.url)
                window.open(n.data.url, '_blank', 'noopener,noreferrer');
              else {
                checkpoint();
                setInspector(n.id);
              }
            }}
            onEdgeDoubleClick={(_e, edge) => editEdge(edge.id)}
            onPaneClick={() => {
              setEditing(null);
              setInspector(null);
              setMenu(false);
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid)" />
            {minimap && (
              <MiniMap
                position="bottom-right"
                pannable
                zoomable
                nodeColor={(n) =>
                  n.data.kind === 'region'
                    ? 'var(--minimap-region)'
                    : n.data.kind === 'note'
                      ? 'var(--minimap-note)'
                      : 'var(--minimap-item)'
                }
                maskColor="var(--minimap-mask)"
                style={{ background: 'var(--surface)' }}
              />
            )}
            <svg>
              <defs>
                <marker
                  id="arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10"
                    fill="none"
                    stroke="var(--wire)"
                    strokeWidth="1.5"
                  />
                </marker>
              </defs>
            </svg>
          </ReactFlow>
          {!nodes.length && (
            <div className="empty-canvas">
              <div className="empty-mark">
                <SquareDashed size={34} strokeWidth={1} />
                <span />
              </div>
              <div className="eyebrow">A NEW INVESTIGATION</div>
              <h1>
                Start with a source.
                <br />
                See where it leads.
              </h1>
              <p>Paste a link, drop a file, or put a thought on the board.</p>
              <div className="empty-actions">
                <button onClick={() => add('note')}>
                  <StickyNote size={17} />
                  Write a note<kbd>N</kbd>
                </button>
                <button onClick={() => setLinkOpen(true)}>
                  <Link2 size={17} />
                  Add a source<kbd>L</kbd>
                </button>
              </div>
              <span className="empty-hint">Your work saves as you go.</span>
            </div>
          )}
          {dropActive && (
            <div className="drop-overlay">
              <Upload size={36} />
              <h2>Drop it into your investigation</h2>
              <p>Images, documents, and files · up to {maxUploadMB} MB each</p>
            </div>
          )}
        </div>
        <nav className="tool-dock" aria-label="Canvas tools">
          <IconButton
            label="Select (V)"
            onClick={() => setTool('select')}
            active={tool === 'select'}
          >
            <MousePointer2 size={19} />
          </IconButton>
          <IconButton
            label="Pan (H or hold Space)"
            onClick={() => setTool('hand')}
            active={tool === 'hand'}
          >
            <Hand size={19} />
          </IconButton>
          <div className="dock-divider" />
          <IconButton label="Add note (N)" onClick={() => add('note')}>
            <StickyNote size={19} />
          </IconButton>
          <IconButton label="Add link (L)" onClick={() => setLinkOpen((v) => !v)} active={linkOpen}>
            <Link2 size={19} />
          </IconButton>
          <IconButton label="Upload image or file" onClick={() => fileInput.current?.click()}>
            <Upload size={19} />
          </IconButton>
          <IconButton
            label="Connect items (C)"
            onClick={() => {
              setTool(tool === 'connect' ? 'select' : 'connect');
              connectionStart.current = null;
            }}
            active={tool === 'connect'}
          >
            <Waypoints size={19} />
          </IconButton>
          <IconButton
            label="Add region (R)"
            onClick={() => add('region', { title: 'Untitled region' })}
          >
            <SquareDashed size={19} />
          </IconButton>
          <div className="dock-divider" />
          <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!past.current.length}>
            <Undo2 size={18} />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!future.current.length}>
            <Redo2 size={18} />
          </IconButton>
        </nav>
        <input
          hidden
          ref={fileInput}
          type="file"
          multiple
          onChange={(e) => {
            void uploadFiles(Array.from(e.target.files || []), point());
            e.target.value = '';
          }}
        />
        {linkOpen && (
          <form
            className="link-popover"
            onSubmit={(e) => {
              e.preventDefault();
              addLink(linkInput);
            }}
          >
            <Link2 size={17} />
            <input
              autoFocus
              aria-label="Source URL"
              placeholder="Paste a source URL…"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              required
            />
            <button className="confirm-link" title="Add source" aria-label="Add source">
              <Check size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Close link input"
              onClick={() => setLinkOpen(false)}
            >
              <X size={15} />
            </button>
          </form>
        )}
        {(selected.length > 0 || selectedEdges.length > 0) && !editing && !inspector && (
          <div className="context-toolbar" style={{ left: contextX, top: contextY }}>
            <span className="selection-count">
              {selected.length > 1
                ? `${selected.length} items`
                : single
                  ? single.data.kind
                  : selectedEdges.length + ' connections'}
            </span>
            <span className="toolbar-divider" />
            {single && (
              <IconButton
                label="Edit selected item"
                onClick={() => {
                  if (single.data.kind === 'note' || single.data.kind === 'region')
                    beginEdit(single.id);
                  else {
                    checkpoint();
                    setInspector(single.id);
                  }
                }}
              >
                <Pencil size={15} />
              </IconButton>
            )}
            {selected.length > 0 && (
              <>
                <IconButton label="Duplicate selection (Ctrl+D)" onClick={duplicate}>
                  <Copy size={15} />
                </IconButton>
                <IconButton
                  label="Bring forward"
                  onClick={() => {
                    checkpoint();
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.selected
                          ? {
                              ...n,
                              zIndex: Math.min(
                                9999,
                                Math.max(0, ...ns.map((n) => n.zIndex || 0)) + 1,
                              ),
                            }
                          : n,
                      ),
                    );
                  }}
                >
                  <ArrowUpToLine size={16} />
                </IconButton>
                <IconButton
                  label="Send backward"
                  onClick={() => {
                    checkpoint();
                    setNodes((ns) =>
                      ns.map((n) =>
                        n.selected
                          ? {
                              ...n,
                              zIndex: Math.max(
                                -9999,
                                Math.min(
                                  0,
                                  ...ns
                                    .filter((n) => n.data.kind !== 'region')
                                    .map((n) => n.zIndex || 0),
                                ) - 1,
                              ),
                            }
                          : n,
                      ),
                    );
                  }}
                >
                  <ArrowDownToLine size={16} />
                </IconButton>
                {selected.length > 1 && (
                  <IconButton label="Group selection (Ctrl+G)" onClick={() => grouping()}>
                    <Group size={16} />
                  </IconButton>
                )}
                {selected.some((n) => n.data.groupId) && (
                  <IconButton label="Ungroup (Ctrl+Shift+G)" onClick={() => grouping(true)}>
                    <Ungroup size={16} />
                  </IconButton>
                )}
                {single?.data.assetId && (
                  <a
                    className="icon-button"
                    aria-label="Download original"
                    title="Download original"
                    href={downloadUrl(single.data.assetId)}
                  >
                    <Download size={15} />
                  </a>
                )}
                {(single?.data.kind === 'note' || single?.data.kind === 'region') && (
                  <div className="color-options">
                    {['neutral', 'amber', 'blue', 'green', 'rose'].map((color) => (
                      <button
                        key={color}
                        className={`color-dot color-${color} ${single.data.color === color ? 'chosen' : ''}`}
                        aria-label={`${color} color`}
                        title={color}
                        onClick={() => {
                          checkpoint();
                          update(single.id, { color });
                        }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
            {selectedEdges.length === 1 && !selected.length && (
              <IconButton label="Edit connection" onClick={() => editEdge(selectedEdges[0].id)}>
                <Pencil size={16} />
              </IconButton>
            )}
            <span className="toolbar-divider" />
            <IconButton label="Delete selection" onClick={remove}>
              <Trash2 size={15} />
            </IconButton>
          </div>
        )}
        {searchOpen && (
          <aside className="search-panel">
            <div className="search-input">
              <Search size={17} />
              <input
                aria-label="Search this board"
                autoFocus
                placeholder="Search this board…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <IconButton
                label="Close search"
                onClick={() => {
                  setSearchOpen(false);
                  setQuery('');
                }}
              >
                <X size={16} />
              </IconButton>
            </div>
            <div className="search-summary">
              {query
                ? `${matching.length} ${matching.length === 1 ? 'MATCH' : 'MATCHES'}`
                : 'SEARCH SOURCES, NOTES, AND FILES'}
            </div>
            {matching.map((n) => (
              <button className="search-result" key={n.id} onClick={() => jump(n)}>
                <span>{n.data.kind}</span>
                <strong>
                  {n.data.title ||
                    n.data.text?.slice(0, 100) ||
                    n.data.filename ||
                    n.data.caption ||
                    'Untitled'}
                </strong>
                <small>
                  {n.data.domain || n.data.caption || n.data.description?.slice(0, 100)}
                </small>
              </button>
            ))}
            {query && !matching.length && <p className="no-results">No items match “{query}”.</p>}
          </aside>
        )}
        {currentInspector && (
          <aside className="inspector">
            <div className="inspector-heading">
              <span>EDIT {currentInspector.data.kind.toUpperCase()}</span>
              <IconButton label="Close item editor" onClick={() => setInspector(null)}>
                <X size={17} />
              </IconButton>
            </div>
            {currentInspector.data.kind === 'link' ? (
              <>
                {!youtubeVideo(currentInspector.data.url) && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={!currentInspector.data.hidePreview}
                      onChange={(event) => {
                        checkpoint();
                        update(currentInspector.id, { hidePreview: !event.target.checked });
                      }}
                    />
                    Show preview image
                  </label>
                )}
                <label>
                  Visible title
                  <InlineEditor
                    key={currentInspector.id + '-title'}
                    onDone={() => setInspector(null)}
                    label="Visible title"
                    multiline={false}
                    maxLength={4000}
                    value={currentInspector.data.title}
                    format={currentInspector.data.formats?.title}
                    onChange={(title, format) =>
                      update(currentInspector.id, {
                        title,
                        formats: { ...currentInspector.data.formats, title: format },
                      })
                    }
                  />
                </label>
                <label>
                  Description
                  <InlineEditor
                    key={currentInspector.id + '-description'}
                    onDone={() => setInspector(null)}
                    label="Description"
                    value={currentInspector.data.description}
                    format={currentInspector.data.formats?.description}
                    onChange={(description, format) =>
                      update(currentInspector.id, {
                        description,
                        formats: { ...currentInspector.data.formats, description: format },
                      })
                    }
                  />
                </label>
                <label>
                  Original URL
                  <a
                    className="original-url"
                    href={currentInspector.data.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {currentInspector.data.url}
                    <ExternalLink size={14} />
                  </a>
                </label>
                <div className="capture-details">
                  <span>CAPTURED SOURCE</span>
                  <p>{currentInspector.data.capturedTitle || 'No source metadata available'}</p>
                  <small>
                    {currentInspector.data.capturedAt
                      ? new Date(currentInspector.data.capturedAt).toLocaleString()
                      : ''}
                  </small>
                  <p>
                    {currentInspector.data.captureStatus === 'captured'
                      ? 'Metadata preserved on this computer.'
                      : currentInspector.data.captureStatus}
                  </p>
                </div>
                <button
                  className="secondary-button"
                  disabled={currentInspector.data.loading}
                  onClick={() => void capture(currentInspector.id, currentInspector.data.url!)}
                >
                  <RefreshCw size={15} />
                  Refresh metadata
                </button>
              </>
            ) : (
              <>
                <label>
                  Original filename
                  <input readOnly value={currentInspector.data.filename || ''} />
                </label>
                <label>
                  Notes / caption (optional)
                  <InlineEditor
                    key={currentInspector.id + '-caption'}
                    onDone={() => setInspector(null)}
                    autoFocus
                    label="Notes / caption (optional)"
                    value={currentInspector.data.caption}
                    format={currentInspector.data.formats?.caption}
                    placeholder="Where did this come from? What matters here?"
                    onChange={(caption, format) =>
                      update(currentInspector.id, {
                        caption,
                        formats: { ...currentInspector.data.formats, caption: format },
                      })
                    }
                  />
                </label>
                {currentInspector.data.assetId && (
                  <a className="secondary-button" href={downloadUrl(currentInspector.data.assetId)}>
                    <Download size={16} />
                    Download original
                  </a>
                )}
              </>
            )}
          </aside>
        )}
        {menu && (
          <div className="board-menu">
            <ThemeSelect value={theme} onChange={setTheme} />
            <button
              onClick={() => {
                setMinimap((v) => !v);
                setMenu(false);
              }}
            >
              <MapIcon size={17} />
              {minimap ? 'Hide' : 'Show'} minimap
            </button>
            <button
              onClick={() => {
                setHelp(true);
                setMenu(false);
              }}
            >
              <Keyboard size={17} />
              Keyboard shortcuts
            </button>

          </div>
        )}
        <div className="canvas-footer">
          <div className="board-stats">
            <span className="status-dot" />
            {nodes.length} {nodes.length === 1 ? 'item' : 'items'}
            <span className="stat-divider">/</span>
            {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
          </div>
          <span className="canvas-hint">
            {tool === 'connect'
              ? 'Click two items to connect · or drag a connector'
              : space || tool === 'hand'
                ? 'Drag to pan'
                : 'Space + drag to pan · Ctrl + scroll to zoom'}
          </span>
          <div className="zoom-controls">
            <IconButton label="Zoom out" onClick={() => void flow.zoomOut({ duration: 180 })}>
              <Minus size={16} />
            </IconButton>
            <button
              className="zoom-value"
              title="Reset zoom to 100%"
              onClick={() => void flow.zoomTo(1, { duration: 200 })}
            >
              {Math.round(viewport.zoom * 100)}%
            </button>
            <IconButton label="Zoom in" onClick={() => void flow.zoomIn({ duration: 180 })}>
              <Plus size={16} />
            </IconButton>
            <span className="toolbar-divider" />
            <IconButton label="Fit all content (F)" onClick={fit}>
              <Maximize size={17} />
            </IconButton>
          </div>
        </div>
        {notice && (
          <div className="toast" role="status">
            {notice}
            <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}
        {currentViewer && (
          <Modal
            title={currentViewer.data.caption || currentViewer.data.filename || 'Image'}
            onClose={closeViewer}
          >
            <div className="image-viewer">
              <img
                src={
                  currentViewer.data.assetId
                    ? assetUrl(currentViewer.data.assetId, false)
                    : currentViewer.data.localUrl
                }
                alt={currentViewer.data.caption || currentViewer.data.filename || 'Research image'}
              />
            </div>
            {currentViewer.data.assetId && (
              <a className="secondary-button" href={downloadUrl(currentViewer.data.assetId)}>
                <Download size={16} />
                Download original
              </a>
            )}
          </Modal>
        )}
        {currentEdge && (
          <Modal title="Connection" onClose={closeEdge}>
            <label>
              Relationship label
              <InlineEditor
                key={currentEdge.id}
                autoFocus
                label="Relationship label"
                multiline={false}
                placeholder="e.g. supports, contradicts, source for…"
                maxLength={1000}
                value={String(currentEdge.label || '')}
                format={currentEdge.data?.labelFormat}
                onChange={(label, labelFormat) =>
                  setEdges((es) =>
                    es.map((edge) =>
                      edge.id === currentEdge.id
                        ? { ...edge, label, data: { ...edge.data, labelFormat } }
                        : edge,
                    ),
                  )
                }
                onDone={() => setEdgeEdit(null)}
              />
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={!!currentEdge.data?.directed}
                onChange={(e) =>
                  setEdges((es) =>
                    es.map((edge) =>
                      edge.id === currentEdge.id
                        ? { ...edge, data: { ...edge.data, directed: e.target.checked } }
                        : edge,
                    ),
                  )
                }
              />
              Show direction arrow
            </label>
            <div className="dialog-actions">
              <button className="primary-button" onClick={() => setEdgeEdit(null)}>
                Done
              </button>
            </div>
          </Modal>
        )}
        {help && (
          <Modal title="Keep your train of thought." onClose={closeHelp}>
            <div className="shortcut-list">
              {[
                ['New note', 'N / double-click canvas'],
                ['Add a source', 'L / paste URL'],
                ['Upload an image', 'Paste / drop a file'],
                ['Select / pan', 'V / H'],
                ['Pan temporarily', 'Space + drag'],
                ['Zoom at pointer', 'Ctrl + scroll / pinch'],
                ['Connect / region', 'C / R'],
                ['Select multiple', 'Shift + click / drag'],
                ['Copy / paste', 'Ctrl or ⌘ + C / V'],
                ['Duplicate', 'Ctrl or ⌘ + D'],
                ['Undo / redo', 'Ctrl or ⌘ + Z / Shift + Z'],
                ['Group / ungroup', 'Ctrl or ⌘ + G / Shift + G'],
                ['Search board', 'Ctrl or ⌘ + F'],
                ['Fit everything', 'F'],
                ['Delete / deselect', 'Delete / Escape'],
              ].map(([name, key]) => (
                <div key={name}>
                  <span>{name}</span>
                  <kbd>{key}</kbd>
                </div>
              ))}
            </div>
          </Modal>
        )}
      </main>
    </CanvasContext.Provider>
  );
}
