import { Component, type ReactNode } from "react";
import "../../styles/components/app-recovery.css";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

// Error messages and stacks can contain clipboard text, file paths or credentials.
// Keep only a small, fixed diagnostic classification in local storage.
const errorKind = (error: unknown): string => {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof ReferenceError) return "ReferenceError";
  if (error instanceof SyntaxError) return "SyntaxError";
  return "Error";
};

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    const kind = errorKind(error);
    console.error(`[UI] Rendering failed (${kind}); waiting for manual reload.`);
    try {
      localStorage.setItem("tiez_last_render_error", JSON.stringify({
        version: 1,
        kind,
        time: new Date().toISOString()
      }));
    } catch {
      // A full or unavailable browser store must not break the recovery screen.
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="app-recovery" role="alert">
        <h1>界面加载出了问题</h1>
        <p>可以重新加载界面，已保存的剪贴板记录和设置不会被清除。</p>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载界面
        </button>
      </main>
    );
  }
}
