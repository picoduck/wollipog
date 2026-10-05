/**
 * The one status vocabulary (docs/design-system.md §11.2).
 *
 * Every status the app shows gets its label, tone and pulse from here, so one condition carries one
 * name on every surface. Before this map each panel kept its own label table, so lost work carried
 * three different names depending on where it was shown, and an offline worker a fourth. Labels are
 * Title Case in the copy; the `.status` recipe never transforms them.
 *
 * Keys are the wire values wherever a wire value exists, so callers pass the value they hold.
 * Values that have no wire form (a Stop waiting for an offline runner, a quarantined session) are
 * derived by the caller and named here.
 */

import {
  isTerminal,
  sessionAttentionBreakdown,
  sessionAttentionStatus,
  type ArchiveOperationView,
  type ArchiveStatus,
  type BackgroundDeliveryView,
  type SessionAttentionKind,
  type SessionStatus,
  type SessionView,
  type StopOperationView,
} from "@wollipog/protocol";
import { BACKGROUND_DELIVERY_STATUS, backgroundDeliveryNeedsYou, shownWatchdogDelivery } from "./background-delivery-status.js";

export type StatusTone = "info" | "success" | "warning" | "danger" | "neutral";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** The dot pulses. Only work that is actively progressing pulses (§11.1). */
  pulse: boolean;
  /** A hollow dot: the state is not known to be current, because its source is offline. */
  hollow?: boolean;
  /** Other words a search should match for this value, such as the server's own labels. */
  aliases?: readonly string[];
}

type Entry = Omit<StatusMeta, "pulse"> & { pulse?: boolean };

const neutral = (label: string, extra: Partial<Entry> = {}): Entry => ({ label, tone: "neutral", ...extra });
const info = (label: string, extra: Partial<Entry> = {}): Entry => ({ label, tone: "info", ...extra });
const success = (label: string, extra: Partial<Entry> = {}): Entry => ({ label, tone: "success", ...extra });
const warning = (label: string, extra: Partial<Entry> = {}): Entry => ({ label, tone: "warning", ...extra });
const danger = (label: string, extra: Partial<Entry> = {}): Entry => ({ label, tone: "danger", ...extra });

const VOCABULARY = {
  /** What the session needs from the user. Attention outranks lifecycle on every surface. */
  attention: {
    approval_required: warning("Approval Required"),
    answer_required: warning("Answer Required"),
    authentication_required: warning("Authentication Required"),
    account_required: warning("Account Required"),
    input_required: warning("Needs Your Input"),
    recovery_required: danger("Recovery Required"),
  },
  /** Session lifecycle, including the Stop and quarantine states derived beside it. */
  session: {
    queued: neutral("Queued"),
    starting: info("Starting", { pulse: true }),
    running: info("Running", { pulse: true }),
    stopping: info("Stopping", { pulse: true }),
    input_required: warning("Awaiting Input", { aliases: ["Input Required"] }),
    idle: neutral("Awaiting Prompt", { aliases: ["Idle"] }),
    stalled: danger("Stalled"),
    failed: danger("Failed"),
    completed: success("Completed"),
    stopped: neutral("Stopped"),
    archived: neutral("Archived"),
    snoozed: neutral("Snoozed"),
    quarantined: danger("Quarantined"),
    /** The Stop is being delivered to a connected runner. */
    stop_pending: info("Stop Pending", { pulse: true }),
    /** The Stop is still pending, but its runner is offline: nothing is progressing until it
     * reconnects, and runtime capacity may still be held (#208). */
    stop_waiting_for_runner: neutral("Stop Waiting for Runner"),
    stop_failed: danger("Stop Failed"),
  },
  /** Machines, control-plane instances and paired devices. */
  machine: {
    online: success("Online"),
    connecting: info("Connecting"),
    offline: neutral("Offline", { hollow: true }),
    saved: neutral("Saved"),
    bootstrapping: info("Bootstrapping", { pulse: true }),
    deploying: info("Deploying Runner", { pulse: true }),
    update_required: warning("Update Required"),
    sign_in_required: warning("Sign-In Required"),
    pairing_required: warning("Pairing Required"),
    unreachable: danger("Unreachable"),
    error: danger("Error"),
    failed: danger("Failed"),
  },
  /** A project location's reachability on its machine. */
  project_location: {
    available: success("Available"),
    runner_offline: warning("Runner Offline"),
    workspace_missing: warning("Workspace Missing"),
    runner_removed: danger("Runner Removed"),
  },
  /** One skill deployed to one machine. */
  skill: {
    linked: success("Linked"),
    pending: neutral("Pending"),
    edited: warning("Edited"),
    /** A Git or built-in update waits for review before it becomes the library's version. */
    update_held: warning("Update Held"),
    conflict: warning("Conflict"),
    error: danger("Error"),
    offline: neutral("Offline", { hollow: true }),
  },
  /** Automations, their runs and outbound event subscriptions. */
  automation: {
    enabled: success("Enabled"),
    paused: neutral("Paused"),
    running: info("Running", { pulse: true }),
    failed: danger("Failed"),
    target_unavailable: warning("Target Unavailable"),
  },
  tool: {
    pending: neutral("Pending"),
    running: info("Running", { pulse: true }),
    completed: success("Completed"),
    failed: danger("Failed"),
  },
  /** The rollup chip on a session family. Its visible label carries the count. */
  family: {
    awaiting_input: warning("Awaiting Input"),
    idle: neutral("Idle"),
  },
  /** A subagent, worker or managed background job. */
  job: {
    queued: neutral("Queued"),
    starting: info("Starting", { pulse: true }),
    running: info("Running", { pulse: true }),
    working: info("Working", { pulse: true }),
    waiting: neutral("Waiting"),
    input_required: warning("Input Required"),
    stalled: warning("Stalled"),
    completed: success("Completed"),
    failed: danger("Failed"),
    canceled: neutral("Canceled"),
    killed: danger("Killed"),
    stopped: neutral("Stopped"),
    interrupted: neutral("Interrupted"),
    unverified: neutral("Unverified", { hollow: true }),
    lost: danger("Lost"),
    result_missing: warning("Result Missing"),
    unknown: neutral("Unknown"),
  },
  /** A session's aggregate background work, as its header shows it. */
  background_work: {
    running: info("Waiting on External Job", { pulse: true }),
    continuation_pending: info("Continuation Pending", { pulse: true }),
    orphaned: danger("Background Work Lost"),
  },
  /**
   * A message the user sent that the agent has not taken yet: the transcript's pending bubbles
   * and the composer's queue. Keys are the wire `PendingPromptState` values, plus the states the
   * queue derives (Pending Delivery, Steering…, Held) and the two failure readings (Not Sent,
   * Canceled).
   */
  queuedMessage: {
    pending: neutral("Pending"),
    sent: info("Sending", { pulse: true }),
    accepted: info("Accepted"),
    queued: neutral("Queued"),
    started: info("Starting", { pulse: true }),
    pending_delivery: info("Pending Delivery"),
    steering: info("Steering…", { pulse: true }),
    held: warning("Held"),
    uncertain: warning("Delivery Uncertain"),
    failed: danger("Delivery Failed"),
    not_sent: danger("Not Sent"),
    cancelled: neutral("Canceled"),
  },
  /** What happened to a message after it was sent: the one receipt line under its row in the
   * transcript (#2171). Sending has no badge (a spinner and the word), so it does not pulse here. */
  messageReceipt: {
    sending: info("Sending"),
    queued: neutral("Queued"),
    delivered: success("Delivered"),
    steered: success("Steered the Current Turn"),
    uncertain: warning("Delivery Uncertain"),
    failed: danger("Delivery Failed"),
    not_sent: danger("Not Sent"),
    not_accepted: danger("Not Accepted"),
    rejected: danger("Rejected"),
    rename_failed: danger("Rename Failed"),
    cancelled: neutral("Canceled"),
    dismissed: neutral("Dismissed"),
  },
  /** Delivery receipts: a background result returning, or a push notification. */
  delivery: {
    delivered: success("Delivered"),
    delivery_failed: danger("Delivery Failed"),
    pending: neutral("Delivery Pending"),
  },
  /** A background result's push notification receipt. */
  notification: {
    pending: neutral("Push Pending"),
    retry: neutral("Push Retry Pending"),
    service_accepted: success("Push Service Accepted"),
    shown: success("Notification Displayed"),
    clicked: success("Notification Clicked"),
    permanent_failure: danger("Push Failed"),
    expired: danger("Push Expired"),
  },
  /**
   * How a request ended, in the past tense (#2204): the outcome word of every Decision Record (a
   * permission, a governance decision, an automated review) and of the answered-question row. Never
   * a provider's option id.
   */
  requestDecision: {
    allowed: success("Allowed"),
    answered: success("Answered"),
    answered_by_policy: success("Answered by Policy"),
    answered_by_parent: success("Answered by Parent"),
    /** A sign-in request the runner settled itself when the account recovered. */
    rechecked_automatically: success("Rechecked Automatically"),
    rejected: neutral("Rejected"),
    dismissed: neutral("Dismissed"),
    dismissed_by_parent: neutral("Dismissed by Parent"),
    /** The request was cancelled, or the approval aborted before it could finish. */
    ended_early: neutral("Ended Early"),
    replaced: neutral("Replaced"),
    expired: neutral("Expired"),
    provider_resolved: neutral("Resolved by Provider"),
    another_account_selected: neutral("Another Account Selected"),
    /** An automated reviewer handed the request to a person. */
    escalated: neutral("Escalated"),
    /** A chosen option whose kind says neither allow nor reject. */
    resolved: neutral("Resolved"),
    /** Denied by a policy, or fail-closed by Wollipog. */
    blocked: danger("Blocked"),
    timed_out: warning("Timed Out"),
  },
  /** A workflow gate, a run decision, and the run itself. */
  workflow: {
    awaiting_decision: warning("Awaiting Decision"),
    approved: success("Approved"),
    rejected: neutral("Rejected"),
    queued: neutral("Queued"),
    running: info("Running", { pulse: true }),
    waiting_gate: warning("Awaiting Decision"),
    succeeded: success("Succeeded"),
    failed: danger("Failed"),
    stopped: neutral("Stopped"),
  },
  pod: {
    active: info("Active"),
    paused: neutral("Paused"),
    conflicted: warning("Conflicted"),
    failed: danger("Failed"),
    closed: neutral("Closed"),
    /** Pod orchestration and reconciliation. */
    idle: neutral("Idle"),
    ready: neutral("Ready"),
    running: info("Running", { pulse: true }),
    stopped: neutral("Stopped"),
  },
  /** One work item in an issue campaign's ledger (Campaign Status, #2417). */
  campaignWork: {
    planned: neutral("Planned"),
    queued: neutral("Queued"),
    running: info("Running", { pulse: true }),
    waiting: warning("Waiting"),
    blocked: danger("Blocked"),
    delivered: success("Delivered"),
    cancelled: neutral("Canceled"),
    removed: neutral("Scope Removed"),
  },
  /** An organization member's account (People & Devices). */
  member: {
    active: success("Active"),
    suspended: danger("Suspended"),
  },
  provider_account: {
    signed_in: success("Signed In"),
    sign_in_required: warning("Sign-In Required"),
    signed_out: neutral("Signed Out"),
  },
  /** A transcript share link (Share Transcript, #2148). */
  share: {
    active: success("Active"),
    expired: neutral("Expired"),
    revoked: neutral("Revoked"),
  },
  /** A provider's subscription usage. */
  usage: {
    available: success("Available"),
    approaching_limit: warning("Approaching Limit"),
    temporarily_unavailable: danger("Temporarily Unavailable"),
    exhausted: danger("Exhausted"),
    limit_reached: danger("Limit Reached"),
    stale: warning("Last Known — Stale"),
    unsupported: neutral("Unsupported"),
    sign_in_required: warning("Sign-In Required"),
    not_applicable: neutral("Not Applicable"),
  },
} as const satisfies Record<string, Record<string, Entry>>;

export type StatusDomain = keyof typeof VOCABULARY;
export type StatusValue<D extends StatusDomain> = keyof (typeof VOCABULARY)[D] & string;

const UNAVAILABLE: StatusMeta = { label: "Status Unavailable", tone: "neutral", pulse: false };

/** The label, tone and pulse for one value of one status domain. An unknown value (a newer server's
 * state this client does not know) reads "Status Unavailable" rather than its raw enum. */
export function statusMeta<D extends StatusDomain>(domain: D, value: StatusValue<D>): StatusMeta;
export function statusMeta(domain: StatusDomain, value: string): StatusMeta;
export function statusMeta(domain: StatusDomain, value: string): StatusMeta {
  const table = VOCABULARY[domain] as Record<string, Entry>;
  if (!Object.hasOwn(table, value)) return UNAVAILABLE;
  const entry = table[value]!;
  return { ...entry, pulse: entry.pulse ?? false };
}

/** A tool call's wire status on the tool vocabulary: providers report a running call as
 * `in_progress`. */
export function toolStatusMeta(status: string): StatusMeta {
  return statusMeta("tool", status === "in_progress" ? "running" : status);
}

/** Every value of a domain, in vocabulary order. */
export function statusValues<D extends StatusDomain>(domain: D): StatusValue<D>[] {
  return Object.keys(VOCABULARY[domain]) as StatusValue<D>[];
}

/**
 * The lifecycle a session's badge shows. A Stop operation outranks the provider lifecycle it is
 * stopping; a quarantined conversation outranks "Awaiting Prompt".
 *
 * A pending Stop whose runner is offline is not being delivered: the operation stays pending (so
 * runtime capacity may still be held) but nothing is progressing until the runner reconnects, so it
 * reads "Stop Waiting for Runner" without a pulse rather than the pulsing "Stop Pending" (#208).
 * `runnerOnline` defaults to true so a surface that cannot see the runner keeps the conservative
 * delivery wording.
 */
export function sessionLifecycleMeta(
  status: SessionStatus,
  options: {
    archiveStatus?: ArchiveStatus;
    archiveOperation?: ArchiveOperationView;
    stopOperation?: StopOperationView;
    historyQuarantine?: SessionView["historyQuarantine"];
    runnerOnline?: boolean;
  } = {},
): StatusMeta {
  const operation = options.stopOperation ?? options.archiveOperation;
  const operationStatus = operation?.status ?? options.archiveStatus;
  if (operationStatus === "stop_pending") {
    return statusMeta("session", options.runnerOnline === false ? "stop_waiting_for_runner" : "stop_pending");
  }
  if (operationStatus === "stop_failed") return statusMeta("session", "stop_failed");
  return quarantinedStatusMeta(status, options.historyQuarantine) ?? statusMeta("session", status);
}

/**
 * An archived session that has stopped, with no Stop in progress or failed: the Session bar's
 * lifecycle reads Archived and the notice slot offers Unarchive (#2202). A Stop Pending or Stop
 * Failed archive keeps that status and its Stop recovery. An archived session that is still running
 * (an older control plane archived without stopping it) keeps its lifecycle, since Archived would
 * hide the running agent.
 */
export function sessionArchivedAtRest(
  session: Pick<SessionView, "status"> &
    Partial<Pick<SessionView, "archived" | "archiveStatus" | "archiveOperation" | "stopOperation">>,
): boolean {
  if (!session.archived || !isTerminal(session.status)) return false;
  const operationStatus = (session.stopOperation ?? session.archiveOperation)?.status ?? session.archiveStatus;
  return operationStatus !== "stop_pending" && operationStatus !== "stop_failed";
}

/** A quarantined conversation is idle only in the sense that nothing is running. It can never
 * accept another prompt, so "Awaiting Prompt" would invite exactly the retry that cannot work. */
export function quarantinedStatusMeta(
  status: SessionStatus,
  historyQuarantine: SessionView["historyQuarantine"],
): StatusMeta | null {
  if (!historyQuarantine || status === "completed" || status === "failed" || status === "stopped") return null;
  return statusMeta("session", "quarantined");
}

/** What one condition of a session is, so a surface can attach the action that resolves it. */
export type SessionConditionKind =
  /** One attention kind (`sessionAttentionBreakdown()`): a request the person answers. */
  | "attention"
  /** Human-owned campaign requests, listed in the Requests panel. */
  | "campaign_requests"
  /** Unresolved requests of descendant sessions, listed in the Requests panel. */
  | "descendant_requests"
  /** Campaign requests assigned to the Orchestrator rather than to the person. */
  | "orchestrator_requests"
  /** The session's aggregate background work: Lost, Waiting on External Job, Continuation Pending. */
  | "background_work"
  /** A background result that has not come back to the conversation. */
  | "background_delivery"
  /** The session's machine is offline. */
  | "disconnected"
  /** Live workers. */
  | "workers"
  /** Why a queued session is waiting: capacity, or a worktree or account handoff. */
  | "queue_reason"
  /** The session lifecycle, including Stop Pending and Stop Failed. */
  | "lifecycle";

/** One condition a session is in, as the Session Status control and its popover show it. */
export interface SessionCondition {
  kind: SessionConditionKind;
  /** Label, tone and pulse. The label is the badge's text; a count is in the label or in `count`. */
  meta: StatusMeta;
  /** One sentence saying what the condition means. */
  description: string;
  /** The person must act on it. Only these count toward "+N". */
  needsYou: boolean;
  /** Requests behind the condition, where it stands for several. */
  count?: number;
  /** For an attention condition, which kind of request it is. */
  attentionKind?: SessionAttentionKind;
  /** For a background delivery, the delivery whose watchdog state it shows. */
  delivery?: BackgroundDeliveryView;
  /** A fact rather than a state (§11.2): listed as a plain row, never drawn as a badge. */
  fact?: boolean;
}

/** The session's one status, the number of other things that need the person, and every condition. */
export interface SessionStatusSummary {
  /** The one badge a surface shows for the session. Always `conditions[0]`. */
  primary: SessionCondition;
  /** How many OTHER conditions need the person: the "+N". Never counts passive states. */
  more: number;
  /** Every condition, in rank order, for the Session Status popover. The lifecycle is listed only
   * when nothing needs the person. */
  conditions: SessionCondition[];
}

/** What a surface knows about a session beyond the session record itself. */
export interface SessionStatusContext {
  /** The session's machine is connected. Unknown counts as connected; only offline is Disconnected. */
  runnerOnline?: boolean;
  /** Unresolved requests of descendant sessions (the Requests panel's count). */
  descendantRequests?: number;
  /** Live workers (the Agents panel's count). */
  activeWorkers?: number;
}

/** The session fields the ranking reads. */
export type SessionStatusSource = Pick<SessionView, "status" | "pendingApproval" | "attentionOwners"> &
  Partial<Pick<SessionView, "orchestratorCampaign" | "pendingRequestOwners" | "archived" |
    "archiveStatus" | "archiveOperation" | "stopOperation" | "historyQuarantine" | "capacityWait" |
    "queueHold" | "holds" | "backgroundWorkState" | "backgroundDeliveries">>;

const LIFECYCLE_DESCRIPTIONS: Partial<Record<StatusValue<"session">, string>> = {
  queued: "The session is waiting for a slot to start.",
  starting: "The agent is starting.",
  running: "The agent is working on its turn.",
  stopping: "The agent is stopping.",
  input_required: "The agent is waiting for your input.",
  idle: "The agent finished its turn and is waiting for your next prompt.",
  stalled: "The agent stopped reporting progress.",
  failed: "The session ended with an error.",
  completed: "The session finished.",
  stopped: "The session was stopped.",
  quarantined: "This conversation's history is quarantined, so it cannot take another prompt.",
  stop_pending: "A Stop is being delivered to the session's machine.",
  stop_waiting_for_runner: "A Stop is waiting for the session's machine to reconnect, so the session may still be running.",
  stop_failed: "The Stop failed, so the session may still be running.",
  archived: "This session is archived and stopped.",
};

/** The sentence a session's status details show for one lifecycle value. */
export function sessionLifecycleDescription(value: StatusValue<"session"> | undefined): string {
  return (value && LIFECYCLE_DESCRIPTIONS[value]) ?? "The session's current state.";
}

function lifecycleDescription(meta: StatusMeta): string {
  return sessionLifecycleDescription(statusValues("session").find((candidate) => statusMeta("session", candidate).label === meta.label));
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The short name of why a queued session is waiting for capacity. */
export function queueReasonLabel(kind: NonNullable<SessionView["capacityWait"]>["kind"]): string {
  return kind === "runner_capacity"
    ? "Runner Capacity"
    : kind === "agent_quota"
      ? "Agent Quota"
      : kind === "target_quota"
        ? "Target Quota"
        : kind === "exclusive_group"
          ? "Provider Slot"
          : kind === "request_weight"
            ? "Agent Weight"
            : kind === "active_turn_capacity"
              ? "Active Turn Capacity"
              : kind === "capacity_lock"
                ? "Capacity Sync"
                : "Queue Order";
}

/**
 * Which one status a session shows, and how many other things need the person (#2182). The Session
 * bar, and later the Sessions rows, the preview bar and the Board cards, all choose their badge here.
 *
 * The badge is the first of these that applies:
 * 1. What needs the person: each attention kind in `sessionAttentionBreakdown()` order (the Sessions
 *    list's priority), then human-owned campaign requests, then descendant requests, then a
 *    background result that is blocked or missing (Result Blocked, Result Missing; #2275).
 * 2. Background Work Lost.
 * 3. Disconnected, when the session's machine is offline.
 * 4. Waiting on External Job (or Continuation Pending) while the session is otherwise awaiting its
 *    next prompt, so running background work stays visible at a glance (#784).
 * 5. The lifecycle, including Stop Pending and Stop Failed, and Archived for an archived session at
 *    rest (`sessionArchivedAtRest()`).
 *
 * `more` counts the other conditions in rule 1, never a passive state, so "+N" is the same at every
 * width. `conditions` lists everything in that order for the popover, followed by the passive rows
 * (background work while the agent is busy, a result still on its way back, workers, Orchestrator
 * requests and queue reasons).
 */
export function sessionStatusSummary(
  session: SessionStatusSource,
  context: SessionStatusContext = {},
): SessionStatusSummary {
  const runnerOnline = context.runnerOnline ?? true;
  const needs: SessionCondition[] = [];
  const humanCampaignRequests = session.orchestratorCampaign?.pendingRequests?.human ?? 0;
  const groups = sessionAttentionBreakdown(session)
    // With no request of the person's own, the breakdown falls back to the campaign's "Needs Your
    // Input", which is the campaign-request condition below.
    .filter((group) => !(group.count === 0 && humanCampaignRequests > 0));
  // The badge says the kind, which is what a glance needs; a single request's sentence names the
  // worker that owns it ("Audit · Reviewer owns this request…"), which would not fit in a badge.
  const single = groups.length === 1 && groups[0]!.count <= 1 ? sessionAttentionStatus(session) : null;
  for (const group of groups) {
    needs.push({
      kind: "attention",
      meta: { ...statusMeta("attention", group.kind), label: group.label },
      description: (single ?? group).description,
      needsYou: true,
      count: group.count > 1 ? group.count : undefined,
      attentionKind: group.kind,
    });
  }
  if (humanCampaignRequests > 0) {
    needs.push({
      kind: "campaign_requests",
      meta: statusMeta("attention", "input_required"),
      description: `${humanCampaignRequests} human-owned campaign ${plural(humanCampaignRequests, "request needs", "requests need")} your input.`,
      needsYou: true,
      count: humanCampaignRequests,
    });
  }
  // A campaign's request counts already include its descendants' requests.
  const descendantRequests = context.descendantRequests ?? 0;
  if (descendantRequests > 0 && !session.orchestratorCampaign?.pendingRequests) {
    needs.push({
      kind: "descendant_requests",
      meta: { label: "Descendant Requests", tone: "warning", pulse: false },
      description: `${descendantRequests} ${plural(descendantRequests, "request from a descendant session is", "requests from descendant sessions are")} unresolved.`,
      needsYou: true,
      count: descendantRequests,
    });
  }

  // A result that is blocked or missing does not progress on its own and asks the person for a step
  // (#2275), so it ranks after their requests; a result still on its way back stays passive. Where a
  // session has several, the one that needs the person is the one shown.
  const watched = shownWatchdogDelivery(session.backgroundDeliveries);
  const deliveryState = watched?.watchdogState;
  const delivery: SessionCondition | null = watched && deliveryState ? {
    kind: "background_delivery",
    meta: {
      label: BACKGROUND_DELIVERY_STATUS[deliveryState].label,
      tone: backgroundDeliveryNeedsYou(deliveryState) ? "warning" : "info",
      pulse: false,
    },
    description: BACKGROUND_DELIVERY_STATUS[deliveryState].description,
    needsYou: backgroundDeliveryNeedsYou(deliveryState),
    delivery: watched,
  } : null;
  if (delivery?.needsYou) needs.push(delivery);

  const lifecycle = sessionArchivedAtRest(session) ? statusMeta("session", "archived") : sessionLifecycleMeta(session.status, {
    archiveStatus: session.archiveStatus,
    archiveOperation: session.archiveOperation,
    stopOperation: session.stopOperation,
    historyQuarantine: session.historyQuarantine,
    runnerOnline,
  });
  const backgroundState = session.backgroundWorkState === "resumed" ? undefined : session.backgroundWorkState;
  const background: SessionCondition | null = backgroundState ? {
    kind: "background_work",
    meta: statusMeta("background_work", backgroundState),
    description: backgroundState === "orphaned"
      ? "Managed background work was lost and will not return its result."
      : backgroundState === "running"
        ? "A background job is still running, and its result returns to this conversation when it finishes."
        : "A background job finished, and the conversation continues with its result.",
    needsYou: false,
  } : null;
  const lost = backgroundState === "orphaned" ? background : null;
  const disconnected: SessionCondition | null = runnerOnline ? null : {
    kind: "disconnected",
    meta: { label: "Disconnected", tone: "danger", pulse: false },
    description: "The session's machine is offline, so its status may not be current.",
    needsYou: false,
  };
  const awaitingPrompt = lifecycle.label === statusMeta("session", "idle").label;
  const waiting = !lost && awaitingPrompt ? background : null;

  const conditions: SessionCondition[] = [...needs];
  if (lost) conditions.push(lost);
  if (disconnected) conditions.push(disconnected);
  if (waiting) conditions.push(waiting);
  if (needs.length === 0) {
    conditions.push({ kind: "lifecycle", meta: lifecycle, description: lifecycleDescription(lifecycle), needsYou: false });
  }
  if (background && background !== lost && background !== waiting) conditions.push(background);
  if (delivery && !delivery.needsYou) conditions.push(delivery);
  const workers = context.activeWorkers ?? 0;
  if (workers > 0) {
    conditions.push({
      kind: "workers",
      meta: { label: `${workers} ${plural(workers, "Worker", "Workers")}`, tone: "info", pulse: true },
      description: `${workers} ${plural(workers, "worker is", "workers are")} running for this session.`,
      needsYou: false,
    });
  }
  const orchestratorRequests = session.orchestratorCampaign?.pendingRequests?.orchestrator ?? 0;
  if (orchestratorRequests > 0) {
    conditions.push({
      kind: "orchestrator_requests",
      meta: { label: "Orchestrator Action", tone: "neutral", pulse: false },
      description: `The Orchestrator has ${orchestratorRequests} descendant ${plural(orchestratorRequests, "request", "requests")} assigned to it.`,
      needsYou: false,
      count: orchestratorRequests,
    });
  }
  if (session.status === "queued" && session.capacityWait) {
    conditions.push({
      kind: "queue_reason",
      meta: { label: queueReasonLabel(session.capacityWait.kind), tone: "neutral", pulse: false },
      description: session.capacityWait.description,
      needsYou: false,
      fact: true,
    });
  } else if (session.status === "queued" && session.queueHold) {
    const reason = session.holds?.find((hold) => hold.holdId === session.queueHold?.holdId)?.reason;
    conditions.push({
      kind: "queue_reason",
      meta: {
        label: session.queueHold.kind === "worktree_rebind" ? "Worktree Handoff" : "Account Handoff",
        tone: "neutral",
        pulse: false,
      },
      description: reason ?? "A handoff is waiting on background work.",
      needsYou: false,
      fact: true,
    });
  }
  return { primary: conditions[0]!, more: Math.max(0, needs.length - 1), conditions };
}
