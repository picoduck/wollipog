import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AccessScopeChangePreview,
  IdentityAdministrationView,
  ProjectLocationView,
  ProjectView,
  ResourceOwner,
  ResourceScope,
  RunnerView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import type { ProjectLocationCandidate } from "../project-management.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";

/**
 * Add Location (#2966): one Existing Location | New Folder switch, one surface of radio rows with
 * no button of their own, the chosen row's offline and access warnings, New Folder's Machine Select
 * with the folder browser under it, onboarding, and the states that replaced the old cards.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const ORG = "org-1";
const scopeOf = (owner: ResourceOwner): ResourceScope => ({ organizationId: ORG, owner });
const organizationScope = scopeOf({ kind: "organization", organizationId: ORG });
const buildersScope = scopeOf({ kind: "team", teamId: "team-builders" });

const identity: IdentityAdministrationView = {
  context: {
    userId: "user-me", userName: "Me", organizationId: ORG, organizationName: "Org", role: "admin",
    deviceId: "device", localBootstrap: false,
  },
  organizations: [{ organizationId: ORG, name: "Org", createdAt: 1 }],
  memberships: [
    { organizationId: ORG, organizationName: "Org", userId: "user-me", userName: "Me", userStatus: "active", role: "admin", createdAt: 1 },
  ],
  teams: [
    { teamId: "team-builders", organizationId: ORG, name: "Builders", memberUserIds: ["user-me", "user-two"], createdAt: 1 },
  ],
};

const location = (projectId: string, workspaceId: string, name: string, path: string): ProjectLocationView => ({
  id: `location-${projectId}-${workspaceId}`, projectId, runnerId: "runner-1", workspaceId, name, path,
  source: "managed", availability: "available", isDefault: false, createdAt: 1, updatedAt: 1,
  scope: organizationScope, canManage: true,
});

const project: ProjectView = {
  id: "project-1",
  name: "Project One",
  hidden: false,
  scope: organizationScope,
  canManage: true,
  locations: [location("project-1", "added", "Already Here", "/repos/already-here")],
  activeSessionCount: 0,
  unarchivedSessionCount: 0,
  totalSessionCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const otherProject: ProjectView = {
  ...project,
  id: "project-2",
  name: "Storefront",
  locations: [location("project-2", "shared", "Shared Checkout", "/repos/shared")],
};

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "studio",
  displayName: "Studio Mac",
  os: "linux",
  version: "1",
  status: "online",
  scope: organizationScope,
  agents: [],
  workspaces: [
    { id: "added", name: "Already Here", path: "/repos/already-here", scope: organizationScope, canManage: true },
    { id: "loose", name: "Loose Checkout", path: "/repos/loose", scope: organizationScope, canManage: true },
    { id: "shared", name: "Shared Checkout", path: "/repos/shared", scope: organizationScope, canManage: true },
    { id: "billing", name: "Billing Service", path: "/repos/billing", scope: buildersScope, canManage: true },
  ],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 200,
};

const offlineRunner: RunnerView = {
  ...runner,
  runnerId: "runner-2",
  hostname: "build",
  displayName: "Build Box",
  status: "offline",
  workspaces: [{ id: "docs", name: "Docs Site", path: "/srv/docs-site", scope: organizationScope, canManage: true }],
};

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const body = () => domWindow.document.body as unknown as HTMLElement;
const dialog = (name = "Add Location to Project One") => [...body().querySelectorAll<HTMLElement>('[role="dialog"]')]
  .find((element) => text(element.querySelector(".modal-title, h2")) === name) ?? null;
const footer = () => dialog()!.querySelector<HTMLElement>(".modal-foot")!;
const addButton = () => [...footer().querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => text(button) === "Add Location")!;
const rowNamed = (name: string) => [...dialog()!.querySelectorAll<HTMLElement>(".add-location-list .choice-row")]
  .find((row) => text(row.querySelector(".choice-row-title")).startsWith(name)) ?? null;
const settle = () => act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });

interface Rendered {
  added: ProjectLocationCandidate[];
  /** Each add's `generateSetup`. */
  generated: boolean[];
  created: unknown[];
  closed: () => number;
  unmount: () => Promise<void>;
}

async function render(options: {
  client?: Partial<ApiClient>;
  runners?: RunnerView[];
  projects?: ProjectView[];
  canCreateLocation?: boolean;
  onboarding?: boolean;
  setupFileSupported?: boolean;
  onAdd?: (candidate: ProjectLocationCandidate) => Promise<void>;
  onCreate?: () => Promise<void>;
} = {}): Promise<Rendered> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const added: ProjectLocationCandidate[] = [];
  const generated: boolean[] = [];
  const created: unknown[] = [];
  let closed = 0;
  const client = { ...api, getIdentity: async () => identity, ...options.client } as ApiClient;
  const runners = options.runners ?? [runner, offlineRunner];
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <ProjectLocationDialog
          project={project}
          projects={options.projects ?? [project, otherProject]}
          runners={new Map(runners.map((value) => [value.runnerId, value]))}
          boxes={new Map()}
          canCreateLocation={options.canCreateLocation ?? true}
          accessScopeManagementSupported
          onboarding={options.onboarding}
          setupFileSupported={options.setupFileSupported}
          onClose={() => { closed += 1; }}
          onAdd={async (candidate, generateSetup) => {
            added.push(candidate);
            generated.push(generateSetup);
            await options.onAdd?.(candidate);
          }}
          onCreate={async (value, generateSetup) => {
            created.push({ ...value, generateSetup });
            await options.onCreate?.();
          }}
          onManageConnections={() => {}}
        />
      </ApiProvider>,
    );
  });
  await settle();
  return {
    added,
    generated,
    created,
    closed: () => closed,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      mountPoint.remove();
    },
  };
}

async function choose(name: string) {
  const input = rowNamed(name)?.querySelector<HTMLInputElement>('input[type="radio"]');
  assert.ok(input, `${name} has a radio`);
  await act(async () => { input.click(); });
}

test("the footer has Cancel and one Add Location, and no candidate row has a button of its own", async () => {
  const view = await render();
  try {
    assert.deepEqual([...footer().querySelectorAll("button")].map(text), ["Cancel", "Add Location"]);
    const list = dialog()!.querySelector(".add-location-list");
    assert.ok(list && list.classList.contains("surface"), "the rows are one surface (§5.1)");
    assert.equal(list.querySelectorAll("button").length, 0, "no per-row commit button");
    assert.deepEqual([...list.querySelectorAll(".choice-row-title")].map((title) => text(title).split(/(Available|Runner Offline)/u)[0]),
      ["Already Here", "Billing Service", "Loose Checkout", "Shared Checkout", "Docs Site"]);
    assert.equal(addButton().disabled, true, "nothing is chosen yet");
    assert.equal(text(footer().querySelector(".add-location-reason")), "Choose a location or a folder.");
    // The machine, then the path in mono, cut from its start (§11.3).
    const loose = rowNamed("Loose Checkout")!;
    assert.equal(text(loose.querySelector(".add-location-machine")), "Studio Mac");
    assert.equal(loose.querySelector(".add-location-path")?.getAttribute("title"), "/repos/loose");
    assert.equal(text(rowNamed("Shared Checkout")!.querySelector(".choice-row-meta")), "Used by Storefront");
    assertNoDomNode(dialog()!.querySelector("select"), "no native select");
    const seg = dialog()!.querySelector('[role="radiogroup"][aria-label="Add From"]');
    assert.deepEqual([...seg!.querySelectorAll('[role="radio"]')].map(text), ["Existing Location", "New Folder"]);
    assert.equal(seg!.querySelector('[aria-checked="true"]')?.textContent, "Existing Location");
  } finally {
    await view.unmount();
  }
});

test("choosing an existing location and pressing Add Location adds it and closes", async () => {
  const view = await render();
  try {
    await choose("Loose Checkout");
    assert.equal(addButton().disabled, false);
    assertNoDomNode(footer().querySelector(".add-location-reason"), "nothing blocks it");
    await act(async () => { addButton().click(); });
    await settle();
    assert.deepEqual(view.added.map((candidate) => candidate.workspaceId), ["loose"]);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("an Already Added row is refused with its reason", async () => {
  const view = await render();
  try {
    const row = rowNamed("Already Here")!;
    const input = row.querySelector<HTMLInputElement>('input[type="radio"]')!;
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(text(row.querySelector(".choice-row-meta")), "Already Added");
    assert.equal(text(row.querySelector(".choice-row-reason")), "It's already one of Project One's locations.");
    await act(async () => { input.click(); });
    assert.equal(input.checked, false, "the choice is refused");
    assert.equal(addButton().disabled, true);
    assert.equal(text(footer().querySelector(".add-location-reason")), "Choose a location or a folder.");
  } finally {
    await view.unmount();
  }
});

test("an offline location shows the offline warning and can still be added", async () => {
  const view = await render();
  try {
    await choose("Docs Site");
    const notice = dialog()!.querySelector(".notice.warning, .notice[data-tone=warning], .notice");
    assert.match(text(dialog()), /Build Box is offline\. You can add this location, but sessions can't start there until it reconnects\./u);
    assert.ok(notice);
    assert.equal(addButton().disabled, false, "offline does not block adding");
    await act(async () => { addButton().click(); });
    await settle();
    assert.deepEqual(view.added.map((candidate) => candidate.workspaceId), ["docs"]);
  } finally {
    await view.unmount();
  }
});

test("a narrower location keeps Add Location off, and Narrow Project Access… opens Change Access with the narrower option chosen", async () => {
  const previews: ResourceOwner[] = [];
  const view = await render({
    client: {
      previewProjectAccessScope: async (_projectId: string, owner: ResourceOwner) => {
        previews.push(owner);
        return {
          preview: {
            resource: "project", resourceId: "project-1", currentScope: organizationScope, targetScope: scopeOf(owner),
            affectedProjects: [], activeSessionCount: 0, totalSessionCount: 0, sessionsToNarrow: 0,
            compatible: true, confirmationToken: "token",
          } satisfies AccessScopeChangePreview,
        };
      },
    },
  });
  try {
    await choose("Billing Service");
    const notice = [...dialog()!.querySelectorAll(".notice")].find((element) =>
      text(element).includes("Billing Service Is Shared Only With Builders"));
    assert.ok(notice, "the mismatch notice is titled by the location's access");
    assert.match(text(notice), /Project One is shared with everyone in your organization, and a project's locations must be shared at least as widely\./u);
    assert.equal(addButton().disabled, true);
    assert.equal(text(footer().querySelector(".add-location-reason")), "Match the access levels to continue.");
    const actions = [...notice.querySelectorAll("button")].map(text);
    assert.deepEqual(actions, ["Narrow Project Access…", "Broaden Location Access…"]);
    await act(async () => { [...notice.querySelectorAll<HTMLButtonElement>("button")][0]!.click(); });
    await settle();
    const change = dialog("Change Project Access");
    assert.ok(change, "Change Access opens");
    assert.ok(dialog(), "stacked over Add Location, which stays open");
    const checked = change.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    assert.ok(checked);
    assert.equal(text(checked.closest(".choice-row")?.querySelector(".choice-row-title")), "Team: Builders",
      "the project's narrower option is preselected");
    assert.deepEqual(previews, [{ kind: "team", teamId: "team-builders" }]);
  } finally {
    await view.unmount();
  }
});

test("a search with no match is one row", async () => {
  const view = await render();
  try {
    const search = dialog()!.querySelector<HTMLInputElement>('input[aria-label="Search Locations"]')!;
    assert.equal(search.placeholder, "Search locations");
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      search.focus();
      setter.call(search, "definitely-not-here");
      search.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
      // react-dom decided at import, before these globals existed, that input events are
      // unsupported, so it reads value changes on keyup.
      search.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
    });
    assertNoDomNode(dialog()!.querySelector(".add-location-list"));
    const rows = dialog()!.querySelectorAll(".surface > .row");
    assert.equal(rows.length, 1);
    assert.equal(text(rows[0]), "No locations match. Try a machine name, a folder or a path, or add a new folder.");
    assertNoDomNode(dialog()!.querySelector(".project-manager-empty"));
  } finally {
    await view.unmount();
  }
});

test("New Folder: Machine is the app's Select, the browser is under it, and the name fills in Title Case", async () => {
  const view = await render({
    client: {
      listDirectory: async (_runnerId: string, path: string) => ({
        path: path || "/home/ada/acme-storefront",
        parent: "/home/ada",
        entries: [],
      }),
    },
  });
  try {
    const newFolder = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => text(radio) === "New Folder")!;
    await act(async () => { newFolder.click(); });
    await settle();
    await settle();
    assertNoDomNode(dialog()!.querySelector("select"), "no native select renders");
    const fields = [...dialog()!.querySelectorAll<HTMLElement>(".modal-body .field")];
    const labels = fields.map((field) => text(field.querySelector(":scope > span")));
    assert.deepEqual(labels.slice(0, 4), ["Machine", "Folder", "Location Name", "Location Access"]);
    const trigger = fields[0]!.querySelector<HTMLButtonElement>(".ui-select-trigger");
    assert.ok(trigger, "the app's Select");
    assert.equal(trigger.getAttribute("aria-label"), "Machine: Studio Mac");
    assert.ok(fields[1]!.querySelector(".folder-picker"), "the folder browser is the Folder field, directly under Machine");
    const name = fields[2]!.querySelector<HTMLInputElement>("input")!;
    assert.equal(name.value, "Acme Storefront");
    assert.equal(text(fields[2]!.querySelector(".field-helper")), "Filled in from the folder name.");
    // Offline machines are listed, unavailable with their reason.
    await act(async () => { trigger.click(); });
    const offline = [...body().querySelectorAll<HTMLElement>('[role="option"]')].find((option) => text(option).startsWith("Build Box"));
    assert.ok(offline);
    assert.equal(offline.getAttribute("aria-disabled"), "true");
    assert.match(text(offline), /Offline\. Start it to browse its folders\./u);
    await act(async () => { trigger.click(); });
    assert.equal(addButton().disabled, false);
    await act(async () => { addButton().click(); });
    await settle();
    assert.deepEqual(view.created, [{
      runnerId: "runner-1", name: "Acme Storefront", path: "/home/ada/acme-storefront",
      owner: { kind: "organization", organizationId: ORG }, generateSetup: false,
    }]);
  } finally {
    await view.unmount();
  }
});

test("onboarding leads with the success notice, offers Skip for Now, and ends with the setup-file checkbox", async () => {
  const view = await render({ onboarding: true, setupFileSupported: true });
  try {
    const notices = [...dialog()!.querySelectorAll(".modal-body .notice")];
    assert.equal(text(notices[0]), "Project One was created. Add the folder where its sessions run.");
    assert.equal(dialog()!.querySelector(".modal-body")!.firstElementChild, notices[0], "the notice leads");
    assert.deepEqual([...footer().querySelectorAll("button")].map(text), ["Skip for Now", "Add Location"]);
    const checkbox = dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    const row = checkbox.closest(".checkbox")!;
    assert.match(text(row), /^Create a Starter Setup File/u);
    assert.match(text(row), /Adds a setup file for review after the location is added\. Nothing runs, and nothing is committed\./u);
    const fields = [...dialog()!.querySelectorAll(".modal-body .field, .modal-body .checkbox, .modal-body .add-location-list, .modal-body .input-affix")];
    assert.equal(fields.at(-1), row, "the checkbox is the last field");
    assert.equal(checkbox.checked, false, "an explicit choice, unchecked");
    await act(async () => { checkbox.click(); });
    // It applies to whichever location is added.
    await choose("Loose Checkout");
    await act(async () => { addButton().click(); });
    await settle();
    assert.deepEqual(view.added.map((candidate) => candidate.workspaceId), ["loose"]);
    assert.deepEqual(view.generated, [true]);
  } finally {
    await view.unmount();
  }
});

test("onboarding without setup-file support keeps the notice and Skip for Now but offers no checkbox", async () => {
  const view = await render({ onboarding: true, setupFileSupported: false });
  try {
    assert.match(text(dialog()), /Project One was created\./u);
    assert.equal(text(footer().querySelector("button")), "Skip for Now");
    assertNoDomNode(dialog()!.querySelector('input[type="checkbox"]'));
  } finally {
    await view.unmount();
  }
});

test("New Folder states are notices: an update, and no machines online with Open Connections", async () => {
  const update = await render({ canCreateLocation: false });
  try {
    const newFolder = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => text(radio) === "New Folder")!;
    await act(async () => { newFolder.click(); });
    assert.match(text(dialog()), /Adding New Folders Needs an Update/u);
    assert.match(text(dialog()), /This version of Wollipog can't register a new folder as a location\./u);
    assert.doesNotMatch(text(dialog()), /control plane/iu, "docs/design-system.md §17.2 retires the term");
    assertNoDomNode(dialog()!.querySelector(".project-location-compatibility"));
  } finally {
    await update.unmount();
  }
  const offline = await render({ runners: [offlineRunner], projects: [project] });
  try {
    // Nothing on the offline machine is in this project yet, so Docs Site can still be added and
    // Existing Location leads; New Folder says no machine is online.
    const newFolder = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => text(radio) === "New Folder")!;
    await act(async () => { newFolder.click(); });
    const notice = [...dialog()!.querySelectorAll(".notice")].find((element) => text(element).includes("No Machines Online"));
    assert.ok(notice);
    assert.deepEqual([...notice.querySelectorAll("button")].map(text), ["Open Connections"]);
  } finally {
    await offline.unmount();
  }
});

test("New Folder leads when there is no existing location to add", async () => {
  const view = await render({ runners: [{ ...runner, workspaces: [runner.workspaces[0]!] }], projects: [project] });
  try {
    const seg = dialog()!.querySelector('[role="radiogroup"][aria-label="Add From"]')!;
    assert.equal(seg.querySelector('[aria-checked="true"]')?.textContent, "New Folder");
  } finally {
    await view.unmount();
  }
});

test("an identity failure is one danger notice and adding stays fail-closed", async () => {
  const view = await render({ client: { getIdentity: async () => { throw new Error("identity service unavailable"); } } });
  try {
    const notice = [...dialog()!.querySelectorAll(".notice")].find((element) => text(element).includes("Couldn't Load Access Levels"));
    assert.ok(notice);
    assertNoDomNode(dialog()!.querySelector(".project-location-error"));
    await choose("Loose Checkout");
    assert.equal(addButton().disabled, true, "adding stays fail-closed after identity loading fails");
    assert.equal(text(footer().querySelector(".add-location-reason")), "Access levels couldn't be loaded.");
  } finally {
    await view.unmount();
  }
});

test("a failed add is a danger notice above the footer with the raw text behind Show Details", async () => {
  const view = await render({ onAdd: async () => { throw new Error("workspace is not visible to this principal"); } });
  try {
    await choose("Loose Checkout");
    await act(async () => { addButton().click(); });
    await settle();
    assert.equal(view.closed(), 0, "the dialog stays open");
    const notice = dialog()!.querySelector(".modal-body")!.lastElementChild!;
    assert.match(text(notice), /^Couldn't Add the Location/u);
    assert.match(text(notice), /Wollipog couldn't add this location\. Try again\./u);
    assert.doesNotMatch(text(notice), /not visible to this principal/u, "the raw text waits behind Show Details");
    const details = [...notice.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Show Details")!;
    await act(async () => { details.click(); });
    assert.match(text(notice), /workspace is not visible to this principal/u);
  } finally {
    await view.unmount();
  }
});

test("while a new folder is being added, the browser and the form hold still on the folder being submitted", async () => {
  let settleCreate: () => void = () => {};
  const listed: string[] = [];
  const view = await render({
    client: {
      listDirectory: async (_runnerId: string, path: string) => {
        listed.push(path);
        const at = path || "/repos/acme-storefront";
        return { path: at, parent: "/repos", entries: at === "/repos/acme-storefront" ? [{ name: "billing", path: "/repos/acme-storefront/billing", isDir: true }] : [] };
      },
    },
    onCreate: () => new Promise<void>((resolve) => { settleCreate = resolve; }),
  });
  try {
    const radios = () => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Add From"] [role="radio"]')];
    await act(async () => { radios().find((radio) => text(radio) === "New Folder")!.click(); });
    await settle();
    await settle();
    const name = () => [...dialog()!.querySelectorAll<HTMLElement>(".modal-body .field")]
      .find((field) => text(field.querySelector(":scope > span")) === "Location Name")!.querySelector<HTMLInputElement>("input")!;
    assert.equal(name().value, "Acme Storefront");
    await act(async () => { addButton().click(); });
    await settle();
    assert.equal(view.created.length, 1, "the request is in flight");

    const picker = dialog()!.querySelector(".folder-picker")!;
    const controls = [...picker.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")];
    assert.ok(controls.length >= 3, "the crumbs, Edit Path, Up One Level and folder rows render");
    assert.deepEqual(controls.filter((control) => !control.disabled).map((control) => text(control) || control.getAttribute("aria-label")), [],
      "every browser control is disabled while the folder is submitted");
    const billing = [...picker.querySelectorAll<HTMLButtonElement>(".folder-picker-list > .row")].find((row) => text(row) === "billing")!;
    await act(async () => { billing.click(); });
    await settle();
    assert.deepEqual(listed, [""], "nothing navigated");
    assert.equal(name().value, "Acme Storefront", "the name stays the submitted folder's");
    assert.equal(name().disabled, true);
    assert.ok(radios().every((radio) => radio.getAttribute("aria-disabled") === "true" || radio.disabled), "the mode switch holds still");

    await act(async () => { settleCreate(); });
    await settle();
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("while an existing location is being added, the search and the rows hold still", async () => {
  let settleAdd: () => void = () => {};
  const view = await render({ onAdd: () => new Promise<void>((resolve) => { settleAdd = resolve; }) });
  try {
    await choose("Loose Checkout");
    await act(async () => { addButton().click(); });
    await settle();
    assert.equal(dialog()!.querySelector<HTMLInputElement>('input[aria-label="Search Locations"]')!.disabled, true);
    const inputs = [...dialog()!.querySelectorAll<HTMLInputElement>('.add-location-list input[type="radio"]')];
    assert.ok(inputs.every((input) => input.getAttribute("aria-disabled") === "true"), "every row is refused while pending");
    await choose("Shared Checkout");
    assert.equal(rowNamed("Loose Checkout")!.querySelector<HTMLInputElement>("input")!.checked, true, "the submitted row stays chosen");
    await act(async () => { settleAdd(); });
    await settle();
    assert.deepEqual(view.added.map((candidate) => candidate.workspaceId), ["loose"]);
  } finally {
    await view.unmount();
  }
});

test("a server too old to register folders says so in the failed-add notice, with nothing behind Show Details", async () => {
  const view = await render({
    client: {
      listDirectory: async (_runnerId: string, path: string) => ({ path: path || "/home/ada/acme-storefront", parent: "/home/ada", entries: [] }),
    },
    onCreate: async () => { throw new ApiError("not found", 404); },
  });
  try {
    const newFolder = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => text(radio) === "New Folder")!;
    await act(async () => { newFolder.click(); });
    await settle();
    await settle();
    await act(async () => { addButton().click(); });
    await settle();
    const notice = dialog()!.querySelector(".modal-body")!.lastElementChild!;
    assert.match(text(notice), /^Couldn't Add the Location/u);
    assert.match(text(notice), /This version of Wollipog does not support creating a Location from a new folder\./u);
    assert.equal([...notice.querySelectorAll("button")].some((button) => text(button) === "Show Details"), false);
  } finally {
    await view.unmount();
  }
});
