import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const failures=[];
const privatePatterns=[/\b[\w.-]+\.(?:lan|internal)\b/i,/\/(?:home|root)\/[a-z][a-z0-9_-]*\//i,/192\.168\.\d+\.\d+/,/intelboard_session=[a-f0-9]{32,}/i,/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16})\b/];
const forbidden=/(^|\/)(\.env(?:\..*)?|data|test-results|trace\.zip|intelboard\.sqlite.*|Dockerfile.*|compose.*\.ya?ml|HANDOFF\.md|AGENTS\.md|\.git)(\/|$)/i;
async function check(file,relative=file,dependency=false) {
  if(forbidden.test(relative))failures.push('Forbidden distribution path: '+relative);
  if(!dependency && /\.(?:js|cjs|mjs|ts|tsx|css|json|html|md|txt|ya?ml|svg)$/.test(file)) {
    const content=await readFile(file,'utf8');
    if(privatePatterns.some(pattern=>pattern.test(content)))failures.push('Private marker in: '+relative);
  }
}
async function walk(dir,dependency=false) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const file=path.join(dir,entry.name);
    if(entry.isDirectory())await walk(file,dependency||entry.name==='node_modules');
    else await check(file,file,dependency);
  }
}
// The curated Git index is the source-release boundary; no dependency folders or build caches.
const tracked=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!tracked.length)throw new Error('Stage the curated source tree before auditing');
for(const file of tracked) await check(file);
await walk('dist');
const asar=await import('@electron/asar');
let inspected=0;
for (const archive of ['release/linux-unpacked/resources/app.asar','release/win-unpacked/resources/app.asar',process.env.INTELBOARD_AUDIT_ARCHIVE].filter(Boolean)) {
  try { await stat(archive); } catch { continue; }
  const entries=asar.listPackage(archive);
  for(const file of entries) {
    const relative=file.replace(/^\//,'');
    if(forbidden.test(relative))failures.push('Forbidden package path: '+relative);
    if(!relative.startsWith('node_modules/') && /\.(js|cjs|mjs|json|html|css|txt)$/.test(relative)) {
      try {const content=asar.extractFile(archive,relative).toString();if(privatePatterns.some(pattern=>pattern.test(content)))failures.push('Private marker in package: '+relative);}catch{ }
    }
  }
  inspected++;console.log(`Reviewed ${entries.length} packaged paths in ${archive}.`);
}
if(!inspected)console.log('Packaged archive not present; source and dist reviewed only.');
if(failures.length)throw new Error(failures.join('\n'));
console.log(`Privacy allowlist audit passed: ${tracked.length} source files plus production dist. Dependency license content is excluded from personal-marker matching.`);
