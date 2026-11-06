import {
  SESSION_WAIT_DEADLINE_GRACE_MS,
  SESSION_WAIT_KINDS,
  SESSION_WAIT_LIMIT_PER_SESSION,
  SESSION_WAIT_MAX_INTERVAL_MS,
  SESSION_WAIT_MAX_TIMEOUT_MS,
  SESSION_WAIT_TARGET_GRACE_MS,
  sessionWaitProgressBoundMs,
  type SessionStatus,
  type SessionWaitKind,
  type SessionWaitReport,
  type SessionWaitReportTarget,
  type SessionWaitStallReason,
  type SessionWaitView,
} from "@wollipog/protocol";

/** What the registry reads about a `wait_session` target: its status, or null once it is gone. */
export type SessionWaitTargetStatus = (targetSessionId: string) => SessionStatus | null;

interface WaitRecord {
  waitId: string;
  kind: SessionWaitKind;
  target: SessionWaitReportTarget;
  child: boolean;
  since: number;
  deadlineAt: number;
  intervalMs: number;
  lastProgressAt: number;
  /** When the registry first saw the watched session in a requested state, while the wait ran. */
  targetReachedSince: number | null;
  health: "healthy" | "stalled";
  stalledReason?: SessionWaitStallReason;
  stalledSince?: number;
}

const WAIT_ID = /^wait_[A-Za-z0-9_-]{8,64}$/u;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REPOSITORY = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,254}$/u;
const MAX_TARGET_STATES = 8;

function duration(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** A report's exact shape, or why it is refused. Unknown keys are refused so a newer reporter's
 * extension is never half-understood. */
export function parseSessionWaitReport(body: unknown): SessionWaitReport | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "a wait report must be an object";
  const value = body as Record<string, unknown>;
  const keys = ["waitId", "kind", "state", "target", "elapsedMs", "remainingMs", "intervalMs"];
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) return `unknown wait report field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}`;
  if (typeof value.waitId !== "string" || !WAIT_ID.test(value.waitId)) return "waitId must look like wait_<8–64 letters, digits, _ or ->";
  if (!SESSION_WAIT_KINDS.includes(value.kind as SessionWaitKind)) return `kind must be one of ${SESSION_WAIT_KINDS.join(", ")}`;
  if (value.state !== "active" && value.state !== "ended") return "state must be active or ended";
  const elapsedMs = duration(value.elapsedMs, SESSION_WAIT_MAX_TIMEOUT_MS * 2);
  const remainingMs = duration(value.remainingMs, SESSION_WAIT_MAX_TIMEOUT_MS);
  const intervalMs = duration(value.intervalMs, SESSION_WAIT_MAX_INTERVAL_MS);
  if (elapsedMs === null || remainingMs === null || intervalMs === null) {
    return "elapsedMs, remainingMs and intervalMs must be non-negative whole milliseconds within the wait limits";
  }
  const target = value.target as Record<string, unknown> | null | undefined;
  if (!target || typeof target !== "object" || Array.isArray(target)) return "target must be an object";
  let parsedTarget: SessionWaitReportTarget;
  if (value.kind === "wait_session") {
    if (target.kind !== "session" || Object.keys(target).some((key) => !["kind", "sessionId", "states"].includes(key)) ||
        typeof target.sessionId !== "string" || !SESSION_ID.test(target.sessionId) ||
        !Array.isArray(target.states) || target.states.length === 0 || target.states.length > MAX_TARGET_STATES ||
        target.states.some((state) => typeof state !== "string" || !/^[a-z_]{1,32}$/u.test(state))) {
      return "a wait_session target is {kind: \"session\", sessionId, states: [1–8 session states]}";
    }
    parsedTarget = { kind: "session", sessionId: target.sessionId, states: [...new Set(target.states as string[])] };
  } else {
    if (target.kind !== "pull_request" || Object.keys(target).some((key) => !["kind", "repository", "number"].includes(key)) ||
        typeof target.repository !== "string" || !REPOSITORY.test(target.repository) || target.repository.includes("..") ||
        !Number.isSafeInteger(target.number) || (target.number as number) <= 0) {
      return "a wait_pull_request target is {kind: \"pull_request\", repository, number}";
    }
    parsedTarget = { kind: "pull_request", repository: target.repository, number: target.number as number };
  }
  return {
    waitId: value.waitId, kind: value.kind as SessionWaitKind, state: value.state, target: parsedTarget,
    elapsedMs, remainingMs, intervalMs,
  };
}

/**
 * The waits in progress on each session, kept in memory by the owning control plane. Nothing here
 * survives a control-plane restart, and nothing needs to: the next report of a live call carries
 * its whole description again, and a call that ended meanwhile simply is not reported.
 *
 * A record's health is decided when a report arrives and on each sweep, and projected as stored, so
 * every read between two decisions (lists, detail, live rows) agrees.
 */
export class SessionWaits {
  private readonly bySession = new Map<string, Map<string, WaitRecord>>();

  constructor(private readonly targetStatus: SessionWaitTargetStatus) {}

  /** Apply one report from the session itself. The caller has already checked that the session is
   * busy and may read the watched session. Returns whether the projected waits changed, or why the
   * report is refused. */
  report(sessionId: string, report: SessionWaitReport, now: number, child: () => boolean):
    { changed: boolean } | { error: string; status: number } {
    const waits = this.bySession.get(sessionId);
    const existing = waits?.get(report.waitId);
    if (report.state === "ended") {
      if (!existing) return { changed: false };
      waits!.delete(report.waitId);
      if (waits!.size === 0) this.bySession.delete(sessionId);
      return { changed: true };
    }
    if (existing && (existing.kind !== report.kind || !sameTarget(existing.target, report.target))) {
      return { error: "a wait keeps its kind and target; report a new waitId for a new call", status: 409 };
    }
    if (!existing && (waits?.size ?? 0) >= SESSION_WAIT_LIMIT_PER_SESSION) {
      return { error: `a session tracks at most ${SESSION_WAIT_LIMIT_PER_SESSION} waits at once`, status: 409 };
    }
    const record: WaitRecord = existing ?? {
      waitId: report.waitId, kind: report.kind, target: report.target,
      child: report.target.kind === "session" ? child() : false,
      since: now - report.elapsedMs, deadlineAt: now + report.remainingMs, intervalMs: report.intervalMs,
      lastProgressAt: now, targetReachedSince: null, health: "healthy",
    };
    const before = projectionKey(existing);
    // A call's own timeout is fixed by its first report: a later one never extends the deadline.
    record.lastProgressAt = now;
    if (!existing) {
      const map = waits ?? new Map<string, WaitRecord>();
      map.set(record.waitId, record);
      if (!waits) this.bySession.set(sessionId, map);
    }
    this.classify(record, now);
    return { changed: !existing || before !== projectionKey(record) };
  }

  /** Forget every wait of a session whose turn ended, or that was removed. */
  clear(sessionId: string): boolean {
    return this.bySession.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /** The sessions with any wait, for the sweep's status check. */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }

  /** The session's waits, oldest first, as last classified. */
  views(sessionId: string): SessionWaitView[] | undefined {
    const waits = this.bySession.get(sessionId);
    if (!waits?.size) return undefined;
    return [...waits.values()].sort((a, b) => a.since - b.since || a.waitId.localeCompare(b.waitId)).map((record) => ({
      waitId: record.waitId,
      kind: record.kind,
      target: record.target.kind === "session"
        ? { kind: "session", child: record.child }
        : { kind: "pull_request", repository: record.target.repository, number: record.target.number },
      since: record.since,
      deadlineAt: record.deadlineAt,
      health: record.health,
      ...(record.health === "stalled" ? { stalledReason: record.stalledReason, stalledSince: record.stalledSince } : {}),
    }));
  }

  /** Re-decide every wait's health. Returns the sessions whose projected waits changed. */
  sweep(now: number): string[] {
    const changed: string[] = [];
    for (const [sessionId, waits] of this.bySession) {
      let any = false;
      for (const record of waits.values()) {
        const before = projectionKey(record);
        this.classify(record, now);
        if (before !== projectionKey(record)) any = true;
      }
      if (any) changed.push(sessionId);
    }
    return changed;
  }

  /** The liveness contract (session-waits.ts in the protocol). The first broken part is named. */
  private classify(record: WaitRecord, now: number): void {
    let reason: SessionWaitStallReason | null = null;
    if (record.target.kind === "session") {
      const status = this.targetStatus(record.target.sessionId);
      if (status === null) {
        reason = "target_missing";
      } else if (record.target.states.includes(status)) {
        record.targetReachedSince ??= now;
        if (now - record.targetReachedSince > SESSION_WAIT_TARGET_GRACE_MS) reason = "target_reached";
      } else {
        record.targetReachedSince = null;
      }
    }
    if (!reason && now > record.deadlineAt + SESSION_WAIT_DEADLINE_GRACE_MS) reason = "deadline_passed";
    if (!reason && now > record.lastProgressAt + sessionWaitProgressBoundMs(record.intervalMs)) reason = "progress_lost";
    if (reason) {
      if (record.health !== "stalled") record.stalledSince = now;
      record.health = "stalled";
      record.stalledReason = reason;
    } else {
      record.health = "healthy";
      delete record.stalledReason;
      delete record.stalledSince;
    }
  }
}

function sameTarget(a: SessionWaitReportTarget, b: SessionWaitReportTarget): boolean {
  if (a.kind === "session" && b.kind === "session") {
    return a.sessionId === b.sessionId && a.states.length === b.states.length && a.states.every((state) => b.states.includes(state));
  }
  if (a.kind === "pull_request" && b.kind === "pull_request") return a.repository === b.repository && a.number === b.number;
  return false;
}

/** What a dashboard sees of a record: a change to any of it is broadcast. */
function projectionKey(record: WaitRecord | undefined): string {
  return record ? `${record.health}\u0000${record.stalledReason ?? ""}` : "";
}
