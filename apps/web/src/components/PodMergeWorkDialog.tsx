import { useEffect, useId, useState } from "react";
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
import { podMemberName, podMemberShortName, podMemberTask } from "../pod-presentation.js";
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

function MergeRow({ pod, receipt, sessions }: {
  pod: PodView;
  receipt: PodReconciliation;
  sessions: ReadonlyMap<string, SessionView>;
}) {
  const from = podMemberShortName(pod, sessions, receipt.sourceSessionId);
  const into = podMemberShortName(pod, sessions, receipt.targetSessionId);
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
  const [worktrees, setWorktrees] = useState<ReadonlyMap<string, WorktreeState>>(new Map());
  const [merging, setMerging] = useState(false);
  const [merged, setMerged] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const source = pod.members.some((member) => member.sessionId === fromId) ? sessions.get(fromId) : undefined;
  const target = pod.members.some((member) => member.sessionId === intoId) ? sessions.get(intoId) : undefined;
  const runner = target ? runners.get(target.runnerId) : undefined;
  const name = (sessionId: string) => podMemberShortName(pod, sessions, sessionId);

  // Read each chosen idle member's worktree, again whenever it settles from a turn, so Merge can say
  // which member still has uncommitted changes. A failed read leaves the decision to the server.
  const checks = [source, target]
    .filter((session): session is SessionView => Boolean(session?.worktreePath) && session?.status === "idle")
    .map((session) => `${session.id}@${session.lastEventAt ?? 0}`);
  const checkKey = [...new Set(checks)].join(" ");
  useEffect(() => {
    if (!checkKey) return;
    let current = true;
    const sessionIds = checkKey.split(" ").map((entry) => entry.slice(0, entry.lastIndexOf("@")));
    setWorktrees((known) => new Map([...known, ...sessionIds.map((id) => [id, "checking"] as const)]));
    for (const sessionId of sessionIds) {
      api.git(sessionId, { action: "status" })
        .then((data) => data.status ? (data.status.hasChanges ? "changed" : "clean") : "unknown")
        .catch(() => "unknown" as const)
        .then((state) => {
          if (current) setWorktrees((known) => new Map(known).set(sessionId, state as WorktreeState));
        });
    }
    return () => { current = false; };
  }, [api, checkKey]);

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
    }
  };

  const options = pod.members.map((member) => {
    const session = sessions.get(member.sessionId);
    return { value: member.sessionId, label: podMemberName(member, session), description: podMemberTask(member, session) || undefined };
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
        {receipts.length > 0 && (
          <section className="pod-merges" aria-labelledby={`${ids}-recent`}>
            <h3 className="section-title" id={`${ids}-recent`}>Recent Merges</h3>
            <ul className="surface pod-merge-list">
              {receipts.map((receipt) => <MergeRow key={receipt.reconciliationId} pod={pod} receipt={receipt} sessions={sessions} />)}
            </ul>
          </section>
        )}
        {failure && (
          <Notice tone="danger" role="alert" details={<code>{failure}</code>}>
            The merge didn't run.
          </Notice>
        )}
      </div>
    </Modal>
  );
}
