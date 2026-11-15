import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Menu } from "electron";
import { createService } from "../service.js";
import { CollaborationEngine } from "./engine.js";
import { newIdentity } from "./identity.js";
import { textBinding } from "../../shared/collaboration/document.js";

export async function runSmoke(window, service, dir) {
  const manager = service.collaboration;
  const js = (code) => window.webContents.executeJavaScript(code, true);
  const wait = async (code) => {
    const until = Date.now() + 8000;
    while (Date.now() < until) {
      if (await js(code)) return;
      await new Promise((r) => setTimeout(r, 70));
    }
    throw Error(
      "Shared UI timed out: " +
        code +
        "; " +
        (await js("document.body.innerText")),
    );
  };
  const saved = async (predicate) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 70));
    }
    throw Error("Shared state did not persist");
  };
  let board = service.store
    .list()
    .find((b) => b.title === "Synthetic collaboration UI");
  if (!board) {
    board = service.store.create("Synthetic collaboration UI");
    board.nodes = [
      {
        id: randomUUID(),
        type: "research",
        position: { x: 100, y: 100 },
        style: { width: 280, height: 220 },
        data: { kind: "note", text: "Collaborative base" },
      },
    ];
    board.viewport = { x: 70, y: 140, zoom: 0.8 };
    service.store.save(board.id, board);
  }
  const boardId = board.id,
    noteId = service.store.get(boardId).nodes[0].id;
  await js(`localStorage.setItem('intelboard.last','${boardId}')`);
  await window.reload();
  await wait(`!!document.querySelector('.workspace')`);
  if (!board.shared) {
    await js(`document.querySelector('.collaboration-button').click()`);
    await wait(`!!document.querySelector('dialog input')`);
    await js(
      `(()=>{const e=document.querySelector('dialog input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Synthetic owner');e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(`!document.querySelector('dialog .primary-button').disabled`);
    await js(`document.querySelector('dialog .primary-button').click()`);
    await wait(`!!document.querySelector('.collaboration-button.is-shared')`);
  }
  await wait(`!document.querySelector('.canvas[inert]')`);
  await js(`document.querySelector('[aria-label="Close dialog"]')?.click()`);
  console.log(
    "collaboration UI: explicit sharing and local document initialization passed",
  );
  const remoteService = createService(path.join(dir, "remote-" + randomUUID()));
  const remote = new CollaborationEngine(remoteService.store, {
    identity: newIdentity("Synthetic peer"),
  });
  try {
    const owner = manager.engine,
      entry = owner.get(boardId);
    owner.grant(boardId, remote.identity.publicKey, remote.identity.name);
    const remoteId = remote.accept(entry.genesis, owner.records(entry.docId));
    await js(
      `document.querySelector('[data-id="${noteId}"] .note-content').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    );
    await wait(
      `!!document.querySelector('[contenteditable=true]') && document.activeElement===document.querySelector('[contenteditable=true]')`,
    );
    await js(
      `(()=>{const e=document.querySelector('[contenteditable=true]'),r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`,
    );
    await window.webContents.insertText(" LOCAL");
    await saved(() =>
      service.store.get(boardId).nodes[0].data.text.includes(" LOCAL"),
    );
    const caret = () =>
      js(
        `(()=>{const e=document.querySelector('[contenteditable=true]'),s=getSelection(),r=document.createRange();r.selectNodeContents(e);r.setEnd(s.anchorNode,s.anchorOffset);return r.toString().length;})()`,
      );
    const before = await caret();
    remote.ingest(remoteId, owner.records(entry.docId));
    remote.edit(remoteId, (doc) => textBinding(doc, noteId).insert(0, "R "));
    owner.ingest(boardId, remote.records(entry.docId));
    await wait(
      `document.querySelector('[contenteditable=true]').textContent.startsWith('R ')`,
    );
    assert.equal(
      await caret(),
      before + 2,
      "Remote insertion must preserve the live relative caret",
    );
    Menu.getApplicationMenu().getMenuItemById("undo").click();
    await saved(
      () => !service.store.get(boardId).nodes[0].data.text.includes(" LOCAL"),
    );
    assert.ok(
      service.store.get(boardId).nodes[0].data.text.startsWith("R "),
      "Text Undo must keep the remote contribution",
    );
    await js(
      `document.querySelector('[contenteditable=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`,
    );
    await wait(`!document.querySelector('[contenteditable=true]')`);
    console.log(
      "collaboration UI: native text input, remote caret anchoring, and local-only Undo passed",
    );
    const count = service.store.get(boardId).nodes.length;
    await js(
      `document.activeElement?.blur();document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true,cancelable:true}))`,
    );
    await saved(() => service.store.get(boardId).nodes.length === count + 1);
    await wait(
      `!!document.querySelector('[contenteditable=true]') && document.activeElement===document.querySelector('[contenteditable=true]')`,
    );
    let length = 0;
    for (const character of "first") {
      await window.webContents.insertText(character);
      assert.equal(
        await caret(),
        ++length,
        "New shared notes must keep the caret after each typed character",
      );
    }
    await saved(() =>
      service.store.get(boardId).nodes.some((n) => n.data.text === "first"),
    );
    await js(
      `document.querySelector('[contenteditable=true]')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`,
    );
    await wait(`!document.querySelector('[contenteditable=true]')`);
    Menu.getApplicationMenu().getMenuItemById("undo").click();
    await saved(() => service.store.get(boardId).nodes.length === count);
    Menu.getApplicationMenu().getMenuItemById("redo").click();
    await saved(() => service.store.get(boardId).nodes.length === count + 1);
    console.log(
      "collaboration UI: actor-bound creation and recoverable canvas Undo/Redo passed",
    );
    const fake = "synthetic-presence";
    manager.connections.set(fake, {
      id: fake,
      boardId,
      lane: "control",
      publicKey: remote.identity.publicKey,
      authenticated: true,
      remoteKnown: new Set(entry.heads),
      created: Date.now(),
    });
    manager.presences.set(
      boardId,
      new Map([
        [
          remote.identity.publicKey,
          {
            publicKey: remote.identity.publicKey,
            name: remote.identity.name,
            seen: Date.now(),
            cursor: { x: 10, y: 20 },
            selection: [noteId],
            resize: noteId,
            previews: [],
          },
        ],
      ]),
    );
    manager.emit("presence", { boardId });
    await wait(
      `!!document.querySelector('.collaboration-cursor') && document.querySelector('.collaboration-node-presence')?.textContent.includes('resizing')`,
    );
    assert.equal(
      await js(
        `document.querySelector('.collaboration-cursor').style.transform`,
      ),
      "translate(78px, 156px)",
    );
    assert.equal(
      await js(
        `!!document.querySelector('[data-id="${noteId}"] .react-flow__resize-control.handle')`,
      ),
      false,
      "Other participants cannot resize a leased item",
    );
    manager.connections.delete(fake);
    manager.emit("presence", { boardId });
    await wait(`!document.querySelector('.collaboration-node-presence')`);
    console.log(
      "collaboration UI: world-coordinate cursors and disconnect-safe resize leases passed",
    );
    const privateBoard = service.store.create(
      "Synthetic private background check",
    );
    await js(`localStorage.setItem('intelboard.last','${privateBoard.id}')`);
    await window.reload();
    await wait(
      `document.querySelector('[aria-label="Board title"]')?.value==='Synthetic private background check'`,
    );
    remote.ingest(remoteId, owner.records(entry.docId));
    remote.edit(remoteId, (doc) => {
      const text = textBinding(doc, noteId);
      text.insert(text.length, " BACKGROUND");
    });
    owner.ingest(boardId, remote.records(entry.docId));
    assert.ok(
      service.store.get(boardId).nodes[0].data.text.endsWith(" BACKGROUND"),
    );
    assert.equal(
      await js(`document.querySelector('[aria-label="Board title"]').value`),
      "Synthetic private background check",
    );
    await js(`localStorage.setItem('intelboard.last','${boardId}')`);
    await window.reload();
    await wait(
      `document.querySelector('.note-content')?.textContent.endsWith(' BACKGROUND')`,
    );
    assert.deepEqual(service.store.get(boardId).viewport, {
      x: 70,
      y: 140,
      zoom: 0.8,
    });
    console.log(
      "collaboration UI: background board updates, independent viewport, and reopen passed",
    );
    const image = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await writeFile(path.join(dir, "collaboration-ui.png"), image.toPNG());
    await js(`document.querySelector('.collaboration-button').click()`);
    await wait(
      `!!document.querySelector('dialog') && document.body.innerText.includes('Board collaboration')`,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    const modal = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    await writeFile(path.join(dir, "collaboration-modal.png"), modal.toPNG());
    await writeFile(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          ok: true,
          shared: true,
          caret: true,
          localUndo: true,
          leases: true,
          background: true,
        },
        null,
        2,
      ),
    );
  } finally {
    remote.close();
    remoteService.close();
  }
}
