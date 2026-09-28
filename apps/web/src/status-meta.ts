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

export type StatusTone = "info" | "success" | "warning" | "danger" | "neutral";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** The dot pulses. Only work that is actively progressing pulses (§11.1). */
  pulse: boolean;
  /** A hollow dot: the state is not known to be current, because its source is offline. */
  hollow?: boolean;
  /** A shorter visible label for the narrowest surfaces; the full label stays the accessible name. */
  shortLabel?: string;
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
    running: info("Waiting on External Job", { pulse: true, shortLabel: "Job" }),
    continuation_pending: info("Continuation Pending", { pulse: true, shortLabel: "Pending" }),
    orphaned: danger("Background Work Lost", { shortLabel: "Lost" }),
  },
  /**
   * A message the user sent that the agent has not taken yet: the transcript's pending bubbles
   * and the composer's queue. Keys are the wire `PendingPromptState` values, plus the states the
   * queue derives (Pending Delivery, Steering…, Held) and the two failure readings (Not Sent,
   * Cancelled).
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
    cancelled: neutral("Cancelled"),
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
