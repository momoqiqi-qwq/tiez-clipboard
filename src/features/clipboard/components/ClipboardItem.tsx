import { useRef, useEffect, useLayoutEffect, useState, useMemo, memo } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
    Pin,
    PinOff,
    Eye,
    EyeOff,
    ExternalLink,
    Tag,
    X,
    FileText,
    Image as ImageIcon,
    Link as LinkIcon,
    Code,
    File,
    Plus,
    Video,
    Sparkles,
    Loader2,
    FileArchive,
    Music,
    FileCode,
    Cpu,
    Files,
    ImageOff,
    FileQuestion,
    GripVertical,
    StickyNote
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ClipboardItemProps } from "../types";
import {
    formatSensitivePreview,
    getConciseTime,
    getTagColor,
    getTagTextColor
} from "../../../shared/lib/utils";
import HtmlContent from "../../../shared/components/HtmlContent";
import { toTauriLocalImageSrc } from "../../../shared/lib/localImageSrc";
import { getRichTextSnapshotDataUrl } from "../../../shared/lib/richTextSnapshot";
import { getFileIcon as getSystemFileIcon, peekFileIcon } from "../../../shared/lib/fileIcon";
import { getSourceAppIcon, peekSourceAppIcon } from "../../../shared/lib/sourceAppIcon";
import { registerCompactPreviewControls } from "../lib/compactPreviewControls";
import { debugLog, isDebugLogging } from "../../../shared/lib/debug";

const COMPACT_PREVIEW_LABEL = "compact-preview";
// 拖拽导出：按下后移动超过这个距离才算「拖」，否则当成一次普通点击（粘贴）。
// 取 6px 而不是系统默认的 SM_CXDRAG(4px)：手抖 4-5px 很常见，误判成拖拽会直接吞掉粘贴，
// 而真正要拖到文件夹的人早就移动了几十上百像素，多 2px 门槛不影响手感。
const DRAG_OUT_THRESHOLD_PX = 6;
const RICH_IMAGE_FALLBACK_PREFIX = "<!--TIEZ_RICH_IMAGE:";
const RICH_IMAGE_FALLBACK_SUFFIX = "-->";
const TABULAR_RICH_HTML_RE = /<(table|tr|td|th|thead|tbody|tfoot|colgroup|col)\b/i;
const SPREADSHEET_SOURCE_RE = /\b(excel|et|wps|sheet|spreadsheet|calc)\b/i;
const SPREADSHEET_APP_RE = /(?:^|[\\/])(excel|et|wps|wpssheet|soffice)(?:\.exe|\.app)?$/i;
const STANDALONE_COLOR_RE = /^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|hsl)a?\(\s*[^)]+\s*\))$/i;
const IS_MACOS =
    typeof navigator !== "undefined" &&
    (/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) || /Mac/i.test(navigator.platform));
const COMPACT_PREVIEW_WINDOW_SUPPORTED = true;
const COMPACT_PREVIEW_WARMUP_SUPPORTED = !IS_MACOS;
const compactPreviewLog = (...args: unknown[]) => {
    if (!isDebugLogging) return;
    const ts = new Date().toISOString();
    debugLog(`[CompactPreview][Main][${ts}]`, ...args);
};
const richPreviewFailureLog = (stage: string, detail?: Record<string, unknown>) => {
    console.warn("[RichTextPreview][MainList]", stage, detail || {});
};
type CompactPreviewAnchor = {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
};

const extractRichImageFallback = (html?: string): { cleanHtml?: string; imagePayload?: string } => {
    if (!html) return {};
    const start = html.lastIndexOf(RICH_IMAGE_FALLBACK_PREFIX);
    if (start < 0) return { cleanHtml: html };

    const markerStart = start + RICH_IMAGE_FALLBACK_PREFIX.length;
    const endRel = html.slice(markerStart).indexOf(RICH_IMAGE_FALLBACK_SUFFIX);
    if (endRel < 0) return { cleanHtml: html };

    const markerEnd = markerStart + endRel;
    const payload = html.slice(markerStart, markerEnd).trim();
    const cleanHtml = `${html.slice(0, start)}${html.slice(markerEnd + RICH_IMAGE_FALLBACK_SUFFIX.length)}`.trim();
    return {
        cleanHtml: cleanHtml || html,
        imagePayload: payload || undefined
    };
};

const resolveRichImageSrc = (payload?: string): string | null => {
    if (!payload) return null;
    const value = payload.trim();
    if (!value) return null;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\/asset\.localhost\//i.test(value)) return value;
    return toTauriLocalImageSrc(value);
};

const isAnimatedGifSrc = (src?: string | null): boolean => {
    const value = (src || "").trim().toLowerCase();
    if (!value) return false;
    return value.startsWith("data:image/gif") || /\.gif(?:$|[?#])/i.test(value);
};

const richHtmlLooksTabular = (html?: string): boolean => {
    if (!html) return false;
    return TABULAR_RICH_HTML_RE.test(html);
};

const isSpreadsheetLikeSource = (...candidates: Array<string | undefined>): boolean => {
    return candidates.some((candidate) => {
        const value = (candidate || "").trim();
        if (!value) return false;
        return SPREADSHEET_APP_RE.test(value) || SPREADSHEET_SOURCE_RE.test(value);
    });
};

const getStandaloneColorValue = (contentType: string, content: string): string | null => {
    if (contentType !== "text" && contentType !== "code") {
        return null;
    }

    const normalized = content.trim();
    if (!normalized || normalized.includes("\n")) {
        return null;
    }

    return STANDALONE_COLOR_RE.test(normalized) ? normalized : null;
};

let compactPreviewWindow: WebviewWindow | null = null;
let compactPreviewCreating = false;
let compactPreviewReady: Promise<WebviewWindow | null> | null = null;
let compactPreviewMounted = false;
let compactPreviewMountedPromise: Promise<boolean> | null = null;
let compactPreviewResizeListener: Promise<() => void> | null = null;
let compactPreviewPendingShow = false;
let compactPreviewPendingAnchor: CompactPreviewAnchor | null = null;
let compactPreviewPendingTimer: ReturnType<typeof setTimeout> | null = null;
let compactPreviewLifecycleListenersReady: Promise<void> | null = null;

const loadWebviewWindowModule = async () => import("@tauri-apps/api/webviewWindow");

const setIgnoreBlurSafe = (ignore: boolean) => {
    compactPreviewLog("set_ignore_blur", { ignore });
    invoke("set_ignore_blur", { ignore }).catch(() => { });
};

const clearCompactPreviewPendingState = () => {
    compactPreviewLog("clear pending state");
    if (compactPreviewPendingTimer) {
        clearTimeout(compactPreviewPendingTimer);
        compactPreviewPendingTimer = null;
    }
    compactPreviewPendingShow = false;
    compactPreviewPendingAnchor = null;
};

const resolveAnchorPhysical = async (
    anchor: CompactPreviewAnchor,
    scale: number
): Promise<{ x: number; y: number }> => {
    try {
        const appWindow = getCurrentWindow();
        const outer = await appWindow.outerPosition();
        return {
            x: Math.round(outer.x + anchor.clientX * scale),
            y: Math.round(outer.y + anchor.clientY * scale)
        };
    } catch {
        return {
            x: Math.round(anchor.screenX * scale),
            y: Math.round(anchor.screenY * scale)
        };
    }
};

const pickPreviewPosition = (
    anchorX: number,
    anchorY: number,
    widthPx: number,
    heightPx: number,
    monitorPos: { x: number; y: number },
    monitorSize: { width: number; height: number },
    margin: number,
    offset: number,
    avoidRect?: { left: number; top: number; right: number; bottom: number } | null
) => {
    const left = monitorPos.x + margin;
    const top = monitorPos.y + margin;
    const right = monitorPos.x + monitorSize.width - margin;
    const bottom = monitorPos.y + monitorSize.height - margin;

    const clampPoint = (p: { x: number; y: number }) => ({
        x: Math.min(Math.max(p.x, left), right - widthPx),
        y: Math.min(Math.max(p.y, top), bottom - heightPx)
    });

    const intersectsAvoidRect = (p: { x: number; y: number }) => {
        if (!avoidRect) return false;
        const previewRect = {
            left: p.x,
            top: p.y,
            right: p.x + widthPx,
            bottom: p.y + heightPx
        };
        return !(
            previewRect.right <= avoidRect.left ||
            previewRect.left >= avoidRect.right ||
            previewRect.bottom <= avoidRect.top ||
            previewRect.top >= avoidRect.bottom
        );
    };

    const candidates = [
        { x: anchorX + offset, y: anchorY + offset }, // right-bottom
        { x: anchorX + offset, y: anchorY - heightPx - offset }, // right-top
        { x: anchorX - widthPx - offset, y: anchorY + offset }, // left-bottom
        { x: anchorX - widthPx - offset, y: anchorY - heightPx - offset } // left-top
    ];

    const fits = (p: { x: number; y: number }) =>
        p.x >= left && p.y >= top && p.x + widthPx <= right && p.y + heightPx <= bottom;

    for (const c of candidates) {
        if (fits(c) && !intersectsAvoidRect(c)) return c;
    }

    if (avoidRect) {
        const outsideCandidates = [
            { x: avoidRect.right + offset, y: anchorY - Math.round(heightPx * 0.25) }, // right of main
            { x: avoidRect.left - widthPx - offset, y: anchorY - Math.round(heightPx * 0.25) }, // left of main
            { x: anchorX - Math.round(widthPx * 0.2), y: avoidRect.top - heightPx - offset }, // above main
            { x: anchorX - Math.round(widthPx * 0.2), y: avoidRect.bottom + offset } // below main
        ].map(clampPoint);

        for (const c of outsideCandidates) {
            if (!intersectsAvoidRect(c)) return c;
        }
    }

    for (const c of candidates) {
        const clamped = clampPoint(c);
        if (!intersectsAvoidRect(clamped)) return clamped;
    }

    // Final fallback: clamp the default candidate into monitor bounds.
    return clampPoint(candidates[0]);
};

const placeAndShowPendingCompactPreview = async (
    widthLogical: number,
    heightLogical: number,
    options?: { keepPending?: boolean }
) => {
    if (!compactPreviewPendingShow || !compactPreviewWindow || !compactPreviewPendingAnchor) {
        compactPreviewLog("skip place/show: pending state not ready", {
            pendingShow: compactPreviewPendingShow,
            hasWindow: !!compactPreviewWindow,
            hasAnchor: !!compactPreviewPendingAnchor
        });
        return;
    }

    const appWindow = getCurrentWindow();
    const scale = await appWindow.scaleFactor();
    const monitor = await currentMonitor();
    const monitorPos = monitor?.position || { x: 0, y: 0 };
    const monitorSize = monitor?.size || { width: 1920, height: 1080 };
    const margin = Math.round(10 * scale);
    const offset = Math.round(12 * scale);

    const widthPx = Math.round(widthLogical * scale);
    const heightPx = Math.round(heightLogical * scale);
    const anchorPx = await resolveAnchorPhysical(compactPreviewPendingAnchor, scale);
    const mainOuter = await appWindow.outerPosition().catch(() => null);
    const mainSize = await appWindow.outerSize().catch(() => null);
    const avoidRect =
        mainOuter && mainSize
            ? {
                left: mainOuter.x,
                top: mainOuter.y,
                right: mainOuter.x + mainSize.width,
                bottom: mainOuter.y + mainSize.height
            }
            : null;

    const target = pickPreviewPosition(
        anchorPx.x,
        anchorPx.y,
        widthPx,
        heightPx,
        monitorPos,
        monitorSize,
        margin,
        offset,
        avoidRect
    );
    compactPreviewLog("place/show target resolved", {
        widthLogical,
        heightLogical,
        widthPx,
        heightPx,
        anchorPx,
        target,
        avoidRect,
        scale
    });

    setIgnoreBlurSafe(true);
    try {
        await compactPreviewWindow.setPosition(new PhysicalPosition(target.x, target.y));
        await compactPreviewWindow.show();
        // Force top-most z-order refresh so preview is not occluded by the main top-most window.
        // macOS skips this toggle because frequent style-mask sync can cause UI stalls.
        if (!IS_MACOS) {
            try {
                await compactPreviewWindow.setAlwaysOnTop(false);
                await compactPreviewWindow.setAlwaysOnTop(true);
                compactPreviewLog("refresh always-on-top stacking done");
            } catch (stackErr) {
                compactPreviewLog("refresh always-on-top stacking failed", stackErr);
            }
        }
        const visible = await compactPreviewWindow.isVisible().catch(() => null);
        compactPreviewLog("preview window shown", { visible, target });
    } catch (err) {
        setIgnoreBlurSafe(false);
        compactPreviewLog("preview show failed", err);
        throw err;
    }
    if (options?.keepPending) {
        compactPreviewLog("keep pending state after place/show", { widthLogical, heightLogical });
    } else {
        clearCompactPreviewPendingState();
    }
};

const hideCompactPreviewGlobal = async () => {
    const previewWindow = compactPreviewWindow;
    compactPreviewLog("hide preview requested", { hasWindow: !!previewWindow });
    clearCompactPreviewPendingState();
    setIgnoreBlurSafe(false);

    if (!previewWindow) return;

    try {
        await previewWindow.hide();
        const visible = await previewWindow.isVisible().catch(() => null);
        compactPreviewLog("preview window hidden", { visible });
    } catch (err) {
        console.error("Failed to hide compact preview window:", err);
        compactPreviewLog("hide preview failed, reset window reference", err);
        compactPreviewWindow = null;
        compactPreviewMounted = false;
        compactPreviewMountedPromise = null;
    }
};

const forceHideCompactPreviewWindow = () => {
    void hideCompactPreviewGlobal();
};

const seekVideoPreviewFrame = (video: HTMLVideoElement | null) => {
    if (!video) return;
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const maxSeek = Math.max(duration - 0.05, 0);
    if (maxSeek <= 0) return;
    const preferred = Math.min(duration * 0.1, 2);
    const target = Math.min(Math.max(preferred, 0.1), maxSeek);
    if (target <= 0) return;
    try {
        video.currentTime = target;
    } catch {
        // Ignore seek errors; fallback will just show the first frame.
    }
};

const waitForCompactPreviewMounted = async (): Promise<boolean> => {
    if (compactPreviewMounted) {
        compactPreviewLog("mounted already true, skip wait");
        return true;
    }
    if (!compactPreviewMountedPromise) {
        compactPreviewLog("waiting compact preview mounted event...");
        compactPreviewMountedPromise = new Promise(async (resolve) => {
            const timeout = setTimeout(() => {
                compactPreviewLog("wait compact-preview-mounted timeout");
                resolve(false);
            }, 1200);
            try {
                const unlisten = await listen("compact-preview-mounted", () => {
                    compactPreviewMounted = true;
                    clearTimeout(timeout);
                    unlisten();
                    compactPreviewLog("received compact-preview-mounted");
                    resolve(true);
                });
            } catch (err) {
                clearTimeout(timeout);
                console.error("Failed to listen for compact preview ready:", err);
                compactPreviewLog("listen compact-preview-mounted failed", err);
                resolve(false);
            }
        });
    }
    return compactPreviewMountedPromise;
};

const ensureCompactPreviewResizeListener = async (): Promise<void> => {
    if (compactPreviewResizeListener) {
        await compactPreviewResizeListener;
        return;
    }
    compactPreviewLog("register compact-preview-resize listener");
    compactPreviewResizeListener = listen<{ width: number; height: number }>(
        "compact-preview-resize",
        async (event) => {
            const { width, height } = event.payload || {};
            if (!width || !height) {
                compactPreviewLog("ignore compact-preview-resize with invalid payload", event.payload);
                return;
            }
            compactPreviewLog("received compact-preview-resize", { width, height });

            try {
                await placeAndShowPendingCompactPreview(width, height);
            } catch (err) {
                console.error("Failed to resize compact preview window:", err);
                compactPreviewLog("resize handling failed", err);
            }
        }
    );
    await compactPreviewResizeListener;
};

const ensureCompactPreviewLifecycleListeners = async (): Promise<void> => {
    if (compactPreviewLifecycleListenersReady) {
        await compactPreviewLifecycleListenersReady;
        return;
    }

    compactPreviewLifecycleListenersReady = (async () => {
        const lifecycleEvents = ["tauri://hide", "tauri://close-requested", "tauri://destroyed"];
        await Promise.all(
            lifecycleEvents.map(async (eventName) => {
                try {
                    compactPreviewLog("bind lifecycle listener", eventName);
                    await listen(eventName, () => {
                        compactPreviewLog("lifecycle event -> hide preview", eventName);
                        void hideCompactPreviewGlobal();
                    });
                } catch (err) {
                    console.error(`Failed to bind compact preview lifecycle listener: ${eventName}`, err);
                    compactPreviewLog("bind lifecycle listener failed", { eventName, err });
                }
            })
        );
    })();

    await compactPreviewLifecycleListenersReady;
};

const tryReuseExistingCompactPreviewWindow = async (): Promise<WebviewWindow | null> => {
    try {
        const { WebviewWindow } = await loadWebviewWindowModule();
        const existing = await WebviewWindow.getByLabel(COMPACT_PREVIEW_LABEL);
        if (!existing) {
            compactPreviewLog("no existing compact preview window by label");
            return null;
        }

        const visible = await existing.isVisible().catch(() => null);
        compactPreviewLog("reuse compact preview window by label", { visible });
        compactPreviewWindow = existing;
        compactPreviewMounted = true;
        compactPreviewMountedPromise = Promise.resolve(true);
        try {
            await existing.setIgnoreCursorEvents(true);
        } catch { }
        try {
            await existing.setAlwaysOnTop(true);
        } catch { }
        return existing;
    } catch (err) {
        compactPreviewLog("reuse compact preview window by label failed", err);
        return null;
    }
};

const ensureCompactPreviewWindow = async (): Promise<WebviewWindow | null> => {
    if (!COMPACT_PREVIEW_WINDOW_SUPPORTED) return null;
    if (compactPreviewWindow) {
        compactPreviewMounted = true;
        compactPreviewMountedPromise = Promise.resolve(true);
        compactPreviewLog("reuse existing compact preview window");
        return compactPreviewWindow;
    }
    if (compactPreviewReady) return compactPreviewReady;
    if (compactPreviewCreating) return null;
    const reusedBeforeCreate = await tryReuseExistingCompactPreviewWindow();
    if (reusedBeforeCreate) {
        return reusedBeforeCreate;
    }
    compactPreviewLog("create compact preview window start");
    compactPreviewCreating = true;
    compactPreviewReady = (async () => {
        try {
            const { WebviewWindow } = await loadWebviewWindowModule();
            const previewWindow = new WebviewWindow(COMPACT_PREVIEW_LABEL, {
                url: "index.html?window=compact-preview",
                decorations: false,
                transparent: true,
                resizable: false,
                skipTaskbar: true,
                alwaysOnTop: true,
                visible: false,
                focus: false,
                focusable: false,
                shadow: false
            });

            compactPreviewMounted = false;
            compactPreviewMountedPromise = null;
            compactPreviewLog("compact preview window instance created, waiting tauri://created");

            const created = await new Promise<boolean>((resolve) => {
                const timeout = setTimeout(() => resolve(false), 1500);
                previewWindow.once("tauri://created", () => {
                    clearTimeout(timeout);
                    compactPreviewLog("compact preview tauri://created");
                    resolve(true);
                });
                previewWindow.once("tauri://error", (event) => {
                    clearTimeout(timeout);
                    compactPreviewLog("compact preview tauri://error", event.payload);
                    resolve(false);
                });
            });

            if (!created) {
                compactPreviewLog("compact preview create timeout/failure, try reuse by label");
                const reusedAfterFailedCreate = await tryReuseExistingCompactPreviewWindow();
                if (reusedAfterFailedCreate) {
                    return reusedAfterFailedCreate;
                }
                return null;
            }

            try {
                await previewWindow.setSize(new PhysicalSize(1, 1));
            } catch (err) {
                console.error("Failed to initialize compact preview size:", err);
            }

            try {
                await previewWindow.setIgnoreCursorEvents(true);
            } catch (err) {
                console.error("Failed to enable ignore cursor events:", err);
            }

            compactPreviewWindow = previewWindow;
            compactPreviewLog("compact preview window ready");
            return previewWindow;
        } catch (err) {
            console.error("Failed to create compact preview window:", err);
            compactPreviewLog("create compact preview window failed", err);
            return null;
        } finally {
            compactPreviewCreating = false;
            compactPreviewReady = null;
        }
    })();
    return compactPreviewReady;
};

/**
 * Pre-warm the compact preview window so it's ready before the user hovers.
 * On macOS we deliberately skip warmup to reduce startup-time UI stalls.
 */
const warmupCompactPreviewWindow = () => {
    if (!COMPACT_PREVIEW_WINDOW_SUPPORTED || !COMPACT_PREVIEW_WARMUP_SUPPORTED) return;
    // Only warm up if not already created/creating
    if (compactPreviewWindow || compactPreviewCreating || compactPreviewReady) return;
    compactPreviewLog("warmup: pre-creating compact preview window");
    // Fire and forget - creates the window in the background
    ensureCompactPreviewWindow().catch((err) => {
        compactPreviewLog("warmup: failed", err);
    });
};

const isCompactPreviewWindowSupported = () => COMPACT_PREVIEW_WINDOW_SUPPORTED;
const isCompactPreviewWarmupSupported = () => COMPACT_PREVIEW_WARMUP_SUPPORTED;

registerCompactPreviewControls({
    forceHide: forceHideCompactPreviewWindow,
    warmup: warmupCompactPreviewWindow,
    supported: isCompactPreviewWindowSupported,
    warmupSupported: isCompactPreviewWarmupSupported,
});

const getIcon = (type: string) => {
    switch (type) {
        case "text": return <FileText size={14} />;
        case "image": return <ImageIcon size={14} />;
        case "url": return <LinkIcon size={14} />;
        case "code": return <Code size={14} />;
        case "file": return <File size={14} />;
        case "video": return <Video size={14} />;
        default: return <FileText size={14} />;
    }
};

const renderSourceAppIcon = (iconSrc: string | null, contentType: string, sourceApp: string) => {
    if (!iconSrc) {
        return getIcon(contentType);
    }

    return (
        <img
            src={iconSrc}
            alt={`${sourceApp} icon`}
            className="source-app-icon"
            loading="lazy"
        />
    );
};

const getFallbackFileIcon = (filePath: string) => {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'zip':
        case 'rar':
        case '7z':
        case 'tar':
        case 'gz':
            return <FileArchive size={20} />;
        case 'mp3':
        case 'wav':
        case 'flac':
        case 'm4a':
            return <Music size={20} />;
        case 'exe':
        case 'msi':
        case 'bat':
        case 'sh':
            return <Cpu size={20} />;
        case 'pdf':
        case 'doc':
        case 'docx':
        case 'ppt':
        case 'pptx':
        case 'xls':
        case 'xlsx':
            return <FileText size={20} />;
        case 'js':
        case 'ts':
        case 'tsx':
        case 'jsx':
        case 'py':
        case 'rs':
        case 'c':
        case 'cpp':
        case 'go':
        case 'java':
        case 'html':
        case 'css':
        case 'json':
            return <FileCode size={20} />;
        default:
            return <File size={20} />;
    }
};

const ClipboardItem = ({
    item,
    isSelected,
    isSensitiveHidden,
    isRevealed,
    isEditingTags,
    tagInput,
    tagSuggestions = [],
    theme,
    language,
    t,
    isAIProcessing,
    onSelect,
    onCopy,
    onToggleReveal,
    onOpen,
    onTogglePin,
    onDelete,
    onToggleTagEditor,
    onTagInput,
    onTagAdd,
    onTagPick,
    onTagEditCancel,
    onTagDelete,
    onAIAction,
    onInputSubmit,
    aiEnabled,
    aiOptionsOpen,
    onAIOptionsToggle,
    tagColors,
    richTextSnapshotPreview = false,
    showSourceAppIcon = true,
    sensitiveMaskPrefixVisible = 3,
    sensitiveMaskSuffixVisible = 3,
    sensitiveMaskEmailDomain = false,
    quickPasteHint,
    dragOutEnabled,
    onStartDragOut,
    dragControls,
    id,
    compactMode,
    className,
    disableLayout
}: ClipboardItemProps & { compactMode?: boolean, className?: string }) => {
    const itemRef = useRef<HTMLDivElement | null>(null);
    const tagInputRef = useRef<HTMLInputElement>(null);
    // 拖拽导出：mousedown 之后、拖拽成型之前挂着的全局监听器，留一个清理入口。
    // 窗口在这一小段时间里被隐藏或失焦时 mouseup 收不到，监听会残留到下一次鼠标操作，
    // 把无关的按住移动（拖滚动条、拖选文字）误判成「拖出这个条目」。
    const pendingDragOutCleanupRef = useRef<(() => void) | null>(null);
    useEffect(() => () => {
        pendingDragOutCleanupRef.current?.();
        pendingDragOutCleanupRef.current = null;
    }, []);
    const [localTagInput, setLocalTagInput] = useState(tagInput);
    const [localAiOptionsOpen, setLocalAiOptionsOpen] = useState(!!aiOptionsOpen);
    const [snapshotFailed, setSnapshotFailed] = useState(false);
    const [richImageFallbackFailed, setRichImageFallbackFailed] = useState(false);
    const [sourceAppIcon, setSourceAppIcon] = useState<string | null>(() => peekSourceAppIcon(item.source_app_path) ?? null);
    const filePaths = useMemo(
        () => item.content_type === "file" ? item.content.split('\n').filter((p) => p.trim()) : [],
        [item.content, item.content_type]
    );
    const singleFilePath = filePaths.length === 1 ? filePaths[0] : null;
    const [fileIcon, setFileIcon] = useState<string | null>(() => peekFileIcon(singleFilePath) ?? null);
    const isComposing = useRef(false);
    const richSnapshotImgRef = useRef<HTMLImageElement | null>(null);
    const richSnapshotFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverAnchorRef = useRef<CompactPreviewAnchor | null>(null);
    const hoverRequestIdRef = useRef(0);
    const richTextFallback = item.content_type === "rich_text" && item.html_content
        ? (() => {
            const { cleanHtml, imagePayload } = extractRichImageFallback(item.html_content);
            return {
                cleanHtml: cleanHtml || item.html_content,
                imagePayload,
                imageSrc: resolveRichImageSrc(imagePayload)
            };
        })()
        : null;
    const pickableTagSuggestions = useMemo(() => {
        if (!isEditingTags) return [];
        const existing = new Set(item.tags || []);
        const q = localTagInput.trim().toLowerCase();
        return tagSuggestions
            .filter((tag) => !existing.has(tag))
            .filter((tag) => !q || tag.toLowerCase().includes(q))
            .slice(0, 14);
    }, [isEditingTags, item.tags, localTagInput, tagSuggestions]);

    const [tagSuggestIndex, setTagSuggestIndex] = useState(-1);
    const tagSuggestListRef = useRef<HTMLDivElement | null>(null);

    // 备注（note 列）：自由文本注释。
    // 编辑态、草稿、已保存值三份分开存 —— noteLocal 是保存成功后的乐观副本，
    // 父级数组里的 item.note 要等 clipboard-changed 重新拉数据才更新，
    // 只看 item.note 的话刚写完会闪回旧值。
    const [noteOpen, setNoteOpen] = useState(false);
    const [noteDraft, setNoteDraft] = useState("");
    const [noteLocal, setNoteLocal] = useState<string | null>(null);
    const [noteSaving, setNoteSaving] = useState(false);
    const noteEditorRef = useRef<HTMLDivElement | null>(null);
    const noteBlurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const noteValue = noteLocal ?? item.note ?? "";

    useEffect(() => () => {
        if (noteBlurTimerRef.current) clearTimeout(noteBlurTimerRef.current);
    }, []);

    // 后端把新值带回来（clipboard-changed → 重新拉列表）之后，乐观副本就过期了，
    // 交回给 item.note，避免本地留着旧值跟服务端打架。
    useEffect(() => {
        setNoteLocal(null);
    }, [item.note]);

    useEffect(() => {
        if (!isEditingTags) setTagSuggestIndex(-1);
    }, [isEditingTags]);

    useEffect(() => {
        setTagSuggestIndex((prev) => {
            if (pickableTagSuggestions.length === 0) return -1;
            if (prev < 0) return -1;
            return Math.min(prev, pickableTagSuggestions.length - 1);
        });
    }, [pickableTagSuggestions]);

    useLayoutEffect(() => {
        if (tagSuggestIndex < 0 || !tagSuggestListRef.current) return;
        const row = tagSuggestListRef.current.children[tagSuggestIndex] as HTMLElement | undefined;
        row?.scrollIntoView({ block: "nearest" });
    }, [tagSuggestIndex, pickableTagSuggestions]);

    useEffect(() => {
        if (!isEditingTags || !onTagEditCancel) return;

        const onDocMouseDown = (e: MouseEvent) => {
            if (e.button !== 0) return;
            const root = itemRef.current;
            if (!root) return;
            const t = e.target as HTMLElement;

            if (root.contains(t)) {
                if (t.closest(".tag-edit-anchor")) return;
                if (t.closest(".item-tags-container .tag-chip")) return;
                if (
                    t.closest("button") ||
                    t.closest("input") ||
                    t.closest("textarea") ||
                    t.closest('[role="button"]') ||
                    t.closest(".drag-handle")
                ) {
                    return;
                }
            }

            onTagEditCancel();
            e.preventDefault();
            e.stopPropagation();
        };

        document.addEventListener("mousedown", onDocMouseDown, true);
        return () => document.removeEventListener("mousedown", onDocMouseDown, true);
    }, [isEditingTags, onTagEditCancel]);

    const sensitivePreview = useMemo(
        () => formatSensitivePreview(item.content, item.content_type, {
            prefixVisible: sensitiveMaskPrefixVisible,
            suffixVisible: sensitiveMaskSuffixVisible,
            maskEmailDomain: sensitiveMaskEmailDomain,
        }),
        [
            item.content,
            item.content_type,
            sensitiveMaskPrefixVisible,
            sensitiveMaskSuffixVisible,
            sensitiveMaskEmailDomain
        ]
    );
    const richTextCleanHtml = richTextFallback?.cleanHtml || item.html_content || "";
    const richTextSnapshotDisplayMaxHeight = compactMode ? 40 : 64;
    const richTextSnapshotRenderMaxHeight = compactMode ? 100 : 200;
    const spreadsheetLikeRichSource = item.content_type === "rich_text"
        && !!item.html_content
        && isSpreadsheetLikeSource(item.source_app, item.source_app_path);
    const richTextHasAnimatedImageFallback = isAnimatedGifSrc(
        richTextFallback?.imagePayload || richTextFallback?.imageSrc || null
    );
    const preferHtmlRichPreview = item.content_type === "rich_text"
        && !!item.html_content
        && !richTextHasAnimatedImageFallback
        && !richHtmlLooksTabular(richTextCleanHtml)
        && !spreadsheetLikeRichSource;
    const preferGeneratedRichPreview = item.content_type === "rich_text"
        && !!item.html_content
        && !preferHtmlRichPreview
        && (
            !!richTextSnapshotPreview
            || richHtmlLooksTabular(richTextCleanHtml)
            || spreadsheetLikeRichSource
        );
    const richTextSnapshotSrc = useMemo(() => {
        if (!preferGeneratedRichPreview) return null;
        if (item.content_type !== "rich_text" || !item.html_content) return null;
        if (!richTextCleanHtml) return null;
        return getRichTextSnapshotDataUrl(richTextCleanHtml, {
            width: compactMode ? 360 : 560,
            // Keep source snapshot height bounded so list-item preview does not over-shrink text.
            maxHeight: richTextSnapshotRenderMaxHeight
        });
    }, [
        preferGeneratedRichPreview,
        item.content_type,
        item.html_content,
        richTextCleanHtml,
        compactMode,
        richTextSnapshotRenderMaxHeight
    ]);
    const effectiveRichTextSnapshotSrc = !snapshotFailed ? richTextSnapshotSrc : null;
    const effectiveRichImageFallbackSrc = !richImageFallbackFailed
        ? (richTextFallback?.imageSrc || null)
        : null;
    const preferImageFallbackForTabular = (
        richHtmlLooksTabular(richTextCleanHtml) || spreadsheetLikeRichSource
    ) && !!effectiveRichImageFallbackSrc;
    const richTextPreviewSrc = richTextHasAnimatedImageFallback
        ? (effectiveRichImageFallbackSrc || effectiveRichTextSnapshotSrc)
        : preferImageFallbackForTabular
            ? (effectiveRichImageFallbackSrc || effectiveRichTextSnapshotSrc)
            : (effectiveRichTextSnapshotSrc || null);
    const useSnapshotPreviewImage = !!richTextPreviewSrc && richTextPreviewSrc === effectiveRichTextSnapshotSrc;
    const useRichImageFallback = !!richTextPreviewSrc && richTextPreviewSrc === effectiveRichImageFallbackSrc;
    const visibleTagCount = item.tags?.length || 0;
    const hasTagsSection = visibleTagCount > 0 || isEditingTags;
    const overlayTagsInPreview = !compactMode && !isEditingTags && visibleTagCount > 0;
    const standaloneColorValue = useMemo(
        () => getStandaloneColorValue(item.content_type, item.content),
        [item.content, item.content_type]
    );

    useEffect(() => {
        let cancelled = false;
        const sourceAppPath = item.source_app_path?.trim();
        const cachedIcon = peekSourceAppIcon(sourceAppPath);

        if (!showSourceAppIcon) {
            setSourceAppIcon(null);
            return () => {
                cancelled = true;
            };
        }

        if (cachedIcon !== undefined) {
            setSourceAppIcon(cachedIcon ?? null);
            return () => {
                cancelled = true;
            };
        }

        setSourceAppIcon(null);
        if (!sourceAppPath) {
            return () => {
                cancelled = true;
            };
        }

        getSourceAppIcon(sourceAppPath).then((icon) => {
            if (!cancelled) {
                setSourceAppIcon(icon);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [item.source_app_path, showSourceAppIcon]);

    useEffect(() => {
        let cancelled = false;
        const cachedIcon = peekFileIcon(singleFilePath);

        if (item.content_type !== "file" || item.file_preview_exists === false || !singleFilePath) {
            setFileIcon(null);
            return () => {
                cancelled = true;
            };
        }

        if (cachedIcon !== undefined) {
            setFileIcon(cachedIcon ?? null);
            return () => {
                cancelled = true;
            };
        }

        setFileIcon(null);
        getSystemFileIcon(singleFilePath).then((icon) => {
            if (!cancelled) {
                setFileIcon(icon);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [item.content_type, item.file_preview_exists, singleFilePath]);

    const compactPreviewEnabled =
        compactMode &&
        COMPACT_PREVIEW_WINDOW_SUPPORTED &&
        item.content_type !== "file";

    const isHoverPreviewRequestCurrent = (requestId: number) => {
        const node = itemRef.current;
        return (
            hoverRequestIdRef.current === requestId &&
            !!hoverAnchorRef.current &&
            !!node &&
            node.isConnected &&
            node.matches(":hover")
        );
    };

    const cancelHoverPreview = () => {
        hoverRequestIdRef.current += 1;
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        hoverAnchorRef.current = null;
    };

    const hideCompactPreview = async () => {
        cancelHoverPreview();
        await hideCompactPreviewGlobal();
    };

    // ---- 备注（note 列）-----------------------------------------------------
    const clearNoteBlurTimer = () => {
        if (noteBlurTimerRef.current) {
            clearTimeout(noteBlurTimerRef.current);
            noteBlurTimerRef.current = null;
        }
    };

    const saveNote = async (value: string) => {
        const trimmed = value.trim();
        clearNoteBlurTimer();
        setNoteSaving(true);
        try {
            await invoke("update_entry_note", { id: item.id, note: trimmed });
            setNoteLocal(trimmed);
            setNoteDraft(trimmed);
            setNoteOpen(false);
        } catch (err) {
            console.error("[Note] save failed", err);
        } finally {
            setNoteSaving(false);
        }
    };

    const openNoteEditor = () => {
        clearNoteBlurTimer();
        void hideCompactPreview();
        setNoteDraft(noteValue);
        setNoteOpen(true);
    };

    const closeNoteEditor = () => {
        clearNoteBlurTimer();
        setNoteDraft(noteValue);
        setNoteOpen(false);
    };

    const showCompactPreview = async (anchor: CompactPreviewAnchor, requestId: number) => {
        if (!compactPreviewEnabled) return;
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request before start", {
                itemId: item.id,
                requestId
            });
            return;
        }
        compactPreviewLog("show preview requested", {
            itemId: item.id,
            contentType: item.content_type,
            anchor
        });
        let previewWindow = await ensureCompactPreviewWindow();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after ensure window", {
                itemId: item.id,
                requestId
            });
            return;
        }
        if (!previewWindow) {
            compactPreviewLog("show preview aborted: window unavailable");
            return;
        }
        await ensureCompactPreviewLifecycleListeners();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after lifecycle listeners", {
                itemId: item.id,
                requestId
            });
            return;
        }
        await ensureCompactPreviewResizeListener();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after resize listener", {
                itemId: item.id,
                requestId
            });
            return;
        }
        compactPreviewLog("preview listeners ready");
        const mounted = await waitForCompactPreviewMounted();
        if (!isHoverPreviewRequestCurrent(requestId)) {
            compactPreviewLog("show preview aborted: stale hover request after mounted wait", {
                itemId: item.id,
                requestId
            });
            return;
        }
        compactPreviewLog("mounted state before emit", { mounted });
        if (!mounted) {
            compactPreviewLog("mounted wait returned false; continue with fallback timer");
        }

        try {
            const rootStyle = getComputedStyle(document.documentElement);
            const clipboardItemFontSizeRaw = parseInt(
                rootStyle.getPropertyValue("--clipboard-item-font-size")
            );
            const clipboardTagFontSizeRaw = parseInt(
                rootStyle.getPropertyValue("--clipboard-tag-font-size")
            );
            const clipboardItemFontSize = Number.isFinite(clipboardItemFontSizeRaw)
                ? clipboardItemFontSizeRaw
                : undefined;
            const clipboardTagFontSize = Number.isFinite(clipboardTagFontSizeRaw)
                ? clipboardTagFontSizeRaw
                : undefined;
            const colorMode = document.documentElement.classList.contains("dark-mode") ? "dark" : "light";

            if (!isHoverPreviewRequestCurrent(requestId)) {
                compactPreviewLog("show preview aborted: stale hover request before emit", {
                    itemId: item.id,
                    requestId
                });
                return;
            }
            compactPreviewPendingShow = true;
            compactPreviewPendingAnchor = anchor;
            compactPreviewLog("emit compact-preview-update", {
                itemId: item.id,
                contentType: item.content_type,
                hasHtml: !!item.html_content
            });
            await previewWindow.emit("compact-preview-update", {
                contentType: item.content_type,
                content: item.content,
                preview: item.preview,
                htmlContent: item.html_content,
                sourceApp: item.source_app,
                timestamp: item.timestamp,
                language,
                theme,
                colorMode,
                richTextSnapshotPreview,
                clipboardItemFontSize,
                clipboardTagFontSize
            });
            compactPreviewLog("emit compact-preview-update done");
            if (compactPreviewPendingTimer) {
                clearTimeout(compactPreviewPendingTimer);
            }
            compactPreviewPendingTimer = setTimeout(async () => {
                if (!compactPreviewPendingShow || !compactPreviewWindow || !compactPreviewPendingAnchor) {
                    compactPreviewLog("fallback timer canceled: pending state changed");
                    return;
                }
                try {
                    compactPreviewLog("fallback timer place/show with default size");
                    await placeAndShowPendingCompactPreview(320, 220, { keepPending: true });
                } catch (fallbackErr) {
                    console.error("Failed to show compact preview window (fallback):", fallbackErr);
                    compactPreviewLog("fallback place/show failed", fallbackErr);
                }
            }, 200);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("window not found")) {
                compactPreviewLog("window not found, recreate flow");
                compactPreviewWindow = null;
                compactPreviewMounted = false;
                compactPreviewMountedPromise = null;
                previewWindow = await ensureCompactPreviewWindow();
                if (!isHoverPreviewRequestCurrent(requestId)) {
                    compactPreviewLog("show preview aborted: stale hover request after recreate", {
                        itemId: item.id,
                        requestId
                    });
                    return;
                }
                if (!previewWindow) return;
                try {
                    compactPreviewPendingShow = true;
                    compactPreviewPendingAnchor = anchor;
                    compactPreviewLog("emit compact-preview-update after recreate");
                    await previewWindow.emit("compact-preview-update", {
                        contentType: item.content_type,
                        content: item.content,
                        preview: item.preview,
                        htmlContent: item.html_content,
                        sourceApp: item.source_app,
                        timestamp: item.timestamp,
                        language,
                        theme,
                        richTextSnapshotPreview,
                        colorMode: document.documentElement.classList.contains("dark-mode") ? "dark" : "light"
                    });
                    compactPreviewLog("emit compact-preview-update after recreate done");
                    if (compactPreviewPendingTimer) {
                        clearTimeout(compactPreviewPendingTimer);
                    }
                    compactPreviewPendingTimer = setTimeout(async () => {
                        if (!compactPreviewPendingShow || !compactPreviewWindow || !compactPreviewPendingAnchor) {
                            compactPreviewLog("recreate fallback canceled: pending state changed");
                            return;
                        }
                        try {
                            compactPreviewLog("recreate fallback place/show with default size");
                            await placeAndShowPendingCompactPreview(320, 220, { keepPending: true });
                        } catch (fallbackErr) {
                            console.error("Failed to show compact preview window (fallback):", fallbackErr);
                            compactPreviewLog("recreate fallback failed", fallbackErr);
                        }
                    }, 200);
                } catch (retryErr) {
                    console.error("Failed to show compact preview window:", retryErr);
                    compactPreviewLog("recreate flow failed", retryErr);
                }
                return;
            }
            console.error("Failed to show compact preview window:", err);
            compactPreviewLog("show preview failed", err);
        }
    };

    // Sync local state when prop changes (e.g. when editor opens)
    useEffect(() => {
        setLocalTagInput(tagInput);
    }, [tagInput]);

    useEffect(() => {
        setLocalAiOptionsOpen(!!aiOptionsOpen);
    }, [aiOptionsOpen]);

    useEffect(() => {
        setSnapshotFailed(false);
        setRichImageFallbackFailed(false);
    }, [item.id, item.html_content, richTextSnapshotPreview, compactMode]);

    useEffect(() => {
        if (richSnapshotFallbackTimerRef.current) {
            clearTimeout(richSnapshotFallbackTimerRef.current);
            richSnapshotFallbackTimerRef.current = null;
        }
        if (!useSnapshotPreviewImage) return;

        // Safety net: some WebView failures do not reliably fire <img onError>.
        richSnapshotFallbackTimerRef.current = setTimeout(() => {
            const img = richSnapshotImgRef.current;
            if (!img || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
                richPreviewFailureLog("snapshot image timeout -> fallback to html", {
                    itemId: item.id,
                    hasImageElement: !!img,
                    complete: img?.complete ?? false,
                    naturalWidth: img?.naturalWidth ?? 0,
                    naturalHeight: img?.naturalHeight ?? 0
                });
                setSnapshotFailed(true);
            }
        }, 700);

        return () => {
            if (richSnapshotFallbackTimerRef.current) {
                clearTimeout(richSnapshotFallbackTimerRef.current);
                richSnapshotFallbackTimerRef.current = null;
            }
        };
    }, [useSnapshotPreviewImage, effectiveRichTextSnapshotSrc, item.id]);

    const showAIOptions = localAiOptionsOpen;
    const inlineAiVariants = {
        open: { opacity: 1, height: "auto", marginTop: 8, marginBottom: 8 },
        collapsed: { opacity: 0, height: 0, marginTop: 0, marginBottom: 0 }
    };
    useEffect(() => {
        if (isEditingTags && tagInputRef.current) {
            tagInputRef.current.focus();
        }
    }, [isEditingTags]);

    useEffect(() => {
        if (!compactPreviewEnabled) {
            void hideCompactPreview();
        }
    }, [compactPreviewEnabled]);

    useEffect(() => {
        return () => {
            cancelHoverPreview();
            void hideCompactPreviewGlobal();
        };
    }, []);

    const renderFilePreview = () => {
        if (item.file_preview_exists === false) {
            return (
                <div className="file-thumbnail-card error-bg" title={t('file_deleted') || "File Deleted"}>
                    <div className="file-icon-wrapper error-icon">
                        <FileQuestion size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name error-text">{t('file_deleted') || "Deleted"}</div>
                        <div className="file-hint error-text">{item.content}</div>
                    </div>
                </div>
            );
        }

        if (filePaths.length > 1) {
            return (
                <div className="file-thumbnail-card" title={item.content}>
                    <div className="file-icon-wrapper">
                        <Files size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name">{filePaths.length} {t('items')}</div>
                        <div className="file-hint">{filePaths[0].split(/[\\/]/).pop()} ...</div>
                    </div>
                </div>
            );
        }

        const filePath = filePaths[0];
        if (!filePath) {
            return (
                <div className="file-thumbnail-card" title={item.content}>
                    <div className="file-icon-wrapper">
                        <File size={24} />
                    </div>
                    <div className="file-info-wrapper">
                        <div className="file-name">{t('file') || "File"}</div>
                        <div className="file-hint">{item.content}</div>
                    </div>
                </div>
            );
        }

        const fileName = filePath.split(/[\\/]/).pop();
        const dirPath = filePath.split(/[\\/]/).slice(0, -1).join('\\');

        return (
            <div className="file-thumbnail-card" title={item.content}>
                <div className={`file-icon-wrapper${fileIcon ? " file-icon-wrapper-system" : ""}`}>
                    {fileIcon ? (
                        <img
                            src={fileIcon}
                            alt={`${fileName || "file"} icon`}
                            className="file-icon-image"
                            loading="lazy"
                        />
                    ) : (
                        getFallbackFileIcon(filePath)
                    )}
                </div>
                <div className="file-info-wrapper">
                    <div className="file-name">{fileName}</div>
                    <div className="file-hint">{dirPath}</div>
                </div>
            </div>
        );
    };

    const renderTagsContainer = (overlay = false) => (
        <div
            className={`item-tags-container${overlay ? ' overlay' : ''}${isEditingTags ? ' tag-edit-active' : ''}`}
            style={{
                marginTop: overlay ? '0' : '2px',
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: '4px',
                paddingTop: '0'
            }}
        >
            {item.tags?.map((tag) => {
                const tagBackground = tagColors?.[tag] || getTagColor(tag, theme);
                const tagTextColor = getTagTextColor(tagBackground);
                return (
                    <span
                        key={tag}
                        className="tag-chip"
                        style={{
                            background: tagBackground,
                            color: tagTextColor,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                        }}
                    >
                        {tag}
                        {isEditingTags && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onTagDelete(tag);
                                }}
                                style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', opacity: 0.72, cursor: 'pointer', display: 'flex' }}
                            >
                                <X size={8} />
                            </button>
                        )}
                    </span>
                );
            })}

            {isEditingTags && (
                <div className="tag-edit-anchor">
                    <div className="tag-edit-input-row">
                        <input
                            ref={tagInputRef}
                            type="text"
                            value={localTagInput}
                            onCompositionStart={() => {
                                isComposing.current = true;
                            }}
                            onCompositionEnd={(e) => {
                                isComposing.current = false;
                                const val = (e.target as HTMLInputElement).value;
                                setLocalTagInput(val);
                                onTagInput(val);
                            }}
                            onMouseDown={() => {
                                invoke('activate_window_focus').catch(console.error);
                            }}
                            onFocus={() => {
                                invoke('activate_window_focus').catch(console.error);
                            }}
                            onChange={(e) => {
                                const val = e.target.value;
                                setLocalTagInput(val);
                                if (!isComposing.current) {
                                    onTagInput(val);
                                }
                            }}
                            onKeyDown={(e) => {
                                if (isComposing.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onTagEditCancel?.();
                                    return;
                                }
                                const suggestionCount = pickableTagSuggestions.length;
                                if (e.key === 'ArrowDown' && suggestionCount > 0 && onTagPick) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTagSuggestIndex((prev) =>
                                        prev < 0 ? 0 : Math.min(prev + 1, suggestionCount - 1)
                                    );
                                    return;
                                }
                                if (e.key === 'ArrowUp' && suggestionCount > 0 && onTagPick) {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setTagSuggestIndex((prev) => (prev <= 0 ? -1 : prev - 1));
                                    return;
                                }
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (
                                        onTagPick &&
                                        tagSuggestIndex >= 0 &&
                                        tagSuggestIndex < suggestionCount
                                    ) {
                                        const picked = pickableTagSuggestions[tagSuggestIndex];
                                        onTagPick(picked);
                                        setLocalTagInput('');
                                        setTagSuggestIndex(-1);
                                    } else {
                                        onTagAdd();
                                    }
                                }
                            }}
                            className="tag-input"
                            aria-autocomplete="list"
                            aria-controls={
                                pickableTagSuggestions.length > 0 && onTagPick
                                    ? `tag-suggest-list-${item.id}`
                                    : undefined
                            }
                            aria-activedescendant={
                                tagSuggestIndex >= 0 && pickableTagSuggestions.length > 0 && onTagPick
                                    ? `tag-suggest-opt-${item.id}-${tagSuggestIndex}`
                                    : undefined
                            }
                            placeholder={t('enter_tag_name')}
                            style={{
                                background: 'var(--bg-input)',
                                border: 'none',
                                borderRadius: '0',
                                padding: '2px 6px',
                                fontSize: '10px',
                                color: 'var(--text-primary)',
                                outline: 'none'
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onTagAdd();
                            }}
                            className="btn-icon"
                            style={{ padding: '2px', height: '16px', width: '16px' }}
                        >
                            <Plus size={10} />
                        </button>
                    </div>
                    {pickableTagSuggestions.length > 0 && onTagPick && (
                        <div
                            ref={tagSuggestListRef}
                            id={`tag-suggest-list-${item.id}`}
                            className="tag-edit-suggestions-popover hide-scrollbar"
                            role="listbox"
                            aria-label={t('find_tags')}
                            onMouseDown={(e) => e.stopPropagation()}
                        >
                            {pickableTagSuggestions.map((sTag, sIdx) => {
                                const bg = tagColors?.[sTag] || getTagColor(sTag, theme);
                                const fg = getTagTextColor(bg);
                                return (
                                    <button
                                        key={sTag}
                                        type="button"
                                        role="option"
                                        id={`tag-suggest-opt-${item.id}-${sIdx}`}
                                        aria-selected={tagSuggestIndex === sIdx}
                                        className={`tag-suggest-item${tagSuggestIndex === sIdx ? ' tag-suggest-item--active' : ''}`}
                                        onMouseEnter={() => setTagSuggestIndex(sIdx)}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onTagPick(sTag);
                                            setLocalTagInput('');
                                            setTagSuggestIndex(-1);
                                        }}
                                    >
                                        <span
                                            className="tag-suggest-pill"
                                            style={{
                                                background: bg,
                                                color: fg
                                            }}
                                        >
                                            {sTag}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <motion.div
            ref={itemRef}
            id={id}
            data-test-clipboard-item
            layout={!disableLayout}
            initial={false}
            animate={{ marginBottom: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className={`history-item ${isSelected ? "selected" : ""} ${compactMode ? "compact" : ""} ${item.is_pinned ? "pinned" : ""} ${dragOutEnabled ? "drag-out-ready" : ""} ${className || ''}`}
            onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (e.button !== 0) return;

                // 拖拽导出模式：单击照常粘贴，只有「按住并移动超过阈值」才把内容落成文件交给 OLE。
                if (dragOutEnabled && !isEditingTags) {
                    if (target.closest('button, input, textarea, [role="button"], .drag-handle')) return;
                    if (target.closest('a')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // 悬停预览先收起来，免得按下去到拖起来之间它挂在旁边。
                    void hideCompactPreview();

                    const startX = e.clientX;
                    const startY = e.clientY;
                    let dragStarted = false;

                    // 上一次按下的手势万一没收干净（窗口被隐藏，mouseup 丢了），先收掉再挂新的。
                    pendingDragOutCleanupRef.current?.();

                    const cleanup = () => {
                        window.removeEventListener("mousemove", handleMove, true);
                        window.removeEventListener("mouseup", handleUp, true);
                        window.removeEventListener("blur", handleLostFocus);
                        document.removeEventListener("visibilitychange", handleVisibilityChange);
                        if (pendingDragOutCleanupRef.current === cleanup) {
                            pendingDragOutCleanupRef.current = null;
                        }
                    };

                    function handleMove(ev: MouseEvent) {
                        if (dragStarted) return;
                        // 按键已经松开（mouseup 没收到，比如被别的窗口吃掉）：当作没拖，免得后续移动误触发拖拽。
                        if (ev.buttons === 0) {
                            cleanup();
                            return;
                        }
                        const dx = ev.clientX - startX;
                        const dy = ev.clientY - startY;
                        if (dx * dx + dy * dy < DRAG_OUT_THRESHOLD_PX * DRAG_OUT_THRESHOLD_PX) return;
                        dragStarted = true;
                        cleanup();
                        onStartDragOut?.(item);
                    }

                    function handleUp() {
                        cleanup();
                        // 已经进入 OLE 拖拽循环，mouseup 会被它吃掉，这里不会再做事。
                        if (dragStarted) return;
                        onCopy(false); // 纯文本，和普通点击一致
                        onSelect();
                    }

                    // 窗口在这一刻被收起/失焦（失焦即隐藏、全局热键、托盘菜单）：手势作废，
                    // 既不能等 mouseup（不会来了），也不能留着监听器。
                    function handleLostFocus() {
                        cleanup();
                    }

                    function handleVisibilityChange() {
                        if (document.visibilityState === "hidden") cleanup();
                    }

                    pendingDragOutCleanupRef.current = cleanup;
                    window.addEventListener("mousemove", handleMove, true);
                    window.addEventListener("mouseup", handleUp, true);
                    window.addEventListener("blur", handleLostFocus);
                    document.addEventListener("visibilitychange", handleVisibilityChange);
                    return;
                }

                if (isEditingTags) {
                    if (target.closest(".tag-edit-anchor")) return;
                    if (target.closest(".item-tags-container .tag-chip")) return;
                    if (target.closest('button, input, textarea, [role="button"], .drag-handle')) {
                        return;
                    }
                    if (target.closest('a')) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onTagEditCancel?.();
                    return;
                }

                if (target.closest('button, input, textarea, [role="button"], .drag-handle')) {
                    return;
                }
                if (target.closest('a')) {
                    return;
                }
                // e.preventDefault() stops macOS from transferring key-window focus to TieZ
                // when the user clicks on a clipboard item, including pinned mode.
                // Without this, the first click activates TieZ and the original input
                // target loses focus before we dispatch the paste keystroke.
                e.preventDefault();
                void hideCompactPreview();
                onCopy(false); // Plain text by default
                onSelect();
            }}
            onClick={(e) => {
                if (isEditingTags) return;
                const target = e.target as HTMLElement;
                if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
                    return;
                }
                // Prevent link navigation - we want to copy, not open links
                if (target.closest('a')) {
                    e.preventDefault();
                }
                // Copy is handled on mousedown so the source app keeps focus.
            }}
            onContextMenu={(e) => {
                const target = e.target as HTMLElement;
                if (isEditingTags) {
                    if (target.closest(".tag-edit-anchor")) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onTagEditCancel?.();
                    return;
                }
                if (target.closest('button') || target.closest('input') || target.closest('textarea')) {
                    return;
                }
                void hideCompactPreview();
                e.preventDefault();
                // Prevent link navigation on right-click too
                if (target.closest('a')) {
                    e.stopPropagation();
                }
                onCopy(true); // Formatted text for right-click

                onSelect();
            }}
            onMouseEnter={(e) => {
                if (!compactPreviewEnabled) return;
                // Don't show preview if AI options are open to avoid interference
                if (showAIOptions) return;
                compactPreviewLog("mouseenter schedule preview", { itemId: item.id });
                const requestId = hoverRequestIdRef.current + 1;
                hoverRequestIdRef.current = requestId;
                hoverAnchorRef.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY
                };
                const target = e.currentTarget;

                // Clear any pending hide timer
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);

                // Set a delay to show
                hoverTimerRef.current = setTimeout(() => {
                    hoverTimerRef.current = null;
                    // Double-check AI options are still closed before showing
                    if (showAIOptions) return;
                    if (!target.isConnected) return;
                    if (!isHoverPreviewRequestCurrent(requestId)) return;
                    const anchor = hoverAnchorRef.current;
                    if (!anchor) return;
                    compactPreviewLog("mouseenter timer fired, show preview", { itemId: item.id });
                    void showCompactPreview(anchor, requestId);
                }, 1000); // 1s delay
            }}
            onMouseMove={(e) => {
                if (!compactPreviewEnabled) return;
                hoverAnchorRef.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    screenX: e.screenX,
                    screenY: e.screenY
                };
            }}
            onMouseLeave={() => {
                compactPreviewLog("mouseleave hide preview", { itemId: item.id });
                void hideCompactPreview();
            }}
        >
            <div className="item-meta">
                <div className="item-meta-left">
                    {dragControls && (
                        <div
                            className="drag-handle"
                            onPointerDown={(e) => dragControls.start(e)}
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                cursor: 'grab',
                                opacity: 0.5,
                                display: 'flex',
                                alignItems: 'center',
                                touchAction: 'none'
                            }}
                        >
                            <GripVertical size={14} />
                        </div>
                    )}
                    <div className="app-info">
                        {item.is_pinned && !dragControls && <Pin size={10} style={{ color: 'var(--accent-color)', marginRight: '-2px' }} />}
                        {showSourceAppIcon
                            ? renderSourceAppIcon(sourceAppIcon, item.content_type, item.source_app)
                            : getIcon(item.content_type)}
                        <span>{item.source_app}</span>
                    </div>
                </div>

                <div className="item-meta-right">
                    <div className="item-actions">
                        {(item.tags?.includes('sensitive') || item.tags?.includes('密码') || item.tags?.includes('password')) && (
                            <button
                                className={`btn-icon ${isRevealed ? "active" : ""}`}
                                onClick={onToggleReveal}
                                title={isRevealed ? t('hide') : t('reveal')}
                            >
                                {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                            </button>
                        )}
                        <button
                            className="btn-icon"
                            onClick={onOpen}
                            title={t('open')}
                        >
                            <ExternalLink size={12} />
                        </button>
                        <button
                            className={`btn-icon ${item.is_pinned ? "active" : ""}`}
                            onClick={onTogglePin}
                            title={item.is_pinned ? t('unpin') : t('pin')}
                        >
                            {item.is_pinned ? <PinOff size={12} /> : <Pin size={12} />}
                        </button>
                        <button
                            className={`btn-icon ${item.tags && item.tags.length > 0 ? "active" : ""}`}
                            onClick={onToggleTagEditor}
                            title="Tags"
                        >
                            <Tag size={12} />
                        </button>
                        <button
                            className={`btn-icon ${noteValue ? "active" : ""}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (noteOpen) closeNoteEditor();
                                else openNoteEditor();
                            }}
                            title={t('note')}
                        >
                            <StickyNote size={12} />
                        </button>
                        {(item.content_type === 'text' || item.content_type === 'rich_text') && aiEnabled && (
                            <button
                                className={`btn-icon ai-btn ${isAIProcessing || showAIOptions ? 'active' : ''}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!isAIProcessing) {
                                        // Close preview window when opening AI options
                                        if (!showAIOptions) {
                                            hideCompactPreview();
                                        }
                                        setLocalAiOptionsOpen(prev => !prev);
                                        onAIOptionsToggle?.();
                                    }
                                }}
                                title={t('ai_assistant')}
                            >
                                {isAIProcessing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                            </button>
                        )}
                        <button className="btn-icon" onClick={onDelete} title={t('delete')}>
                            <X size={12} />
                        </button>
                    </div>
                    <div className="item-meta-right-info">
                        {quickPasteHint && (
                            <span
                                className="quick-paste-hint"
                                title={`${t('quick_paste_modifier')}: ${quickPasteHint.combo}`}
                            >
                                {quickPasteHint.combo}
                            </span>
                        )}
                        <span>{getConciseTime(item.timestamp, language)}</span>
                    </div>
                </div>
            </div>

            {
                compactMode && item.is_pinned && (
                    <div className="compact-pinned-indicator" title={t('pinned')}>
                        <Pin size={10} fill="currentColor" />
                    </div>
                )
            }
            <div className={`content-preview-shell${overlayTagsInPreview ? ' has-overlay-tags' : ''}`}>
                <div className={`content-preview ${item.content_type === 'rich_text' ? 'rich-text' : ''} ${item.content_type === 'file' ? 'file-preview' : ''} ${isSensitiveHidden ? 'sensitive-blur' : ''}`}>
                {item.content_type === "image" ? (
                    <div style={{ position: 'relative' }}>
                        {item.is_external && item.file_preview_exists === false ? (
                            <div className="image-preview error-placeholder" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-secondary)', color: 'var(--text-secondary)', height: '100px', fontSize: '12px' }}>
                                <ImageOff size={24} style={{ marginBottom: '8px', opacity: 0.5 }} />
                                <span>{t('image_deleted') || 'Image Deleted'}</span>
                            </div>
                        ) : (
                            <img
                                src={
                                    item.content.startsWith("data:")
                                        ? item.content
                                        : (
                                            toTauriLocalImageSrc(item.content) ||
                                            (item.is_external ? convertFileSrc(item.content) : item.content)
                                        )
                                }
                                alt={t('image_preview')}
                                className="image-preview"
                                loading="lazy"
                                style={isSensitiveHidden ? { filter: 'blur(8px)' } : {}}
                                onError={(e) => {
                                    // Fallback for load errors even if backend said it exists (e.g. deleted after fetch)
                                    e.currentTarget.style.display = 'none';
                                    e.currentTarget.parentElement?.classList.add('image-load-error');
                                }}
                            />
                        )}
                        {isSensitiveHidden && (
                            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontWeight: 'bold', opacity: 0.5, fontSize: '10px' }}>
                                SENSITIVE
                            </div>
                        )}
                    </div>
                ) : item.content_type === "video" ? (
                    <div className="video-thumbnail-card">
                        <div className="video-thumbnail-wrapper">
                            <video
                                src={item.content.startsWith("data:")
                                    ? item.content
                                    : (toTauriLocalImageSrc(item.content) || item.content)}
                                preload="metadata"
                                muted
                                playsInline
                                className="video-thumbnail-element"
                                onLoadedMetadata={(e) => seekVideoPreviewFrame(e.currentTarget)}
                            />
                            <div className="video-play-overlay">
                                <Video size={16} />
                            </div>
                        </div>
                        <div className="video-info-wrapper">
                            <div className="video-name">{item.content.split(/[\\/]/).pop()}</div>
                        </div>
                    </div>
                ) : item.content_type === "file" ? (
                    renderFilePreview()
                ) : isAIProcessing ? (
                    <div className="ai-skeleton-wrapper">
                        <div className="ai-skeleton-line" style={{ width: '90%' }}></div>
                        <div className="ai-skeleton-line" style={{ width: '75%' }}></div>
                        <div className="ai-skeleton-line" style={{ width: '85%' }}></div>
                    </div>
                ) : item.isInputting ? (
                    <div className="ai-input-wrapper">
                        <input
                            autoFocus
                            className="search-input"
                            onMouseDown={() => invoke('activate_window_focus').catch(console.error)}
                            onFocus={() => invoke('activate_window_focus').catch(console.error)}
                            style={{ width: '100%', fontSize: '12px', padding: '8px', border: '1px solid var(--accent-color)' }}
                            placeholder={item.content}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const val = e.currentTarget.value.trim();
                                    if (onInputSubmit) {
                                        onInputSubmit(val);
                                    }
                                }
                            }}
                            onClick={(e) => e.stopPropagation()}
                        />
                        <div style={{ fontSize: '10px', opacity: 0.6, marginTop: '4px' }}>
                            {language === 'zh' ? '输入补充信息后按回车提交' : 'Press Enter to submit supplementary info'}
                        </div>
                    </div>
                ) : item.content_type === "rich_text" && item.html_content && !isSensitiveHidden ? (
                    richTextPreviewSrc ? (
                        <img
                            ref={richSnapshotImgRef}
                            src={richTextPreviewSrc}
                            alt="rich text preview"
                            onLoad={() => {
                                if (useSnapshotPreviewImage && richSnapshotFallbackTimerRef.current) {
                                    clearTimeout(richSnapshotFallbackTimerRef.current);
                                    richSnapshotFallbackTimerRef.current = null;
                                }
                            }}
                            onError={() => {
                                if (useRichImageFallback) {
                                    richPreviewFailureLog("fallback image load error -> switch to snapshot", {
                                        itemId: item.id,
                                        srcLength: (richTextPreviewSrc || "").length,
                                        srcSample: (richTextPreviewSrc || "").slice(0, 140)
                                    });
                                    setRichImageFallbackFailed(true);
                                    return;
                                }
                                if (richSnapshotFallbackTimerRef.current) {
                                    clearTimeout(richSnapshotFallbackTimerRef.current);
                                    richSnapshotFallbackTimerRef.current = null;
                                }
                                if (effectiveRichTextSnapshotSrc) {
                                    richPreviewFailureLog("snapshot image load error -> fallback to html", {
                                        itemId: item.id,
                                        srcLength: (richTextPreviewSrc || "").length,
                                        srcSample: (richTextPreviewSrc || "").slice(0, 140)
                                    });
                                    setSnapshotFailed(true);
                                }
                            }}
                            style={{
                                width: 'auto',
                                maxWidth: '100%',
                                maxHeight: `${richTextSnapshotDisplayMaxHeight}px`,
                                display: 'block',
                                marginRight: 'auto',
                                pointerEvents: 'none',
                                borderRadius: '4px',
                                maskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)',
                                WebkitMaskImage: 'linear-gradient(to bottom, black 78%, transparent 100%)'
                            }}
                        />
                    ) : (
                        <HtmlContent
                            className="rich-text-preview"
                            htmlContent={richTextCleanHtml || item.html_content}
                            fallbackText={item.preview}
                            preview={true}
                            style={{
                                maxHeight: `${richTextSnapshotDisplayMaxHeight}px`,
                                overflow: 'hidden',
                                fontSize: 'var(--clipboard-item-font-size)',
                                lineHeight: '1.4',
                                position: 'relative',
                                pointerEvents: 'none', // Prevent interacting with links in the list
                                maskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)',
                                WebkitMaskImage: 'linear-gradient(to bottom, black 70%, transparent 100%)'
                            }}
                        />
                    )
                ) : standaloneColorValue && !isSensitiveHidden ? (
                    <div className="color-code-preview">
                        <span
                            className="color-code-swatch"
                            style={{ background: standaloneColorValue }}
                            aria-hidden="true"
                        />
                        <span className="color-code-value">{standaloneColorValue}</span>
                    </div>
                ) : (
                    isSensitiveHidden
                        ? (
                            <div style={{ minHeight: '24px', opacity: 0.6, fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '8px', fontFamily: 'var(--font-mono)' }}>
                                <span style={{ letterSpacing: '1px' }}>
                                    {sensitivePreview}
                                </span>
                                <span style={{ fontSize: '10px', opacity: 0.7 }}>
                                    ({item.content.length} {t('chars') || 'chars'})
                                </span>
                            </div>
                        )
                        : item.preview
                )}
                {overlayTagsInPreview && renderTagsContainer(true)}
                </div>
            </div>

            {/* 备注：收起时是内容下方的一行小字，点开是带下划线的编辑区。
                两者都不让它冒泡到条目上——点备注不能顺手触发「复制并粘贴」。 */}
            <AnimatePresence initial={false}>
                {!noteOpen && noteValue && (
                    <motion.div
                        key="note-view"
                        className="item-note"
                        initial={{ opacity: 0, y: -3 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -3 }}
                        transition={{ duration: 0.16, ease: 'easeOut' }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            openNoteEditor();
                        }}
                        onContextMenu={(e) => e.stopPropagation()}
                        title={noteValue}
                    >
                        <StickyNote size={11} className="item-note-icon" />
                        <span className="item-note-text">{noteValue}</span>
                    </motion.div>
                )}

                {noteOpen && (
                    <motion.div
                        key="note-editor"
                        ref={noteEditorRef}
                        className="item-note-editor"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ height: { duration: 0.2, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.14 } }}
                        style={{ overflow: 'hidden' }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        onContextMenu={(e) => e.stopPropagation()}
                    >
                        <textarea
                            className="item-note-input"
                            rows={3}
                            autoFocus
                            value={noteDraft}
                            placeholder={t('note_placeholder')}
                            onChange={(e) => setNoteDraft(e.target.value)}
                            onFocus={() => {
                                invoke('activate_window_focus').catch(() => { });
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    closeNoteEditor();
                                    return;
                                }
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    void saveNote(noteDraft);
                                }
                            }}
                            onBlur={() => {
                                // 点「保存 / 取消」也会先触发 blur，所以晚一拍再判断焦点：
                                // 焦点还在编辑器里就什么都不做，真离开了就静默保存（没改动则收起）。
                                clearNoteBlurTimer();
                                noteBlurTimerRef.current = setTimeout(() => {
                                    noteBlurTimerRef.current = null;
                                    if (!noteEditorRef.current) return; // 已经关闭
                                    const active = document.activeElement;
                                    if (active && noteEditorRef.current.contains(active)) return;
                                    const trimmed = noteDraft.trim();
                                    if (trimmed !== noteValue) void saveNote(trimmed);
                                    else setNoteOpen(false);
                                }, 140);
                            }}
                        />
                        <div className="item-note-footer">
                            <span className="item-note-hint">{t('note_hint')}</span>
                            <div className="item-note-actions">
                                <button
                                    className="note-btn"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        closeNoteEditor();
                                    }}
                                >
                                    {t('note_cancel')}
                                </button>
                                <button
                                    className="note-btn primary"
                                    disabled={noteSaving}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void saveNote(noteDraft);
                                    }}
                                >
                                    {noteSaving ? <Loader2 size={11} className="animate-spin" /> : t('note_save')}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* AI Options - Compact Mode: Dropdown Panel, Normal Mode: Inline */}
            <AnimatePresence>
                {showAIOptions && (
                    <motion.div
                        className={compactMode ? "ai-options-dropdown" : ""}
                        initial={compactMode ? { opacity: 0, y: -10 } : "collapsed"}
                        animate={compactMode ? { opacity: 1, y: 0 } : "open"}
                        exit={compactMode ? { opacity: 0, y: -10 } : "collapsed"}
                        variants={compactMode ? undefined : inlineAiVariants}
                        transition={compactMode ? { duration: 0.16 } : { duration: 0.18 }}
                        style={compactMode ? {
                            position: 'absolute',
                            top: '100%',
                            right: '4px',
                            zIndex: 100000,
                            marginTop: '4px',
                            background: 'var(--bg-element)',
                            border: '2px solid var(--border-dark)',
                            borderRadius: '4px',
                            boxShadow: '4px 4px 0 0 var(--shadow-color)',
                            padding: '6px',
                            minWidth: '140px',
                            maxHeight: '200px',
                            overflowY: 'auto'
                        } : { overflow: 'hidden' }}
                    >
                        <div style={compactMode ? {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px'
                        } : {
                            padding: '8px 10px',
                            background: 'rgba(72, 123, 219, 0.05)',
                            border: '1.5px dashed var(--accent-color)',
                            borderRadius: '4px',
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '6px',
                            alignItems: 'center'
                        }}>
                            {['task', 'mouthpiece', 'translate'].map(actionType => (
                                <button
                                    key={actionType}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onAIAction?.(actionType);
                                        onAIOptionsToggle?.();
                                    }}
                                    className="btn-icon"
                                    style={compactMode ? {
                                        width: '100%',
                                        fontSize: '11px',
                                        height: '32px',
                                        boxShadow: '2px 2px 0 0 var(--shadow-color)',
                                        textTransform: 'none',
                                        justifyContent: 'flex-start',
                                        paddingLeft: '10px'
                                    } : {
                                        flex: 1,
                                        minWidth: '90px',
                                        fontSize: '11px',
                                        height: '32px',
                                        padding: '0 12px',
                                        boxShadow: '2px 2px 0 0 var(--shadow-color)',
                                        textTransform: 'none',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    {t(`ai_${actionType}`)}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {!overlayTagsInPreview && hasTagsSection && renderTagsContainer()}
        </motion.div >
    );
};

export default memo(ClipboardItem, (prevProps, nextProps) => {
    return prevProps.isSelected === nextProps.isSelected &&
        prevProps.item.id === nextProps.item.id &&
        prevProps.item.content_type === nextProps.item.content_type &&
        prevProps.item.timestamp === nextProps.item.timestamp &&
        prevProps.item.content === nextProps.item.content &&
        prevProps.item.preview === nextProps.item.preview &&
        prevProps.item.html_content === nextProps.item.html_content &&
        prevProps.item.source_app === nextProps.item.source_app &&
        prevProps.item.source_app_path === nextProps.item.source_app_path &&
        prevProps.item.is_pinned === nextProps.item.is_pinned &&
        prevProps.item.is_external === nextProps.item.is_external &&
        prevProps.item.file_preview_exists === nextProps.item.file_preview_exists &&
        prevProps.item.tags === nextProps.item.tags &&
        prevProps.item.note === nextProps.item.note &&
        prevProps.isSensitiveHidden === nextProps.isSensitiveHidden &&
        prevProps.tagColors === nextProps.tagColors &&
        prevProps.sensitiveMaskPrefixVisible === nextProps.sensitiveMaskPrefixVisible &&
        prevProps.sensitiveMaskSuffixVisible === nextProps.sensitiveMaskSuffixVisible &&
        prevProps.sensitiveMaskEmailDomain === nextProps.sensitiveMaskEmailDomain &&
        prevProps.isRevealed === nextProps.isRevealed &&
        prevProps.isEditingTags === nextProps.isEditingTags &&
        prevProps.isAIProcessing === nextProps.isAIProcessing &&
        prevProps.aiOptionsOpen === nextProps.aiOptionsOpen &&
        prevProps.aiEnabled === nextProps.aiEnabled &&
        prevProps.richTextSnapshotPreview === nextProps.richTextSnapshotPreview &&
        prevProps.showSourceAppIcon === nextProps.showSourceAppIcon &&
        prevProps.quickPasteHint?.slot === nextProps.quickPasteHint?.slot &&
        prevProps.quickPasteHint?.combo === nextProps.quickPasteHint?.combo &&
        prevProps.compactMode === nextProps.compactMode &&
        prevProps.dragOutEnabled === nextProps.dragOutEnabled &&
        prevProps.theme === nextProps.theme &&
        prevProps.language === nextProps.language &&
        prevProps.tagInput === nextProps.tagInput &&
        (prevProps.tagSuggestions ?? []).join('\u0000') === (nextProps.tagSuggestions ?? []).join('\u0000');
});
