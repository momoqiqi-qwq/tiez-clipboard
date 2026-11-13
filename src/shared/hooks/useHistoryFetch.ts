import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseHistorySearch } from "../lib/historySearch";
import type { Dispatch, SetStateAction } from "react";
import type { ClipboardEntry } from "../types";

// Reject malformed IPC responses before they reach sorting and rendering.
const validateHistory = (value: unknown): ClipboardEntry[] => {
  if (!Array.isArray(value) || value.some((item) =>
    !item || typeof item !== "object" ||
    !Number.isFinite(item.id) || !Number.isFinite(item.timestamp) ||
    typeof item.content_type !== "string" || typeof item.is_pinned !== "boolean" ||
    (item.content != null && typeof item.content !== "string") ||
    (item.source_app != null && typeof item.source_app !== "string") ||
    (item.tags != null && (!Array.isArray(item.tags) ||
      item.tags.some((tag: unknown) => typeof tag !== "string")))
  )) {
    throw new Error("Invalid clipboard history response");
  }
  return value;
};

interface UseHistoryFetchOptions {
  debouncedSearch: string;
  typeFilter: string | null;
  fileExtensions?: string[];
  persistentLimitEnabled: boolean;
  persistentLimit: number;
  pageSize: number;
  currentOffset: number;
  historyLength: number;
  setHistory: Dispatch<SetStateAction<ClipboardEntry[]>>;
  setCurrentOffset: Dispatch<SetStateAction<number>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  isLoadingMore: boolean;
  hasMore: boolean;
  setIsLoadingMore: Dispatch<SetStateAction<boolean>>;
}

export const useHistoryFetch = ({
  debouncedSearch,
  typeFilter,
  fileExtensions,
  persistentLimitEnabled,
  persistentLimit,
  pageSize,
  currentOffset,
  historyLength,
  setHistory,
  setCurrentOffset,
  setHasMore,
  isLoadingMore,
  hasMore,
  setIsLoadingMore
}: UseHistoryFetchOptions) => {
  const [requestState, setRequestState] = useState<{
    phase: "loading" | "ready" | "error";
    queryKey: string;
    limited: boolean;
  }>({ phase: "loading", queryKey: "", limited: false });
  const errorRef = useRef<{ reset: boolean; queryKey: string } | null>(null);
  const extensionsKey = fileExtensions?.join(" ") || "";
  const queryKey = JSON.stringify([debouncedSearch, typeFilter, extensionsKey]);
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  const resetPendingRef = useRef(false);
  const loadedTagQueryRef = useRef<string | null>(null);
  const fetchSeqRef = useRef(0);
  const lastRequestedOffsetRef = useRef<number | null>(null);
  const currentOffsetRef = useRef(currentOffset);
  const historyLengthRef = useRef(historyLength);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ++fetchSeqRef.current;
    };
  }, []);

  useEffect(() => {
    currentOffsetRef.current = currentOffset;
  }, [currentOffset]);

  useEffect(() => {
    historyLengthRef.current = historyLength;
  }, [historyLength]);
  const fetchHistory = useCallback(
    async (reset = false) => {
      if (!mountedRef.current || (!reset && resetPendingRef.current)) return;
      if (reset) resetPendingRef.current = true;
      const seq = ++fetchSeqRef.current;
      errorRef.current = null;
      setRequestState({ phase: "loading", queryKey, limited: false });
      try {
        if (reset) {
          lastRequestedOffsetRef.current = null;
        }

        const baseOffset = reset
          ? 0
          : Math.min(currentOffsetRef.current, historyLengthRef.current);

        let data: ClipboardEntry[] = [];

        const { term, tagOnly } = parseHistorySearch(debouncedSearch);

        if (extensionsKey) {
          const offset = reset ? 0 : currentOffsetRef.current;
          const response = await invoke<unknown>("search_clipboard_history", {
            searchTerm: term, tagOnly, limit: pageSize + 1, offset,
            fileExtensions: extensionsKey.split(" ")
          });
          if (seq !== fetchSeqRef.current) return;
          const rawData = validateHistory(response);
          const page = rawData.slice(0, pageSize);
          if (reset) setHistory(page);
          else setHistory(prev => {
            const seen = new Set(prev.filter(item => item.id !== 0).map(item => item.id));
            return [...prev, ...page.filter(item => {
              if (item.id === 0) return true;
              if (seen.has(item.id)) return false;
              seen.add(item.id);
              return true;
            })];
          });
          loadedTagQueryRef.current = null;
          currentOffsetRef.current = offset + page.length;
          setCurrentOffset(currentOffsetRef.current);
          setHasMore(rawData.length > pageSize);
        } else if (term && tagOnly) {
          // Offset counts the merged search results, including transient id=0 entries.
          const queryKey = JSON.stringify([term.toLowerCase(), typeFilter]);
          const replace = reset || loadedTagQueryRef.current !== queryKey;
          const offset = replace ? 0 : currentOffsetRef.current;
          const response = await invoke<unknown>("search_clipboard_history", {
            searchTerm: term,
            limit: pageSize + 1,
            offset,
            tagOnly: true,
            contentType: typeFilter || undefined
          });
          if (seq !== fetchSeqRef.current) return;
          const rawData = validateHistory(response);
          const hasMoreNow = rawData.length > pageSize;
          const page = rawData.slice(0, pageSize);
          loadedTagQueryRef.current = queryKey;
          if (replace) {
            setHistory(page);
          } else {
            setHistory((prev) => {
              const seen = new Set(prev.filter(item => item.id !== 0).map(item => item.id));
              const next = page.filter(item => {
                if (item.id === 0) return true;
                if (seen.has(item.id)) return false;
                seen.add(item.id);
                return true;
              });
              return next.length ? [...prev, ...next] : prev;
            });
          }
          // Advance by consumed rows, not deduplicated visible rows.
          currentOffsetRef.current = offset + page.length;
          setCurrentOffset(currentOffsetRef.current);
          setHasMore(hasMoreNow);
        } else if (term) {
          const response = await invoke<unknown>("search_clipboard_history", {
            searchTerm: term,
            limit: 200,
            tagOnly
          });

          if (seq !== fetchSeqRef.current) return;
          data = validateHistory(response);
          loadedTagQueryRef.current = null;
          // Search results are not paginated; always replace list and stop infinite loading.
          setHistory(data);
          setCurrentOffset(data.length);
          setHasMore(false);
        } else {
          const requestedLimit = pageSize + 1; // Use standard page size for DB limit
          const response = await invoke<unknown>("get_clipboard_history", {
            limit: requestedLimit,
            offset: baseOffset,
            contentType: typeFilter || undefined
          });

          if (seq !== fetchSeqRef.current) return;

          const rawData = validateHistory(response);
          const hasMoreNow = rawData.length > pageSize;
          const data = hasMoreNow ? rawData.slice(0, pageSize) : rawData;

          // Calculate how many DB items we actually retrieved (id > 0)
          // This is critical for the next offset to be correct
          const dbItemsCount = data.filter(item => item.id > 0).length;
          loadedTagQueryRef.current = null;

          if (reset) {
            setHistory(data);
            setCurrentOffset(dbItemsCount);
            setHasMore(hasMoreNow);
          } else {
            setHistory((prev) => {
              const existingIds = new Set(prev.map((item) => item.id));
              const nextItems = data.filter((item) => !existingIds.has(item.id) || item.id === 0);

              if (nextItems.length === 0) return prev;
              return [...prev, ...nextItems];
            });

            setCurrentOffset(prev => prev + dbItemsCount);
            // If we didn't add any NEW items but the backend says there are more,
            // it means the items we got were already in our list (maybe shifted due to sorting).
            // We should keep hasMore true so the user can try to load further.
            setHasMore(hasMoreNow);
          }
        }
        setRequestState({ phase: "ready", queryKey, limited: !extensionsKey && !!term && !tagOnly && data.length >= 200 });
      } catch (err) {
        // A failed obsolete request must not change the current query's state.
        if (seq !== fetchSeqRef.current) return;
        errorRef.current = { reset: reset || !loadingRef.current, queryKey };
        setRequestState({ phase: "error", queryKey, limited: false });
        console.error("无法获取历史记录", err);
        // Preserve the last valid list/offset/hasMore and allow a deliberate retry.
        lastRequestedOffsetRef.current = null;
      } finally {
        if (reset && seq === fetchSeqRef.current) resetPendingRef.current = false;
      }
    },
    [
      debouncedSearch,
      queryKey,
      typeFilter,
      extensionsKey,
      pageSize,
      persistentLimit,
      persistentLimitEnabled,
      setCurrentOffset,
      setHasMore,
      setHistory
    ]
  );

  const loadMoreHistory = useCallback(async (retry = false) => {
    if (!mountedRef.current || resetPendingRef.current || loadingRef.current || isLoadingMore || !hasMore) return;
    if (errorRef.current && !retry) return;
    const { term, tagOnly } = parseHistorySearch(debouncedSearch);
    if (term && !tagOnly && !extensionsKey) return;

    const effectiveOffset = extensionsKey ? currentOffsetRef.current : term && tagOnly
      ? (loadedTagQueryRef.current === JSON.stringify([term.toLowerCase(), typeFilter]) ? currentOffsetRef.current : 0)
      : Math.min(currentOffsetRef.current, historyLengthRef.current);
    if (lastRequestedOffsetRef.current === effectiveOffset) return;
    lastRequestedOffsetRef.current = effectiveOffset;

    loadingRef.current = true;
    setIsLoadingMore(true);
    try {
      await fetchHistory(false);
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setIsLoadingMore(false);
    }
  }, [debouncedSearch, typeFilter, extensionsKey, fetchHistory, hasMore, isLoadingMore, setIsLoadingMore]);

  const retryHistory = useCallback(async () => {
    if (resetPendingRef.current || loadingRef.current) return;
    const error = errorRef.current;
    if (error && error.queryKey === queryKey && !error.reset) {
      await loadMoreHistory(true);
    } else {
      await fetchHistory(true);
    }
  }, [fetchHistory, loadMoreHistory, queryKey]);

  return { fetchHistory, loadMoreHistory, retryHistory, requestState };
};

