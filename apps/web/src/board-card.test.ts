import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionOption } from "@wollipog/protocol";
import { boardCardDecisions, boardCardRequestCode, boardCardSignInItems } from "./board-card.js";

const option = (optionId: string, kind?: string, description?: string): PermissionOption =>
  ({ optionId, name: optionId, ...(kind ? { kind } : {}), ...(description ? { description } : {}) });

test("Approve and Deny are the first one-time allow and reject options, whatever the agent calls them", () => {
  assert.deepEqual(boardCardDecisions([option("allow", "allow_once"), option("deny", "reject_once")]),
    { approve: option("allow", "allow_once"), deny: option("deny", "reject_once") });
  // An agent that lists Always Allow first still gets the one-time choice from the card.
  const listed = [option("always", "allow_always"), option("once", "allow_once"), option("never", "reject_always"), option("no", "reject_once")];
  assert.equal(boardCardDecisions(listed).approve?.optionId, "once");
  assert.equal(boardCardDecisions(listed).deny?.optionId, "no");
  // A persistent grant or refusal is never relabeled Approve or Deny: it stays in the session.
  assert.deepEqual(boardCardDecisions([option("always", "allow_always"), option("never", "reject_always")]), { approve: null, deny: null });
  assert.equal(boardCardDecisions([option("stop", "deny")]).deny?.optionId, "stop", "a plain deny counts as Deny");
  assert.deepEqual(boardCardDecisions([option("explain")]), { approve: null, deny: null }, "an option without a kind stays in the session");
  assert.deepEqual(boardCardDecisions([option("stop", "reject_once")]), { approve: null, deny: option("stop", "reject_once") });
});

test("a sign-in menu lists the methods with descriptions, then Cancel Sign-In last in danger", () => {
  assert.deepEqual(boardCardSignInItems([
    { ...option("auth_1_cancel", "reject_once"), name: "Cancel sign-in" },
    option("auth_1_method_1", "allow_once", "Sign in in a browser."),
    option("auth_1_method_2", "allow_once"),
    option("unkinded"),
  ]).map(({ option: item, label, danger }) => [item.optionId, label, danger]), [
    ["auth_1_method_1", "auth_1_method_1", false],
    ["auth_1_method_2", "auth_1_method_2", false],
    ["auth_1_cancel", "Cancel Sign-In", true],
  ]);
  // A reject option that does not cancel keeps its own name.
  assert.deepEqual(boardCardSignInItems([option("auth_1_method_1", "allow_once"), { ...option("auth_1_skip", "reject_once"), name: "Skip for Now" }])
    .map(({ label }) => label), ["auth_1_method_1", "Skip for Now"]);
  assert.equal(boardCardSignInItems([{ ...option("x", "reject_once"), name: "Cancel sign-in" }])[0]!.label, "Cancel Sign-In");
  // Dismiss Recovery is not a cancellation, so it keeps its name.
  assert.deepEqual(boardCardSignInItems([option("auth:login", "allow_once"), { ...option("auth:dismiss", "reject_once"), name: "Dismiss Recovery" }])
    .map(({ label, danger }) => [label, danger]), [["auth:login", false], ["Dismiss Recovery", true]]);
});

test("a request's code line is the first non-empty line of its input, and a workflow decision has none", () => {
  assert.equal(boardCardRequestCode({ context: { input: "\n  npm test  \nnext" } }), "npm test");
  assert.equal(boardCardRequestCode({ context: { toolName: "Bash" } }), null);
  assert.equal(boardCardRequestCode({}), null);
  assert.equal(boardCardRequestCode({ context: { input: "npm test" }, workflowDecision: {} as never }), null);
});
