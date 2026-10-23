const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) contextBridge.exposeInMainWorld('intelboard', Object.freeze({
  request: (route, method, body) => ipcRenderer.invoke('intelboard:request', route, method, body),
  transfer: (operation, boardId) => ipcRenderer.invoke('intelboard:transfer', operation, boardId),
  saveOnExit: (id, board) => ipcRenderer.sendSync('intelboard:save-on-exit', id, board),
}));

if (process.isMainFrame) ipcRenderer.on('intelboard:edit', (_event, command) => {
  if (!['undo', 'redo', 'selectAll'].includes(command)) return;
  const target = document.activeElement || document.body;
  const handled = !target.dispatchEvent(new KeyboardEvent('keydown', {
    key: command === 'selectAll' ? 'a' : 'z', ctrlKey: true,
    shiftKey: command === 'redo', bubbles: true, cancelable: true,
  }));
  if (!handled) document.execCommand(command);
});
