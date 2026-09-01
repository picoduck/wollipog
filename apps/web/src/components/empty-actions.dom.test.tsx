import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AutomationSchedule, AutomationSpec, RunnerView, SessionView, UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { AutomationsView } from "./AutomationsView.js";
import { Board } from "./Board.js";
import { RunnersView } from "./RunnersView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";

/**
 * What the empty-state actions actually DO.
 *
 * The first version of these checks asserted that the string `action=` appeared near each `Empty`.
 * Review then found three separate ways an action could be present and still not get the user out
 * of the empty screen — stale edit state, a filter the action does not clear, and an action aimed at
 * the wrong control plane — and every one of them satisfied that assertion. An action is a promise
 * that the screen changes; the only way to check a promise like that is to click it.
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  // The Board's columns render through MeasuredVirtualList, which observes its own height. happy-dom
  // has no layout, so the observer never has a size to report — a stub that never fires is the
  // honest model of that, and the list falls back to rendering its items.
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** The Sessions view owns board scoping now (split, query, reminder mode); this harness supplies
 * what it would: the store's unarchived sessions with no extra narrowing. */
function BoardHarness({ onNewSession }: { onNewSession: () => void }) {
  const sessions = useStoreSelector((s) => s.sessions);
  const scoped = React.useMemo(() => [...sessions.values()].filter((s) => !s.archived), [sessions]);
  return <Board sessions={scoped} searchActive={false} onShowAll={() => {}} onNewSession={onNewSession} onSessionMenu={() => {}} />;
}

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 63,
};

const session = {
  id: "session-1",
  runnerId: "runner-1",
  workspaceId: "workspace-1",
  agentId: "claude",
  title: "A Session",
  status: "idle",
  column: "doing",
  archived: false,
  createdAt: 1,
  updatedAt: 1,
} as unknown as SessionView;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const navigation: ViewNavigation = { current: () => ({ name: "inbox" }), push() {}, listen: () => () => {} };

function snapshot(overrides: Partial<UiSnapshotMessage> = {}): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner], boxes: [], projects: [], sessions: [], runs: [], pods: [],
    ...overrides,
  };
}

let sequence = 0;

/** Mount `children` inside every provider the views under test read from. */
async function mount(
  client: Partial<ApiClient>,
  children: React.ReactNode,
  instances?: InstanceManager,
  nav: ViewNavigation = navigation,
) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `empty-actions-${sequence}`,
    runtimeKey: `empty-actions-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api, ...client } as unknown as ApiClient}>
        <InstancesContextProvider value={instances ?? browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection} navigation={nav}>{children}</StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  return { container, root, socket, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}


/** Wait past the component's five-second poll so one more refresh cycle starts and lands. */
const nextPoll = () => new Promise((resolve) => setTimeout(resolve, 5_100));

const buttonLabelled = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);

const automation = (id: string, name: string): AutomationSchedule => ({
  automationId: id, name, cron: "0 9 * * 1-5", timezone: "UTC", enabled: true,
  misfirePolicy: { kind: "skip" }, runnerPolicy: { kind: "wait" }, concurrencyPolicy: "wait",
  limits: { maxCostUsd: 5, maxToolCalls: 50 }, notifications: { pushEvents: ["failed"] },
  action: { kind: "create_session", request: { runnerId: "runner-1", workspaceId: "workspace-1", agentId: "claude", prompt: "go" } },
  createdAt: 1, updatedAt: 1,
} as unknown as AutomationSchedule);

test("the empty state's New Automation creates, even after an edit was cancelled", async () => {
  // The reported sequence, exactly: edit an automation, cancel, let it be deleted, then take the
  // empty state's way out. Cancel used to leave `editingId` set, and the empty-state action only
  // flipped `showForm` — so the editor reopened titled "Edit Automation" over the old form, and
  // Save sent `updateAutomation` for an ID the control plane no longer had.
  let items = [automation("automation-1", "Nightly")];
  const created: AutomationSpec[] = [];
  const updated: string[] = [];
  const { container, unmount } = await mount({
    automations: async () => ({ automations: items }),
    automation: async () => ({ executions: [] }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => [],
    createAutomation: async (spec: AutomationSpec) => { created.push(structuredClone(spec)); return {} as never; },
    updateAutomation: async (id: string) => { updated.push(id); return {} as never; },
    deleteAutomation: async (id: string) => { items = items.filter((item) => item.automationId !== id); return {} as never; },
  } as unknown as Partial<ApiClient>, <AutomationsView />);

  await act(async () => { await Promise.resolve(); });
  const edit = buttonLabelled(container, "Edit");
  assert.ok(edit, "the seeded automation renders with an Edit button");
  await act(async () => { fireDomEvent.click(edit!); });
  assert.match(container.querySelector(".automation-editor h3")?.textContent ?? "", /Edit Automation/);

  const cancel = buttonLabelled(container, "Cancel");
  await act(async () => { fireDomEvent.click(cancel!); });

  // Delete it the way a user would, through the confirmation, so the refresh that empties the list
  // is the app's own rather than one the test staged.
  const remove = buttonLabelled(container, "Delete");
  await act(async () => { fireDomEvent.click(remove!); });
  const confirmDelete = buttonLabelled(container, "Delete Automation");
  assert.ok(confirmDelete, "deleting asks for confirmation first");
  await act(async () => { fireDomEvent.click(confirmDelete!); });
  await act(async () => { await Promise.resolve(); });

  // This screen exposed its empty state as an `h3` before it moved to `Empty`, and heading
  // navigation is how a screen-reader user finds a section. A paragraph is not in that list.
  assert.equal(container.querySelector(".empty-title")?.tagName, "H3");

  const wayOut = [...container.querySelectorAll(".empty-action button")][0];
  assert.ok(wayOut, "the empty state offers a way out");
  await act(async () => { fireDomEvent.click(wayOut as never); });

  const heading = container.querySelector(".automation-editor h3")?.textContent ?? "";
  assert.match(heading, /New Automation/, `the empty state's action opened "${heading}"`);

  const save = buttonLabelled(container, "Save Automation");
  await act(async () => { fireDomEvent.click(save!); });
  await act(async () => { await Promise.resolve(); });

  assert.deepEqual(updated, [], "Save must not update an automation the user did not open");
  assert.equal(created.length, 1, "the way out of an empty screen has to create something");
  await unmount();
});

test("deleting the automation being edited closes the editor", async () => {
  // The other route to the same corrupt state, without a Cancel in it: leave the editor open and
  // delete what it points at. Save would then send `updateAutomation` for an ID that is gone.
  let items = [automation("automation-1", "Nightly")];
  const updated: string[] = [];
  const { container, unmount } = await mount({
    automations: async () => ({ automations: items }),
    automation: async () => ({ executions: [] }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => [],
    updateAutomation: async (id: string) => { updated.push(id); return {} as never; },
    deleteAutomation: async (id: string) => { items = items.filter((item) => item.automationId !== id); return {} as never; },
  } as unknown as Partial<ApiClient>, <AutomationsView />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Edit")!); });
  assert.ok(container.querySelector(".automation-editor"), "the editor is open on the automation");

  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Delete")!); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Delete Automation")!); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(container.querySelector(".automation-editor"), null,
    "an editor pointed at a deleted automation has nothing left to save");
  assert.deepEqual(updated, []);
  await unmount();
});

test("a board emptied by a filter offers to clear the filter, not to create", async () => {
  // Emptiness was read off the FILTERED list, so a filter that matched nothing rendered "No Sessions
  // Yet" and offered New Session — which creates on the dialog's default Machine, leaves the filter
  // in place, and returns the user to the same empty board.
  let created = 0;
  const { container, socket, unmount } = await mount({}, <BoardHarness onNewSession={() => { created += 1; }} />);
  await act(async () => { socket.push(snapshot({ sessions: [session] })); });

  assert.equal(container.querySelector(".empty"), null, "one unfiltered session is not an empty board");

  const machine = container.querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    machine.value = "runner-1";
    fireDomEvent.change(machine as never, { target: { value: "runner-1" } as never });
  });
  assert.equal(container.querySelector(".empty"), null, "the filter that matches is not empty either");

  // A Machine with no sessions on it.
  await act(async () => { socket.push(snapshot({ runners: [runner, { ...runner, runnerId: "runner-2", hostname: "other" }], sessions: [session] })); });
  const machine2 = container.querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    machine2.value = "runner-2";
    fireDomEvent.change(machine2 as never, { target: { value: "runner-2" } as never });
  });

  const title = container.querySelector(".empty-title")?.textContent ?? "";
  assert.equal(title, "No Matching Sessions", `a filtered-out board said "${title}"`);
  const action = container.querySelector(".empty-action button") as unknown as HTMLButtonElement;
  assert.equal((action.textContent ?? "").trim(), "Clear Filters");

  await act(async () => { fireDomEvent.click(action as never); });
  assert.equal(created, 0, "clearing a filter is not creating a session");
  assert.equal(container.querySelector(".empty"), null, "and it has to actually put the sessions back");
  await unmount();
});

test("a remote instance with no machines is not offered local setup", async () => {
  // "local" onboarding drives the desktop bridge, whose runner-credential and socket work is
  // hard-coded to the loopback control plane. Offering it from the empty state of a REMOTE instance
  // set up a machine that screen would never show, and could overwrite the local runner doing it.
  // The toolbar already gated this on `offerLocalSetup`; the empty state did not.
  const remote: InstanceManager = {
    ...browserInstanceManager,
    desktopMultiInstance: true,
    activeProfile: { ...browserInstanceManager.activeProfile, id: "remote-1", kind: "remote", label: "Build Box" },
  };
  const { container, socket, unmount } = await mount(
    { getIdentity: async () => ({ context: { role: "owner" } }) } as unknown as Partial<ApiClient>,
    <RunnersView />,
    remote,
    { current: () => ({ name: "runners", section: "machines" }), push() {}, listen: () => () => {} },
  );
  await act(async () => { socket.push(snapshot({ runners: [], boxes: [] })); });
  await act(async () => { await Promise.resolve(); });

  const action = container.querySelector(".empty-action button") as unknown as HTMLButtonElement | null;
  assert.ok(action, "an owner looking at an empty remote instance is still offered a way to add a machine");
  assert.equal((action!.textContent ?? "").trim(), "Connect via SSH");

  await act(async () => { fireDomEvent.click(action as never); });
  // The local-onboarding dialog names This Machine; the SSH dialog does not.
  const opened = container.querySelector(".modal, [role='dialog']");
  assert.ok(opened, "the action opens something");
  assert.doesNotMatch(opened!.textContent ?? "", /This Machine/,
    "a remote instance's empty state must not open local onboarding");
  await unmount();
});

test("a genuinely empty board still offers to create", async () => {
  // The other half of the same branch: narrowing the filtered case must not swallow the real one.
  let created = 0;
  const { container, socket, unmount } = await mount({}, <BoardHarness onNewSession={() => { created += 1; }} />);
  await act(async () => { socket.push(snapshot({ sessions: [] })); });

  assert.equal(container.querySelector(".empty-title")?.textContent, "No Sessions Yet");
  const action = container.querySelector(".empty-action button") as unknown as HTMLButtonElement;
  assert.equal((action.textContent ?? "").trim(), "New Session");
  await act(async () => { fireDomEvent.click(action as never); });
  assert.equal(created, 1);
  await unmount();
});

test("an older poll cannot close an editor opened from a newer one", async () => {
  // Two refreshes are routinely in flight: the five-second poll plus one after every mutation. A
  // slow earlier request committing after a later one makes the screen go backwards — and since the
  // editor closes when its automation leaves the list, going backwards discards an unsaved form for
  // an automation that still exists.
  const held: Array<() => void> = [];
  let calls = 0;
  let items = [automation("automation-1", "Nightly")];
  const { container, unmount } = await mount({
    automations: async () => {
      calls += 1;
      const snapshot = items;
      // The FIRST call is held open; by the time it resolves, its list is stale.
      if (calls === 1) await new Promise<void>((resolve) => held.push(resolve));
      return { automations: snapshot };
    },
    automation: async () => ({ executions: [] }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => [],
  } as unknown as Partial<ApiClient>, <AutomationsView />);

  // A later refresh starts and completes with both automations while the first is still pending.
  items = [automation("automation-1", "Nightly"), automation("automation-2", "Weekly")];
  await act(async () => { await nextPoll(); });
  const edits = [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Edit");
  assert.equal(edits.length, 2, "both automations render before the stale poll lands");
  await act(async () => { fireDomEvent.click(edits[1]!); });
  assert.ok(container.querySelector(".automation-editor"), "the newer automation is open for editing");

  // Now the stale first poll finishes, carrying the one-item list.
  await act(async () => { for (const release of held) release(); await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  assert.ok(container.querySelector(".automation-editor"),
    "a poll that started BEFORE the automation existed must not conclude that it was deleted");
  await unmount();
});

test("a workflow-definition failure cannot keep a deleted automation on screen", async () => {
  // The list and the workflow definitions used to share a `Promise.all`, so a rejected workflow
  // fetch discarded a successful list. The deleted automation stayed, the editor stayed open on it,
  // and Save sent `updateAutomation` for an ID the control plane no longer had.
  let items = [automation("automation-1", "Nightly")];
  const updated: string[] = [];
  const { container, unmount } = await mount({
    automations: async () => ({ automations: items }),
    automation: async () => ({ executions: [] }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => { throw new Error("workflow service is down"); },
    updateAutomation: async (id: string) => { updated.push(id); return {} as never; },
    deleteAutomation: async (id: string) => {
      items = items.filter((item) => item.automationId !== id);
      return {} as never;
    },
  } as unknown as Partial<ApiClient>, <AutomationsView />);

  await act(async () => { await Promise.resolve(); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Edit")!); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Delete")!); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Delete Automation")!); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(container.querySelector(".automation-editor"), null,
    "an unrelated service being down must not keep an editor open on a deleted automation");
  assert.deepEqual(updated, []);
  await unmount();
});

test("deleting the edited automation leaves the others alone", async () => {
  // With one automation, an implementation that closed whenever the list became EMPTY would pass
  // the earlier test while being wrong. Two automations tell them apart.
  let items = [automation("automation-1", "Nightly"), automation("automation-2", "Weekly")];
  const { container, unmount } = await mount({
    automations: async () => ({ automations: items }),
    automation: async () => ({ executions: [] }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => [],
    deleteAutomation: async (id: string) => {
      items = items.filter((item) => item.automationId !== id);
      return {} as never;
    },
  } as unknown as Partial<ApiClient>, <AutomationsView />);

  await act(async () => { await Promise.resolve(); });
  const edits = [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Edit");
  await act(async () => { fireDomEvent.click(edits[1]!); });
  const deletes = [...container.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === "Delete");
  await act(async () => { fireDomEvent.click(deletes[1]!); });
  await act(async () => { fireDomEvent.click(buttonLabelled(container, "Delete Automation")!); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(container.querySelector(".automation-editor"), null, "the edited automation is gone");
  assert.equal(container.querySelectorAll(".automation-card").length, 1, "the other one is not");
  await unmount();
});

test("a board emptied by archiving still clears its filter on the way out", async () => {
  // Archive the last unarchived session while a filter is active and the count is zero, so this
  // renders the TRUE-empty branch — with the filter still on. Creating a session on the dialog's
  // own default would then be hidden by that filter and the board would come back empty.
  let created = 0;
  const { container, socket, unmount } = await mount(
    {}, <BoardHarness onNewSession={() => { created += 1; }} />);
  await act(async () => { socket.push(snapshot({ sessions: [session] })); });
  const machine = container.querySelector("select") as unknown as HTMLSelectElement;
  await act(async () => {
    machine.value = "runner-1";
    fireDomEvent.change(machine as never, { target: { value: "runner-1" } as never });
  });
  // The only session is archived: nothing unarchived is left, and the filter is still Machine 1.
  await act(async () => { socket.push(snapshot({ sessions: [{ ...session, archived: true } as SessionView] })); });

  assert.equal(container.querySelector(".empty-title")?.textContent, "No Sessions Yet");
  await act(async () => { fireDomEvent.click(container.querySelector(".empty-action button") as never); });
  assert.equal(created, 1, "the action still creates");
  const after = container.querySelector("select") as unknown as HTMLSelectElement;
  assert.equal(after.value, "", "and it must not leave a filter on that would hide what it creates");
  await unmount();
});
