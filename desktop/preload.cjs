const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame)
  contextBridge.exposeInMainWorld(
    "intelboard",
    Object.freeze({
      request: (route, method, body) =>
        ipcRenderer.invoke("intelboard:request", route, method, body),
      transfer: (operation, boardId) =>
        ipcRenderer.invoke("intelboard:transfer", operation, boardId),
      saveOnExit: (id, board) =>
        ipcRenderer.sendSync("intelboard:save-on-exit", id, board),
      collaboration: (operation, boardId, body) =>
        ipcRenderer.invoke(
          "intelboard:collaboration",
          operation,
          boardId,
          body,
        ),
      saveCollaboration: (boardId, body) =>
        ipcRenderer.sendSync("intelboard:collaboration-flush", boardId, body),
      onCollaboration: (listener) => {
        const receive = (_event, message) => {
          if (
            ["delta", "status", "presence"].includes(message?.type) &&
            typeof message.boardId === "string"
          )
            listener(message);
        };
        ipcRenderer.on("intelboard:collaboration-event", receive);
        return () =>
          ipcRenderer.removeListener("intelboard:collaboration-event", receive);
      },
    }),
  );

if (process.isMainFrame)
  ipcRenderer.on("intelboard:edit", (_event, command) => {
    if (!["undo", "redo", "selectAll"].includes(command)) return;
    const target = document.activeElement || document.body;
    const handled = !target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: command === "selectAll" ? "a" : "z",
        ctrlKey: true,
        shiftKey: command === "redo",
        bubbles: true,
        cancelable: true,
      }),
    );
    if (!handled) document.execCommand(command);
  });
