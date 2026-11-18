import {
  assetIdForHash,
  manifestSchema,
} from "../../shared/collaboration/assets.js";
export {
  assetIdForHash,
  manifestSchema,
} from "../../shared/collaboration/assets.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "../files.js";

export class CollaborationMedia {
  constructor(service, dir) {
    this.service = service;
    this.partialDir = path.join(dir, "collaboration", "downloads");
    this.locks = new Set();
  }
  async local(id) {
    const asset = this.service.assets.get(id);
    if (!asset) throw new Error("Local attachment not found");
    const manifest = manifestSchema.parse({
      id: assetIdForHash(asset.checksum),
      hash: asset.checksum,
      size: asset.size,
      filename: asset.filename.replace(/[\\/\x00]/g, "_"),
      mime: asset.mime,
    });
    if (!this.service.assets.get(manifest.id)) {
      const original = path.join(this.service.assets.folder, id),
        target = path.join(this.service.assets.folder, manifest.id);
      await link(original, target).catch(async (error) => {
        if (error.code !== "EEXIST")
          await atomicWrite(target, await readFile(original));
      });
      const thumbnail = asset.thumbnail ? manifest.id + ".webp" : null;
      if (thumbnail)
        await link(
          path.join(this.service.assets.folder, asset.thumbnail),
          path.join(this.service.assets.folder, thumbnail),
        ).catch(async (error) => {
          if (error.code !== "EEXIST")
            await atomicWrite(
              path.join(this.service.assets.folder, thumbnail),
              await readFile(
                path.join(this.service.assets.folder, asset.thumbnail),
              ),
            );
        });
      this.service.store.db
        .prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          manifest.id,
          asset.filename,
          asset.mime,
          asset.size,
          asset.checksum,
          thumbnail,
          asset.width,
          asset.height,
          asset.preview,
          asset.created_at,
        );
    }
    if (!this.complete(manifest))
      throw new Error(
        "Attachment identifier collision; existing files were preserved",
      );
    return manifest;
  }
  async prepare(board) {
    const manifests = new Map(),
      ids = new Map();
    for (const node of board.nodes)
      for (const key of ["assetId", "thumbnailId", "faviconId"]) {
        const id = node.data[key];
        if (!id || ids.has(id)) continue;
        const manifest = await this.local(id);
        manifests.set(manifest.id, manifest);
        ids.set(id, manifest.id);
      }
    return {
      board: {
        ...board,
        nodes: board.nodes.map((n) => ({
          ...n,
          data: Object.fromEntries(
            Object.entries(n.data).map(([key, value]) => [
              key,
              ["assetId", "thumbnailId", "faviconId"].includes(key) &&
              ids.has(value)
                ? ids.get(value)
                : value,
            ]),
          ),
        })),
      },
      manifests: [...manifests.values()],
    };
  }
  authorize(docId, manifest) {
    this.service.store.db
      .prepare("INSERT OR IGNORE INTO collab_asset_access VALUES(?,?)")
      .run(docId, manifest.hash);
  }
  complete(manifest, docId) {
    if (
      docId &&
      !this.service.store.db
        .prepare("SELECT 1 FROM collab_asset_access WHERE doc_id=? AND hash=?")
        .get(docId, manifest.hash)
    )
      return false;
    const existing = this.service.assets.get(manifest.id);
    return (
      !!existing &&
      existing.checksum === manifest.hash &&
      existing.size === manifest.size
    );
  }
  async withWrite(manifest, operation) {
    if (this.locks.has(manifest.hash))
      throw new Error("This attachment already has an active write");
    this.locks.add(manifest.hash);
    try {
      return await operation();
    } finally {
      this.locks.delete(manifest.hash);
    }
  }
  async resume(manifest, docId) {
    manifest = manifestSchema.parse(manifest);
    return this.withWrite(manifest, () => this.resumeLocked(manifest, docId));
  }
  async resumeLocked(manifest, docId) {
    if (this.complete(manifest, docId)) return manifest.size;
    await mkdir(this.partialDir, { recursive: true, mode: 0o700 });
    const same =
      !docId &&
      this.service.store.db
        .prepare("SELECT id FROM assets WHERE checksum=? AND size=? LIMIT 1")
        .get(manifest.hash, manifest.size);
    if (same) {
      await this.local(same.id);
      await this.finish(manifest, docId);
      return manifest.size;
    }
    const filename = path.join(this.partialDir, manifest.hash + ".part");
    const saved = this.service.store.db
      .prepare("SELECT * FROM collab_downloads WHERE hash=?")
      .get(manifest.hash);
    const info = await stat(filename).catch(() => null);
    let received = saved?.received || 0;
    if (info && info.size > received && received <= manifest.size) {
      const file = await open(filename, "r+");
      try {
        await file.truncate(received);
        await file.sync();
      } finally {
        await file.close();
      }
    } else if (!info || info.size !== received || received > manifest.size) {
      await unlink(filename).catch(() => {});
      received = 0;
    }
    this.service.store.db
      .prepare(
        "INSERT INTO collab_downloads VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET manifest=excluded.manifest,received=excluded.received",
      )
      .run(manifest.hash, JSON.stringify(manifest), received);
    if (received === manifest.size) await this.finalize(manifest, docId);
    return received;
  }
  async chunk(manifest, offset, bytes, docId) {
    manifest = manifestSchema.parse(manifest);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 1 ||
      bytes.length > 64 * 1024 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset + bytes.length > manifest.size
    )
      throw new Error("Invalid attachment chunk");
    return this.withWrite(manifest, async () => {
      const expected = await this.resumeLocked(manifest, docId);
      if (expected === manifest.size)
        return { received: expected, complete: true };
      if (expected !== offset) return { received: expected, complete: false };
      const filename = path.join(this.partialDir, manifest.hash + ".part");
      const file = await open(filename, offset ? "r+" : "w", 0o600);
      try {
        let written = 0;
        while (written < bytes.length) {
          const { bytesWritten } = await file.write(
            bytes,
            written,
            bytes.length - written,
            offset + written,
          );
          if (!bytesWritten) throw new Error("Attachment write did not finish");
          written += bytesWritten;
        }
        await file.sync();
      } finally {
        await file.close();
      }
      const received = offset + bytes.length;
      this.service.store.db
        .prepare("UPDATE collab_downloads SET received=? WHERE hash=?")
        .run(received, manifest.hash);
      if (received !== manifest.size) return { received, complete: false };
      await this.finalize(manifest, docId);
      return { received, complete: true };
    });
  }
  async finalize(manifest, docId) {
    const filename = path.join(this.partialDir, manifest.hash + ".part");
    const buffer = await readFile(filename);
    if (
      buffer.length !== manifest.size ||
      createHash("sha256").update(buffer).digest("hex") !== manifest.hash
    ) {
      this.service.store.db
        .prepare("DELETE FROM collab_downloads WHERE hash=?")
        .run(manifest.hash);
      await unlink(filename).catch(() => {});
      throw new Error(
        "Attachment integrity check failed; it will be downloaded again.",
      );
    }
    // Decode and validate through the normal attachment import path.
    const registered = await this.service.assets.add(
      buffer,
      manifest.filename,
      manifest.mime,
    );
    try {
      await this.local(registered.id);
      await this.finish(manifest, docId);
    } finally {
      await this.service.assets.remove(registered.id).catch(() => {});
    }
  }
  async finish(manifest, docId) {
    const { db, transaction } = this.service.store;
    transaction(() => {
      if (docId) {
        this.authorize(docId, manifest);
        db.prepare(
          `INSERT OR IGNORE INTO asset_refs
           SELECT elements.board_id,elements.id,? FROM elements
           JOIN collab_boards ON collab_boards.board_id=elements.board_id
           WHERE doc_id=? AND (
             json_extract(content,'$.data.assetId')=? OR
             json_extract(content,'$.data.thumbnailId')=? OR
             json_extract(content,'$.data.faviconId')=?
           )`,
        ).run(manifest.id, docId, manifest.id, manifest.id, manifest.id);
      }
      db.prepare("DELETE FROM collab_downloads WHERE hash=?").run(
        manifest.hash,
      );
    });
    await unlink(path.join(this.partialDir, manifest.hash + ".part")).catch(
      () => {},
    );
  }
  async read(manifest, offset, docId) {
    manifest = manifestSchema.parse(manifest);
    if (
      !this.complete(manifest, docId) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= manifest.size
    )
      throw new Error("Attachment not available");
    const file = await open(
      path.join(this.service.assets.folder, manifest.id),
      "r",
    );
    try {
      const buffer = Buffer.alloc(Math.min(64 * 1024, manifest.size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }
}
