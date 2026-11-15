import { useEffect, useRef, useState } from "react";
import type { ReactFlowInstance, Viewport } from "@xyflow/react";
import { zoomAtPoint } from "../shared/canvas-interactions.js";
import type { Item, Connection } from "./model";

// Capture before node/reader/resize handlers. Only the right mouse button is
// consumed; React Flow retains ordinary scrolling, Ctrl/pinch zoom and left drag.
export function useCanvasNavigation(
  flow: ReactFlowInstance<Item, Connection>,
  onPointerPosition: (point: { x: number; y: number }) => void,
) {
  const canvasRef = useRef<HTMLDivElement>(null),
    [rightNavigating, setRightNavigating] = useState(false);
  const pointerPosition = useRef(onPointerPosition);
  pointerPosition.current = onPointerPosition;
  useEffect(() => {
    const root = canvasRef.current;
    if (!root) return;
    let gesture: {
      id: number;
      x: number;
      y: number;
      startX: number;
      startY: number;
      moved: boolean;
    } | null = null;
    let pending: Viewport | null = null,
      frame = 0,
      suppressMenuUntil = 0;
    const frameListeners = new Map<HTMLIFrameElement, () => void>();
    let activeFrame: HTMLIFrameElement | null = null;
    const surface = (target: EventTarget | null) =>
      target instanceof Element &&
      root.contains(target) &&
      !target.closest(".react-flow__panel") &&
      !root.inert;
    const consume = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const commit = () => {
      frame = 0;
      if (pending) {
        const next = pending;
        pending = null;
        void flow.setViewport(next);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(commit);
    };
    const finish = () => {
      if (!gesture) return;
      const previous = gesture;
      gesture = null;
      activeFrame = null;
      if (previous.moved) suppressMenuUntil = performance.now() + 600;
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      commit();
      try {
        if (root.hasPointerCapture(previous.id))
          root.releasePointerCapture(previous.id);
      } catch {}
      root.classList.remove("right-navigating");
      setRightNavigating(false);
    };
    const clientPoint = (event: MouseEvent, embedded?: HTMLIFrameElement) => {
      if (!embedded) return { x: event.clientX, y: event.clientY };
      const rect = embedded.getBoundingClientRect(),
        scaleX = rect.width / (embedded.offsetWidth || rect.width),
        scaleY = rect.height / (embedded.offsetHeight || rect.height);
      return {
        x: rect.left + (embedded.clientLeft + event.clientX) * scaleX,
        y: rect.top + (embedded.clientTop + event.clientY) * scaleY,
      };
    };
    const down = (event: PointerEvent, embedded?: HTMLIFrameElement) => {
      if (event.button !== 2 || !surface(embedded || event.target)) return;
      consume(event);
      finish();
      const point = clientPoint(event, embedded);
      pointerPosition.current(point);
      gesture = {
        id: event.pointerId,
        x: point.x,
        y: point.y,
        startX: point.x,
        startY: point.y,
        moved: false,
      };
      activeFrame = embedded || null;
      pending = flow.getViewport();
      root.classList.add("right-navigating");
      setRightNavigating(true);
      try {
        root.setPointerCapture(event.pointerId);
      } catch {}
    };
    const move = (event: PointerEvent, embedded?: HTMLIFrameElement) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!(event.buttons & 2)) {
        finish();
        return;
      }
      consume(event);
      const point = clientPoint(event, embedded);
      pointerPosition.current(point);
      if (Math.hypot(point.x - gesture.startX, point.y - gesture.startY) > 3)
        gesture.moved = true;
      if (gesture.moved) {
        const current = pending || flow.getViewport();
        pending = {
          ...current,
          x: current.x + point.x - gesture.x,
          y: current.y + point.y - gesture.y,
        };
        schedule();
      }
      gesture.x = point.x;
      gesture.y = point.y;
    };
    const up = (event: PointerEvent) => {
      if (gesture && event.pointerId === gesture.id) {
        consume(event);
        finish();
      }
    };
    const mouseDown = (event: MouseEvent, embedded?: HTMLIFrameElement) => {
      if ((event.button === 2 && surface(embedded || event.target)) || gesture)
        consume(event);
    };
    const mouseMove = (event: MouseEvent) => {
      if (gesture) consume(event);
    };
    const mouseUp = (event: MouseEvent) => {
      if (gesture && event.button === 2) {
        consume(event);
        finish();
      }
    };
    const wheel = (event: WheelEvent, embedded?: HTMLIFrameElement) => {
      if (
        (!gesture && !(event.buttons & 2)) ||
        !surface(embedded || event.target)
      )
        return;
      consume(event);
      if (gesture) gesture.moved = true;
      suppressMenuUntil = performance.now() + 600;
      const rect = root.getBoundingClientRect(),
        delta =
          event.deltaY *
          (event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
              ? rect.height
              : 1);
      const point = clientPoint(event, embedded);
      pointerPosition.current(point);
      pending = zoomAtPoint(
        pending || flow.getViewport(),
        { x: point.x - rect.left, y: point.y - rect.top },
        delta,
      );
      schedule();
    };
    const contextMenu = (event: MouseEvent) => {
      if (gesture?.moved || performance.now() < suppressMenuUntil)
        consume(event);
    };
    const visibility = () => {
      if (document.hidden) finish();
    };
    const lostCapture = (event: PointerEvent) => {
      if (event.target === root && event.pointerId === gesture?.id) finish();
    };
    const playerMessage = (event: MessageEvent) => {
      if (
        event.origin !== "https://www.youtube-nocookie.com" ||
        document.querySelector("dialog[open]")
      )
        return;
      const embedded = [...frameListeners.keys()].find(
        (element) => element.contentWindow === event.source,
      );
      const value = event.data;
      if (
        !embedded ||
        !value ||
        value.type !== "intelboard-frame-navigation" ||
        !["down", "move", "up", "wheel", "cancel"].includes(value.action) ||
        ![value.x, value.y, value.deltaY].every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e7,
        ) ||
        !Number.isSafeInteger(value.id) ||
        value.id < 0 ||
        value.id > 65535
      )
        return;
      if (value.action === "cancel") {
        if (activeFrame === embedded) finish();
        return;
      }
      if (
        value.action !== "down" &&
        !(value.action === "wheel" && !activeFrame) &&
        activeFrame !== embedded
      )
        return;
      const eventOptions = {
        clientX: value.x,
        clientY: value.y,
        button: 2,
        buttons: value.buttons & 2 ? 2 : 0,
        pointerId: value.id,
      };
      if (value.action === "down") {
        down(new PointerEvent("pointerdown", eventOptions), embedded);
      } else if (value.action === "move")
        move(new PointerEvent("pointermove", eventOptions), embedded);
      else if (value.action === "up")
        up(new PointerEvent("pointerup", eventOptions));
      else if ([0, 1, 2].includes(value.deltaMode))
        wheel(
          new WheelEvent("wheel", {
            ...eventOptions,
            deltaY: value.deltaY,
            deltaMode: value.deltaMode,
          }),
          embedded,
        );
    };
    window.addEventListener("message", playerMessage);
    // EPUB pages have their own same-origin document. Subscribe there too: DOM
    // events do not bubble out of an iframe. Cross-origin players retain isolation.
    const observeFrame = (embedded: HTMLIFrameElement) => {
      if (frameListeners.has(embedded)) return;
      let detach = () => {};
      const attach = () => {
        detach();
        try {
          const doc = embedded.contentDocument;
          if (!doc) return;
          const frameBlur = () => {
            if (activeFrame === embedded) finish();
          };
          const pointerDown = (e: PointerEvent) => down(e, embedded),
            pointerMove = (e: PointerEvent) => move(e, embedded),
            nativeDown = (e: MouseEvent) => mouseDown(e, embedded),
            nativeWheel = (e: WheelEvent) => wheel(e, embedded);
          doc.addEventListener("pointerdown", pointerDown, true);
          doc.addEventListener("pointermove", pointerMove, {
            capture: true,
            passive: false,
          });
          doc.addEventListener("pointerup", up, true);
          doc.addEventListener("pointercancel", up, true);
          doc.addEventListener("mousedown", nativeDown, true);
          doc.addEventListener("mousemove", mouseMove, true);
          doc.addEventListener("mouseup", mouseUp, true);
          doc.addEventListener("wheel", nativeWheel, {
            capture: true,
            passive: false,
          });
          doc.addEventListener("contextmenu", contextMenu, true);
          doc.defaultView?.addEventListener("blur", frameBlur);
          detach = () => {
            doc.removeEventListener("pointerdown", pointerDown, true);
            doc.removeEventListener("pointermove", pointerMove, true);
            doc.removeEventListener("pointerup", up, true);
            doc.removeEventListener("pointercancel", up, true);
            doc.removeEventListener("mousedown", nativeDown, true);
            doc.removeEventListener("mousemove", mouseMove, true);
            doc.removeEventListener("mouseup", mouseUp, true);
            doc.removeEventListener("wheel", nativeWheel, true);
            doc.removeEventListener("contextmenu", contextMenu, true);
            try {
              doc.defaultView?.removeEventListener("blur", frameBlur);
            } catch {}
          };
        } catch {
          /* Cross-origin frames cannot expose their document. */
        }
      };
      embedded.addEventListener("load", attach);
      attach();
      frameListeners.set(embedded, () => {
        detach();
        embedded.removeEventListener("load", attach);
      });
    };
    const visitFrames = (node: Node, removed = false) => {
      if (!(node instanceof Element)) return;
      const frames = [
        ...(node instanceof HTMLIFrameElement ? [node] : []),
        ...node.querySelectorAll<HTMLIFrameElement>("iframe"),
      ];
      for (const embedded of frames)
        if (removed) {
          frameListeners.get(embedded)?.();
          frameListeners.delete(embedded);
        } else observeFrame(embedded);
    };
    visitFrames(root);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) visitFrames(node, true);
        for (const node of record.addedNodes) visitFrames(node);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener("pointerdown", down, true);
    root.addEventListener("mousedown", mouseDown, true);
    root.addEventListener("wheel", wheel, { capture: true, passive: false });
    root.addEventListener("contextmenu", contextMenu, true);
    root.addEventListener("lostpointercapture", lostCapture);
    window.addEventListener("pointermove", move, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("mousemove", mouseMove, true);
    window.addEventListener("mouseup", mouseUp, true);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      for (const detach of frameListeners.values()) detach();
      frameListeners.clear();
      window.removeEventListener("message", playerMessage);
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("pointerdown", down, true);
      root.removeEventListener("mousedown", mouseDown, true);
      root.removeEventListener("wheel", wheel, true);
      root.removeEventListener("contextmenu", contextMenu, true);
      root.removeEventListener("lostpointercapture", lostCapture);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("mousemove", mouseMove, true);
      window.removeEventListener("mouseup", mouseUp, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [flow]);
  return { canvasRef, rightNavigating };
}
