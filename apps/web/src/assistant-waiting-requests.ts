import type { PendingApproval } from "@wollipog/protocol";
import { approvalOptionForIntent } from "./inbox.js";

export function assistantWorkRequestKey(sessionId: string, request: PendingApproval): string {
  return JSON.stringify([sessionId, request.occurrenceId ?? request.requestId]);
}

/** Inline answers cover one ordinary, single-choice provider question. Other question forms use
 * the session's full question flow, which supports native validation, recovery and classification. */
export function assistantInlineQuestion(request: PendingApproval) {
  if (request.kind !== "question" || request.recoveryReason || request.questions?.length !== 1) return undefined;
  const question = request.questions[0]!;
  if (!question.options.length || question.multiSelect || question.secret || question.inputFormat ||
    question.customAnswerError || question.required === false) return undefined;
  return question;
}

/** Only a plain tool request with an unambiguous one-time allow and deny can be handled here. */
export function assistantToolOptions(request: PendingApproval) {
  if ((request.kind && request.kind !== "permission") || request.context?.providerPermissionExpansion) return undefined;
  const approve = approvalOptionForIntent(request, "approve");
  const deny = approvalOptionForIntent(request, "deny");
  return approve && deny ? { approve, deny } : undefined;
}
