import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type AgentDefinition, type BoxView, type RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { MachineSettingsDialog } from "./MachineSettingsDialog.js";
import type { MachineSettingsTarget } from "../machine-settings.js";

/**
 * Machine Settings as one form with one Save Changes (#2991): the fields each viewer sees, what Save
 * Changes sends, the baseline after a partial failure, and the confirmation for turning on
 * automatic switching.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
let matchingMedia = new Set<string>(["(pointer: fine)"]);
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return matchingMedia.has(query); },
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const body = domWindow.document.body as unknown as HTMLElement;
const settle = () => act(async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });

function codex(id: string, installationId: string, path: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, name: "Codex", command: path, args: [], env: {}, driver: "codex-app-server", context: { kind: "native" },
    available: true, authStatus: "authenticated", version: "0.155.1",
    installation: { id: installationId, path, via: "path" }, ...extra,
  };
}

function machine(overrides: Partial<RunnerView> = {}): RunnerView {
  return {
    runnerId: "studio",
    hostname: "studio.local",
    displayName: "Studio Mac",
    os: "macos",
    version: "1",
    status: "online",
    agents: [],
    workspaces: [],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: PROTOCOL_VERSION,
    canManage: true,
    capacity: { configuredUnits: 16, revision: 2, authority: "control_plane" },
    automaticAccountSwitching: { enabled: false, revision: 4 },
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "unauthenticated" },
      { id: "spare", label: "Spare", provider: "codex", authStatus: "unknown" },
    ],
    providerAccountDefaults: [{ provider: "claude", accountId: null, revision: 3 }],
    ...overrides,
  };
}

type Call = [string, ...unknown[]];

const unmounts = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const unmount of [...unmounts]) await unmount();
  matchingMedia = new Set(["(pointer: fine)"]);
});

async function mount(runner: RunnerView | undefined, {
  box,
  canManageMachines = true,
  at,
  client: overrides = {},
}: {
  box?: BoxView;
  canManageMachines?: boolean;
  at?: MachineSettingsTarget;
  client?: Partial<ApiClient>;
} = {}) {
  const calls: Call[] = [];
  let closed = 0;
  const record = <T,>(name: string, result: T) => async (...args: unknown[]) => { calls.push([name, ...args]); return result; };
  const client = {
    ...api,
    updateMachine: record("updateMachine", { ok: true }),
    updateMachineCapacity: async (runnerId: string, input: { configuredUnits: number; expectedRevision: number }) => {
      calls.push(["updateMachineCapacity", runnerId, input]);
      return { capacity: { configuredUnits: input.configuredUnits, revision: input.expectedRevision + 1 } };
    },
    updateMachineAutomaticAccountSwitching: async (runnerId: string, input: { enabled: boolean; expectedRevision: number }) => {
      calls.push(["updateMachineAutomaticAccountSwitching", runnerId, input]);
      return { automaticAccountSwitching: { enabled: input.enabled, revision: input.expectedRevision + 1 } };
    },
    updateMachineProviderAccountDefault: async (runnerId: string, provider: string, input: { accountId: string | null; expectedRevision: number }) => {
      calls.push(["updateMachineProviderAccountDefault", runnerId, provider, input]);
      return { providerAccountDefault: { provider, accountId: input.accountId, revision: input.expectedRevision + 1 } };
    },
    selectHarnessInstallation: async (runnerId: string, agentId: string, installationId: string) => {
      calls.push(["selectHarnessInstallation", runnerId, agentId, installationId]);
      return { selection: { installationId } };
    },
    ...overrides,
  } as unknown as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  body.append(mountPoint);
  const root = createRoot(mountPoint);
  const render = (next: RunnerView | undefined) => (
    <ApiProvider client={client}>
      <FeedbackProvider>
        <MachineSettingsDialog
          runner={next}
          {...(box ? { box } : {})}
          canManageMachines={canManageMachines}
          {...(at ? { at } : {})}
          onClose={() => { closed += 1; }}
          onDelete={async () => undefined}
        />
      </FeedbackProvider>
    </ApiProvider>
  );
  await act(async () => { root.render(render(runner)); });
  await settle();
  const unmount = async () => {
    if (!unmounts.delete(unmount)) return;
    await act(async () => root.unmount());
    mountPoint.remove();
  };
  unmounts.add(unmount);
  const dialog = () => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => element.querySelector(".modal-title")?.textContent === "Machine Settings") ?? null;
  return {
    calls,
    closed: () => closed,
    dialog,
    rerender: async (next: RunnerView) => { await act(async () => { root.render(render(next)); }); await settle(); },
    unmount,
  };
}

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;
const inputLabelled = (scope: Element, label: string) => {
  const target = [...scope.querySelectorAll("label")].find((element) => element.textContent === label);
  return target ? domWindow.document.getElementById(target.getAttribute("for")!) as unknown as HTMLInputElement : null;
};
const describedText = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
  .map((id) => domWindow.document.getElementById(id)?.textContent);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
}
async function blur(input: HTMLInputElement) {
  await act(async () => {
    input.focus();
    input.blur();
  });
}
async function press(button: HTMLButtonElement | null) {
  assert.ok(button, "the button is there");
  await act(async () => { button.click(); });
  await settle();
}
const save = (dialog: HTMLElement) => press(buttonNamed(dialog.closest(".modal-panel")!, "Save Changes"));

test("Machine Settings is one form: its name as the description, Delete Machine…, Cancel and Save Changes, and no other save", async () => {
  const view = await mount(machine({ status: "offline" }));
  const dialog = view.dialog()!;
  assert.ok(dialog, "the dialog opens");
  assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Studio Mac");
  assert.equal(dialog.querySelectorAll("form").length, 1, "one form");
  assert.equal(dialog.querySelector("form")?.hasAttribute("novalidate"), true);
  const footer = [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")].map((button) => button.textContent?.trim());
  assert.deepEqual(footer, ["Delete Machine…", "Cancel", "Save Changes"]);
  const saves = [...dialog.querySelectorAll<HTMLButtonElement>("button")].filter((button) => /\bSave\b|Selected|Use This Installation/u.test(button.textContent ?? ""));
  assert.deepEqual(saves.map((button) => button.textContent?.trim()), ["Save Changes"], "no other save button");
  assert.equal(dialog.querySelectorAll('button[type="submit"]').length, 1);
  for (const gone of ["Machine Details", "Danger Zone", "Runner Capacity", "Workspaces"]) {
    assert.doesNotMatch(dialog.textContent ?? "", new RegExp(gone, "u"), `no ${gone}`);
  }
  for (const gone of [".machine-settings-heading", ".machine-name-row", ".machine-harness-installation", ".automatic-account-switch-button", ".form-error"]) {
    assertNoDomNode(dialog.querySelector(gone), `no ${gone}`);
  }
  // An offline machine still saves every field now; the runner takes its settings on reconnect.
  assert.equal(dialog.querySelector(".notice")?.textContent,
    "Studio Mac is offline. Changes save now; Capacity Limit and automatic switching take effect when it reconnects.");
});

test("Save Changes sends exactly the changed fields with their revisions, then closes with a toast; an unchanged form sends nothing", async () => {
  const unchanged = await mount(machine());
  await save(unchanged.dialog()!);
  assert.deepEqual(unchanged.calls, [], "nothing changed, nothing sent");
  assert.equal(unchanged.closed(), 1);
  await unchanged.unmount();

  const view = await mount(machine());
  const dialog = view.dialog()!;
  await type(inputLabelled(dialog, "Machine Name")!, "Primary Mac");
  await type(inputLabelled(dialog, "Capacity Limit")!, "24");
  await save(dialog);
  assert.deepEqual(view.calls, [
    ["updateMachine", "studio", { displayName: "Primary Mac" }],
    ["updateMachineCapacity", "studio", { configuredUnits: 24, expectedRevision: 2 }],
  ]);
  assert.equal(view.closed(), 1, "the dialog closes");
  assert.ok([...body.querySelectorAll(".toast")].some((toast) => toast.textContent?.includes("Machine settings saved.")), "the toast");
});

test("a capacity failure after the name saved keeps the dialog open, names Capacity Limit, and the retry sends only it", async () => {
  let failCapacity = true;
  const view = await mount(machine(), {
    client: {
      updateMachineCapacity: (async (runnerId: string, input: { configuredUnits: number; expectedRevision: number }) => {
        view.calls.push(["updateMachineCapacity", runnerId, input]);
        if (failCapacity) throw new Error("Runner Capacity changed in another client");
        return { capacity: { configuredUnits: input.configuredUnits, revision: input.expectedRevision + 1 } };
      }) as ApiClient["updateMachineCapacity"],
    },
  });
  const dialog = view.dialog()!;
  await type(inputLabelled(dialog, "Machine Name")!, "Primary Mac");
  await type(inputLabelled(dialog, "Capacity Limit")!, "24");
  await save(dialog);
  assert.deepEqual(view.calls.map(([name]) => name), ["updateMachine", "updateMachineCapacity"]);
  assert.equal(view.closed(), 0, "the dialog stays open");
  const notice = dialog.querySelector<HTMLElement>('.notice.t-danger[role="alert"]')!;
  assert.ok(notice, "a danger notice");
  assert.match(notice.textContent ?? "", /^Capacity Limit wasn't saved\. Runner Capacity changed in another client/u);
  assertNoDomNode(notice.nextElementSibling, "the notice ends the form, above the footer");
  assert.doesNotMatch(notice.textContent ?? "", /Machine Name/u);
  assert.equal(inputLabelled(dialog, "Machine Name")!.value, "Primary Mac", "the name keeps its value");

  view.calls.length = 0;
  failCapacity = false;
  await save(dialog);
  assert.deepEqual(view.calls, [["updateMachineCapacity", "studio", { configuredUnits: 24, expectedRevision: 2 }]],
    "the name is the new baseline, so only Capacity Limit is still changed");
  assert.equal(view.closed(), 1);
});

test("Capacity Limit is a 96px field whose error sits under its helper, both describing it", async () => {
  const view = await mount(machine());
  const dialog = view.dialog()!;
  const input = inputLabelled(dialog, "Capacity Limit")!;
  assert.ok(input.classList.contains("w-xs"), "96px");
  assert.deepEqual(describedText(input), ["In units, from 1 to 256. Sessions beyond the limit wait in a queue."]);
  await type(input, "300");
  await blur(input);
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.deepEqual(describedText(input), [
    "In units, from 1 to 256. Sessions beyond the limit wait in a queue.",
    "Enter a whole number from 1 to 256.",
  ]);
  const helper = dialog.querySelector(".field-helper")!;
  assert.equal(helper.nextElementSibling?.classList.contains("field-error"), true, "the error is under the helper");
  await save(dialog);
  assert.deepEqual(view.calls, [], "an invalid field blocks the save");
  assert.ok((domWindow.document.activeElement as unknown) === input, "focus moves to it");
  await type(input, "32");
  assert.equal(input.hasAttribute("aria-invalid"), false, "a valid value clears the error");
});

test("on an older runner Capacity Limit and the switch are disabled with the capability sentence", async () => {
  const view = await mount(machine({ protocolVersion: 1 }));
  const dialog = view.dialog()!;
  const input = inputLabelled(dialog, "Capacity Limit")!;
  assert.equal(input.disabled, true);
  assert.match(describedText(input)[0] ?? "", /runner capacity changes/u);
  const toggle = dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(toggle.disabled, true);
  assert.match(describedText(toggle).join(" "), /automatic account switching changes/u);
});

test("turning switching on asks first with a primary Turn On Automatic Switching; cancelling saves nothing, and turning it off does not ask", async () => {
  const view = await mount(machine());
  const dialog = view.dialog()!;
  const toggle = dialog.querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.match(toggle.textContent ?? "", /^Switch Accounts Automatically/u);
  await press(toggle);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  await save(dialog);
  const confirmation = [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => element.querySelector(".modal-title")?.textContent === "Turn On Automatic Switching")!;
  assert.ok(confirmation, "the confirmation stacks on Machine Settings");
  const confirmButton = buttonNamed(confirmation, "Turn On Automatic Switching")!;
  assert.ok(confirmButton.classList.contains("primary") && !confirmButton.classList.contains("danger"), "a primary button");
  assertNoDomNode(confirmation.querySelector(".modal-tone-icon"), "no danger icon");
  assert.ok(confirmation.querySelector(".notice.t-warning")?.textContent?.includes("Provider terms"), "the terms are a warning notice");
  await press(buttonNamed(confirmation, "Cancel"));
  assert.deepEqual(view.calls, [], "cancelling saves nothing");
  assert.equal(view.closed(), 0);

  await save(dialog);
  const again = [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => element.querySelector(".modal-title")?.textContent === "Turn On Automatic Switching")!;
  await press(buttonNamed(again, "Turn On Automatic Switching"));
  assert.deepEqual(view.calls, [["updateMachineAutomaticAccountSwitching", "studio", { enabled: true, expectedRevision: 4 }]]);
  await view.unmount();

  const on = await mount(machine({ automaticAccountSwitching: { enabled: true, revision: 5 } }));
  await press(on.dialog()!.querySelector<HTMLButtonElement>('[role="switch"]'));
  await save(on.dialog()!);
  assert.deepEqual(on.calls, [["updateMachineAutomaticAccountSwitching", "studio", { enabled: false, expectedRevision: 5 }]],
    "turning it off needs no confirmation");
});

test("two installations of one harness are one radio group, and a missing saved choice is a disabled row", async () => {
  const view = await mount(machine({
    agents: [codex("codex", "system", "/usr/bin/codex"), codex("codex-local", "local", "/home/me/.local/bin/codex", { version: "0.210.0" })],
    harnessSelections: [{ family: "codex", context: { kind: "native" }, installationId: "system", path: "/usr/bin/codex", via: "path", agentId: "codex" }],
  }));
  const dialog = view.dialog()!;
  const groups = dialog.querySelectorAll('[role="radiogroup"]');
  assert.equal(groups.length, 1, "one group");
  const radios = [...groups[0]!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  assert.equal(radios.length, 2);
  assert.deepEqual(radios.map((radio) => radio.checked), [true, false]);
  const local = radios[1]!.closest(".choice-row")!;
  assert.match(local.textContent ?? "", /\/home\/me\/\.local\/bin\/codex/u);
  assert.match(local.textContent ?? "", /v0\.210\.0/u);
  assert.match(local.textContent ?? "", /Available\. Signed in\./u);
  await act(async () => { radios[1]!.click(); });
  await save(dialog);
  assert.deepEqual(view.calls, [["selectHarnessInstallation", "studio", "codex-local", "local"]]);
  await view.unmount();

  const missing = await mount(machine({
    agents: [codex("codex", "system", "/usr/bin/codex")],
    harnessSelections: [{ family: "codex", context: { kind: "native" }, installationId: "gone", path: "/opt/codex", via: "path", agentId: null }],
  }));
  const row = [...missing.dialog()!.querySelectorAll<HTMLElement>(".choice-row")].find((candidate) => candidate.textContent?.includes("/opt/codex"))!;
  assert.ok(row.classList.contains("is-disabled"), "the missing choice is disabled");
  assert.equal(row.querySelector("input")?.getAttribute("aria-disabled"), "true");
  assert.match(row.textContent ?? "", /Saved choice not found\. Choose another installation\./u);
});

test("Default Accounts read Signed In, Sign-In Required or Status Unknown, and No Default; never Logged In", async () => {
  const view = await mount(machine());
  const dialog = view.dialog()!;
  assert.equal(dialog.querySelector("fieldset legend")?.textContent, "Default Accounts");
  const claude = dialog.querySelector<HTMLButtonElement>('[aria-label^="Default Claude Account"]')!;
  assert.ok(claude, "a Select per provider");
  assert.ok(dialog.querySelector('[aria-label^="Default Codex Account"]'));
  assert.match(describedText(claude).join(" "), /Used by new sessions on this machine that don't choose an account\./u);
  await press(claude);
  const options = [...body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((option) => option.textContent);
  assert.deepEqual(options, [
    "No DefaultUses the agent's configured account, or the first one available.",
    "WorkSigned In",
    "PersonalSign-In Required",
  ]);
  assert.doesNotMatch(body.textContent ?? "", /Logged In|Login Required|Login Unknown/u);
});

test("Default Accounts leave out a profile only other control planes may use, unless it is the saved one (#3240)", async () => {
  const theirs = { id: "theirs", label: "Theirs", provider: "claude" as const, authStatus: "authenticated" as const,
    profile: { id: "p-theirs", access: "not_granted" as const } };
  const accounts = [
    { id: "work", label: "Work", provider: "claude" as const, authStatus: "authenticated" as const },
    theirs,
  ];
  const offered = async (overrides: Parameters<typeof machine>[0]) => {
    const view = await mount(machine(overrides));
    await press(view.dialog()!.querySelector<HTMLButtonElement>('[aria-label^="Default Claude Account"]')!);
    const options = [...body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((option) => option.textContent);
    await view.unmount();
    return options;
  };
  assert.deepEqual(await offered({ providerAccounts: accounts }), [
    "No DefaultUses the agent's configured account, or the first one available.",
    "WorkSigned In",
  ]);
  assert.deepEqual(await offered({ providerAccounts: accounts,
    providerAccountDefaults: [{ provider: "claude", accountId: "theirs", revision: 2 }] }), [
    "No DefaultUses the agent's configured account, or the first one available.",
    "WorkSigned In",
    "TheirsIts provider profile isn't granted to this control plane.",
  ]);
});

test("a saved default account the machine no longer lists keeps its not-found option", async () => {
  const view = await mount(machine({ providerAccountDefaults: [{ provider: "claude", accountId: "removed", revision: 3 }] }));
  const claude = view.dialog()!.querySelector<HTMLButtonElement>('[aria-label^="Default Claude Account"]')!;
  assert.match(claude.getAttribute("aria-label") ?? "", /Saved Account Not Found/u);
  await press(claude);
  await press([...body.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')]
    .find((option) => option.textContent?.startsWith("Work"))!);
  await save(view.dialog()!);
  assert.deepEqual(view.calls, [["updateMachineProviderAccountDefault", "studio", "claude", { accountId: "work", expectedRevision: 3 }]]);
});

test("an online native runner's Delete Machine… is disabled with its reason as visible text", async () => {
  const view = await mount(machine());
  const dialog = view.dialog()!;
  const remove = buttonNamed(dialog, "Delete Machine…")!;
  assert.equal(remove.disabled, true);
  const note = dialog.querySelector(".machine-settings-delete-note")!;
  assert.equal(note.textContent, "Stop the runner to delete.");
  assert.equal(remove.getAttribute("aria-describedby"), note.id);
  await view.unmount();

  const offline = await mount(machine({ status: "offline" }));
  assert.equal(buttonNamed(offline.dialog()!, "Delete Machine…")!.disabled, false);
  assertNoDomNode(offline.dialog()!.querySelector(".machine-settings-delete-note"), "no reason once it can be deleted");
});

test("a machine's own manager sees only Capacity Limit, the switch and Default Accounts", async () => {
  const view = await mount(machine({
    agents: [codex("codex", "system", "/usr/bin/codex"), codex("codex-local", "local", "/home/me/.local/bin/codex")],
  }), { canManageMachines: false });
  const dialog = view.dialog()!;
  const labels = [...dialog.querySelectorAll("label, legend, .setting-row-title")].map((element) => element.textContent);
  assert.deepEqual(labels.filter((label) => !/^(No Default|Work|Personal|Spare)$/u.test(label ?? "")),
    ["Capacity Limit", "Switch Accounts Automatically", "Default Accounts"]);
  assertNoDomNode(inputLabelled(dialog, "Machine Name"), "no Machine Name");
  assertNoDomNode(dialog.querySelector('[role="radiogroup"]'), "no Agent Installations");
  assertNoDomNode(buttonNamed(dialog, "Delete Machine…"), "no Delete Machine…");
});

test("Change Limit… opens with focus in Capacity Limit, Choose Another Installation… at Agent Installations", async () => {
  const capacity = await mount(machine(), { at: "capacity" });
  assert.ok((domWindow.document.activeElement as unknown) === inputLabelled(capacity.dialog()!, "Capacity Limit"), "focus");
  await capacity.unmount();

  const installations = await mount(machine({
    agents: [codex("codex", "system", "/usr/bin/codex"), codex("codex-local", "local", "/home/me/.local/bin/codex")],
  }), { at: "installations" });
  const fieldset = installations.dialog()!.querySelector("fieldset.machine-settings-installations")!;
  assert.ok((domWindow.document.activeElement as unknown) === fieldset, "focus");
  assert.equal(fieldset.querySelector("legend")?.textContent, "Agent Installations");
  await installations.unmount();

  // Without the section (a manager, or nothing to choose), the dialog opens as usual.
  const fallback = await mount(machine(), { at: "installations" });
  assert.ok((domWindow.document.activeElement as unknown) === inputLabelled(fallback.dialog()!, "Machine Name"), "focus");
});

test("a machine that reports new facts while the dialog is open keeps the person's draft", async () => {
  const view = await mount(machine());
  const dialog = view.dialog()!;
  await type(inputLabelled(dialog, "Capacity Limit")!, "24");
  await view.rerender(machine({ capacity: { configuredUnits: 16, revision: 2, authority: "control_plane", usedUnits: 3 } }));
  assert.equal(inputLabelled(dialog, "Capacity Limit")!.value, "24");
  await save(dialog);
  assert.deepEqual(view.calls, [["updateMachineCapacity", "studio", { configuredUnits: 24, expectedRevision: 2 }]]);
});

test("a provider that appears after opening keeps the revision it was edited at, so another client's change conflicts (CR-1.1)", async () => {
  const claudeOnly = machine({ providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }] });
  const view = await mount(claudeOnly);
  const dialog = view.dialog()!;
  assertNoDomNode(dialog.querySelector('[aria-label^="Default Codex Account"]'), "no Codex accounts yet");
  const withCodex = machine({ providerAccounts: [
    { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
    { id: "solo", label: "Codex Solo", provider: "codex", authStatus: "authenticated" },
    { id: "team", label: "Codex Team", provider: "codex", authStatus: "authenticated" },
  ] });
  await view.rerender(withCodex);
  await press(dialog.querySelector<HTMLButtonElement>('[aria-label^="Default Codex Account"]'));
  await press([...body.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')]
    .find((option) => option.textContent?.startsWith("Codex Solo"))!);
  // Another client saves Codex Team as the default while this one is still editing.
  await view.rerender({ ...withCodex, providerAccountDefaults: [
    { provider: "claude", accountId: null, revision: 3 },
    { provider: "codex", accountId: "team", revision: 1 },
  ] });
  await save(dialog);
  assert.deepEqual(view.calls, [["updateMachineProviderAccountDefault", "studio", "codex", { accountId: "solo", expectedRevision: 0 }]],
    "the write carries the revision the person edited, so the server refuses it as a conflict");
});

test("a capacity typed as 024 saves as 24 and is not resent after a later field fails (CR-1.2)", async () => {
  let failDefault = true;
  const view = await mount(machine(), {
    client: {
      updateMachineProviderAccountDefault: (async (runnerId: string, provider: string, input: { accountId: string | null; expectedRevision: number }) => {
        view.calls.push(["updateMachineProviderAccountDefault", runnerId, provider, input]);
        if (failDefault) throw new Error("Default Provider Account changed in another client");
        return { providerAccountDefault: { provider, accountId: input.accountId, revision: input.expectedRevision + 1 } };
      }) as ApiClient["updateMachineProviderAccountDefault"],
    },
  });
  const dialog = view.dialog()!;
  await type(inputLabelled(dialog, "Capacity Limit")!, "024");
  await press(dialog.querySelector<HTMLButtonElement>('[aria-label^="Default Claude Account"]'));
  await press([...body.querySelectorAll<HTMLButtonElement>('[role="listbox"] [role="option"]')]
    .find((option) => option.textContent?.startsWith("Work"))!);
  await save(dialog);
  assert.deepEqual(view.calls.map(([name]) => name), ["updateMachineCapacity", "updateMachineProviderAccountDefault"]);
  assert.deepEqual(view.calls[0], ["updateMachineCapacity", "studio", { configuredUnits: 24, expectedRevision: 2 }]);
  view.calls.length = 0;
  failDefault = false;
  await save(dialog);
  assert.deepEqual(view.calls, [["updateMachineProviderAccountDefault", "studio", "claude", { accountId: "work", expectedRevision: 3 }]],
    "only the default account is still changed");
});

test("an SSH machine whose runner has not arrived shows only Machine Name", async () => {
  const box: BoxView = { boxId: "box", runnerId: "golf", displayName: "Golf Simulator", sshTarget: "me@golf", status: "bootstrapping", lastError: null, createdAt: 1 };
  const view = await mount(undefined, { box });
  const dialog = view.dialog()!;
  assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Golf Simulator");
  assert.deepEqual([...dialog.querySelectorAll("label")].map((label) => label.textContent), ["Machine Name"]);
  assert.equal(buttonNamed(dialog, "Delete Machine…")!.disabled, false, "an SSH machine is deleted through its box");
});
