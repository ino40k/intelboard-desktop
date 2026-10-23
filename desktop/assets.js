import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { randomUUID, createHash } from 'node:crypto';
import { videoMimeFromBytes } from './video.js';
import { atomicWrite } from './files.js';
import { readBoundedZip } from './zip.js';
export function assetService(store, dir) {
  const folder = path.join(dir, 'assets');
  async function add(buffer, filename, mime) {
    await mkdir(folder, { recursive: true });
    mime = videoMimeFromBytes(buffer.subarray(0, 512), filename, mime) || mime;
    if (/\.epub$/i.test(filename) || mime === 'application/epub+zip') await readBoundedZip(buffer, { collect: false });
    const id = randomUUID();
    let thumbnail = null,
      width = null,
      height = null,
      preview = null;
    // Only decoded raster formats become inline images. SVG/HTML always download.
    try {
      const head = buffer.subarray(0, 16);
      const raster =
        head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        head.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
        /^GIF8/.test(head.toString()) ||
        (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') ||
        head.toString('ascii', 4, 12) === 'ftypavif';
      if (!raster) throw new Error('Generic attachment');
      const info = await sharp(buffer, { limitInputPixels: 50000000 }).metadata();
      if (['png', 'jpeg', 'webp', 'gif', 'avif'].includes(info.format)) {
        mime = 'image/' + (info.format === 'jpeg' ? 'jpeg' : info.format);
        const rotated = [5, 6, 7, 8].includes(info.orientation);
        width = rotated ? info.height : info.width;
        height = rotated ? info.width : info.height;
        thumbnail = id + '.webp';
        await sharp(buffer, { limitInputPixels: 50000000 })
          .rotate()
          .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(path.join(folder, thumbnail));
      }
    } catch {
      // A failed decoder must never mark an original as safe for inline viewing.
      if (thumbnail) await unlink(path.join(folder, thumbnail)).catch(() => {});
      thumbnail = null;
      width = null;
      height = null;
    }
    if (!thumbnail && /^(text\/plain|text\/csv|application\/json)$/.test(mime))
      preview = buffer.subarray(0, 2000).toString('utf8');
    await atomicWrite(path.join(folder, id), buffer);
    const asset = {
      id,
      filename,
      mime: thumbnail ? mime : mime || 'application/octet-stream',
      size: buffer.length,
      checksum: createHash('sha256').update(buffer).digest('hex'),
      thumbnail,
      width,
      height,
      preview,
      created_at: new Date().toISOString(),
    };
    try {
      store.db
        .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(...Object.values(asset));
    } catch (e) {
      await unlink(path.join(folder, id));
      if (thumbnail) await unlink(path.join(folder, thumbnail));
      throw e;
    }
    return asset;
  }
  const get = (id) => store.db.prepare('SELECT * FROM assets WHERE id=?').get(id);
  async function remove(id) {
    const a = get(id);
    if (!a) return false;
    if (store.db.prepare('SELECT 1 FROM asset_refs WHERE asset_id=?').get(id))
      throw Object.assign(new Error('This file is still used by a board'), { status: 409 });
    store.db.prepare('DELETE FROM assets WHERE id=?').run(id);
    await unlink(path.join(folder, id)).catch(() => {});
    if (a.thumbnail) await unlink(path.join(folder, a.thumbnail)).catch(() => {});
    return true;
  }
  return { add, get, remove, folder };
}
