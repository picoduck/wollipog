import assert from "node:assert/strict";
import test from "node:test";
import { prioritizedPendingRequests, type PendingApproval, type PermissionOption } from "@wollipog/protocol";
import {
  formatRequestCountdown,
  moreRequestsLabel,
  pendingRequestsTitle,
  requestCardActions,
  requestKindMeta,
  requestOptionForIntent,
  requestPolicyLine,
  waitingRequestKinds,
} from "./request-meta.js";
import { dockRequests } from "./RequestDock.js";
import { softwareKeyboardOpen, SOFTWARE_KEYBOARD_MIN_PX } from "./software-keyboard.js";

const ids = (options: readonly PermissionOption[]) => options.map((option) => option.optionId);

test("the footer orders secondary options, then the menu, then the one primary, whatever the provider's order", () => {
  // A provider permission: allow first, always-allow next, reject last.
  const permission = requestCardActions([
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "always", name: "Always Allow in This Session", kind: "allow_always",
      description: "Allows pnpm deploy without asking until the session ends." },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ]);
  assert.deepEqual(ids(permission.secondary), ["deny"]);
  assert.deepEqual(ids(permission.menu), ["always"], "allow_always is only in the menu");
  assert.equal(permission.primary?.optionId, "allow");

  // A budget pause and a tool-call pause map the same way: Stop, then Continue.
  for (const continueName of ["Continue", "Check Again"]) {
    const pause = requestCardActions([
      { optionId: "continue", name: continueName, kind: "allow_once" },
      { optionId: "cancel", name: "Stop", kind: "reject_once" },
    ]);
    assert.deepEqual(ids(pause.secondary), ["cancel"]);
    assert.deepEqual(pause.menu, []);
    assert.equal(pause.primary?.optionId, "continue");
  }

  // Several allows: only the first allow_once is primary; the rest and kindless options wait in the menu.
  const signIn = requestCardActions([
    { optionId: "auth:login", name: "Start Sign-In", kind: "allow_once" },
    { optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" },
    { optionId: "auth:dismiss", name: "Dismiss Recovery", kind: "reject_once" },
    { optionId: "other", name: "Other" },
  ]);
  assert.equal(signIn.primary?.optionId, "auth:login");
  assert.deepEqual(ids(signIn.menu), ["auth:revalidate", "other"]);
  assert.deepEqual(ids(signIn.secondary), ["auth:dismiss"]);

  // No allow_once: no primary is invented; an allow_always still waits in the menu.
  const trust = requestCardActions([
    { optionId: "trust", name: "Trust This Configuration", kind: "allow_always" },
    { optionId: "skip", name: "Create Without Setup", kind: "reject_once" },
  ]);
  assert.equal(trust.primary, null);
  assert.deepEqual(ids(trust.menu), ["trust"]);
  assert.deepEqual(ids(trust.secondary), ["skip"]);
});

test("A and D name an option only where exactly one has that kind", () => {
  const options: PermissionOption[] = [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ];
  assert.equal(requestOptionForIntent(options, "approve")?.optionId, "allow");
  assert.equal(requestOptionForIntent(options, "deny")?.optionId, "deny");
  assert.equal(requestOptionForIntent([...options, { optionId: "again", name: "Again", kind: "allow_once" }], "approve"), null);
  assert.equal(requestOptionForIntent([{ optionId: "always", name: "Always", kind: "allow_always" }], "approve"), null);
});

test("every request kind has one label", () => {
  const label = (request: Partial<PendingApproval>) => requestKindMeta(request as PendingApproval).label;
  assert.equal(label({ kind: "permission" }), "Permission");
  assert.equal(label({}), "Permission");
  assert.equal(label({ kind: "policy_hook" }), "Permission");
  for (const kind of ["cost_budget", "cost_checkpoint", "cost_unpriced", "daily_budget"] as const) {
    assert.equal(label({ kind }), "Budget");
  }
  assert.equal(label({ kind: "max_tool_calls" }), "Tool Calls");
  assert.equal(label({ kind: "authentication" }), "Sign-In");
  assert.equal(label({ kind: "question" }), "Question");
  assert.equal(label({ kind: "workflow_decision", workflowDecision: { category: "pr_merge" } as never }), "Workflow Decision");
  assert.equal(label({ kind: "workflow_decision", workflowDecision: { category: "ui_evidence_approval" } as never }), "UI Evidence");
});

test("the policy line names the policy and counts down to its automatic rejection", () => {
  assert.equal(formatRequestCountdown((9 * 60 + 42) * 1000), "9:42");
  assert.equal(formatRequestCountdown(999), "0:01", "a part second still shows as a second left");
  assert.equal(formatRequestCountdown(-5), "0:00");
  assert.equal(formatRequestCountdown((3600 + 5 * 60 + 9) * 1000), "1:05:09");
  assert.equal(requestPolicyLine("Deploy Guard", (9 * 60 + 42) * 1000), "Asked by Deploy Guard · Rejects automatically in 9:42");
  assert.equal(requestPolicyLine("Deploy Guard", null), "Asked by Deploy Guard");
  assert.equal(requestPolicyLine(null, null), "");
});

test("the dock answers the session's own requests other than questions, in priority order", () => {
  const permission = { requestId: "p", kind: "permission", title: "Run pnpm deploy?", options: [] } as PendingApproval;
  const budget = { requestId: "b", kind: "cost_budget", title: "Cost budget reached", options: [] } as PendingApproval;
  const signIn = { requestId: "s", kind: "authentication", title: "Sign In", options: [] } as PendingApproval;
  const question = { requestId: "q", kind: "question", title: "Question", options: [] } as PendingApproval;
  const worker = { requestId: "w", kind: "permission", title: "Worker", options: [], ownerToolUseId: "tool" } as PendingApproval;
  const docked = dockRequests(prioritizedPendingRequests({ ...permission, additionalRequests: [budget, signIn, question, worker] }));
  assert.deepEqual(docked.map((request) => request.requestId), ["s", "b", "p"]);
  assert.equal(waitingRequestKinds(docked.slice(1)), "Budget, Permission");
  assert.equal(moreRequestsLabel(2), "+2 More Requests");
  assert.equal(moreRequestsLabel(1), "+1 More Request");
  assert.equal(pendingRequestsTitle(1), "Pending Request");
  assert.equal(pendingRequestsTitle(3), "3 Pending Requests");
});

test("the software keyboard is open when the visual viewport is a keyboard shorter than the layout viewport", () => {
  const viewport = (height: number) => ({ height }) as VisualViewport;
  assert.equal(softwareKeyboardOpen({ innerHeight: 844, visualViewport: viewport(844) }), false);
  assert.equal(softwareKeyboardOpen({ innerHeight: 844, visualViewport: viewport(844 - SOFTWARE_KEYBOARD_MIN_PX) }), false,
    "a browser toolbar moving is not a keyboard");
  assert.equal(softwareKeyboardOpen({ innerHeight: 844, visualViewport: viewport(500) }), true);
  assert.equal(softwareKeyboardOpen({ innerHeight: 844, visualViewport: null }), false);
});
