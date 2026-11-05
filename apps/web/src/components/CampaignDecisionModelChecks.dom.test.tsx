import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignDecisionsResponse } from "@wollipog/protocol";
import { api } from "../api.js";
import { CampaignDecisionModelChecks } from "./CampaignDecisionModelChecks.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 0 };
const decision = (occurrenceId: string, extra: Partial<CampaignDecisionsResponse["decisions"][number]>): CampaignDecisionsResponse["decisions"][number] => ({
  occurrenceId, kind: "credential_screen", promptVersion: "credential_screen.v1", state: "decided", inputDigests: {}, attempts: [],
  usage, createdAt: 1, subject: { sessionId: "child-1", surface: "implementation_question", requestId: occurrenceId }, ...extra,
});

function facts(item: Element): Record<string, string> {
  return Object.fromEntries([...item.querySelectorAll("dt")].map((dt) => [dt.textContent ?? "", dt.nextElementSibling?.textContent ?? ""]));
}

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

test("Campaign Status shows each screen's verdict, reason and failure beside the request, and the owner only classifies a failed one (#4104)", async () => {
  const read = api.campaignDecisions;
  const classify = api.classifyCampaignDecision;
  const classified: Array<[string, string, string]> = [];
  let decisions = [
    decision("dec_ok", { verdict: "discusses", reason: "It asks which keyboard keys to show." }),
    decision("dec_ask", { verdict: "ask", reason: "It asks for the token's value.", subject: { sessionId: "child-1", surface: "provider_question", requestId: "q-1" } }),
    decision("dec_failed", { state: "failed", failureClass: "timed_out" }),
    decision("probe", { kind: "probe", verdict: "confirm" }),
  ];
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions, usage: { ...usage, calls: decisions.length, unpricedCalls: 0 } });
  api.classifyCampaignDecision = async (id, occurrenceId, classification) => {
    classified.push([id, occurrenceId, classification]);
    decisions = decisions.map((item) => item.occurrenceId === occurrenceId ? { ...item, subject: { ...item.subject!, classification } } : item);
    return decisions.find((item) => item.occurrenceId === occurrenceId)!.subject!;
  };
  const opened: string[] = [];
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={(id) => opened.push(id)} />);
  try {
    const { container } = view;
    assert.equal(container.querySelector("h3")?.textContent, "Question Screen");
    const items = [...container.querySelectorAll("li")];
    assert.equal(items.length, 3, "only the question screen's checks");
    assert.deepEqual(facts(items[0]!), { "Implementation Question": "Open SessionThe Orchestrator decides it.", Verdict: "Only Discusses",
      Reason: "It asks which keyboard keys to show." });
    assert.deepEqual(facts(items[1]!), { "Provider Question": "Open SessionDeclined and recorded as blocked work.", Verdict: "Asks for Access",
      Reason: "It asks for the token's value." });
    assert.deepEqual(facts(items[2]!), { "Implementation Question": "Open SessionWaiting for you to classify it.", Verdict: "None", Failure: "Timed Out" });
    const buttons = (item: Element) => [...item.querySelectorAll("button")].map((node) => node.textContent);
    assert.deepEqual(buttons(items[0]!), ["Open Session"], "a settled check offers no classification");
    assert.deepEqual(buttons(items[2]!), ["Open Session", "Decline", "Let the Orchestrator Answer"]);
    await act(async () => { [...items[2]!.querySelectorAll("button")].find((node) => node.textContent === "Let the Orchestrator Answer")!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(classified, [["root-1", "dec_failed", "orchestrator"]]);
    const after = [...container.querySelectorAll("li")][2]!;
    assert.equal(facts(after)["Implementation Question"], "Open SessionYou let the Orchestrator answer it.");
    assert.deepEqual(buttons(after), ["Open Session"]);
    await act(async () => { (after.querySelector("button") as HTMLButtonElement).click(); });
    assert.deepEqual(opened, ["child-1"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
    api.classifyCampaignDecision = classify;
  }
});

test("an owner decision whose screen failed stays the owner's: they decline it or answer it themselves", async () => {
  const read = api.campaignDecisions;
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [decision("dec_owner", { state: "uncertain", verdict: "uncertain",
    reason: "It may ask the owner to sign in.", subject: { sessionId: "root-1", surface: "owner_decision", requestId: "ask-owner" } })],
    usage: { ...usage, calls: 1, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="root-1" canClassify refreshKey={1} onOpenSession={() => {}} />);
  try {
    const item = view.container.querySelector("li")!;
    assert.equal(facts(item)["Owner Decision"], "Open SessionWaiting for you to classify it.");
    assert.deepEqual([...item.querySelectorAll("button")].map((node) => node.textContent), ["Open Session", "Decline", "Let Me Answer"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});

test("a member session sees the checks but never the classification buttons", async () => {
  const read = api.campaignDecisions;
  api.campaignDecisions = async (id) => ({ campaignSessionId: id, decisions: [decision("dec_failed", { state: "uncertain", verdict: "uncertain", reason: "Unclear." })],
    usage: { ...usage, calls: 1, unpricedCalls: 0 } });
  const view = await render(<CampaignDecisionModelChecks sessionId="child-1" canClassify={false} refreshKey={1} onOpenSession={() => {}} />);
  try {
    const item = view.container.querySelector("li")!;
    assert.equal(facts(item).Verdict, "Uncertain");
    assert.deepEqual([...item.querySelectorAll("button")].map((node) => node.textContent), ["Open Session"]);
  } finally {
    view.unmount();
    api.campaignDecisions = read;
  }
});
