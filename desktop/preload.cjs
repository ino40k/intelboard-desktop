const { contextBridge, ipcRenderer } = require("electron");
if (process.isMainFrame)
  contextBridge.exposeInMainWorld(
    "intelboard",
    Object.freeze({
      updater: (operation, body) =>
        ipcRenderer.invoke("intelboard:updater", operation, body),
      onUpdater: (listener) => {
        const receive = (_event, value) => listener(value);
        ipcRenderer.on("intelboard:updater-state", receive);
        return () =>
          ipcRenderer.removeListener("intelboard:updater-state", receive);
      },
      onUpdatePreparation: (listener) => {
        const receive = async (_event, value) => {
          if (value?.action === "release") {
            await listener("release");
            return;
          }
          if (value?.action !== "prepare" || typeof value.nonce !== "string")
            return;
          try {
            const preferences = await listener("prepare");
            ipcRenderer.send("intelboard:update-prepared", {
              nonce: value.nonce,
              ok: true,
              preferences,
            });
          } catch (error) {
            ipcRenderer.send("intelboard:update-prepared", {
              nonce: value.nonce,
              ok: false,
              error: String(error.message || error).slice(0, 300),
            });
          }
        };
        ipcRenderer.on("intelboard:update-prepare", receive);
        return () =>
          ipcRenderer.removeListener("intelboard:update-prepare", receive);
      },
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
