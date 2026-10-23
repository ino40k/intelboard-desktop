import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedZip } from './zip.js';
import { z } from 'zod';
import { openStore } from './store.js';
import { assetService } from './assets.js';
import { boardSchema } from '../shared/schema.js';
import { fetchPublic, parseMetadata } from './metadata.js';
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const uuid = z.string().uuid();
export function createService(dataDir) {
  const store = openStore(dataDir);
  const assets = assetService(store, dataDir);
  let captures = 0;
  async function capture(raw) {
    const url = z.url().max(8000).parse(raw);
    if (!/^https?:/.test(url)) throw new Error('Use an HTTP or HTTPS link');
    const fallback = { url, title: new URL(url).hostname, domain: new URL(url).hostname, capturedAt: new Date().toISOString() };
    if (captures >= 4) return { ...fallback, captureStatus: 'Capture is busy. Retry from Edit.' };
    captures++;
    try {
      const result = await fetchPublic(url);
      if (!/text\/html|application\/xhtml\+xml/i.test(result.type)) throw new Error('This source does not provide an HTML preview');
      const metadata = parseMetadata(result.buffer.toString('utf8'), result.url);
      metadata.url = url;
      metadata.capturedTitle = metadata.title;
      metadata.assetId = (await assets.add(result.buffer, 'source.html', 'text/html')).id;
      async function cacheImage(raw, name) {
        if (!raw) return;
        try {
          const response = await fetchPublic(raw, { maxBytes: 5 * 1024 * 1024, timeout: 5000 });
          const a = await assets.add(response.buffer, name, response.type.split(';')[0]);
          if (a.thumbnail) return a.id;
          await assets.remove(a.id);
        } catch { /* Keep captured text when a preview is unavailable. */ }
      }
      [metadata.thumbnailId, metadata.faviconId] = await Promise.all([
        cacheImage(metadata.imageUrl, 'link-preview'), cacheImage(metadata.faviconUrl, 'favicon'),
      ]);
      delete metadata.imageUrl; delete metadata.faviconUrl;
      return { ...metadata, captureStatus: 'captured' };
    } catch (e) { return { ...fallback, captureStatus: e.message }; }
    finally { captures--; }
  }
  async function request(route, method = 'GET', body) {
    if (typeof route !== 'string' || route.length > 200 || !['GET','POST','PUT','DELETE'].includes(method)) throw new Error('Invalid desktop request');
    if (route === '/boards') {
      if (method === 'GET') return store.list();
      if (method === 'POST') return store.create(z.string().trim().min(1).max(200).parse(body?.title));
    }
    const board = route.match(/^\/boards\/([^/]+)(\/duplicate)?$/);
    if (board) {
      const id = uuid.parse(board[1]);
      if (!store.get(id)) throw Object.assign(new Error('Board not found'), { status: 404 });
      if (board[2] && method === 'POST') return store.duplicate(id);
      if (!board[2] && method === 'GET') return store.get(id);
      if (!board[2] && method === 'PUT') return store.save(id, boardSchema.parse(body));
      if (!board[2] && method === 'DELETE') { store.remove(id); return { ok: true }; }
    }
    if (route === '/assets' && method === 'POST') {
      if (!(body?.bytes instanceof Uint8Array) || body.bytes.byteLength > MAX_FILE_BYTES || !body.bytes.byteLength) throw new Error('Choose a file between 1 byte and 50 MB');
      const filename = z.string().min(1).max(4000).parse(body.filename).replace(/[\\/]/g, '_');
      return assets.add(Buffer.from(body.bytes), filename, z.string().max(200).parse(body.mime || 'application/octet-stream'));
    }
    const epub = route.match(/^\/assets\/([0-9a-f-]{36})\/validate-epub$/);
    if (epub && method === 'GET') {
      const asset = assets.get(epub[1]); if (!asset) throw new Error('File not found');
      await readBoundedZip(await readFile(path.join(assets.folder,asset.id)), { collect: false });
      return { ok: true };
    }
    if (route === '/metadata' && method === 'POST') return capture(body?.url);
    throw Object.assign(new Error('Unknown desktop operation'), { status: 404 });
  }
  return { store, assets, request, close: () => store.db.close() };
}
