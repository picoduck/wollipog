import { useEffect, type RefObject } from "react";
import { PageHeader } from "./PageHeader.js";
import { State } from "./State.js";

export function LazyRouteLoading({ title, pending }: { title: string; pending: RefObject<boolean> }) {
  return <div className="page" data-route-loading onFocusCapture={(event) => {
    if (event.target.id === "page-title") pending.current = true;
  }} onBlurCapture={() => { pending.current = false; }}>
    <PageHeader title={title} />
    <State variant="loading">Loading…</State>
  </div>;
}

/** Runs when resolved Suspense content commits, after its loading heading is removed. */
export function LazyRouteFocusRecovery({ path, pending }: { path: string; pending: RefObject<boolean> }) {
  useEffect(() => {
    if (!pending.current) return;
    pending.current = false;
    // A live control may have taken focus while loading. Keep that user's destination.
    if (document.activeElement === document.body) document.getElementById("page-title")?.focus();
  }, [path, pending]);
  return null;
}
