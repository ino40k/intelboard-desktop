import assert from 'node:assert/strict';
import sharp from 'sharp';
import JSZip from 'jszip';
import { Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exportBoards, importBoards } from './transfer.js';
export async function runSmoke(window, service, dir) {
  const errors=[]; console.log('smoke: startup');
  window.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const js=async code=>{try{return await window.webContents.executeJavaScript(code,true);}catch(error){throw new Error(error.message+'; expression: '+code+'; renderer errors: '+errors.join(' | '));}};
  async function wait(code) {
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}
    throw new Error('Timed out: '+code+'; body: '+await js('document.body.innerText')+'; reader frames: '+JSON.stringify(await js(`Array.from(document.querySelectorAll('.epub-viewport iframe')).map(f=>({width:f.clientWidth,height:f.clientHeight,visibility:getComputedStyle(f).visibility,state:f.contentDocument?.readyState,text:f.contentDocument?.body?.innerText}))`))+'; renderer errors: '+errors.join(' | '));
  }
  await wait('!!document.querySelector(".library, .workspace")');
  console.log('smoke: workspace loaded');
  assert.equal(await js('typeof window.require'),'undefined');
  assert.equal(await js('typeof window.intelboard.request'),'function');
  // Offline local resources, native bridge and actual React UI.
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
  let board=service.store.list().find(b=>b.title==='Synthetic desktop smoke');
  if(!board) {
    await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('New board')).click()`);
    await wait('!!document.querySelector("dialog input")');
    await js(`(()=>{const i=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Synthetic desktop smoke');i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await js(`document.querySelector('dialog form').requestSubmit()`);
    await wait('!!document.querySelector(".workspace")');
    await js(`document.querySelector('[aria-label="Add note (N)"]').click()`);
    await wait(`!!document.querySelector('[contenteditable=true]') && getComputedStyle(document.querySelector('[contenteditable=true]').closest('.react-flow__node')).visibility!=='hidden'`);
    await js(`document.querySelector('[contenteditable=true]').focus()`);
    console.log('smoke: note editor focused');

    for (const character of 'Synthetic offline note') {
      await window.webContents.insertText(character);
      if(character==='S') console.log('smoke: first character inserted');
      // A fully hidden Windows window may pause animation frames. Wait on the
      // main-process clock so the caret assertion still runs after React updates.
      await new Promise(resolve=>setTimeout(resolve,60));
      const caret = await js(`(()=>{
        const e=document.querySelector('[contenteditable=true]'),s=getSelection(),r=s.getRangeAt(0).cloneRange();
        r.selectNodeContents(e);r.setEnd(s.anchorNode,s.anchorOffset);
        return {text:e.textContent,offset:r.toString().length};
      })()`);
      assert.equal(caret.offset,caret.text.length,'Typing must leave the cursor after the inserted character: '+JSON.stringify(caret));
    }
    // Emptying an existing editor must not bring the first-character bug back.
    await js(`(()=>{const e=document.querySelector('[contenteditable=true]'),r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
    await js(`document.execCommand('delete')`);
    assert.equal(await js(`document.querySelector('[contenteditable=true]').textContent`),'');
    await window.webContents.insertText('R');
    await window.webContents.insertText('e');
    assert.equal(await js(`document.querySelector('[contenteditable=true]').textContent`),'Re');
    // Restore the expected persisted phrase through native typing, not DOM mutation.
    await js(`(()=>{const e=document.querySelector('[contenteditable=true]'),r=document.createRange();r.selectNodeContents(e);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
    await window.webContents.insertText('Synthetic offline note');
    await new Promise(r=>setTimeout(r,100));
    await js(`document.querySelector('[contenteditable=true]')?.blur()`);
    const deadline=Date.now()+10000;
    while(Date.now()<deadline) {
      const b=service.store.list()[0];
      if(b && service.store.get(b.id).nodes[0]?.data.text==='Synthetic offline note')break;
      await new Promise(r=>setTimeout(r,100));
    }
    board=service.store.list()[0];
    assert.equal(service.store.get(board.id).nodes[0].data.text,'Synthetic offline note');
  } else {
    // Startup restores the last opened board after process restart.
    await wait('!!document.querySelector(".workspace")');
    assert.equal(service.store.get(board.id).nodes[0].data.text,'Synthetic offline note');
  }
  console.log('smoke: note persisted');
  if(service.store.get(board.id).nodes.length===1) {
    await js(`document.querySelector('[aria-label="Add note (N)"]').click()`);
    await wait(`document.querySelectorAll('.react-flow__node').length===2`);
    await wait(`!!document.querySelector('[contenteditable=true]')`);
    // Exit text editing explicitly before exercising canvas-level Undo/Redo.
    await js(`document.querySelector('[contenteditable=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
    await wait(`!document.querySelector('[contenteditable=true]')`);
    Menu.getApplicationMenu().getMenuItemById('undo').click();
    await wait(`document.querySelectorAll('.react-flow__node').length===1`);
    Menu.getApplicationMenu().getMenuItemById('redo').click();
    await wait(`document.querySelectorAll('.react-flow__node').length===2`);
    Menu.getApplicationMenu().getMenuItemById('undo').click();
    await wait(`document.querySelectorAll('.react-flow__node').length===1`);
    Menu.getApplicationMenu().getMenuItemById('select-all').click();
    await wait(`document.querySelectorAll('.react-flow__node.selected').length===1`);
  }
  const png=await sharp({create:{width:10,height:10,channels:4,background:'#abcdef'}}).png().toBuffer();
  const asset=await service.assets.add(png,'synthetic.png','image/png');
  const loaded=await js(`fetch('/api/assets/${asset.id}?preview=1').then(r=>({status:r.status,type:r.headers.get('content-type')}))`);
  assert.equal(loaded.status,200);assert.equal(loaded.type,'image/webp');
  console.log('smoke: native asset response');
  await js(`new Promise((resolve,reject)=>{setTimeout(()=>reject(new Error('Image load timed out')),5000);const image=new Image();image.onload=()=>resolve(true);image.onerror=reject;image.src='/api/assets/${asset.id}?preview=1';})`);
  console.log('smoke: image decoded');
  const output=path.join(dir,'smoke.intelboard');await exportBoards(service,[board.id],output);await importBoards(service,output);
  console.log('smoke: transfer passed');
  const pdfObjects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 53 >>\nstream\nBT /F1 18 Tf 30 200 Td (Synthetic PDF) Tj ET\nendstream',
  ];
  let pdf='%PDF-1.4\n', offsets=[0];
  for(let i=0;i<pdfObjects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${pdfObjects[i]}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pdfAsset=await service.assets.add(Buffer.from(pdf),'synthetic.pdf','application/pdf');
  const epub=new JSZip();
  epub.file('mimetype','application/epub+zip');
  epub.file('META-INF/container.xml','<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  epub.file('book.opf','<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">synthetic</dc:identifier><dc:title>Synthetic EPUB</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="n" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="c"/></spine></package>');
  epub.file('chapter.xhtml','<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Synthetic</title></head><body><h1>Synthetic EPUB</h1><p>Offline reading works.</p></body></html>');
  epub.file('nav.xhtml','<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Chapter</a></li></ol></nav></body></html>');
  const epubAsset=await service.assets.add(await epub.generateAsync({type:'nodebuffer'}),'synthetic.epub','application/epub+zip');
  const readers=service.store.create('Synthetic readers');
  readers.nodes=[pdfAsset,epubAsset].map((a,i)=>({id:randomUUID(),type:'research',position:{x:i*520,y:0},style:{width:480,height:560},data:{kind:'file',assetId:a.id,filename:a.filename,mime:a.mime,size:a.size}}));
  service.store.save(readers.id,readers);
  await js(`localStorage.setItem('intelboard.last','${readers.id}')`);await window.reload();
  await wait(`!!document.querySelector('.pdf-page canvas') && !document.querySelector('.pdf-scroll .reader-loading') && document.querySelector('.epub-location')?.textContent.includes('Chapter')`);
  assert.equal(await js(`document.querySelectorAll('.reader-message').length`),0);
  console.log('smoke: PDF and EPUB rendered offline');
  const regions=service.store.create('Synthetic region resize');
  const regionId=randomUUID(),leftId=randomUUID(),rightId=randomUUID();
  regions.viewport={x:70,y:140,zoom:0.8};
  regions.nodes=[
    {id:regionId,type:'research',position:{x:0,y:0},style:{width:720,height:480},zIndex:-100,data:{kind:'region',title:'Region resize test'}},
    {id:leftId,type:'research',position:{x:100,y:100},style:{width:280,height:220},data:{kind:'note',text:'Left note'}},
    {id:rightId,type:'research',position:{x:800,y:200},style:{width:280,height:220},data:{kind:'note',text:'Right note'}},
  ];
  service.store.save(regions.id,regions);
  await js(`localStorage.setItem('intelboard.last','${regions.id}')`);await window.reload();
  await wait(`!!document.querySelector('[data-id="${regionId}"] .region-heading')`);
  async function mouse(type,x,y) {
    window.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),button:'left',clickCount:1,...(type==='mouseMove'?{modifiers:['leftButtonDown']}:{})});
    await new Promise(r=>setTimeout(r,35));
  }
  async function point(selector) {
    return js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  }
  async function drag(selector,dx,dy) {
    const start=await point(selector);await mouse('mouseDown',start.x,start.y);
    for(let step=1;step<=4;step++)await mouse('mouseMove',start.x+dx*step/4,start.y+dy*step/4);
    await mouse('mouseUp',start.x+dx,start.y+dy);
  }
  const heading=`[data-id="${regionId}"] .region-heading`;
  const start=await point(heading);await mouse('mouseDown',start.x,start.y);await mouse('mouseUp',start.x,start.y);
  const handle=`[data-id="${regionId}"] .react-flow__resize-control.bottom.right.handle`;
  await wait(`!!document.querySelector(${JSON.stringify(handle)})`);
  await drag(handle,544,296);
  const until=async predicate=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(predicate())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Region positions/dimensions did not save: '+JSON.stringify(service.store.get(regions.id)));};
  await until(()=>service.store.get(regions.id).nodes.find(n=>n.id===regionId).width>1300);
  const before=service.store.get(regions.id);
  await drag(heading,100,60);
  await until(()=>service.store.get(regions.id).nodes.find(n=>n.id===regionId).position.x>20);
  const after=service.store.get(regions.id),container=after.nodes.find(n=>n.id===regionId);
  for(const id of [leftId,rightId]) {
    const old=before.nodes.find(n=>n.id===id), moved=after.nodes.find(n=>n.id===id);
    assert.ok(Math.abs(moved.position.x-old.position.x-container.position.x)<1,'Both notes must follow the enlarged region horizontally');
    assert.ok(Math.abs(moved.position.y-old.position.y-container.position.y)<1,'Both notes must follow the enlarged region vertically');
  }
  await window.reload();await wait(`!!document.querySelector('[data-id="${regionId}"] .region-heading')`);
  await drag(heading,-40,-20);
  await until(()=>service.store.get(regions.id).nodes.find(n=>n.id===regionId).position.x<container.position.x-20);
  const reopened=service.store.get(regions.id),movedAgain=reopened.nodes.find(n=>n.id===regionId);
  for(const id of [leftId,rightId]) {
    const original=regions.nodes.find(n=>n.id===id),moved=reopened.nodes.find(n=>n.id===id);
    assert.ok(Math.abs(moved.position.x-original.position.x-movedAgain.position.x)<1,'Region followers must still work after reopening');
  }
  console.log('smoke: actual region resize, both note followers, and reopen passed');
  await js(`localStorage.setItem('intelboard.last','${board.id}')`);

  const shot=await window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await writeFile(path.join(dir,'smoke.png'),shot.toPNG());
  await writeFile(path.join(dir,'result.json'),JSON.stringify({ok:true,boards:service.store.list().length,offline:true,nodeIntegration:false,errors},null,2));
}
