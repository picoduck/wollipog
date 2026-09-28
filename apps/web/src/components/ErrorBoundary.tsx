import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { PageHeader } from "./PageHeader.js";

/**
 * Catch render/lifecycle exceptions so one bad component (e.g. a malformed transcript
 * payload crashing a timeline row) degrades to an inline error card instead of
 * white-screening the whole dashboard. `resetKey` remounts the subtree when the user
 * navigates elsewhere — a crash in session A must not leave session B showing A's error.
 *
 * Routes draw their own page header (#1801), so a crashed route loses its title with it. With
 * `pageTitle` the card sits under that title again, and `#page-title` still exists for the shell's
 * focus rescue.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string; resetKey?: string | number; pageTitle?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[wollipog] render error in ${this.props.label}:`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string | number }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      const card = (
        <div className="error-boundary" role="alert">
          <div className="error-boundary-title">Something broke rendering the {this.props.label}.</div>
          <div className="error-boundary-message">{String(this.state.error)}</div>
          <button className="btn sm" onClick={() => this.setState({ error: null })}>
            Try Again
          </button>
        </div>
      );
      if (this.props.pageTitle === undefined) return card;
      return (
        <div className="page">
          <PageHeader title={this.props.pageTitle} />
          {card}
        </div>
      );
    }
    return this.props.children;
  }
}
