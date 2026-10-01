import { useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import type { SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { missingResultContinuationId, requestMissingResultAcknowledgement } from "../background-delivery-status.js";
import {
  STOP_JOB_ALREADY_ENDED,
  STOP_JOB_OUTCOME,
  blockedDeliveryStopTarget,
  requestBackgroundJobStop,
  type BlockedDeliveryStopTarget,
} from "../background-job-stop.js";
import { useInstanceScope } from "../instance-scope.js";
import type { SessionCondition } from "../status-meta.js";
import { useFeedback } from "./FeedbackProvider.js";
import type { SessionStatusStep } from "./SessionStatusButton.js";

/** `confirming`: Stop Job's confirmation is open. `pending`: the request is in flight. `done`: it
 * succeeded and the session update that clears the row is on its way. */
type StepState = "confirming" | "pending" | "done";

interface StepInputs {
  session: SessionView;
  condition: SessionCondition | undefined;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
}

/**
 * Steps by instance, session, action and target. They live at module scope rather than in the
 * header: leaving the session and coming back remounts the header while a request is still in
 * flight, and the row must still read busy and refuse a second request. An entry is set
 * synchronously, before React commits, so two presses in one batch also take the step once.
 *
 * Only a step in progress outlives its headers. A `done` entry is dropped once the row no longer
 * offers that step (the session update arrived) or once no header shows the session, so the store
 * holds the steps in flight plus those of the sessions on screen.
 */
const steps = new Map<string, { state: StepState; sessionKey: string }>();
/** The current inputs of each session a mounted header shows, so a confirmation that resolves later
 * checks its target against the session as it is then. Dropped with the session's last header. */
const latestInputs = new Map<string, StepInputs>();
/** How many mounted headers show each session. */
const owners = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

function setStep(key: string, sessionKey: string, state: StepState | null) {
  // A step that finishes while no header shows its session has no row to hold back.
  if (state && !(state === "done" && !owners.has(sessionKey))) steps.set(key, { state, sessionKey });
  else steps.delete(key);
  notify();
}

/** Drops this session's finished steps, except the one its row still offers. */
function pruneDone(sessionKey: string, offeredKey: string | null) {
  let pruned = false;
  for (const [key, entry] of steps) {
    if (entry.sessionKey === sessionKey && entry.state === "done" && key !== offeredKey) {
      steps.delete(key);
      pruned = true;
    }
  }
  if (pruned) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: how much the module holds. */
export function backgroundDeliveryStepRetention(): { steps: number; inputs: number } {
  return { steps: steps.size, inputs: latestInputs.size };
}

/** For tests: forget every step. */
export function resetBackgroundDeliverySteps() {
  steps.clear();
  latestInputs.clear();
  owners.clear();
  version += 1;
}

type Offer =
  | { kind: "acknowledge"; key: string; continuationId: string }
  | { kind: "stop"; key: string; target: BlockedDeliveryStopTarget };

/** The step this session's row offers, whatever its state. */
function offeredStep(instanceScope: string, inputs: StepInputs): Offer | null {
  const { session, condition, runnerOnline, runnerProtocolVersion } = inputs;
  const delivery = condition?.needsYou ? condition.delivery : undefined;
  if (!delivery) return null;
  const continuationId = missingResultContinuationId(delivery);
  if (continuationId) {
    return { kind: "acknowledge", key: JSON.stringify([instanceScope, session.id, "acknowledge", continuationId]), continuationId };
  }
  const target = blockedDeliveryStopTarget(session, delivery, runnerProtocolVersion, runnerOnline);
  return target ? { kind: "stop", key: JSON.stringify([instanceScope, session.id, "stop", target.jobId]), target } : null;
}

/**
 * The step the Session Status popover's Result Blocked or Result Missing row takes itself (#2275),
 * with the Background Work panel's requests and copy: Stop Job… for the one job still blocking the
 * result, behind the same danger confirmation, and Acknowledge Missing Result, which asks nothing
 * first, as in the panel. `undefined` where neither applies, so the row opens Background Work.
 *
 * Reopened while the request runs, the row shows it busy and refuses a second press. A step that
 * succeeded is not offered again while the session update is on its way, and a failure is an error
 * toast that leaves the row and its step in place. Stop Job checks its target again once confirmed,
 * against the session as a mounted header shows it then; if the target changed, or no header shows
 * the session any more, nothing is stopped.
 */
export function useBackgroundDeliveryStep({
  session,
  condition,
  runnerOnline,
  runnerProtocolVersion,
  returnFocusRef,
}: StepInputs & {
  /** The Session Status control, where focus returns after the confirmation. */
  returnFocusRef: RefObject<HTMLElement | null>;
}): SessionStatusStep | undefined {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const { confirm, showToast } = useFeedback();
  useSyncExternalStore(subscribe, () => version);
  const sessionKey = JSON.stringify([instanceScope, session.id]);
  const inputs: StepInputs = { session, condition, runnerOnline, runnerProtocolVersion };
  const offer = offeredStep(instanceScope, inputs);

  // Cleanups run before setups, so a header that switches sessions releases the old one first.
  useLayoutEffect(() => {
    owners.set(sessionKey, (owners.get(sessionKey) ?? 0) + 1);
    return () => {
      const remaining = (owners.get(sessionKey) ?? 1) - 1;
      if (remaining > 0) {
        owners.set(sessionKey, remaining);
        return;
      }
      owners.delete(sessionKey);
      latestInputs.delete(sessionKey);
      pruneDone(sessionKey, null);
    };
  }, [sessionKey]);
  useLayoutEffect(() => {
    latestInputs.set(sessionKey, inputs);
    pruneDone(sessionKey, offer?.key ?? null);
  });

  if (!offer) return undefined;
  const sessionId = session.id;
  const { key } = offer;
  const state = steps.get(key)?.state;
  if (state === "done") return undefined;

  if (offer.kind === "acknowledge") {
    const { continuationId } = offer;
    return {
      label: "Acknowledge Missing Result",
      progress: "Acknowledging the missing result…",
      busy: state === "pending",
      run: () => {
        if (steps.has(key)) return;
        setStep(key, sessionKey, "pending");
        void requestMissingResultAcknowledgement(api, sessionId, continuationId).then((failure) => {
          setStep(key, sessionKey, failure === null ? "done" : null);
          if (failure === null) showToast("Missing result acknowledged.", { tone: "success" });
          else showToast(failure, { tone: "error" });
        });
      },
    };
  }

  const { target } = offer;
  return {
    label: "Stop Job…",
    progress: "Stopping the job…",
    busy: state === "pending",
    run: () => {
      if (steps.has(key)) return;
      setStep(key, sessionKey, "confirming");
      void confirm({
        title: "Stop Job",
        message: STOP_JOB_OUTCOME,
        detailRows: [{ label: target.jobLabel }],
        confirmLabel: "Stop Job",
        cancelLabel: "Keep Running",
        tone: "danger",
        returnFocus: returnFocusRef,
      }).then((confirmed) => {
        if (!confirmed) {
          setStep(key, sessionKey, null);
          return;
        }
        // The job is stopped only if it is still the one job blocking this session's result, as a
        // mounted header shows the session now. With no header showing it, nothing can say so.
        const current = latestInputs.get(sessionKey);
        if (!current || offeredStep(instanceScope, current)?.key !== key) {
          setStep(key, sessionKey, null);
          showToast(current
            ? "The background work changed, so nothing was stopped."
            : "The session was closed, so nothing was stopped.", { tone: "info" });
          return;
        }
        setStep(key, sessionKey, "pending");
        return requestBackgroundJobStop(api, sessionId, target.jobId).then((result) => {
          setStep(key, sessionKey, result.state === "error" ? null : "done");
          if (result.state === "stopped") showToast(`${target.jobLabel} was stopped.`, { tone: "success" });
          else if (result.state === "already_terminal") showToast(STOP_JOB_ALREADY_ENDED, { tone: "info" });
          else showToast(result.message, { tone: "error" });
        });
      });
    },
  };
}
