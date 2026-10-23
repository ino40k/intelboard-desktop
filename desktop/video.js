import { open } from 'node:fs/promises';
import { videoMime } from '../shared/media.js';

// Container identification is deliberately separate from browser codec support.
// Never trust an extension or an upload's Content-Type to permit inline HTML/SVG.
export function videoMimeFromBytes(bytes, filename, mime) {
  const candidate = videoMime(filename, mime);
  if (!candidate) return null;
  const ascii = (start, end) => bytes.subarray(start, end).toString('ascii');
  if (
    ['video/mp4', 'video/quicktime'].includes(candidate) &&
    bytes.length >= 16 &&
    ascii(4, 8) === 'ftyp' &&
    !/avif|avis|heic|heif|mif1/.test(ascii(8, 12))
  )
    return candidate;
  if (
    candidate === 'video/webm' &&
    bytes.length >= 8 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    bytes.includes(Buffer.from('webm'))
  )
    return candidate;
  if (candidate === 'video/ogg' && ascii(0, 4) === 'OggS' && bytes.includes(Buffer.from('theora')))
    return candidate;
  return null;
}

export async function storedVideoMime(file, asset) {
  if (!videoMime(asset.filename, asset.mime)) return null;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return videoMimeFromBytes(buffer.subarray(0, bytesRead), asset.filename, asset.mime);
  } finally {
    await handle.close();
  }
}
