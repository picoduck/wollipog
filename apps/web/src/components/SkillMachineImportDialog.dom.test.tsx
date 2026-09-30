import assert from "node:assert/strict";
import test from "node:test";
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SkillMachineImportDialog } from "./SkillMachineImportDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * #1963 under StrictMode, which the app renders in and the e2e harness does not. Its simulated
 * unmount runs every effect cleanup once before the real mount: the dialog must still read the
 * machine exactly once (the server refuses a second concurrent read), and the stacked dialogs must
 * still show what their requests return rather than treating themselves as closed.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const runner: RunnerView = {
  runnerId: "runner-1", hostname: "runner-host", os: "linux", version: "1", status: "online", displayName: "Build Machine",
  agents: [
    { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true },
  ],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
};
const candidate = { id: "opaque", name: "code-review", sourceDirectory: ".codex/skills", generation: "g" };
const file = { path: "SKILL.md", encoding: "utf8" as const, content: "---\nname: code-review\n---\nReview" };

function fakeApi(calls: Record<string, number>): ApiClient {
  const count = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  return {
    ...api,
    discoverMachineSkills: async () => { count("discover"); return { discoveryId: "discovery", candidates: [candidate] }; },
    discardMachineSkillDiscovery: async () => { count("discard"); },
    previewMachineSkill: async () => {
      count("preview");
      return { previewId: "preview", candidate, files: [file], previousFiles: [file], digest: "d", disposition: "identical" as const, assignmentCount: 1 };
    },
    preflightMachineSkillAdoption: async () => {
      count("preflight");
      return { status: "prerequisites_met" as const, mutationSupported: true, blockers: [], advisories: [], adoptionToken: "token",
        sharedReaders: ["codex"], source: { candidate, digest: "d", checkedAt: 1 }, notice: "" };
    },
    inspectMachineSkillRecovery: async () => {
      count("recovery");
      return { truncated: false, operations: [{ operationId: "op", backupDirectory: "b", sourceDirectory: ".codex/skills",
        name: "code-review", digest: "d", state: "managed_linked" as const, detail: "Linked." }] };
    },
  } as ApiClient;
}

function dialogTitled(title: string): Element {
  const found = [...document.querySelectorAll('[role="dialog"]')].find((dialog) => dialog.querySelector(".modal-title")?.textContent === title);
  assert.ok(found, `a dialog titled ${title}`);
  return found;
}

function buttonNamed(name: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? (button.querySelector(".menu-text") ?? button).textContent?.trim()) === name);
  assert.ok(found, `a button named ${name}`);
  return found;
}

test("under StrictMode the dialog reads the machine once, and its stacked dialogs show their results", async () => {
  const calls: Record<string, number> = {};
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StrictMode><ApiProvider client={fakeApi(calls)}><FeedbackProvider>
      <SkillMachineImportDialog runners={[runner]} libraryNames={new Set(["code-review"])} onClose={() => undefined}
        onImported={async () => undefined} />
    </FeedbackProvider></ApiProvider></StrictMode>);
  });
  await settle();
  assert.equal(calls.discover, 1, "the folders are read once, not once per simulated mount");
  const row = [...document.querySelectorAll<HTMLButtonElement>(".row.row-2")].find((button) => button.textContent?.includes("code-review"));
  assert.ok(row, "the folder is listed without another button");
  assert.match(row.textContent ?? "", /In Library/u);

  await act(async () => { row.click(); });
  await settle();
  assert.equal(calls.preview, 1);
  assert.match(row.textContent ?? "", /Matches Latest/u);

  await act(async () => { buttonNamed("Replace with Link…").click(); });
  await settle();
  assert.equal(calls.preflight, 1, "the safety check runs once when the confirmation opens");
  const confirmation = dialogTitled("Replace with Link");
  assert.match(confirmation.textContent ?? "", /Codex/u, "the check's shared readers are shown, by agent name");
  assert.doesNotMatch(confirmation.textContent ?? "", /Running the safety check/u);
  await act(async () => { buttonNamed("Cancel", confirmation).click(); });
  assert.ok(document.querySelector(".row.is-selected"), "Cancel returns to the dialog with the selection kept");
  await settle();

  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { buttonNamed("Adoption Recovery…").click(); });
  await settle();
  assert.equal(calls.recovery, 1);
  const recovery = dialogTitled("Adoption Recovery");
  assert.match(recovery.textContent ?? "", /Linked/u, "the journals are shown");

  // However the dialog goes away, its discovery is discarded on the server.
  await act(async () => { root.unmount(); });
  container.remove();
  assert.equal(calls.discard, 1);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function mountDialog(client: ApiClient, onImported: () => Promise<void>, runners: RunnerView[] = [runner]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<StrictMode><ApiProvider client={client}><FeedbackProvider>
      <SkillMachineImportDialog runners={runners} libraryNames={new Set(["code-review"])} onClose={() => undefined}
        onImported={onImported} />
    </FeedbackProvider></ApiProvider></StrictMode>);
  });
  await settle();
  return async () => { await act(async () => { root.unmount(); }); container.remove(); };
}

const folderRow = () => document.querySelector<HTMLButtonElement>(".row.row-2")!;
const machineSelect = () => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => /^Machine\b/u.test(button.getAttribute("aria-label") ?? ""))!;

test("the dialog stays on its machine, locked, until the page refresh after an adoption settles", async () => {
  const calls: Record<string, number> = {};
  const discovered: string[] = [];
  const refresh = deferred();
  const other: RunnerView = { ...runner, runnerId: "runner-2", displayName: "Other Machine" };
  const client = { ...fakeApi(calls),
    discoverMachineSkills: async (runnerId: string) => { discovered.push(runnerId); return { discoveryId: "discovery", candidates: [candidate] }; },
    adoptMachineSkill: async () => ({ status: "adopted" as const, operationId: "op", backupDirectory: "b" }),
  } as ApiClient;
  const unmount = await mountDialog(client, () => refresh.promise, [runner, other]);
  await act(async () => { folderRow().click(); });
  await settle();
  await act(async () => { buttonNamed("Replace with Link…").click(); });
  await settle();
  await act(async () => { buttonNamed("Replace with Link", dialogTitled("Replace with Link")).click(); });
  await settle();
  // The confirmation has closed, the page is still refreshing: nothing may start another read.
  assert.equal(machineSelect()?.getAttribute("aria-disabled"), "true", "the Machine select waits for the refresh");
  assert.ok(folderRow().disabled, "the folders wait for the refresh");
  assert.equal(document.body.textContent?.includes("Replace with Link…"), false, "the consumed review is gone");
  await act(async () => { refresh.resolve(); });
  await settle();
  assert.deepEqual(discovered, ["runner-1", "runner-1"], "the folders are read again on the same machine");
  await unmount();
});

test("a failed page refresh after an adoption is reported, and the folders are still read again", async () => {
  const calls: Record<string, number> = {};
  const client = { ...fakeApi(calls),
    adoptMachineSkill: async () => ({ status: "adopted" as const, operationId: "op", backupDirectory: "b" }),
  } as ApiClient;
  const unmount = await mountDialog(client, async () => { throw new Error("Skills list unavailable."); });
  await act(async () => { folderRow().click(); });
  await settle();
  await act(async () => { buttonNamed("Replace with Link…").click(); });
  await settle();
  await act(async () => { buttonNamed("Replace with Link", dialogTitled("Replace with Link")).click(); });
  await settle();
  assert.match(document.body.textContent ?? "", /didn't refresh: Skills list unavailable\./u);
  assert.match(document.body.textContent ?? "", /Replaced with Link/u);
  assert.equal(calls.discover, 2, "the folders are read again");
  assert.equal(document.body.textContent?.includes("Replace with Link…"), false);
  await unmount();
});

test("a safety check still running after its confirmation is cancelled keeps the dialog from reading", async () => {
  const calls: Record<string, number> = {};
  const check = deferred<Awaited<ReturnType<ApiClient["preflightMachineSkillAdoption"]>>>();
  const base = fakeApi(calls);
  const client = { ...base, preflightMachineSkillAdoption: () => check.promise } as ApiClient;
  const unmount = await mountDialog(client, async () => undefined);
  await act(async () => { folderRow().click(); });
  await settle();
  await act(async () => { buttonNamed("Replace with Link…").click(); });
  await settle();
  await act(async () => { buttonNamed("Cancel", dialogTitled("Replace with Link")).click(); });
  await settle();
  assert.ok(folderRow().disabled, "the server is still checking, so no folder can be read yet");
  assert.equal(machineSelect()?.getAttribute("aria-disabled"), "true");
  await act(async () => { buttonNamed("More Actions").click(); });
  assert.ok(buttonNamed("Adoption Recovery…").disabled, "recovery waits too");
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { check.resolve(await base.preflightMachineSkillAdoption("discovery", "preview")); });
  await settle();
  assert.equal(folderRow().disabled, false, "once it settles the dialog reads again");
  await unmount();
});
