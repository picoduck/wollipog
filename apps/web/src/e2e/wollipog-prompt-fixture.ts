import type { SessionEvent, WollipogPromptOrigin } from "@wollipog/protocol";

export const longConfirmationTarget =
  "Validate Integration Fixtures Against the Release Candidate on Every Supported Platform Before the Release Window";
export const legacyConfirmationText = '[Wollipog Owner Confirmation] Your owner approved "Archive Session" (session_archive) on session Bump the Vite Group (sess-deps), command cmd_legacy. Wollipog ran it once; its receipt reads succeeded. Never send that command again: read its receipt and target, then continue.';
export const approvedConfirmationText = legacyConfirmationText.replace("cmd_legacy", "cmd_archive");

type Payload = SessionEvent["payload"];
type Outcome = Extract<WollipogPromptOrigin, { kind: "owner_confirmation" }>["outcome"];

function confirmation(outcome: Outcome, long = false): Payload {
  const title = outcome === "approved" ? "Archive Session" : "Stop Session";
  const target = outcome === "approved" && !long
    ? { kind: "session", id: "sess-deps", label: "Bump the Vite Group" }
    : { kind: "session", id: "sess-flaky", label: long ? longConfirmationTarget : "Fix the Flaky Upload Test" };
  const action = '"' + title + '" (session_stop) on session ' + target.label + ' (' + target.id + '), command cmd_stop';
  const tail = {
    approved: approvedConfirmationText.slice("[Wollipog Owner Confirmation] ".length),
    denied: "Your owner denied " + action + ". Nothing ran. Continue without it, and ask your owner before requesting it again.",
    expired: "Your request for " + action + " expired before your owner answered. Nothing ran. Ask your owner before requesting it again.",
    refused: "Your request for " + action + " was refused, so nothing ran: the target or grant changed.",
  }[outcome];
  return {
    kind: "user_message", text: "[Wollipog Owner Confirmation] " + tail,
    promptOrigin: { kind: "owner_confirmation", confirmationId: "aoc_" + outcome, outcome, title, target,
      ...(outcome === "approved" ? { receiptStatus: "succeeded" } : {}) },
  };
}

export function confirmationResultFixture(scenario: string): Payload[] {
  switch (scenario) {
    case "approved": case "denied": case "expired": case "refused":
      return [confirmation(scenario)];
    case "legacy":
      return [{ kind: "user_message", text: legacyConfirmationText }];
    case "scheduled":
      return [{ kind: "user_message", text: "The campaign has resumed. Continue the preserved work.", promptOrigin: { kind: "scheduled_wake" } }];
    case "delegation":
      return [{ kind: "user_message", text: "The assistant answered a decision under your owner's delegation.", promptOrigin: { kind: "delegation_notice" } }];
    case "background":
      return [
        { kind: "user_message", text: "Run the upload tests and report the result." },
        { kind: "agent_message", text: "The tests are running in the background.", final: true },
        { kind: "stderr", text: "Runner continued after managed background work completed.",
          backgroundPrompt: { origin: { kind: "background_result" }, text: "Report the terminal result of the upload tests." } },
        { kind: "agent_message", text: "All upload tests passed.", final: true },
      ];
    case "stress":
      return [
        confirmation("denied", true),
        { kind: "agent_message", text: "I’ll leave the upload test running while I check the other changes.", final: true },
        confirmation("expired", true),
        { kind: "user_message", text: "Keep the upload check running until the build is done." },
        confirmation("approved"),
        ...confirmationResultFixture("delegation"),
        ...confirmationResultFixture("scheduled"),
        confirmation("refused", true),
      ];
    default:
      return [];
  }
}
