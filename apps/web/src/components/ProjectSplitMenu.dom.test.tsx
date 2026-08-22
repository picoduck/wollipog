import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { Simulate } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { RunnerView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { InboxSplit } from "../inbox.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ProjectSplitMenu } from "./ProjectSplitMenu.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";

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
    .find((candidate) => candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label);
  const match = find(container) ?? find(domWindow.document.body as unknown as HTMLElement);
  assert.ok(match, `missing button: ${label}`);
  return match;
}

async function openMenu(container: HTMLElement): Promise<void> {
  await act(async () => {
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => /^(?:Project|Workspace) Actions for Project One$/u.test(
        candidate.getAttribute("aria-label") ?? "",
      ));
    assert.ok(trigger, "missing Project or Workspace action trigger");
    trigger.click();
    await tick();
  });
}

test("project split menu is fixed, keyboard-managed, and restores trigger focus", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider>
        <FeedbackProvider>
          <ProjectSplitMenu split={split} runner={runner()} pinned={false} onPinnedChange={() => undefined} onNewSession={() => undefined} />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });

  const trigger = button(container, "Workspace Actions for Project One");
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
  assert.equal(menu.style.position, "fixed");
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "Pin Workspace");

  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
  });
  assert.equal(domWindow.document.activeElement?.textContent?.trim(), "Archive and Stop All Sessions");
  await act(async () => {
    domWindow.document.activeElement?.dispatchEvent(
      new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await tick();
  });
  assert.equal(body.querySelector('[role="menu"]'), null);
  assert.equal(domWindow.document.activeElement, trigger);

  await act(async () => { root.unmount(); });
  container.remove();
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
      return { ...session(sessionId), status: "stopped" as const, archiveStatus: "stop_pending" as const };
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  await act(async () => { button(container, "Create Permanent Worktree").click(); await tick(); });
  assert.deepEqual(presets, [
    { runnerId: "runner-1", workspaceId: "workspace-1", projectName: "Project One" },
    { runnerId: "runner-1", workspaceId: "workspace-1", worktree: true },
  ]);

  await openMenu(container);
  await act(async () => { button(container, "Rename Workspace").click(); await tick(); });
  const renameInput = container.querySelector<HTMLInputElement>('#rename-project-split-name')!;
  await act(async () => {
    renameInput.value = "Renamed Project";
    Simulate.change(renameInput);
  });
  await act(async () => { button(container, "Save").click(); await tick(); });
  assert.deepEqual(renamed, [["runner-1", "workspace-1", "Renamed Project"]]);

  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions").click(); await tick(); });
  assert.match(container.textContent ?? "", /Archive and stop 2 sessions\?/);
  assert.match(container.textContent ?? "", /runtime capacity will be released/);
  assert.match(container.textContent ?? "", /use Snooze instead/);
  await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
  assert.deepEqual(archived, [["session-1", true], ["session-2", true]]);
  assert.match(container.textContent ?? "", /2 sessions are waiting for runtime capacity to be released before archiving from Project One/);

  await act(async () => { root.unmount(); });
  container.remove();
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
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  await act(async () => { button(container, "Create Permanent Worktree").click(); await tick(); });

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
  container.remove();
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
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  assert.equal(button(container, "Create Permanent Worktree").disabled, false);
  assert.equal(button(container, "Reveal in File Manager").title, "Choose a default Location to use location actions.");
  const status = domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement;
  assert.match(status.textContent ?? "", /Location Actions:.*Choose a default Location/);
  await act(async () => { button(container, "New Session").click(); await tick(); });

  await openMenu(container);
  await act(async () => { button(container, "Create Permanent Worktree").click(); await tick(); });
  assert.deepEqual(presets, [
    { projectId: "project-1" },
    { projectId: "project-1", worktree: true },
  ], "the New Session dialog must make the user choose one of the available Locations");

  await act(async () => { root.unmount(); });
  container.remove();
});

test("project action guards fail closed for offline, stale, and native-Windows WSL workspaces", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  assert.equal(button(container, "Create Permanent Worktree").disabled, true);
  assert.match((domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement).textContent ?? "", /Location Actions:.*offline/);
  await act(async () => { button(container, "Workspace Actions for Project One").click(); await tick(); });

  await render(runner({ workspaces: [] }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, true);
  assert.match((domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement).textContent ?? "", /Location Actions:.*not advertised/);
  await act(async () => { button(container, "Workspace Actions for Project One").click(); await tick(); });

  await render(runner({ os: "windows", workspaces: [{ id: "workspace-1", name: "Project One", path: "/mnt/c/project-one" }] }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, false);
  assert.equal(button(container, "Create Permanent Worktree").disabled, false);
  assert.match((domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement).textContent ?? "", /Reveal:.*WSL workspace paths/);
  await act(async () => { button(container, "Workspace Actions for Project One").click(); await tick(); });

  await render(runner({ protocolVersion: 1 }));
  assert.equal(button(container, "Reveal in File Manager").disabled, true);
  assert.equal(button(container, "New Session Here").disabled, false);
  assert.match((domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement).textContent ?? "", /Reveal:/);

  await act(async () => { root.unmount(); });
  container.remove();
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
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  assert.equal(button(container, "Create Permanent Worktree").disabled, true);
  assert.equal(button(container, "Archive All Sessions").disabled, true);
  const noLocationStatus = domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement;
  assert.match(noLocationStatus.textContent ?? "", /Location Actions:.*Add a Project Location/);
  assert.match(noLocationStatus.textContent ?? "", /Archive:.*no unarchived sessions/);
  await act(async () => { button(container, "Pin Project").click(); await tick(); });
  assert.deepEqual(pinned, [true]);

  await openMenu(container);
  await act(async () => { button(container, "Rename Project").click(); await tick(); });
  const renameInput = container.querySelector<HTMLInputElement>("#rename-project-split-name")!;
  await act(async () => {
    renameInput.value = "Renamed Durable Project";
    Simulate.change(renameInput);
  });
  await act(async () => { button(container, "Save").click(); await tick(); });
  assert.deepEqual(renamed, [["project-1", "Renamed Durable Project"]]);

  await act(async () => { root.unmount(); });
  container.remove();
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
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
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
  assert.equal(button(container, "Rename Project").disabled, true);
  assert.equal(button(container, "Archive and Stop All Sessions").disabled, true);
  const permissionStatus = domWindow.document.querySelector('[role="note"]') as unknown as HTMLElement;
  assert.match(permissionStatus.textContent ?? "", /Project Management: Project management permission is required\./);
  assert.equal(domWindow.document.querySelector('[role="menu"]')?.getAttribute("aria-describedby"), permissionStatus.id);
  await act(async () => { button(container, "Project Actions for Project One").click(); await tick(); });

  await render(true);
  await openMenu(container);
  await act(async () => { button(container, "Archive and Stop All Sessions").click(); await tick(); });
  assert.match(container.textContent ?? "", /Archive and stop 2 sessions\?/);
  assert.match(container.textContent ?? "", /server applies the same stop-before-archive rule/);
  assert.match(container.textContent ?? "", /use Snooze instead/);
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
  await act(async () => { button(container, "Archive and Stop All Sessions").click(); await tick(); });
  await act(async () => { button(container, "Archive and Stop").click(); await tick(); await tick(); });
  assert.deepEqual(archivedProjects, ["project-1", "project-1"]);
  assert.match(container.textContent ?? "", /Sessions archived from Project One\. Exact undo is unavailable/);

  await act(async () => { root.unmount(); });
  container.remove();
});
