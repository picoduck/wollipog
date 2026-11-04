import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView, TeamView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { deleteTeamMessage, TeamDialog } from "./TeamDialog.js";

/**
 * Create Team and Manage Team (#3000): one Save Changes that renames and then saves members only
 * when each changed, Team Name's field errors, member rows that keep a suspended member, masked
 * email names, and the Delete Team confirmation.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query === "(pointer: fine)",
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

const team: TeamView = { teamId: "team-1", organizationId: "org-1", name: "Support", memberUserIds: ["user-2", "user-3"], createdAt: 1 };

function identity(memberships: Array<{ userId: string; userName: string; role: string; userStatus: string }>): IdentityAdministrationView {
  return {
    context: { userId: "user-1", userName: "Misko", role: "owner", localBootstrap: true },
    memberships,
    teams: [team],
  } as unknown as IdentityAdministrationView;
}

const people = identity([
  { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" },
  { userId: "user-2", userName: "Pat", role: "operator", userStatus: "active" },
  { userId: "user-3", userName: "Sam", role: "viewer", userStatus: "suspended" },
  { userId: "user-4", userName: "Alex", role: "admin", userStatus: "active" },
]);

type Call = [string, ...unknown[]];

const unmounts = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const unmount of [...unmounts]) await unmount();
});

async function mount({ manage = team, directory = people, client: overrides = {} }: {
  manage?: TeamView | null;
  directory?: IdentityAdministrationView;
  client?: Partial<ApiClient>;
} = {}) {
  const calls: Call[] = [];
  let closed = 0;
  let saved = 0;
  const client = {
    ...api,
    renameIdentityTeam: async (...args: unknown[]) => { calls.push(["rename", ...args]); return { team }; },
    updateIdentityTeamMembers: async (...args: unknown[]) => { calls.push(["members", ...args]); return { team }; },
    createIdentityTeam: async (...args: unknown[]) => { calls.push(["create", ...args]); return { team }; },
    deleteIdentityTeam: async (...args: unknown[]) => { calls.push(["delete", ...args]); },
    ...overrides,
  } as unknown as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  body.append(mountPoint);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <TeamDialog
            identity={directory}
            {...(manage ? { team: manage } : {})}
            onClose={() => { closed += 1; }}
            onSaved={async () => { saved += 1; }}
          />
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  await settle();
  const unmount = async () => {
    if (!unmounts.delete(unmount)) return;
    await act(async () => root.unmount());
    mountPoint.remove();
  };
  unmounts.add(unmount);
  const dialog = (title = manage ? "Manage Team" : "Create Team") => [...body.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => element.querySelector(".modal-title")?.textContent === title) ?? null;
  return { calls, closed: () => closed, saved: () => saved, dialog, unmount };
}

const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;
const nameInput = (scope: Element) => {
  const label = [...scope.querySelectorAll("label")].find((element) => element.textContent === "Team Name");
  assert.ok(label, "Team Name has a label");
  return domWindow.document.getElementById(label.getAttribute("for")!) as unknown as HTMLInputElement;
};
const rows = (scope: Element) => [...scope.querySelectorAll<HTMLElement>(".choice-row")].map((row) => {
  const input = row.querySelector("input") as HTMLInputElement;
  return {
    title: row.querySelector(".choice-row-title")?.textContent,
    meta: row.querySelector(".choice-row-meta")?.textContent,
    checked: input.checked,
    disabled: input.getAttribute("aria-disabled") === "true",
    reason: row.querySelector(".choice-row-reason")?.textContent ?? null,
    input,
  };
});
const describedText = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
  .map((id) => domWindow.document.getElementById(id)?.textContent);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
}
async function press(button: HTMLButtonElement | null) {
  assert.ok(button, "the button is there");
  await act(async () => { button.click(); });
  await settle();
}
const save = (dialog: HTMLElement) => press(buttonNamed(dialog.closest(".modal-panel")!, "Save Changes"));

describe("Team dialog (#3000)", () => {
  test("Manage Team shows the name and everyone, sorted, with the role as Title Case meta and no intro", async () => {
    const view = await mount();
    const dialog = view.dialog();
    assert.ok(dialog, "the dialog is titled Manage Team, not the team's name");
    assert.equal(nameInput(dialog).value, "Support");
    assert.deepEqual(describedText(nameInput(dialog)), ["Up to 80 characters."]);
    assertNoDomNode(dialog.querySelector(".modal-desc, .access-dialog-intro"), "Manage has no intro");
    assert.deepEqual(rows(dialog).map(({ title, meta, checked }) => [title, meta, checked]), [
      ["Alex", "Admin", false],
      ["Misko", "Owner", false],
      ["Pat", "Operator", true],
      ["Sam", "Viewer", true],
    ]);
    const panel = dialog.closest(".modal-panel")!;
    assert.deepEqual([...panel.querySelectorAll(".modal-foot button")].map((button) => button.textContent?.trim()),
      ["Delete Team…", "Cancel", "Save Changes"]);
    const group = dialog.querySelector('[role="group"]')!;
    assert.equal(domWindow.document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent, "Members");
  });

  test("changing only the name sends one rename and no members request; changing nothing sends none", async () => {
    const unchanged = await mount();
    await save(unchanged.dialog()!);
    assert.deepEqual(unchanged.calls, []);
    assert.equal(unchanged.closed(), 1);
    assert.equal(unchanged.saved(), 0);
    await unchanged.unmount();

    // Retyping the same name with spaces is no change either.
    const spaced = await mount();
    await type(nameInput(spaced.dialog()!), "  Support ");
    await save(spaced.dialog()!);
    assert.deepEqual(spaced.calls, []);
    await spaced.unmount();

    const renamed = await mount();
    await type(nameInput(renamed.dialog()!), " Help Desk ");
    await save(renamed.dialog()!);
    assert.deepEqual(renamed.calls, [["rename", "team-1", "Help Desk"]]);
    assert.equal(renamed.saved(), 1);
    assert.equal(renamed.closed(), 1);
  });

  test("a taken name is a field error under Team Name, and nothing else is sent", async () => {
    const view = await mount({
      client: {
        renameIdentityTeam: async () => {
          throw new ApiError("another team in this organization already has this name", 409, "team_name_taken");
        },
      },
    });
    const dialog = view.dialog()!;
    const input = nameInput(dialog);
    await type(input, "Platform");
    const pat = rows(dialog).find((row) => row.title === "Pat")!;
    await act(async () => { pat.input.click(); });
    await save(dialog);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedText(input), ["Another team already has this name."]);
    assertNoDomNode(dialog.querySelector(".field-helper"), "the error replaces the helper");
    assert.ok((domWindow.document.activeElement as unknown) === input, "focus moves to the refused field");
    assert.deepEqual(view.calls, [], "members are not saved after a refused rename");
    assert.equal(view.closed(), 0);
    assertNoDomNode(dialog.querySelector(".notice"), "a field error is not a save failure");
    await type(input, "Platform Two");
    assert.equal(input.getAttribute("aria-invalid"), null, "the error clears once the name changes");
  });

  test("a suspended member stays checked and disabled, and Save Changes keeps them on the team", async () => {
    const view = await mount();
    const dialog = view.dialog()!;
    const sam = () => rows(dialog).find((row) => row.title === "Sam")!;
    assert.deepEqual([sam().checked, sam().disabled, sam().reason], [true, true, "Suspended. Restore their access to add them."]);
    await act(async () => { sam().input.click(); });
    assert.equal(sam().checked, true, "a suspended member can't be removed here");
    const alex = rows(dialog).find((row) => row.title === "Alex")!;
    assert.deepEqual([alex.disabled, alex.reason], [false, null]);
    await act(async () => { alex.input.click(); });
    await save(dialog);
    assert.equal(view.calls.length, 1);
    const [kind, teamId, memberIds] = view.calls[0]!;
    assert.deepEqual([kind, teamId, [...memberIds as string[]].sort()], ["members", "team-1", ["user-2", "user-3", "user-4"]]);
  });

  test("a suspended person not on the team can't be added", async () => {
    const view = await mount({ manage: { ...team, memberUserIds: [] } });
    const dialog = view.dialog()!;
    const sam = () => rows(dialog).find((row) => row.title === "Sam")!;
    assert.deepEqual([sam().checked, sam().disabled], [false, true]);
    await act(async () => { sam().input.click(); });
    assert.equal(sam().checked, false);
    await save(dialog);
    assert.deepEqual(view.calls, []);
  });

  test("a rename that succeeds while the members fail keeps the dialog open with the new name; trying again sends only the members", async () => {
    let fail = true;
    const memberCalls: unknown[] = [];
    const view = await mount({
      client: {
        updateIdentityTeamMembers: async (...args: unknown[]) => {
          memberCalls.push(args);
          if (fail) throw new ApiError("database is locked", 409);
          return { team };
        },
      },
    });
    const dialog = view.dialog()!;
    await type(nameInput(dialog), "Help Desk");
    await act(async () => { rows(dialog).find((row) => row.title === "Pat")!.input.click(); });
    await save(dialog);
    assert.deepEqual(view.calls, [["rename", "team-1", "Help Desk"]]);
    assert.equal(memberCalls.length, 1);
    assert.equal(view.closed(), 0);
    assert.equal(nameInput(dialog).value, "Help Desk");
    const notice = dialog.querySelector(".notice.t-danger")!;
    assert.ok(notice, "the failure is a danger notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Save the Team");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "The new name was saved, but the members weren't. Try again.");
    assert.equal(notice.textContent?.includes("database is locked"), false, "the raw message waits behind Show Details");
    await press(buttonNamed(notice, "Show Details"));
    assert.ok(notice.textContent?.includes("database is locked"));
    assert.equal(view.saved(), 1, "the page behind refreshes to show the saved name");

    fail = false;
    await save(dialog);
    assert.deepEqual(view.calls, [["rename", "team-1", "Help Desk"]], "the saved name is not sent again");
    assert.equal(memberCalls.length, 2);
    assert.equal(view.closed(), 1);
  });

  test("the containment refusal says to move the work first", async () => {
    const view = await mount({
      client: {
        updateIdentityTeamMembers: async () => {
          throw new ApiError("cannot remove user 'user-2' from this team because ...", 409, "team_member_containment");
        },
      },
    });
    const dialog = view.dialog()!;
    await act(async () => { rows(dialog).find((row) => row.title === "Pat")!.input.click(); });
    await save(dialog);
    assert.equal(dialog.querySelector(".notice-body")?.textContent,
      "Someone you removed still owns work shared with this team. Move that work first.");
  });

  test("Create Team: one sentence about teams, an empty name is a field error, and the primary stays enabled", async () => {
    const view = await mount({ manage: null });
    const dialog = view.dialog("Create Team");
    assert.ok(dialog);
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Teams share machines, workspaces and sessions among their members.");
    const panel = dialog.closest(".modal-panel")!;
    const create = buttonNamed(panel, "Create Team")!;
    assert.equal(create.disabled, false);
    assertNoDomNode(buttonNamed(panel, "Delete Team…"));
    await press(create);
    const input = nameInput(dialog);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedText(input), ["Enter a team name."]);
    assert.deepEqual(view.calls, []);

    await type(input, "Platform");
    assert.equal(input.getAttribute("aria-invalid"), null);
    await act(async () => { rows(dialog).find((row) => row.title === "Pat")!.input.click(); });
    await press(create);
    assert.deepEqual(view.calls, [["create", { name: "Platform", memberUserIds: ["user-2"] }]]);
    assert.equal(view.closed(), 1);
  });

  test("Create Team shows a taken name under Team Name", async () => {
    const view = await mount({
      manage: null,
      client: { createIdentityTeam: async () => { throw new ApiError("taken", 409, "team_name_taken"); } },
    });
    const dialog = view.dialog("Create Team")!;
    await type(nameInput(dialog), "Support");
    await press(buttonNamed(dialog.closest(".modal-panel")!, "Create Team"));
    assert.deepEqual(describedText(nameInput(dialog)), ["Another team already has this name."]);
  });

  test("email-shaped member names stay masked until Show Names", async () => {
    const view = await mount({
      directory: identity([
        { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" },
        { userId: "user-2", userName: "pat@example.org", role: "operator", userStatus: "active" },
        { userId: "user-3", userName: "sam@example.net", role: "viewer", userStatus: "suspended" },
      ]),
    });
    const dialog = view.dialog()!;
    assert.equal(dialog.innerHTML.includes("@example."), false);
    assert.deepEqual(rows(dialog).map((row) => row.title), ["Misko", "Hidden Name 1", "Hidden Name 2"]);
    const reveal = buttonNamed(dialog, "Show Names")!;
    assert.ok(reveal.closest(".field-head"), "Show Names shares the Members label's line");
    assert.ok(reveal.classList.contains("btn") && reveal.classList.contains("sm") && reveal.classList.contains("ghost"));
    await press(reveal);
    assert.deepEqual(rows(dialog).map((row) => row.title), ["Misko", "pat@example.org", "sam@example.net"]);
    assert.ok(buttonNamed(dialog, "Hide Names"));
  });

  test("no Show Names when no name is email-shaped", async () => {
    const view = await mount();
    assertNoDomNode(buttonNamed(view.dialog()!, "Show Names"));
  });

  test("Delete Team… confirms with the team's saved members and deletes from the confirmation", async () => {
    const view = await mount();
    await press(buttonNamed(view.dialog()!.closest(".modal-panel")!, "Delete Team…"));
    const confirmation = view.dialog("Delete Team")!;
    assert.ok(confirmation);
    assert.ok(confirmation.textContent?.includes(
      "“Support” is deleted and can't be restored. Its 2 members keep their own access; what was shared with the team is no longer shared.",
    ));
    await press(buttonNamed(confirmation.closest(".modal-panel")!, "Delete Team"));
    assert.deepEqual(view.calls, [["delete", "team-1"]]);
    assert.equal(view.saved(), 1);
    assert.equal(view.closed(), 1);
  });

  test("a refused deletion stays in the confirmation in plain words", async () => {
    const view = await mount({
      client: {
        deleteIdentityTeam: async () => { throw new ApiError("reassign resources owned by this team before deleting it", 409); },
      },
    });
    await press(buttonNamed(view.dialog()!.closest(".modal-panel")!, "Delete Team…"));
    const confirmation = view.dialog("Delete Team")!;
    await press(buttonNamed(confirmation.closest(".modal-panel")!, "Delete Team"));
    assert.ok(confirmation.textContent?.includes("This team still owns work. Move that work to a person or another team first."));
    assert.equal(view.closed(), 0);
  });

  test("the Delete Team sentence follows the member count", () => {
    assert.equal(deleteTeamMessage("Support", 0), "“Support” is deleted and can't be restored. No one loses access to their own work.");
    assert.equal(deleteTeamMessage("Support", 1),
      "“Support” is deleted and can't be restored. Its 1 member keeps their own access; what was shared with the team is no longer shared.");
    assert.equal(deleteTeamMessage("Support", 3),
      "“Support” is deleted and can't be restored. Its 3 members keep their own access; what was shared with the team is no longer shared.");
  });
});
