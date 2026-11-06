import { isTerminal, type SessionView, type SessionWaitView } from "@wollipog/protocol";
import type { StatusMeta } from "./status-meta.js";

/**
 * What a session is deliberately waiting on (#1280, #4249), as conditions beside its lifecycle:
 * - a `wait_session` or `wait_pull_request` call in progress, as the control plane classified it
 *   (`SessionView.waits`): Waiting while its liveness contract holds, Wait Stalled once it breaks;
 * - a merge-queue watch the session is parked on (#4071, `SessionView.pullRequestWatch`).
 *
 * Nothing here compares clocks: a wait reads Stalled only when the server says its contract broke.
 * A Stalled wait is a warning but not a request, so it adds to no attention count.
 */
export interface SessionWaitCondition {
  meta: StatusMeta;
  description: string;
  /** Broken: shown ahead of the lifecycle's passive context. */
  broken: boolean;
}

type WaitSource = Pick<SessionView, "status"> & Partial<Pick<SessionView, "waits" | "pullRequestWatch">>;

function waitTarget(wait: SessionWaitView): string {
  if (wait.target.kind === "pull_request") return `pull request ${wait.target.repository}#${wait.target.number}`;
  return wait.target.child ? "a child session" : "another session";
}

/** The healthy label for one wait. */
export function sessionWaitLabel(wait: SessionWaitView): string {
  if (wait.target.kind === "pull_request") return "Waiting on Pull Request";
  return wait.target.child ? "Waiting on Children" : "Waiting on Session";
}

const STALL_SENTENCES: Record<NonNullable<SessionWaitView["stalledReason"]>, (target: string) => string> = {
  progress_lost: (target) => `The wait on ${target} stopped making progress: its polls stopped succeeding.`,
  target_missing: () => "The wait is still running, but the session it watches no longer exists.",
  target_reached: (target) => `The wait is still running, although ${target} already reached a state it waits for.`,
  deadline_passed: (target) => `The wait on ${target} is still running past its own timeout.`,
};

function stallSentence(wait: SessionWaitView): string {
  return STALL_SENTENCES[wait.stalledReason ?? "progress_lost"](waitTarget(wait));
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The session's wait conditions: at most one Wait Stalled and one Waiting, so one healthy wait
 * never hides another that is stuck, and a parked merge-queue watch. */
export function sessionWaitConditions(session: WaitSource): SessionWaitCondition[] {
  const conditions: SessionWaitCondition[] = [];
  // Only a turn can be inside a tool call; the server forgets the waits of a turn that ended, and
  // this keeps an older or lagging record from labeling a session at rest.
  const inTurn = session.status === "running" || session.status === "input_required";
  const waits = inTurn ? session.waits ?? [] : [];
  const stalled = waits.filter((wait) => wait.health === "stalled");
  const healthy = waits.filter((wait) => wait.health !== "stalled");
  if (stalled.length) {
    conditions.push({
      meta: { label: "Wait Stalled", tone: "warning", pulse: false },
      description: stalled.map(stallSentence).join(" ") +
        (healthy.length ? ` ${healthy.length} other ${plural(healthy.length, "wait is", "waits are")} still making progress.` : ""),
      broken: true,
    });
  }
  if (healthy.length) {
    const first = healthy[0]!;
    const others = healthy.length - 1;
    conditions.push({
      meta: { label: sessionWaitLabel(first), tone: "info", pulse: false },
      description: `The agent is deliberately waiting on ${waitTarget(first)}, and the wait is making progress.` +
        (others ? ` It is also waiting on ${others} more ${plural(others, "target", "targets")}.` : ""),
      broken: false,
    });
  }
  const watch = isTerminal(session.status) ? undefined : session.pullRequestWatch;
  if (watch) {
    const target = `pull request ${watch.repository}#${watch.number}`;
    if (watch.state === "watching") {
      conditions.push({
        meta: { label: "Waiting on Merge Queue", tone: "info", pulse: false },
        description: `The session is parked on ${target} in the merge queue. It wakes when the pull request merges, leaves the queue, or its head moves.`,
        broken: false,
      });
    } else if (watch.state === "lost") {
      conditions.push({
        meta: { label: "Merge Queue Watch Lost", tone: "warning", pulse: false },
        description: `Wollipog stopped watching ${target} in the merge queue` +
          (watch.reason ? `: ${watch.reason.replace(/\.?$/u, ".")}` : "."),
        broken: true,
      });
    } else if (watch.state === "fired" && ["none", "held", "delivering", "uncertain"].includes(watch.continuation)) {
      conditions.push({
        meta: { label: "Merge Queue Wake Pending", tone: "neutral", pulse: false },
        description: `The merge-queue watch on ${target} ended, and its wake prompt has not reached the session yet.`,
        broken: false,
      });
    }
  }
  return conditions;
}
