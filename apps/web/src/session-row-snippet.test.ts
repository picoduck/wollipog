import assert from "node:assert/strict";
import test from "node:test";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { sessionRowSnippet } from "./session-row-snippet.js";

const session = (extra: Partial<SessionView> = {}): SessionView =>
  ({ id: "s", status: "idle", pendingApproval: null, preview: null, ...extra }) as unknown as SessionView;

const request = (requestId: string, title: string, extra: Partial<PendingApproval> = {}): PendingApproval =>
  ({ requestId, kind: "permission", title, options: [], ...extra }) as PendingApproval;

test("an idle row's snippet is its latest agent message without markdown (#2218)", () => {
  assert.equal(
    sessionRowSnippet(session({ preview: "## Done\n**All 42 tests** pass. See [the log](https://ci.example/1)." })),
    "Done All 42 tests pass. See the log.",
  );
  assert.equal(sessionRowSnippet(session()), "");
});

test("a blocked row's snippet is its request's title, not the agent's last message", () => {
  assert.equal(sessionRowSnippet(session({
    status: "input_required",
    preview: "I need to run the migration.",
    pendingApproval: request("a", "Run the Migration Script"),
  })), "Run the Migration Script");
});

test("several requests name the one the badge ranks first", () => {
  // A question outranks a tool permission (attentionRequestRank), whatever arrived first.
  assert.equal(sessionRowSnippet(session({
    status: "input_required",
    pendingApproval: { ...request("a", "Run `pnpm test`"), additionalRequests: [request("b", "Which Database?", { kind: "question" })] },
  })), "Which Database?");
  assert.equal(sessionRowSnippet(session({
    status: "input_required",
    pendingApproval: { ...request("a", "Run `pnpm test`"), additionalRequests: [request("b", "Vacuum the Database")] },
  })), "Run pnpm test");
});

test("a request someone else owns falls back to the agent's message", () => {
  assert.equal(sessionRowSnippet(session({
    status: "input_required",
    preview: "Waiting on the orchestrator.",
    pendingApproval: request("a", "Merge Pull Request"),
    pendingRequestOwners: { human: 0, orchestrator: 1, requests: [{ requestId: "a", owner: "orchestrator" }] },
  } as Partial<SessionView>)), "Waiting on the orchestrator.");
});
