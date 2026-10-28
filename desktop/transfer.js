// Versioned, uncompressed ZIP. Only UUID-named entries from a validated manifest are read;
// archive paths are never extracted to the filesystem.
import JSZip from 'jszip';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { boardSchema } from '../shared/schema.js';
import { MAX_FILE_BYTES } from './service.js';
import { atomicWrite } from './files.js';
import { readBoundedZip } from './zip.js';
import { documentFormat } from '../shared/document.js';
const LIMIT = 512 * 1024 * 1024;
const manifestSchema = z.object({
  format: z.literal('intelboard'), version: z.literal(1),
  boards: z.array(boardSchema).min(1).max(1000),
  assets: z.array(z.object({ id: z.string().uuid(), filename: z.string().min(1).max(4000), mime: z.string().max(200), size: z.number().int().min(1).max(MAX_FILE_BYTES), checksum: z.string().regex(/^[a-f0-9]{64}$/) })).max(10000),
});
const refs = boards => new Set(boards.flatMap(b => b.nodes.flatMap(n => [n.data.assetId,n.data.thumbnailId,n.data.faviconId].filter(Boolean))));
export async function exportBoards(service, ids, destination) {
  const boards = ids.map(id => {
    const board = service.store.get(id); if (!board) throw new Error('Board not found'); return boardSchema.parse(board);
  });
  if (!boards.length) throw new Error('There are no boards to export');
  const zip = new JSZip(), assets = []; let total = 0;
  for (const id of refs(boards)) {
    const asset = service.assets.get(id); if (!asset) throw new Error('A referenced attachment is missing');
    if ((total += asset.size) > LIMIT - 32 * 1024 * 1024) throw new Error('Export exceeds the 480 MB attachment limit; export individual boards');
    const bytes = await readFile(path.join(service.assets.folder, id));
    if (createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new Error('An attachment failed its integrity check');
    assets.push({ id, filename: asset.filename, mime: asset.mime, size: bytes.length, checksum: asset.checksum });
    zip.file('assets/' + id, bytes, { createFolders: false });
  }
  const manifest = manifestSchema.parse({ format: 'intelboard', version: 1, boards, assets });
  const json = JSON.stringify(manifest);
  if (Buffer.byteLength(json) > 32 * 1024 * 1024) throw new Error('Board data exceeds the 32 MB manifest limit');
  zip.file('manifest.json', json);
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  if (output.length > LIMIT) throw new Error('Export exceeds 512 MB');
  await atomicWrite(destination, output);
  return { boards: boards.length, assets: assets.length };
}
export async function importBoards(service, source) {
  if ((await stat(source)).size > LIMIT) throw new Error('Import exceeds 512 MB');
  const input = await readFile(source);
  const files = await readBoundedZip(input, {
    maxEntries: 10001, maxTotal: LIMIT, maxEntry: MAX_FILE_BYTES,
    allowName: name => /^(manifest\.json|assets\/[0-9a-f-]{36})$/.test(name),
  });
  const manifestFile = files.get('manifest.json');
  if (!manifestFile || manifestFile.length > 32 * 1024 * 1024) throw new Error('Missing or oversized manifest');
  const manifest = manifestSchema.parse(JSON.parse(manifestFile.toString('utf8')));
  const ids = new Set(manifest.assets.map(a => a.id));
  const referenced = refs(manifest.boards);
  if (ids.size !== manifest.assets.length || files.size !== manifest.assets.length + 1 || [...referenced].some(id => !ids.has(id)) || [...ids].some(id=>!referenced.has(id))) throw new Error('Attachment manifest does not match board references');
  // Validate every payload before changing the database or adding files.
  const payloads = new Map();
  for (const asset of manifest.assets) {
    const bytes = files.get('assets/' + asset.id);
    if (!bytes) throw new Error('Missing attachment');
    if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.checksum) throw new Error('Attachment checksum mismatch');
    payloads.set(asset.id, bytes);
  }
  // Nodes can identify an EPUB even when the attachment metadata is generic.
  // Validate each shared asset once across all boards, before any writes.
  const validatedEpubs = new Set();
  for (const board of manifest.boards) for (const node of board.nodes) {
    const id = node.data.assetId;
    if (id && !validatedEpubs.has(id) && documentFormat(node.data.filename, node.data.mime) === 'epub') {
      await readBoundedZip(payloads.get(id), { collect: false });
      validatedEpubs.add(id);
    }
  }
  const added = [], map = new Map();
  try {
    for (const asset of manifest.assets) {
      const imported = await service.assets.add(payloads.get(asset.id), asset.filename.replace(/[\\/]/g,'_'), asset.mime);
      added.push(imported.id); map.set(asset.id, imported.id);
    }
    return service.store.transaction(() => manifest.boards.map(original => {
      const title = (original.title + ' — imported').slice(0,200);
      const copy = service.store.create(title);
      const nodeIds = new Map(original.nodes.map(n => [n.id,randomUUID()]));
      const groups = new Map(original.nodes.filter(n=>n.data.groupId).map(n=>[n.data.groupId,randomUUID()]));
      const nodes = original.nodes.map(n => {
        const data = { ...n.data };
        for (const key of ['assetId','thumbnailId','faviconId']) if (data[key]) data[key] = map.get(data[key]);
        if (data.groupId) data.groupId = groups.get(data.groupId);
        return { ...n, id:nodeIds.get(n.id), data };
      });
      const edges = original.edges.map(e=>({...e,id:randomUUID(),source:nodeIds.get(e.source),target:nodeIds.get(e.target)}));
      service.store.save(copy.id, { ...original,title,revision:0,nodes,edges });
      return copy.id;
    }));
  } catch(e) { for(const id of added) await service.assets.remove(id).catch(()=>{}); throw e; }
}
