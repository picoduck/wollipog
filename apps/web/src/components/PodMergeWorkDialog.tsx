import { useEffect, useId, useRef, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type PodReconciliation,
  type PodView,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime } from "../format.js";
import { podMemberName, podMemberNames, podMemberTask } from "../pod-presentation.js";
import { statusMeta } from "../status-meta.js";
import { ChevronRightIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";

export const MERGE_RULE = "Both members must be idle with committed work on the same machine and folder. " +
  "If the merge conflicts, Into is left unchanged.";

/** Whether a member's worktree has uncommitted changes, as its last status read said. */
type WorktreeState = "checking" | "clean" | "changed" | "unknown";
/** What one status read answered: a read that failed is "unknown", which leaves it to the server. */
type WorktreeRead = Exclude<WorktreeState, "checking">;

/**
 * What a status read of `session` is valid for: the member's status and activity, and the dialog's
 * read generation (bumped when the window comes back and after a merge). Anything that can change
 * the worktree changes one of them, so a read taken against another key never decides Merge.
 */
export function worktreeReadKey(session: SessionView, generation: number): string {
  return `${session.id}|${session.status}|${session.eventEpoch ?? 0}|${session.lastEventAt ?? 0}|${session.updatedAt}|${generation}`;
}

/**
 * A chosen member's worktree as Merge may rely on it: the read taken for its current key, else
 * "checking", because an earlier "clean" may no longer hold. An earlier "changed" keeps blocking
 * with its reason until the new read answers, since a merge it allowed would fail anyway.
 */
export function currentWorktreeState(reads: ReadonlyMap<string, WorktreeRead>, lastRead: ReadonlyMap<string, WorktreeRead>,
  session: SessionView, generation: number): WorktreeState {
  return reads.get(worktreeReadKey(session, generation)) ?? (lastRead.get(session.id) === "changed" ? "changed" : "checking");
}

function shortHead(head: string | undefined): string | null {
  return head ? head.slice(0, 10) : null;
}

/**
 * Why Merge is unavailable for this pair, in the person's terms, or null (§3.1). The control plane
 * applies the same rules; this says which one fails before the person asks.
 */
export function podMergeBlockedReason({ pod, source, target, runner, worktrees, name }: {
  pod: PodView;
  source: SessionView | undefined;
  target: SessionView | undefined;
  runner: RunnerView | undefined;
  worktrees: ReadonlyMap<string, WorktreeState>;
  name: (sessionId: string) => string;
}): string | null {
  if (pod.status !== "active") return "This pod is closed.";
  if (pod.orchestration?.state.status === "running") return "Stop automatic turns before merging.";
  if (pod.reconciliations?.some((receipt) => receipt.status === "running")) return "A merge is already running.";
  if (!source || !target) return "Choose a member for From and Into.";
  if (source.id === target.id) return "Choose two different members.";
  for (const session of [source, target]) {
    if (!session.useWorktree || !session.worktreePath) return `${name(session.id)} has no worktree of its own.`;
  }
  if (source.runnerId !== target.runnerId) return "Both members must be on the same machine.";
  if (!source.workspaceId || source.workspaceId !== target.workspaceId) return "Both members must be in the same folder.";
  for (const session of [source, target]) {
    if (session.pendingApproval) return `${name(session.id)} is waiting for your decision.`;
    if (session.status !== "idle") return `${name(session.id)} is ${session.status === "running" || session.status === "starting" ? "running" : "not idle"}. Merge when it's idle.`;
  }
  if (runner?.status !== "online") return "This machine is offline.";
  if (!runnerSupportsProtocol(runner.protocolVersion, "podReconciliation")) {
    return runnerCapabilityRequirement(runner.protocolVersion, "podReconciliation", "merging work between members");
  }
  for (const session of [source, target]) {
    if (worktrees.get(session.id) === "changed") return `${name(session.id)} has uncommitted changes. Commit them first.`;
  }
  if ([source, target].some((session) => worktrees.get(session.id) === "checking")) return "Checking for uncommitted changes…";
  return null;
}

function MergeRow({ receipt, names }: {
  receipt: PodReconciliation;
  names: ReadonlyMap<string, string>;
}) {
  const from = names.get(receipt.sourceSessionId)!;
  const into = names.get(receipt.targetSessionId)!;
  const heads = [
    ["From", shortHead(receipt.sourceHead)],
    ["Into", shortHead(receipt.targetHead)],
    ["Result", shortHead(receipt.resultHead)],
    ["Common Base", shortHead(receipt.mergeBase)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  const hasDetails = heads.length > 0 || Boolean(receipt.conflictPaths?.length) || Boolean(receipt.error);
  return (
    <li className="pod-merge-row">
      <div className="row-line">
        <span className="row-title">{from} into {into}</span>
        <StatusBadge meta={statusMeta("podMerge", receipt.status)} inline />
        <span className="row-trail">{relativeTime(receipt.completedAt ?? receipt.createdAt)}</span>
      </div>
      {hasDetails && (
        <details className="disclosure">
          <summary><ChevronRightIcon size={14} className="disclosure-chevron" />Show Details</summary>
          <div className="disclosure-body">
            <dl className="facts">
              {heads.map(([label, head]) => (
                <div key={label}><dt>{label}</dt><dd><code>{head}</code></dd></div>
              ))}
              {receipt.conflictPaths?.length ? (
                <div>
                  <dt>Conflicting Paths</dt>
                  <dd><ul className="pod-merge-paths">{receipt.conflictPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></dd>
                </div>
              ) : null}
              {receipt.error && <div><dt>Error</dt><dd>{receipt.error}</dd></div>}
            </dl>
          </div>
        </details>
      )}
    </li>
  );
}

/** The pod's merges, newest first, each in words with its heads behind Show Details (#2980). */
function RecentMerges({ receipts, names, titled = true }: {
  receipts: readonly PodReconciliation[];
  names: ReadonlyMap<string, string>;
  /** Off where the dialog's own title already says "Recent Merges". */
  titled?: boolean;
}) {
  const id = useId();
  return (
    <section className="pod-merges" aria-labelledby={titled ? id : undefined} aria-label={titled ? undefined : "Recent Merges"}>
      {titled && <h3 className="section-title" id={id}>Recent Merges</h3>}
      <ul className="surface pod-merge-list">
        {receipts.map((receipt) => <MergeRow key={receipt.reconciliationId} receipt={receipt} names={names} />)}
      </ul>
    </section>
  );
}

/**
 * Recent Merges… on a closed pod (#2981): Merge Work is unavailable once the pod closes, so its
 * merges stay readable here, in words and with Show Details, and nothing can merge.
 */
export function PodRecentMergesDialog({ pod, sessions, onClose }: {
  pod: PodView;
  sessions: ReadonlyMap<string, SessionView>;
  onClose: () => void;
}) {
  const receipts = pod.reconciliations ?? [];
  const names = podMemberNames(pod, sessions, [
    ...pod.members.map((member) => member.sessionId),
    ...receipts.flatMap((receipt) => [receipt.sourceSessionId, receipt.targetSessionId]),
  ]);
  return (
    <Modal
      title="Recent Merges"
      description="This pod is closed, so no more work can be merged."
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <RecentMerges receipts={receipts} names={names} titled={false} />
    </Modal>
  );
}

/**
 * Merge Work… (#2980): merge one member's committed work into another's, opened from the pod's ⋯,
 * with the pod's Recent Merges below. Merge stays disabled with the rule that fails, including a
 * member with uncommitted changes, which the dialog reads from each chosen member's worktree.
 */
export function PodMergeWorkDialog({ pod, sessions, runners, onClose }: {
  pod: PodView;
  sessions: ReadonlyMap<string, SessionView>;
  runners: ReadonlyMap<string, RunnerView>;
  onClose: () => void;
}) {
  const api = useApi();
  const ids = useId();
  const [intoId, setIntoId] = useState(() =>
    pod.members.find((member) => member.role === "lead")?.sessionId ?? pod.members[0]?.sessionId ?? "");
  const [fromId, setFromId] = useState(() => pod.members.find((member) => member.sessionId !== intoId)?.sessionId ?? "");
  // Status reads by the key they were taken for, and each member's latest answer.
  const [reads, setReads] = useState<ReadonlyMap<string, WorktreeRead>>(new Map());
  const [lastRead, setLastRead] = useState<ReadonlyMap<string, WorktreeRead>>(new Map());
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // The read generation, bumped when the window regains focus or becomes visible and after a
  // merge settles: a commit made outside Wollipog (a terminal, an editor) or by the merge itself
  // changes no session activity, so these are the cues to read the worktrees again.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const again = () => { if (document.visibilityState !== "hidden") setGeneration((count) => count + 1); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);

  const source = pod.members.some((member) => member.sessionId === fromId) ? sessions.get(fromId) : undefined;
  const target = pod.members.some((member) => member.sessionId === intoId) ? sessions.get(intoId) : undefined;
  const runner = target ? runners.get(target.runnerId) : undefined;
  const memberIds = pod.members.map((member) => member.sessionId);
  const receiptIds = (pod.reconciliations ?? []).flatMap((receipt) => [receipt.sourceSessionId, receipt.targetSessionId]);
  // Names no two members share, in sentences and rows; choices start at role and agent (#2980).
  const names = podMemberNames(pod, sessions, [...memberIds, ...receiptIds]);
  const choiceNames = podMemberNames(pod, sessions, memberIds, "agent");
  const name = (sessionId: string) => names.get(sessionId) ?? sessionId;

  // Read each chosen idle member's worktree for its current key, so Merge can say which member
  // still has uncommitted changes. Reads are kept by key, so an answer that arrives late, for a
  // state the member has since left, can never stand for the current one.
  const chosen = [source, target]
    .filter((session): session is SessionView => Boolean(session?.worktreePath) && session?.status === "idle");
  const pending = [...new Map(chosen.map((session) => [worktreeReadKey(session, generation), session.id])).entries()]
    .filter(([key]) => !reads.has(key));
  const pendingKey = pending.map(([key]) => key).join(" ");
  // Set on every setup, not only the first: StrictMode replays setup and cleanup once, and a flag
  // only ever cleared would drop every answer after the replay, leaving Merge at "Checking…".
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // A replayed setup finds a read already in flight and does not repeat it; that read's answer
  // lands under its own key. A remount is a new dialog with its own set, so no key is stranded.
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    for (const [key, sessionId] of pending) {
      if (inFlight.current.has(key)) continue;
      inFlight.current.add(key);
      api.git(sessionId, { action: "status" })
        .then((data): WorktreeRead => data.status ? (data.status.hasChanges ? "changed" : "clean") : "unknown")
        .catch((): WorktreeRead => "unknown")
        .then((state) => {
          inFlight.current.delete(key);
          if (!mounted.current) return;
          setReads((known) => new Map(known).set(key, state));
          setLastRead((known) => new Map(known).set(sessionId, state));
        });
    }
    // Keyed by the reads still missing; each starts once and lands under its own key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pendingKey]);

  const worktrees = new Map(chosen.map((session) => [session.id, currentWorktreeState(reads, lastRead, session, generation)]));
  const blockedReason = podMergeBlockedReason({ pod, source, target, runner, worktrees, name });

  const merge = async () => {
    if (merging || blockedReason) return;
    setMerging(true);
    setFailure(null);
    try {
      await api.reconcilePod(pod.id, { sourceSessionId: fromId, targetSessionId: intoId });
      setMerged(true);
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      setMerging(false);
      // The merge may have moved Into's worktree; nothing read before it decides the next one.
      setGeneration((count) => count + 1);
    }
  };

  const options = pod.members.map((member) => {
    const session = sessions.get(member.sessionId);
    const label = choiceNames.get(member.sessionId)!;
    const task = podMemberTask(member, session);
    return { value: member.sessionId, label, ...(task && label === podMemberName(member, session) ? { description: task } : {}) };
  });
  const reasonId = `${ids}-reason`;
  const ruleId = `${ids}-rule`;
  const receipts = pod.reconciliations ?? [];
  return (
    <Modal
      title="Merge Work"
      description="Merge one member's committed work into another's."
      onClose={onClose}
      footer={(
        <>
          {blockedReason && !merging && <span className="pod-merge-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" onClick={onClose}>{merged ? "Done" : "Cancel"}</button>
          <BusyButton className="btn primary" busy={merging} progress="Merging…"
            disabled={Boolean(blockedReason) && !merging} aria-describedby={blockedReason && !merging ? reasonId : undefined}
            onClick={() => void merge()}>
            Merge
          </BusyButton>
        </>
      )}
    >
      <div className="form">
        <div className="field-row">
          <div className="field">
            <span>From</span>
            <Select<string> label="From" value={fromId || null} options={options} describedBy={ruleId}
              disabled={merging} onChange={setFromId} />
          </div>
          <div className="field">
            <span>Into</span>
            <Select<string> label="Into" value={intoId || null} options={options} describedBy={ruleId}
              disabled={merging} onChange={setIntoId} />
          </div>
        </div>
        <p className="field-helper pod-merge-rule" id={ruleId}>{MERGE_RULE}</p>
        {receipts.length > 0 && <RecentMerges receipts={receipts} names={names} />}
        {failure && (
          <Notice tone="danger" role="alert" details={<code>{failure}</code>}>
            The merge didn't run.
          </Notice>
        )}
      </div>
    </Modal>
  );
}
