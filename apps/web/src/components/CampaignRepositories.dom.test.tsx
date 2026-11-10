import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { CAMPAIGN_LIMITED_LOCATION_REASON, PROJECT_LOCATION_INSPECTION_FAILURES, type CampaignRepositoryBoundaryView } from "@wollipog/protocol";
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
  excludedLocations: [{ locationId: "loc_notes", name: "Notes Folder", failure: "not_repository", reason: PROJECT_LOCATION_INSPECTION_FAILURES.not_repository },
    { locationId: "loc_away", name: "Away Machine", failure: "runner_offline", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_offline },
    { locationId: "loc_old", name: "Old Machine", failure: "runner_too_old", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_too_old }],
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
    // Each one names its own specific reason, whichever way it failed.
    assert.deepEqual([...excluded.querySelectorAll("li")].map((item) => item.textContent), [`Notes Folder${PROJECT_LOCATION_INSPECTION_FAILURES.not_repository}`,
      `Away Machine${PROJECT_LOCATION_INSPECTION_FAILURES.runner_offline}`, `Old Machine${PROJECT_LOCATION_INSPECTION_FAILURES.runner_too_old}`]);
    const headings = [...container.querySelectorAll("h4")].map((node) => node.textContent);
    assert.deepEqual(headings, ["Excluded Locations", "Waiting to Be Included"]);
    const button = includeButton(container);
    assert.ok(button, "the owner's campaign session offers Include in Campaign");
    assert.equal(button.textContent, "Include in Campaign");
  } finally { unmount(); }
});

test("each waiting Location says why it waits, as recorded, and an entry stored before claims nothing (#4312)", async () => {
  const waiting: CampaignRepositoryBoundaryView = { ...boundary, excludedLocations: [], pendingLocations: [
    { locationId: "loc_theirs", name: "Their Folder", reason: "added_by_other", cause: "added_by_other" },
    { locationId: "loc_nobody", name: "Old Folder", reason: "added_by_other", cause: "no_recorded_adder" },
    { locationId: "loc_sibling", name: "Second Checkout", reason: "added_by_other", cause: "repository_added" },
    { locationId: "loc_owner", name: "My Folder", reason: "added_by_other", cause: "owner_added" },
    { locationId: "loc_stored", name: "Stored Folder", reason: "added_by_other" },
  ] };
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" boundary={waiting} canInclude />);
  try {
    const section = container.querySelector('ul[aria-label="Locations Waiting to Be Included"]')!;
    const rows = Object.fromEntries([...section.querySelectorAll("li")].map((row) => [row.firstChild!.textContent!.trim(),
      row.querySelector(".campaign-status-meta")?.textContent ?? null]));
    assert.deepEqual(rows, {
      "Their Folder": "Someone other than the campaign's owner added this Location to the Project.",
      "Old Folder": "No one is recorded as having added this Location to the Project.",
      "Second Checkout": "The campaign's owner approved adding another Location of its repository, and this one wasn't part of that approval.",
      "My Folder": "The campaign's owner added this Location, and it hasn't joined on its own.",
      "Stored Folder": null,
    });
    // The note says only how they join, true of every row, whoever added it.
    const note = container.querySelector('ul[aria-label="Locations Waiting to Be Included"]')!.previousElementSibling!;
    assert.equal(note.textContent, "These Locations join this campaign only when its owner includes them.");
    assert.doesNotMatch(container.textContent!, /Someone else added these Locations/);
    // Each still joins only through its own Include in Campaign, named for it.
    for (const name of ["Their Folder", "Old Folder", "Second Checkout", "My Folder", "Stored Folder"]) {
      const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Include ${name} in Campaign"]`);
      assert.ok(button, name);
      assert.equal(button.textContent, "Include in Campaign");
    }
  } finally { unmount(); }
});

test("a limited launch Location says why under its row, and a left-out Location names its repository (#4319)", async () => {
  const { container, unmount } = await render(<CampaignRepositories campaignId="s_root" canInclude boundary={{ ...boundary,
    limitedLocations: [{ locationId: "loc_desk", name: "Wollipog on Desk", reason: CAMPAIGN_LIMITED_LOCATION_REASON }],
    excludedLocations: [{ locationId: "loc_old", name: "Old Machine", failure: "runner_below_gates", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_below_gates, repository: "owner/old" }] }} />);
  try {
    const rows = [...container.querySelector('ul[aria-label="Locations of picoduck/wollipog"]')!.querySelectorAll("li")];
    assert.ok(rows.find((row) => row.textContent!.includes("Wollipog on Desk"))!.textContent!.includes(CAMPAIGN_LIMITED_LOCATION_REASON));
    assert.equal(rows.some((row) => !row.textContent!.includes("Wollipog on Desk") && row.textContent!.includes(CAMPAIGN_LIMITED_LOCATION_REASON)), false);
    assert.equal(container.querySelector('ul[aria-label="Excluded Locations"] li')!.textContent, `Old Machineowner/old${PROJECT_LOCATION_INSPECTION_FAILURES.runner_below_gates}`);
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
