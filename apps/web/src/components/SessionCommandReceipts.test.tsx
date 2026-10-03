import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionCommandInvocationView } from "@wollipog/protocol";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { commandReceiptLine, SessionCommandReceipts, visibleSessionCommandReceipts } from "./SessionCommandReceipts.js";

function invocation(
  state: SessionCommandInvocationView["state"],
  overrides: Partial<SessionCommandInvocationView> = {},
): SessionCommandInvocationView {
  return {
    invocationId: `ci-${state}`,
    submissionId: `submission-${state}`,
    sessionId: "session-1",
    providerCommandId: "command-1",
    catalogRevision: "catalog-1",
    commandName: "review",
    argumentText: "storage",
    executionMode: "passthrough",
    state,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("completed command receipts retire while unresolved and failed states remain", () => {
  assert.deepEqual(
    visibleSessionCommandReceipts([
      invocation("completed"),
      invocation("started"),
      invocation("rejected", { error: "catalog changed" }),
    ], [{
      kind: "user_message",
      id: 1,
      text: "/review storage",
      commandInvocation: {
        invocationId: "ci-completed",
        submissionId: "submission-completed",
        providerCommandId: "command-1",
        catalogRevision: "catalog-1",
        commandName: "review",
        executionMode: "passthrough",
      },
    }]).map((item) => item.state),
    ["started", "rejected"],
  );
  assert.deepEqual(visibleSessionCommandReceipts([invocation("completed")], []).map((item) => item.state),
    ["completed"], "completion stays visible until its canonical transcript event is present");
  assert.deepEqual(visibleSessionCommandReceipts([invocation("completed")], [{
    kind: "user_message",
    id: 2,
    text: "/review storage",
    commandInvocation: {
      invocationId: "ci-completed",
      submissionId: "submission-completed",
      providerCommandId: "different-command",
      catalogRevision: "catalog-1",
      commandName: "review",
      executionMode: "passthrough",
    },
  }]).map((item) => item.state), ["completed"], "mismatched authority cannot retire a receipt");
});

test("only the newest five terminal recovery receipts remain while active receipts are never dropped", () => {
  const activeStates: SessionCommandInvocationView["state"][] = [
    "pending",
    "sent",
    "accepted",
    "queued",
    "started",
  ];
  const active = activeStates.map((state, index) => invocation(state, {
    invocationId: `active-${state}`,
    submissionId: `active-submission-${state}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  }));
  const terminal = Array.from({ length: 10 }, (_, index) => invocation(
    index % 2 === 0 ? "rejected" : "uncertain",
    {
      invocationId: `terminal-${index + 1}`,
      submissionId: `terminal-submission-${index + 1}`,
      createdAt: index + 1,
      updatedAt: index + 1,
    },
  ));
  const unmatchedCompletion = invocation("completed", {
    invocationId: "completion-without-transcript",
    submissionId: "completion-without-transcript",
    createdAt: 11,
    updatedAt: 11,
  });

  const visible = visibleSessionCommandReceipts([
    ...terminal.slice(0, 5),
    ...active,
    unmatchedCompletion,
    ...terminal.slice(5),
  ], []);

  assert.deepEqual(
    visible.filter((item) => activeStates.includes(item.state)).map((item) => item.invocationId),
    active.map((item) => item.invocationId),
  );
  assert.deepEqual(
    visible.filter((item) => ["completed", "rejected", "uncertain"].includes(item.state))
      .map((item) => item.invocationId),
    ["completion-without-transcript", "terminal-7", "terminal-8", "terminal-9", "terminal-10"],
  );
  assert.equal(visible.some((item) => item.invocationId === "terminal-6"), false,
    "an unmatched completion participates in the combined terminal cap");
});

test("provider command receipts are transcript rows that say where the command went and what happened", () => {
  const html = renderToStaticMarkup(<SessionCommandReceipts invocations={[
    invocation("uncertain"),
    invocation("rejected", { invocationId: "ci-unavailable", code: "COMMAND_UNAVAILABLE",
      error: "provider returned COMMAND_UNAVAILABLE for review" }),
    invocation("started", { invocationId: "ci-running" }),
    invocation("sent", { invocationId: "ci-sent" }),
  ]} timelineItems={[]} agentLabel="Codex" />);
  assert.doesNotMatch(html, /Provider Command/, "the source is not repeated on every receipt");
  assert.match(html, /class="tl-row user tl-receipt-row"/);
  assert.match(html, /class="tl-bubble is-command is-failed"/);
  assert.match(html, /Delivery Uncertain/);
  assert.match(html, /Wollipog couldn&#x27;t confirm this message was delivered\./);
  assert.match(html, /Rejected/);
  assert.match(html, /This command isn&#x27;t available right now\./);
  assert.match(html, /Running in Codex…/);
  assert.match(html, /Sending to Codex…/);
  assert.match(html, /Show Details/);
  assert.doesNotMatch(html, /provider returned COMMAND_UNAVAILABLE/, "raw provider text waits behind Show Details");
  assert.match(html, /\/review storage/);
});

test("a command receipt line names the agent for every state", () => {
  assert.deepEqual(commandReceiptLine({ state: "pending" }, "Claude Code"),
    { status: "sending", progress: "Sending to Claude Code…" });
  assert.deepEqual(commandReceiptLine({ state: "queued" }, "Claude Code"),
    { status: "queued", reason: "Waiting for Claude Code." });
  assert.deepEqual(commandReceiptLine({ state: "started" }, "Claude Code"),
    { status: "sending", progress: "Running in Claude Code…" });
  assert.deepEqual(commandReceiptLine({ state: "completed" }, "Claude Code"),
    { status: "delivered", reason: "Ran in Claude Code." });
  assert.deepEqual(commandReceiptLine({ state: "rejected", code: "COMMAND_CATALOG_STALE" }, "Claude Code"),
    { status: "rejected", reason: "The agent's commands changed, so this command wasn't run." });
});

test("a bounded window is not evidence that a completed command lost its message", () => {
  // Absence from a partial transcript means only that the turn is unloaded, so a command that
  // completed cleanly turns ago must not resurrect a recovery receipt beside the composer.
  assert.deepEqual(
    visibleSessionCommandReceipts([invocation("completed")], [], true).map((item) => item.state),
    [],
  );
  // Failures and ambiguity never depended on canonical presence, so they still surface.
  assert.deepEqual(
    visibleSessionCommandReceipts(
      [invocation("completed"), invocation("rejected", { error: "catalog changed" })],
      [],
      true,
    ).map((item) => item.state),
    ["rejected"],
  );
  // With the whole history loaded, absence is authoritative again.
  assert.deepEqual(
    visibleSessionCommandReceipts([invocation("completed")], [], false).map((item) => item.state),
    ["completed"],
  );
});

test("skill receipts use the $name spelling the transcript records", () => {
  const html = renderToStaticMarkup(React.createElement(SessionCommandReceipts, {
    invocations: [
      invocation("started", { commandName: "review", argumentText: "pr 42" }),
      invocation("queued", { invocationId: "ci-prompt", commandName: "summarize", argumentText: "" }),
    ],
    timelineItems: [],
    agentLabel: "Codex",
    isSkillInvocation: (candidate) => candidate.commandName === "review",
  }));
  assert.match(html, /\$review pr 42/);
  assert.match(html, />\/summarize</);
});
