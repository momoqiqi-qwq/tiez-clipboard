import { SMART_TAGS } from "./smartTags";

const SMART_TAG_SET = new Set<string>(SMART_TAGS);

/**
 * Tag chips for the filter strip: shape tags (长文本 / AI提示词) first, then the
 * rest in the order the store returned them, duplicates removed.
 *
 * Pinning keeps the strip's left edge stable while the auto-classified tag list
 * keeps growing behind them.
 */
export const tagFilterOptions = (tags: readonly string[]) => {
  const unique = Array.from(new Set(tags.filter(tag => tag.trim().length > 0)));
  return [
    ...unique.filter(tag => SMART_TAG_SET.has(tag)),
    ...unique.filter(tag => !SMART_TAG_SET.has(tag)),
  ];
};
