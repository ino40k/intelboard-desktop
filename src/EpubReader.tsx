import { api } from './api';
import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Rendition } from 'epubjs';
import type { Location } from 'epubjs/types/rendition';
import type Section from 'epubjs/types/section';
import DOMPurify from 'dompurify';
import JSZip from 'jszip';
import { useReaderSize, type ReaderProps } from './DocumentReader';

export function EpubReader({ url, position, onChange, checkpoint, onError }: ReaderProps) {
  const { ref, size } = useReaderSize();
  const rendition = useRef<Rendition | undefined>(undefined);
  const latest = useRef({ position, onChange, checkpoint, onError });
  latest.current = { position, onChange, checkpoint, onError };
  const [location, setLocation] = useState<Location>();
  const [chapters, setChapters] = useState<{ label: string; href: string }[]>([]);
  const [ready, setReady] = useState(false);
  const lastCfi = useRef(position.cfi);
  const navigating = useRef(false);
  const saveRelocation = useRef(false);
  useEffect(() => {
    if (!ref.current) return;
    let active = true;
    let book: Book | undefined;
    let locationTimer: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (active) latest.current.onError();
    }, 30000);
    (async () => {
      const assetId = new URL(url, window.location.href).pathname.split('/').pop();
      await api('/assets/' + assetId + '/validate-epub');
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('File unavailable');
      const bytes = await response.arrayBuffer();
      // Reject oversized archives before EPUB.js inflates chapter resources.
      const archive = await JSZip.loadAsync(bytes);
      const entries = Object.values(archive.files);
      const expanded = entries.reduce(
        (sum, entry) =>
          sum +
          ((entry as unknown as { _data?: { uncompressedSize: number } })._data?.uncompressedSize ||
            0),
        0,
      );
      if (
        entries.length > 5000 ||
        expanded > 100 * 1024 * 1024 ||
        bytes.byteLength > 50 * 1024 * 1024
      )
        throw new Error('Book too large');
      if (!active) return;
      book = ePub({ replacements: 'blobUrl' });
      // Some EPUB.js failures reject both opened and open; handle both.
      book.opened.catch(() => {});
      await book.open(bytes, 'binary');
      await book.ready;
      if (!active) return;
      book.spine.hooks.serialize.register((_html: string, section: Section) => {
        const safe = DOMPurify.sanitize(section.output, {
          WHOLE_DOCUMENT: true,
          ALLOWED_URI_REGEXP:
            /^(?:(?:https?|blob):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
          ADD_TAGS: ['link'],
          ADD_ATTR: ['xmlns'],
          FORBID_TAGS: [
            'script',
            'iframe',
            'object',
            'embed',
            'form',
            'input',
            'button',
            'textarea',
            'select',
            'meta',
            'base',
          ],
        });
        const doc = new DOMParser().parseFromString(safe, 'text/html');
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content =
          "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; form-action 'none'; base-uri 'none'";
        doc.head.prepend(policy);
        section.output = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
      });
      const r = book.renderTo(ref.current!, {
        width: ref.current!.clientWidth,
        height: ref.current!.clientHeight,
        flow: 'paginated',
        spread: 'none',
        allowScriptedContent: false,
      });
      rendition.current = r;
      r.themes.default({
        body: {
          'font-family': 'Georgia, serif',
          'line-height': '1.6',
          color: '#222',
          background: '#fff',
        },
        img: { 'max-width': '100%', height: 'auto' },
      });
      const updateLocation = (loc: Location) => {
        if (!active) return;
        clearInterval(locationTimer);
        locationTimer = undefined;
        setLocation(loc);
        const cfi = loc.start.cfi;
        if (cfi && (saveRelocation.current || !lastCfi.current) && cfi !== lastCfi.current) {
          lastCfi.current = cfi;
          latest.current.onChange({ ...latest.current.position, cfi });
          saveRelocation.current = false;
        }
      };
      r.on('relocated', updateLocation);
      r.hooks.content.register((contents: { document: Document }) => {
        contents.document.addEventListener(
          'click',
          (event: MouseEvent) => {
            if ((event.target as Element)?.closest('a[href]')) {
              latest.current.checkpoint();
              saveRelocation.current = true;
            }
          },
          true,
        );
      });
      r.on('displayError', () => {
        if (active) latest.current.onError();
      });
      const toc: { label: string; href: string }[] = [];
      const walk = (items: import('epubjs/types/navigation').NavItem[]) =>
        items.forEach((item) => {
          toc.push({ label: item.label.trim(), href: item.href });
          if (item.subitems) walk(item.subitems);
        });
      walk(book.navigation.toc);
      setChapters(toc);
      await r.display(latest.current.position.cfi).catch(() => r.display());
      if (active) {
        // EPUB.js can report an empty location while React Flow is measuring
        // the card, then omit the initial relocation event. Reconcile from the
        // rendered page while layout settles, stopping on the first location.
        // Its types describe an endpoint; the default manager returns Location.
        let attempts = 0;
        const refreshLocation = () => {
          const loc = r.currentLocation() as unknown as Location;
          if (loc?.start?.cfi && loc?.end?.cfi) updateLocation(loc);
          else if (++attempts >= 30) clearInterval(locationTimer);
        };
        locationTimer = setInterval(refreshLocation, 100);
        refreshLocation();
        setReady(true);
        clearTimeout(timeout);
      }
    })().catch(() => {
      if (active) latest.current.onError();
    });
    return () => {
      active = false;
      clearTimeout(timeout);
      clearInterval(locationTimer);
      controller.abort();
      rendition.current = undefined;
      book?.destroy();
    };
  }, [url]);
  // EPUB.js reflows around its current CFI when the element changes dimensions.
  useEffect(() => {
    if (!ready || !size.width || !size.height) return;
    const timer = setTimeout(() => {
      const r = rendition.current;
      if (!r) return;
      r.resize(size.width, size.height);
      if (lastCfi.current) void r.display(lastCfi.current).catch(() => latest.current.onError());
    }, 120);
    return () => clearTimeout(timer);
  }, [size.width, size.height, ready]);
  // Undo/redo can replace persistent position without replacing the reader.
  useEffect(() => {
    if (ready && position.cfi && position.cfi !== lastCfi.current) {
      lastCfi.current = position.cfi;
      void rendition.current?.display(position.cfi).catch(() => latest.current.onError());
    }
  }, [position.cfi, ready]);
  const navigate = async (target: 'prev' | 'next' | string) => {
    const r = rendition.current;
    if (!r || navigating.current) return;
    navigating.current = true;
    saveRelocation.current = true;
    checkpoint();
    try {
      await (target === 'prev' ? r.prev() : target === 'next' ? r.next() : r.display(target));
    } catch {
      onError();
    } finally {
      navigating.current = false;
    }
  };
  return (
    <>
      <div className="reader-toolbar" aria-label="EPUB controls">
        <button
          aria-label="Previous book page"
          disabled={!ready || location?.atStart}
          onClick={() => void navigate('prev')}
        >
          ‹
        </button>
        <span className="epub-location" aria-label="Book location">
          {location
            ? `Chapter ${location.start.index + 1} · ${location.start.displayed.page} / ${location.start.displayed.total}`
            : 'Opening…'}
        </span>
        <button
          aria-label="Next book page"
          disabled={!ready || location?.atEnd}
          onClick={() => void navigate('next')}
        >
          ›
        </button>
        <select
          aria-label="Chapter"
          disabled={!ready}
          value=""
          onChange={(e) => void navigate(e.target.value)}
        >
          <option value="">Chapters</option>
          {chapters.map((chapter, i) => (
            <option key={i} value={chapter.href}>
              {chapter.label}
            </option>
          ))}
        </select>
      </div>
      <div className="epub-viewport reader-viewport" ref={ref} aria-label="EPUB reading area" />
    </>
  );
}
