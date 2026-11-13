/**
 * Shape tags the backend classifier assigns to whole classes of content, offered
 * as one-click switches in the header.
 *
 * The names are the literal tag values — they must stay identical to
 * `SHAPE_TAGS` in src-tauri/src/services/auto_tag.rs, otherwise `tag:<name>`
 * matches nothing.
 */
export const SMART_TAGS = ["长文本", "AI提示词"] as const;

export type SmartTag = (typeof SMART_TAGS)[number];
