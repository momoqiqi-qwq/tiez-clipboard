import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent
} from "react";

type Offset = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  baseX: number;
  baseY: number;
  current: Offset;
  bounds: Bounds;
  moved: boolean;
  lastX: number;
  lastTime: number;
};

const STORAGE_KEY = "tiez.headerActions.offset.v1";
// Keep the floating bar a few pixels inside the window so it never hugs the frame.
const EDGE = 8;
// Anything under this many pixels counts as a click, not a drag.
const DRAG_THRESHOLD = 4;
// Release within this distance of a window corner and the bar snaps into it.
const SNAP_DISTANCE = 56;
const MAX_TILT = 10;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const readOffset = (): Offset => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { x: 0, y: 0 };
    const parsed = JSON.parse(raw) as Partial<Offset>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return { x: 0, y: 0 };
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return { x: 0, y: 0 };
    return { x: parsed.x, y: parsed.y };
  } catch {
    return { x: 0, y: 0 };
  }
};

/**
 * Free-drag behaviour for the header action cluster.
 *
 * The bar stays in normal flow (so the header never changes height) and only
 * translates with a transform, which keeps the window layout completely still
 * while the buttons float over the clipboard list.
 *
 * Moves are tracked on `window` instead of using pointer capture on the bar: capture
 * retargets the compatibility mouse events, which would swallow the click on the
 * buttons themselves. Global listeners leave plain clicks untouched.
 */
export const useDraggableActions = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState<Offset>(readOffset);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const [dragging, setDragging] = useState(false);
  const [settling, setSettling] = useState(false);
  const [tilt, setTilt] = useState(0);

  const dragState = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const suppressTimer = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const getBounds = useCallback((): Bounds => {
    const el = ref.current;
    if (!el) return { minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity };
    const rect = el.getBoundingClientRect();
    // Strip the current transform back out to learn where the bar really sits.
    const naturalLeft = rect.left - offsetRef.current.x;
    const naturalTop = rect.top - offsetRef.current.y;
    return {
      minX: EDGE - naturalLeft,
      maxX: window.innerWidth - EDGE - rect.width - naturalLeft,
      minY: EDGE - naturalTop,
      maxY: window.innerHeight - EDGE - rect.height - naturalTop
    };
  }, []);

  const pulse = useCallback(() => {
    setSettling(true);
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      setSettling(false);
      settleTimer.current = null;
    }, 520);
  }, []);

  // A window resize can leave a parked bar hanging outside the frame.
  useEffect(() => {
    const reclamp = () => {
      const bounds = getBounds();
      setOffset((prev) => {
        const next = {
          x: clamp(prev.x, bounds.minX, bounds.maxX),
          y: clamp(prev.y, bounds.minY, bounds.maxY)
        };
        return next.x === prev.x && next.y === prev.y ? prev : next;
      });
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [getBounds]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
    } catch {
      // Storage can be unavailable (private mode); the bar just forgets where it was.
    }
  }, [offset]);

  useEffect(
    () => () => {
      detach.current?.();
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
      document.body.classList.remove("toolbar-dragging");
    },
    []
  );

  const finishDrag = useCallback(
    (pointerId: number) => {
      const state = dragState.current;
      if (!state || state.pointerId !== pointerId) return;
      dragState.current = null;

      if (!state.moved) return;

      // Swallow the click that follows a drag so we never trigger a button by accident.
      // The timer is a safety net: if no click event ever arrives, the flag must not
      // linger and eat the next genuine button press.
      suppressClick.current = true;
      if (suppressTimer.current !== null) window.clearTimeout(suppressTimer.current);
      suppressTimer.current = window.setTimeout(() => {
        suppressClick.current = false;
        suppressTimer.current = null;
      }, 260);

      setDragging(false);
      setTilt(0);
      document.body.classList.remove("toolbar-dragging");

      const { bounds, current } = state;

      // Dragged back into the title bar band? That reads as "put it back where it
      // belongs", so send it home instead of parking it on top of the header.
      if (current.y <= bounds.minY + 10) {
        setOffset({ x: 0, y: 0 });
        pulse();
        return;
      }

      const corners: Offset[] = [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.minY },
        { x: bounds.minX, y: bounds.maxY },
        { x: bounds.maxX, y: bounds.maxY }
      ];

      let best: Offset | null = null;
      let bestDistance = SNAP_DISTANCE;
      for (const corner of corners) {
        if (Math.abs(corner.y - current.y) > SNAP_DISTANCE) continue;
        const diagonal = Math.hypot(corner.x - current.x, corner.y - current.y);
        if (diagonal <= bestDistance) {
          best = corner;
          bestDistance = diagonal;
        }
      }

      if (best) {
        // The top-right corner *is* the default seat, so landing there should look
        // exactly like the untouched layout rather than a few pixels off.
        setOffset(Math.abs(best.x) < 12 && Math.abs(best.y) < 12 ? { x: 0, y: 0 } : best);
        pulse();
      }
    },
    [pulse]
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragState.current) return;
    const el = ref.current;
    if (!el) return;

    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offsetRef.current.x,
      baseY: offsetRef.current.y,
      current: offsetRef.current,
      bounds: getBounds(),
      moved: false,
      lastX: event.clientX,
      lastTime: event.timeStamp
    };

    const onMove = (moveEvent: PointerEvent) => {
      const state = dragState.current;
      if (!state || state.pointerId !== moveEvent.pointerId) return;

      const dx = moveEvent.clientX - state.startX;
      const dy = moveEvent.clientY - state.startY;

      if (!state.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        state.moved = true;
        setDragging(true);
        document.body.classList.add("toolbar-dragging");
      }

      moveEvent.preventDefault();

      const next = {
        x: clamp(state.baseX + dx, state.bounds.minX, state.bounds.maxX),
        y: clamp(state.baseY + dy, state.bounds.minY, state.bounds.maxY)
      };
      state.current = next;

      // Lean into the direction of travel: the bar should feel like it has mass.
      const deltaTime = Math.max(moveEvent.timeStamp - state.lastTime, 1);
      const velocity = (moveEvent.clientX - state.lastX) / deltaTime;
      state.lastX = moveEvent.clientX;
      state.lastTime = moveEvent.timeStamp;
      setTilt(clamp(-velocity * 13, -MAX_TILT, MAX_TILT));

      setOffset(next);
    };

    const onUp = (upEvent: PointerEvent) => {
      if (dragState.current?.pointerId !== upEvent.pointerId) return;
      finishDrag(upEvent.pointerId);
      cleanup();
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      detach.current = null;
    };

    detach.current?.();
    detach.current = cleanup;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    // Every button may be double-clicked to put the bar back except the one that
    // hides the window: that would take the bar away before it could settle.
    if (target?.closest(".header-actions-close")) return;
    setTilt(0);
    setOffset({ x: 0, y: 0 });
    pulse();
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const style: CSSProperties = {
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`
  };

  const innerStyle: CSSProperties = {
    transform: `rotate(${tilt}deg) scale(${dragging ? 1.055 : 1})`
  };

  return {
    ref,
    style,
    innerStyle,
    dragging,
    settling,
    handlers: {
      onPointerDown,
      onDoubleClick,
      onClickCapture
    }
  };
};
