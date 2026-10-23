import { useEffect, useRef, useState, useCallback } from 'react';
import type { Board, Item, Connection } from './model';
import { cleanNodes, cleanEdges } from './model';
import type { Viewport } from '@xyflow/react';
import { api, ApiError } from './api';
export const draftKey = (id: string) => 'intelboard.draft.' + id;
export function usePersistence(
  board: Board,
  nodes: Item[],
  edges: Connection[],
  viewport: Viewport,
  title: string,
  onSaved: (revision: number) => void,
) {
  const revision = useRef(board.revision),
    last = useRef(''),
    busy = useRef(false),
    conflict = useRef(false),
    mounted = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activeCaptures = useRef(false);
  activeCaptures.current = nodes.some((node) => node.data.loading);
  const [status, setStatus] = useState('saved');
  const [error, setError] = useState('');
  const snapshot = { nodes: cleanNodes(nodes), edges: cleanEdges(edges), viewport, title };
  const encoded = JSON.stringify(snapshot);
  const latest = useRef({ snapshot, encoded });
  latest.current = { snapshot, encoded };
  const callback = useRef(onSaved);
  callback.current = onSaved;
  if (!last.current)
    last.current = localStorage.getItem(draftKey(board.id))
      ? 'recovered'
      : JSON.stringify({
          nodes: cleanNodes(board.nodes),
          edges: cleanEdges(board.edges),
          viewport: board.viewport,
          title: board.title,
        });
  const persistDraft = useCallback(() => {
    try {
      localStorage.setItem(
        draftKey(board.id),
        JSON.stringify({ ...latest.current.snapshot, revision: revision.current }),
      );
    } catch {
      setError(
        'Recovery storage is full. Keep this window open until the local save completes.',
      );
    }
  }, [board.id]);
  const save = useCallback(async () => {
    if (busy.current || conflict.current || latest.current.encoded === last.current) return;
    busy.current = true;
    const current = latest.current;
    setStatus('saving');
    try {
      const result = await api<{ revision: number }>('/boards/' + board.id, {
        method: 'PUT',
        body: JSON.stringify({ ...current.snapshot, revision: revision.current }),
      });
      revision.current = result.revision;
      last.current = current.encoded;
      callback.current(result.revision);
      if (latest.current.encoded === current.encoded) localStorage.removeItem(draftKey(board.id));
      else persistDraft();
      if (mounted.current) {
        setStatus(latest.current.encoded === last.current ? 'saved' : 'pending');
        setError('');
      }
    } catch (e) {
      persistDraft();
      if (e instanceof ApiError && e.status === 409) conflict.current = true;
      if (mounted.current) {
        setStatus('error');
        setError((e as Error).message);
      }
    } finally {
      busy.current = false;
      if (mounted.current && !conflict.current && latest.current.encoded !== last.current)
        timer.current = setTimeout(() => void save(), 3000);
    }
  }, [board.id, persistDraft]);
  useEffect(() => {
    if (encoded === last.current) {
      // Undo can return to the already saved snapshot before the debounce runs.
      if (!busy.current && !conflict.current) {
        setStatus('saved');
        setError('');
        localStorage.removeItem(draftKey(board.id));
      }
      return;
    }
    persistDraft();
    if (!conflict.current) setStatus('pending');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 450);
    return () => clearTimeout(timer.current);
  }, [encoded, persistDraft, save]);
  useEffect(() => {
    mounted.current = true;
    const exit = (e: BeforeUnloadEvent) => {
      if (latest.current.encoded !== last.current) {
        persistDraft();
        const result = window.intelboard.saveOnExit(board.id, { ...latest.current.snapshot, revision: revision.current });
        if (result.ok) {
          last.current = latest.current.encoded;
          localStorage.removeItem(draftKey(board.id));
        }
      }
      if (latest.current.encoded !== last.current || activeCaptures.current) e.preventDefault();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden' && latest.current.encoded !== last.current) {
        persistDraft();
        void save();
      }
    };
    window.addEventListener('beforeunload', exit);
    window.addEventListener('online', save);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      window.removeEventListener('beforeunload', exit);
      window.removeEventListener('online', save);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [board.id, persistDraft, save]);
  return {
    status: status === 'saved' && activeCaptures.current ? 'capturing' : status,
    error,
    save,
    hasUnsaved: () => latest.current.encoded !== last.current || activeCaptures.current,
  };
}
