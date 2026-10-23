import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
for (const name of await readdir('release')) {
  if (!/\.(AppImage|exe)$/.test(name)) continue;
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(path.join('release',name))) hash.update(chunk);
  await writeFile(path.join('release',name+'.sha256'),hash.digest('hex')+'  '+name+'\n');
}
