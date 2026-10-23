import { InlineText } from './InlineText';
import { memo, useState, type SyntheticEvent } from 'react';
import { ArrowUpRight, Download, Film, LoaderCircle } from 'lucide-react';
import { assetUrl, downloadUrl, readableSize, type ItemData } from './model';
import { youtubeEmbedUrl } from '../shared/media.js';

const isolate = (event: SyntheticEvent) => event.stopPropagation();

// These remain file and link nodes. Playback state belongs to the browser, while
// source metadata, dimensions, asset references and history use the usual board model.
export const VideoPresentation = memo(function VideoPresentation({ data }: { data: ItemData }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const embed = data.kind === 'link' ? youtubeEmbedUrl(data.url) : null;
  const src = data.localUrl || (data.assetId ? assetUrl(data.assetId, false) : '');
  const label = embed ? data.caption || data.title || 'Video' : data.filename || 'Video';
  return (
    <>
      <div
        className="video-stage nodrag nopan nowheel"
        data-player-surface
        onPointerDown={isolate}
        onMouseDown={isolate}
        onClick={isolate}
        onDoubleClick={isolate}
        onWheel={isolate}
        onKeyDown={isolate}
        onKeyUp={isolate}
        onFocus={isolate}
        onContextMenu={isolate}
        onDragStart={(event) => event.preventDefault()}
      >
        {embed ? (
          <iframe
            className="youtube-player"
            src={embed}
            title={`YouTube video: ${label}`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : src && failedSource !== src ? (
          <video
            key={src}
            src={src}
            controls
            playsInline
            preload="metadata"
            aria-label={label}
            onError={() => setFailedSource(src)}
          />
        ) : (
          <div className="video-unavailable" role="status">
            <Film size={24} />
            <span>
              {data.loading
                ? 'Uploading video…'
                : src
                  ? 'This browser cannot play this video format or codec.'
                  : 'The original video is not available. Upload the file again.'}
            </span>
            {data.assetId && <a href={downloadUrl(data.assetId)}>Download original</a>}
          </div>
        )}
      </div>
      <div className="video-caption" title="Drag here to move; click to select and resize">
        <Film size={15} />
        <div className="video-caption-text">
          <strong title={label}>
            <InlineText
              text={label}
              format={embed ? data.formats?.[data.caption ? 'caption' : 'title'] : undefined}
            />
          </strong>
          <span>
            {embed
              ? data.author || data.domain || 'YouTube'
              : `${readableSize(data.size)} · ${data.filename?.split('.').pop()?.toUpperCase() || 'VIDEO'}`}
            {data.uploadError ? ' · Upload failed' : ''}
          </span>
        </div>
        {data.loading && <LoaderCircle size={14} className="spin" />}
        {embed ? (
          <a
            className="nodrag nopan icon-link"
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on YouTube"
            aria-label="Open on YouTube"
          >
            <ArrowUpRight size={16} />
          </a>
        ) : (
          data.assetId && (
            <a
              className="nodrag nopan icon-link"
              href={downloadUrl(data.assetId)}
              title="Download original video"
              aria-label="Download original video"
            >
              <Download size={15} />
            </a>
          )
        )}
      </div>
      {!embed && data.caption && (
        <p className="media-notes nodrag nopan nowheel" aria-label="Notes / caption">
          <InlineText text={data.caption} format={data.formats?.caption} />
        </p>
      )}
    </>
  );
});
