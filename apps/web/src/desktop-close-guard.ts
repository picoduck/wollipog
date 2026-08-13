import type { SessionStatus } from "@wollipog/protocol";

/**
 * The dashboard's side of §23.1, which is now only the message.
 *
 * The first version had the dashboard COUNT the work and report it to the shell. Review found three
 * bugs that were all the same bug: the dashboard reports the instance the user is LOOKING at, so
 * switching to a remote one made local work invisible; its snapshots exclude archived sessions, so
 * an archived-but-running session and every side chat were invisible too; and a report is
 * asynchronous, so a prompt accepted moments before a close had not arrived yet. Exit kills the
 * LOCAL sidecar and runner, so the local control plane is the only thing that can answer the
 * question exit actually asks — and the shell asks it directly now, at close time.
 *
 * What is left here is the classification, kept because it is the one thing the protocol can drift
 * under: the shell holds the same list in Rust, and the test beside this file checks the two agree
 * and that together they cover every `SessionStatus`.
 */

/**
 * Whether each status has work that dies with the process — as a TOTAL map over `SessionStatus`.
 *
 * A `Record` rather than a list, so adding a status to the protocol fails this build until someone
 * decides which side it falls on. A list would silently classify anything new as "nothing to lose",
 * which is the direction that loses work.
 *
 * `input_required` counts: the turn is open and waiting on a person, and killing the runner
 * discards it exactly as it discards a running one. `idle` does not — the agent is up but between
 * turns, and warning about it would train the user to dismiss a warning that is usually wrong.
 */
export const WORK_IN_FLIGHT: Readonly<Record<SessionStatus, boolean>> = {
  queued: true,
  starting: true,
  running: true,
  input_required: true,
  idle: false,
  completed: false,
  failed: false,
  stopped: false,
};

/** The statuses the shell must treat as work in flight. */
export const WORK_IN_FLIGHT_STATUSES: readonly SessionStatus[] =
  (Object.keys(WORK_IN_FLIGHT) as SessionStatus[]).filter((status) => WORK_IN_FLIGHT[status]);
