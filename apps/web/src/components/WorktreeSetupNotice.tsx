export const WORKTREE_SETUP_DOCS_URL =
  "https://github.com/picoduck/wollipog/blob/main/docs/worktree-setup.md";

export function WorktreeSetupNotice({
  compact = false,
  busy = false,
  error,
  onGenerate,
  onDismiss,
}: {
  compact?: boolean;
  busy?: boolean;
  error?: string | null;
  onGenerate: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className={`worktree-setup-notice${compact ? " compact" : ""}`} aria-label="Set up This Project">
      <div className="worktree-setup-notice-copy">
        <strong>Set up This Project</strong>
        <span>Generate a reviewable starter file from repository signals. Nothing runs, stages, or commits.</span>
        {error && <span className="worktree-setup-notice-error" role="alert">{error}</span>}
      </div>
      <div className="worktree-setup-notice-actions">
        <button type="button" className="btn primary sm" onClick={onGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate"}
        </button>
        <a className="btn ghost sm" href={WORKTREE_SETUP_DOCS_URL} target="_blank" rel="noreferrer">Learn More</a>
        <button type="button" className="icon-btn sm" onClick={onDismiss} disabled={busy}
          aria-label="Dismiss Setup Notice" title="Dismiss Setup Notice">×</button>
      </div>
    </aside>
  );
}
