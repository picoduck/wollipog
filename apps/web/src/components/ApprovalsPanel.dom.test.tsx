import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GovernancePolicy } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { approvalsPolicyAnchorId } from "../navigation.js";
import { QUESTION_RESPONSE_STYLE_STORAGE_KEY } from "../question-response-style.js";
import { ApprovalsPanel } from "./ApprovalsPanel.js";
import { BehaviorPanel } from "./SettingsView.js";

/**
 * Settings › Approvals (#2158): Answering Questions, Routine Questions and the read-only Tool
 * Policies list, against a stubbed policies route that records every write.
 */

const domWindow = new Window({ url: "http://localhost/" });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

afterEach(() => domWindow.localStorage.clear());
installDomTestCleanup(domWindow);

const OWNER = { userId: "alice", organizationId: "org" };

function policy(overrides: Partial<GovernancePolicy> & Pick<GovernancePolicy, "policyId" | "name">): GovernancePolicy {
  return { effect: "allow", priority: 0, enabled: true, scope: {}, createdAt: 1, updatedAt: 2, ...overrides };
}

const BUILT_IN = policy({
  policyId: "builtin:session-spawn-human-gate", name: "Review Agent-Created Sessions", effect: "ask",
  priority: -1_000_000, builtin: true, scope: { toolName: "wollipog.create_session" },
});
const TOOL_POLICIES = [
  policy({ policyId: "allow-tests", name: "Allow Tests", priority: 10, scope: { toolName: "Bash" } }),
  BUILT_IN,
  policy({ policyId: "ask-deploys", name: "Ask Before Deploys", effect: "ask", priority: 50, askTimeout: 600 }),
  policy({
    policyId: "deny-shell", name: "Deny Shell", effect: "deny", priority: 50, scope: { runnerId: "prod", branch: "main" },
    conditions: { minCostUsd: 5, escalated: false },
  }),
];
const CUSTOM = policy({
  policyId: "questions:custom:notes:alice", name: "Release Notes", ownerUserId: "alice", scope: { organizationId: "org" },
  questionRule: { questionPattern: "May I draft*", answer: { option: "Yes" } },
});
const SOMEONE_ELSES = policy({
  policyId: "questions:custom:bob", name: "Bob's Policy", ownerUserId: "bob", scope: { organizationId: "org" },
  questionRule: { questionPattern: "*", answer: { text: "Yes" } },
});

interface Stub {
  client: ApiClient;
  writes: Omit<GovernancePolicy, "createdAt" | "updatedAt">[];
  loads: number;
  /** Fail the next N saves. */
  failSaves: number;
  failLoads: number;
}

function stub(policies: GovernancePolicy[]): Stub {
  const state: Stub = { writes: [], loads: 0, failSaves: 0, failLoads: 0, client: undefined as never };
  state.client = {
    ...api,
    governancePolicies: async () => {
      state.loads += 1;
      if (state.failLoads > 0) {
        state.failLoads -= 1;
        throw new Error("502 Bad Gateway");
      }
      return { policies: structuredClone(policies) };
    },
    getIdentity: async () => ({ context: OWNER }) as never,
    putGovernancePolicy: async (next) => {
      state.writes.push(next);
      if (state.failSaves > 0) {
        state.failSaves -= 1;
        throw new Error("Question policies require their owner");
      }
      const saved = { ...next, createdAt: 1, updatedAt: 3 } as GovernancePolicy;
      policies = [...policies.filter((p) => p.policyId !== saved.policyId), saved];
      return saved;
    },
  };
  return state;
}

async function mount(element: React.ReactNode, client?: ApiClient) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = async (next: React.ReactNode) => {
    await act(async () => root.render(client ? <ApiProvider client={client}>{next}</ApiProvider> : next));
    // Let the policy and identity requests settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await render(element);
  return { container, rerender: render, unmount: () => act(async () => root.unmount()) };
}

function group(container: HTMLElement, title: string): HTMLElement {
  const heading = [...container.querySelectorAll("h3")].find((element) => element.textContent === title);
  assert.ok(heading, `the ${title} group renders`);
  return heading.closest("section") as HTMLElement;
}

function switchNamed(scope: ParentNode, title: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("[role=switch]")].find((control) =>
    domWindow.document.getElementById(control.getAttribute("aria-labelledby") ?? "")?.textContent === title);
  assert.ok(match, `a switch named ${title}`);
  return match;
}

function rowTitles(scope: ParentNode): string[] {
  return [...scope.querySelectorAll(".ui-row-title")].map((element) => element.textContent ?? "");
}

test("Behavior no longer shows Question Response Style or Routine Question Policies", async () => {
  const { container } = await mount(<BehaviorPanel />);
  assert.doesNotMatch(container.textContent ?? "", /Question Response Style|Routine Question|Answer Questions In/);
});

test("Answer Questions In keeps a stored composer choice across the move and writes the same key", async () => {
  domWindow.localStorage.setItem(QUESTION_RESPONSE_STYLE_STORAGE_KEY, "composer");
  const { container } = await mount(<ApprovalsPanel />, stub([]).client);
  const answering = group(container, "Answering Questions");
  const radios = [...answering.querySelectorAll<HTMLElement>("[role=radio]")];
  assert.deepEqual(radios.map((radio) => radio.textContent), ["Form", "Composer"]);
  assert.equal(answering.querySelector("[role=radiogroup]")?.getAttribute("aria-label"), "Answer Questions In");
  assert.equal(radios[1]!.getAttribute("aria-checked"), "true", "the stored composer choice survives the move");
  assert.match(answering.textContent ?? "", /Saved on this device\./);
  await act(async () => radios[0]!.click());
  assert.equal(domWindow.localStorage.getItem(QUESTION_RESPONSE_STYLE_STORAGE_KEY), "interactive");
});

test("the section is three groups, and Routine Questions lists the starters then the person's custom policies", async () => {
  const api = stub([...TOOL_POLICIES, CUSTOM, SOMEONE_ELSES]);
  const { container } = await mount(<ApprovalsPanel />, api.client);
  assert.deepEqual([...container.querySelectorAll("h3")].map((heading) => heading.textContent),
    ["Answering Questions", "Routine Questions", "Tool Policies"]);
  const routine = group(container, "Routine Questions");
  assert.match(routine.querySelector(".settings-group-intro")?.textContent ?? "",
    /^Answer routine permission questions automatically in sessions you own\./);
  assert.deepEqual(rowTitles(routine),
    ["Review Sharing and Retries", "Push and Open Pull Requests", "Evidence Upload", "Release Notes"]);
  const custom = switchNamed(routine, "Release Notes");
  assert.equal(custom.querySelector(".status")?.textContent, "Custom");
  assert.equal(custom.getAttribute("aria-checked"), "true");
  assert.doesNotMatch(routine.textContent ?? "", /Bob's Policy/, "another person's question policy is not listed");
  assertNoDomNode(routine.querySelector('[role="alert"]'), "the bare alert paragraph is gone");

  await act(async () => custom.click());
  assert.deepEqual(api.writes.map((write) => [write.policyId, write.enabled]), [["questions:custom:notes:alice", false]],
    "the custom policy toggles through the same route");
  assert.equal(api.writes[0]!.questionRule?.questionPattern, "May I draft*", "the stored rule is sent back unchanged");
  assert.equal(switchNamed(routine, "Release Notes").getAttribute("aria-checked"), "false");
  assert.match(routine.textContent ?? "", /Saved/);
});

test("a failed save shows on that row with Try Again, keeps the real state and does not move the other rows", async () => {
  const api = stub(TOOL_POLICIES);
  const { container } = await mount(<ApprovalsPanel />, api.client);
  const routine = group(container, "Routine Questions");
  const before = rowTitles(routine);
  api.failSaves = 1;
  await act(async () => switchNamed(routine, "Push and Open Pull Requests").click());

  const failed = switchNamed(routine, "Push and Open Pull Requests");
  assert.equal(failed.getAttribute("aria-checked"), "false", "the switch shows its real, saved state");
  const row = failed.closest(".ui-row")!;
  assert.ok(row.classList.contains("ui-row-failed"));
  assert.equal(row.querySelector(".ui-row-failure")?.textContent, "Couldn't save this change. Try Again");
  assert.equal(domWindow.document.getElementById(failed.getAttribute("aria-describedby")!)?.textContent,
    "Couldn't save this change.", "the switch is described by the failure, not by Try Again");
  assert.equal(row.querySelectorAll(".ui-row-desc-slot.is-failed > .ui-row-desc").length, 2,
    "the description keeps its place under the failure, so the row keeps its height");
  assert.equal(routine.querySelectorAll(".ui-row-failure").length, 1, "only the row that failed changes");
  assert.deepEqual(rowTitles(routine), before);
  const announced = [...routine.querySelectorAll('[role="status"]')].map((region) => region.textContent).join("|");
  assert.match(announced, /Push and Open Pull Requests not saved\. .*Question policies require their owner/);

  await act(async () => (row.querySelector(".ui-row-retry") as HTMLButtonElement).click());
  assert.deepEqual(api.writes.map((write) => [write.policyId, write.enabled]),
    [["questions:push:alice", true], ["questions:push:alice", true]], "Try Again repeats the change that failed");
  assert.equal(routine.querySelectorAll(".ui-row-failure").length, 0);
  assert.equal(switchNamed(routine, "Push and Open Pull Requests").getAttribute("aria-checked"), "true");
});

test("tool policies list in priority order with effect and meta, and no control in the list writes", async () => {
  const api = stub([...TOOL_POLICIES, CUSTOM]);
  const { container } = await mount(<ApprovalsPanel />, api.client);
  const tools = group(container, "Tool Policies");
  assert.deepEqual(rowTitles(tools), ["Deny Shell", "Ask Before Deploys", "Allow Tests", "Review Agent-Created Sessions"],
    "highest priority first; at equal priority deny before ask; question policies excluded");
  const rows = [...tools.querySelectorAll<HTMLButtonElement>(".ui-row-nav")];
  assert.deepEqual(rows.map((row) => row.querySelector(".status")?.textContent), ["Deny", "Ask", "Allow", "Ask"]);
  assert.ok(rows.every((row) => row.querySelector(".status.t-neutral.no-dot")), "the effect label is neutral");
  assert.deepEqual([...rows[0]!.querySelectorAll(".policy-meta-item")].map((item) => item.textContent),
    ["Scope: one machine, branch main", "Conditions: cost at least $5.00, not escalated"]);
  assert.deepEqual([...rows[1]!.querySelectorAll(".policy-meta-item")].map((item) => item.textContent),
    ["Scope: every machine", "Timeout: 10 min"]);
  const builtIn = rows[3]!;
  assert.equal(builtIn.querySelector(".policy-meta-item")?.textContent, "Built In");
  assert.ok(builtIn.querySelector(".policy-meta-item svg"), "a built-in policy shows a lock");
  assert.equal(tools.querySelectorAll("[role=switch], input, select").length, 0, "the list has no switches or fields");
  assert.equal(builtIn.id, approvalsPolicyAnchorId(BUILT_IN.policyId), "each row carries the stable anchor");

  for (const row of rows) {
    await act(async () => row.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog, "activating a row opens Policy Details");
    assert.match(dialog.textContent ?? "", /Policy Details/);
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")];
    assert.deepEqual(buttons.map((button) => button.textContent), ["Done"], "a single Done");
    await act(async () => buttons[0]!.click());
  }
  await act(async () => rows[0]!.click());
  const facts = domWindow.document.querySelector('[role="dialog"] dl.facts')!;
  const terms = [...facts.querySelectorAll("dt")].map((term) => term.textContent);
  assert.deepEqual(terms, ["Name", "Effect", "Priority", "State", "Source", "Tool", "Organization", "Machine", "Workspace",
    "Agent", "Branch", "Conditions", "Policy ID", "Updated"]);
  assert.deepEqual([...facts.querySelectorAll("dd")].slice(0, -1).map((value) => value.textContent), ["Deny Shell", "Deny", "50", "On",
    "Saved on this control plane.", "Every tool", "Every organization", "prod", "Every workspace", "Every agent", "main",
    "Cost at least $5.00, not escalated", "deny-shell"]);
  assert.deepEqual(api.writes, [], "nothing in Tool Policies sends a PUT");
});

test("an empty tool policy list says what governs tool calls instead", async () => {
  const { container } = await mount(<ApprovalsPanel />, stub([]).client);
  assert.match(group(container, "Tool Policies").textContent ?? "",
    /No tool policies\. Every tool call follows the session's permission mode\./);
});

test("a failed load is one danger notice with Retry at the top, and Answering Questions still works", async () => {
  const api = stub(TOOL_POLICIES);
  api.failLoads = 1;
  const { container } = await mount(<ApprovalsPanel />, api.client);
  const notice = container.firstElementChild as HTMLElement;
  assert.ok(notice.classList.contains("notice"), "the notice is first in the section");
  assert.match(notice.textContent ?? "", /Couldn't Load Approvals/);
  assert.ok(group(container, "Answering Questions"));
  assert.equal([...container.querySelectorAll("h3")].length, 1, "the groups that need the policies wait for them");
  const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
  await act(async () => retry.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assert.equal(api.loads, 2);
  assertNoDomNode(container.querySelector(".notice"), "the notice leaves once the policies load");
  assert.ok(group(container, "Tool Policies"));
});

test("a linked policy id brings its row into view and focus", async () => {
  const scrolled: string[] = [];
  const original = domWindow.HTMLElement.prototype.scrollIntoView;
  domWindow.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
  try {
    const { container } = await mount(<ApprovalsPanel policyId="ask-deploys" />, stub(TOOL_POLICIES).client);
    const row = container.querySelector<HTMLElement>(`#${approvalsPolicyAnchorId("ask-deploys")}`)!;
    assert.deepEqual(scrolled, [row.id]);
    assert.equal(domWindow.document.activeElement, row);
    assert.ok(row.hasAttribute("data-targeted"));
  } finally {
    domWindow.HTMLElement.prototype.scrollIntoView = original;
  }
});

test("a linked question policy focuses its switch", async () => {
  const { container } = await mount(<ApprovalsPanel policyId="questions:custom:notes:alice" />, stub([CUSTOM]).client);
  const frame = container.querySelector<HTMLElement>(`#${approvalsPolicyAnchorId(CUSTOM.policyId)}`)!;
  assert.equal(domWindow.document.activeElement, frame.querySelector("[role=switch]"));
});

test("a custom policy whose id is a starter's category keeps its own busy, failure and retry state", async () => {
  const lookalike = policy({
    policyId: "review", name: "Lookalike", ownerUserId: "alice", scope: { organizationId: "org" },
    questionRule: { questionPattern: "*", answer: { text: "Yes" } },
  });
  const api = stub([lookalike]);
  const { container } = await mount(<ApprovalsPanel />, api.client);
  const routine = group(container, "Routine Questions");
  api.failSaves = 1;
  await act(async () => switchNamed(routine, "Lookalike").click());
  assert.equal(routine.querySelectorAll(".ui-row-failure").length, 1, "only the custom row fails");
  assert.ok(switchNamed(routine, "Lookalike").closest(".ui-row-failed"));
  assert.ok(!switchNamed(routine, "Review Sharing and Retries").closest(".ui-row-failed"));
  await act(async () => (routine.querySelector(".ui-row-retry") as HTMLButtonElement).click());
  assert.deepEqual(api.writes.map((write) => [write.policyId, write.enabled]), [["review", false], ["review", false]],
    "Try Again repeats the custom policy's change, not the starter's");
});

test("leaving a policy link and coming back to it scrolls to the row again", async () => {
  const scrolled: string[] = [];
  const original = domWindow.HTMLElement.prototype.scrollIntoView;
  domWindow.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) { scrolled.push(this.id); };
  try {
    const { rerender } = await mount(<ApprovalsPanel policyId="ask-deploys" />, stub(TOOL_POLICIES).client);
    await rerender(<ApprovalsPanel />);
    await rerender(<ApprovalsPanel policyId="ask-deploys" />);
    assert.deepEqual(scrolled, [approvalsPolicyAnchorId("ask-deploys"), approvalsPolicyAnchorId("ask-deploys")]);
  } finally {
    domWindow.HTMLElement.prototype.scrollIntoView = original;
  }
});

test("an organization selector is shown, since the control plane enforces it", async () => {
  const scoped = policy({ policyId: "org-deny", name: "Org Deny", effect: "deny", scope: { organizationId: "org-a" } });
  const { container } = await mount(<ApprovalsPanel />, stub([scoped]).client);
  const row = group(container, "Tool Policies").querySelector<HTMLButtonElement>(".ui-row-nav")!;
  assert.deepEqual([...row.querySelectorAll(".policy-meta-item")].map((item) => item.textContent),
    ["Scope: every machine, one organization"]);
  await act(async () => row.click());
  const facts = [...document.querySelectorAll('[role="dialog"] dl.facts > div')].map((pair) => pair.textContent);
  assert.ok(facts.includes("Organizationorg-a"));
});
