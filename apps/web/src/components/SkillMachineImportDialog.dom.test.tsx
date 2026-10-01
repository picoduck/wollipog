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
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/**
 * #1963 under StrictMode, which the app renders in and the e2e harness does not. Its simulated
 * unmount runs every effect cleanup once before the real mount: the dialog must still read the
 * machine exactly once (the server refuses a second concurrent read), and the stacked dialogs must
 * still show what their requests return rather than treating themselves as closed.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
/** Whether the window is phone-width: max-width queries match while it is set. */
let phoneWidth = false;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({ matches: phoneWidth && query.includes("max-width"), media: query, addEventListener() {}, removeEventListener() {} }),
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
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
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

const newVersion = () => ({ previewId: "preview", candidate, files: [{ ...file, content: `${file.content}!` }], previousFiles: [file],
  digest: "e", disposition: "update" as const, assignmentCount: 0 });

test("a failed page refresh after an import stays reported through the automatic re-read", async () => {
  const calls: Record<string, number> = {};
  let previews = 0;
  const base = fakeApi(calls);
  const client = { ...base,
    previewMachineSkill: async (id: string, candidateId: string) => (previews++ === 0 ? newVersion() : base.previewMachineSkill(id, candidateId)),
    importMachineSkill: async () => ({}) as never,
  } as ApiClient;
  const unmount = await mountDialog(client, async () => { throw new Error("Skills list unavailable."); });
  await act(async () => { folderRow().click(); });
  await settle();
  await act(async () => { buttonNamed("Import as New Version").click(); });
  await settle();
  assert.equal(previews, 2, "the folder is read again after the import");
  assert.match(document.body.textContent ?? "", /didn't refresh: Skills list unavailable\./u);
  await unmount();
});

test("Import waits while a recovery read dismissed before it finished is still running", async () => {
  const calls: Record<string, number> = {};
  const journals = deferred<Awaited<ReturnType<ApiClient["inspectMachineSkillRecovery"]>>>();
  const base = fakeApi(calls);
  const client = { ...base, previewMachineSkill: async () => newVersion(), inspectMachineSkillRecovery: () => journals.promise } as ApiClient;
  const unmount = await mountDialog(client, async () => undefined);
  await act(async () => { folderRow().click(); });
  await settle();
  assert.equal(buttonNamed("Import as New Version").disabled, false);
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { buttonNamed("Adoption Recovery…").click(); });
  await settle();
  await act(async () => { buttonNamed("Done", dialogTitled("Adoption Recovery")).click(); });
  await settle();
  assert.ok(buttonNamed("Import as New Version").disabled, "the server is still reading the journals");
  await act(async () => { journals.resolve(await base.inspectMachineSkillRecovery("runner-1")); });
  await settle();
  assert.equal(buttonNamed("Import as New Version").disabled, false);
  await unmount();
});

test("a restore still running after its confirmation is cancelled locks Restore Original, then refreshes", async () => {
  const calls: Record<string, number> = {};
  const restoring = deferred<Awaited<ReturnType<ApiClient["restoreMachineSkillRecovery"]>>>();
  let restores = 0;
  let refreshes = 0;
  const client = { ...fakeApi(calls), restoreMachineSkillRecovery: () => { restores++; return restoring.promise; } } as ApiClient;
  const unmount = await mountDialog(client, async () => { refreshes++; });
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { buttonNamed("Adoption Recovery…").click(); });
  await settle();
  const recovery = dialogTitled("Adoption Recovery");
  await act(async () => { buttonNamed("Restore Original…", recovery).click(); });
  await settle();
  await act(async () => { buttonNamed("Restore Original", dialogTitled("Restore Original")).click(); });
  await settle();
  await act(async () => { buttonNamed("Cancel", dialogTitled("Restore Original")).click(); });
  await settle();
  assert.ok(buttonNamed("Restore Original…", recovery).disabled, "a second restore would meet the first");
  assert.equal(restores, 1);
  await act(async () => { restoring.resolve({ status: "restored" }); });
  await settle();
  assert.equal(calls.recovery, 2, "the journals are read again once the cancelled restore finishes");
  assert.equal(refreshes, 1, "and the page is refreshed after it restored");
  assert.equal(buttonNamed("Restore Original…", recovery).disabled, false);
  await unmount();
});

const MACHINE_REQUESTS = ["discoverMachineSkills", "previewMachineSkill", "preflightMachineSkillAdoption", "adoptMachineSkill",
  "importMachineSkill", "inspectMachineSkillRecovery", "restoreMachineSkillRecovery"] as const;

/** Wraps every machine request to record how many ran at once: the server refuses a second. */
function probeConcurrency(client: ApiClient) {
  const probe = { active: 0, most: 0 };
  const wrapped = { ...client } as Record<string, unknown>;
  for (const name of MACHINE_REQUESTS) {
    const original = client[name] as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      probe.active += 1;
      probe.most = Math.max(probe.most, probe.active);
      try { return await original(...args); } finally { probe.active -= 1; }
    };
  }
  return { client: wrapped as unknown as ApiClient, probe };
}

test("Adoption Recovery waits through a rescan, even while the old discovery is being discarded", async () => {
  const calls: Record<string, number> = {};
  const discarding = deferred();
  let discards = 0;
  const { client, probe } = probeConcurrency({ ...fakeApi(calls),
    discardMachineSkillDiscovery: () => (discards++ === 0 ? discarding.promise : Promise.resolve()),
  } as ApiClient);
  const unmount = await mountDialog(client, async () => undefined);
  await act(async () => { buttonNamed("Scan Again").click(); });
  await act(async () => { buttonNamed("More Actions").click(); });
  assert.ok(buttonNamed("Adoption Recovery…").disabled, "recovery waits for the rescan");
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { discarding.resolve(); });
  await settle();
  assert.equal(calls.discover, 2);
  assert.equal(probe.most, 1, "never two machine requests at once");
  await unmount();
});

test("cancelling a restore retry reads the journals only after the retry settles", async () => {
  const calls: Record<string, number> = {};
  const retry = deferred<Awaited<ReturnType<ApiClient["restoreMachineSkillRecovery"]>>>();
  let restores = 0;
  const { client, probe } = probeConcurrency({ ...fakeApi(calls),
    restoreMachineSkillRecovery: async () => (restores++ === 0 ? { status: "blocked" as const, error: "The source path is occupied." } : retry.promise),
  } as ApiClient);
  const unmount = await mountDialog(client, async () => undefined);
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { buttonNamed("Adoption Recovery…").click(); });
  await settle();
  await act(async () => { buttonNamed("Restore Original…", dialogTitled("Adoption Recovery")).click(); });
  await settle();
  const confirmation = dialogTitled("Restore Original");
  await act(async () => { buttonNamed("Restore Original", confirmation).click(); });
  await settle();
  assert.match(confirmation.textContent ?? "", /The source path is occupied\./u, "the first attempt stopped");
  await act(async () => { buttonNamed("Restore Original", confirmation).click(); });
  await settle();
  await act(async () => { buttonNamed("Cancel", confirmation).click(); });
  await settle();
  assert.equal(calls.recovery, 1, "no journal read while the retry runs");
  await act(async () => { retry.resolve({ status: "blocked", error: "Still occupied." }); });
  await settle();
  assert.equal(calls.recovery, 2, "the journals are read once the retry settles");
  assert.equal(probe.most, 1, "never two machine requests at once");
  await unmount();
});

test("a restore that fails after its confirmation is cancelled still re-reads the journals", async () => {
  const calls: Record<string, number> = {};
  const restoring = deferred<Awaited<ReturnType<ApiClient["restoreMachineSkillRecovery"]>>>();
  const { client } = probeConcurrency({ ...fakeApi(calls), restoreMachineSkillRecovery: () => restoring.promise } as ApiClient);
  const unmount = await mountDialog(client, async () => undefined);
  await act(async () => { buttonNamed("More Actions").click(); });
  await act(async () => { buttonNamed("Adoption Recovery…").click(); });
  await settle();
  await act(async () => { buttonNamed("Restore Original…", dialogTitled("Adoption Recovery")).click(); });
  await settle();
  const confirmation = dialogTitled("Restore Original");
  await act(async () => { buttonNamed("Restore Original", confirmation).click(); });
  await act(async () => { buttonNamed("Cancel", confirmation).click(); });
  await settle();
  await act(async () => { restoring.reject(new Error("The restore result could not be verified.")); });
  await settle();
  assert.equal(calls.recovery, 2, "the journals are read again: the restore may have happened");
  await unmount();
});

test("closing mid-read and opening again waits for the first read instead of meeting it", async () => {
  const calls: Record<string, number> = {};
  const firstRead = deferred<Awaited<ReturnType<ApiClient["discoverMachineSkills"]>>>();
  let reads = 0;
  const base = fakeApi(calls);
  const { client, probe } = probeConcurrency({ ...base,
    discoverMachineSkills: (runnerId: string) => (reads++ === 0 ? firstRead.promise : base.discoverMachineSkills(runnerId)),
  } as ApiClient);
  const closeFirst = await mountDialog(client, async () => undefined);
  await closeFirst();
  const closeSecond = await mountDialog(client, async () => undefined);
  assert.equal(reads, 1, "the second opening's read waits for the first");
  await act(async () => { firstRead.resolve({ discoveryId: "first", candidates: [candidate] }); });
  await settle();
  assert.equal(reads, 2);
  assert.equal(probe.most, 1, "never two machine requests at once");
  assert.doesNotMatch(document.body.textContent ?? "", /Couldn't Read Skill Folders/u);
  assert.ok(folderRow(), "the second opening lists the folders");
  assert.ok((calls.discard ?? 0) >= 1, "the first opening's late discovery is discarded");
  await closeSecond();
});

/** #2283: a phone shows the folders or the review, so a pane change can unmount the focused control. */
const second = { ...candidate, id: "second", name: "release-notes" };
function twoFolders(calls: Record<string, number>, overrides: Partial<ApiClient> = {}): ApiClient {
  const base = fakeApi(calls);
  return { ...base,
    discoverMachineSkills: async () => ({ discoveryId: "discovery", candidates: [candidate, second] }),
    previewMachineSkill: async (id: string, candidateId: string) => {
      const preview = await base.previewMachineSkill(id, candidateId);
      return candidateId === second.id ? { ...preview, candidate: second } : preview;
    },
    ...overrides,
  } as ApiClient;
}
const importDialog = () => dialogTitled("Import from Machine") as HTMLElement;
const folderRows = () => [...importDialog().querySelectorAll<HTMLButtonElement>('[aria-label="Skill Folders"] > button')];
const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null;
const focusInDialog = () => importDialog().contains(document.activeElement);
async function resize(phone: boolean) {
  phoneWidth = phone;
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("resize")); });
  await settle();
}
async function choose(row: HTMLButtonElement) {
  await act(async () => { row.focus(); });
  await act(async () => { row.click(); });
  await settle();
}

test("on a phone, choosing a folder moves focus to Back, and Back returns it to the chosen folder (#2283)", async () => {
  phoneWidth = true;
  try {
    const unmount = await mountDialog(twoFolders({}), async () => undefined);
    await choose(folderRows()[1]!);
    assert.equal(folderRows().length, 0, "the review replaces the folders");
    assert.ok(focusInDialog(), "choosing keeps focus inside the dialog");
    assert.equal(focused(), "Back to Skill Folders");
    // Back keeps its header button, which is Close on the list step: focus goes to the chosen folder.
    await act(async () => { buttonNamed("Back to Skill Folders").click(); });
    await settle();
    assert.equal(folderRows().length, 2);
    assert.ok(folderRows()[1] === document.activeElement, "Back returns focus to the chosen folder");
    await unmount();
  } finally { phoneWidth = false; }
});

test("crossing the phone breakpoint either way keeps focus inside Import from Machine (#2283)", async () => {
  try {
    const unmount = await mountDialog(twoFolders({}), async () => undefined);
    // Wide: both panes show. Choosing leaves focus on the row; narrowing hides the folders.
    await choose(folderRows()[1]!);
    assert.ok(folderRows()[1] === document.activeElement);
    await resize(true);
    assert.equal(folderRows().length, 0);
    assert.ok(focusInDialog(), "narrowing keeps focus inside the dialog");
    assert.equal(focused(), "Back to Skill Folders");
    // Widening keeps the header button (now Close) and the focus on it.
    await resize(false);
    assert.ok(focusInDialog(), "widening keeps focus inside the dialog");
    assert.equal(focused(), "Close");
    // Back to the list on a phone, then wider: focus a control in the review, and narrow again,
    // which hides the review: focus goes to the chosen folder.
    await resize(true);
    await act(async () => { buttonNamed("Back to Skill Folders").focus(); });
    await act(async () => { buttonNamed("Back to Skill Folders").click(); });
    await settle();
    await resize(false);
    assert.ok(folderRows()[1] === document.activeElement, "widening leaves focus on the chosen folder");
    await act(async () => { buttonNamed("Replace with Link…").focus(); });
    assert.equal(focused(), "Replace with Link…");
    await resize(true);
    assertNoDomNode(importDialog().querySelector(".skill-machine-import-pane.review"), "the review is hidden on the list step");
    assert.ok(focusInDialog(), "narrowing keeps focus inside the dialog");
    assert.ok(folderRows()[1] === document.activeElement, "focus goes to the chosen folder");
    await unmount();
  } finally { phoneWidth = false; }
});

test("a pane change while an import runs leaves focus on the dialog when the folders refuse it (#2283)", async () => {
  const importing = deferred<never>();
  const client = twoFolders({}, {
    previewMachineSkill: async () => ({ ...newVersion(), candidate: second }),
    importMachineSkill: () => importing.promise,
  });
  try {
    const unmount = await mountDialog(client, async () => undefined);
    phoneWidth = true;
    await resize(true);
    await choose(folderRows()[1]!);
    await act(async () => { buttonNamed("Back to Skill Folders").click(); });
    await settle();
    await resize(false);
    await act(async () => { buttonNamed("Import as New Version").click(); });
    await settle();
    // The import is running, so every folder and the Machine field are disabled.
    assert.ok(folderRows().every((row) => row.disabled));
    const summary = importDialog().querySelector<HTMLElement>(".skill-machine-import-pane.review summary")!;
    await act(async () => { summary.focus(); });
    assert.ok(summary === document.activeElement);
    await resize(true);
    assert.ok(focusInDialog(), "focus stays inside the dialog while the folders are disabled");
    assert.ok(importDialog() === document.activeElement, "the dialog itself takes focus");
    await act(async () => { importing.reject(new Error("Stopped.")); });
    await settle();
    await unmount();
  } finally { phoneWidth = false; }
});

test("choosing a machine that needs a runner update keeps focus on the Machine field (#2283)", async () => {
  const old: RunnerView = { ...runner, runnerId: "runner-old", displayName: "Old Machine", protocolVersion: 1 };
  const unmount = await mountDialog(twoFolders({}), async () => undefined, [runner, old]);
  await act(async () => { machineSelect().focus(); });
  await act(async () => { machineSelect().click(); });
  await settle();
  const option = [...importDialog().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((entry) => entry.textContent?.includes("Old Machine"))!;
  await act(async () => { option.focus(); });
  await act(async () => { option.click(); });
  await settle();
  assert.match(importDialog().textContent ?? "", /Old Machine Needs a Runner Update/u);
  assert.ok(focusInDialog(), "the swapped pane keeps focus inside the dialog");
  assert.ok(machineSelect() === document.activeElement, "focus is on the Machine field");
  await unmount();
});

test("a pane change never moves focus out of a dialog stacked over Import from Machine (#2283)", async () => {
  try {
    const unmount = await mountDialog(twoFolders({}), async () => undefined);
    await choose(folderRows()[1]!);
    await act(async () => { buttonNamed("More Actions").click(); });
    await act(async () => { buttonNamed("Adoption Recovery…").click(); });
    await settle();
    const recovery = dialogTitled("Adoption Recovery");
    const inRecovery = recovery.querySelector<HTMLButtonElement>("button:not(:disabled)")!;
    await act(async () => { inRecovery.focus(); });
    // Narrowing hides the folders behind it; focus stays where the person is.
    await resize(true);
    assert.ok(recovery.contains(document.activeElement), "focus stays in the stacked dialog");
    await unmount();
  } finally { phoneWidth = false; }
});
