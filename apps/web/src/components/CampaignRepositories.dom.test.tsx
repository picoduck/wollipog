import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROJECT_LOCATION_INSPECTION_FAILURES, type CampaignRepositoryBoundaryView } from "@wollipog/protocol";
import { api, ApiError } from "../api.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { CampaignRepositories } from "./CampaignRepositories.js";

const dom = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event, Node: dom.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const boundary: CampaignRepositoryBoundaryView = {
  revision: 6,
  repositories: [
    { repository: "picoduck/wollipog", locations: [
      { locationId: "loc_laptop", name: "Wollipog on Laptop", availability: "available", isDefault: true },
      { locationId: "loc_desk", name: "Wollipog on Desk", availability: "runner_offline", isDefault: false },
    ] },
    { repository: "picoduck/dev-box-setup", locations: [
      { locationId: "loc_setup", name: "Dev Box Setup", availability: "removed", isDefault: false },
    ] },
  ],
  excludedLocations: [{ locationId: "loc_notes", name: "Notes Folder", failure: "not_repository", reason: PROJECT_LOCATION_INSPECTION_FAILURES.not_repository }],
  pendingLocations: [{ locationId: "loc_shared", name: "Shared Docs", reason: "added_by_other" }],
  joins: [{ locationId: "loc_desk", name: "Wollipog on Desk", repository: "picoduck/wollipog", revision: 6, at: 1, source: "owner_added" }],
};

async function render(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, unmount: () => { act(() => root.unmount()); container.remove(); } };
}

const includeButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Include Shared Docs in Campaign"]');

test("Repositories lists each boundary repository's Locations, exclusions and Locations waiting for the owner (#4117)", async () => {
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" boundary={boundary} canInclude />);
  try {
    assert.equal(container.querySelector("h3")!.textContent, "Repositories");
    const terms = [...container.querySelectorAll("dt")].map((node) => node.textContent);
    assert.deepEqual(terms, ["picoduck/wollipog", "picoduck/dev-box-setup", "Boundary Revision"]);
    const first = container.querySelector('ul[aria-label="Locations of picoduck/wollipog"]')!;
    assert.match(first.textContent!, /Wollipog on Laptop Default Available/);
    assert.match(first.textContent!, /Wollipog on Desk Runner Offline/);
    assert.match(first.textContent!, /Joined at boundary revision 6\./);
    const second = container.querySelector('ul[aria-label="Locations of picoduck/dev-box-setup"]')!;
    assert.match(second.textContent!, /Dev Box Setup Removed/);
    assert.match(container.textContent!, /No Location of this repository is available/);
    const excluded = container.querySelector('ul[aria-label="Excluded Locations"]')!;
    assert.equal(excluded.textContent, `Notes Folder${PROJECT_LOCATION_INSPECTION_FAILURES.not_repository}`);
    const headings = [...container.querySelectorAll("h4")].map((node) => node.textContent);
    assert.deepEqual(headings, ["Excluded Locations", "Waiting to Be Included"]);
    const button = includeButton(container);
    assert.ok(button, "the owner's campaign session offers Include in Campaign");
    assert.equal(button.textContent, "Include in Campaign");
  } finally { unmount(); }
});

test("a Location the owner's first message left out is shown as available, with no way to include it here (#4117)", async () => {
  const limited: CampaignRepositoryBoundaryView = { ...boundary, excludedLocations: [], pendingLocations: [],
    availableLocations: [{ locationId: "loc_docs", name: "Shared Docs", repository: "picoduck/shared-docs" }],
    repositoryLimits: ["picoduck/wollipog", "picoduck/dev-box-setup"] };
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" boundary={limited} canInclude />);
  try {
    assert.deepEqual([...container.querySelectorAll("h4")].map((node) => node.textContent), ["Available but Not in This Campaign"]);
    assert.match(container.textContent!, /Your first message limited this campaign to picoduck\/wollipog, picoduck\/dev-box-setup\./);
    assert.match(container.textContent!, /they join only if the Orchestrator asks to add their repository and you approve it/);
    const list = container.querySelector('ul[aria-label="Locations Available but Not in This Campaign"]')!;
    assert.equal(list.textContent, "Shared Docspicoduck/shared-docs");
    assertNoDomNode(includeButton(container), "only an approved addition brings it in");
    assertNoDomNode(list.querySelector("button"), "a left-out Location has no action");
  } finally { unmount(); }
  // A control plane before v320 sends neither field.
  const older = await render(<CampaignRepositories campaignId="s_root" boundary={{ ...boundary, excludedLocations: [], pendingLocations: [] }} canInclude />);
  try {
    assertNoDomNode(older.container.querySelector("h4"), "nothing is left out");
  } finally { older.unmount(); }
});

test("Include in Campaign asks the server, and a refusal is shown (#4117)", async () => {
  const original = api.includeCampaignLocation;
  const calls: Array<[string, string]> = [];
  api.includeCampaignLocation = async (id, locationId) => { calls.push([id, locationId]); return { joined: true, revision: 7 }; };
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" boundary={boundary} canInclude />);
  try {
    await act(async () => { includeButton(container)!.click(); });
    assert.deepEqual(calls, [["s_root", "loc_shared"]]);
    assertNoDomNode(container.querySelector('[role="alert"]'), "an accepted inclusion shows no error");
    api.includeCampaignLocation = async () => { throw new ApiError("Only the campaign's owner can include a Location in it.", 403); };
    await act(async () => { includeButton(container)!.click(); });
    const alert = container.querySelector('[role="alert"]')!;
    assert.match(alert.textContent!, /Couldn't Include the Location/);
    assert.match(alert.textContent!, /Only the campaign's owner/);
  } finally { api.includeCampaignLocation = original; unmount(); }
});

test("a member's view shows the boundary without Include in Campaign (#4117)", async () => {
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" boundary={boundary} canInclude={false} />);
  try {
    assertNoDomNode(includeButton(container), "a member's view offers no Include in Campaign");
    assert.match(container.textContent!, /Shared Docs/);
  } finally { unmount(); }
});
