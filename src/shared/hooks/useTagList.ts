import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface TagListItem {
  name: string;
  count: number;
}

/**
 * Events that can change the set of tags or their counts.
 * - clipboard-*: new entries classify into tags, or entries are removed
 * - tags-changed: the tag manager created / renamed / deleted a tag
 */
const TAG_LIST_REFRESH_EVENTS = [
  "clipboard-changed",
  "clipboard-updated",
  "clipboard-removed",
  "tags-changed"
] as const;

/**
 * All tags known to the backend, most used first.
 *
 * Unlike the history-derived list this stays complete while a tag filter is
 * active (history only holds the filtered subset then), which the header tag
 * switches rely on.
 */
export const useTagList = (): TagListItem[] => {
  const [tagList, setTagList] = useState<TagListItem[]>([]);

  useEffect(() => {
    let disposed = false;
    let requestSeq = 0;

    const fetchTagList = () => {
      const seq = ++requestSeq;
      invoke<unknown>("get_all_tags_info")
        .then((tagMap) => {
          if (disposed || seq !== requestSeq) return;
          if (!tagMap || typeof tagMap !== "object" || Array.isArray(tagMap)) {
            throw new Error("Invalid tag list response");
          }
          const entries = Object.entries(tagMap);
          if (entries.some(([, count]) => !Number.isSafeInteger(count) || count < 0)) {
            throw new Error("Invalid tag count");
          }
          const next = entries
            .filter(([name]) => name.trim().length > 0)
            .map(([name, count]) => ({ name, count: count as number }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
          setTagList(next);
        })
        .catch((error) => {
          if (!disposed && seq === requestSeq) console.error("Failed to refresh tags", error);
        });
    };

    fetchTagList();
    // Attach a rejection handler immediately, not only during cleanup.
    const unlisteners = TAG_LIST_REFRESH_EVENTS.map((event) =>
      listen(event, fetchTagList).catch((error) => {
        if (!disposed) console.error("Failed to subscribe to tag updates", error);
        return null;
      })
    );

    return () => {
      disposed = true;
      unlisteners.forEach((pending) => {
        pending.then((unlisten) => unlisten?.()).catch(console.error);
      });
    };
  }, []);

  return tagList;
};
