import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { InboxSplit } from "../inbox.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { archiveRowStatus, ProjectSplitMenu } from "./ProjectSplitMenu.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import type { GroupTabMenuRequest } from "./SessionGroupTabs.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/inbox" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

function session(id: string): SessionView {
  return {
    id,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Project One",
    title: id,
    status: "idle",
    archived: false,
    updatedAt: 1,
    lastEventAt: 1,
    pendingApproval: null,
  } as SessionView;
}

const split: InboxSplit = {
  key: '["runner-1","workspace-1"]',
  kind: "project",
  name: "Project One",
  project: { kind: "legacy", runnerId: "runner-1", workspaceId: "workspace-1" },
  sessions: [session("session-1"), session("session-2")],
  count: 2,
  blockedCount: 0,
  stalledCount: 0,
};

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1",
    hostname: "runner",
    os: "linux",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [{ id: "workspace-1", name: "Project One", path: "/repos/project-one" }],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 999,
    ...overrides,
  };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const find = (scope: HTMLElement) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.querySelector(".menu-text") ?? candidate).textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label);
  const match = find(container) ?? find(domWindow.document.body as unknown as HTMLElement);
  assert.ok(match, `missing button: ${label}`);
  return match;
}

/** A menu item's second line: why it is unavailable (§9.1), or null. */
function reason(container: HTMLElement, label: string): string | null {
  const item = button(container, label);
  const description = item.querySelector(".menu-desc");
  if (!description) return null;
  assert.ok((item.getAttribute("aria-describedby") ?? "").split(" ").includes(description.id), `${label} is described by its reason`);
  return description.textContent;
}

async function openMenu(container: HTMLElement): Promise<void> {
  await act(async () => {
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.getAttribute("aria-label") === "Project One Actions");
    assert.ok(trigger, "missing the Project One Actions trigger");
    trigger.click();
    await tick();
  });
}

test("project split menu is fixed, keyboard-managed, and restores trigger focus", async () => {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider>
        <FeedbackProvider>
          <ProjectSplitMenu split={split} runner={runner()} pinned={false} onPinnedChange={() => undefined} onNewSession={() => undefined} />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });

  const trigger = button(container, "Project One Actions");
  assert.ok(trigger.classList.contains("icon-btn") && trigger.classList.contains("sm"), "a small icon button (§3.1)");
  assert.equal(trigger.title, "Project One Actions", "its tooltip matches its name");
  trigger.focus();
  await act(async () => {
    trigger.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as unknown as Event,
    );
    await tick();
  });
  const body = domWindow.document.body as unknown as HTMLElement;
  const menu = body.querySelector<HTMLElement>('[role="menu"]')!;
  assert.ok(menu);
  assert.equal(menu.parentElement, body, "the menu must escape tab-strip overflow through a portal");
  // The shared surface is position: fixed in the stylesheet from its first commit, and placed
  // against its trigger before paint, so focusing its first item never scrolls the page.
  assert.ok(menu.classList.contains("menu"), "the shared menu surface");
  assert.notEqual(menu.style.left, "", "placed against its trigger");
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "New Session Here");
  assert.equal(menu.getAttribute("aria-label"), "Project One Actions");
  assert.equal(menu.querySelector(".menu-head")?.textContent, "Project One", "a phone sheet is titled with the name");

  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
  });
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "Archive and Stop All Sessions…");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();
  });
  assertNoDomNode(body.querySelector('[role="menu"]'));
  assert.equal(domWindow.document.activeElement, trigger);

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("project actions preserve presets, pin state, rename, reveal, and compensated archive plumbing", async () => {
  const revealed: Array<[string, string]> = [];
  const renamed: Array<[string, string, string]> = [];
  const archived: Array<[string, boolean]> = [];
  const pinned: boolean[] = [];
  const presets: NewSessionPreset[] = [];
  const client = {
    ...api,
    revealWorkspace: async (runnerId: string, path: string) => { revealed.push([runnerId, path]); return { ok: true as const }; },
    renameWorkspace: async (runnerId: string, workspaceId: string, name: string) => {
      renamed.push([runnerId, workspaceId, name]);
      return { ok: true as const };
    },
    setArchived: async (sessionId: string, value: boolean) => {
      archived.push([sessionId, value]);
      return {
        ...session(sessionId),
        status: "stopped" as const,
        archiveStatus: sessionId === "session-1" ? "stop_failed" as const : "stop_pending" as const,
      };
    },
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <ProjectSplitMenu
            split={split}
            runner={runner()}
            pinned={false}
            onPinnedChange={(value) => pinned.push(value)}
            onNewSession={(preset) => presets.push(preset)}
          />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });

  await openMenu(container);
  await act(async () => { button(container, "Pin Workspace").click(); await tick(); });
  assert.deepEqual(pinned, [true]);

  await openMenu(container);
  await act(async () => { button(container, "Reveal in File Manager").click(); await tick(); });
  assert.deepEqual(revealed, [["runner-1", "/repos/project-one"]]);

  await openMenu(container);
  await act(async () => { button(container, "New Session Here").click(); await tick(); });
  await openMenu(container);
  await act(async () => { button(container, "Create Permanent Worktree…").click(); await tick(); });
  assert.deepEqual(presets, [
    { runnerId: "runner-1", workspaceId: "workspace-1", projectName: "Project One" },
    { runnerId: "runner-1", workspaceId: "workspace-1", worktree: true },
  ]);

  await openMenu(container);
  await act(async () => { button(container, "Rename Workspace…").click(); await tick(); });
  const renameInput = container.querySelector<HTMLInputElement>("#rename-project-name")!;
  await act(async () => {
    renameInput.value = "Renamed Project";
    fireDomEvent.change(renameInput);
  });
  await act(async () => { button(container, "Rename Workspace").click(); await tick(); });
  assert.deepEqual(renamed, [["runner-1", "workspace-1", "Renamed Project"]]);

  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions…").click(); await tick(); });
  assert.match(container.textContent ?? "", /Archive and Stop 2 Sessions.*All 2 sessions in/);
  assert.match(
    container.textContent ?? "",
    /All 2 sessions in “Project One” stop, their queued messages are canceled, and they move to Archived Sessions\. You can restore them later\./,
  );
  assert.doesNotMatch(container.textContent ?? "", /Snooze/);
  await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
  assert.deepEqual(archived, [["session-1", true], ["session-2", true]]);
  assert.match(
    container.textContent ?? "",
    /The stop failed for 1 session in Project One, so it may still be running\. Use Retry Stop to try again\./,
  );

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("durable Project launch actions carry stable Project and Location identity", async () => {
  const durableSplit: InboxSplit = {
    ...split,
    key: "project:project-1",
    project: {
      kind: "durable",
      project: {
        id: "project-1",
        name: "Project One",
        hidden: false,
        locations: [{
          id: "location-1",
          projectId: "project-1",
          runnerId: "runner-1",
          workspaceId: "workspace-1",
          name: "Project One",
          path: "/repos/project-one",
          source: "managed",
          availability: "available",
          isDefault: true,
          createdAt: 1,
          updatedAt: 1,
        }],
        activeSessionCount: 0,
        unarchivedSessionCount: 2,
        totalSessionCount: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      primaryLocation: {
        id: "location-1",
        projectId: "project-1",
        runnerId: "runner-1",
        workspaceId: "workspace-1",
        name: "Project One",
        path: "/repos/project-one",
        source: "managed",
        availability: "available",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
      legacyKeys: ['["runner-1","workspace-1"]'],
    },
  };
  const presets: NewSessionPreset[] = [];
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <FeedbackProvider>
        <ProjectSplitMenu
          split={durableSplit}
          runner={runner()}
          pinned={false}
          onPinnedChange={() => undefined}
          onNewSession={(preset) => presets.push(preset)}
        />
      </FeedbackProvider>,
    );
  });

  await openMenu(container);
  await act(async () => { button(container, "New Session Here").click(); await tick(); });
  await openMenu(container);
  await act(async () => { button(container, "Create Permanent Worktree…").click(); await tick(); });

  assert.deepEqual(presets, [
    {
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      projectLocationId: "location-1",
    },
    {
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      projectLocationId: "location-1",
      worktree: true,
    },
  ]);

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("multi-Location Projects without a default defer Location choice to New Session", async () => {
  const locations = [
    {
      id: "location-1",
      projectId: "project-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      name: "Project One",
      path: "/repos/project-one",
      source: "managed" as const,
      availability: "available" as const,
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "location-2",
      projectId: "project-1",
      runnerId: "runner-2",
      workspaceId: "workspace-2",
      name: "Project One",
      path: "/work/project-one",
      source: "managed" as const,
      availability: "available" as const,
      isDefault: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  const durableSplit: InboxSplit = {
    ...split,
    key: "project:project-1",
    project: {
      kind: "durable",
      project: {
        id: "project-1",
        name: "Project One",
        hidden: false,
        locations,
        activeSessionCount: 0,
        unarchivedSessionCount: 2,
        totalSessionCount: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      primaryLocation: null,
      legacyKeys: ['["runner-1","workspace-1"]', '["runner-2","workspace-2"]'],
    },
  };
  const presets: NewSessionPreset[] = [];
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <FeedbackProvider>
        <ProjectSplitMenu
          split={durableSplit}
          runner={undefined}
          pinned={false}
          onPinnedChange={() => undefined}
          onNewSession={(preset) => presets.push(preset)}
        />
      </FeedbackProvider>,
    );
  });

  await openMenu(container);
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session").disabled, false);
  assert.equal(button(container, "Create Permanent Worktree…").disabled, false);
  assert.equal(reason(container, "Reveal in File Manager"), "Choose a default Location to use location actions.");
  assert.equal(button(container, "Reveal in File Manager").title, "", "the reason is never only a tooltip");
  assertNoDomNode(domWindow.document.querySelector(".menu-note"));
  await act(async () => { button(container, "New Session").click(); await tick(); });

  await openMenu(container);
  await act(async () => { button(container, "Create Permanent Worktree…").click(); await tick(); });
  assert.deepEqual(presets, [
    { projectId: "project-1" },
    { projectId: "project-1", worktree: true },
  ], "the New Session dialog must make the user choose one of the available Locations");

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("project action guards fail closed for offline, stale, and native-Windows WSL workspaces", async () => {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const render = async (value: RunnerView) => {
    await act(async () => {
      root.render(
        <FeedbackProvider>
          <ProjectSplitMenu split={split} runner={value} pinned={false} onPinnedChange={() => undefined} onNewSession={() => undefined} />
        </FeedbackProvider>,
      );
    });
    await openMenu(container);
  };

  await render(runner({ status: "offline" }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, true);
  assert.equal(button(container, "Create Permanent Worktree…").disabled, true);
  for (const label of ["Reveal in File Manager", "New Session Here", "Create Permanent Worktree…"]) {
    assert.equal(reason(container, label), "The runner for this Location is offline.");
  }
  await act(async () => { button(container, "Project One Actions").click(); await tick(); });

  await render(runner({ workspaces: [] }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, true);
  assert.match(reason(container, "New Session Here") ?? "", /not advertised/);
  await act(async () => { button(container, "Project One Actions").click(); await tick(); });

  await render(runner({ os: "windows", workspaces: [{ id: "workspace-1", name: "Project One", path: "/mnt/c/project-one" }] }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, false);
  assert.equal(button(container, "Create Permanent Worktree…").disabled, false);
  assert.match(reason(container, "Reveal in File Manager") ?? "", /^WSL workspace paths/);
  assert.equal(reason(container, "New Session Here"), null, "an available item has no second line");
  await act(async () => { button(container, "Project One Actions").click(); await tick(); });

  await render(runner({ protocolVersion: 1 }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, false);
  assert.ok(reason(container, "Reveal in File Manager"), "an old runner says why it cannot reveal");

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("durable zero-session Projects keep Project actions without inferring identity from a session", async () => {
  const durableSplit: InboxSplit = {
    key: "project:project-1",
    kind: "project",
    name: "Project One",
    project: {
      kind: "durable",
      project: {
        id: "project-1",
        name: "Project One",
        hidden: false,
        locations: [],
        activeSessionCount: 0,
        unarchivedSessionCount: 0,
        totalSessionCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      primaryLocation: null,
      legacyKeys: [],
    },
    sessions: [],
    count: 0,
    blockedCount: 0,
    stalledCount: 0,
  };
  const renamed: Array<[string, string]> = [];
  const pinned: boolean[] = [];
  const client = {
    ...api,
    updateProject: async (projectId: string, body: { name?: string }) => {
      renamed.push([projectId, body.name ?? ""]);
      return {
        project: {
          ...(durableSplit.project!.kind === "durable" ? durableSplit.project!.project : {}),
          name: body.name,
        },
      } as never;
    },
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <ProjectSplitMenu
            split={durableSplit}
            runner={undefined}
            pinned={false}
            onPinnedChange={(value) => pinned.push(value)}
            onNewSession={() => undefined}
          />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });

  await openMenu(container);
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, true);
  assert.equal(button(container, "Create Permanent Worktree…").disabled, true);
  assert.equal(button(container, "Archive All Sessions…").disabled, true);
  assert.equal(reason(container, "New Session Here"), "Add a Project Location to use location actions.");
  assert.equal(reason(container, "Archive All Sessions…"), "This Project has no unarchived sessions.");
  await act(async () => { button(container, "Pin Project").click(); await tick(); });
  assert.deepEqual(pinned, [true]);

  await openMenu(container);
  await act(async () => { button(container, "Rename Project…").click(); await tick(); });
  const renameInput = container.querySelector<HTMLInputElement>("#rename-project-name")!;
  await act(async () => {
    renameInput.value = "Renamed Durable Project";
    fireDomEvent.change(renameInput);
  });
  await act(async () => { button(container, "Rename Project").click(); await tick(); });
  assert.deepEqual(renamed, [["project-1", "Renamed Durable Project"]]);

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("durable Project archive is atomic, restores only changed sessions, and honors management permission", async () => {
  const project = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    canManage: true,
    locations: [{
      id: "location-1",
      projectId: "project-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      name: "Project One",
      path: "/repos/project-one",
      source: "managed" as const,
      availability: "available" as const,
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: 2,
    totalSessionCount: 3,
    createdAt: 1,
    updatedAt: 1,
  };
  const durableSplit: InboxSplit = {
    key: "project:project-1",
    kind: "project",
    name: "Project One",
    project: {
      kind: "durable",
      project,
      primaryLocation: project.locations[0]!,
      legacyKeys: ['["runner-1","workspace-1"]'],
    },
    sessions: [session("session-visible")],
    count: 2,
    blockedCount: 0,
    stalledCount: 0,
  };
  const archivedProjects: string[] = [];
  const restored: Array<[string, boolean]> = [];
  const client = {
    ...api,
    archiveProjectSessions: async (projectId: string) => {
      archivedProjects.push(projectId);
      return { project, sessions: [], archivedSessionIds: ["session-visible", "session-not-loaded"] };
    },
    setArchived: async (sessionId: string, value: boolean) => {
      restored.push([sessionId, value]);
      return session(sessionId);
    },
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const render = async (canManage: boolean) => {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <FeedbackProvider>
            <ProjectSplitMenu
              split={{
                ...durableSplit,
                project: durableSplit.project?.kind === "durable"
                  ? { ...durableSplit.project, project: { ...project, canManage } }
                  : durableSplit.project,
              }}
              runner={runner()}
              pinned={false}
              onPinnedChange={() => undefined}
              onNewSession={() => undefined}
            />
          </FeedbackProvider>
        </ApiProvider>,
      );
    });
  };

  await render(false);
  await openMenu(container);
  assert.equal(button(container, "Rename Project…").disabled, true);
  assert.equal(button(container, "Archive and Stop All Sessions…").disabled, true);
  for (const label of ["Rename Project…", "Archive and Stop All Sessions…"]) {
    assert.equal(reason(container, label), "Project management permission is required.");
  }
  assert.equal(domWindow.document.querySelector('[role="menu"]')?.hasAttribute("aria-describedby"), false, "no shared note describes the menu");
  await act(async () => { button(container, "Project One Actions").click(); await tick(); });

  await render(true);
  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions…").click(); await tick(); });
  assert.match(container.textContent ?? "", /Archive and Stop 2 Sessions.*All 2 sessions in/);
  // The count covers the Project sessions that are not loaded here, which the server also stops.
  assert.match(container.textContent ?? "", /All 2 sessions in “Project One” stop, their queued messages are canceled/);
  assert.doesNotMatch(container.textContent ?? "", /Snooze/);
  // The loaded session is listed; the one the split has not loaded is still counted (#2051).
  const durableDialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  assert.deepEqual([...durableDialog.querySelectorAll(".confirmation-rows .row-title")].map((row) => row.textContent), ["session-visible"]);
  assert.equal(durableDialog.querySelector(".confirmation-rows-more")?.textContent, "and 1 more");
  await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
  assert.deepEqual(archivedProjects, ["project-1"]);
  assert.match(container.textContent ?? "", /2 sessions archived from Project One/);
  await act(async () => { button(container, "Undo").click(); await tick(); await tick(); });
  assert.deepEqual(restored, [["session-visible", false], ["session-not-loaded", false]]);

  client.archiveProjectSessions = async (projectId: string) => {
    archivedProjects.push(projectId);
    return { project, sessions: [] };
  };
  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions…").click(); await tick(); });
  await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
  assert.deepEqual(archivedProjects, ["project-1", "project-1"]);
  assert.match(container.textContent ?? "", /Sessions archived from Project One\. Undo isn't available for this archive\./);

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("a Project archive toast is a success only when every stop finished: still stopping is info, a failed stop a warning (#2333)", async () => {
  const project = {
    id: "project-1",
    name: "Project One",
    hidden: false,
    canManage: true,
    locations: [{
      id: "location-1",
      projectId: "project-1",
      runnerId: "runner-1",
      workspaceId: "workspace-1",
      name: "Project One",
      path: "/repos/project-one",
      source: "managed" as const,
      availability: "available" as const,
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    activeSessionCount: 2,
    unarchivedSessionCount: 2,
    totalSessionCount: 2,
    createdAt: 1,
    updatedAt: 1,
  };
  const durableSplit: InboxSplit = {
    ...split,
    key: "project:project-1",
    project: { kind: "durable", project, primaryLocation: project.locations[0]!, legacyKeys: [split.key!] },
  };
  const outcomes = [
    { archiveStatus: undefined, message: /^2 sessions archived from Project One\./, tone: "t-success", icon: "lucide-circle-check" },
    { archiveStatus: "stop_pending" as const, message: /^Archiving from Project One\. 1 session is still stopping\./, tone: "t-info", icon: "lucide-info" },
    { archiveStatus: "stop_failed" as const, message: /^The stop failed for 1 session in Project One/, tone: "t-warning", icon: "lucide-triangle-alert" },
  ];
  for (const group of ["workspace", "durable"] as const) {
    for (const outcome of outcomes) {
      const restored: string[] = [];
      const client = {
        ...api,
        // A workspace group archives each session; the second one reports this outcome.
        setArchived: async (sessionId: string, value: boolean) => {
          if (!value) restored.push(sessionId);
          return { ...session(sessionId), archived: value, archiveStatus: value && sessionId === "session-2" ? outcome.archiveStatus : undefined };
        },
        // A durable Project archives in one request that names the sessions by outcome.
        archiveProjectSessions: async () => ({
          project,
          sessions: [],
          archivedSessionIds: outcome.archiveStatus ? ["session-1"] : ["session-1", "session-2"],
          ...(outcome.archiveStatus === "stop_pending" ? { pendingSessionIds: ["session-2"] } : {}),
          ...(outcome.archiveStatus === "stop_failed" ? { failedSessionIds: ["session-2"] } : {}),
        }),
      } as ApiClient;
      const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
      domWindow.document.body.append(mountPoint as never);
      const container = domWindow.document.body as unknown as HTMLDivElement;
      const root = createRoot(mountPoint);
      await act(async () => {
        root.render(
          <ApiProvider client={client}>
            <FeedbackProvider>
              <ProjectSplitMenu
                split={group === "durable" ? durableSplit : split}
                runner={runner()}
                pinned={false}
                onPinnedChange={() => undefined}
                onNewSession={() => undefined}
              />
            </FeedbackProvider>
          </ApiProvider>,
        );
      });
      await openMenu(container);
      await act(async () => { button(container, "Archive and Stop All Sessions…").click(); await tick(); });
      await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
      const label = `${group} ${outcome.archiveStatus ?? "archived"}`;
      const toasts = [...container.querySelectorAll<HTMLElement>(".toast")];
      assert.equal(toasts.length, 1, `${label}: one result toast`);
      const toast = toasts[0]!;
      assert.match(toast.querySelector(".toast-message")?.textContent ?? "", outcome.message, label);
      assert.ok(toast.classList.contains(outcome.tone), `${label}: ${outcome.tone}, not ${toast.className}`);
      assert.ok(toast.querySelector(".toast-icon svg")?.classList.contains(outcome.icon), `${label}: ${outcome.icon}`);
      await act(async () => { button(toast, "Undo").click(); await tick(); await tick(); });
      assert.deepEqual(restored, ["session-1", "session-2"], `${label}: Undo restores every session`);
      await act(async () => { root.unmount(); });
      mountPoint.remove();
    }
  }
});

test("the archive confirmation lists the split's sessions with their status, then counts the rest (#2051)", async () => {
  const statuses: Array<[string, Partial<SessionView>]> = [
    ["Fix the invoice rounding bug", { status: "running" }],
    ["Review the migration plan", { status: "input_required" }],
    ["Draft release notes", { status: "idle" }],
    ["Approve the schema change", {
      status: "input_required",
      pendingApproval: { requestId: "request-1", title: "Run Bash", options: [] },
    }],
    ["Retry the stuck stop", {
      status: "running",
      stopOperation: { operationId: "stop-1", status: "stop_pending", requestedAt: 1, lastAttemptAt: 1, attemptCount: 1 } as SessionView["stopOperation"],
    }],
    ["Upgrade the browsers", { status: "queued" }],
    ["Audit stylesheet debt", { status: "idle" }],
  ];
  const sevenSplit: InboxSplit = {
    ...split,
    sessions: statuses.map(([title, overrides], index) => ({ ...session(`session-${index + 1}`), title, ...overrides })),
    count: statuses.length,
  };
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const render = async (stopBeforeArchiveSupported: boolean) => {
    await act(async () => {
      root.render(
        <ApiProvider>
          <FeedbackProvider>
            <ProjectSplitMenu split={sevenSplit} runner={runner()} stopBeforeArchiveSupported={stopBeforeArchiveSupported}
              pinned={false} onPinnedChange={() => undefined} onNewSession={() => undefined} />
          </FeedbackProvider>
        </ApiProvider>,
      );
    });
  };
  const expectRows = (title: string) => {
    const dialog = [...domWindow.document.querySelectorAll('[role="dialog"]')]
      .find((candidate) => candidate.getAttribute("aria-labelledby")
        && domWindow.document.getElementById(candidate.getAttribute("aria-labelledby")!)?.textContent === title) as unknown as HTMLElement;
    assert.ok(dialog, `missing dialog: ${title}`);
    const rows = [...dialog.querySelectorAll(".confirmation-rows > li")];
    assert.deepEqual(rows.map((row) => row.querySelector(".row-title")?.textContent), [
      "Fix the invoice rounding bug",
      "Review the migration plan",
      "Draft release notes",
      "Approve the schema change",
      "Retry the stuck stop",
    ]);
    // Attention outranks lifecycle, and a Stop already under way reads as one (§11.1).
    assert.deepEqual(rows.map((row) => row.querySelector(".status.inline")?.textContent?.trim()), [
      "Running",
      "Awaiting Input",
      "Awaiting Prompt",
      "Approval Required",
      "Stop Pending",
    ]);
    assert.equal(dialog.querySelector(".confirmation-rows-more")?.textContent, "and 2 more");
    const described = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
    assert.ok(described.includes(dialog.querySelector(".confirmation-rows")!.id), "the rows join the dialog's description");
    // The message copy is unchanged; the rows sit under it.
    assert.match(dialog.querySelector(".confirmation-message")?.textContent ?? "", /^All 7 sessions in “Project One” /);
  };

  await render(true);
  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions…").click(); await tick(); });
  expectRows("Archive and Stop 7 Sessions");
  await act(async () => { button(container, "Cancel").click(); await tick(); });

  // Without Stop-before-archive support the action is plain "Archive 7 Sessions" with the same rows.
  await render(false);
  await openMenu(container);
  await act(async () => { button(container, "Archive All Sessions…").click(); await tick(); });
  expectRows("Archive 7 Sessions");
  await act(async () => { button(container, "Cancel").click(); await tick(); });

  await act(async () => { root.unmount(); });
  mountPoint.remove();
});

test("an archive row's badge follows the shared human-owned attention projection", () => {
  const approval = { requestId: "request-1", title: "Run Bash", options: [] };
  const label = (overrides: Partial<SessionView>) => archiveRowStatus({ ...session("row"), ...overrides }).label;
  // A request only a child agent owns does not claim the row: it reads as the session's lifecycle.
  assert.equal(label({
    status: "running",
    pendingApproval: approval,
    pendingRequestOwners: { human: 0, orchestrator: 1, requests: [{ requestId: "request-1", owner: "orchestrator" }] },
  } as Partial<SessionView>), "Running");
  assert.equal(label({ status: "input_required", pendingApproval: approval }), "Approval Required");
  assert.equal(label({ status: "input_required", pendingApproval: { ...approval, kind: "question" } }), "Answer Required");
  // A campaign's human-owned requests claim the row even with no request of its own.
  assert.equal(label({
    status: "running",
    orchestratorCampaign: { pendingRequests: { human: 2, orchestrator: 0 } } as SessionView["orchestratorCampaign"],
  }), "Needs Your Input");
  // A bare input status with nothing behind it keeps its lifecycle wording.
  assert.equal(label({ status: "input_required" }), "Awaiting Input");
});

/** A durable Project with one available default Location, which every action can use. */
function durableProjectSplit(): InboxSplit {
  const location = {
    id: "location-1",
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Project One",
    path: "/repos/project-one",
    source: "managed" as const,
    availability: "available" as const,
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    ...split,
    key: "project:project-1",
    project: {
      kind: "durable",
      project: {
        id: "project-1",
        name: "Project One",
        hidden: false,
        canManage: true,
        locations: [location],
        activeSessionCount: 0,
        unarchivedSessionCount: 2,
        totalSessionCount: 2,
        createdAt: 1,
        updatedAt: 1,
      },
      primaryLocation: location,
      legacyKeys: [split.key!],
    },
  };
}

/** The open menu's rows in order, a separator as "—". */
function menuRows(): string[] {
  const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')]
    .map((row) => row.getAttribute("role") === "separator" ? "—" : row.querySelector(".menu-text")!.textContent!);
}

function stubViewport(phone: boolean): () => void {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: phone && query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  return () => { domWindow.matchMedia = prior; };
}

async function mountMenu(element: React.ReactElement) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => { root.render(element); });
  return {
    container: domWindow.document.body as unknown as HTMLDivElement,
    async unmount() {
      await act(async () => { root.unmount(); });
      mountPoint.remove();
    },
  };
}

test("the menu groups its items in order, New Session Here first and the archive last in danger (#2199)", async () => {
  const view = await mountMenu(
    <FeedbackProvider>
      <ProjectSplitMenu split={durableProjectSplit()} runner={runner()} pinned={false}
        onPinnedChange={() => undefined} onNewSession={() => undefined} onManageProject={() => undefined} />
    </FeedbackProvider>,
  );
  await openMenu(view.container);
  assert.deepEqual(menuRows(), [
    "New Session Here",
    "—",
    "Rename Project…",
    "Pin Project",
    "Create Permanent Worktree…",
    "Reveal in File Manager",
    "—",
    "Manage Project",
    "—",
    "Archive and Stop All Sessions…",
  ]);
  assert.ok(button(view.container, "Archive and Stop All Sessions…").classList.contains("danger"));
  assertNoDomNode(domWindow.document.querySelector(".menu-note"));
  await view.unmount();
});

test("on a phone the menu leaves out Reveal in File Manager (#2199)", async () => {
  const restore = stubViewport(true);
  try {
    const view = await mountMenu(
      <FeedbackProvider>
        <ProjectSplitMenu split={durableProjectSplit()} runner={runner()} pinned
          onPinnedChange={() => undefined} onNewSession={() => undefined} onManageProject={() => undefined} />
      </FeedbackProvider>,
    );
    await openMenu(view.container);
    assert.deepEqual(menuRows(), [
      "New Session Here", "—", "Rename Project…", "Unpin Project", "Create Permanent Worktree…", "—",
      "Manage Project", "—", "Archive and Stop All Sessions…",
    ]);
    await view.unmount();
  } finally {
    restore();
  }
});

test("Rename Project refuses an empty or unchanged name on the field, then renames with a busy primary (#2199)", async () => {
  const renames: string[] = [];
  let finish: (() => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const client = {
    ...api,
    updateProject: (_projectId: string, body: { name?: string }) => new Promise((resolve, reject) => {
      renames.push(body.name ?? "");
      finish = () => resolve({ project: {} } as never);
      fail = reject;
    }),
  } as unknown as ApiClient;
  const view = await mountMenu(
    <ApiProvider client={client}>
      <FeedbackProvider>
        <ProjectSplitMenu split={durableProjectSplit()} runner={runner()} pinned={false}
          onPinnedChange={() => undefined} onNewSession={() => undefined} />
      </FeedbackProvider>
    </ApiProvider>,
  );
  const { container } = view;
  await openMenu(container);
  await act(async () => { button(container, "Rename Project…").click(); await tick(); });
  const dialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  assert.equal(dialog.querySelector(".modal-title")?.textContent, "Rename Project");
  const input = dialog.querySelector<HTMLInputElement>("#rename-project-name")!;
  assert.equal(dialog.querySelector(`label[for="${input.id}"]`)?.textContent, "Name");
  assert.equal(domWindow.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent,
    "Changes the name everywhere this project appears.");
  assert.equal(button(container, "Cancel").className, "btn");

  const submit = button(container, "Rename Project");
  const expectRefused = (why: string) => {
    assert.equal(input.getAttribute("aria-invalid"), "true", why);
    const error = domWindow.document.getElementById(input.getAttribute("aria-describedby")!) as unknown as HTMLElement;
    assert.ok(error.classList.contains("field-error"), `${why}: the shared field error (#2150)`);
    assert.equal(error.textContent, "Enter a name for the project.");
    assertNoDomNode(dialog.querySelector(".field-helper"), "the error replaces the helper");
    assert.ok(dialog.isConnected, `${why}: the dialog stays open`);
  };
  // Unchanged.
  await act(async () => { submit.click(); await tick(); });
  expectRefused("an unchanged name");
  // Empty.
  await act(async () => { input.value = "   "; fireDomEvent.change(input); });
  await act(async () => { submit.click(); await tick(); });
  expectRefused("an empty name");
  assert.deepEqual(renames, []);

  // A valid name clears the error as it is typed.
  await act(async () => { input.value = "Project Two"; fireDomEvent.change(input); });
  assert.equal(input.hasAttribute("aria-invalid"), false);

  // A failed request says why in the same place.
  await act(async () => { submit.click(); await tick(); });
  await act(async () => { fail!(new Error("A project named Project Two already exists.")); await tick(); });
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(dialog.querySelector(".field-error")?.textContent, "A project named Project Two already exists.");

  // The primary keeps its label and shows the spinner while the rename runs, then the dialog closes.
  await act(async () => { submit.click(); await tick(); });
  assert.equal(submit.getAttribute("aria-busy"), "true");
  assert.equal(submit.textContent, "Rename Project");
  assert.ok(submit.querySelector(".spinner, svg"), "a spinner is prepended");
  assert.doesNotMatch(container.textContent ?? "", /Saving…/);
  await act(async () => { finish!(); await tick(); });
  assert.deepEqual(renames, ["Project Two", "Project Two"]);
  assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'));
  await view.unmount();
});

test("a menu the tab asks for opens at the pointer for that project and returns focus to the tab (#2199)", async () => {
  const tab = domWindow.document.createElement("button") as unknown as HTMLButtonElement;
  tab.textContent = "Project One";
  domWindow.document.body.append(tab as never);
  let closed = 0;
  const render = (request: GroupTabMenuRequest | null) => (
    <FeedbackProvider>
      <ProjectSplitMenu split={split} runner={runner()} pinned={false} active={false}
        tabMenu={request} onTabMenuClose={() => { closed += 1; }}
        onPinnedChange={() => undefined} onNewSession={() => undefined} />
    </FeedbackProvider>
  );
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => { root.render(render(null)); });
  assert.equal(mountPoint.querySelectorAll("button").length, 0, "an unselected tab draws no ⋯");
  assertNoDomNode(domWindow.document.querySelector('[role="menu"]'));

  await act(async () => { root.render(render({ tab, point: { x: 120, y: 30 } })); await tick(); });
  const menu = domWindow.document.querySelector('[role="menu"]') as unknown as HTMLElement;
  assert.equal(menu.getAttribute("aria-label"), "Project One Actions");
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "New Session Here");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await tick();
  });
  assert.equal(closed, 1);
  assert.equal(domWindow.document.activeElement, tab, "Escape returns focus to the tab");
  await act(async () => { root.unmount(); });
  mountPoint.remove();
  tab.remove();
});

test("the archive confirmation names how many sessions it archives and keeps its button (#2199)", async () => {
  const eight: InboxSplit = {
    ...split,
    sessions: Array.from({ length: 8 }, (_, index) => ({ ...session(`session-${index + 1}`), status: "running" as const })),
    count: 8,
  };
  const view = await mountMenu(
    <FeedbackProvider>
      <ProjectSplitMenu split={eight} runner={runner()} pinned={false}
        onPinnedChange={() => undefined} onNewSession={() => undefined} />
    </FeedbackProvider>,
  );
  await openMenu(view.container);
  await act(async () => { button(view.container, "Archive and Stop All Sessions…").click(); await tick(); });
  const dialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  assert.equal(domWindow.document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent, "Archive and Stop 8 Sessions");
  assert.ok(button(view.container, "Archive and Stop").classList.contains("danger"));
  await act(async () => { button(view.container, "Cancel").click(); await tick(); });
  await view.unmount();
});

test("a legacy Workspace keeps its one reset: an empty name clears the display override (#2199)", async () => {
  const renamed: Array<[string, string, string]> = [];
  const client = {
    ...api,
    renameWorkspace: async (runnerId: string, workspaceId: string, name: string) => {
      renamed.push([runnerId, workspaceId, name]);
      return { ok: true as const };
    },
  } as ApiClient;
  const view = await mountMenu(
    <ApiProvider client={client}>
      <FeedbackProvider>
        <ProjectSplitMenu split={split} runner={runner()} pinned={false}
          onPinnedChange={() => undefined} onNewSession={() => undefined} />
      </FeedbackProvider>
    </ApiProvider>,
  );
  const { container } = view;
  await openMenu(container);
  await act(async () => { button(container, "Rename Workspace…").click(); await tick(); });
  const dialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  assert.equal(dialog.querySelector(".modal-title")?.textContent, "Rename Workspace");
  const input = dialog.querySelector<HTMLInputElement>("#rename-project-name")!;
  assert.equal(domWindow.document.getElementById(input.getAttribute("aria-describedby")!)?.textContent,
    "Leave empty to use the folder name.");
  const submit = button(container, "Rename Workspace");

  // Unchanged is still refused.
  await act(async () => { submit.click(); await tick(); });
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(dialog.querySelector(".field-error")?.textContent, "Enter a name for the workspace.");
  assert.deepEqual(renamed, []);

  // Empty is the reset, sent as an empty name.
  await act(async () => { input.value = "  "; fireDomEvent.change(input); });
  assert.equal(input.hasAttribute("aria-invalid"), false, "an empty name is valid here");
  await act(async () => { submit.click(); await tick(); await tick(); });
  assert.deepEqual(renamed, [["runner-1", "workspace-1", ""]]);
  assertNoDomNode(domWindow.document.querySelector('[role="dialog"]'));
  await view.unmount();
});
