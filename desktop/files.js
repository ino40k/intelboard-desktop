import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
export async function atomicWrite(destination, bytes) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await rename(temporary, destination);
    // On POSIX this also makes the directory entry durable. Windows may reject directory fsync.
    try { const dir = await open(path.dirname(destination), 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch { }
  } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
}
