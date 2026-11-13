import { LoaderCircle, RotateCw, SearchX, SlidersHorizontal, X } from "lucide-react";
import { parseHistorySearch } from "../../../shared/lib/historySearch";
import "../../../styles/components/history-filter.css";

interface HistoryFilterBarProps {
  t: (key: string) => string;
  search: string;
  typeFilter: string | null;
  fileCategoryLabel?: string;
  count: number;
  hasMore: boolean;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  limited: boolean;
  hasSavedData: boolean;
  onClearSearch: () => void;
  onClearType: () => void;
  onClearAll: () => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

export default function HistoryFilterBar({
  t, search, typeFilter, fileCategoryLabel, count, hasMore, status, loadingMore, limited, hasSavedData,
  onClearSearch, onClearType, onClearAll, onRetry, onLoadMore
}: HistoryFilterBarProps) {
  const parsed = parseHistorySearch(search);
  const active = search.trim().length > 0 || !!typeFilter || !!fileCategoryLabel;
  const typeName = typeFilter ? t(`type_${typeFilter === "link" ? "url" : typeFilter}`) : "";
  const searchLabel = `${t(parsed.tagOnly ? "filter_tag" : "filter_keyword")}: ${parsed.term || t("filter_all")}`;
  const typeLabel = `${t(fileCategoryLabel ? "sidebar_formats" : "filter_type")}: ${fileCategoryLabel || typeName}`;
  const message = status === "loading"
    ? t(loadingMore ? "filter_loading_more" : "filter_loading")
    : status === "error"
      ? t(hasSavedData ? "filter_failed_saved" : "filter_failed")
      : t(limited ? "filter_count_limited" : hasMore ? "filter_count_more" : "filter_count_total")
        .replace("{count}", String(count));

  return (
    <section className="history-filter-bar window-no-drag" aria-label={t("filter_panel")}>
      {active && (
        <div className="history-filter-conditions" aria-label={t("filter_active")}>
          <SlidersHorizontal size={14} aria-hidden="true" />
          {search.trim() && (
            <button type="button" className="history-filter-chip" onClick={onClearSearch}
              title={searchLabel} aria-label={`${t("filter_remove")} ${searchLabel}`}>
              <span>{searchLabel}</span><X size={12} aria-hidden="true" />
            </button>
          )}
          {(typeFilter || fileCategoryLabel) && (
            <button type="button" className="history-filter-chip" onClick={onClearType}
              title={typeLabel} aria-label={`${t("filter_remove")} ${typeLabel}`}>
              <span>{typeLabel}</span><X size={12} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="history-filter-text-button" onClick={onClearAll}>
            {t("filter_clear_all")}
          </button>
        </div>
      )}
      <div className={`history-filter-status${status === "error" ? " is-error" : ""}`}>
        <div className="history-filter-message" role="status" aria-live="polite" aria-atomic="true">
          {status === "loading" && <LoaderCircle size={14} className="history-filter-spinner" aria-hidden="true" />}
          <span>{message}</span>
        </div>
        {status === "error" && (
          <button type="button" className="history-filter-action" onClick={onRetry}>
            <RotateCw size={13} aria-hidden="true" />{t("filter_retry")}
          </button>
        )}
        {status === "ready" && hasMore && (
          <button type="button" className="history-filter-text-button" onClick={() => onLoadMore()}>
            {t("filter_load_more")}
          </button>
        )}
      </div>
      {limited && status === "ready" && <p className="history-filter-note">{t("filter_limit_hint")}</p>}
      {count === 0 && status === "ready" && active && (
        <div className="history-filter-empty">
          <SearchX size={30} strokeWidth={1.5} aria-hidden="true" />
          <strong>{t("filter_empty")}</strong>
          <p>{t("filter_empty_hint")}</p>
          <div className="history-filter-empty-actions">
            {(typeFilter || fileCategoryLabel) && <button type="button" className="history-filter-action" onClick={onClearType}>{t("filter_remove_type")}</button>}
            <button type="button" className="history-filter-action" onClick={onClearAll}>{t("filter_clear_all")}</button>
          </div>
        </div>
      )}
    </section>
  );
}
