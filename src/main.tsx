import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import AppErrorBoundary from "./shared/components/AppErrorBoundary";
import { isTauriRuntime } from "./shared/lib/tauriRuntime";
import CompactPreviewWindow from "./features/clipboard/components/CompactPreviewWindow";
import AdvancedSettingsWindow from "./features/settings/components/AdvancedSettingsWindow";
import "./index.css";
import "./styles/components/index.css";
import "./styles/themes/load";

const params = new URLSearchParams(window.location.search);
const isCompactPreview = params.get("window") === "compact-preview";
const isAdvancedSettingsWindow = params.get("window") === "advanced-settings";

// Signal after React commits real content (including the recovery screen).
// Hidden native windows may pause animation frames, so do not wait for a RAF.
const WindowReady = ({ children }: { children: React.ReactNode }) => {
  React.useEffect(() => {
    if (isCompactPreview || isAdvancedSettingsWindow || !isTauriRuntime()) return;
    let disposed = false;
    let timer: number;
    const notifyReady = (attempt: number) => {
      if (disposed) return;
      void invoke("main_window_ready").catch(() => {
        if (disposed) return;
        if (attempt < 3) {
          timer = window.setTimeout(() => notifyReady(attempt + 1), 250);
        } else {
          console.warn("[UI] Could not notify the main window that rendering is ready.");
        }
      });
    };
    // Defer one task so StrictMode's discarded effect cannot send or schedule retries.
    timer = window.setTimeout(() => notifyReady(1), 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);
  return children;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <WindowReady>
      <AppErrorBoundary>
        {isCompactPreview
          ? <CompactPreviewWindow />
          : isAdvancedSettingsWindow
            ? <AdvancedSettingsWindow />
            : <App />}
      </AppErrorBoundary>
    </WindowReady>
  </React.StrictMode>,
);
