import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionCommandInvocationView } from "@wollipog/protocol";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCommandReceipts, visibleSessionCommandReceipts } from "./SessionCommandReceipts.js";

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

test("provider command receipts expose Title Case state and failure detail", () => {
  const html = renderToStaticMarkup(<SessionCommandReceipts invocations={[
    invocation("uncertain"),
    invocation("rejected", { error: "The command is unavailable." }),
  ]} timelineItems={[]} />);
  assert.match(html, /Provider Command Receipts/);
  assert.match(html, /Delivery Uncertain/);
  assert.match(html, /The command is unavailable\./);
  assert.match(html, /\/review storage/);
});
