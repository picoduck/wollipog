import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import type { SessionView } from "@wollipog/protocol";
import { Select } from "./ui/ChoiceControls.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
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

/** The form typed for one recovery incident, by session and incident. The session notice slot shows
 * one notice at a time, so choosing another from "+N More" unmounts this card; the draft outlives
 * that for the life of the page (#1966). */
const recoveryDrafts = new Map<string, Partial<{ branch: string; baseRef: string; selectedPath: string }>>();

export function WorktreeRecoveryCard({
  session,
  runnerOnline,
  offlineReason = "The runner is offline.",
  creation = null,
  onCreate,
  onSelect,
  trailing,
}: {
  session: SessionView;
  runnerOnline: boolean;
  /** The visible reason both actions are unavailable while the runner is offline, naming its Machine. */
  offlineReason?: string;
  /** The session notice slot's "+N More", in the title row. */
  trailing?: ReactNode;
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
  const draftKey = recovery ? `${session.id}:${recovery.recoveryId}` : null;
  const [branch, setBranch] = useState(() =>
    (draftKey ? recoveryDrafts.get(draftKey)?.branch : undefined) ??
      replacementBranch(recovery?.expectedBranch ?? "recovered-worktree"));
  const [baseRef, setBaseRef] = useState(() =>
    (draftKey ? recoveryDrafts.get(draftKey)?.baseRef : undefined) ?? broken?.baseRef ?? "");
  const [selectedPath, setSelectedPath] = useState(() =>
    (draftKey ? recoveryDrafts.get(draftKey)?.selectedPath : undefined) ?? candidates[0]?.path ?? "");
  const shownRecoveryId = useRef(recovery?.recoveryId);
  const [action, setAction] = useState<"create" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Colons are legal in an id but hostile to CSS selectors, and these ids are looked up by tests
  // and by assistive technology alike.
  const uid = useId().replace(/:/gu, "");
  const detailId = `worktree-recovery-detail-${uid}`;
  const retainedId = `worktree-recovery-retained-${uid}`;
  const offlineId = `worktree-recovery-offline-${uid}`;
  const creationFailedId = `worktree-recovery-create-failed-${uid}`;
  const refusalId = `worktree-recovery-refusal-${uid}`;
  // Creating and selecting a worktree are refused together for a person the server refuses (#1864).
  const refusal = sessionCommandRefusal(session, "manageWorktrees");

  // Only what the person edits is kept, so an untouched form still proposes fresh defaults.
  const edit = (change: Partial<{ branch: string; baseRef: string; selectedPath: string }>) => {
    if (change.branch !== undefined) setBranch(change.branch);
    if (change.baseRef !== undefined) setBaseRef(change.baseRef);
    if (change.selectedPath !== undefined) setSelectedPath(change.selectedPath);
    if (draftKey) recoveryDrafts.set(draftKey, { ...recoveryDrafts.get(draftKey), ...change });
  };

  useEffect(() => {
    // Mounting again for the same incident (the notice slot showed another notice meanwhile) keeps
    // the draft the person typed.
    if (!recovery || shownRecoveryId.current === recovery.recoveryId) return;
    shownRecoveryId.current = recovery.recoveryId;
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
  // While the card checks for a create already running, offering another could start a second one.
  const checking = !creating && creation?.status === "checking";
  const creationFailure = !creating && action === null && creation?.status === "failed" ? creation : null;
  const phase = creation?.status === "creating" && creation.phase ? worktreeCreationPhase(creation.phase) : null;
  const failedPhase = creationFailure?.phase ? worktreeCreationPhase(creationFailure.phase) : null;
  const disabled = action !== null || creating || checking || !runnerOnline || refusal !== null;
  // Both actions carry the incident detail and the reason ordinary submission is unavailable, so a
  // screen reader announces why the card exists rather than just the action's own name.
  const describedBy = [detailId, retainedId, ...(refusal === null ? [] : [refusalId]), ...(runnerOnline ? [] : [offlineId]),
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
    <Notice as="section" tone="danger" ariaLabel="Worktree Recovery Required" title="Worktree Recovery Required"
      trailing={trailing}>
        <p id={detailId}>{recovery.detail}</p>
        <p id={retainedId}>
          This worktree cannot start another turn. Messages marked <strong>Not Sent</strong>
          {" "}can be retried after this session has a verified worktree.
        </p>
        {refusal !== null && <p id={refusalId}>{refusal}</p>}
        {!runnerOnline && <p id={offlineId} className="notice-error">{offlineReason}</p>}
        {error && <p className="notice-error" role="alert">{error}</p>}
        {creationFailure && (
          <p id={creationFailedId} className="notice-error" role="alert">
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
      <div className="worktree-recovery-controls">
        <fieldset disabled={disabled}>
          <legend>Create Replacement Worktree</legend>
          <label>
            <span>Base Ref</span>
            <input
              value={baseRef}
              placeholder="Default Branch"
              onChange={(event) => edit({ baseRef: event.target.value })}
            />
          </label>
          <label>
            <span>Branch</span>
            <input value={branch} onChange={(event) => edit({ branch: event.target.value })} />
          </label>
          <button
            type="button"
            className="btn primary sm"
            aria-describedby={describedBy}
            title={refusal ?? undefined}
            disabled={disabled || !branch.trim()}
            onClick={() => void run("create", () => onCreate({
              branch: branch.trim(),
              ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
            }))}
          >
            {creating ? "Creating…" : checking ? "Checking…" : "Create Replacement"}
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
              onChange={(path) => edit({ selectedPath: path })}
            />
          </label>
          <button
            type="button"
            className="btn ghost sm"
            aria-describedby={describedBy}
            title={refusal ?? undefined}
            disabled={disabled || !selectedPath}
            onClick={() => void run("select", () => onSelect(selectedPath))}
          >
            {action === "select" ? "Selecting…" : "Select Worktree"}
          </button>
        </fieldset>
      </div>
    </Notice>
  );
}
