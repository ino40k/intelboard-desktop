import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';
const dir=await mkdtemp(path.join(os.tmpdir(),'intelboard-smoke-'));
const binary=process.env.INTELBOARD_TEST_BINARY||electron;
const args=process.env.INTELBOARD_TEST_BINARY?[]:['.'];
// A hidden BrowserWindow uses the existing graphical session; nothing is shown.
// No sandbox bypass. One process tree, two starts, 30s per start, killed on timeout.
try {
  for(let iteration=0;iteration<2;iteration++) {
    await new Promise((resolve,reject)=>{
      const child=spawn(binary,[...args,'--disable-gpu'],{env:{...process.env,INTELBOARD_SMOKE_DIR:dir},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
      let output='';const cap=chunk=>{output=(output+chunk.toString()).slice(-12000);process.stdout.write(chunk);};child.stdout.on('data',cap);child.stderr.on('data',cap);
      const timer=setTimeout(()=>{
        if(process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{}}
        else spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000});
        reject(new Error('Desktop smoke deadline exceeded: '+output));
      },30000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',async code=>{clearTimeout(timer);if(code===0)resolve();else reject(new Error('Desktop smoke failed: '+output+'\n'+await readFile(path.join(dir,'failure.txt'),'utf8').catch(()=>'')));});
    });
  }
  console.log(await readFile(path.join(dir,'result.json'),'utf8'));
  console.log('Hidden startup and persistence across two process launches passed.');
} finally {
  if(process.env.INTELBOARD_KEEP_SMOKE)console.log('Synthetic diagnostics:',dir);
  else await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(error=>console.warn('Temporary smoke cleanup:',error.code));
}
