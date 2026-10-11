import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { CopyButton } from "./common.js";
import { ErrorIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { PageHeader } from "./PageHeader.js";
import { State } from "./State.js";

/** How many component-stack frames the details and the copied report carry. */
const COMPONENT_FRAME_COUNT = 3;

/**
 * The text Show Details reveals and Copy Error Details copies: the error message, then the first
 * frames of the component stack. It stays in the person's own browser; nothing is sent anywhere.
 */
export function errorDetailsText(error: unknown, componentStack: string | null | undefined): string {
  const frames = (componentStack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, COMPONENT_FRAME_COUNT);
  return [String(error), ...frames].join("\n");
}

type ErrorBoundaryProps = {
  children: ReactNode;
  /** Navigating elsewhere clears the error: a crash in session A must not stay on session B. */
  resetKey?: string | number;
} & (
  | {
    /** The shell itself: a crash here takes the whole window, header and rail included. */
    scope: "app";
  }
  | {
    scope?: "view";
    /** The destination as a person names it, the subject of the title "{name} Couldn't Be Shown":
     * "Automations", or "This Session" inside a session. */
    name: string;
    /** A more specific sentence than the default body, for a view that knows what failed. */
    body?: string;
    /** The route's page header, redrawn above the notice because the crashed route drew its own. */
    pageTitle?: string;
    /** Keep a failed dialog in its dismissible surface while retaining the standard notice. */
    wrapError?: (notice: ReactNode) => ReactNode;
  }
);

/**
 * Catch render/lifecycle exceptions so one bad component (e.g. a malformed transcript
 * payload crashing a timeline row) degrades to an explanation instead of white-screening the
 * whole dashboard. `resetKey` remounts the subtree when the user navigates elsewhere.
 *
 * Routes draw their own page header (#1801), so a crashed route loses its title with it. With
 * `pageTitle` the notice sits under that title again, and `#page-title` still exists for the shell's
 * focus rescue.
 *
 * The recovery is Reload, not a retry: re-rendering the same data crashes the same way, while a
 * reload fetches everything again (docs/design-system.md §12.4).
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  // `failed` rather than a null check on `error`: `throw undefined` is still a crash.
  { failed: boolean; error: unknown; componentStack: string | null }
> {
  state = { failed: false, error: undefined as unknown, componentStack: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error, componentStack: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const where = this.props.scope === "app" ? "the app shell" : this.props.name;
    console.error(`[wollipog] render error in ${where}:`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, error: undefined, componentStack: null });
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const details = errorDetailsText(this.state.error, this.state.componentStack);
    const well = <div className="code-well"><pre>{details}</pre></div>;
    const copy = (className: string) =>
      <CopyButton text={details} label="Copy Error Details" ariaLabel="Copy Error Details" className={className} />;

    if (this.props.scope === "app") {
      return (
        <div className="app-crash" role="alert">
          <State
            icon={<ErrorIcon />}
            headingLevel={1}
            title="Wollipog Couldn't Show This Screen"
            actions={
              <>
                <button type="button" className="btn primary" onClick={() => window.location.reload()}>
                  Reload Wollipog
                </button>
                {copy("btn")}
              </>
            }
            details={well}
          >
            This screen failed to display. Nothing was changed.
          </State>
        </div>
      );
    }

    const notice = (
      <Notice
        tone="danger"
        role="alert"
        className="view-error"
        title={`${this.props.name} Couldn't Be Shown`}
        actions={
          <>
            <button type="button" className="btn sm primary" onClick={() => window.location.reload()}>
              Reload Page
            </button>
            {copy("btn sm")}
          </>
        }
        details={well}
      >
        {this.props.body ?? "Part of this page failed to display. Nothing was changed."}
      </Notice>
    );
    if (this.props.wrapError) return this.props.wrapError(notice);
    if (this.props.pageTitle === undefined) return notice;
    return (
      <div className="page">
        <PageHeader title={this.props.pageTitle} />
        {notice}
      </div>
    );
  }
}
