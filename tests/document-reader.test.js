import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openStore } from '../desktop/store.js';
import { boardSchema, nodeSchema } from '../shared/schema.js';
import { documentFormat } from '../shared/document.js';

test('reader detection preserves generic unsupported files', () => {
  assert.equal(documentFormat('book.PDF', 'application/octet-stream'), 'pdf');
  assert.equal(documentFormat('book', 'application/epub+zip'), 'epub');
  for (const filename of ['book.mobi', 'book.azw3', 'book.docx', 'book.fb2', 'source.html'])
    assert.equal(documentFormat(filename, ''), null);
});
test('page and CFI persist through database reopen and duplication with originals and notes intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-state-'));
  let store = openStore(dir);
  try {
    const assetId = randomUUID(),
      timestamp = new Date().toISOString();
    store.db
      .prepare('INSERT INTO assets(id,filename,mime,size,checksum,created_at) VALUES(?,?,?,?,?,?)')
      .run(
        assetId,
        'original.epub',
        'application/epub+zip',
        1234,
        'unchanged-original-checksum',
        timestamp,
      );
    const board = store.create('Document test');
    const node = {
      id: randomUUID(),
      type: 'research',
      position: { x: 0, y: 0 },
      data: {
        kind: 'file',
        filename: 'original.epub',
        assetId,
        caption: 'Separate user notes',
        reader: { cfi: 'epubcfi(/6/4[c2]!/4/10[p4]/1:55)' },
      },
    };
    assert.equal(
      nodeSchema.parse({ ...node, data: { kind: 'file', filename: 'legacy.pdf' } }).data.reader,
      undefined,
    );
    board.nodes = [
      node,
      {
        ...node,
        id: randomUUID(),
        data: { ...node.data, filename: 'original.pdf', reader: { page: 126, zoom: 1.5 } },
      },
    ];
    store.save(board.id, boardSchema.parse(board));
    store.db.close();
    store = openStore(dir);
    const loaded = store.get(board.id);
    assert.deepEqual(
      loaded.nodes.map((n) => n.data.reader),
      board.nodes.map((n) => n.data.reader),
    );
    const copy = store.duplicate(board.id);
    assert.deepEqual(
      copy.nodes.map((n) => n.data.reader),
      board.nodes.map((n) => n.data.reader),
    );
    assert.equal(copy.nodes[0].data.filename, 'original.epub');
    assert.equal(copy.nodes[0].data.caption, 'Separate user notes');
    assert.equal(copy.nodes[0].data.assetId, assetId);
    store.remove(copy.id);
    assert.equal(
      store.db.prepare('SELECT checksum FROM assets WHERE id=?').get(assetId).checksum,
      'unchanged-original-checksum',
    );
    for (const reader of [{ page: 0 }, { page: 1.5 }, { cfi: 'javascript:alert(1)' }, { zoom: 20 }])
      assert.throws(() => nodeSchema.parse({ ...node, data: { ...node.data, reader } }));
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
