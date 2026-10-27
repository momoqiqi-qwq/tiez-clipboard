import { useCallback, useMemo } from "react";
import type { StateSnapshot } from "react-virtuoso";

/** One in-memory snapshot. New data, filters, settings or viewport discard it.
 * A late callback from an old list writes only to its old cache, never the new one.
 */
export const useListScrollMemory = (items: readonly unknown[], contextKey: string, layoutVersion?: unknown) => {
  const viewport = typeof window === "undefined" ? "" : `${window.innerWidth}x${window.innerHeight}`;
  const memory = useMemo<{ snapshot?: StateSnapshot }>(() => ({}), [items, contextKey, layoutVersion, viewport]);
  const remember = useCallback((snapshot: StateSnapshot) => {
    memory.snapshot = snapshot;
  }, [memory]);
  return { restoreState: memory.snapshot, remember };
};
