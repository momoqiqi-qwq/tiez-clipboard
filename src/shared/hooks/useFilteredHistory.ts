import { useMemo } from "react";
import { parseHistorySearch } from "../lib/historySearch";
import type { ClipboardEntry } from "../types";

interface UseFilteredHistoryOptions {
  history: ClipboardEntry[];
  search: string;
  typeFilter: string | null;
}

export const useFilteredHistory = ({
  history,
  search,
  typeFilter
}: UseFilteredHistoryOptions) => {
  // Search and type changes do not change ordering. Never sort the state array.
  const sortedHistory = useMemo(() => {
    return history.slice().sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) {
        return a.is_pinned ? -1 : 1;
      }
      if (a.is_pinned) {
        if ((a.pinned_order || 0) !== (b.pinned_order || 0)) {
          return (b.pinned_order || 0) - (a.pinned_order || 0);
        }
      }
      return b.timestamp - a.timestamp;
    });
  }, [history]);

  return useMemo(() => {
    const { tagOnly: isTagSearch, normalizedTerm: effectiveSearch } = parseHistorySearch(search);

    // Reuse the sorted array when no filtering is needed.
    if (!typeFilter && !effectiveSearch) return sortedHistory;

    return sortedHistory.filter((item) => {
      if (typeFilter && item.content_type !== typeFilter) {
        return false;
      }
      if (!effectiveSearch) return true;

      if (isTagSearch) {
        return item.tags?.some((tag) => tag.toLowerCase().includes(effectiveSearch)) ?? false;
      }

      return (
        item.content?.toLowerCase().includes(effectiveSearch) ||
        item.source_app?.toLowerCase().includes(effectiveSearch) ||
        item.tags?.some((tag) => tag.toLowerCase().includes(effectiveSearch))
      );
    });
  }, [sortedHistory, search, typeFilter]);
};
