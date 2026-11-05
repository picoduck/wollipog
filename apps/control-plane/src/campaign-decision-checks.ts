import { createHash, randomUUID } from "node:crypto";
import type { CampaignDecisionSubject, DecisionErrorClass, DecisionKind, SessionView } from "@wollipog/protocol";
import type { ControlPlaneDb, DecisionOccurrenceRecord } from "./db.js";
import { DECISION_KINDS, DecisionInputError, decisionInputDigests, type DecisionInputs } from "./decision-kinds.js";
import type { DecisionAutomaticHarness } from "./decision-model-settings.js";
import type { DecisionRuntime } from "./decision-runtime.js";

/**
 * Follow-up relatedness and closure-reason choice on the Decision Model (#4104, Slice B).
 *
 * Each check runs only after its deterministic floor admitted the request, and it may only refuse:
 * the confirming verdict leaves the request as the floor admitted it, the refusing one returns it to
 * the Orchestrator with the model's reason, and an uncertain or failed check makes the request the
 * owner's. A check is one audited occurrence per request and inputs, so a replay joins its outcome
 * and never records a second verdict; nothing ever falls back to reading the text another way.
 */

export type CampaignCheckOutcome =
  /** The model confirmed what the floor admitted. */
  | { outcome: "confirmed"; occurrenceId: string }
  /** The model refused it; `reason` is its bounded reason, for the Orchestrator. */
  | { outcome: "refused"; occurrenceId: string; reason: string }
  /** Uncertain or failed: the request is the owner's. */
  | { outcome: "owner"; occurrenceId: string; cause: "uncertain" | "failed"; failureClass?: DecisionErrorClass; reason?: string };

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** One request's key: the same request with the same inputs always joins the same occurrence. */
export function campaignCheckKey(kind: DecisionKind, campaignSessionId: string, requestId: string, inputs: DecisionInputs): string {
  return `${kind}:${campaignSessionId}:${sha256(requestId).slice(0, 16)}:${sha256(JSON.stringify(inputs)).slice(0, 32)}`;
}

/** Record a decision the runtime could not finish as a failed occurrence whose route to a person is
 * already taken, so it reads like any other failure. An occurrence the runtime already settled keeps
 * its outcome: the compare-and-set settles only one still pending. */
export function recordUnfinishedDecision(db: ControlPlaneDb, input: { kind: DecisionKind; organizationId: string; campaignSessionId: string;
  occurrenceKey: string; inputs: DecisionInputs }, failureClass: "configuration" | "provider_failed", at: number): string {
  const definition = DECISION_KINDS[input.kind];
  const { occurrence } = db.createDecisionOccurrence({
    occurrenceId: `dec_${randomUUID()}`, organizationId: input.organizationId, campaignSessionId: input.campaignSessionId,
    occurrenceKey: input.occurrenceKey, kind: definition.kind, promptVersion: definition.promptVersion,
    inputDigests: decisionInputDigests(input.inputs),
    inputDigest: sha256(`${definition.kind}\n${definition.promptVersion}\nunrendered\n${JSON.stringify(input.inputs)}`),
    now: at,
  });
  db.settleDecisionOccurrence(occurrence.occurrenceId, { state: "failed", failureClass, now: at });
  if (db.claimDecisionHumanRoute(occurrence.occurrenceId, at)) db.completeDecisionHumanRoute(occurrence.occurrenceId, null, at);
  return occurrence.occurrenceId;
}

export interface CampaignCheckInput {
  kind: "follow_up_relatedness" | "closure_reason";
  /** The verdict that confirms the floor's admission, and the one that refuses it. */
  confirm: string;
  refuse: string;
  organizationId: string;
  root: Pick<SessionView, "id" | "runnerId" | "agentId" | "driver">;
  /** The session whose request this is, and what it affected, for Campaign Status. */
  sessionId: string;
  surface: Extract<CampaignDecisionSubject["surface"], "follow_up_publication" | "issue_closure">;
  requestId: string;
  inputs: DecisionInputs;
}

/** Run one Slice B check on the Decision Model and read its outcome. The person-owned request for
 * an uncertain or failed check is the affected request itself, which the caller keeps the owner's. */
export async function runCampaignCheck(db: ControlPlaneDb, runtime: DecisionRuntime, input: CampaignCheckInput,
  now: () => number = Date.now): Promise<CampaignCheckOutcome> {
  const occurrenceKey = campaignCheckKey(input.kind, input.root.id, input.requestId, input.inputs);
  const automaticHarness: DecisionAutomaticHarness | null = input.root.agentId
    ? { runnerId: input.root.runnerId, agentId: input.root.agentId, driver: input.root.driver } : null;
  const subject = (occurrenceId: string) => db.recordCampaignDecisionSubject({ occurrenceId, campaignSessionId: input.root.id,
    sessionId: input.sessionId, surface: input.surface, requestId: input.requestId }, now());
  // A refusal, an uncertain verdict or a failure sticks to the server-owned subject (the
  // recommendation, or the issue and reason): a request whose text differs inherits it without a
  // new call, so rewording never buys a second verdict. The person deciding the affected request
  // is the only way past it.
  const earlier = db.latestUnconfirmedCampaignCheck(input.root.id, input.surface, input.requestId, input.kind, input.refuse);
  if (earlier && earlier.occurrenceKey !== occurrenceKey) return outcomeOf(earlier, input);
  let occurrenceId: string;
  try {
    occurrenceId = (await runtime.decide({
      organizationId: input.organizationId, kind: input.kind, campaignSessionId: input.root.id, occurrenceKey, automaticHarness,
      inputs: input.inputs,
      routeToHuman: (occurrence) => { subject(occurrence.occurrenceId); return null; },
    })).occurrenceId;
  } catch (error) {
    // Inputs too large for one Decision call are never judged by a part of them, and a check the
    // runtime cannot finish leaves a durable failure: either way the request is the owner's.
    occurrenceId = recordUnfinishedDecision(db, { kind: input.kind, organizationId: input.organizationId,
      campaignSessionId: input.root.id, occurrenceKey, inputs: input.inputs },
    error instanceof DecisionInputError ? "configuration" : "provider_failed", now());
  }
  subject(occurrenceId);
  return outcomeOf(db.getDecisionOccurrence(occurrenceId)!, input);
}

function outcomeOf(occurrence: DecisionOccurrenceRecord, input: Pick<CampaignCheckInput, "confirm" | "refuse">): CampaignCheckOutcome {
  const occurrenceId = occurrence.occurrenceId;
  if (occurrence.state === "decided" && occurrence.verdict === input.confirm) return { outcome: "confirmed", occurrenceId };
  if (occurrence.state === "decided" && occurrence.verdict === input.refuse) {
    return { outcome: "refused", occurrenceId, reason: occurrence.reason ?? "" };
  }
  return { outcome: "owner", occurrenceId, cause: occurrence.state === "uncertain" ? "uncertain" : "failed",
    ...(occurrence.failureClass ? { failureClass: occurrence.failureClass as DecisionErrorClass } : {}),
    ...(occurrence.reason ? { reason: occurrence.reason } : {}) };
}
