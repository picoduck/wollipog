import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { LocationSwitchSnapshot, PendingApproval, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../../api.js";
import { ApiProvider } from "../../api-context.js";
import { installDomTestCleanup } from "../../dom-test-cleanup.js";
import { RequestCard, type RequestIntentHandler } from "./RequestCard.js";
import { WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";
import { locationSwitchOptions } from "./LocationSwitchSummary.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

function snapshot(locations: number): LocationSwitchSnapshot {
  const candidates = Array.from({ length: locations }, (_, index) => ({
    locationId: `loc-${index + 1}`, name: index === 0 ? "Docs Site" : "Docs Site (Laptop)", runnerId: index === 0 ? "runner-1" : "laptop",
    machineName: index === 0 ? "Workstation" : "Laptop", workspaceId: `docs-${index + 1}`, path: `/src/docs-${index + 1}`,
    repository: "acme/docs", sameRunner: index === 0, actions: ["new_session" as const],
  }));
  return {
    category: "location_switch", repository: "acme/docs", reason: "Issue acme/docs#12 lives in the documentation repository.",
    handoff: "Fix the broken link in the install guide (acme/docs#12). Nothing is done yet.", trigger: "early",
    projectId: "project", projectName: "Acme",
    current: { locationId: "loc-app", name: "App", runnerId: "runner-1", machineName: "Workstation", workspaceId: "app", path: "/src/app", repository: "acme/app" },
    candidates,
    unavailable: [{ locationId: "loc-old", name: "Docs Mirror", machineName: "Server", reason: "The Location's machine is offline." }],
    options: candidates.map((candidate) => ({ optionId: `new_session:${candidate.locationId}`, label: "Start a New Session",
      description: `${candidate.name} on ${candidate.machineName}` })),
    targetDigest: "a".repeat(64), expiresAt: Date.now() + 60_000,
  };
}

function request(locations: number): PendingApproval {
  const resourceSnapshot = snapshot(locations);
  return {
    requestId: "switch", occurrenceId: "switch", kind: "workflow_decision", title: "Location Switch Approval Required",
    context: { toolName: "Typed Workflow Decision", input: JSON.stringify(resourceSnapshot) },
    options: [
      ...resourceSnapshot.options.map((option) => ({ optionId: option.optionId, name: option.label, description: option.description, kind: "allow_once" as const })),
      { optionId: "__workflow_deny__", name: "Stay Here", kind: "reject_once" },
    ],
    workflowDecision: {
      requestId: "switch", occurrenceId: "switch", sessionId: "session-dock", controllingSessionId: "session-dock",
      category: "location_switch", resourceKey: "location_switch:acme/docs", resourceSnapshot,
      resourceDigest: "d".repeat(64), policyRevision: 0, authority: "human", status: "pending", createdAt: 1,
    },
  } as PendingApproval;
}

const session = (pending: PendingApproval | null) => ({ id: "session-dock", runnerId: "runner-1", title: "App Session",
  status: pending ? "input_required" : "running", agentName: "Claude Code", driver: "claude-code", pendingApproval: pending } as SessionView);

async function render(element: React.ReactElement, client: Partial<ApiClient> = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const fullClient = { ...api, governancePolicies: async () => ({ policies: [] }), ...client } as ApiClient;
  await act(async () => { root.render(<ApiProvider client={fullClient}>{element}</ApiProvider>); await tick(); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const footer = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")].map((button) =>
  `${button.getAttribute("aria-label") ?? button.textContent}${button.classList.contains("primary") ? " (primary)" : ""}`);

test("a Location switch names both repositories, where the session is and where it would continue, and offers Stay Here", async () => {
  const pending = request(1);
  const decisions: unknown[] = [];
  const view = await render(<RequestCard session={session(pending)} request={pending} runnerOnline presentation="dock" />,
    { approve: async (_id, body) => { decisions.push(body); return session(null); } });
  try {
    const text = view.container.textContent ?? "";
    assert.match(text, /This task belongs to repository acme\/docs\. This session is currently in repository acme\/app\./u);
    assert.match(text, /Current Location.*App.*acme\/app.*Workstation.*\/src\/app/su);
    assert.match(text, /Proposed Location.*Docs Site.*acme\/docs.*Workstation.*\/src\/docs-1/su);
    assert.match(text, /Docs Mirror on Server: The Location's machine is offline\./u);
    assert.deepEqual(footer(view.container), ["Stay Here", "Start a New Session (primary)"]);
    // The agent's handoff is readable before approving, and the raw request JSON is not repeated.
    const disclosures = [...view.container.querySelectorAll("details.disclosure summary")].map((summary) => summary.textContent);
    assert.deepEqual(disclosures, ["Task Handoff"]);
    await act(async () => { [...view.container.querySelectorAll<HTMLButtonElement>(".request-card-foot > button")][0]!.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "switch", optionId: "__workflow_deny__" }]);
  } finally {
    await view.unmount();
  }
});

test("several matching Locations need a choice, and every control, including A, acts only on the chosen one", async () => {
  const pending = request(2);
  const decisions: unknown[] = [];
  function Harness() {
    const intentRef = useRef<RequestIntentHandler | null>(null);
    return <>
      <RequestCard session={session(pending)} request={pending} runnerOnline presentation="dock" showKeyHints intentRef={intentRef} />
      <button type="button" data-press-a="" onClick={() => intentRef.current?.("approve")}>Press A</button>
    </>;
  }
  const view = await render(<Harness />, { approve: async (_id, body) => { decisions.push(body); return session(null); } });
  try {
    const group = view.container.querySelector("[role=radiogroup]")!;
    assert.equal(group.getAttribute("aria-label"), "Choose a Location");
    const radios = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")];
    assert.equal(radios.length, 2);
    assert.equal(radios[0]!.checked, true, "the Project's first matching Location is chosen until the person picks another");
    assert.deepEqual(footer(view.container), ["Stay HereD", "Start a New SessionA (primary)"]);
    await act(async () => { radios[1]!.click(); await tick(); });
    await act(async () => { view.container.querySelector<HTMLButtonElement>("[data-press-a]")!.click(); await tick(); });
    assert.deepEqual(decisions, [{ requestId: "switch", optionId: "new_session:loc-2" }]);
  } finally {
    await view.unmount();
  }
});

test("the card's options for a Location are its own actions and Stay Here, never another Location's", () => {
  const options = request(2).options;
  assert.deepEqual(locationSwitchOptions(options, "loc-2").map((option) => option.optionId), ["new_session:loc-2", "__workflow_deny__"]);
  assert.deepEqual(locationSwitchOptions(options, null).map((option) => option.optionId), ["__workflow_deny__"]);
});

test("the read-only summary shows the same facts without a chooser", async () => {
  const view = await render(<WorkflowDecisionSummary snapshot={snapshot(2)} />);
  try {
    assert.equal(view.container.querySelector("[role=radiogroup]"), null);
    assert.match(view.container.textContent ?? "", /Proposed Location.*Docs Site/su);
  } finally {
    await view.unmount();
  }
});
