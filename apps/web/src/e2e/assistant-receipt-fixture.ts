import type { AssistantTranscriptReceipt, SessionEventPayload } from "@wollipog/protocol";

export const receiptStressTitle = "CrossPlatformReleaseReadinessVerificationWithAReallyLongUnbrokenSessionTitle".repeat(2);
export const receiptStressReason = "Check the archive at " + "CrossPlatformValidationManifestIdentifier".repeat(5);

export function assistantReceiptFixture(
  scenario: string,
  sessionIds: string[],
  confirmationId: string,
  resolvedAt: number,
): SessionEventPayload[] {
  const old = scenario === "old";
  const call = (id: string, title: string): SessionEventPayload =>
    ({ kind: "tool_call", toolCallId: id, title, status: "in_progress" });
  const receipt = (id: string, value: AssistantTranscriptReceipt): SessionEventPayload =>
    ({ kind: "tool_call_update", toolCallId: id, status: "completed", ...(old ? {} : { assistantReceipt: value }) });
  const message = (text: string): SessionEventPayload => ({ kind: "agent_message", text, final: true });
  const prompt = (text: string): SessionEventPayload => ({ kind: "user_message", text });
  const launch = [
    prompt("Start the verification work."),
    message("I’m starting the verification sessions."),
    ...sessionIds.map((id) => call(id, "Launch Session")),
    // In a parallel batch a later call can finish first.
    ...sessionIds.slice().reverse().map((id) => receipt(id, { kind: "launch", sessionId: id })),
    message("The verification sessions are ready."),
  ];
  const decision = [
    prompt("Handle the release approval."),
    message("I’ll review the release pull request."),
    call("delegate", "Resolve Delegated Decision"),
    receipt("delegate", { kind: "decision", occurrenceId: "occ-release", category: "pr_merge",
      outcome: "approved", subject: scenario === "stress" ? receiptStressTitle + "#126" : "picoduck/wollipog#126",
      reason: scenario === "stress" ? receiptStressReason : "Required checks passed.", selectionMode: "all", resolvedAt }),
    message("The release approval is recorded."),
  ];
  const request = [
    prompt(scenario === "campaign" ? "Start the release campaign." : "Ask before stopping the upload session."),
    call("request", scenario === "campaign" ? "Start Campaign" : "Stop Session"),
    receipt("request", { kind: "request", confirmationId, title: scenario === "campaign" ? "Start Campaign" : "Stop Session" }),
    message(scenario === "campaign" ? "I asked you to review the campaign." : "I asked you before stopping the upload session."),
  ];
  switch (scenario) {
    case "decision": return decision;
    case "request":
    case "campaign": return request;
    case "stress": return [...decision, ...launch];
    case "old": return [...launch, ...decision, ...request];
    default: return launch;
  }
}
