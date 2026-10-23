import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function openStore(dir) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'intelboard.sqlite'));
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) { db.close(); throw new Error('This workspace was created by a newer IntelBoard version. Install that version to open it.'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,viewport TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS elements(id TEXT NOT NULL,board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,content TEXT NOT NULL,PRIMARY KEY(board_id,id));
    CREATE TABLE IF NOT EXISTS connections(id TEXT NOT NULL,board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,content TEXT NOT NULL,PRIMARY KEY(board_id,id));
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,filename TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,checksum TEXT NOT NULL,thumbnail TEXT,width INTEGER,height INTEGER,preview TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_refs(board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,element_id TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES assets(id),PRIMARY KEY(board_id,element_id,asset_id));
    CREATE INDEX IF NOT EXISTS asset_refs_asset ON asset_refs(asset_id);

    PRAGMA user_version=1;`);
  let inTransaction = false;
  const transaction = (fn) => {
    if (inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally { inTransaction = false; }
  };
  const get = (id) => {
    const b = db.prepare('SELECT * FROM boards WHERE id=?').get(id);
    if (!b) return null;
    return {
      ...b,
      viewport: JSON.parse(b.viewport),
      nodes: db
        .prepare('SELECT content FROM elements WHERE board_id=? ORDER BY rowid')
        .all(id)
        .map((x) => JSON.parse(x.content)),
      edges: db
        .prepare('SELECT content FROM connections WHERE board_id=? ORDER BY rowid')
        .all(id)
        .map((x) => JSON.parse(x.content)),
    };
  };
  const list = () =>
    db
      .prepare('SELECT * FROM boards ORDER BY updated_at DESC')
      .all()
      .map((b) => ({
        ...b,
        viewport: JSON.parse(b.viewport),
        nodes: db
          .prepare('SELECT content FROM elements WHERE board_id=? ORDER BY rowid LIMIT 80')
          .all(b.id)
          .map((x) => JSON.parse(x.content)),
        count: db.prepare('SELECT COUNT(*) as n FROM elements WHERE board_id=?').get(b.id).n,
      }));
  const create = (title = 'Untitled board') => {
    const id = randomUUID(),
      now = new Date().toISOString();
    db.prepare('INSERT INTO boards(id,title,created_at,updated_at,viewport) VALUES(?,?,?,?,?)').run(
      id,
      title,
      now,
      now,
      JSON.stringify({ x: 100, y: 100, zoom: 1 }),
    );
    return get(id);
  };
  const save = (id, board) =>
    transaction(() => {
      const old = get(id);
      if (!old) throw Object.assign(new Error('Board not found'), { status: 404 });
      if (board.revision !== old.revision)
        throw Object.assign(
          new Error(
            'This board changed in another tab. Reload before editing; your local draft has been kept.',
          ),
          { status: 409 },
        );
      const now = new Date().toISOString();
      db.prepare(
        'UPDATE boards SET title=?,viewport=?,updated_at=?,revision=revision+1 WHERE id=?',
      ).run(board.title, JSON.stringify(board.viewport), now, id);
      db.prepare('DELETE FROM asset_refs WHERE board_id=?').run(id);
      db.prepare('DELETE FROM elements WHERE board_id=?').run(id);
      db.prepare('DELETE FROM connections WHERE board_id=?').run(id);
      const insert = db.prepare('INSERT INTO elements(id,board_id,content) VALUES(?,?,?)');
      for (const n of board.nodes) {
        insert.run(n.id, id, JSON.stringify(n));
        for (const asset of new Set(
          [n.data.assetId, n.data.thumbnailId, n.data.faviconId].filter(Boolean),
        )) {
          if (!db.prepare('SELECT id FROM assets WHERE id=?').get(asset))
            throw Object.assign(
              new Error('An element references a missing file. Re-upload the file before saving.'),
              { status: 400 },
            );
          db.prepare('INSERT INTO asset_refs VALUES(?,?,?)').run(id, n.id, asset);
        }
      }
      for (const e of board.edges)
        db.prepare('INSERT INTO connections VALUES(?,?,?)').run(e.id, id, JSON.stringify(e));
      return { revision: old.revision + 1, updated_at: now };
    });
  const duplicate = (id) =>
    transaction(() => {
      const original = get(id);
      if (!original) return null;
      const copy = create((original.title + ' — copy').slice(0, 200));
      const ids = new Map(original.nodes.map((n) => [n.id, randomUUID()]));
      // Inline the save transaction to keep duplication atomic without nested transactions.
      const groups = new Map(original.nodes.filter(n => n.data.groupId).map(n => [n.data.groupId, randomUUID()]));
      const nodes = original.nodes.map((n) => ({ ...n, id: ids.get(n.id), data: { ...n.data, ...(n.data.groupId ? { groupId: groups.get(n.data.groupId) } : {}) } }));
      for (const n of nodes)
        db.prepare('INSERT INTO elements VALUES(?,?,?)').run(n.id, copy.id, JSON.stringify(n));
      for (const e of original.edges) {
        const edgeId = randomUUID();
        db.prepare('INSERT INTO connections VALUES(?,?,?)').run(
          edgeId,
          copy.id,
          JSON.stringify({
            ...e,
            id: edgeId,
            source: ids.get(e.source),
            target: ids.get(e.target),
          }),
        );
      }
      for (const r of db.prepare('SELECT * FROM asset_refs WHERE board_id=?').all(id))
        db.prepare('INSERT INTO asset_refs VALUES(?,?,?)').run(
          copy.id,
          ids.get(r.element_id),
          r.asset_id,
        );
      db.prepare('UPDATE boards SET viewport=? WHERE id=?').run(
        JSON.stringify(original.viewport),
        copy.id,
      );
      return get(copy.id);
    });
  return {
    db,
    get,
    list,
    create,
    save,
    duplicate,
    remove: (id) => db.prepare('DELETE FROM boards WHERE id=?').run(id),
    transaction,
  };
}
