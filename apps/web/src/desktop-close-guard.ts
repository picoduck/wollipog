import type { PendingApproval, SessionStatus } from "@wollipog/protocol";

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

/** A session the close confirmation can name, as the loaded local instance holds it. */
export interface CloseGuardSession {
  title: string;
  status: SessionStatus;
  /** The shell counts a session with a pending approval as working whatever its status, so the row
   * has to be able to say that is why it is listed (#2057). */
  pendingApproval: PendingApproval | null;
}

/**
 * What the close confirmation can learn about, and do with, the local instance (#1965).
 *
 * The guard is mounted above the instance boundary, so it cannot read the store or the instance
 * manager itself. The parts of the app that hold them provide these while they are mounted, and a
 * missing part is simply absent: with no local instance open there are no titles, and the
 * confirmation shows its count sentence alone.
 */
export interface CloseGuardLinkParts {
  /** A loaded session of the LOCAL instance, or null. Provided only while that instance is open in
   * the window, so a title is never guessed from another instance. */
  session?: (id: string) => CloseGuardSession | null;
  /** Open Sessions for the local instance, switching to it if another is open. */
  showSessions?: () => void;
}

export interface CloseGuardLinks {
  /** Provide some parts until the returned function is called. A later provider wins while it lasts. */
  provide(parts: CloseGuardLinkParts): () => void;
  current(): CloseGuardLinkParts;
}

export function createCloseGuardLinks(): CloseGuardLinks {
  const providers: CloseGuardLinkParts[] = [];
  return {
    provide(parts) {
      providers.push(parts);
      return () => {
        const index = providers.indexOf(parts);
        if (index >= 0) providers.splice(index, 1);
      };
    },
    current() {
      const merged: CloseGuardLinkParts = {};
      for (const parts of providers) {
        if (parts.session) merged.session = parts.session;
        if (parts.showSessions) merged.showSessions = parts.showSessions;
      }
      return merged;
    },
  };
}

/** The app's links, provided by the local instance's store and the desktop instance manager. */
export const closeGuardLinks = createCloseGuardLinks();
