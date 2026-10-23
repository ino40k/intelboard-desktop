import { ThemeSelect } from './ThemeSelect';
import { readTheme } from './themes';
import { useState, useEffect, useCallback, useId } from 'react';
import {
  Plus,
  Search,
  ArrowUpRight,
  Copy,
  Trash2,
  LayoutGrid,
  LogOut,
  LockKeyhole,
  LoaderCircle,
  FolderOpen,
  ArrowLeft,
} from 'lucide-react';
import { api, transfer } from './api';
import type { Board } from './model';
import Canvas from './Canvas';
import { draftKey } from './usePersistence';
import { boardSchema } from '../shared/schema.js';
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-symbol">
        <i />
        <i />
        <i />
        <i />
      </span>
      intelboard<span className="version">/ 01</span>
    </span>
  );
}
export function IconButton({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`icon-button ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const dialog = document.querySelector<HTMLDialogElement>('dialog');
    dialog?.showModal();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    dialog?.addEventListener('keydown', key);
    return () => {
      dialog?.removeEventListener('keydown', key);
      dialog?.close();
      old?.focus();
    };
  }, [onClose]);
  return (
    <dialog
      className="dialog"
      aria-labelledby={titleId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-title">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export default function App() {
  const [fatal, setFatal] = useState(''),
    [boards, setBoards] = useState<Board[]>([]),
    [board, setBoard] = useState<Board | null>(null),
    [loading, setLoading] = useState(true),
    [filter, setFilter] = useState(''),
    [dialog, setDialog] = useState<{
      kind: 'create' | 'rename' | 'delete' | 'draft';
      board?: Board;
    } | null>(null),
    [title, setTitle] = useState(''),
    [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('intelboard.theme', theme);
    } catch {
      /* Remain usable when storage is unavailable. */
    }
  }, [theme]);
  const refresh = useCallback(async () => {
    const result = await api<Board[]>('/boards');
    for (const item of result) {
      if (!boardSchema.safeParse({ ...item, edges: [] }).success)
        throw new Error(
          'A board contains invalid data. Restore a local backup; the current data has been kept.',
        );
    }
    setBoards(result);
    return result;
  }, []);
  const open = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const result = await api<Board>('/boards/' + id);
      if (!boardSchema.safeParse(result).success)
        throw new Error(
          'This board contains invalid data. Restore a local backup; the current data has been kept.',
        );
      const raw = localStorage.getItem(draftKey(id));
      if (raw) {
        try {
          const draft = boardSchema.parse(JSON.parse(raw));
          if (draft.revision === result.revision) {
            Object.assign(result, draft);
          } else if (draft.revision !== result.revision) {
            const same =
              JSON.stringify(draft.nodes) === JSON.stringify(result.nodes) &&
              JSON.stringify(draft.edges) === JSON.stringify(result.edges) &&
              JSON.stringify(draft.viewport) === JSON.stringify(result.viewport) &&
              draft.title === result.title;
            if (same) localStorage.removeItem(draftKey(id));
            else {
              setDialog({ kind: 'draft', board: result });
              setLoading(false);
              return;
            }
          }
        } catch {
          setFatal('A local recovery draft could not be read. Saved board data has been kept.');
        }
      }
      setBoard(result);
      localStorage.setItem('intelboard.last', id);
      document.title = result.title + ' · Intelboard';
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!active) return;
        {
          const list = await refresh();
          const last = localStorage.getItem('intelboard.last');
          if (last && list.some((b) => b.id === last)) await open(last);
        }
      } catch (e) {
        if (active) setFatal((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh, open]);
  const closeDialog = useCallback(() => setDialog(null), []);
  async function submitBoard(e: React.FormEvent) {
    e.preventDefault();
    if (!dialog) return;
    setBusy(true);
    try {
      if (dialog.kind === 'create') {
        const b = await api<Board>('/boards', {
          method: 'POST',
          body: JSON.stringify({ title: title.trim() || 'Untitled investigation' }),
        });
        setDialog(null);
        await refresh();
        await open(b.id);
      } else if (dialog.kind === 'rename' && dialog.board) {
        const b = await api<Board>('/boards/' + dialog.board.id);
        await api('/boards/' + b.id, {
          method: 'PUT',
          body: JSON.stringify({ ...b, title: title.trim() || b.title }),
        });
        setDialog(null);
        await refresh();
      } else if (dialog.kind === 'delete' && dialog.board) {
        await api('/boards/' + dialog.board.id, { method: 'DELETE' });
        localStorage.removeItem(draftKey(dialog.board.id));
        if (localStorage.getItem('intelboard.last') === dialog.board.id)
          localStorage.removeItem('intelboard.last');
        setDialog(null);
        await refresh();
      }
    } catch (e) {
      setFatal((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(b: Board) {
    try {
      await api('/boards/' + b.id + '/duplicate', { method: 'POST' });
      await refresh();
    } catch (e) {
      setFatal((e as Error).message);
    }
  }
  if (loading)
    return (
      <div className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" />
        <p>{fatal || 'Opening your workspace…'}</p>
        {fatal && <button onClick={() => location.reload()}>Retry</button>}
      </div>
    );
  if (board)
    return (
      <Canvas
        key={board.id}
        board={board}
        theme={theme}
        setTheme={setTheme}
        maxUploadMB={50}
        onBack={async () => {
          setBoard(null);
          localStorage.removeItem('intelboard.last');
          document.title = 'Intelboard';
          await refresh();
        }}
      />
    );
  const filtered = boards.filter((b) => b.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <main className="library">
      <header className="library-header">
        <Brand />
        <div className="header-right">
          <span className="private-badge">
            <span />
            PRIVATE WORKSPACE
          </span>
          <ThemeSelect value={theme} onChange={setTheme} />

        </div>
      </header>
      <section className="library-content">
        <div className="library-heading">
          <div>
            <div className="eyebrow">WORKSPACE</div>
            <h1>
              Your boards<span>{boards.length.toString().padStart(2, '0')}</span>
            </h1>
            <p>Sources, thoughts, and the connections between them.</p>
          </div>
          <button
            className="primary-button"
            onClick={() => {
              setTitle('');
              setDialog({ kind: 'create' });
            }}
          >
            <Plus size={18} />
            New board
          </button>
        </div>
        <div className="desktop-transfers">
          <button onClick={async () => { try { await transfer('import'); await refresh(); } catch(e) { setFatal((e as Error).message); } }}>Import boards…</button>
          <button disabled={!boards.length} onClick={async () => { try { await transfer('export-workspace'); } catch(e) { setFatal((e as Error).message); } }}>Export workspace…</button>
        </div>
        <div className="library-filter">
          <Search size={16} />
          <input
            aria-label="Find a board"
            placeholder="Find a board…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <LayoutGrid size={16} />
        </div>
        {fatal && (
          <div className="alert" role="alert">
            {fatal}
            <button onClick={() => setFatal('')}>Dismiss</button>
          </div>
        )}
        <div className="board-grid">
          {filtered.map((b) => (
            <article className="board-tile" key={b.id}>
              <button
                className="board-preview"
                onClick={() => void open(b.id)}
                aria-label={`Open ${b.title}`}
              >
                <BoardPreview board={b} />
                <span className="open-board">
                  <ArrowUpRight size={20} />
                </span>
                {!b.nodes.length && (
                  <span className="blank-preview">
                    <Plus size={26} strokeWidth={1} />
                  </span>
                )}
              </button>
              <div className="board-tile-title">
                <button onClick={() => void open(b.id)}>{b.title}</button>
                <div className="board-actions">
                  <IconButton
                    label={`Rename ${b.title}`}
                    onClick={() => {
                      setTitle(b.title);
                      setDialog({ kind: 'rename', board: b });
                    }}
                  >
                    <span className="rename-icon">Aa</span>
                  </IconButton>
                  <IconButton label={`Export ${b.title}`} onClick={async () => { try { await transfer('export-board', b.id); } catch(e) { setFatal((e as Error).message); } }}><FolderOpen size={14} /></IconButton>
                  <IconButton label={`Duplicate ${b.title}`} onClick={() => void duplicate(b)}>
                    <Copy size={14} />
                  </IconButton>
                  <IconButton
                    label={`Delete ${b.title}`}
                    onClick={() => setDialog({ kind: 'delete', board: b })}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </div>
              <div className="board-meta">
                <span>{b.count ?? b.nodes.length} items</span>
                <time dateTime={b.updated_at}>
                  Edited{' '}
                  {new Date(b.updated_at).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </div>
            </article>
          ))}
          <button
            className="new-board-tile"
            onClick={() => {
              setTitle('');
              setDialog({ kind: 'create' });
            }}
          >
            <Plus size={24} strokeWidth={1.3} />
            <span>{boards.length ? 'Start another board' : 'Create your first board'}</span>
            <small>
              {boards.length
                ? 'Make room for a new investigation.'
                : 'Drop in a source. Follow a connection.'}
            </small>
          </button>
        </div>
        {filter && !filtered.length && <p className="muted">No boards match “{filter}”.</p>}
        <footer className="library-footer">
          <FolderOpen size={14} />
          Stored on this computer<span>INTELBOARD / V1</span>
        </footer>
      </section>
      {dialog && (
        <Modal
          title={
            dialog.kind === 'create'
              ? 'New board'
              : dialog.kind === 'rename'
                ? 'Rename board'
                : dialog.kind === 'draft'
                  ? 'A recovered draft needs attention'
                  : 'Delete board?'
          }
          onClose={closeDialog}
        >
          {dialog.kind === 'draft' ? (
            <>
              <p>
                This board changed after your local draft was saved. You can recover the draft as a
                separate board to keep both versions.
              </p>
              <div className="dialog-actions">
                <button
                  onClick={() => {
                    localStorage.removeItem(draftKey(dialog.board!.id));
                    setBoard(dialog.board!);
                    setDialog(null);
                  }}
                >
                  Discard draft
                </button>
                <button
                  className="primary-button"
                  onClick={async () => {
                    try {
                      const draft = JSON.parse(localStorage.getItem(draftKey(dialog.board!.id))!);
                      const b = await api<Board>('/boards', {
                        method: 'POST',
                        body: JSON.stringify({ title: (dialog.board!.title + ' — recovered').slice(0, 200) }),
                      });
                      await api('/boards/' + b.id, {
                        method: 'PUT',
                        body: JSON.stringify({ ...draft, title: b.title, revision: 0 }),
                      });
                      localStorage.removeItem(draftKey(dialog.board!.id));
                      setDialog(null);
                      await open(b.id);
                    } catch (e) {
                      setFatal((e as Error).message);
                    }
                  }}
                >
                  Recover a copy
                </button>
              </div>
            </>
          ) : (
            <form onSubmit={submitBoard}>
              {dialog.kind === 'delete' ? (
                <p>
                  Delete <strong>{dialog.board?.title}</strong> and all its canvas content? This
                  cannot be undone. Original uploaded files are retained.
                </p>
              ) : (
                <label>
                  Board name
                  <input
                    autoFocus
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Untitled investigation"
                    maxLength={200}
                  />
                </label>
              )}
              <div className="dialog-actions">
                <button type="button" onClick={closeDialog}>
                  Cancel
                </button>
                <button
                  className={dialog.kind === 'delete' ? 'danger-button' : 'primary-button'}
                  disabled={busy}
                >
                  {dialog.kind === 'delete'
                    ? 'Delete board'
                    : dialog.kind === 'rename'
                      ? 'Rename'
                      : 'Create board'}
                  {dialog.kind === 'create' && <ArrowUpRight size={16} />}
                </button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </main>
  );
}
function BoardPreview({ board }: { board: Board }) {
  if (!board.nodes.length) return null;
  const xs = board.nodes.map((n) => n.position.x),
    ys = board.nodes.map((n) => n.position.y),
    minX = Math.min(...xs) - 40,
    minY = Math.min(...ys) - 40,
    maxX = Math.max(...board.nodes.map((n) => n.position.x + Number(n.style?.width || 280))) + 40,
    maxY = Math.max(...board.nodes.map((n) => n.position.y + Number(n.style?.height || 220))) + 40;
  return (
    <svg viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`} className="preview-svg">
      {board.nodes.map((n) => (
        <g key={n.id}>
          <rect
            x={n.position.x}
            y={n.position.y}
            width={Number(n.style?.width || 280)}
            height={Number(n.style?.height || 220)}
            rx="6"
            fill={
              n.data.kind === 'region'
                ? 'var(--region-bg)'
                : n.data.color === 'amber'
                  ? 'var(--note-amber)'
                  : 'var(--surface-raised)'
            }
            stroke="var(--border-strong)"
            strokeWidth="2"
          />
          {n.data.kind !== 'region' &&
            [0, 1, 2].map((i) => (
              <rect
                key={i}
                x={n.position.x + 20}
                y={n.position.y + 25 + i * 19}
                width={(Number(n.style?.width || 280) - 40) * (i === 2 ? 0.5 : 0.8)}
                height="5"
                rx="2"
                fill="var(--muted)"
                opacity=".25"
              />
            ))}
        </g>
      ))}
    </svg>
  );
}
