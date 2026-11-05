import { createHash, randomUUID } from "node:crypto";
import {
  credentialScreenQuestionText,
  credentialScreenToolText,
  type CampaignDecisionSubject,
  type CredentialScreenFact,
  type PendingApproval,
} from "@wollipog/protocol";
import type { ControlPlaneDb, DecisionOccurrenceRecord } from "./db.js";
import type { DecisionRuntime } from "./decision-runtime.js";
import { DECISION_KINDS, DecisionInputError, decisionInputDigests } from "./decision-kinds.js";
import type { DecisionAutomaticHarness } from "./decision-model-settings.js";

/**
 * The Full Control question and credential screen on the Decision Model (#4104).
 *
 * The deterministic floor in `@wollipog/protocol` runs first and never calls a model. Text it leaves
 * open is screened here once per request occurrence, with one fixed question: "Does this ask whoever
 * answers to supply, disclose or grant a credential, sign-in or access?" `ask` declines the request
 * exactly as the floor would, `discusses` leaves it to the Orchestrator, and an uncertain or failed
 * screen is the owner's to classify through one typed, person-owned request. Nothing here reads the
 * text to decide; a failure never falls back to a word list.
 */

export type CredentialScreenSurface = CampaignDecisionSubject["surface"];

/** The `request` data the model sees, as one JSON document. Its digest names the occurrence. */
export function credentialScreenData(surface: CredentialScreenSurface, fields: Record<string, unknown>): string {
  return JSON.stringify({ surface, ...fields });
}

export function implementationQuestionScreenData(form: { question: string; options: Array<{ label: string; description?: string }> }): string {
  return credentialScreenData("implementation_question", {
    question: form.question,
    options: form.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
  });
}

export function ownerDecisionScreenData(form: { question: string; options: Array<{ label: string; description?: string }>; material?: string }): string {
  return credentialScreenData("owner_decision", {
    question: form.question,
    options: form.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
    ...(form.material ? { material: form.material } : {}),
  });
}

/** A provider question's or tool request's screen data, or null for anything else. The text is
 * never truncated: a verdict on a prefix would admit whatever follows it. Text too large for one
 * Decision input fails closed in screenCredentialRequest. */
export function genericRequestScreenData(request: PendingApproval): { surface: CredentialScreenSurface; data: string } | null {
  if (request.kind === "question") {
    return request.questions?.length
      ? { surface: "provider_question", data: credentialScreenData("provider_question", { text: credentialScreenQuestionText(request.questions) }) }
      : null;
  }
  if (request.kind === undefined || request.kind === "permission" || request.kind === "policy_hook") {
    return { surface: "tool_request", data: credentialScreenData("tool_request", { text: credentialScreenToolText(request) }) };
  }
  return null;
}

/** The idempotency key of one request occurrence's screen: the same request with the same text
 * always joins the same occurrence, so a replay or a concurrent call never records a second verdict. */
export function credentialScreenKey(surface: CredentialScreenSurface, sessionId: string, requestId: string, data: string): string {
  const digest = createHash("sha256").update(data, "utf8").digest("hex").slice(0, 32);
  return `credential_screen:${surface}:${sessionId}:${createHash("sha256").update(requestId, "utf8").digest("hex").slice(0, 16)}:${digest}`;
}

/** The screen's current fact from the durable audit and the owner's classification. */
export function credentialScreenFact(
  occurrence: DecisionOccurrenceRecord | null,
  classification: "decline" | "orchestrator" | undefined,
): CredentialScreenFact {
  if (!occurrence || occurrence.state === "pending") {
    return { state: "pending", ...(occurrence ? { occurrenceId: occurrence.occurrenceId } : {}) };
  }
  const verdict: CredentialScreenFact["verdict"] = occurrence.verdict === "ask" || occurrence.verdict === "discusses" ||
    occurrence.verdict === "uncertain" ? occurrence.verdict : undefined;
  const common = {
    occurrenceId: occurrence.occurrenceId,
    ...(verdict ? { verdict } : {}),
    ...(occurrence.failureClass ? { failureClass: occurrence.failureClass as NonNullable<CredentialScreenFact["failureClass"]> } : {}),
  };
  if (occurrence.state === "decided") return { state: verdict === "ask" ? "ask" : "discusses", ...common };
  if (classification) return { state: classification === "decline" ? "ask" : "discusses", ...common, classifiedBy: "owner" };
  return { state: "review", ...common };
}

/** The fact a stored request occurrence's screen has now, without calling the model. */
export function storedCredentialScreenFact(db: ControlPlaneDb, surface: CredentialScreenSurface, sessionId: string,
  requestId: string, data: string): CredentialScreenFact {
  const occurrence = db.decisionOccurrenceByKey(credentialScreenKey(surface, sessionId, requestId, data));
  return credentialScreenFact(occurrence, occurrence ? db.campaignDecisionSubject(occurrence.occurrenceId)?.classification : undefined);
}

export interface CredentialScreenInput {
  organizationId: string;
  campaignSessionId: string;
  sessionId: string;
  surface: CredentialScreenSurface;
  requestId: string;
  data: string;
  automaticHarness: DecisionAutomaticHarness | null;
  /** The caller's one person-owned request for an uncertain or failed screen, idempotent per
   * occurrence; null when the affected request itself is that request. */
  routeToHuman?: (occurrence: DecisionOccurrenceRecord) => string | null;
}

/** Record a screen the runtime could not finish as a failed occurrence, with its route to a person
 * already taken, so it reads as `review` like any other failure. An occurrence the runtime already
 * settled keeps its outcome: the compare-and-set only settles one still pending. */
function failScreenWithoutVerdict(db: ControlPlaneDb, input: CredentialScreenInput, occurrenceKey: string,
  inputs: { data: Record<string, string> }, failureClass: "configuration" | "provider_failed", at: number): string {
  const definition = DECISION_KINDS.credential_screen;
  const { occurrence } = db.createDecisionOccurrence({
    occurrenceId: `dec_${randomUUID()}`, organizationId: input.organizationId, campaignSessionId: input.campaignSessionId,
    occurrenceKey, kind: definition.kind, promptVersion: definition.promptVersion, inputDigests: decisionInputDigests(inputs),
    inputDigest: createHash("sha256").update(`${definition.kind}\n${definition.promptVersion}\nunrendered\n${input.data}`, "utf8").digest("hex"),
    now: at,
  });
  db.settleDecisionOccurrence(occurrence.occurrenceId, { state: "failed", failureClass, now: at });
  if (db.claimDecisionHumanRoute(occurrence.occurrenceId, at)) db.completeDecisionHumanRoute(occurrence.occurrenceId, null, at);
  return occurrence.occurrenceId;
}

/** Screen one request occurrence on the Decision Model and return its fact. The audit records the
 * occurrence and its subject; the reason stays in the audit, never in the returned fact. */
export async function screenCredentialRequest(db: ControlPlaneDb, runtime: DecisionRuntime, input: CredentialScreenInput, now: () => number = Date.now): Promise<CredentialScreenFact> {
  const subject = (occurrenceId: string) => db.recordCampaignDecisionSubject({ occurrenceId, campaignSessionId: input.campaignSessionId,
    sessionId: input.sessionId, surface: input.surface, requestId: input.requestId }, now());
  const occurrenceKey = credentialScreenKey(input.surface, input.sessionId, input.requestId, input.data);
  const inputs = { data: { request: input.data } };
  let occurrenceId: string;
  try {
    occurrenceId = (await runtime.decide({
      organizationId: input.organizationId,
      kind: "credential_screen",
      campaignSessionId: input.campaignSessionId,
      occurrenceKey,
      automaticHarness: input.automaticHarness,
      inputs,
      routeToHuman: (occurrence) => {
        subject(occurrence.occurrenceId);
        return input.routeToHuman?.(occurrence) ?? null;
      },
    })).occurrenceId;
  } catch (error) {
    // A screen that cannot run fails closed as an audited failure the owner can classify (#4104):
    // text too large for one Decision input is never screened by a prefix, and any other error
    // leaves a durable outcome rather than a request held with nothing to classify.
    occurrenceId = failScreenWithoutVerdict(db, input, occurrenceKey, inputs,
      error instanceof DecisionInputError ? "configuration" : "provider_failed", now());
  }
  subject(occurrenceId);
  const outcome = { occurrenceId };
  const occurrence = db.getDecisionOccurrence(outcome.occurrenceId);
  return credentialScreenFact(occurrence, db.campaignDecisionSubject(outcome.occurrenceId)?.classification);
}
