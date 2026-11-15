// Trusted application listeners for the isolated video player. No native API or
// board data is exposed to the frame; the parent validates source and origin.
(() => {
  if (window.__intelboardNavigationInstalled) return;
  window.__intelboardNavigationInstalled = true;
  let active = false,
    moved = false,
    pointerId = 0,
    startX = 0,
    startY = 0,
    suppressUntil = 0;
  const consume = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const send = (action, event) =>
    parent.postMessage(
      {
        type: "intelboard-frame-navigation",
        action,
        id: pointerId,
        x: event?.clientX || 0,
        y: event?.clientY || 0,
        buttons: event?.buttons || 0,
        deltaY: event?.deltaY || 0,
        deltaMode: event?.deltaMode || 0,
      },
      "*",
    );
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 2) return;
      consume(event);
      active = true;
      moved = false;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      try {
        document.documentElement.setPointerCapture(pointerId);
      } catch {}
      send("down", event);
    },
    true,
  );
  window.addEventListener(
    "mousedown",
    (event) => {
      if (active && event.button === 2) consume(event);
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!active) return;
      if (!(event.buttons & 2)) {
        active = false;
        send("cancel");
        return;
      }
      consume(event);
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 3)
        moved = true;
      send("move", event);
    },
    { capture: true, passive: false },
  );
  const end = (event) => {
    if (!active) return;
    active = false;
    if (moved) suppressUntil = performance.now() + 600;
    consume(event);
    send("up", event);
  };
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  window.addEventListener(
    "wheel",
    (event) => {
      if (!active && !(event.buttons & 2)) return;
      consume(event);
      moved = true;
      send("wheel", event);
    },
    { capture: true, passive: false },
  );
  window.addEventListener(
    "contextmenu",
    (event) => {
      if ((active && moved) || performance.now() < suppressUntil)
        consume(event);
    },
    true,
  );
  window.addEventListener("blur", () => {
    if (active) {
      active = false;
      send("cancel");
    }
  });
})();
