import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 列表拖动排序。
 *
 * 设计要点：
 * - 拖动开始时一次性量出每一行的高度与纵坐标，之后整段拖动都只用这份快照做数学计算，
 *   不依赖逐帧的 getBoundingClientRect，滚动、缩放都不会让行"跳动"。
 * - 拖动行跟随指针（只在列表范围内位移），其余行按"落点"整体让位，
 *   位移由 CSS transition 补间，因此开合是连续的而不是瞬移。
 * - 松手时先把拖动行补间到它将要占的那一格，动画结束再真正提交数组顺序，
 *   提交瞬间 DOM 重排后的位置与动画终点完全重合，所以看不到任何跳变。
 * - 指针靠近滚动容器上下边缘时自动滚动，长列表也能拖到底。
 */
export interface DragSortState {
  /** 拖动行在数组里的原始下标 */
  from: number;
  /** 当前落点下标 */
  to: number;
  /** 拖动行相对原始位置的纵向位移（px） */
  offset: number;
  /** 其余行需要让出的距离（拖动行高度 + 行间距） */
  shift: number;
  phase: "drag" | "settle";
}

interface Session {
  from: number;
  to: number;
  startY: number;
  lastY: number;
  startScrollTop: number;
  tops: number[];
  heights: number[];
  slots: number[];
  shift: number;
  minOffset: number;
  maxOffset: number;
  scrollEl: HTMLElement | null;
  scrollRect: DOMRect | null;
  started: boolean;
  raf: number;
  detach: () => void;
}

const SETTLE_MS = 260;
const DRAG_THRESHOLD = 3;
const EDGE_ZONE = 48;
const MAX_SCROLL_STEP = 16;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (/(auto|scroll)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}

interface Options {
  count: number;
  disabled?: boolean;
  onCommit: (from: number, to: number) => void;
}

export function useDragReorder({ count, disabled = false, onCommit }: Options) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const settleTimer = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  const [drag, setDrag] = useState<DragSortState | null>(null);

  useEffect(() => { commitRef.current = onCommit; }, [onCommit]);

  const finish = useCallback((commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (session.raf) cancelAnimationFrame(session.raf);
    session.raf = 0;
    session.detach();

    if (!session.started) { setDrag(null); return; }

    const { from } = session;
    const to = commit ? session.to : from;
    setDrag({ from, to, offset: session.slots[to] - session.tops[from], shift: session.shift, phase: "settle" });

    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      setDrag(null);
      if (commit && to !== from) commitRef.current(from, to);
    }, SETTLE_MS);
  }, []);

  const beginDrag = useCallback((index: number, event: { clientY: number; button: number }) => {
    if (disabled || event.button !== 0 || sessionRef.current || settleTimer.current) return;
    const editor = editorRef.current;
    if (!editor) return;

    const rows = Array.from(editor.querySelectorAll<HTMLElement>(":scope > .file-category-edit-row"));
    if (rows.length < 2 || rows.length !== count) return;

    const scrollEl = findScrollParent(editor);
    const startScrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const originTop = scrollEl ? scrollEl.getBoundingClientRect().top : 0;
    const rects = rows.map(row => row.getBoundingClientRect());
    const tops = rects.map(rect => rect.top - originTop + startScrollTop);
    const heights = rects.map(rect => rect.height);
    const gap = Math.max(0, tops[1] - tops[0] - heights[0]);
    const base = tops[0];
    const total = heights.reduce((sum, height) => sum + height, 0) + gap * (rows.length - 1);

    // slots[t] = 若把拖动行放到第 t 格，它的顶边在文档坐标里的位置。
    const slots: number[] = [];
    let cursor = base;
    for (let slot = 0; slot < rows.length; slot++) {
      slots.push(cursor);
      const next = slot < index ? slot : slot + 1;
      if (next < rows.length) cursor += heights[next] + gap;
    }

    const session: Session = {
      from: index,
      to: index,
      startY: event.clientY,
      lastY: event.clientY,
      startScrollTop,
      tops,
      heights,
      slots,
      shift: heights[index] + gap,
      minOffset: base - tops[index],
      maxOffset: base + total - heights[index] - tops[index],
      scrollEl,
      scrollRect: scrollEl ? scrollEl.getBoundingClientRect() : null,
      started: false,
      raf: 0,
      detach: () => {}
    };

    const tick = () => {
      const current = sessionRef.current;
      if (!current) return;

      if (current.scrollEl && current.scrollRect) {
        const { rect } = { rect: current.scrollRect };
        let step = 0;
        if (current.lastY < rect.top + EDGE_ZONE) {
          step = -Math.round(((rect.top + EDGE_ZONE - current.lastY) / EDGE_ZONE) * MAX_SCROLL_STEP);
        } else if (current.lastY > rect.bottom - EDGE_ZONE) {
          step = Math.round(((current.lastY - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE) * MAX_SCROLL_STEP);
        }
        if (step) current.scrollEl.scrollTop += step;
      }

      const scrolled = current.scrollEl ? current.scrollEl.scrollTop - current.startScrollTop : 0;
      const delta = current.lastY - current.startY + scrolled;

      if (!current.started) {
        if (Math.abs(delta) < DRAG_THRESHOLD) { current.raf = requestAnimationFrame(tick); return; }
        current.started = true;
      }

      const draggedTop = current.tops[current.from] + delta;
      let to = current.from;
      let best = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < current.slots.length; slot++) {
        const distance = Math.abs(current.slots[slot] - draggedTop);
        if (distance < best) { best = distance; to = slot; }
      }

      current.to = to;
      const offset = Math.round(clamp(delta, current.minOffset, current.maxOffset));
      setDrag(prev => prev && prev.phase === "drag" && prev.to === to && prev.offset === offset
        ? prev
        : { from: current.from, to, offset, shift: current.shift, phase: "drag" });

      current.raf = requestAnimationFrame(tick);
    };

    const onMove = (moveEvent: PointerEvent) => {
      const current = sessionRef.current;
      if (current) current.lastY = moveEvent.clientY;
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onBlur = () => finish(false);
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finish(false);
    };

    session.detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);

    sessionRef.current = session;
    session.raf = requestAnimationFrame(tick);
  }, [count, disabled, finish]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session) {
      if (session.raf) cancelAnimationFrame(session.raf);
      session.detach();
      sessionRef.current = null;
    }
    if (settleTimer.current) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  }, []);

  return { editorRef, drag, beginDrag, sorting: drag !== null };
}
