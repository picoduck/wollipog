import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type ControlPlaneToUi,
  type ProjectView,
  type RunnerView,
  type SessionView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { MoveToProjectDialog, MoveToWorkspaceDialog, NewWorkspaceDialog } from "./SessionMoveDialogs.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * #2163: choosing a row only selects it; the primary names the outcome and is the only thing that
 * moves the session. The notices beside the choice replace the separate consent dialog.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
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

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    workspaceId: "workspace-billing",
    workspaceName: "Billing",
    projectId: "own",
    projectName: "Own",
    projectLocationId: "location-own",
    agentId: "codex",
    agentName: "Codex",
    title: "Session",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    audience: "user",
    ...overrides,
  } as SessionView;
}

function project(id: string, name: string, overrides: Partial<ProjectView> = {}, includesFolder = true): ProjectView {
  return {
    id,
    name,
    hidden: false,
    audience: "user",
    canManage: true,
    locations: includesFolder ? [{
      id: `location-${id}`,
      projectId: id,
      runnerId: "runner-1",
      workspaceId: "workspace-billing",
      name: "Billing",
      path: "/repos/billing",
      source: "managed",
      availability: "available",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }] : [],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function runner(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "runner-1",
    hostname: "studio",
    displayName: "Studio",
    os: "linux",
    status: "online",
    agents: [],
    workspaces: [
      { id: "workspace-billing", name: "Billing", path: "/repos/billing" },
      { id: "workspace-alpha", name: "Alpha", path: "/repos/alpha" },
    ],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 999,
    ...overrides,
  } as RunnerView;
}

const TEAM_PROJECT = project("team", "Team Project", {
  audience: "team",
  scope: { organizationId: "org", owner: { kind: "team", teamId: "team-1" } },
});

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

let sequence = 0;

type Calls = Array<[string, ...unknown[]]>;

async function mount(
  render: (onClose: () => void) => React.ReactElement,
  data: { projects?: ProjectView[]; runners?: RunnerView[]; sessions?: SessionView[]; projectsSupported?: boolean },
  overrides: Partial<ApiClient> = {},
) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const body = domWindow.document.body as unknown as HTMLElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `session-move-${sequence}`,
    runtimeKey: `session-move-${sequence}:1`,
    createSocket: () => socket,
    onCredentialChange: () => () => {},
    close() {},
  };
  const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push: () => {}, listen: () => () => {} };
  const calls: Calls = [];
  let closed = 0;
  const client = {
    ...api,
    listAllSessions: async () => ({ sessions: data.sessions ?? [] }),
    getIdentity: async () => ({
      context: { userId: "user-1", organizationId: "org", role: "member" },
      organizations: [],
      memberships: [],
      teams: [{ teamId: "team-1", organizationId: "org", name: "Platform", memberUserIds: ["user-1"], createdAt: 1 }],
    }),
    setProject: async (...args: unknown[]) => { calls.push(["setProject", ...args]); return {}; },
    setWorkspace: async (...args: unknown[]) => { calls.push(["setWorkspace", ...args]); return {}; },
    createWorkspace: async (...args: unknown[]) => {
      calls.push(["createWorkspace", ...args]);
      return { workspace: { id: "workspace-new", name: "New", path: "/repos/new" } };
    },
    listDirectory: async (_runnerId: string, path: string) => ({
      path: path || "/repos",
      parent: "/",
      entries: [{ name: "new", path: "/repos/new", isDir: true }],
    }),
    ...overrides,
  } as unknown as ApiClient;
  const onClose = () => { closed += 1; };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            {render(onClose)}
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>,
    );
    await Promise.resolve();
  });
  const snapshot: UiSnapshotMessage = {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: data.projectsSupported ?? true },
    runners: data.runners ?? [runner()],
    boxes: [],
    ...(data.projects ? { projects: data.projects } : {}),
    sessions: data.sessions ?? [],
    runs: [],
    pods: [],
  };
  await act(async () => {
    socket.push(snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const dialog = (title: string) => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((candidate) => candidate.querySelector(".modal-title")?.textContent === title);
  const buttonIn = (scope: HTMLElement, label: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  const row = (scope: HTMLElement, title: string) => [...scope.querySelectorAll<HTMLElement>(".choice-row")]
    .find((candidate) => candidate.querySelector(".choice-row-title")?.firstChild?.textContent === title);
  return {
    body,
    socket,
    calls,
    closed: () => closed,
    dialog,
    buttonIn,
    row,
    choose: async (scope: HTMLElement, title: string) => {
      const target = row(scope, title);
      assert.ok(target, `${title} row exists`);
      await act(async () => { target.click(); });
    },
    press: async (button: HTMLButtonElement | undefined) => {
      assert.ok(button, "button exists");
      await act(async () => {
        fireDomEvent.click(button);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    },
    settle: async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    },
    unmount: async () => {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

const PROJECTS = [
  project("own", "Own"),
  project("linkable", "Linkable", {}, false),
  TEAM_PROJECT,
  project("legacy", "Legacy", { audience: undefined }),
  project("elsewhere", "Elsewhere", {}, false),
];

test("choosing a Move to Project row only selects it; the primary moves the session", async () => {
  const value = session();
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Project");
    assert.ok(dialog);
    assert.match(dialog.textContent ?? "", /Files stay where they are\. Only the project that lists this session changes\./);
    // The current project is selected and the primary says why it is disabled.
    const primary = view.buttonIn(dialog, "Move Session");
    assert.equal(primary?.disabled, true);
    assert.match(dialog.querySelector(".modal-foot")?.textContent ?? "", /Choose a different project\./);
    assert.match(view.row(dialog, "Own")?.textContent ?? "", /Current/);

    await view.choose(dialog, "No Project");
    assert.deepEqual(view.calls, [], "choosing a row never calls the move API");
    assert.equal(primary?.disabled, false);
    assert.doesNotMatch(dialog.textContent ?? "", /Choose a different project\./);
    assert.equal(view.body.querySelectorAll('[role="dialog"]').length, 1, "no separate confirmation opens");

    await view.press(view.buttonIn(dialog, "Move Session"));
    assert.deepEqual(view.calls, [["setProject", "session-1", null, { linkLocation: false }]]);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("a linkable project shows the folder notice and Add Folder and Move", async () => {
  const value = session({ adopted: true, importLocationReady: true, projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Project")!;
    assert.match(view.row(dialog, "Linkable")?.textContent ?? "", /Adds this folder to the project\./);
    await view.choose(dialog, "Linkable");
    const notice = dialog.querySelector(".notice");
    assert.match(notice?.className ?? "", /info/);
    assert.equal(notice?.textContent?.trim(),
      "Linkable will include /repos/billing. New sessions in that folder may be filed there too.");
    assert.deepEqual(view.calls, []);
    await view.press(view.buttonIn(dialog, "Add Folder and Move"));
    assert.deepEqual(view.calls, [["setProject", "session-1", "linkable", { linkLocation: true }]]);
    assert.equal(view.body.querySelectorAll('[role="dialog"]').length, 1, "no separate confirmation opened");
  } finally {
    await view.unmount();
  }
});

test("a selected project that can no longer take this folder cannot be moved to", async () => {
  // Codex review round 1 (#2257): revoking the permission to add folders after the row was chosen
  // left the primary enabled, and it sent a move without the folder link.
  const value = session({ adopted: true, importLocationReady: true, projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Project")!;
    await view.choose(dialog, "Linkable");
    assert.equal(view.buttonIn(dialog, "Add Folder and Move")?.disabled, false);
    await act(async () => {
      view.socket.push({ type: "project_upsert", project: { ...PROJECTS[1]!, canManage: false } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const primary = view.buttonIn(dialog, "Move Session");
    assert.equal(primary?.disabled, true, "the selection falls back to the current assignment");
    assert.match(dialog.querySelector(".modal-foot")?.textContent ?? "", /Choose a different project\./);
    assertNoDomNode(dialog.querySelector(".notice"), "no folder notice for a project that cannot take it");
    await view.press(primary);
    assert.deepEqual(view.calls, []);
  } finally {
    await view.unmount();
  }
});

test("a team project names the team in a warning and the primary says Move and Share", async () => {
  const value = session();
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    await view.settle();
    const dialog = view.dialog("Move to Project")!;
    assert.match(view.row(dialog, "Team Project")?.textContent ?? "", /Includes this folder\. Shared with the Platform team\./);
    await view.choose(dialog, "Team Project");
    const notice = dialog.querySelector(".notice");
    assert.match(notice?.className ?? "", /warning/);
    assert.equal(notice?.textContent?.trim(),
      "Members of the Platform team will be able to read this conversation. Moving it out later doesn't remove their access.");
    await view.press(view.buttonIn(dialog, "Move and Share"));
    assert.deepEqual(view.calls, [["setProject", "session-1", "team", { linkLocation: false }]]);
    assert.equal(view.closed(), 1);
    assert.equal(view.body.querySelectorAll('[role="dialog"]').length, 1, "no separate confirmation opened");
  } finally {
    await view.unmount();
  }
});

test("a team notice reads the owning team when team names cannot be read", async () => {
  const value = session();
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  }, { getIdentity: async () => { throw new Error("forbidden"); } });
  try {
    await view.settle();
    const dialog = view.dialog("Move to Project")!;
    await view.choose(dialog, "Team Project");
    assert.match(dialog.querySelector(".notice")?.textContent ?? "",
      /^Members of the owning team will be able to read this conversation\./);
  } finally {
    await view.unmount();
  }
});

test("an unknown audience shows its warning and Move and Share", async () => {
  const value = session();
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Project")!;
    await view.choose(dialog, "Legacy");
    const notice = dialog.querySelector(".notice");
    assert.match(notice?.className ?? "", /warning/);
    assert.equal(notice?.textContent?.trim(),
      "This Wollipog doesn't report who can read this project, so moving the session may change who can read this conversation.");
    assert.ok(view.buttonIn(dialog, "Move and Share"));
    assert.equal(view.body.querySelectorAll('[role="dialog"]').length, 1);
  } finally {
    await view.unmount();
  }
});

test("projects that cannot take this folder are counted under the list, and the line is absent otherwise", async () => {
  const value = session();
  let view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Project")!;
    assert.equal(view.row(dialog, "Elsewhere"), undefined);
    const line = dialog.querySelector(".session-move-unlisted");
    assert.match(line?.textContent ?? "", /^Projects you can't add this folder to aren't listed\. Manage Projects$/);
    assert.equal(line?.querySelector("a")?.textContent, "Manage Projects");
  } finally {
    await view.unmount();
  }
  view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: [project("own", "Own"), TEAM_PROJECT],
    sessions: [value],
  });
  try {
    assertNoDomNode(view.dialog("Move to Project")!.querySelector(".session-move-unlisted"), "no unlisted line");
  } finally {
    await view.unmount();
  }
});

test("a failed move keeps the dialog open with a danger notice above the footer", async () => {
  const value = session();
  const view = await mount((onClose) => <MoveToProjectDialog session={value} onClose={onClose} />, {
    projects: PROJECTS,
    sessions: [value],
  }, { setProject: async () => { throw new Error("The project is gone."); } });
  try {
    const dialog = view.dialog("Move to Project")!;
    await view.choose(dialog, "No Project");
    await view.press(view.buttonIn(dialog, "Move Session"));
    const alert = dialog.querySelector('.notice[role="alert"]');
    assert.equal(alert?.textContent?.trim(), "The project is gone.");
    assert.match(alert?.className ?? "", /danger/);
    assert.equal(view.closed(), 0);
    assert.equal(view.buttonIn(dialog, "Move Session")?.getAttribute("aria-busy"), null, "the primary is usable again");
  } finally {
    await view.unmount();
  }
});

test("Move to Workspace commits only through Move Session, with New Workspace… in the body", async () => {
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <MoveToWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Workspace")!;
    const primary = view.buttonIn(dialog, "Move Session");
    assert.equal(primary?.disabled, true);
    assert.match(dialog.querySelector(".modal-foot")?.textContent ?? "", /Choose a different workspace\./);
    const newWorkspace = view.buttonIn(dialog, "New Workspace…");
    assert.ok(newWorkspace?.closest(".modal-body"), "New Workspace… is a body action");
    assert.equal(dialog.querySelector(".modal-foot")?.contains(newWorkspace ?? null), false);

    await view.choose(dialog, "Alpha");
    assert.deepEqual(view.calls, []);
    await view.press(view.buttonIn(dialog, "Move Session"));
    assert.deepEqual(view.calls, [["setWorkspace", "session-1", "workspace-alpha"]]);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("New Workspace… is unavailable with a visible reason while the machine is offline", async () => {
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <MoveToWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    runners: [runner({ status: "offline" })],
    sessions: [value],
  });
  try {
    const dialog = view.dialog("Move to Workspace")!;
    const newWorkspace = view.buttonIn(dialog, "New Workspace…")!;
    assert.equal(newWorkspace.disabled, true);
    const reason = domWindow.document.getElementById(newWorkspace.getAttribute("aria-describedby") ?? "");
    assert.equal(reason?.textContent, "Studio is offline.");
  } finally {
    await view.unmount();
  }
});

test("Browse… in New Workspace on a runner without directory browsing says what to do (#2362)", async () => {
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <NewWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    runners: [runner({ protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing - 1 })],
    sessions: [value],
  });
  try {
    const dialog = view.dialog("New Workspace")!;
    const browse = view.buttonIn(dialog, "Browse…")!;
    assert.equal(browse.disabled, true);
    const reason = domWindow.document.getElementById(browse.getAttribute("aria-describedby") ?? "");
    assert.ok(reason?.classList.contains("field-helper"), "the reason is visible helper text under Folder");
    assert.equal(reason?.textContent, "This machine needs a newer runner for directory browsing. Update and restart the runner.");
  } finally {
    await view.unmount();
  }
});

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}

test("New Workspace asks for a Name and a Folder, stacks Choose Folder, and creates and moves", async () => {
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  const view = await mount((onClose) => <NewWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    sessions: [value],
  });
  try {
    const dialog = view.dialog("New Workspace")!;
    const labels = [...dialog.querySelectorAll("label")].map((label) => label.textContent);
    assert.deepEqual(labels, ["Name", "Folder"]);
    const [name, folder] = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    assert.match(name!.placeholder, /^e\.g\. /);
    assert.equal(folder!.readOnly, true);
    const create = view.buttonIn(dialog, "Create and Move")!;
    assert.equal(create.disabled, true);
    assert.match(dialog.querySelector(".modal-foot")?.textContent ?? "", /Enter a name and choose a folder\./);

    await view.press(view.buttonIn(dialog, "Browse…"));
    await view.settle();
    const chooser = view.dialog("Choose Folder");
    assert.ok(chooser, "Browse… stacks Choose Folder");
    assert.ok(view.dialog("New Workspace"), "the form stays open under it");
    assert.deepEqual([...chooser.querySelectorAll(".modal-foot button")].map((button) => button.textContent), ["Cancel", "Use This Folder"]);
    await view.press(view.buttonIn(chooser, "new"));
    await view.settle();
    await view.press(view.buttonIn(chooser, "Use This Folder"));
    assert.equal(view.dialog("Choose Folder"), undefined);
    assert.equal(folder!.value, "/repos/new");

    await typeInto(name!, "Billing Service");
    assert.equal(create.disabled, false);
    await view.press(create);
    await view.settle();
    assert.deepEqual(view.calls, [
      ["createWorkspace", "runner-1", { name: "Billing Service", path: "/repos/new" }],
      ["setWorkspace", "session-1", "workspace-new"],
    ]);
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("submitting New Workspace with Enter keeps the Name field focusable while it runs", async () => {
  // Codex review round 1 (#2257): disabling the focused field drops focus on <body> in a browser.
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  let release!: () => void;
  const view = await mount((onClose) => <NewWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    sessions: [value],
  }, {
    createWorkspace: () => new Promise((resolve) => {
      release = () => resolve({ workspace: { id: "workspace-new", name: "New", path: "/repos/new" } });
    }),
  } as Partial<ApiClient>);
  try {
    const dialog = view.dialog("New Workspace")!;
    const [name] = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    await view.press(view.buttonIn(dialog, "Browse…"));
    await view.settle();
    await view.press(view.buttonIn(view.dialog("Choose Folder")!, "Use This Folder"));
    await typeInto(name!, "Billing Service");
    await act(async () => {
      fireDomEvent.submit(dialog.querySelector("form")!);
      await Promise.resolve();
    });
    assert.equal(view.buttonIn(dialog, "Create and Move")?.getAttribute("aria-busy"), "true");
    assert.equal(name!.disabled, false);
    assert.equal(name!.readOnly, true);
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("a retry after the move failed reuses the workspace the first attempt created", async () => {
  const value = session({ projectId: null, projectName: null, projectLocationId: null });
  let failMove = true;
  const created: unknown[] = [];
  const view = await mount((onClose) => <NewWorkspaceDialog session={value} onClose={onClose} />, {
    projectsSupported: false,
    sessions: [value],
  }, {
    createWorkspace: async (...args: unknown[]) => {
      created.push(args);
      return { workspace: { id: "workspace-new", name: "New", path: "/repos/new" } };
    },
    setWorkspace: async () => {
      if (failMove) throw new Error("Try again.");
      return {} as SessionView;
    },
  } as Partial<ApiClient>);
  try {
    const dialog = view.dialog("New Workspace")!;
    const [name] = [...dialog.querySelectorAll<HTMLInputElement>("input")];
    await view.press(view.buttonIn(dialog, "Browse…"));
    await view.settle();
    await view.press(view.buttonIn(view.dialog("Choose Folder")!, "Use This Folder"));
    await typeInto(name!, "Billing Service");
    await view.press(view.buttonIn(dialog, "Create and Move"));
    await view.settle();
    assert.equal(dialog.querySelector('.notice[role="alert"]')?.textContent?.trim(), "Try again.");
    failMove = false;
    await view.press(view.buttonIn(dialog, "Create and Move"));
    await view.settle();
    assert.equal(created.length, 1, "the workspace is created once");
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});
