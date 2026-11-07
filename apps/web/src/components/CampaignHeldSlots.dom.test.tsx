import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CampaignHeldSlot, CampaignSlotRelease } from "@wollipog/protocol";
import { api, ApiError } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignHeldSlots } from "./CampaignHeldSlots.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const NOW = 1_794_040_000_000;
const held: CampaignHeldSlot[] = [
  { sessionId: "s_worker_a", title: "Implement #4145", generation: "gen-a", reason: "older_runner", status: "failed" },
  { sessionId: "s_worker_b", title: null, generation: "gen-b", reason: "unsupported_location", status: "stopped" },
];
const record: CampaignSlotRelease = { sessionId: "s_worker_c", title: "Implement #4054", generation: "gen-c",
  releasedByUserId: "usr_owner", releasedByName: "Sam Owner", releasedAt: NOW - 3 * 60_000, reason: "Rebooted the host",
  heldReason: "fence_without_evidence", settlement: { costUsd: 0.7, toolCalls: 12, source: "checkpoint" } };

function setInput(input: HTMLInputElement, text: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new dom.InputEvent("input", { bubbles: true }) as unknown as Event);
  input.dispatchEvent(new dom.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
}

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

const named = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
const link = (sessionId: string) => <a href={`/s/${sessionId}`}>{sessionId}</a>;

test("Held Slots names each held worker and why, and a release needs a confirmation with the person's reason (#4331)", async () => {
  const original = api.releaseCampaignSlot;
  const calls: Array<[string, unknown]> = [];
  let refuse = true;
  api.releaseCampaignSlot = async (campaignId, request) => {
    calls.push([campaignId, request]);
    if (refuse) throw new ApiError("This slot can't be released by a person: the worker is still running or stopping.", 409);
    return { ...record, sessionId: request.sessionId, title: "Implement #4145", generation: request.generation, reason: request.reason,
      heldReason: "older_runner", releasedAt: NOW };
  };
  const view = await render(<CampaignHeldSlots campaignId="root-1" budget={{ heldSlots: held, slotReleases: [record] }} canAct now={NOW}
    onOpenSession={link} />);
  try {
    const { container } = view;
    assert.deepEqual([...container.querySelectorAll("h3, h4")].map((node) => node.textContent), ["Held Slots", "Released Slots"]);
    assert.deepEqual([...container.querySelectorAll("dt")].map((node) => node.textContent), ["Implement #4145", "s_worker_b", "Implement #4054"]);
    assert.match(container.textContent ?? "", /Failed\. Its runner is too old to prove that the provider is gone\./);
    assert.match(container.textContent ?? "", /Its provider ran where the runner can't check it, such as WSL, a container or a cloud machine\./);
    assert.match(container.textContent ?? "", /Released by Sam Owner 3m ago“Rebooted the host”/);
    assert.match(container.textContent ?? "", /Settled at \$0\.70, 12 tool calls, from the runner's final usage\./);

    // Each action's accessible name matches its visible Title Case label and names the worker.
    const open = named(container, "Release Slot: Implement #4145");
    assert.ok(open);
    assert.equal(open.textContent, "Release Slot");
    assert.ok(named(container, "Release Slot: s_worker_b"), "an untitled worker is named by its session");
    await act(async () => open.click());
    assert.equal(container.querySelector("legend")?.textContent, "Release Slot: Implement #4145");
    assert.match(container.textContent ?? "", /Releasing stops nothing: a provider that is still running keeps running outside the campaign's\s+concurrency allowance\./);
    assert.equal(container.querySelector("label span")?.textContent, "How You Checked");
    const input = container.querySelector<HTMLInputElement>("input[type=text]")!;
    const confirm = () => [...container.querySelectorAll<HTMLButtonElement>("fieldset button[aria-label='Release Slot: Implement #4145']")][0]!;

    await act(async () => confirm().click());
    assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /Say how you checked that the worker's provider is gone\./);
    assert.equal(calls.length, 0, "no reason, no request");

    await act(async () => setInput(input, "  Rebooted the host  "));
    await act(async () => confirm().click());
    assert.deepEqual(calls, [["root-1", { sessionId: "s_worker_a", generation: "gen-a", reason: "Rebooted the host" }]],
      "it names the worker and the exact generation it was shown");
    assert.match(container.querySelector("[role=alert]")?.textContent ?? "", /still running or stopping/, "the server's refusal is shown");
    assert.ok(container.querySelector("legend"), "and the confirmation stays open");

    refuse = false;
    await act(async () => confirm().click());
    assertNoDomNode(container.querySelector("legend"), "the confirmation closes");
    assert.match(container.querySelector("[role=status]")?.textContent ?? "", /Slot ReleasedImplement #4145's slot is free, and its reservation settled\./);
  } finally {
    view.unmount();
    api.releaseCampaignSlot = original;
  }
});

test("a member's view shows held slots without the release, and nothing renders when no slot is held (#4331)", async () => {
  const member = await render(<CampaignHeldSlots campaignId="root-1" budget={{ heldSlots: held }} canAct={false} now={NOW} onOpenSession={link} />);
  try {
    assert.equal(member.container.querySelector("h3")?.textContent, "Held Slots");
    assertNoDomNode(member.container.querySelector("button"), "only the campaign's own view offers it");
  } finally { member.unmount(); }
  const empty = await render(<CampaignHeldSlots campaignId="root-1" budget={{}} canAct now={NOW} onOpenSession={link} />);
  try {
    assert.equal(empty.container.innerHTML, "");
  } finally { empty.unmount(); }
});
