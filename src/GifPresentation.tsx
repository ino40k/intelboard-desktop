import { memo, useState, type SyntheticEvent } from 'react';
import { assetUrl, type ItemData } from './model';
const isolate = (event: SyntheticEvent) => event.stopPropagation();

export const GifPresentation = memo(function GifPresentation({ data }: { data: ItemData }) {
  const [paused, setPaused] = useState(false);
  const [restart, setRestart] = useState(0);
  const playing = data.assetId
    ? `${assetUrl(data.assetId, false)}&animated=1&restart=${restart}`
    : data.localUrl;
  const still = data.assetId ? assetUrl(data.assetId) : data.localUrl;
  return (
    <button
      type="button"
      className="gif-player nodrag nopan nowheel"
      data-player-surface
      aria-label={paused ? 'Resume GIF animation' : 'Pause GIF animation'}
      aria-pressed={!paused}
      title={paused ? 'Click to resume animation' : 'Click to pause animation'}
      disabled={!data.assetId}
      onPointerDown={isolate}
      onMouseDown={isolate}
      onDoubleClick={isolate}
      onWheel={isolate}
      onKeyDown={isolate}
      onKeyUp={isolate}
      onClick={(event) => {
        event.stopPropagation();
        if (paused) setRestart((value) => value + 1);
        setPaused((value) => !value);
      }}
    >
      <img
        key={`${paused}-${restart}`}
        src={paused ? still : playing}
        alt={data.caption || data.filename || 'Animated GIF'}
        draggable={false}
      />
    </button>
  );
});
