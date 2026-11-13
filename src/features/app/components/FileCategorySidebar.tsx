import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, Code2, File, FileSpreadsheet, FileText, Folder, Grid2X2, GripVertical, HardDrive, Image, Link, Music, PanelLeftClose, PanelLeftOpen, Plus, Presentation, Settings2, Trash2, Type, Video, X } from "lucide-react";
import { DEFAULT_FILE_CATEGORIES, parseFileExtensions, type FileCategory } from "../../../shared/lib/fileCategories";
import { isTauriRuntime } from "../../../shared/lib/tauriRuntime";
import { useDragReorder } from "../hooks/useDragReorder";
import "../../../styles/components/file-sidebar.css";

type Translate = (key: string) => string;
const icons = { sheet: FileSpreadsheet, document: FileText, presentation: Presentation, audio: Music, archive: Archive, code: Code2, app: Grid2X2, disk: HardDrive };
export const fileCategoryName = (category: FileCategory, t: Translate) => category.name || (["audio", "archive"].includes(category.id) ? t(`sidebar_${category.id}`) : "");

interface Props {
  t: Translate;
  collapsed: boolean;
  categories: FileCategory[];
  activeCategoryId: string | null;
  typeFilter: string | null;
  onToggle: () => void;
  onSelect: (type: string | null, categoryId?: string) => void;
  onSave: (categories: FileCategory[]) => Promise<void>;
}

const moveItem = (items: FileCategory[], from: number, to: number): FileCategory[] => {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

interface RowLabels {
  reorder: string;
  visible: string;
  name: string;
  extensions: string;
  delete: string;
}

interface CategoryRowProps {
  item: FileCategory;
  index: number;
  translate: number;
  dragging: boolean;
  settling: boolean;
  flashing: boolean;
  disabled: boolean;
  labels: RowLabels;
  onField: (index: number, patch: Partial<FileCategory>) => void;
  onRemove: (index: number) => void;
  onDragStart: (index: number, event: { clientY: number; button: number }) => void;
  onNudge: (index: number, delta: number) => void;
}

const CategoryRow = memo(function CategoryRow({ item, index, translate, dragging, settling, flashing, disabled, labels, onField, onRemove, onDragStart, onNudge }: CategoryRowProps) {
  const name = item.name;
  const className = `file-category-edit-row${dragging ? " is-dragging" : ""}${settling ? " is-settling" : ""}${flashing ? " is-moved" : ""}`;
  return (
    <div className={className} style={{ "--row-shift": `${translate}px` } as CSSProperties}>
      <button type="button" className="file-category-grip" disabled={disabled}
        title={labels.reorder} aria-label={`${labels.reorder} ${name}`}
        onPointerDown={event => onDragStart(index, event)}
        onKeyDown={event => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          onNudge(index, event.key === "ArrowUp" ? -1 : 1);
        }}>
        <GripVertical size={14} aria-hidden="true" />
      </button>
      <label className="file-category-visible" title={labels.visible}>
        <input type="checkbox" checked={item.visible} disabled={disabled} aria-label={`${labels.visible} ${name}`} onChange={event => onField(index, { visible: event.target.checked })} />
      </label>
      <input className="file-category-input" aria-label={`${labels.name} ${index + 1}`} maxLength={24} required disabled={disabled}
        value={name} onChange={event => onField(index, { name: event.target.value })} />
      <input className="file-category-input file-category-extensions" aria-label={`${labels.extensions} ${index + 1}`} required disabled={disabled}
        value={item.extensions.join(" ")} placeholder="pdf docx tar.gz" onChange={event => onField(index, { extensions: [event.target.value] })} />
      <button type="button" className="btn-icon file-category-delete" title={labels.delete} aria-label={`${labels.delete} ${name}`} disabled={disabled} onClick={() => onRemove(index)}>
        <Trash2 size={13} aria-hidden="true" />
      </button>
    </div>
  );
});

function CategoryManager({ t, categories, onSave, onClose }: {
  t: Translate; categories: FileCategory[]; onSave: Props["onSave"]; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => categories.map(item => ({ ...item, name: fileCategoryName(item, t), extensions: [...item.extensions] })));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const commitOrder = useCallback((from: number, to: number) => {
    const moved = draftRef.current[from];
    setDraft(items => moveItem(items, from, to));
    if (moved) setAnnounce(`${fileCategoryName(moved, t)}，${t("sidebar_moved").replace("{n}", String(to + 1))}`);
  }, [t]);

  const { editorRef, drag, beginDrag, sorting } = useDragReorder({ count: draft.length, disabled: saving, onCommit: commitOrder });

  useEffect(() => {
    dialog.current?.showModal();
    if (isTauriRuntime()) void invoke("activate_window_focus").catch(console.error);
  }, []);

  useEffect(() => {
    if (!flashKey) return;
    const timer = window.setTimeout(() => setFlashKey(null), 620);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  const update = useCallback((index: number, patch: Partial<FileCategory>) => {
    setDraft(items => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  }, []);

  const remove = useCallback((index: number) => {
    setDraft(items => items.filter((_, i) => i !== index));
  }, []);

  const nudge = useCallback((index: number, delta: number) => {
    const items = draftRef.current;
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    const moved = items[index];
    setDraft(list => moveItem(list, index, to));
    if (moved) {
      setFlashKey(moved.id);
      setAnnounce(`${fileCategoryName(moved, t)}，${t("sidebar_moved").replace("{n}", String(to + 1))}`);
    }
  }, [t]);

  const labels = useMemo<RowLabels>(() => ({
    reorder: t("sidebar_reorder"),
    visible: t("sidebar_visible"),
    name: t("sidebar_name"),
    extensions: t("sidebar_extensions"),
    delete: t("sidebar_delete")
  }), [t]);

  const addCategory = () => {
    setDraft(items => [...items, { id: crypto.randomUUID(), name: "", extensions: [], icon: "document", visible: true }]);
    window.requestAnimationFrame(() => {
      const last = editorRef.current?.lastElementChild as HTMLElement | null;
      last?.scrollIntoView({ block: "nearest" });
      last?.querySelector<HTMLInputElement>(".file-category-input")?.focus();
    });
  };

  return (
    <dialog ref={dialog} className={`file-category-dialog window-no-drag${sorting ? " is-sorting" : ""}`} aria-labelledby="file-category-title"
      onCancel={event => { event.preventDefault(); if (!saving && !sorting) onClose(); }}
      onKeyDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget && !saving && !sorting) onClose(); }}>
      <form onSubmit={async event => {
        event.preventDefault();
        if (saving) return;
        if (draft.some(item => !item.name.trim() || !parseFileExtensions(item.extensions.join(" ")).length
          || item.extensions.some(value => value.split(/[\s,;，；、]+/).filter(Boolean).some(token => !parseFileExtensions(token).length)))) {
          setError(t("sidebar_invalid")); return;
        }
        setError(""); setSaving(true);
        try {
          await onSave(draft.map(item => ({ ...item, name: item.name.trim(), extensions: parseFileExtensions(item.extensions.join(" ")) })));
          onClose();
        } catch { setError(t("sidebar_save_failed")); setSaving(false); }
      }}>
        <div className="file-category-dialog-heading">
          <h2 id="file-category-title">{t("sidebar_manage")}</h2>
          <button type="button" className="btn-icon" title={t("cancel")} aria-label={t("cancel")} disabled={saving} onClick={onClose}><X size={17} /></button>
        </div>
        <p className="file-category-help">{t("sidebar_help")}</p>
        <div className="file-category-columns" aria-hidden="true"><span>{t("sidebar_name")}</span><span>{t("sidebar_extensions")}</span></div>
        <div className={`file-category-editor${sorting ? " is-sorting" : ""}`} ref={editorRef}>
          {draft.map((item, index) => {
            let translate = 0;
            if (drag) {
              if (index === drag.from) translate = drag.offset;
              else if (drag.to > drag.from && index > drag.from && index <= drag.to) translate = -drag.shift;
              else if (drag.to < drag.from && index >= drag.to && index < drag.from) translate = drag.shift;
            }
            return (
              <CategoryRow key={item.id} item={item} index={index} translate={translate}
                dragging={drag?.phase === "drag" && drag.from === index}
                settling={drag?.phase === "settle" && drag.from === index}
                flashing={flashKey === item.id}
                disabled={saving}
                labels={labels}
                onField={update}
                onRemove={remove}
                onDragStart={beginDrag}
                onNudge={nudge} />
            );
          })}
        </div>
        <p className="file-category-sr" role="status" aria-live="polite">{announce}</p>
        {error && <p className="file-category-error" role="alert">{error}</p>}
        <div className="file-category-editor-tools">
          <button type="button" className="file-category-text-button" disabled={saving} onClick={addCategory}><Plus size={14} />{t("sidebar_add")}</button>
          <button type="button" className="file-category-text-button" disabled={saving} onClick={() => setDraft(DEFAULT_FILE_CATEGORIES.map(item => ({ ...item, name: fileCategoryName(item, t), extensions: [...item.extensions] })))}>{t("sidebar_reset")}</button>
        </div>
        <div className="file-category-dialog-footer">
          <button type="button" className="file-category-secondary" disabled={saving} onClick={onClose}>{t("cancel")}</button>
          <button type="submit" className="file-category-primary" disabled={saving}>{t(saving ? "sidebar_saving" : "sidebar_save")}</button>
        </div>
      </form>
    </dialog>
  );
}

export default function FileCategorySidebar({ t, collapsed, categories, activeCategoryId, typeFilter, onToggle, onSelect, onSave }: Props) {
  const [managing, setManaging] = useState(false);
  const builtins = [
    { id: null, label: t("filter_all"), icon: Grid2X2 },
    { id: "text", label: t("type_text"), icon: Type },
    { id: "image", label: t("type_image"), icon: Image },
    { id: "file", label: t("type_file"), icon: Folder },
    { id: "url", label: t("type_url"), icon: Link },
    { id: "code", label: t("type_code"), icon: Code2 },
    { id: "video", label: t("type_video"), icon: Video },
    { id: "rich_text", label: t("type_rich_text"), icon: FileText }
  ];
  return (
    <aside className={`file-sidebar window-no-drag${collapsed ? " is-collapsed" : ""}`} aria-label={t("sidebar_title")}>
      <div className="file-sidebar-heading" data-tauri-drag-region>
        <span data-tauri-drag-region>{t("sidebar_title")}</span>
        <button type="button" className="file-sidebar-toggle" aria-expanded={!collapsed} aria-controls="file-sidebar-nav"
          title={t(collapsed ? "sidebar_expand" : "sidebar_collapse")} aria-label={t(collapsed ? "sidebar_expand" : "sidebar_collapse")} onClick={onToggle}>
          <PanelLeftClose className="file-sidebar-toggle-collapse" size={18} aria-hidden="true" />
          <PanelLeftOpen className="file-sidebar-toggle-expand" size={18} aria-hidden="true" />
        </button>
      </div>
      <nav id="file-sidebar-nav" className="file-sidebar-nav">
        <div className="file-sidebar-group">
          {builtins.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id || "all"} className="file-sidebar-item" title={label} aria-label={label}
              aria-pressed={!activeCategoryId && typeFilter === id} onClick={() => onSelect(id)}>
              <Icon size={17} aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </div>
        <div className="file-sidebar-group" aria-label={t("sidebar_formats")}>
          <div className="file-sidebar-section-label">{t("sidebar_formats")}</div>
          {categories.filter(item => item.visible).map(item => {
            const Icon = icons[item.icon as keyof typeof icons] || File;
            const name = fileCategoryName(item, t);
            return <button type="button" key={item.id} className="file-sidebar-item" title={`${name} (${item.extensions.map(ext => `.${ext}`).join(", ")})`}
              aria-label={name} aria-pressed={activeCategoryId === item.id} onClick={() => onSelect(null, item.id)}>
              <Icon size={17} aria-hidden="true" /><span>{name}</span><small className="file-sidebar-format-hint" aria-hidden="true">{item.extensions[0]}</small>
            </button>;
          })}
        </div>
      </nav>
      <button type="button" className="file-sidebar-manage file-sidebar-item" title={t("sidebar_manage")} aria-label={t("sidebar_manage")} onClick={() => setManaging(true)}>
        <Settings2 size={17} aria-hidden="true" /><span>{t("sidebar_manage")}</span>
      </button>
      {managing && <CategoryManager t={t} categories={categories} onSave={onSave} onClose={() => setManaging(false)} />}
    </aside>
  );
}
