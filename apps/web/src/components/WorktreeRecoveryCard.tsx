import { useEffect, useId, useMemo, useState } from "react";
import type { SessionView } from "@wollipog/protocol";
import { Select } from "./ui/ChoiceControls.js";
import {
  WORKTREE_CREATION_STEPS,
  worktreeCreationPhase,
  type RecoveryWorktreeCreation,
} from "../recovery-worktree-creation.js";

function replacementBranch(expectedBranch: string): string {
  const prior = /^(.*)-recovery(?:-(\d+))?$/u.exec(expectedBranch);
  if (!prior) return `${expectedBranch.slice(0, 220)}-recovery`;
  const suffix = Number(prior[2] ?? 1) + 1;
  return `${prior[1]!.slice(0, 218)}-recovery-${suffix}`;
}

export function WorktreeRecoveryCard({
  session,
  runnerOnline,
  creation = null,
  onCreate,
  onSelect,
}: {
  session: SessionView;
  runnerOnline: boolean;
  /** Replacement-create progress. It outlives this component's own in-flight action so a reloaded
   * page shows a create that is still running, and names the phase a failed create stopped in. */
  creation?: RecoveryWorktreeCreation | null;
  onCreate: (input: { branch: string; baseRef?: string }) => Promise<void>;
  onSelect: (path: string) => Promise<void>;
}) {
  const recovery = session.worktreeRecovery;
  const broken = session.worktrees?.find((worktree) => worktree.path === recovery?.selectedPath);
  const candidates = useMemo(() => {
    const eligible = (session.worktrees ?? []).filter((worktree) =>
      worktree.setup?.status !== "failed" && worktree.setup?.status !== "running" &&
      worktree.setup?.status !== "awaiting_trust");
    // Keep healthy alternatives first, but retain the selected coordinate as a restore option.
    // The runner re-proves it before activation, so a path that is still broken fails precisely.
    return [...eligible.filter((worktree) => worktree.path !== recovery?.selectedPath),
      ...eligible.filter((worktree) => worktree.path === recovery?.selectedPath)];
  }, [recovery?.selectedPath, session.worktrees]);
  const [branch, setBranch] = useState(() => replacementBranch(recovery?.expectedBranch ?? "recovered-worktree"));
  const [baseRef, setBaseRef] = useState(() => broken?.baseRef ?? "");
  const [selectedPath, setSelectedPath] = useState(() => candidates[0]?.path ?? "");
  const [action, setAction] = useState<"create" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Colons are legal in an id but hostile to CSS selectors, and these ids are looked up by tests
  // and by assistive technology alike.
  const uid = useId().replace(/:/gu, "");
  const detailId = `worktree-recovery-detail-${uid}`;
  const retainedId = `worktree-recovery-retained-${uid}`;
  const offlineId = `worktree-recovery-offline-${uid}`;
  const creationFailedId = `worktree-recovery-create-failed-${uid}`;

  useEffect(() => {
    if (!recovery) return;
    setBranch(replacementBranch(recovery.expectedBranch));
    setBaseRef(broken?.baseRef ?? "");
    setSelectedPath(candidates[0]?.path ?? "");
    setAction(null);
    setError(null);
    // A fresh incident resets the form. Ordinary session broadcasts must preserve typed input and
    // the in-flight action guard even when they re-materialize the worktrees array.
  }, [recovery?.recoveryId]);

  if (!recovery) return null;
  const creating = action === "create" || creation?.status === "creating";
  const creationFailure = !creating && action === null && creation?.status === "failed" ? creation : null;
  const phase = creation?.status === "creating" && creation.phase ? worktreeCreationPhase(creation.phase) : null;
  const failedPhase = creationFailure?.phase ? worktreeCreationPhase(creationFailure.phase) : null;
  const disabled = action !== null || creating || !runnerOnline;
  // Both actions carry the incident detail and the reason ordinary submission is unavailable, so a
  // screen reader announces why the card exists rather than just the action's own name.
  const describedBy = [detailId, retainedId, ...(runnerOnline ? [] : [offlineId]),
    ...(creationFailure ? [creationFailedId] : [])].join(" ");
  const run = async (next: "create" | "select", operation: () => Promise<void>) => {
    if (disabled) return;
    setAction(next);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError((cause as Error).message);
    }
    // A confirmed recovery unmounts the card; anything else, including a create whose failure is
    // reported through `creation`, must leave the form actionable again.
    setAction(null);
  };

  return (
    <section className="quarantine-banner worktree-recovery" aria-label="Worktree Recovery Required">
      <div className="quarantine-copy">
        <span className="quarantine-title">Worktree Recovery Required</span>
        <p id={detailId}>{recovery.detail}</p>
        <p id={retainedId}>
          The provider was not launched. Your submitted message is retained as <strong>Not Sent</strong>
          {" "}and can be retried after this session has a verified worktree.
        </p>
        {!runnerOnline && <p id={offlineId} className="worktree-recovery-error">The runner is offline.</p>}
        {error && <p className="worktree-recovery-error" role="alert">{error}</p>}
        {creationFailure && (
          <p id={creationFailedId} className="worktree-recovery-error" role="alert">
            <strong>{failedPhase ? `Creation Failed: ${failedPhase.label}` : "Creation Failed"}</strong>
            {" "}{creationFailure.error}
          </p>
        )}
        {phase && (
          <div className="worktree-recovery-progress" role="status" aria-label="Replacement Worktree Progress">
            <span className="worktree-recovery-progress-phase">{phase.label}</span>
            <span className="worktree-recovery-progress-step">Step {phase.step} of {WORKTREE_CREATION_STEPS}</span>
            <progress max={WORKTREE_CREATION_STEPS} value={phase.step} aria-hidden="true" />
          </div>
        )}
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
            aria-describedby={describedBy}
            disabled={disabled || !branch.trim()}
            onClick={() => void run("create", () => onCreate({
              branch: branch.trim(),
              ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
            }))}
          >
            {creating ? "Creating…" : "Create Replacement"}
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
              options={candidates.map((worktree) => ({
                value: worktree.path,
                label: worktree.path === recovery.selectedPath
                  ? `${worktree.branch} (Restore Selected)`
                  : worktree.branch,
              }))}
              onChange={setSelectedPath}
            />
          </label>
          <button
            type="button"
            className="btn ghost sm"
            aria-describedby={describedBy}
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
