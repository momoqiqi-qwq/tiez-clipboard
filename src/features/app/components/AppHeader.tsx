import type { RefObject } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronLeft,
  FolderDown,
  MessageSquare,
  Pin,
  PinOff,
  Search,
  Settings as SettingsIcon,
  Smile,
  Tag,
  Trash2,
  X
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import TagFilterPicker from "./TagFilterPicker";
import { useDraggableActions } from "../hooks/useDraggableActions";
import { parseHistorySearch } from "../../../shared/lib/historySearch";

interface AppHeaderProps {
  t: (key: string) => string;
  showSettings: boolean;
  setShowSettings: (val: boolean) => void;
  showTagManager: boolean;
  setShowTagManager: (val: boolean) => void;
  tagManagerEnabled: boolean;
  dragOutEnabled: boolean;
  setDragOutEnabled: (val: boolean) => void;
  showEmojiPanel: boolean;
  setShowEmojiPanel: (val: boolean) => void;
  emojiPanelEnabled: boolean;
  chatMode: boolean;
  fileServerEnabled: boolean;
  isWindowPinned: boolean;
  setIsWindowPinned: (val: boolean) => void;
  clearHistory: () => void;
  showSearchBox: boolean;
  search: string;
  setSearch: (val: string) => void;
  onCommitSearch: (val: string) => void;
  setIsComposing: (val: boolean) => void;
  searchInputRef: RefObject<HTMLInputElement | null>;
  filterTags: string[];
  setEditingTagsId: (val: number | null) => void;
  theme: string;
  colorMode: string;
  settingsTitle: string;
  onBack: () => void;
  onToggleChat: () => void;
}

const AppHeader = ({
  t,
  showSettings,
  setShowSettings,
  showTagManager,
  setShowTagManager,
  tagManagerEnabled,
  dragOutEnabled,
  setDragOutEnabled,
  showEmojiPanel,
  setShowEmojiPanel,
  emojiPanelEnabled,
  chatMode,
  fileServerEnabled,
  isWindowPinned,
  setIsWindowPinned,
  clearHistory,
  showSearchBox,
  search,
  setSearch,
  onCommitSearch,
  setIsComposing,
  searchInputRef,
  filterTags,
  setEditingTagsId,
  theme,
  colorMode,
  settingsTitle,
  onBack,
  onToggleChat
}: AppHeaderProps) => {
  // A tag switch reuses the existing `tag:<name>` search syntax, so filtering
  // goes through the backend tag search instead of adding a second filter state.
  const parsedSearch = parseHistorySearch(search);
  const activeTagFilter = parsedSearch.tagOnly ? parsedSearch.normalizedTerm : "";

  const actionsBar = useDraggableActions();

  const toggleTagFilter = (tag: string) => {
    onCommitSearch(activeTagFilter && activeTagFilter === tag.trim().toLowerCase() ? "" : `tag:${tag}`);
  };

  return (
  <header className="window-drag-region">
    <div className="header-top">
      <div className="header-leading">
        {(showSettings || showTagManager || showEmojiPanel) && (
          <button className="btn-icon window-no-drag" onClick={onBack}>
            <ChevronLeft size={18} />
          </button>
        )}
        <div className="header-drag-region" data-tauri-drag-region>
          <span className="header-title">
            {showEmojiPanel
              ? (t('emoji_panel') || '表情包')
              : showTagManager && tagManagerEnabled
                ? (t('tag_manager') || '标签管理')
                : showSettings
                  ? settingsTitle
                  : t('app_name')}
          </span>
        </div>
      </div>
      <div
        ref={actionsBar.ref}
        className={`header-actions window-no-drag${actionsBar.dragging ? " is-dragging" : ""}${actionsBar.settling ? " is-settling" : ""}`}
        style={actionsBar.style}
        {...actionsBar.handlers}
      >
        <div className="header-actions-inner" style={actionsBar.innerStyle}>
          <span
            className="header-actions-grip"
            title={t('toolbar_drag_hint') || '按住拖动，双击复位'}
            aria-hidden="true"
          />
          {/* Pin Button - Always visible but single instance */}
          <button
            className={`btn-icon ${isWindowPinned ? 'active' : ''}`}
            title={t('pin')}
            onClick={() => {
              const newVal = !isWindowPinned;
              setIsWindowPinned(newVal);
              invoke("set_window_pinned", { pinned: newVal }).catch(console.error);
            }}
          >
            {isWindowPinned ? <PinOff size={16} /> : <Pin size={16} />}
          </button>

          {!showSettings && !showTagManager && !showEmojiPanel && (
            <>
              <button className="btn-icon" title={t('clear_history')} onClick={clearHistory}>
                <Trash2 size={16} />
              </button>
              {tagManagerEnabled && (
                <button className="btn-icon" title={t('tag_manager') || '标签管理'} onClick={() => setShowTagManager(true)}>
                  <Tag size={16} />
                </button>
              )}
              {emojiPanelEnabled && (
                <button className="btn-icon" title={t('emoji_panel') || '表情包'} onClick={() => setShowEmojiPanel(true)}>
                  <Smile size={16} />
                </button>
              )}
              <button
                className={`btn-icon ${dragOutEnabled ? 'active' : ''}`}
                title={dragOutEnabled
                  ? (t('drag_out_on') || '拖拽导出已开启：按住条目拖到文件夹')
                  : (t('drag_out') || '拖拽导出：可以拖动剪贴板内容到文件夹')}
                onClick={() => setDragOutEnabled(!dragOutEnabled)}
              >
                <FolderDown size={16} />
              </button>
              <button className="btn-icon" title={t('settings')} onClick={() => setShowSettings(true)}>
                <SettingsIcon size={16} />
              </button>
            </>
          )}
          {fileServerEnabled && (
            <button
              className={`btn-icon header-chat-btn ${chatMode && showSettings ? 'active' : ''}`}
              title="Chat"
              onClick={onToggleChat}
            >
              <MessageSquare size={16} />
            </button>
          )}
          <button className="btn-icon header-actions-close" title={t('hide')} onClick={async () => {
            invoke("hide_window_cmd").catch(console.error);
          }}>
            <X size={16} />
          </button>
        </div>
      </div>
    </div>

    {!showSettings && !showTagManager && !showEmojiPanel && (
      <AnimatePresence>
        {(showSearchBox || search.trim().length > 0) && (
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: 'hidden' }}
            animate={{
              height: "auto",
              opacity: 1,
              transitionEnd: { overflow: "visible" }
            }}
            exit={{ height: 0, opacity: 0, overflow: 'hidden' }}
            transition={{ duration: 0.2, ease: "circOut" }}
            style={{ flexShrink: 0 }}
          >
            <div className="search-container window-no-drag">
              <div style={{ position: 'relative' }}>
                <Search size={14} className="search-icon" />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="search-input"
                  placeholder={t('search_placeholder')}
                  value={search}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={(e) => {
                    setIsComposing(false);
                    setSearch((e.target as HTMLInputElement).value);
                  }}
                  onChange={(e) => {
                    setSearch(e.target.value);
                  }}
                  onMouseDown={() => {
                    invoke("activate_window_focus").catch(console.error);
                  }}
                  onClick={() => setEditingTagsId(null)}
                  onFocus={() => {
                    invoke("activate_window_focus").catch(console.error);
                    setEditingTagsId(null);
                  }}
                  style={{ color: colorMode === 'dark' ? '#ffffff' : undefined }}
                />
              </div>
              <TagFilterPicker tags={filterTags} activeTag={activeTagFilter} theme={theme}
                t={t} onSelect={toggleTagFilter} />

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    )}
  </header>
);
};

export default AppHeader;
