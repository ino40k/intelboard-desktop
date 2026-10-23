import { app, BrowserWindow, protocol, ipcMain, dialog, shell, Menu, session } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createService } from './service.js';
import { createProtocol, ORIGIN } from './protocol.js';
import { exportBoards, importBoards } from './transfer.js';
import { boardSchema } from '../shared/schema.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
protocol.registerSchemesAsPrivileged([{scheme:'intelboard',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
app.setName('IntelBoard');
app.enableSandbox();
// Automated smoke runs use disposable storage and a hidden window; never touch a real workspace.
const smoke=process.env.INTELBOARD_SMOKE_DIR;
if(smoke) app.setPath('userData',path.resolve(smoke));
if(!app.requestSingleInstanceLock()) app.quit();
else {
  let window,service,transferBusy=false,quitting=false;
  const trusted=event=>{
    const frame=event.senderFrame;
    if(!window||event.sender!==window.webContents||frame!==window.webContents.mainFrame||frame.url!==ORIGIN+'/index.html') throw new Error('Untrusted desktop request');
  };
  function openExternal(raw) {
    try { const u=new URL(raw); if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password) void shell.openExternal(u.href); } catch { }
  }
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{quitting=true;});
  app.on('will-quit',()=>service?.close());
  app.whenReady().then(async()=>{
    const data=app.getPath('userData'); mkdirSync(data,{recursive:true,mode:0o700});
    // Keep the previous clean-start database snapshot; SQLite recovery owns WAL after crashes.
    const database=path.join(data,'intelboard.sqlite');
    if(existsSync(database)) {
      const { DatabaseSync, backup }=await import('node:sqlite');
      const source=new DatabaseSync(database);
      try { await backup(source,path.join(data,'intelboard.previous.sqlite')); } finally { source.close(); }
    }
    service=createService(data);
    protocol.handle('intelboard',createProtocol(service,path.join(root,'dist')));
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    // Remote pages cannot access local resources, navigate the app, or obtain native APIs.
    app.on('web-contents-created',(_event,contents)=>{
      contents.on('will-attach-webview',event=>event.preventDefault());
      contents.on('will-navigate',(event,url)=>{event.preventDefault();openExternal(url);});
      contents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
    });
    ipcMain.handle('intelboard:request',async(event,route,method,body)=>{
      try { trusted(event); return {ok:true,data:await service.request(route,method,body)}; }
      catch(e) {return {ok:false,error:e.message,status:e.status||400};}
    });
    ipcMain.on('intelboard:save-on-exit',(event,id,board)=>{
      try { trusted(event); service.store.save(id,boardSchema.parse(board));event.returnValue={ok:true}; }
      catch(e) {event.returnValue={ok:false,error:e.message};}
    });
    ipcMain.handle('intelboard:transfer',async(event,operation,boardId)=>{
      trusted(event);
      if(transferBusy) throw new Error('Another file operation is in progress');
      transferBusy=true;
      try {
        if(operation==='import') {
          const result=await dialog.showOpenDialog(window,{title:'Import IntelBoard boards',properties:['openFile'],filters:[{name:'IntelBoard archive',extensions:['intelboard']}]});
          if(result.canceled)return null;
          return {imported:await importBoards(service,result.filePaths[0])};
        }
        if(!['export-board','export-workspace','save-asset'].includes(operation))throw new Error('Unknown file operation');
        let ids,asset;
        if(operation==='save-asset') { asset=service.assets.get(boardId);if(!asset)throw new Error('File not found'); }
        else {ids=operation==='export-board'?[boardId]:service.store.list().map(b=>b.id);if(ids.some(id=>!service.store.get(id)))throw new Error('Board not found');}
        const result=await dialog.showSaveDialog(window,{title:asset?'Save attachment':'Export IntelBoard boards',defaultPath:asset?path.basename(asset.filename.replace(/\\/g,'/')):'IntelBoard.intelboard',...(asset?{}:{filters:[{name:'IntelBoard archive',extensions:['intelboard']}]})});
        if(result.canceled)return null;
        if(asset){await copyFile(path.join(service.assets.folder,asset.id),result.filePath);return {saved:true};}
        return await exportBoards(service,ids,result.filePath);
      } finally {transferBusy=false;}
    });
    let bounds={width:1440,height:960};
    const settings=path.join(data,'window.json');
    try { const saved=JSON.parse(readFileSync(settings,'utf8'));if(saved.width>=800&&saved.width<=7680&&saved.height>=600&&saved.height<=4320)bounds={width:saved.width,height:saved.height}; } catch { }
    window=new BrowserWindow({...bounds,minWidth:800,minHeight:600,show:false,title:'IntelBoard',backgroundColor:'#17191c',icon:path.join(root,'build/icon.png'),webPreferences:{offscreen:!!smoke,backgroundThrottling:!smoke,preload:path.join(root,'desktop/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,spellcheck:true}});
    window.on('ready-to-show',()=>{if(!smoke)window.show();});
    window.on('close',event=>{
      if(transferBusy){event.preventDefault();return;}
      const b=window.getNormalBounds();
      try {writeFileSync(settings+'.tmp',JSON.stringify({width:b.width,height:b.height}),{mode:0o600});renameSync(settings+'.tmp',settings);} catch { }
    });
    window.webContents.on('will-prevent-unload',async event=>{
      const response=dialog.showMessageBoxSync(window,{type:'warning',buttons:['Keep editing','Close and keep recovery draft'],defaultId:0,cancelId:0,message:'Some work has not finished saving.',detail:'Closing keeps the latest available local recovery draft. An unfinished file import or link capture may need to be retried.'});
      if(response===1)event.preventDefault();
    });
    window.webContents.on('will-navigate',(event,url)=>{if(url!==ORIGIN+'/index.html')event.preventDefault();});
    window.webContents.on('will-frame-navigate',details=>{
      try { const u=new URL(details.url);if(details.isMainFrame || !(u.protocol==='blob:'||u.protocol==='about:'||u.origin==='https://www.youtube-nocookie.com'))details.preventDefault(); } catch {details.preventDefault();}
    });
    // Attachment links use native Save As instead of navigating a privileged window.
    window.webContents.session.on('will-download',(event)=>{event.preventDefault();});
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'File',submenu:[{label:'Close',accelerator:'Alt+F4',click:()=>window.close()}]},
      {label:'Edit',submenu:[{id:'undo',label:'Undo',accelerator:'CommandOrControl+Z',click:()=>window.webContents.send('intelboard:edit','undo')},{id:'redo',label:'Redo',accelerator:'CommandOrControl+Shift+Z',click:()=>window.webContents.send('intelboard:edit','redo')},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{id:'select-all',label:'Select all',accelerator:'CommandOrControl+A',click:()=>window.webContents.send('intelboard:edit','selectAll')}]},
      {label:'View',submenu:[{role:'togglefullscreen'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'}]},
      {label:'Help',submenu:[{label:'About IntelBoard',click:()=>dialog.showMessageBox(window,{message:`IntelBoard ${app.getVersion()}`,detail:'Your local visual research workspace. Updates are installed manually; boards remain in your user data folder.'})}]},
    ]));
    await window.loadURL(ORIGIN+'/index.html');
    if(smoke) {
      try { const {runSmoke}=await import('./smoke.js');await runSmoke(window,service,smoke);service.close();service=null;app.exit(0); }
      catch(e){writeFileSync(path.join(smoke,'failure.txt'),e.stack||e.message);app.exit(1);}
    }
  }).catch(error=>{
    if(smoke){writeFileSync(path.join(smoke,'failure.txt'),error.stack||error.message);app.exit(1);return;}
    dialog.showErrorBox('IntelBoard could not open',error.message+'\nYour existing workspace has been kept. Check available disk space and permissions.');app.quit();
  });
}
