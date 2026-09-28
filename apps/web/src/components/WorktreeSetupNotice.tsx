import React, { useId } from "react";
import { Notice } from "./Notice.js";

export const WORKTREE_SETUP_DOCS_URL =
  "https://github.com/picoduck/wollipog/blob/main/docs/worktree-setup.md";

export function WorktreeSetupNotice({
  busy = false,
  error,
  generateRefusal = null,
  onGenerate,
  onDismiss,
}: {
  busy?: boolean;
  error?: string | null;
  /** Why the signed-in person may not generate the setup file (#1864). Dismissing stays available:
   * it hides the notice for that person only. */
  generateRefusal?: string | null;
  onGenerate: () => void;
  onDismiss: () => void;
}) {
  const refusalId = `worktree-setup-refusal-${useId().replace(/:/gu, "")}`;
  return (
    <Notice as="aside" tone="neutral" ariaLabel="Set Up This Project" title="Set Up This Project"
      dismissLabel="Dismiss Setup Notice" dismissDisabled={busy} onDismiss={onDismiss}
      actions={(
        <>
          <button type="button" className="btn primary sm" onClick={onGenerate} disabled={busy || generateRefusal !== null}
            title={generateRefusal ?? undefined} aria-describedby={generateRefusal !== null ? refusalId : undefined}>
            {busy ? "Generating…" : "Generate"}
          </button>
          <a className="btn ghost sm" href={WORKTREE_SETUP_DOCS_URL} target="_blank" rel="noreferrer">Learn More</a>
        </>
      )}>
      <p>Generate a reviewable starter file from repository signals. Nothing runs, stages, or commits.</p>
      {generateRefusal !== null && <p className="notice-meta" id={refusalId}>{generateRefusal}</p>}
      {error && <p className="notice-error" role="alert">{error}</p>}
    </Notice>
  );
}
