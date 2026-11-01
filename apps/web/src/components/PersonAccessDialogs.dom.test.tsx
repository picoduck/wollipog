import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
  OrganizationRole,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { PeopleDevicesPanel } from "./PeopleDevicesPanel.js";
import { AddPersonDialog, ManagePersonDialog } from "./PersonAccessDialogs.js";

const domWindow = new Window({ url: "http://localhost/" });
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

/** Dialogs are portalled to <body>. */
function page(): HTMLElement {
  return domWindow.document.body as unknown as HTMLElement;
}

function dialogs(): HTMLElement[] {
  return [...page().querySelectorAll<HTMLElement>('[role="dialog"]')];
}

/** The dialog whose title reads `title`. */
function dialog(title: string): HTMLElement {
  const found = dialogs().find((candidate) =>
    domWindow.document.getElementById(candidate.getAttribute("aria-labelledby") ?? "")?.textContent === title);
  assert.ok(found, `the ${title} dialog is open`);
  return found;
}

function buttonIn(scope: Element, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
}

function nameField(scope: Element): HTMLInputElement {
  const label = [...scope.querySelectorAll("label")].find((candidate) => candidate.textContent === "Name");
  assert.ok(label, "the Name field has a visible label");
  const input = domWindow.document.getElementById(label.getAttribute("for") ?? "") as unknown as HTMLInputElement | null;
  assert.ok(input, "the label names the input");
  return input;
}

/** The text of every element `element`'s aria-describedby names. */
function description(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" ");
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    fireDomEvent.change(input);
  });
}

async function press(button: HTMLButtonElement | undefined) {
  assert.ok(button, "the button is rendered");
  await act(async () => {
    button.click();
    await tick();
  });
  await act(async () => { await tick(); });
}

async function mount(element: React.ReactElement) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(element);
    await tick();
  });
  return {
    mountPoint,
    async unmount() {
      await act(async () => root.unmount());
      mountPoint.remove();
      // Toasts and anything else left on the body belong to the test that is ending.
      for (const leftover of [...domWindow.document.body.children]) leftover.remove();
    },
  };
}

type UpdateBody = Parameters<ApiClient["updateIdentityMember"]>[1];

function member(overrides: Partial<OrganizationMembershipView> = {}): OrganizationMembershipView {
  return { userId: "user-2", userName: "Pat Jones", role: "operator", userStatus: "active", ...overrides } as OrganizationMembershipView;
}

function renderManage({
  person = member(),
  actorRole = "owner" as OrganizationRole,
  pairedDevices,
  updateIdentityMember = async () => ({}) as never,
  onClose = () => {},
}: {
  person?: OrganizationMembershipView;
  actorRole?: OrganizationRole;
  pairedDevices?: number | null;
  updateIdentityMember?: ApiClient["updateIdentityMember"];
  onClose?: () => void;
} = {}) {
  return mount(
    <ApiProvider client={{ ...api, updateIdentityMember } as ApiClient}>
      <FeedbackProvider>
        <ManagePersonDialog
          actorRole={actorRole}
          member={person}
          pairedDevices={pairedDevices}
          onClose={onClose}
          onSaved={async () => {}}
        />
      </FeedbackProvider>
    </ApiProvider>,
  );
}

describe("Add Person and Manage Person (#2998)", () => {
  test("Add Person keeps its primary enabled and shows the missing name under the field", async () => {
    const created: Array<{ displayName: string; role: OrganizationRole }> = [];
    let closes = 0;
    const view = await mount(
      <ApiProvider client={{ ...api, createIdentityMember: async (body) => { created.push(body); return {} as never; } } as ApiClient}>
        <AddPersonDialog actorRole="owner" onClose={() => { closes += 1; }} onSaved={async () => {}} />
      </ApiProvider>,
    );
    try {
      const add = dialog("Add Person");
      assert.equal(add.querySelector(".modal-desc")?.textContent, "Next, pair a device so they can sign in.");
      assert.match(description(add), /Next, pair a device so they can sign in\./);
      const primary = buttonIn(add, "Add Person");
      assert.ok(primary, "the primary repeats the title");
      assert.equal(primary.disabled, false, "an empty name does not disable the primary");
      assert.equal(primary.getAttribute("aria-disabled"), null);
      const name = nameField(add);
      assert.equal(name.maxLength, 80);
      assert.equal(description(name), "Enter the person's name.");
      assertNoDomNode(add.querySelector(".access-form, .access-dialog-intro, .form-error"), "no retired form classes");

      await press(primary);
      assert.deepEqual(created, [], "an empty name is not sent");
      assert.equal(name.getAttribute("aria-invalid"), "true");
      assert.equal(add.querySelector(".field-error")?.textContent, "Enter the person's name.");
      assert.equal(description(name), "Enter the person's name.", "the error replaces the helper");
      assert.ok(domWindow.document.activeElement === (name as unknown), "focus moves to the name");

      await type(name, "Sam");
      assert.equal(name.getAttribute("aria-invalid"), null, "typing a name clears the error");
      assertNoDomNode(add.querySelector(".field-error"));

      await press(buttonIn(add, "Add Person"));
      assert.deepEqual(created, [{ displayName: "Sam", role: "viewer" }], "Viewer is chosen by default");
      assert.equal(closes, 1);
    } finally {
      await view.unmount();
    }
  });

  test("Access Level lists four levels from Viewer to Owner, and an admin sees why Owner is unavailable", async () => {
    const view = await mount(
      <ApiProvider client={api}>
        <AddPersonDialog actorRole="admin" onClose={() => {}} onSaved={async () => {}} />
      </ApiProvider>,
    );
    try {
      const group = dialog("Add Person").querySelector('[role="radiogroup"]');
      assert.ok(group, "Access Level is a radio group");
      assert.equal(domWindow.document.getElementById(group.getAttribute("aria-labelledby") ?? "")?.textContent, "Access Level");
      const rows = [...group.querySelectorAll(".choice-row")];
      assert.deepEqual(rows.map((row) => row.querySelector(".choice-row-title")?.textContent), ["Viewer", "Operator", "Admin", "Owner"]);
      assert.deepEqual(rows.slice(0, 3).map((row) => row.querySelector(".choice-row-desc")?.textContent), [
        "Read-only access to shared work and connection status.",
        "Run and manage work, without changing who has access.",
        "Manage connections, people, teams and paired devices.",
      ]);
      const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      assert.equal(radios[0]!.checked, true, "Viewer is chosen by default");
      const owner = radios[3]!;
      assert.equal(owner.getAttribute("aria-disabled"), "true", "Owner is refused for an admin");
      assert.equal(owner.disabled, false, "but stays in the arrow-key order");
      assert.equal(rows[3]!.querySelector(".choice-row-reason")?.textContent, "Only an owner can make someone an owner.");
      assert.match(description(owner), /Only an owner can make someone an owner\./);
    } finally {
      await view.unmount();
    }
  });

  test("an owner can choose Owner, and Manage Person's Save Changes sends only the name and access level", async () => {
    const updates: UpdateBody[] = [];
    let closes = 0;
    const view = await renderManage({
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
      onClose: () => { closes += 1; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      assert.equal(manage.textContent?.includes("Account Status"), false, "no Account Status control");
      assertNoDomNode(manage.querySelector("select"));
      const owner = [...manage.querySelectorAll<HTMLInputElement>('input[type="radio"]')][3]!;
      assert.equal(owner.getAttribute("aria-disabled"), null);

      // Nothing changed: Save Changes closes without a request.
      await press(buttonIn(manage, "Save Changes"));
      assert.equal(updates.length, 0);
      assert.equal(closes, 1);
    } finally {
      await view.unmount();
    }

    const second = await renderManage({
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
      onClose: () => { closes += 1; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      await type(nameField(manage), "  Pat Smith ");
      const admin = [...manage.querySelectorAll<HTMLInputElement>('input[type="radio"]')][2]!;
      await act(async () => { admin.click(); });
      await press(buttonIn(manage, "Save Changes"));
      assert.deepEqual(updates, [{ displayName: "Pat Smith", role: "admin" }], "status never rides along");
      assert.equal(closes, 2);
    } finally {
      await second.unmount();
    }
  });

  test("Manage Person's empty name is a field error, and its Paired Devices line counts the person's devices", async () => {
    const updates: UpdateBody[] = [];
    const view = await renderManage({
      pairedDevices: 3,
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      const facts = manage.querySelector("dl.facts");
      assert.equal(facts?.querySelector("dt")?.textContent, "Paired Devices");
      assert.equal(facts?.querySelector("dd")?.textContent, "3 devices. They use this access level.");
      assert.match(description(manage), /3 devices\. They use this access level\./);

      const name = nameField(manage);
      await type(name, " ");
      const save = buttonIn(manage, "Save Changes")!;
      assert.equal(save.disabled, false);
      await press(save);
      assert.deepEqual(updates, []);
      assert.equal(name.getAttribute("aria-invalid"), "true");
      assert.equal(manage.querySelector(".field-error")?.textContent, "Enter the person's name.");
      assert.ok(domWindow.document.activeElement === (name as unknown));
    } finally {
      await view.unmount();
    }

    const none = await renderManage({ pairedDevices: 0 });
    try {
      assert.equal(dialog("Manage Pat Jones").querySelector("dl.facts dd")?.textContent,
        "None yet. Use Pair Device… to give them a sign-in link.");
    } finally {
      await none.unmount();
    }

    const hidden = await renderManage();
    try {
      assertNoDomNode(dialog("Manage Pat Jones").querySelector("dl.facts"), "no line where devices are not shown");
    } finally {
      await hidden.unmount();
    }
  });

  test("Suspend Access… confirms first; Cancel sends nothing and returns focus", async () => {
    const updates: UpdateBody[] = [];
    const view = await renderManage({
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      const suspend = buttonIn(manage, "Suspend Access…");
      assert.ok(suspend, "an active person's dialog offers Suspend Access…");
      assert.match(suspend.className, /\bbtn\b.*\bghost\b.*\bdanger\b/);
      assert.ok(suspend.closest(".modal-tertiary"), "it is the footer's destructive tertiary");
      assert.ok(suspend.querySelector("svg"), "with its icon");
      suspend.focus();
      await press(suspend);

      const confirmation = dialog("Suspend Access");
      assert.match(confirmation.textContent ?? "",
        /Pat Jones is signed out everywhere and can't use Wollipog until you restore access\. Their devices stay paired\./);
      const confirmButton = buttonIn(confirmation, "Suspend Access");
      assert.ok(confirmButton);
      assert.match(confirmButton.className, /\bdanger\b/);
      await press(buttonIn(confirmation, "Cancel"));
      assert.deepEqual(updates, [], "Cancel sends nothing");
      assert.equal(dialogs().length, 1);
      assert.ok(domWindow.document.activeElement === (buttonIn(dialog("Manage Pat Jones"), "Suspend Access…") as unknown),
        "focus returns to Suspend Access…");
    } finally {
      await view.unmount();
    }
  });

  test("confirming Suspend Access sends the status alone and the People row shows Suspended", async () => {
    const owner = { userId: "user-1", userName: "Misko", role: "owner", userStatus: "active" } as OrganizationMembershipView;
    let server: IdentityAdministrationView = {
      context: { userId: "user-1", userName: "Misko", role: "owner", localBootstrap: true },
      memberships: [owner, member()],
      teams: [],
    } as unknown as IdentityAdministrationView;
    const updates: UpdateBody[] = [];
    const devices = [
      { deviceId: "device-1", name: "Pat's Phone", userId: "user-2", userName: "Pat Jones", role: "operator", createdAt: 1, lastSeenAt: null },
      { deviceId: "device-2", name: "Pat's Laptop", userId: "user-2", userName: "Pat Jones", role: "operator", createdAt: 1, lastSeenAt: null },
    ] as unknown as DeviceView[];
    const client = {
      ...api,
      getIdentity: async () => server,
      listDevices: async () => ({ devices }),
      updateIdentityMember: async (userId: string, body: UpdateBody) => {
        updates.push(body);
        server = {
          ...server,
          memberships: server.memberships.map((item) => item.userId === userId && body.status
            ? { ...item, userStatus: body.status }
            : item),
        };
        return {} as never;
      },
    } as unknown as ApiClient;
    function Harness() {
      const [identity, setIdentity] = useState(server);
      return <PeopleDevicesPanel identity={identity} onIdentityChange={setIdentity} />;
    }
    const view = await mount(
      <ApiProvider client={client}>
        <FeedbackProvider><Harness /></FeedbackProvider>
      </ApiProvider>,
    );
    try {
      await act(async () => { await tick(); });
      const row = () => [...view.mountPoint.querySelectorAll(".access-row")]
        .find((candidate) => candidate.textContent?.includes("Pat Jones") && candidate.textContent?.includes("Manage"))!;
      assert.match(row().textContent ?? "", /Active/);
      await press(buttonIn(row(), "Manage"));
      const manage = dialog("Manage Pat Jones");
      assert.equal(manage.querySelector("dl.facts dd")?.textContent, "2 devices. They use this access level.");
      // A pointer press focuses the button; happy-dom's click() does not.
      buttonIn(manage, "Suspend Access…")!.focus();
      await press(buttonIn(manage, "Suspend Access…"));
      const confirmButton = buttonIn(dialog("Suspend Access"), "Suspend Access")!;
      confirmButton.focus();
      await press(confirmButton);
      await act(async () => { await tick(); });

      assert.deepEqual(updates, [{ status: "suspended" }]);
      assert.match(row().textContent ?? "", /Suspended/, "the list is refreshed");
      const after = dialog("Manage Pat Jones");
      assert.ok(buttonIn(after, "Suspend Access…") === undefined);
      assert.match(after.querySelector(".notice")?.textContent ?? "", /Access is suspended\. Pat Jones can't sign in and their devices can't connect\./);
      assert.ok(domWindow.document.activeElement === (buttonIn(after, "Restore Access") as unknown),
        "focus moves to Restore Access, which took Suspend Access…'s place");
    } finally {
      await view.unmount();
    }
  });

  test("a suspended person's dialog restores access at once with a success toast", async () => {
    const updates: UpdateBody[] = [];
    const view = await renderManage({
      person: member({ userStatus: "suspended" }),
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      const notice = manage.querySelector(".notice");
      assert.ok(notice, "the dialog opens with the suspension notice");
      assert.match(notice.className, /\bt-neutral\b/);
      assert.match(notice.className, /\bcompact\b/);
      assert.ok(buttonIn(manage, "Suspend Access…") === undefined);
      assert.match(description(manage), /Access is suspended\./);

      await press(buttonIn(notice, "Restore Access"));
      assert.deepEqual(updates, [{ status: "active" }], "no confirmation: restoring is not destructive");
      assertNoDomNode(manage.querySelector(".notice"), "the notice is replaced");
      assert.match(page().querySelector(".toast-message")?.textContent ?? "", /Access restored for Pat Jones\./);
      assert.ok(domWindow.document.activeElement === (buttonIn(manage, "Suspend Access…") as unknown),
        "focus moves to Suspend Access…, which took the notice's place");
    } finally {
      await view.unmount();
    }
  });

  test("an email-shaped name is masked inside an input-styled box until Show Name", async () => {
    const updates: UpdateBody[] = [];
    const view = await renderManage({
      person: member({ userName: "pat@example.com" }),
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
    });
    try {
      const manage = dialog("Manage Person");
      assert.equal(page().innerHTML.includes("@example."), false, "neither the title nor the field shows the name");
      const box = manage.querySelector(".pid-field-box");
      assert.ok(box?.querySelector(".pid-mask"), "the mask sits inside the field box");
      assert.equal(manage.querySelector(".field-helper")?.textContent, "Hidden because it looks like an email address.");
      assert.ok(manage.querySelector(".pid-field-head")?.contains(buttonIn(manage, "Show Name") as unknown as Node));

      const show = buttonIn(manage, "Show Name")!;
      show.focus();
      await act(async () => { show.click(); });
      assert.equal(nameField(manage).value, "pat@example.com");
      assertNoDomNode(manage.querySelector(".pid-field-box"), "revealed, it is the normal input");
      // A keyboard reveal keeps focus on the same control, so the next Enter hides it again.
      assert.ok(domWindow.document.activeElement === (buttonIn(manage, "Hide Name") as unknown));
      await act(async () => { buttonIn(manage, "Hide Name")!.click(); });
      assert.equal(page().innerHTML.includes("@example."), false, "the name can be hidden again");

      // Suspending never names it either.
      await press(buttonIn(manage, "Suspend Access…"));
      assert.match(dialog("Suspend Access").textContent ?? "", /This person is signed out everywhere/);
      assert.equal(page().innerHTML.includes("@example."), false);
      await press(buttonIn(dialog("Suspend Access"), "Cancel"));

      // Changing only the access level never needs the name revealed, and saves it unchanged.
      const viewer = [...manage.querySelectorAll<HTMLInputElement>('input[type="radio"]')][0]!;
      await act(async () => { viewer.click(); });
      await press(buttonIn(manage, "Save Changes"));
      assert.deepEqual(updates, [{ displayName: "pat@example.com", role: "viewer" }]);
    } finally {
      await view.unmount();
    }
  });

  test("a running suspension cannot be cancelled, and the dialog under it cannot close or save", async () => {
    const updates: UpdateBody[] = [];
    let settle!: () => void;
    let closes = 0;
    const view = await renderManage({
      updateIdentityMember: (_userId, body) => {
        updates.push(body);
        return new Promise((resolve) => { settle = () => resolve({} as never); });
      },
      onClose: () => { closes += 1; },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      await press(buttonIn(manage, "Suspend Access…"));
      await press(buttonIn(dialog("Suspend Access"), "Suspend Access"));
      assert.equal(updates.length, 1);

      const cancel = buttonIn(dialog("Suspend Access"), "Cancel")!;
      assert.equal(cancel.disabled, true, "Cancel is locked while the request runs");
      await act(async () => {
        domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never);
        await tick();
      });
      assert.ok(dialog("Suspend Access"), "Escape does not close it either");
      // The dialog underneath refuses to close or save until the suspension settles.
      await press(buttonIn(manage, "Save Changes"));
      assert.equal(closes, 0);
      assert.equal(updates.length, 1);

      await act(async () => { settle(); await tick(); });
      await act(async () => { await tick(); });
      assert.equal(dialogs().length, 1, "the confirmation closes once the request settles");
      assert.match(dialog("Manage Pat Jones").querySelector(".notice")?.textContent ?? "", /Access is suspended\./);
    } finally {
      await view.unmount();
    }
  });

  test("an edited name that was hidden again is still validated, and revealed with its error", async () => {
    const updates: UpdateBody[] = [];
    const view = await renderManage({
      person: member({ userName: "pat@example.com" }),
      updateIdentityMember: async (_userId, body) => { updates.push(body); return {} as never; },
    });
    try {
      const manage = dialog("Manage Person");
      await act(async () => { buttonIn(manage, "Show Name")!.click(); });
      await type(nameField(manage), "");
      await act(async () => { buttonIn(manage, "Hide Name")!.click(); });
      assert.ok(manage.querySelector(".pid-field-box"));

      await press(buttonIn(manage, "Save Changes"));
      assert.equal(updates.length, 0, "an empty name is not sent");
      const name = nameField(manage);
      assert.equal(name.getAttribute("aria-invalid"), "true", "the field is revealed with its error");
      assert.equal(manage.querySelector(".field-error")?.textContent, "Enter the person's name.");
      assert.ok(domWindow.document.activeElement === (name as unknown), "focus moves to the revealed input");
    } finally {
      await view.unmount();
    }
  });

  test("a failed save is a titled danger notice with the server's words only under Show Details", async () => {
    const raw = "identity store is locked (SQLITE_BUSY)";
    const view = await renderManage({
      updateIdentityMember: async () => { throw new ApiError(raw, 409); },
    });
    try {
      const manage = dialog("Manage Pat Jones");
      await type(nameField(manage), "Pat Smith");
      await press(buttonIn(manage, "Save Changes"));
      const notice = manage.querySelector(".notice.t-danger");
      assert.ok(notice, "the failure is a danger notice");
      assert.equal(notice.getAttribute("role"), "alert");
      assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Save Changes");
      assert.match(notice.textContent ?? "", /Wollipog didn't save the change\. Nothing changed; try again\./);
      assert.equal(page().textContent?.includes(raw), false, "the raw message waits behind Show Details");
      const form = manage.querySelector("form")!;
      assert.ok(form.lastElementChild === notice, "directly above the footer");
      assertNoDomNode(manage.querySelector(".form-error"));
      await press(buttonIn(notice, "Show Details"));
      assert.match(notice.textContent ?? "", /identity store is locked \(SQLITE_BUSY\)/);
    } finally {
      await view.unmount();
    }
  });

  test("the server's owner rule and length refusal read in the person's words", async () => {
    const owner = await mount(
      <ApiProvider client={{
        ...api,
        createIdentityMember: async () => { throw new ApiError("only an organization owner can grant owner access", 403); },
      } as ApiClient}>
        <AddPersonDialog actorRole="owner" onClose={() => {}} onSaved={async () => {}} />
      </ApiProvider>,
    );
    try {
      const add = dialog("Add Person");
      await type(nameField(add), "Sam");
      await press(buttonIn(add, "Add Person"));
      const notice = add.querySelector(".notice.t-danger");
      assert.equal(notice?.querySelector(".notice-title")?.textContent, "Couldn't Add Sam");
      assert.match(notice?.textContent ?? "", /Only an owner can change owner access\./);
    } finally {
      await owner.unmount();
    }

    const length = await mount(
      <ApiProvider client={{
        ...api,
        createIdentityMember: async () => { throw new ApiError("displayName must be 1-80 characters", 400); },
      } as ApiClient}>
        <AddPersonDialog actorRole="owner" onClose={() => {}} onSaved={async () => {}} />
      </ApiProvider>,
    );
    try {
      const add = dialog("Add Person");
      const name = nameField(add);
      await type(name, "Sam");
      await press(buttonIn(add, "Add Person"));
      assertNoDomNode(add.querySelector(".notice.t-danger"), "a refused name is not a submit failure");
      assert.equal(name.getAttribute("aria-invalid"), "true");
      assert.equal(add.querySelector(".field-error")?.textContent, "Use 80 characters or fewer.");
    } finally {
      await length.unmount();
    }
  });
});
