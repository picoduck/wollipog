import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PERSONAL_ORGANIZATION_ID,
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type IdentityAdministrationView,
  type OrganizationRole,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider } from "../instances-context.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { canManageProviderProfiles, RunnersView } from "./RunnersView.js";

/**
 * Provider profile routes (#3239) are neither member-scoped nor organization-admin routes, so the
 * control plane refuses them to Owners and Admins of any organization but its personal one. The
 * Machines view offers the actions only where the routes would accept them.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, HTMLButtonElement: domWindow.HTMLButtonElement, HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Element: domWindow.Element, Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1", hostname: "runner-host", os: "linux", version: "1", status: "online", agents: [],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.providerProfiles,
  canManage: true,
  providerAccounts: [
    { id: "granted", label: "Granted Work", provider: "claude", authStatus: "authenticated", profile: { id: "p1", access: "granted" } },
    { id: "legacy", label: "Legacy Work", provider: "codex", authStatus: "authenticated" },
  ],
};

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

function identity(organizationId: string, role: OrganizationRole): IdentityAdministrationView {
  return {
    context: { userId: "user-1", userName: "Owner", organizationId, organizationName: "Organization", role,
      deviceId: null, localBootstrap: false },
    organizations: [{ organizationId, name: "Organization", createdAt: 1 }],
    memberships: [], teams: [],
  };
}

let sequence = 0;

/** The profile action buttons the Machines view renders for this viewer. */
async function profileActions(viewer: IdentityAdministrationView): Promise<string[]> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `runner-profiles-${sequence}`, runtimeKey: `runner-profiles-${sequence}:1`,
    createSocket: () => socket, close() {},
  };
  const client = { ...api, getIdentity: async () => viewer } as unknown as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <InstancesContextProvider value={browserInstanceManager}>
          <FeedbackProvider>
            <StoreProvider connection={connection}
              // The machine's own route: with nothing selected the detail is the overview (#2986).
              navigation={{ current: () => ({ name: "runners", section: "machines", machineId: runner.runnerId }), push() {}, listen: () => () => {} }}>
              <RunnersView />
            </StoreProvider>
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [runner], boxes: [], projects: [], sessions: [], runs: [], pods: [],
    });
  });
  await act(async () => { for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  const rows = [...mountPoint.querySelectorAll<HTMLElement>(".provider-accounts-list > .row")]
    .filter((row) => row.textContent?.includes("Granted Work") || row.textContent?.includes("Legacy Work"));
  assert.equal(rows.length, 2, "both account rows render");
  // The profile actions are items of each row's ⋯ (#2995).
  const labels: string[] = [];
  for (const row of rows) {
    const more = row.querySelector<HTMLButtonElement>('button[aria-label^="More Actions for"]');
    if (!more) continue;
    await act(async () => { more.click(); });
    const menu = domWindow.document.body.querySelector('[role="menu"]');
    labels.push(...[...(menu?.querySelectorAll(".menu-item .menu-text") ?? [])].map((item) => item.textContent ?? "")
      .filter((label) => label === "Adopt as Profile…" || label === "Revoke Access…"));
    await act(async () => { (domWindow.document.body.querySelector(".menu-backdrop") as unknown as HTMLElement | null)?.click(); });
  }
  await act(async () => root.unmount());
  mountPoint.remove();
  return labels;
}

test("profile actions are offered to Owners and Admins of the personal organization only", async () => {
  for (const role of ["owner", "admin"] as const) {
    assert.deepEqual(await profileActions(identity(PERSONAL_ORGANIZATION_ID, role)), ["Revoke Access…", "Adopt as Profile…"],
      `a personal-organization ${role} sees both actions`);
    assert.deepEqual(await profileActions(identity("org_team", role)), [],
      `an ${role} of another organization, whom the routes refuse, sees none`);
  }
  assert.deepEqual(await profileActions(identity(PERSONAL_ORGANIZATION_ID, "operator")), [], "a member sees none");
});

test("the profile gate needs both the role and the personal organization", () => {
  assert.equal(canManageProviderProfiles({ organizationId: PERSONAL_ORGANIZATION_ID, role: "owner" }), true);
  assert.equal(canManageProviderProfiles({ organizationId: PERSONAL_ORGANIZATION_ID, role: "viewer" }), false);
  assert.equal(canManageProviderProfiles({ organizationId: "org_team", role: "admin" }), false);
  assert.equal(canManageProviderProfiles(null), false);
});
