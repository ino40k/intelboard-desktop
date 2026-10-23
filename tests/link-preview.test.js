import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../desktop/store.js';
import { boardSchema, nodeSchema } from '../shared/schema.js';

test('per-link preview preference survives save/reopen/duplication without dropping image references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-preview-'));
  let store = openStore(dir);
  try {
    const image = randomUUID();
    store.db.prepare('INSERT INTO assets(id,filename,mime,size,checksum,created_at) VALUES(?,?,?,?,?,?)')
      .run(image, 'preview.png', 'image/png', 10, 'fixture', new Date().toISOString());
    const b = store.create('Preview regression');
    const link = { id: randomUUID(), type: 'research', position: { x: 0, y: 0 },
      data: { kind: 'link', title: 'Preserved title', description: 'Preserved notes',
        url: 'https://example.com/', thumbnailId: image } };
    assert.equal(nodeSchema.parse(link).data.hidePreview, undefined);
    b.nodes = [link, { ...link, id: randomUUID(), data: { ...link.data, hidePreview: true } }];
    store.save(b.id, boardSchema.parse(b));
    store.db.close(); store = openStore(dir);
    const loaded = store.get(b.id);
    assert.equal(loaded.nodes[0].data.hidePreview, undefined);
    assert.equal(loaded.nodes[1].data.hidePreview, true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM asset_refs WHERE asset_id=?').get(image).n, 2);
    const copy = store.duplicate(b.id);
    assert.equal(copy.nodes[1].data.hidePreview, true);
    assert.equal(copy.nodes[1].data.thumbnailId, image);
    assert.equal(copy.nodes[1].data.description, 'Preserved notes');
    loaded.nodes[1].data.hidePreview = false;
    store.save(loaded.id, boardSchema.parse(loaded));
    assert.equal(store.get(b.id).nodes[1].data.hidePreview, false);
    assert.equal(store.get(b.id).nodes[1].data.thumbnailId, image);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE id=?').get(image).n, 1);
    assert.throws(() => nodeSchema.parse({ ...link, data: { ...link.data, hidePreview: 'yes' } }));
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
