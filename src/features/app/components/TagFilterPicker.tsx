import { useMemo } from "react";
import { getTagColor } from "../../../shared/lib/utils";
import { tagFilterOptions } from "../../../shared/lib/tagOptions";
import "../../../styles/components/tag-picker.css";

interface TagFilterPickerProps {
  tags: string[];
  activeTag: string;
  theme: string;
  t: (key: string) => string;
  onSelect: (tag: string) => void;
}

/** One-click tag filter chips. No search box: the strip is short enough to scan,
 *  and the header already has the history search for `tag:<name>` queries. */
export default function TagFilterPicker({ tags, activeTag, theme, t, onSelect }: TagFilterPickerProps) {
  const all = useMemo(() => tagFilterOptions(tags), [tags]);
  if (all.length === 0) return null;
  return (
    <section className="tag-picker window-no-drag" aria-label={t("tag_picker_title")}>
      <div className="tag-picker-options" aria-label={t("tag_picker_options")}>
        {all.map(tag => {
          const active = !!activeTag && activeTag === tag.trim().toLowerCase();
          const color = getTagColor(tag, theme);
          return <button key={tag} type="button" className={`tag-picker-option${active ? " active" : ""}`}
            aria-pressed={active} aria-label={tag} title={tag} onClick={() => onSelect(tag)}
            style={active ? {borderColor: color, boxShadow: `inset 0 0 0 1px ${color}`, fontWeight: 600} : undefined}>
            <span className="tag-picker-dot" style={{background: color}} aria-hidden="true" />
            <span className="tag-picker-name">{tag}</span>
          </button>;
        })}
      </div>
    </section>
  );
}
