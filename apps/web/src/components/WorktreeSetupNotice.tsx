import { useId } from "react";

export const WORKTREE_SETUP_DOCS_URL =
  "https://github.com/picoduck/wollipog/blob/main/docs/worktree-setup.md";

export function WorktreeSetupNotice({
  compact = false,
  busy = false,
  error,
  generateRefusal = null,
  onGenerate,
  onDismiss,
}: {
  compact?: boolean;
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
    <aside className={`worktree-setup-notice${compact ? " compact" : ""}`} aria-label="Set up This Project">
      <div className="worktree-setup-notice-copy">
        <strong>Set up This Project</strong>
        <span>Generate a reviewable starter file from repository signals. Nothing runs, stages, or commits.</span>
        {generateRefusal !== null && <span id={refusalId}>{generateRefusal}</span>}
        {error && <span className="worktree-setup-notice-error" role="alert">{error}</span>}
      </div>
      <div className="worktree-setup-notice-actions">
        <button type="button" className="btn primary sm" onClick={onGenerate} disabled={busy || generateRefusal !== null}
          title={generateRefusal ?? undefined} aria-describedby={generateRefusal !== null ? refusalId : undefined}>
          {busy ? "Generating…" : "Generate"}
        </button>
        <a className="btn ghost sm" href={WORKTREE_SETUP_DOCS_URL} target="_blank" rel="noreferrer">Learn More</a>
        <button type="button" className="icon-btn sm" onClick={onDismiss} disabled={busy}
          aria-label="Dismiss Setup Notice" title="Dismiss Setup Notice">×</button>
      </div>
    </aside>
  );
}
