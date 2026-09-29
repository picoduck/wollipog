import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import type { SessionView } from "@wollipog/protocol";
import { ChoiceList, SegmentedControl, Select } from "./ui/ChoiceControls.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Modal } from "./Modal.js";
import { useIsMobile } from "./useIsMobile.js";
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

type RecoveryPath = "create" | "existing";
type RecoveryDraft = Partial<{ path: RecoveryPath; branch: string; baseRef: string; selectedPath: string }>;

/** The form typed for one recovery incident, by session and incident. The session notice slot shows
 * one notice at a time, so choosing another from "+N More" unmounts this card; the draft outlives
 * that for the life of the page (#1966). */
const recoveryDrafts = new Map<string, RecoveryDraft>();

const PATH_OPTIONS = [
  { value: "create" as const, label: "Create New" },
  { value: "existing" as const, label: "Use Existing" },
];

/** A setup step's name, set in code inside a sentence. */
function StepName({ name }: { name: string | undefined }) {
  return name ? <> (<code>{name}</code>)</> : null;
}

/**
 * The rank-1 danger notice in the session notice slot while a session's worktree is missing
 * (docs/design-system.md §13.2, #1976): one sentence, then one question — create a replacement or
 * use an existing worktree — answered in one row. Below 760px the notice keeps only its sentence,
 * its status line and a Recover Worktree… button that opens the same form as a bottom sheet (§7.5).
 */
export function WorktreeRecoveryCard({
  session,
  runnerOnline,
  machineName = "This machine",
  creation = null,
  selecting = false,
  selectError = null,
  onCreate,
  onSelect,
  trailing,
}: {
  /** A worktree selection is still running. Like `creation`, it outlives this card, which the
   * session notice slot unmounts while another notice shows. */
  selecting?: boolean;
  /** Why the last worktree selection failed, kept by the caller so a card mounted after the failure
   * still shows it. */
  selectError?: string | null;
  session: SessionView;
  runnerOnline: boolean;
  /** The session's Machine, named by the visible reason both actions are unavailable while it is
   * offline. */
  machineName?: string;
  /** The session notice slot's "+N More", in the title row. */
  trailing?: ReactNode;
  /** Replacement-create progress. It outlives this component's own in-flight action so a reloaded
   * page shows a create that is still running, and names the phase a failed create stopped in. */
  creation?: RecoveryWorktreeCreation | null;
  onCreate: (input: { branch: string; baseRef?: string }) => Promise<void>;
  onSelect: (path: string) => Promise<void>;
}) {
  const recovery = session.worktreeRecovery;
  const phone = useIsMobile();
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
  const draft = (draftKey ? recoveryDrafts.get(draftKey) : undefined) ?? {};
  const [path, setPath] = useState<RecoveryPath>(() => draft.path ?? "create");
  const [branch, setBranch] = useState(() =>
    draft.branch ?? replacementBranch(recovery?.expectedBranch ?? "recovered-worktree"));
  const [baseRef, setBaseRef] = useState(() => draft.baseRef ?? broken?.baseRef ?? "");
  const [selectedPath, setSelectedPath] = useState(() => draft.selectedPath ?? candidates[0]?.path ?? "");
  const shownRecoveryId = useRef(recovery?.recoveryId);
  const [action, setAction] = useState<"create" | "select" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const recoverButton = useRef<HTMLButtonElement>(null);
  // Colons are legal in an id but hostile to CSS selectors, and these ids are looked up by tests
  // and by assistive technology alike.
  const uid = useId().replace(/:/gu, "");
  // Refusals are refused together for a person the server refuses (#1864).
  const refusal = sessionCommandRefusal(session, "manageWorktrees");

  // Only what the person edits is kept, so an untouched form still proposes fresh defaults.
  const edit = (change: RecoveryDraft) => {
    if (change.path !== undefined) setPath(change.path);
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
    setPath("create");
    setBranch(replacementBranch(recovery.expectedBranch));
    setBaseRef(broken?.baseRef ?? "");
    setSelectedPath(candidates[0]?.path ?? "");
    setAction(null);
    setError(null);
    setOutputOpen(false);
    // A fresh incident resets the form. Ordinary session broadcasts must preserve typed input and
    // the in-flight action guard even when they re-materialize the worktrees array.
  }, [recovery?.recoveryId]);

  if (!recovery) return null;
  const creating = action === "create" || creation?.status === "creating";
  // While the card checks for a create already running, offering another could start a second one.
  const checking = !creating && creation?.status === "checking";
  const creationFailure = !creating && action === null && creation?.status === "failed" ? creation : null;
  const progress = creation?.status === "creating" && creation.phase ? worktreeCreationPhase(creation.phase) : null;
  const failedPhase = creationFailure?.phase ? worktreeCreationPhase(creationFailure.phase) : null;
  const selectBusy = action === "select" || selecting;
  // Unavailable for a reason the notice states, rather than because something is running.
  const blocked = !runnerOnline || refusal !== null;
  const busy = action !== null || selecting || creating || checking;
  const disabled = busy || blocked;
  const ids = {
    sentence: `worktree-recovery-detail-${uid}`,
    refusal: `worktree-recovery-refusal-${uid}`,
    offline: `worktree-recovery-offline-${uid}`,
    failed: `worktree-recovery-create-failed-${uid}`,
    output: `worktree-recovery-output-${uid}`,
  };
  // Every action carries the incident and the reason it is unavailable, so a screen reader
  // announces why the notice exists rather than just the action's own name.
  const describedBy = [ids.sentence, ...(refusal === null ? [] : [ids.refusal]), ...(runnerOnline ? [] : [ids.offline]),
    ...(creationFailure ? [ids.failed] : [])].join(" ");
  const run = async (next: "create" | "select", operation: () => Promise<void>) => {
    if (disabled) return;
    setAction(next);
    setError(null);
    setOutputOpen(false);
    try {
      await operation();
    } catch (cause) {
      setError((cause as Error).message);
    }
    // A confirmed recovery unmounts the card; anything else, including a create whose failure is
    // reported through `creation`, must leave the form actionable again.
    setAction(null);
  };
  const create = () => void run("create", () => onCreate({
    branch: branch.trim(),
    ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
  }));
  const select = () => void run("select", () => onSelect(selectedPath));
  const createLabel = creationFailure ? "Try Again" : "Create Replacement";
  const worktreeOptions = candidates.map((worktree) => ({
    value: worktree.path,
    label: worktree.path === recovery.selectedPath ? `${worktree.branch} (Restore Selected)` : worktree.branch,
  }));
  const sheet = phone && sheetOpen;
  // While the sheet is open it shows the status lines and the notice behind it does not, so a line
  // is announced once. The sheet's copies take their own ids.
  const idFor = (key: keyof typeof ids, where: "notice" | "sheet") => `${ids[key]}${where === "sheet" ? "-sheet" : ""}`;
  const describedByIn = (where: "notice" | "sheet") =>
    where === "notice" ? describedBy : describedBy.split(" ").map((id) =>
      id === ids.sentence ? id : `${id}-sheet`).join(" ");

  const statusLines = (where: "notice" | "sheet") => (
    <>
      {refusal !== null && <p id={idFor("refusal", where)}>{refusal}</p>}
      {!runnerOnline && (
        <p id={idFor("offline", where)} className="notice-error">
          {machineName} is offline, so the worktree can't be recovered until it reconnects.
        </p>
      )}
      {(error ?? selectError) && <p className="notice-error" role="alert">{error ?? selectError}</p>}
      {progress && (
        <div className="worktree-missing-progress" role="status" aria-label="Replacement Worktree Progress">
          <span className="worktree-missing-progress-label">
            {progress.label}
            {progress.label === "Running Setup" && <StepName name={creation?.status === "creating" ? creation.setupStep : undefined} />}
            , Step {progress.step} of {WORKTREE_CREATION_STEPS}
          </span>
          <div
            className="meter is-progress"
            role="progressbar"
            aria-label="Replacement Worktree Progress"
            aria-valuemin={0}
            aria-valuemax={WORKTREE_CREATION_STEPS}
            aria-valuenow={progress.step}
          >
            <span style={{ width: `${(progress.step / WORKTREE_CREATION_STEPS) * 100}%` }} />
          </div>
        </div>
      )}
      {creationFailure && (
        <div className="worktree-missing-failure">
          <p id={idFor("failed", where)} className="notice-error" role="alert">
            {failedPhase
              ? <>Creating the worktree stopped at step {failedPhase.step}, {failedPhase.label}<StepName name={creationFailure.setupStep} />.</>
              : "Creating the worktree stopped before it finished."}
          </p>
          {/* On a phone the output waits in the sheet, so the notice stays short. */}
          {(where === "sheet" || !phone) && (
            <>
              <button
                type="button"
                className="btn sm ghost"
                aria-expanded={outputOpen}
                aria-controls={outputOpen ? idFor("output", where) : undefined}
                onClick={() => setOutputOpen((open) => !open)}
              >
                {outputOpen ? "Hide Output" : "Show Output"}
              </button>
              {outputOpen && (
                <div id={idFor("output", where)} className="code-well worktree-missing-output">
                  <pre>{creationFailure.error}</pre>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );

  const pathChoice = (
    <SegmentedControl
      className={phone ? "block" : undefined}
      label="Recovery Method"
      options={PATH_OPTIONS}
      value={path}
      onChange={(next) => edit({ path: next })}
    />
  );
  const createButton = (className: string) => (
    <BusyButton
      className={className}
      busy={creating || checking}
      progress={checking ? "Checking for a replacement already being created…" : "Creating the replacement worktree…"}
      aria-describedby={describedByIn(sheet ? "sheet" : "notice")}
      title={refusal ?? undefined}
      disabled={!(creating || checking) && (disabled || !branch.trim())}
      onClick={create}
    >
      {createLabel}
    </BusyButton>
  );
  const useButton = (className: string) => (
    <BusyButton
      className={className}
      busy={selectBusy}
      progress="Switching to the worktree…"
      aria-describedby={describedByIn(sheet ? "sheet" : "notice")}
      title={refusal ?? undefined}
      disabled={!selectBusy && (disabled || !selectedPath)}
      onClick={select}
    >
      Use Worktree
    </BusyButton>
  );
  const fields = path === "create" ? (
    <>
      <label className="field">
        <span>Base Ref</span>
        <input
          value={baseRef}
          disabled={disabled}
          placeholder="Default Branch"
          onChange={(event) => edit({ baseRef: event.target.value })}
        />
      </label>
      <label className="field">
        <span>Branch</span>
        <input value={branch} disabled={disabled} onChange={(event) => edit({ branch: event.target.value })} />
      </label>
    </>
  ) : phone ? (candidates.length === 0 ? (
    <p className="worktree-missing-empty">No other worktrees are linked to this session.</p>
  ) : (
    <ChoiceList
      label="Worktree"
      options={worktreeOptions.map((option) => ({ ...option, disabled }))}
      value={selectedPath || null}
      onChange={(next) => edit({ selectedPath: next })}
    />
  )) : (
    <div className="field worktree-missing-picker">
      <span aria-hidden="true">Worktree</span>
      <Select
        label="Worktree"
        value={selectedPath || null}
        disabled={disabled || candidates.length === 0}
        emptyLabel="No Other Linked Worktrees"
        options={worktreeOptions}
        onChange={(next) => edit({ selectedPath: next })}
      />
    </div>
  );

  return (
    <Notice as="section" tone="danger" ariaLabel="Worktree Missing" title="Worktree Missing" trailing={trailing}
      className="worktree-missing"
      details={<p>{recovery.detail}</p>}
      actions={phone ? (
        <button
          ref={recoverButton}
          type="button"
          className="btn primary"
          aria-describedby={describedBy}
          aria-haspopup="dialog"
          title={refusal ?? undefined}
          disabled={blocked}
          onClick={() => setSheetOpen(true)}
        >
          {creationFailure ? "Try Again…" : "Recover Worktree…"}
        </button>
      ) : undefined}>
      <p id={ids.sentence}>
        The worktree for <code>{recovery.expectedBranch}</code> is gone, so messages marked <strong>Not Sent</strong>
        {" "}wait until this session has a worktree.
      </p>
      {!sheet && statusLines("notice")}
      {!phone && (
        <div className="worktree-missing-form">
          {pathChoice}
          <div className={`worktree-missing-row${path === "existing" ? " existing" : ""}`}>
            {fields}
            {path === "create" ? createButton("btn primary") : useButton("btn primary")}
          </div>
        </div>
      )}
      {sheet && (
        <Modal
          size="sm"
          title="Recover Worktree"
          className="worktree-missing-sheet"
          onClose={() => setSheetOpen(false)}
          returnFocusRef={recoverButton}
          describedBy={ids.sentence}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => setSheetOpen(false)}>Cancel</button>
              {path === "create" ? createButton("btn primary") : useButton("btn primary")}
            </>
          )}
        >
          {statusLines("sheet")}
          {pathChoice}
          {fields}
        </Modal>
      )}
    </Notice>
  );
}
