/**
 * RootErrorBoundary — top-level React error boundary.
 *
 * Without one, any thrown error in a render path (a bad marked.parse,
 * a malformed bubble, a KaTeX overflow) crashes the entire SPA and
 * leaves a blank white page until the user hard-refreshes. With this
 * boundary the user sees the error inline + a Reload button.
 *
 * 2026-06-25 audit N2 — added because the SPA had zero error boundary
 * coverage and Hermes-style rich content (math + markdown + tool
 * results from arbitrary models) is exactly the surface that
 * occasionally throws on edge inputs.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class RootErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to the dev console so the user can copy-paste a stack into
    // a bug report. Production builds will still see this; we don't
    // ship to telemetry.
    // eslint-disable-next-line no-console
    console.error("[mathran] root error boundary caught:", error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <div className="mx-auto max-w-2xl rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-red-700">
            mathran SPA crashed
          </h1>
          <p className="mb-4 text-sm text-slate-600">
            A React render threw. The page is in an unrecoverable state.
            Reload to try again — your conversations on disk are unaffected.
          </p>
          <pre className="mb-4 max-h-64 overflow-auto rounded bg-slate-100 p-3 text-xs text-slate-800">
            {error.stack ?? error.message ?? String(error)}
          </pre>
          <button
            type="button"
            onClick={() => {
              this.setState({ error: null });
              window.location.reload();
            }}
            className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}
