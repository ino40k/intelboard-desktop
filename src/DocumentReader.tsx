import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { BookOpen, Download } from 'lucide-react';
import { downloadUrl, readableSize, type ItemData } from './model';
import { InlineText } from './InlineText';
import { documentFormat } from '../shared/document.js';
import { PdfReader } from './PdfReader';
import { EpubReader } from './EpubReader';

export type ReaderPosition = NonNullable<ItemData['reader']>;
export type ReaderProps = {
  url: string;
  position: ReaderPosition;
  onChange: (position: ReaderPosition) => void;
  checkpoint: () => void;
  onError: () => void;
};
const isolate = (e: SyntheticEvent) => e.stopPropagation();

export default function DocumentReader({
  data,
  onChange,
  checkpoint,
}: {
  data: ItemData;
  onChange: (position: ReaderPosition) => void;
  checkpoint: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [data.assetId]);
  const format = documentFormat(data.filename, data.mime);
  const url = data.assetId ? downloadUrl(data.assetId) : '';
  const props: ReaderProps = {
    url,
    position: data.reader || {},
    onChange,
    checkpoint,
    onError: () => setFailed(true),
  };
  return (
    <>
      <div className="document-heading" title="Drag here to move; click to select and resize">
        <BookOpen size={16} />
        <div>
          <strong title={data.filename}>{data.filename || 'Document'}</strong>
          <span>
            {readableSize(data.size)} · {format?.toUpperCase()} · Original file
          </span>
        </div>
        {url && (
          <a
            className="nodrag nopan icon-link"
            href={url}
            title="Download original file"
            aria-label="Download original file"
          >
            <Download size={15} />
          </a>
        )}
      </div>
      <div
        className="document-reader nodrag nopan nowheel"
        data-player-surface
        onPointerDown={isolate}
        onMouseDown={isolate}
        onClick={isolate}
        onDoubleClick={isolate}
        onWheel={isolate}
        onKeyDown={isolate}
        onKeyUp={isolate}
        onContextMenu={isolate}
        onDragStart={(e) => e.preventDefault()}
      >
        {!url || failed ? (
          <div className="reader-message" role="status">
            {data.loading
              ? 'Uploading document…'
              : failed
                ? 'This document cannot be displayed. It may be damaged, protected, or unsupported.'
                : 'The original document is unavailable.'}
            {url && <a href={url}>Download original</a>}
          </div>
        ) : format === 'pdf' ? (
          <PdfReader {...props} />
        ) : (
          <EpubReader {...props} />
        )}
      </div>
      {data.caption && (
        <p className="media-notes nodrag nopan nowheel" aria-label="Notes / caption">
          <InlineText text={data.caption} format={data.formats?.caption} />
        </p>
      )}
    </>
  );
}

// Observe layout dimensions, not transformed canvas coordinates.
export function useReaderSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}
