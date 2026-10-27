import { useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { getTagColor } from "../../../shared/lib/utils";
import { filterTagOptions } from "../../../shared/lib/tagOptions";
import "../../../styles/components/tag-picker.css";

interface TagFilterPickerProps {
  tags: string[];
  activeTag: string;
  theme: string;
  t: (key: string) => string;
  onSelect: (tag: string) => void;
}

export default function TagFilterPicker({ tags, activeTag, theme, t, onSelect }: TagFilterPickerProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { all, visible } = useMemo(() => filterTagOptions(tags, query), [tags, query]);
  if (all.length === 0) return null;
  return (
    <section className="tag-picker window-no-drag" aria-label={t("tag_picker_title")}>
      <div className="tag-picker-toolbar">
        <div className="tag-picker-input-wrap">
          <Search size={13} aria-hidden="true" />
          <input ref={inputRef} type="search" value={query}
            aria-label={t("tag_picker_search")} placeholder={t("tag_picker_search")}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape" && query) {
                event.preventDefault(); event.stopPropagation(); setQuery("");
              } else if (event.key === "Enter" && visible.length === 1) {
                event.preventDefault(); event.stopPropagation(); onSelect(visible[0]);
              }
            }} />
          {query && <button type="button" onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            aria-label={t("tag_picker_clear")} title={t("tag_picker_clear")}><X size={13} aria-hidden="true" /></button>}
        </div>
        <span className="tag-picker-count" role="status" aria-live="polite">
          {t("tag_picker_count").replace("{shown}", String(visible.length)).replace("{total}", String(all.length))}
        </span>
      </div>
      {visible.length > 0 ? (
        <div className="tag-picker-options" aria-label={t("tag_picker_options")}>
          {visible.map(tag => {
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
      ) : <p className="tag-picker-empty">{t("tag_picker_empty")}</p>}
    </section>
  );
}
