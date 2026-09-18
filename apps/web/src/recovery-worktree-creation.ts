import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionView,
  SessionWorktreeCreateOperationView,
  SessionWorktreeProgressPhase,
} from "@wollipog/protocol";
import { ApiError, type ApiClient } from "./api.js";

/** The runner's creation phases, grouped into the stages a person recognises. */
const PHASES: Record<SessionWorktreeProgressPhase, { label: string; step: number }> = {
  resolving_remote: { label: "Resolving Remote", step: 1 },
  fetching_remote: { label: "Fetching Remote", step: 1 },
  validating: { label: "Validating Refs", step: 2 },
  materializing: { label: "Creating Worktree", step: 2 },
  reading_setup_config: { label: "Reading Setup Config", step: 3 },
  awaiting_setup_trust: { label: "Awaiting Setup Trust", step: 3 },
  copying_setup_files: { label: "Copying Setup Files", step: 3 },
  running_setup: { label: "Running Setup", step: 3 },
  activating: { label: "Activating Worktree", step: 4 },
};
export const WORKTREE_CREATION_STEPS = 4;

export function worktreeCreationPhase(phase: SessionWorktreeProgressPhase): { label: string; step: number } {
  // A newer runner may report a phase this client predates; show it as the setup stage it most
  // likely belongs to rather than hiding progress entirely.
  return PHASES[phase] ?? { label: "Preparing Worktree", step: 3 };
}

export type RecoveryWorktreeCreation =
  | { status: "creating"; phase?: SessionWorktreeProgressPhase }
  | { status: "failed"; error: string; phase?: SessionWorktreeProgressPhase };

type Coordinates = { branch: string; baseRef?: string };
type Api = Pick<ApiClient, "createSessionWorktreeWithProgress" | "sessionWorktreeOperations" | "session">;
type Step =
  | { kind: "progress"; operation: Extract<SessionWorktreeCreateOperationView, { status: "in_progress" }> }
  | { kind: "completed"; session?: SessionView }
  | { kind: "failed"; id?: string; error: string; phase?: SessionWorktreeProgressPhase };

const POLL_INTERVAL_MS = 1_000;
const ENDED_WITHOUT_RESULT = "Replacement worktree creation ended without a result. " +
  "Check this session's worktrees before trying again.";

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A failed create answers 409 with the terminal operation, which names the phase it stopped in. */
function failureStep(cause: unknown): Step {
  const operation = cause instanceof ApiError
    ? cause.details?.operation as SessionWorktreeCreateOperationView | undefined
    : undefined;
  if (operation?.status === "failed") {
    return { kind: "failed", id: operation.id, error: operation.error, ...(operation.phase ? { phase: operation.phase } : {}) };
  }
  return { kind: "failed", error: (cause as Error).message };
}

function operationStep(operation: SessionWorktreeCreateOperationView | undefined, session?: SessionView): Step {
  if (!operation || operation.status === "completed") return { kind: "completed", ...(session ? { session } : {}) };
  if (operation.status === "in_progress") return { kind: "progress", operation };
  return { kind: "failed", id: operation.id, error: operation.error, ...(operation.phase ? { phase: operation.phase } : {}) };
}

/** Fastify's unmatched-route 404, as opposed to this route refusing an unknown session. */
function missingRoute(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404 && cause.message !== "session not found";
}

/**
 * Drives a replacement-worktree create from the recovery card with phase feedback.
 *
 * The create is acknowledged and then observed through the read-only operations route, which can
 * never start a second create; that is also how a reloaded page rejoins a create already running.
 * Control planes without that route are followed by repeating the exact create coordinates, which
 * joins the running operation. Control planes without progress-aware creates answer the first
 * request synchronously, leaving the phase unknown so the card keeps its plain Creating… state.
 */
export function useRecoveryWorktreeCreation({
  api,
  session,
  onSession,
  sleep = defaultSleep,
}: {
  api: Api;
  session: SessionView;
  onSession: (session: SessionView) => void;
  sleep?: (ms: number) => Promise<void>;
}) {
  const [creation, setCreation] = useState<RecoveryWorktreeCreation | null>(null);
  const runRef = useRef(0);
  // Terminal operations this client has shown but not consumed. The first create request that
  // repeats their coordinates only consumes the stale result, so it is sent once more.
  const shownTerminalRef = useRef(new Set<string>());
  const sessionId = session.id;
  const recoveryId = session.worktreeRecovery?.recoveryId;
  const recoveryIdRef = useRef(recoveryId);
  recoveryIdRef.current = recoveryId;

  const post = useCallback(async (coordinates: Coordinates): Promise<Step> => {
    try {
      const result = await api.createSessionWorktreeWithProgress(sessionId, coordinates);
      return operationStep(result.operation, result.session);
    } catch (cause) {
      return failureStep(cause);
    }
  }, [api, sessionId]);

  const follow = useCallback(async (run: number, coordinates: Coordinates, first: Step) => {
    const live = () => runRef.current === run;
    let step = first;
    let observeByRead = true;
    let lastPhase: SessionWorktreeProgressPhase | undefined;
    while (step.kind === "progress") {
      const { operation } = step;
      lastPhase = operation.phase ?? lastPhase;
      setCreation({ status: "creating", ...(lastPhase ? { phase: lastPhase } : {}) });
      await sleep(POLL_INTERVAL_MS);
      if (!live()) return;
      if (!observeByRead) {
        step = await post(coordinates);
        continue;
      }
      try {
        const { operations } = await api.sessionWorktreeOperations(sessionId);
        const found = operations.find((candidate) => candidate.id === operation.id);
        if (!found) {
          // Expired, superseded by a later selection, or lost with a restarted control plane.
          // The session record is the only remaining authority on what happened.
          const { session: current } = await api.session(sessionId);
          if (!live()) return;
          onSession(current);
          step = current.worktreeRecovery?.recoveryId === recoveryIdRef.current && current.worktreeRecovery
            ? { kind: "failed", error: ENDED_WITHOUT_RESULT, ...(lastPhase ? { phase: lastPhase } : {}) }
            : { kind: "completed" };
          break;
        }
        step = operationStep(found);
        if (step.kind === "failed") shownTerminalRef.current.add(found.id);
      } catch (cause) {
        if (missingRoute(cause)) observeByRead = false;
        // Any other read failure is transient from here; the create itself is bounded server-side.
      }
    }
    if (!live()) return;
    if (step.kind === "completed") {
      if (step.session) onSession(step.session);
      else if (observeByRead) {
        // Completion read from the operations route carries no snapshot; fetch the settled session.
        try {
          const { session: current } = await api.session(sessionId);
          if (live()) onSession(current);
        } catch {
          /* the session stream still delivers the result */
        }
      }
      if (live()) setCreation(null);
      return;
    }
    if (step.kind === "failed") {
      setCreation({
        status: "failed",
        error: step.error,
        ...(step.phase ?? lastPhase ? { phase: step.phase ?? lastPhase } : {}),
      });
    }
  }, [api, onSession, post, sessionId, sleep]);

  const create = useCallback(async (coordinates: Coordinates) => {
    const run = ++runRef.current;
    setCreation({ status: "creating" });
    let step = await post(coordinates);
    if (step.kind !== "progress" && step.id && shownTerminalRef.current.delete(step.id)) {
      // That answer was the already-shown outcome of an earlier attempt, now consumed. Start anew.
      step = await post(coordinates);
    }
    if (runRef.current !== run) return;
    await follow(run, coordinates, step);
  }, [follow, post]);
  const followRef = useRef(follow);
  followRef.current = follow;
  const apiRef = useRef(api);
  apiRef.current = api;

  // A reloaded page, or another device, rejoins a create that is still running and shows an
  // unconsumed failure. Older control planes have no operations route; the card stays idle.
  useEffect(() => {
    if (!recoveryId) return;
    const run = ++runRef.current;
    let cancelled = false;
    void apiRef.current.sessionWorktreeOperations(sessionId).then(({ operations }) => {
      if (cancelled || runRef.current !== run) return;
      const running = operations.find((operation) => operation.status === "in_progress");
      if (running) {
        const coordinates = { branch: running.branch, ...(running.baseRef ? { baseRef: running.baseRef } : {}) };
        void followRef.current(run, coordinates, operationStep(running));
        return;
      }
      const failed = [...operations].reverse().find((operation) => operation.status === "failed");
      if (failed?.status === "failed") {
        shownTerminalRef.current.add(failed.id);
        setCreation({ status: "failed", error: failed.error, ...(failed.phase ? { phase: failed.phase } : {}) });
      }
    }).catch(() => {
      /* older control plane or transient read failure: the card keeps its idle form */
    });
    return () => {
      cancelled = true;
    };
    // Only a new session or incident re-reads; callback identity churn must not restart observation.
  }, [recoveryId, sessionId]);

  // Leaving the session, or a fresh recovery incident, abandons observation and clears the card.
  useEffect(() => () => {
    runRef.current += 1;
    setCreation(null);
  }, [recoveryId, sessionId]);

  return { creation, create };
}
