import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require=createRequire(import.meta.url),root=path.resolve('.');
const manifest=JSON.parse(await readFile('package.json','utf8'));
const seen=new Set(),notices=[];
async function visit(name,parent=root) {
  let file;
  try { file=require.resolve(name+(name.startsWith('@img/')?'/package':'/package.json'),{paths:[parent]}); }
  catch { let dir=path.dirname(require.resolve(name,{paths:[parent]}));while(dir!==path.dirname(dir)){try{const p=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));if(p.name===name){file=path.join(dir,'package.json');break;}}catch{}dir=path.dirname(dir);} }
  if(!file||seen.has(file))return;seen.add(file);
  const dir=path.dirname(file),pkg=JSON.parse(await readFile(file,'utf8'));
  const licenses=(await readdir(dir)).filter(n=>/^(license|licence|copying|notice|copyright)([.\-_]|$)/i.test(n));
  let text=`${pkg.name}@${pkg.version}\nLicense: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license||'see package files')}\n`;
  for(const name of licenses) {try{text+='\n'+name+'\n'+await readFile(path.join(dir,name),'utf8');}catch{}}
  if (pkg.name.startsWith('@img/')) { try { text+='\nNative library attribution (README.md)\n'+await readFile(path.join(dir,'README.md'),'utf8'); } catch {} }
  notices.push(text);
  for(const dependency of Object.keys({...pkg.dependencies,...pkg.optionalDependencies})) {try{await visit(dependency,dir);}catch{ /* Optional packages for other architectures are not bundled here. */ }}
}
for(const name of Object.keys(manifest.dependencies))await visit(name);
await visit('electron');
const nativeTerms=await readFile('licenses/LGPL-3.0.txt','utf8')+'\n\n'+await readFile('licenses/GPL-3.0.txt','utf8');
await writeFile('THIRD_PARTY_NOTICES.txt','IntelBoard third-party notices\n\nElectron/Chromium license files are also distributed beside the application.\nEach release provides a dependency-sources.zip companion with native-library source archives, patches and recipes. licenses/native-sources.json records the source URLs and SHA-256 checksums. You may replace the dynamically loaded native libraries and debug such modifications under their licenses.\nSharp/libvips carries LGPL components; see node_modules/@img/sharp-libvips-*/versions.json and README.md in the packaged app for exact library versions and source project links.\n\n'+nativeTerms+'\n\n'+notices.sort().join('\n\n'+'='.repeat(72)+'\n\n'));
console.log(`Generated notices for ${seen.size} installed packages. Run on each target platform before packaging.`);
