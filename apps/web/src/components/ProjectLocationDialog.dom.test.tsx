import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ProjectView, ResourceScope, RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ProjectLocationDialog } from "./ProjectLocationDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const organizationScope: ResourceScope = {
  organizationId: "org-1",
  owner: { kind: "organization", organizationId: "org-1" },
};

const project: ProjectView = {
  id: "project-1",
  name: "Project One",
  hidden: false,
  scope: organizationScope,
  canManage: true,
  locations: [],
  activeSessionCount: 0,
  unarchivedSessionCount: 0,
  totalSessionCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  scope: organizationScope,
  agents: [],
  workspaces: [{
    id: "workspace-1",
    name: "Existing Location",
    path: "/repos/existing",
    scope: organizationScope,
    canManage: true,
  }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
};

test("Add Location surfaces identity failures without leaving compatibility checks pending", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const client = {
    ...api,
    getIdentity: async () => { throw new Error("identity service unavailable"); },
  } as ApiClient;
  try {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <ProjectLocationDialog
            project={project}
            projects={[project]}
            runners={new Map([[runner.runnerId, runner]])}
            boxes={new Map()}
            canCreateLocation
            accessScopeManagementSupported
            onClose={() => {}}
            onAdd={async () => {}}
            onCreate={async () => {}}
            onManageConnections={() => {}}
          />
        </ApiProvider>,
      );
      await new Promise((resolve) => domWindow.setTimeout(resolve, 0));
    });

    assert.match(container.textContent ?? "", /Access Scopes Could Not Be Loaded/);
    assert.match(container.textContent ?? "", /identity service unavailable/);
    assert.doesNotMatch(container.textContent ?? "", /Checking access compatibility/);
    const addButton = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.trim() === "Add to Project") as HTMLButtonElement | undefined;
    assert.ok(addButton);
    assert.equal(addButton.disabled, true, "adding stays fail-closed after identity loading fails");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});
