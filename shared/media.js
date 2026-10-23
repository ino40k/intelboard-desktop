// Presentation is derived from the existing file/link metadata, including old boards.
const videoTypes = new Map([
  ['video/mp4', 'video/mp4'],
  ['video/x-m4v', 'video/mp4'],
  ['video/webm', 'video/webm'],
  ['video/ogg', 'video/ogg'],
  ['application/ogg', 'video/ogg'],
  ['video/quicktime', 'video/quicktime'],
]);
const extensions = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
  ['ogg', 'video/ogg'],
  ['mov', 'video/quicktime'],
]);
export function videoMime(filename = '', mime = '') {
  const type = mime.split(';')[0].trim().toLowerCase();
  if (videoTypes.has(type)) return videoTypes.get(type);
  if (!type || type === 'application/octet-stream')
    return extensions.get(filename.split('.').pop()?.toLowerCase()) || null;
  return null;
}

export function youtubeVideo(raw = '') {
  try {
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port)
      return null;
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    let id = null;
    if (['youtu.be', 'www.youtu.be'].includes(host) && segments.length === 1) id = segments[0];
    if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v');
      else if (['shorts', 'embed', 'live', 'v'].includes(segments[0]) && segments.length === 2)
        id = segments[1];
    }
    if (
      ['youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host) &&
      segments[0] === 'embed' &&
      segments.length === 2
    )
      id = segments[1];
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const time =
      url.searchParams.get('start') ||
      url.searchParams.get('t') ||
      new URLSearchParams(url.hash.slice(1)).get('t') ||
      '';
    const parts = time.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    const start = /^\d+$/.test(time)
      ? Number(time)
      : parts
        ? Number(parts[1] || 0) * 3600 + Number(parts[2] || 0) * 60 + Number(parts[3] || 0)
        : 0;
    return { id, start: Number.isSafeInteger(start) && start <= 604800 ? start : 0 };
  } catch {
    return null;
  }
}

export function youtubeEmbedUrl(raw) {
  const video = youtubeVideo(raw);
  if (!video) return null;
  const url = new URL('https://www.youtube-nocookie.com/embed/' + video.id);
  url.searchParams.set('controls', '1');
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('fs', '1');
  if (video.start) url.searchParams.set('start', String(video.start));
  return url.href;
}
