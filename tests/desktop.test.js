import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import JSZip from 'jszip';
import yauzl from 'yauzl';
import { createService } from '../desktop/service.js';
import { exportBoards, importBoards } from '../desktop/transfer.js';
import { createProtocol, ORIGIN } from '../desktop/protocol.js';
import { readBoundedZip } from '../desktop/zip.js';
const setup=async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'intelboard-test-'));
  const service=createService(dir);
  t.after(async()=>{service.close();await rm(dir,{recursive:true,force:true});});
  return {service,dir};
};
const node=(data,id=randomUUID())=>({id,type:'research',position:{x:123,y:-456},style:{width:320,height:240},data});
test('empty offline desktop, revision conflicts and transactional rollback',async t=>{
  const {service}=await setup(t);
  assert.deepEqual(await service.request('/boards'),[]);
  const board=await service.request('/boards','POST',{title:'Synthetic research'});
  const saved={...board,nodes:[node({kind:'note',text:'<script> stays plain',formats:{text:[{start:0,end:8,style:1}]}})]};
  assert.equal((await service.request('/boards/'+board.id,'PUT',saved)).revision,1);
  await assert.rejects(service.request('/boards/'+board.id,'PUT',saved),{status:409});
  const invalid={...service.store.get(board.id),nodes:[node({kind:'file',assetId:randomUUID()})]};
  await assert.rejects(service.request('/boards/'+board.id,'PUT',invalid));
  assert.equal(service.store.get(board.id).nodes[0].data.text,'<script> stays plain');
  assert.equal(service.store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});
test('portable board/workspace export preserves bytes, reader position, groups, edges, previews and formats',async t=>{
  const {service,dir}=await setup(t);
  const png=await sharp({create:{width:4,height:3,channels:4,background:'#abcdef'}}).png().toBuffer();
  const asset=await service.request('/assets','POST',{bytes:png,filename:'synthetic.png',mime:'image/png'});
  const group=randomUUID(),a=node({kind:'image',assetId:asset.id,thumbnailId:asset.id,groupId:group,caption:'Synthetic image'}),b=node({kind:'file',assetId:asset.id,groupId:group,reader:{page:2,zoom:1.5}});
  const board=service.store.create('Portable synthetic board');
  board.nodes=[a,b];board.edges=[{id:randomUUID(),source:a.id,target:b.id,type:'research',label:'Evidence',data:{directed:true,labelFormat:[{start:0,end:8,style:1}]}}];
  board.viewport={x:50,y:-90,zoom:.75};service.store.save(board.id,board);
  const source=path.join(dir,'board.intelboard');await exportBoards(service,[board.id],source);
  const imported=await importBoards(service,source);const copy=service.store.get(imported[0]);
  assert.notEqual(copy.id,board.id);assert.notEqual(copy.nodes[0].id,a.id);assert.notEqual(copy.nodes[0].data.groupId,group);
  assert.equal(copy.nodes[0].data.groupId,copy.nodes[1].data.groupId);
  assert.deepEqual(copy.viewport,board.viewport);assert.deepEqual(copy.nodes[1].data.reader,b.data.reader);
  assert.equal(copy.edges[0].source,copy.nodes[0].id);assert.equal(copy.edges[0].data.directed,true);
  assert.notEqual(copy.nodes[0].data.assetId,asset.id);
  assert.deepEqual(await readFile(path.join(service.assets.folder,copy.nodes[0].data.assetId)),png);
  await importBoards(service,source);assert.equal(service.store.list().length,3);
  const workspace=path.join(dir,'all.intelboard');await exportBoards(service,service.store.list().map(b=>b.id),workspace);
  assert.equal((await importBoards(service,workspace)).length,3);
});
test('archives reject traversal, unexpected entries, missing payloads, checksums and forged expansion sizes without modifying boards',async t=>{
  const {service,dir}=await setup(t);
  const board=service.store.create('Synthetic');board.nodes=[node({kind:'note',text:'keep'})];service.store.save(board.id,board);
  const source=path.join(dir,'board.intelboard');await exportBoards(service,[board.id],source);
  const valid=await readFile(source);
  for(const name of ['../escape','assets/../../escape','unlisted.txt']) {
    const zip=await JSZip.loadAsync(valid);zip.file(name,'bad');await writeFile(source,await zip.generateAsync({type:'nodebuffer'}));
    await assert.rejects(importBoards(service,source));assert.equal(service.store.list().length,1);
  }
  const bomb=new JSZip();bomb.file('a.txt',Buffer.alloc(1024*1024));
  const forged=await bomb.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const central=forged.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));forged.writeUInt32LE(1,central+24);
  await assert.rejects(readBoundedZip(forged,{maxEntry:4096,maxTotal:4096}));
  const zip=await JSZip.loadAsync(valid);const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
  manifest.version=999;zip.file('manifest.json',JSON.stringify(manifest));await writeFile(source,await zip.generateAsync({type:'nodebuffer'}));
  await assert.rejects(importBoards(service,source));assert.equal(service.store.list().length,1);
});
test('assets stream ranges, reject active image spoofing and block filesystem traversal',async t=>{
  const {service,dir}=await setup(t);
  const bytes=Buffer.from('<script>unsafe()</script>');
  const asset=await service.request('/assets','POST',{bytes,filename:'forged.png',mime:'image/png'});
  assert.equal(asset.thumbnail,null);
  const handler=createProtocol(service,path.join(dir,'dist'));
  const req=(url,options)=>new Request(ORIGIN+url,options);
  const response=await handler(req('/api/assets/'+asset.id+'?inline=1',{headers:{Range:'bytes=1-5'}}));
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'application/octet-stream');assert.equal(await response.text(),bytes.subarray(1,6).toString());
  assert.equal((await handler(req('/api/assets/'+asset.id,{headers:{Range:'bytes=999-'}}))).status,416);
  assert.equal((await handler(req('/%2e%2e%2fpackage.json'))).status,403);
  const before=service.store.list().length;await assert.rejects(service.request('/boards/not-a-uuid'));assert.equal(service.store.list().length,before);
});
test('metadata fails gracefully offline/private and never blocks local editing',async t=>{
  const {service}=await setup(t);
  const capture=await service.request('/metadata','POST',{url:'http://127.0.0.1/'});
  assert.match(capture.captureStatus,/blocked/);assert.equal(capture.url,'http://127.0.0.1/');
  assert.ok((await service.request('/boards','POST',{title:'Still works'})).id);
});
test('import cannot bypass EPUB limits by disagreeing with attachment metadata',async t=>{
  const {service,dir}=await setup(t);
  const forgedBook=new JSZip();forgedBook.file('chapter.xhtml','Synthetic');
  const bytes=await forgedBook.generateAsync({type:'nodebuffer'});
  // A text attachment is legitimate, but must not become an unchecked EPUB on import.
  const asset=await service.assets.add(Buffer.from('not a zip'),'safe.txt','text/plain');
  const b=service.store.create('Synthetic inconsistent metadata');
  b.nodes=[node({kind:'file',assetId:asset.id,filename:'book.epub',mime:'application/epub+zip'})];service.store.save(b.id,b);
  const file=path.join(dir,'inconsistent.intelboard');await exportBoards(service,[b.id],file);
  await assert.rejects(importBoards(service,file));assert.equal(service.store.list().length,1);
  await assert.rejects(service.request('/assets/'+asset.id+'/validate-epub'));
});
test('shared EPUB references across boards validate per distinct asset and preserve every reference',async t=>{
  const {service,dir}=await setup(t);
  const book=new JSZip();book.file('chapter.xhtml','Synthetic shared chapter');
  const bytes=await book.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  // Identical bytes under distinct IDs still need separate validation. The second
  // attachment is identified as EPUB only by a later node's presentation metadata.
  const assets=[await service.assets.add(bytes,'book.epub','application/epub+zip'),await service.assets.add(bytes,'attachment.bin','application/octet-stream')];
  const boards=Array.from({length:2},(_,i)=>{
    const b=service.store.create('Shared book '+i);
    b.nodes=Array.from({length:40},(_,j)=>node({kind:'file',assetId:assets[j%2].id,...(j<2?{filename:'attachment.bin',mime:'application/octet-stream'}:{filename:'book.epub',mime:'application/epub+zip'})}));
    service.store.save(b.id,b);return b;
  });
  const file=path.join(dir,'shared.intelboard');await exportBoards(service,boards.map(b=>b.id),file);
  const original=yauzl.fromBuffer;let inflations=0;
  yauzl.fromBuffer=function(input,...args){if(input.equals(bytes))inflations++;return original.call(this,input,...args);};
  let imported;
  try {imported=await importBoards(service,file);} finally {yauzl.fromBuffer=original;}
  assert.equal(inflations,3,'Two node-derived validations and one independent asset-side validation, regardless of reference count');
  assert.equal(imported.length,2);
  const copies=imported.map(id=>service.store.get(id));
  assert.equal(copies[0].nodes.length,40);assert.equal(copies[1].nodes.length,40);
  const ids=new Set(copies.flatMap(b=>b.nodes.map(n=>n.data.assetId)));
  assert.equal(ids.size,2);
  for(const id of ids){assert.ok(!assets.some(a=>a.id===id));assert.deepEqual(await readFile(path.join(service.assets.folder,id)),bytes);}
});
test('attachment matching traverses shared node references once rather than once per asset',async t=>{
  const {service,dir}=await setup(t);
  const assets=[];
  for(let i=0;i<24;i++)assets.push(await service.assets.add(Buffer.from('Synthetic '+i),'file.txt','text/plain'));
  const b=service.store.create('Many shared attachments');
  b.nodes=Array.from({length:96},(_,i)=>node({kind:'file',assetId:assets[i%assets.length].id}));service.store.save(b.id,b);
  const file=path.join(dir,'references.intelboard');await exportBoards(service,[b.id],file);
  const original=Array.prototype.flatMap;let nodeVisits=0;
  Array.prototype.flatMap=function(callback,...args){
    if(this[0]?.type==='research' && this[0]?.data)nodeVisits+=this.length;
    return original.call(this,callback,...args);
  };
  let imported;
  try {imported=await importBoards(service,file);} finally {Array.prototype.flatMap=original;}
  assert.equal(nodeVisits,b.nodes.length,'Reference matching work must be independent of attachment count');
  assert.equal(service.store.get(imported[0]).nodes.length,b.nodes.length);
});
test('mixed generic and EPUB references reject invalid bytes before any writes in either order',async t=>{
  const {service,dir}=await setup(t);
  const asset=await service.assets.add(Buffer.from('Synthetic non-ZIP'),'attachment.bin','application/octet-stream');
  const b=service.store.create('Mixed metadata');
  for(const reverse of [false,true]){
    b.nodes=[node({kind:'file',assetId:asset.id,filename:'attachment.bin'}),node({kind:'file',assetId:asset.id,filename:'book.EPUB'})];
    if(reverse)b.nodes.reverse();
    service.store.save(b.id,{...b,revision:service.store.get(b.id).revision});
    const file=path.join(dir,'mixed.intelboard');await exportBoards(service,[b.id],file);
    await assert.rejects(importBoards(service,file));
    assert.equal(service.store.list().length,1);
    assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  }
});
test('future database versions are preserved and long titles duplicate within the public schema',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'intelboard-version-'));
  try {
    const service=createService(dir);const original=service.store.create('A'.repeat(200));
    const copy=service.store.duplicate(original.id);assert.equal(copy.title.length,200);
    service.store.db.exec('PRAGMA user_version=99');service.close();
    assert.throws(()=>createService(dir),/newer IntelBoard/);
    const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(path.join(dir,'intelboard.sqlite'));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);assert.equal(db.prepare('SELECT count(*) AS n FROM boards').get().n,2);db.close();
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('corrupt or omitted payloads fail before adding assets or boards',async t=>{
  const {service,dir}=await setup(t);const asset=await service.assets.add(Buffer.from('synthetic file'),'fixture.txt','text/plain');
  const b=service.store.create('Checksum test');b.nodes=[node({kind:'file',assetId:asset.id,filename:'fixture.txt'})];service.store.save(b.id,b);
  const file=path.join(dir,'checksums.intelboard');await exportBoards(service,[b.id],file);const valid=await readFile(file);
  for(const corrupt of [true,false]) {
    const zip=await JSZip.loadAsync(valid);
    if(corrupt)zip.file('assets/'+asset.id,'changed content',{createFolders:false});else zip.remove('assets/'+asset.id);
    await writeFile(file,await zip.generateAsync({type:'nodebuffer'}));await assert.rejects(importBoards(service,file));
    assert.equal(service.store.list().length,1);assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM assets').get().n,1);
  }
});
