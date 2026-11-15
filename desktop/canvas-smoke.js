import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Menu } from "electron";

export async function runSmoke(window, service, dir) {
  const js = async (code) => {
      const result = await window.webContents.executeJavaScript(
        `(async()=>{try{return {value:await (${code})};}catch(error){return {failure:error.message,stack:error.stack};}})()`,
        true,
      );
      if (result.failure) throw Error(result.failure + "; " + code);
      return result.value;
    },
    pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (code) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await js(code)) return;
      await pause(35);
    }
    throw Error(
      "Canvas check timed out: " +
        code +
        "; " +
        (await js("document.body.innerText")),
    );
  };
  const saved = async (fn) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fn()) return;
      await pause(50);
    }
    throw Error("Canvas positions did not persist");
  };
  const card = (
    x,
    y,
    w = 280,
    h = 220,
    data = { kind: "note", text: "Synthetic navigation" },
  ) => ({
    id: randomUUID(),
    type: "research",
    position: { x, y },
    style: { width: w, height: h },
    data,
  });
  const load = async (nodes, zoom = 1, delaySharedOpen = false) => {
    const board = service.store.create("Synthetic canvas interactions");
    board.viewport = { x: 60, y: 100, zoom };
    board.nodes = nodes;
    service.store.save(board.id, board);
    if (process.env.INTELBOARD_CANVAS_SHARED)
      await service.collaboration.handle("share", board.id);
    const manager = service.collaboration,
      handle = manager.handle;
    if (delaySharedOpen)
      manager.handle = async function (operation, id, body) {
        if (operation === "open" && id === board.id) await pause(350);
        return handle.call(this, operation, id, body);
      };
    try {
      await js(`localStorage.setItem('intelboard.last','${board.id}')`);
      await window.reload();
      if (delaySharedOpen) {
        await wait(`!!document.querySelector('.canvas[inert]')`);
      }
      await wait(
        `!!document.querySelector('[data-id="${nodes[0].id}"]') && !document.querySelector('.canvas[inert]') && document.querySelectorAll('.react-flow__node').length===${nodes.length} && Array.from(document.querySelectorAll('.react-flow__node')).every(n=>getComputedStyle(n).visibility!=='hidden')`,
      );
      await pause(80);
      return board;
    } finally {
      if (delaySharedOpen) manager.handle = handle;
    }
  };
  const view = () =>
    js(
      `(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform);return {x:m.e,y:m.f,zoom:m.a};})()`,
    );
  const point = (selector) =>
    js(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,
    );
  let heldButton = null;
  const mouse = async (type, p, button = "left", modifiers = []) => {
    if (type === "mouseDown") heldButton = button;
    window.webContents.sendInputEvent({
      type,
      x: Math.round(p.x),
      y: Math.round(p.y),
      button: type === "mouseMove" ? heldButton || undefined : button,
      clickCount: 1,
      modifiers:
        type === "mouseMove" && heldButton
          ? [
              ...modifiers,
              heldButton === "right" ? "rightButtonDown" : "leftButtonDown",
            ]
          : modifiers,
    });
    if (type === "mouseUp") heldButton = null;
    await pause(25);
  };
  const click = async (selector, modifiers = []) => {
    const p = await point(selector);
    await mouse("mouseDown", p, "left", modifiers);
    await mouse("mouseUp", p, "left", modifiers);
  };
  const drag = async (selector, dx, dy, button = "left", check) => {
    const start = await point(selector);
    const nodePosition = () =>
      js(
        `(()=>{const n=document.querySelector(${JSON.stringify(selector)}).closest('.react-flow__node'),m=new DOMMatrix(getComputedStyle(n).transform);return {x:m.e,y:m.f};})()`,
      );
    const original = button === "left" ? await nodePosition() : null;
    await mouse("mouseDown", start, button);
    let current = start,
      end = { x: start.x + dx, y: start.y + dy };
    if (original) {
      // Let React Flow cross its normal drag threshold before measuring a drag.
      // Separate the small native moves by a frame so Chromium cannot coalesce them.
      await mouse("mouseMove", { x: start.x + 4, y: start.y }, button);
      await pause(70);
      current = { x: start.x + 8, y: start.y };
      await mouse("mouseMove", current, button);
      await pause(70);
      const moved = await nodePosition(),
        zoom = (await view()).zoom;
      end = {
        x: current.x + dx - (moved.x - original.x) * zoom,
        y: current.y + dy - (moved.y - original.y) * zoom,
      };
    }
    for (let i = 1; i <= 5; i++)
      await mouse(
        "mouseMove",
        {
          x: current.x + ((end.x - current.x) * i) / 5,
          y: current.y + ((end.y - current.y) * i) / 5,
        },
        button,
      );
    await js(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))",
    );
    if (check) await check();
    await mouse("mouseUp", end, button);
  };
  const wheel = async (p, deltaY, modifiers = []) => {
    window.webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.round(p.x),
      y: Math.round(p.y),
      deltaX: 0,
      deltaY,
      modifiers,
      canScroll: true,
    });
    await pause(100);
  };
  const near = (a, b, message, tolerance = 1) =>
    assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

  const large = card(0, 0, 1100, 680),
    navigation = await load([large]);
  const largeSelector = `[data-id="${large.id}"] .note-content`;
  let before = await view();
  await drag(largeSelector, 60, 35, "right");
  let after = await view();
  near(after.x - before.x, 60, "Right drag over large note pans x");
  near(after.y - before.y, 35, "Right drag over large note pans y");
  assert.equal(
    await js(
      `document.querySelectorAll('.react-flow__node.selected,[contenteditable=true]').length`,
    ),
    0,
    "Right pan must not select/edit a note",
  );
  assert.deepEqual(service.store.get(navigation.id).nodes[0].position, {
    x: 0,
    y: 0,
  });
  const p = await point(largeSelector),
    root = await js(
      `(()=>{const r=document.querySelector('.canvas').getBoundingClientRect();return {x:r.x,y:r.y};})()`,
    );
  before = await view();
  await mouse("mouseDown", p, "right");
  await wheel(p, 120, ["rightButtonDown"]);
  after = await view();
  assert.ok(after.zoom > before.zoom, "Native upward right-wheel zooms in");
  near(
    (p.x - root.x - before.x) / before.zoom,
    (p.x - root.x - after.x) / after.zoom,
    "Cursor-centred zoom x",
  );
  near(
    (p.y - root.y - before.y) / before.zoom,
    (p.y - root.y - after.y) / after.zoom,
    "Cursor-centred zoom y",
  );
  await wheel(p, -120, ["rightButtonDown"]);
  const down = await view();
  assert.ok(down.zoom < after.zoom, "Native downward right-wheel zooms out");
  await mouse("mouseUp", p, "right");
  before = await view();
  await wheel(p, -80);
  after = await view();
  near(
    before.zoom,
    after.zoom,
    "Unmodified wheel still pans, not zooms",
    0.001,
  );
  assert.ok(
    Math.abs(after.y - before.y) > 1,
    "Unmodified wheel retains panning",
  );
  // The capture handler precedes nested editable/nopan handlers, without moving the caret.
  await js(
    `document.querySelector(${JSON.stringify(largeSelector)}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
  );
  await wait(`!!document.querySelector('[contenteditable=true]')`);
  await drag("[contenteditable=true]", -30, 20, "right");
  assert.equal(
    await js(`!!document.querySelector('[contenteditable=true]')`),
    true,
  );
  await js(
    `document.querySelector('[contenteditable=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`,
  );
  await wait(`!document.querySelector('[contenteditable=true]')`);
  await click(`[data-id="${large.id}"] .note-eyebrow`);
  const size = service.store.get(navigation.id).nodes[0].style;
  await drag(
    `[data-id="${large.id}"] .react-flow__resize-control.top.left.handle`,
    25,
    20,
    "right",
  );
  assert.deepEqual(
    service.store.get(navigation.id).nodes[0].style,
    size,
    "Right navigation must not resize",
  );
  assert.equal(
    await js(`!!document.querySelector('.right-navigating')`),
    false,
  );
  console.log(
    "canvas: native right-pan, cursor-centred right-wheel, ordinary wheel, editor and resize exclusion passed",
  );
  window.webContents.session.protocol.handle(
    "https",
    () =>
      new Response('<body style="margin:0">Synthetic isolated player</body>', {
        headers: { "Content-Type": "text/html" },
      }),
  );
  for (const opaque of [false, true]) {
    await js(
      `(()=>{const wrapper=document.createElement('div');wrapper.id='navigation-frame-test';wrapper.className='document-reader nodrag nopan nowheel';Object.assign(wrapper.style,{position:'absolute',left:'100px',top:'120px',width:'400px',height:'180px',zIndex:'2'});const f=document.createElement('iframe');f.id='navigation-frame';f.style='width:100%;height:100%;border:0';${opaque ? "f.src='https://www.youtube-nocookie.com/embedded-navigation-test';" : "f.srcdoc='<body style=\"margin:0\">Synthetic reader frame</body>';"}wrapper.append(f);document.querySelector('[data-id="${large.id}"] .item').append(wrapper);})()`,
    );
    await pause(200);
    if (!opaque)
      await wait(
        `document.querySelector('#navigation-frame').contentDocument?.body?.textContent.includes('Synthetic reader frame')`,
      );
    else {
      let player,
        ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        player = window.webContents.mainFrame.frames.find(
          (f) =>
            f.url ===
            "https://www.youtube-nocookie.com/embedded-navigation-test",
        );
        if (player)
          ready = await player
            .executeJavaScript("!!window.__intelboardNavigationInstalled")
            .catch(() => false);
        if (!ready) await pause(50);
      }
      assert.ok(
        ready,
        "Isolated player has only the trusted navigation listeners",
      );
      assert.equal(
        await player.executeJavaScript("typeof window.intelboard"),
        "undefined",
        "Player does not gain native APIs",
      );
    }
    before = await view();
    await drag("#navigation-frame", 25, 15, "right");
    after = await view();
    near(
      after.x - before.x,
      25,
      opaque ? "Opaque frame right-pan" : "Local reader right-pan",
    );
    near(after.y - before.y, 15, "Frame right-pan y");
    const fp = await point("#navigation-frame");
    before = await view();
    await mouse("mouseDown", fp, "right");
    await wheel(fp, 120, ["rightButtonDown"]);
    after = await view();
    assert.ok(after.zoom > before.zoom, "Right-wheel over frame zooms");
    await mouse("mouseUp", fp, "right");
    await js(`document.querySelector('#navigation-frame-test').remove()`);
  }

  window.webContents.session.protocol.unhandle("https");
  console.log(
    "canvas: right navigation over local reader and isolated player frames passed",
  );
  const handleViews = [
    [1, false],
    [0.5, false],
    ...(process.env.INTELBOARD_CANVAS_SHARED ? [[0.5, true]] : []),
    [0.2, false],
    [2, false],
  ];
  for (const [zoom, delaySharedOpen] of handleViews) {
    const a = card(0, 0),
      b = card(380, 0);
    await load([a, b], zoom, delaySharedOpen);
    await click(`[data-id="${a.id}"] .note-eyebrow`);
    await mouse("mouseMove", { x: 1100, y: 700 }, "left");
    await wait(
      `getComputedStyle(document.querySelector('[data-id="${a.id}"] .react-flow__handle-right')).opacity==='1'`,
    );
    assert.deepEqual(
      await js(
        `(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector('[data-id="${a.id}"]')).transform);return [m.e,m.f];})()`,
      ),
      [0, 0],
      "Idle hover after selection must not drag the node",
    );
    const scale = await js(
      `(()=>{const h=document.querySelector('[data-id="${a.id}"] .react-flow__handle-right'),b=h.getBoundingClientRect();return {width:b.width,pseudo:parseFloat(getComputedStyle(h,'::before').width),opacity:getComputedStyle(h).opacity,hidden:getComputedStyle(document.querySelector('[data-id="${b.id}"] .react-flow__handle-right')).opacity};})()`,
    );
    near(scale.width / zoom, 9, "Measured connection anchor stays fixed", 0.1);
    near(
      scale.pseudo,
      9 * Math.min(3, Math.max(1, 1 / zoom)),
      "Visual/interactive handle grows smoothly",
      0.05,
    );
    assert.equal(scale.opacity, "1");
    assert.equal(
      scale.hidden,
      "0",
      "Unselected, unhovered handles remain hidden",
    );
    if (zoom === 0.5) {
      const from = await point(`[data-id="${a.id}"] .react-flow__handle-right`),
        to = await point(`[data-id="${b.id}"] .react-flow__handle-left`),
        outside = { x: from.x + 3, y: from.y };
      assert.equal(
        await js(
          `document.elementFromPoint(${outside.x},${outside.y})?.dataset.handleid`,
        ),
        "out",
        "Enlarged area outside the original box must be clickable",
      );
      await js(
        `(()=>{window.__canvasInputs=[];window.__canvasInputTrace=e=>{window.__canvasInputs.push({type:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,button:e.button,target:e.target?.className,handle:e.target?.dataset?.handleid,node:e.target?.dataset?.nodeid});if(window.__canvasInputs.length>24)window.__canvasInputs.shift();};for(const type of ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup'])document.addEventListener(type,window.__canvasInputTrace,true);})()`,
      );
      try {
        await mouse("mouseDown", outside);
        for (let i = 1; i <= 4; i++)
          await mouse("mouseMove", {
            x: outside.x + ((to.x - outside.x) * i) / 4,
            y: to.y,
          });
        // XYHandle completes from its last processed move, not mouse-up coordinates.
        // Native Chromium input can coalesce that final move on a busy runner.
        await wait(
          `!!document.querySelector('[data-nodeid="${b.id}"].react-flow__handle.connectingto.valid')`,
        );
        await mouse("mouseUp", to);
        await wait(`document.querySelectorAll('.react-flow__edge').length===1`);
      } catch (error) {
        console.log(
          "Connection input diagnostics:",
          JSON.stringify({
            from,
            to,
            outside,
            focused: window.isFocused(),
            ...(await js(
              `(()=>{const r=n=>{const b=n.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};return {events:window.__canvasInputs,dpr:devicePixelRatio,focus:document.hasFocus(),right:!!document.querySelector('.right-navigating'),nodes:Array.from(document.querySelectorAll('.react-flow__node')).map(n=>({id:n.dataset.id,rect:r(n)})),handles:Array.from(document.querySelectorAll('.react-flow__handle')).map(n=>({node:n.dataset.nodeid,handle:n.dataset.handleid,classes:n.className,rect:r(n),pseudo:getComputedStyle(n,'::before').width})),connection:document.querySelector('.react-flow__connectionline')?.outerHTML};})()`,
            )),
          }),
        );
        throw error;
      } finally {
        await js(
          `(()=>{for(const type of ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup'])document.removeEventListener(type,window.__canvasInputTrace,true);delete window.__canvasInputs;delete window.__canvasInputTrace;})()`,
        );
      }
      const pathBefore = await js(
        `document.querySelector('.react-flow__edge-path').getAttribute('d')`,
      );
      await js(`document.querySelector('[aria-label="Zoom out"]').click()`);
      await wait(
        `Math.abs(new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a-(0.5/1.2))<0.0001`,
      );
      near((await view()).zoom, 0.5 / 1.2, "Zoom controls still work", 0.001);
      assert.equal(
        await js(
          `document.querySelector('.react-flow__edge-path').getAttribute('d')`,
        ),
        pathBefore,
        "Zoom must not displace connection endpoints",
      );
    }
  }
  console.log(
    "canvas: continuous handle scaling, 3x cap, selection visibility, expanded hit target and fixed endpoints passed",
  );

  const a = card(0, 0),
    b = card(360, 200, 320, 240),
    alignment = await load([a, b]);
  await drag(`[data-id="${a.id}"] .note-eyebrow`, 355, 100, "left", async () =>
    assert.equal(
      await js(
        `!!document.querySelector('.alignment-guides line[data-axis=x]')`,
      ),
      true,
      JSON.stringify(
        await js(
          `Array.from(document.querySelectorAll('.react-flow__node')).map(n=>({id:n.dataset.id,transform:n.style.transform,classes:n.className}))`,
        ),
      ),
    ),
  );
  await saved(
    () =>
      service.store.get(alignment.id).nodes.find((n) => n.id === a.id).position
        .x === 360,
  );
  assert.equal(
    await js(`document.querySelectorAll('.alignment-guides').length`),
    0,
  );
  assert.deepEqual(
    service.store.get(alignment.id).nodes.find((n) => n.id === b.id).position,
    b.position,
  );
  Menu.getApplicationMenu().getMenuItemById("undo").click();
  await saved(
    () =>
      service.store.get(alignment.id).nodes.find((n) => n.id === a.id).position
        .x === 0,
  );
  Menu.getApplicationMenu().getMenuItemById("redo").click();
  await saved(
    () =>
      service.store.get(alignment.id).nodes.find((n) => n.id === a.id).position
        .x === 360,
  );
  await window.reload();
  await wait(`!!document.querySelector('[data-id="${a.id}"]')`);
  assert.equal(
    service.store.get(alignment.id).nodes.find((n) => n.id === a.id).position.x,
    360,
  );
  for (const grouped of [true, false]) {
    const group = randomUUID(),
      first = card(0, 0, 280, 220, {
        kind: "note",
        text: "Formation A",
        ...(grouped ? { groupId: group } : {}),
      }),
      second = card(120, 300, 160, 130, {
        kind: "note",
        text: "Formation B",
        ...(grouped ? { groupId: group } : {}),
      }),
      target = card(500, 0),
      formation = await load([first, second, target]);
    if (!grouped) {
      await click(`[data-id="${first.id}"] .note-eyebrow`);
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
      await click(`[data-id="${second.id}"] .note-eyebrow`, ["shift"]);
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
      await wait(
        `document.querySelectorAll('.react-flow__node.selected').length===2`,
      );
    }
    await drag(`[data-id="${first.id}"] .note-eyebrow`, 495, 0);
    await saved(
      () =>
        service.store.get(formation.id).nodes.find((n) => n.id === first.id)
          .position.x === 500,
    );
    const moved = service.store.get(formation.id);
    assert.deepEqual(moved.nodes.find((n) => n.id === second.id).position, {
      x: 620,
      y: 300,
    });
    assert.deepEqual(
      moved.nodes.find((n) => n.id === target.id).position,
      target.position,
    );
  }
  const region = card(0, 0, 720, 480, {
      kind: "region",
      title: "Synthetic region",
    }),
    inside = card(100, 100),
    reference = card(1000, 0),
    regions = await load([region, inside, reference], 0.5);
  await drag(`[data-id="${region.id}"] .region-heading`, 497.5, 0);
  await saved(
    () =>
      service.store.get(regions.id).nodes.find((n) => n.id === region.id)
        .position.x === 1000,
  );
  assert.deepEqual(
    service.store.get(regions.id).nodes.find((n) => n.id === inside.id)
      .position,
    { x: 1100, y: 100 },
  );
  assert.deepEqual(
    service.store.get(regions.id).nodes.find((n) => n.id === reference.id)
      .position,
    reference.position,
  );
  console.log(
    "canvas: snapping, transient guides, persistence/Undo/Redo, group/multi-selection and region followers passed",
  );
  await writeFile(
    path.join(dir, "result.json"),
    JSON.stringify(
      {
        ok: true,
        rightPan: true,
        rightWheel: true,
        handles: true,
        snapping: true,
        formations: true,
      },
      null,
      2,
    ),
  );
}
