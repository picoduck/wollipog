import { useEffect, useMemo, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { Select } from "./ui/ChoiceControls.js";

function replacementBranch(expectedBranch: string): string {
  const base = expectedBranch.replace(/-recovery(?:-\d+)?$/u, "").slice(0, 220);
  return `${base}-recovery`;
}

export function WorktreeRecoveryCard({
  session,
  runnerOnline,
  onCreate,
  onSelect,
}: {
  session: SessionView;
  runnerOnline: boolean;
  onCreate: (input: { branch: string; baseRef?: string }) => Promise<void>;
  onSelect: (path: string) => Promise<void>;
}) {
  const recovery = session.worktreeRecovery;
  const broken = session.worktrees?.find((worktree) => worktree.path === recovery?.selectedPath);
  const candidates = useMemo(() => (session.worktrees ?? []).filter(
    (worktree) => worktree.path !== recovery?.selectedPath &&
      worktree.setup?.status !== "failed" && worktree.setup?.status !== "running" &&
      worktree.setup?.status !== "awaiting_trust",
  ), [recovery?.selectedPath, session.worktrees]);
  const [branch, setBranch] = useState(() => replacementBranch(recovery?.expectedBranch ?? "recovered-worktree"));
  const [baseRef, setBaseRef] = useState(() => broken?.baseRef ?? "");
  const [selectedPath, setSelectedPath] = useState(() => candidates[0]?.path ?? "");
  const [action, setAction] = useState<"create" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recovery) return;
    setBranch(replacementBranch(recovery.expectedBranch));
    setBaseRef(broken?.baseRef ?? "");
    setSelectedPath(candidates[0]?.path ?? "");
    setAction(null);
    setError(null);
  }, [broken?.baseRef, candidates, recovery?.recoveryId]);

  if (!recovery) return null;
  const disabled = action !== null || !runnerOnline;
  const run = async (next: "create" | "select", operation: () => Promise<void>) => {
    if (disabled) return;
    setAction(next);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError((cause as Error).message);
      setAction(null);
    }
  };

  return (
    <section className="quarantine-banner worktree-recovery" aria-label="Worktree Recovery Required">
      <div className="quarantine-copy">
        <span className="quarantine-title">Worktree Recovery Required</span>
        <p>{recovery.detail}</p>
        <p>
          The provider was not launched. Your submitted message is retained as <strong>Not Sent</strong>
          {" "}and can be retried after this session has a verified worktree.
        </p>
        {!runnerOnline && <p className="worktree-recovery-error">The runner is offline.</p>}
        {error && <p className="worktree-recovery-error" role="alert">{error}</p>}
      </div>
      <div className="worktree-recovery-controls">
        <fieldset disabled={disabled}>
          <legend>Create Replacement Worktree</legend>
          <label>
            <span>Base Ref</span>
            <input
              value={baseRef}
              placeholder="Default Branch"
              onChange={(event) => setBaseRef(event.target.value)}
            />
          </label>
          <label>
            <span>Branch</span>
            <input value={branch} onChange={(event) => setBranch(event.target.value)} />
          </label>
          <button
            type="button"
            className="btn primary sm"
            disabled={disabled || !branch.trim()}
            onClick={() => void run("create", () => onCreate({
              branch: branch.trim(),
              ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
            }))}
          >
            {action === "create" ? "Creating…" : "Create Replacement"}
          </button>
        </fieldset>
        <fieldset disabled={disabled || candidates.length === 0}>
          <legend>Select Existing Worktree</legend>
          <label>
            <span>Worktree</span>
            <Select
              label="Worktree"
              value={selectedPath || null}
              disabled={disabled || candidates.length === 0}
              emptyLabel="No Other Linked Worktrees"
              options={candidates.map((worktree) => ({ value: worktree.path, label: worktree.branch }))}
              onChange={setSelectedPath}
            />
          </label>
          <button
            type="button"
            className="btn ghost sm"
            disabled={disabled || !selectedPath}
            onClick={() => void run("select", () => onSelect(selectedPath))}
          >
            {action === "select" ? "Selecting…" : "Select Worktree"}
          </button>
        </fieldset>
      </div>
    </section>
  );
}
