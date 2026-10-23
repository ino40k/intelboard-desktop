import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useReaderSize, type ReaderProps } from './DocumentReader';

GlobalWorkerOptions.workerSrc = workerUrl;
export function PdfReader({ url, position, onChange, checkpoint, onError }: ReaderProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [rendering, setRendering] = useState(true);
  const { ref, size } = useReaderSize();
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const page = Math.min(pdf?.numPages || Infinity, position.page || 1);
  const zoom = position.zoom || 1;
  const error = useRef(onError);
  error.current = onError;
  useEffect(() => {
    let active = true;
    const task = getDocument({
      url,
      useWasm: false,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      enableXfa: false,
    });
    // Password-protected originals keep the normal download fallback.
    task.onPassword = () => {
      if (active) error.current();
      void task.destroy();
    };
    task.promise
      .then((doc) => {
        if (active) setPdf(doc);
      })
      .catch(() => {
        if (active) error.current();
      });
    return () => {
      active = false;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    if (!pdf || !size.width) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    let layer: TextLayer | undefined;
    setRendering(true);
    (async () => {
      const docPage = await pdf.getPage(page);
      if (cancelled || !canvas.current || !text.current || !surface.current) return;
      const scale =
        Math.max(0.1, (size.width - 24) / docPage.getViewport({ scale: 1 }).width) * zoom;
      const viewport = docPage.getViewport({ scale });
      const ratio = Math.min(
        window.devicePixelRatio || 1,
        2,
        Math.sqrt(8000000 / (viewport.width * viewport.height)),
      );
      const c = canvas.current;
      c.width = Math.ceil(viewport.width * ratio);
      c.height = Math.ceil(viewport.height * ratio);
      c.style.width = viewport.width + 'px';
      c.style.height = viewport.height + 'px';
      surface.current.style.width = viewport.width + 'px';
      surface.current.style.height = viewport.height + 'px';
      surface.current.style.setProperty('--scale-factor', String(scale));
      surface.current.style.setProperty('--total-scale-factor', String(scale));
      text.current.replaceChildren();
      render = docPage.render({ canvas: c, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (cancelled) return;
      layer = new TextLayer({
        textContentSource: docPage.streamTextContent(),
        container: text.current,
        viewport,
      });
      await layer.render();
      if (!cancelled) setRendering(false);
    })().catch((e) => {
      if (!cancelled && e?.name !== 'RenderingCancelledException') error.current();
    });
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, zoom, size.width]);
  useEffect(() => {
    ref.current?.scrollTo(0, 0);
  }, [page]);
  const go = (value: number) => {
    if (!pdf || !Number.isFinite(value)) return;
    const next = Math.max(1, Math.min(pdf.numPages, Math.floor(value)));
    if (next !== page) {
      checkpoint();
      onChange({ ...position, page: next });
    }
  };
  return (
    <>
      <div className="reader-toolbar" aria-label="PDF controls">
        <button
          aria-label="Previous page"
          disabled={!pdf || page <= 1}
          onClick={() => go(page - 1)}
        >
          ‹
        </button>
        <input
          aria-label="PDF page"
          type="number"
          min={1}
          max={pdf?.numPages || 1}
          key={page}
          defaultValue={page}
          onBlur={(e) => go(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
        />
        <span aria-label="Page count">/ {pdf?.numPages || '…'}</span>
        <button
          aria-label="Next page"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => go(page + 1)}
        >
          ›
        </button>
        <select
          aria-label="PDF zoom"
          value={zoom}
          onChange={(e) => {
            checkpoint();
            onChange({ ...position, zoom: Number(e.target.value) });
          }}
        >
          <option value={1}>Fit width</option>
          <option value={0.75}>75%</option>
          <option value={1.25}>125%</option>
          <option value={1.5}>150%</option>
          <option value={2}>200%</option>
        </select>
      </div>
      <div
        className="pdf-scroll reader-viewport"
        ref={ref}
        tabIndex={0}
        aria-label="PDF reading area"
      >
        {rendering && (
          <span className="reader-loading" role="status">
            Loading page…
          </span>
        )}
        <div className="pdf-page" ref={surface}>
          <canvas ref={canvas} />
          <div className="textLayer" ref={text} />
        </div>
      </div>
    </>
  );
}
