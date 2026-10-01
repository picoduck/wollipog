import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ResourceScope, type RunnerView } from "@wollipog/protocol";
import type { ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { SkillGroupAssignmentView, SkillGroupView, SkillSummary } from "../skills.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { SkillGroupsDialog } from "./SkillGroupsDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
/** The phone breakpoint (§7.5), switchable mid-test: Modal and useIsMobile follow `change`. */
let phone = false;
const mediaListeners = new Set<() => void>();
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    get matches() { return phone && query.includes("max-width: 760px") && !query.includes("coarse"); },
    media: query,
    addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
  }),
});
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  FocusEvent: domWindow.FocusEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};
const setPhone = async (value: boolean) => {
  phone = value;
  await act(async () => { for (const listener of [...mediaListeners]) listener(); });
  await settle();
};

const orgScope: ResourceScope = { organizationId: "org_personal", owner: { kind: "organization", organizationId: "org_personal" } };
const teamScope: ResourceScope = { organizationId: "org_personal", owner: { kind: "team", teamId: "team_7f3a" } };
const userScope: ResourceScope = { organizationId: "org_personal", owner: { kind: "user", userId: "user_42" } };
const runner: RunnerView = {
  runnerId: "runner-1", hostname: "build", os: "linux", version: "1", status: "online", displayName: "Build Machine",
  agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: PROTOCOL_VERSION,
};

interface Deferred { resolve: () => void; reject: (error: Error) => void }

/** A library with three owned groups and a legacy one. Writes wait for `release` when `hold` is set. */
function fakeApi(options: { groups?: SkillGroupView[]; skills?: SkillSummary[]; creationScope?: ResourceScope | null } = {}) {
  let groups: SkillGroupView[] = options.groups ?? [
    { id: "review", name: "Review Team", scope: orgScope },
    { id: "platform", name: "Platform Tools", scope: teamScope },
    { id: "mine", name: "My Drafts", scope: userScope },
    { id: "legacy", name: "Legacy Tools" },
  ];
  let skills: SkillSummary[] = options.skills ?? [
    { id: "s-review", name: "code-review", groupId: "review" },
    { id: "s-lint", name: "lint-fix", groupId: "review" },
    { id: "s-docs", name: "docs-writer", groupId: "review" },
    { id: "s-free", name: "release-notes" },
    { id: "s-old", name: "old-helper", groupId: "legacy" },
  ] as SkillSummary[];
  let rules: SkillGroupAssignmentView[] = [
    { id: "rule-1", groupId: "review", scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "agent", agentId: "claude" }, enabled: true, invocation: "agent" },
    { id: "rule-2", groupId: "review", scopeKind: "instance", agentSelector: { kind: "all" }, enabled: false, invocation: "manual" },
  ] as SkillGroupAssignmentView[];
  const writes: Array<[string, ...unknown[]]> = [];
  const held: Deferred[] = [];
  const state = { hold: false, fail: null as string | null, rulesFail: null as string | null, holdRules: false };
  const heldReads: Array<() => void> = [];
  const write = async <T,>(entry: [string, ...unknown[]], apply: () => T): Promise<T> => {
    writes.push(entry);
    if (state.hold) await new Promise<void>((resolve, reject) => held.push({ resolve, reject }));
    if (state.fail) throw new Error(state.fail);
    return apply();
  };
  const client = {
    listSkillGroups: async () => ({ groups: groups.map((group) => ({ ...group })), creationScope: options.creationScope === undefined ? orgScope : options.creationScope }),
    listSkills: async () => ({ skills: skills.map((skill) => ({ ...skill })) }),
    getIdentity: async () => ({
      context: { userId: "user_42", userName: "Ada", organizationId: "org_personal", organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true },
      organizations: [], memberships: [], teams: [{ teamId: "team_7f3a", name: "Platform", organizationId: "org_personal", members: [] }],
    }),
    listSkillGroupAssignments: async (id: string) => {
      if (state.rulesFail) throw new Error(state.rulesFail);
      if (state.holdRules) await new Promise<void>((resolve) => heldReads.push(resolve));
      return { assignments: rules.filter((rule) => rule.groupId === id) };
    },
    createSkillGroup: (body: { name: string }) => write(["create", body], () => {
      const group = { id: `g-${groups.length}`, name: body.name, scope: orgScope };
      groups = [...groups, group];
      return { group };
    }),
    updateSkill: (id: string, body: { groupId: string | null }) => write(["update", id, body], () => {
      skills = skills.map((skill) => skill.id === id ? { ...skill, groupId: body.groupId ?? undefined } : skill);
      return { skill: skills.find((skill) => skill.id === id) };
    }),
    convertSkillGroup: (id: string) => write(["convert", id], () => {
      groups = groups.map((group) => group.id === id ? { ...group, scope: orgScope } : group);
      return { group: groups.find((group) => group.id === id) };
    }),
    deleteSkillGroup: (id: string) => write(["delete", id], () => {
      groups = groups.filter((group) => group.id !== id);
      skills = skills.map((skill) => skill.groupId === id ? { ...skill, groupId: undefined } : skill);
    }),
    createSkillGroupAssignment: (id: string, body: object) => write(["create-rule", id, body], () => {
      const assignment = { id: `rule-${rules.length + 1}`, groupId: id, enabled: true, ...body } as SkillGroupAssignmentView;
      rules = [...rules, assignment];
      return { assignment };
    }),
    updateSkillGroupAssignment: (id: string, ruleId: string, body: object) => write(["update-rule", id, ruleId, body], () => {
      rules = rules.map((rule) => rule.id === ruleId ? { ...rule, ...body } : rule);
      return { assignment: rules.find((rule) => rule.id === ruleId) };
    }),
    deleteSkillGroupAssignment: (id: string, ruleId: string) => write(["delete-rule", id, ruleId], () => {
      rules = rules.filter((rule) => rule.id !== ruleId);
    }),
  };
  const release = async () => { await act(async () => { held.splice(0).forEach((entry) => entry.resolve()); }); await settle(); };
  return { client: client as unknown as ApiClient, writes, state, release };
}

async function mount(api = fakeApi(), initialGroupId?: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let changed = 0;
  let closed = 0;
  await act(async () => root.render(
    <ApiProvider client={api.client}>
      <FeedbackProvider>
        <SkillGroupsDialog runners={[runner]} machineLabels={new Map([["runner-1", "Build Machine"]])} initialGroupId={initialGroupId}
          onClose={() => { closed += 1; }} onChanged={async () => { changed += 1; }} />
      </FeedbackProvider>
    </ApiProvider>,
  ));
  await settle();
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const dialog = () => dialogs().find((candidate) => candidate.classList.contains("skill-groups"))!;
  const confirmation = () => dialogs().find((candidate) => candidate.classList.contains("feedback-confirmation")) ?? null;
  return {
    api, dialog, dialogs, confirmation,
    changed: () => changed, closed: () => closed,
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

function buttons(scope: ParentNode | null | undefined, name: string): HTMLButtonElement[] {
  return [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .filter((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
}
function button(scope: ParentNode | null | undefined, name: string): HTMLButtonElement {
  const [found] = buttons(scope, name);
  assert.ok(found, `a button named ${name}`);
  return found;
}
const click = async (target: HTMLElement) => {
  await act(async () => { target.focus(); target.click(); });
  await settle();
};
const active = () => domWindow.document.activeElement as unknown as HTMLElement | null;
const listRows = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLButtonElement>(".skill-groups-list > .row")];
const memberNames = (dialog: HTMLElement) => [...dialog.querySelectorAll(".skill-groups-members .row-title")].map((node) => node.textContent);

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: "x" }) as unknown as Event);
  });
}

/** Opens a ⋯ or Add Skill menu and chooses an item. */
async function chooseFromMenu(trigger: HTMLButtonElement, item: string) {
  await click(trigger);
  const menu = document.getElementById(trigger.getAttribute("aria-controls")!);
  assert.ok(menu, "the menu opened");
  const choice = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((candidate) => (candidate.querySelector(".menu-text") ?? candidate).textContent === item);
  assert.ok(choice, `a menu item ${item}`);
  await click(choice);
}

test("the dialog opens on the group list with the first group selected, ownership in words, and no consent checkbox", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    assert.equal(dialog.querySelector(".modal-title")?.textContent, "Manage Groups");
    assert.deepEqual(listRows(dialog).map((row) => [row.querySelector(".row-title")?.textContent, row.querySelector(".row-trail")?.textContent]), [
      ["Review Team", "3 skills"], ["Platform Tools", "No skills"], ["My Drafts", "No skills"], ["Legacy Tools", "No owner"],
    ]);
    assert.equal(listRows(dialog)[0]!.getAttribute("aria-current"), "true", "the first group is selected");
    assert.ok(dialog.querySelector(".skill-groups-list-head")?.textContent?.includes("New Group"), "New Group sits beside the list label");
    assertNoDomNode(dialog.querySelector("select, [role='combobox'], input[type='checkbox'], [role='checkbox']"), "no Choose a Group select and no checkbox");
    assert.doesNotMatch(dialog.textContent ?? "", /Accept Group-Wide|Choose a Group|Loading…/i);
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Review Team");
    assert.equal(dialog.querySelector(".skill-groups-owner")?.textContent, "Shared with your organization");
    assert.deepEqual([...dialog.querySelectorAll(".skill-groups-section-head h4")].map((node) => node.textContent), ["Members", "Group Assignments"]);
    assert.deepEqual(memberNames(dialog), ["code-review", "lint-fix", "docs-writer"]);
    assert.deepEqual(buttons(dialog, "Remove…").length, 3);
    assert.deepEqual([...dialog.querySelectorAll(".skill-assignment-title")].map((node) => node.textContent),
      ["Claude on Build Machine", "All Agents on All Machines"]);
    assert.ok(button(dialog, "Add Skill"));
    assert.ok(button(dialog, "Add Assignment…"));
    assert.deepEqual([...dialog.querySelectorAll(".modal-foot button")].map((node) => [node.textContent, node.className]), [["Done", "btn"]]);

    await click(listRows(dialog)[1]!);
    assert.equal(dialog.querySelector(".skill-groups-owner")?.textContent, "Shared with Platform");
    await click(listRows(dialog)[2]!);
    assert.equal(dialog.querySelector(".skill-groups-owner")?.textContent, "Only you");
    await click(listRows(dialog)[3]!);
    const notice = dialog.querySelector(".notice")!;
    assert.match(notice.textContent ?? "", /^This Group Has No Owner/);
    assert.match(notice.textContent ?? "", /Converting makes it shared with your organization\./);
    assert.ok(button(notice, "Convert Group…"));
    assertNoDomNode(dialog.querySelector(".skill-groups-rules"), "a legacy group has no assignments");
    assert.doesNotMatch(dialog.textContent ?? "", /org_personal|team_7f3a|user_42/, "no id is shown");

    await click(button(dialog, "Done"));
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});

test("removing a member confirms naming the skill, the group and its assignments; Cancel changes nothing", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    const remove = buttons(dialog, "Remove…")[1]!;
    assert.equal(document.getElementById(remove.getAttribute("aria-describedby")!)?.textContent, "lint-fix");
    await click(remove);
    let confirmation = view.confirmation()!;
    assert.equal(confirmation.querySelector("h2")?.textContent, "Remove Skill from Group");
    assert.match(confirmation.querySelector(".confirmation-message")?.textContent ?? "", /^“lint-fix” leaves “Review Team” and is removed from the machines/);
    assert.deepEqual([...confirmation.querySelectorAll(".confirmation-rows .row-title")].map((node) => node.textContent),
      ["Claude on Build Machine", "All Agents on All Machines"]);
    await click(button(confirmation, "Cancel"));
    assert.deepEqual(view.api.writes, []);
    assert.ok(active() === remove, "focus returns to Remove…");

    view.api.state.hold = true;
    await click(remove);
    confirmation = view.confirmation()!;
    await click(button(confirmation, "Remove Skill"));
    assert.deepEqual(view.api.writes, [["update", "s-lint", { groupId: null }]]);
    // Only the control that changed is busy, and no status line is added.
    assert.equal(remove.getAttribute("aria-busy"), "true");
    assert.equal(dialog.querySelectorAll("[aria-busy='true']").length, 1);
    assert.doesNotMatch(dialog.querySelector(".modal-body")?.textContent ?? "", /Loading|Saving|saved/);
    await view.api.release();
    assert.deepEqual(memberNames(dialog), ["code-review", "docs-writer"]);
    assert.equal(view.changed(), 1);
    // The removed row's Remove… is gone; focus moves to the row that took its place.
    assert.ok(active() === buttons(dialog, "Remove…")[1], `focus is on the next Remove…, not ${active()?.outerHTML}`);
  } finally {
    await view.unmount();
  }
});

test("a removal never claims a group has no assignments when its rules could not be read", async () => {
  phone = false;
  const api = fakeApi();
  api.state.rulesFail = "HTTP 503";
  const view = await mount(api);
  try {
    const dialog = view.dialog();
    assert.match(dialog.textContent ?? "", /Couldn't Load the Group's Assignments/);
    await click(buttons(dialog, "Remove…")[0]!);
    const message = view.confirmation()!.querySelector(".confirmation-message")?.textContent ?? "";
    assert.doesNotMatch(message, /no assignments|nothing is removed/);
    assert.match(message, /^“code-review” leaves “Review Team” and is removed from the machines the group's assignments deployed it to/);
    await click(button(view.confirmation(), "Cancel"));

    // A group whose rules read as empty does say so.
    api.state.rulesFail = null;
    await click(listRows(dialog)[1]!);
    await click(listRows(dialog)[0]!);
    await click(buttons(dialog, "Remove…")[0]!);
    assert.match(view.confirmation()!.querySelector(".confirmation-message")?.textContent ?? "", /these assignments deployed it to/);
    await click(button(view.confirmation(), "Cancel"));
  } finally {
    await view.unmount();
  }
});

test("Escape that dismisses an input method's candidates keeps the new group's name; a plain Escape cancels", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    await click(button(dialog, "New Group"));
    const field = dialog.querySelector<HTMLInputElement>("#skill-groups-new-name")!;
    await typeInto(field, "Review");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const escape = new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Escape", ...("isComposing" in init ? init : {}) });
      if ("keyCode" in init) Object.defineProperty(escape, "keyCode", { value: init.keyCode });
      await act(async () => { field.dispatchEvent(escape as unknown as Event); });
      await settle();
      assert.ok(field.isConnected, `the form stays (${JSON.stringify(init)})`);
      assert.equal(field.value, "Review");
    }
    await act(async () => { field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event); });
    await settle();
    assertNoDomNode(dialog.querySelector("#skill-groups-new-name"), "a plain Escape leaves the name field");
    assert.equal(view.dialogs().length, 1, "and not the dialog");
    assert.ok(active() === button(dialog, "New Group"), "focus returns to New Group");
  } finally {
    await view.unmount();
  }
});

test("adding a skill lists the rules it starts deploying under, and a server refusal is a danger notice above the footer", async () => {
  phone = false;
  const api = fakeApi();
  const view = await mount(api);
  try {
    const dialog = view.dialog();
    await chooseFromMenu(button(dialog, "Add Skill"), "release-notes");
    const confirmation = view.confirmation()!;
    assert.equal(confirmation.querySelector("h2")?.textContent, "Add Skill to Group");
    assert.match(confirmation.querySelector(".confirmation-message")?.textContent ?? "",
      /^“release-notes” joins “Review Team” and starts deploying under the group's assignments, listed below\.$/);
    assert.deepEqual([...confirmation.querySelectorAll(".confirmation-rows .row")].map((row) => row.textContent),
      ["Claude on Build MachineAgent Invocable", "All Agents on All MachinesTurned Off"]);
    api.state.fail = "Owned groups require identical skill ownership. No changes saved.";
    await click(button(confirmation, "Add Skill"));
    assert.deepEqual(api.writes, [["update", "s-free", { groupId: "review" }]]);
    const error = dialog.querySelector(".skill-groups-error")!;
    assert.equal(error.getAttribute("role"), "alert");
    assert.match(error.textContent ?? "", /identical skill ownership/);
    assert.ok(error.closest(".modal-body"), "inside the body, above the footer");
    assert.deepEqual(memberNames(dialog), ["code-review", "lint-fix", "docs-writer"]);

    api.state.fail = null;
    await chooseFromMenu(button(dialog, "Add Skill"), "release-notes");
    await click(button(view.confirmation(), "Add Skill"));
    assertNoDomNode(dialog.querySelector(".skill-groups-error"), "a later success clears the error");
    assert.deepEqual(memberNames(dialog), ["code-review", "lint-fix", "docs-writer", "release-notes"]);
    assert.equal(button(dialog, "Add Skill").disabled, true, "no ungrouped skill is left");
    assert.ok(active() === buttons(dialog, "Remove…").at(-1), "focus leaves the disabled Add Skill for the new member's Remove…");
    assert.match(dialog.textContent ?? "", /Every skill is already in a group/);
  } finally {
    await view.unmount();
  }
});

test("removing a rule confirms naming the group's skills; toggling it applies at once with Saved", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    const enabled = dialog.querySelector<HTMLButtonElement>('.skill-assignment [role="switch"]')!;
    await click(enabled);
    assert.deepEqual(view.api.writes, [["update-rule", "review", "rule-1", { enabled: false }]]);
    assert.equal(dialog.querySelector(".skill-assignment .ui-row-saved")?.textContent, "Saved");
    assert.equal(dialog.querySelector(".skill-assignment .skill-assignment-desc")?.textContent, "Group assignment, turned off");

    // An invocation change spins on the invocation control, not on Enabled.
    view.api.state.hold = true;
    const invocation = dialog.querySelector<HTMLButtonElement>('.skill-assignment [data-rule-control="invocation"]')!;
    await click(invocation);
    const manual = [...document.getElementById(invocation.getAttribute("aria-controls")!)!.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((item) => item.textContent?.startsWith("Manual Only"))!;
    await click(manual);
    assert.deepEqual(view.api.writes.at(-1), ["update-rule", "review", "rule-1", { invocation: "manual" }]);
    assert.equal(invocation.getAttribute("aria-busy"), "true");
    assert.equal(dialog.querySelectorAll("[aria-busy='true']").length, 1, "only the invocation control spins");
    await view.api.release();
    view.api.state.hold = false;
    assert.equal(invocation.textContent, "Manual Only");

    const more = dialog.querySelectorAll<HTMLButtonElement>('[data-rule-control="more"]')[0]!;
    await chooseFromMenu(more, "Remove Assignment…");
    const confirmation = view.confirmation()!;
    assert.equal(confirmation.querySelector("h2")?.textContent, "Remove Group Assignment");
    assert.match(confirmation.querySelector(".confirmation-message")?.textContent ?? "",
      /^The next sync removes the skills in “Review Team” from Claude on Build Machine, unless another assignment keeps them there\.$/);
    assert.deepEqual([...confirmation.querySelectorAll(".confirmation-rows .row-title")].map((node) => node.textContent),
      ["code-review", "lint-fix", "docs-writer"]);
    view.api.state.hold = true;
    await click(button(confirmation, "Remove Assignment"));
    assert.equal(more.getAttribute("aria-busy"), "true", "the rule's ⋯ shows the running removal");
    await view.api.release();
    assert.deepEqual([...dialog.querySelectorAll(".skill-assignment-title")].map((node) => node.textContent), ["All Agents on All Machines"]);
    assert.ok(active() === dialog.querySelector('[data-rule-control="more"]'), "focus moves to the next rule's ⋯");
  } finally {
    await view.unmount();
  }
});

test("a saved rule shows its new value before its controls unlock, even while the rules reload is slow", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    // The group's rules re-read after every change; hold that read so it never lands in this test.
    view.api.state.holdRules = true;
    const enabled = () => dialog.querySelector<HTMLButtonElement>('.skill-assignment [role="switch"]')!;
    await click(enabled());
    assert.deepEqual(view.api.writes, [["update-rule", "review", "rule-1", { enabled: false }]]);
    assert.equal(enabled().disabled, false, "the change finished");
    assert.equal(enabled().getAttribute("aria-checked"), "false", "the row shows what was saved");
    await click(enabled());
    assert.deepEqual(view.api.writes.at(-1), ["update-rule", "review", "rule-1", { enabled: true }], "a second click turns it back on");
    const invocation = dialog.querySelector<HTMLButtonElement>('.skill-assignment [data-rule-control="invocation"]')!;
    await chooseFromMenu(invocation, "Manual Only");
    assert.equal(dialog.querySelector('.skill-assignment [data-rule-control="invocation"]')?.getAttribute("aria-label"), "Invocation: Manual Only");
  } finally {
    await view.unmount();
  }
});

test("adding an assignment clears the notice an earlier refused change left", async () => {
  phone = false;
  const api = fakeApi();
  const view = await mount(api);
  try {
    const dialog = view.dialog();
    api.state.fail = "Removal refused. No changes saved.";
    await click(buttons(dialog, "Remove…")[0]!);
    await click(button(view.confirmation(), "Remove Skill"));
    assert.match(dialog.querySelector(".skill-groups-error")?.textContent ?? "", /Removal refused/);
    api.state.fail = null;
    await click(button(dialog, "Add Assignment…"));
    await click(button(view.dialogs().at(-1), "Add Assignment"));
    assert.equal(view.dialogs().length, 1);
    assertNoDomNode(dialog.querySelector(".skill-groups-error"), "the success clears the old refusal");
  } finally {
    await view.unmount();
  }
});

test("Delete Group… asks for the group's name, and the next group takes its place", async () => {
  phone = false;
  const view = await mount();
  try {
    const dialog = view.dialog();
    await chooseFromMenu(button(dialog, "More Actions for Review Team"), "Delete Group…");
    const confirmation = view.confirmation()!;
    assert.equal(confirmation.querySelector("h2")?.textContent, "Delete Group");
    assert.match(confirmation.querySelector(".confirmation-message")?.textContent ?? "",
      /^“Review Team” and its 2 assignments are deleted, and its 3 skills stop deploying through it\./);
    assert.deepEqual([...confirmation.querySelectorAll(".confirmation-rows .row-title")].map((node) => node.textContent),
      ["code-review", "lint-fix", "docs-writer"]);
    const field = confirmation.querySelector<HTMLInputElement>(".modal-body .field input")!;
    assert.ok(active() === field, "the name field has focus");
    const confirmButton = button(confirmation, "Delete Group");
    assert.equal(confirmButton.disabled, true);
    await typeInto(field, "Review");
    assert.equal(confirmButton.disabled, true);
    await typeInto(field, "Review Team");
    assert.equal(confirmButton.disabled, false);
    await click(confirmButton);
    assert.deepEqual(view.api.writes, [["delete", "review"]]);
    assert.deepEqual(listRows(dialog).map((row) => row.querySelector(".row-title")?.textContent), ["Platform Tools", "My Drafts", "Legacy Tools"]);
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Platform Tools");
    assert.ok(active() === listRows(dialog)[0], "focus lands on the group that took its place");
  } finally {
    await view.unmount();
  }
});

test("converting a legacy group confirms, and a refusal keeps it legacy with the server's reason", async () => {
  phone = false;
  const api = fakeApi();
  const view = await mount(api, "legacy");
  try {
    const dialog = view.dialog();
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Legacy Tools");
    await click(button(dialog, "Convert Group…"));
    let confirmation = view.confirmation()!;
    assert.equal(confirmation.querySelector("h2")?.textContent, "Convert Group");
    assert.match(confirmation.querySelector(".confirmation-message")?.textContent ?? "", /^“Legacy Tools” becomes shared with your organization for good/);
    assert.deepEqual([...confirmation.querySelectorAll(".confirmation-rows .row-title")].map((node) => node.textContent), ["old-helper"]);
    await click(button(confirmation, "Cancel"));
    assert.deepEqual(api.writes, []);

    api.state.fail = "Members have different ownership. No changes saved.";
    await click(button(dialog, "Convert Group…"));
    await click(button(view.confirmation(), "Convert Group"));
    assert.match(dialog.querySelector(".skill-groups-error")?.textContent ?? "", /No changes saved/);
    assert.ok(button(dialog, "Convert Group…"));

    api.state.fail = null;
    await click(button(dialog, "Convert Group…"));
    confirmation = view.confirmation()!;
    await click(button(confirmation, "Convert Group"));
    assertNoDomNode(dialog.querySelector(".notice.t-warning, .skill-groups-error"));
    assert.equal(dialog.querySelector(".skill-groups-owner")?.textContent, "Shared with your organization");
    assert.ok(button(dialog, "Add Assignment…"));
  } finally {
    await view.unmount();
  }
});

test("Add Assignment… stacks Add Group Assignment over Manage Groups and returns to the same group", async () => {
  phone = false;
  const view = await mount(fakeApi(), "platform");
  try {
    const dialog = view.dialog();
    const add = button(dialog, "Add Assignment…");
    await click(add);
    assert.equal(view.dialogs().length, 2, "Manage Groups stays open under it");
    const child = view.dialogs().at(-1)!;
    assert.equal(child.querySelector("h2")?.textContent, "Add Group Assignment");
    assert.match(child.textContent ?? "", /Every skill in Platform Tools, now and later/);
    assert.equal(document.querySelectorAll(".modal-backdrop.stacked").length, 1, "one shared dim");
    await click(button(child, "Cancel"));
    assert.equal(view.dialogs().length, 1);
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Platform Tools");
    assert.ok(active() === add, "focus returns to Add Assignment…");

    await click(add);
    await click(button(view.dialogs().at(-1), "Add Assignment"));
    assert.deepEqual(view.api.writes, [["create-rule", "platform", { scopeKind: "instance", agentSelector: { kind: "all" }, invocation: "agent" }]]);
    assert.equal(view.dialogs().length, 1);
    assert.deepEqual([...dialog.querySelectorAll(".skill-assignment-title")].map((node) => node.textContent), ["All Agents on All Machines"]);
    assert.ok(active() === button(dialog, "Add Assignment…"));
  } finally {
    await view.unmount();
  }
});

test("with no groups the dialog is one empty state whose New Group creates and opens a group", async () => {
  phone = false;
  const api = fakeApi({ groups: [], skills: [{ id: "s-free", name: "release-notes" } as SkillSummary] });
  const view = await mount(api);
  try {
    const dialog = view.dialog();
    assert.equal(dialog.querySelector(".skill-groups-empty h3")?.textContent, "No Groups Yet");
    assertNoDomNode(dialog.querySelector(".skill-groups-panes"));
    await click(button(dialog, "New Group"));
    const field = dialog.querySelector<HTMLInputElement>(".skill-groups-new input")!;
    assert.equal(dialog.querySelector(".skill-groups-new .field-helper")?.textContent, "New groups are shared with your organization.");
    assert.equal(button(dialog, "Create Group").disabled, true);
    await typeInto(field, "Review Team");
    await click(button(dialog, "Create Group"));
    assert.deepEqual(api.writes, [["create", { name: "Review Team" }]]);
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Review Team");
    assert.ok(active() === button(dialog, "Add Skill"), "focus moves to the next step, Add Skill");
  } finally {
    await view.unmount();
  }
});

test("on a phone the list and the group are two steps of one sheet, with Back, and focus never leaves the dialog", async () => {
  phone = true;
  const view = await mount();
  try {
    const dialog = view.dialog();
    assert.equal(listRows(dialog).length, 4);
    assertNoDomNode(dialog.querySelector(".skill-groups-pane.detail"), "the list step only");
    assertNoDomNode(dialog.querySelector('.skill-groups-list > .row[aria-current]'), "a phone list shows no selection");
    await click(listRows(dialog)[1]!);
    assertNoDomNode(dialog.querySelector(".skill-groups-pane.list"), "the group step only");
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Platform Tools");
    const back = button(dialog, "Back to Groups");
    assert.ok(active() === back, "focus moves to Back when the tapped row goes away");
    assert.deepEqual([...dialog.querySelectorAll(".modal-foot button")].map((node) => node.textContent), ["Done"]);
    await click(back);
    assert.equal(listRows(dialog).length, 4);
    assert.ok(dialog.contains(active()), "focus stays in the dialog");

    // Crossing to desktop shows both panes with the chosen group; back to a phone keeps focus inside.
    await click(listRows(dialog)[2]!);
    await setPhone(false);
    assert.ok(dialog.querySelector(".skill-groups-pane.list") && dialog.querySelector(".skill-groups-pane.detail"));
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "My Drafts");
    listRows(dialog)[0]!.focus();
    await setPhone(true);
    assert.ok(dialog.contains(active()), `focus stays in the dialog, not ${active()?.tagName}`);
  } finally {
    phone = false;
    await view.unmount();
  }
});

test("a phone opened from Edit in Groups… starts on that group", async () => {
  phone = true;
  const view = await mount(fakeApi(), "platform");
  try {
    const dialog = view.dialog();
    assert.equal(dialog.querySelector(".skill-groups-name")?.textContent, "Platform Tools");
    assert.ok(button(dialog, "Back to Groups"));
  } finally {
    phone = false;
    await view.unmount();
  }
});
