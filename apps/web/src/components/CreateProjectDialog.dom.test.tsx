import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { IdentityAdministrationView, ProjectView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { CreateProjectDialog, duplicateProjectNameWarning } from "./CreateProjectDialog.js";

/**
 * New Project (#2965): the title every trigger uses, a one-line description, the name's field error
 * and duplicate warning, the full-width Access field and its loading row, and the states as notices.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
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

const ORG = "org-1";

function identityAs(role: "admin" | "operator" | "viewer"): IdentityAdministrationView {
  return {
    context: {
      userId: "user-me", userName: "Me", organizationId: ORG, organizationName: "Org", role,
      deviceId: "device", localBootstrap: false,
    },
    organizations: [{ organizationId: ORG, name: "Org", createdAt: 1 }],
    memberships: [
      { organizationId: ORG, organizationName: "Org", userId: "user-me", userName: "Me", userStatus: "active", role, createdAt: 1 },
    ],
    teams: [
      { teamId: "team-builders", organizationId: ORG, name: "Builders", memberUserIds: ["user-me"], createdAt: 1 },
    ],
  };
}

const createdProject = (name: string): ProjectView => ({
  id: "project-new", name, hidden: false, locations: [],
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
});

interface Rendered {
  requests: unknown[];
  created: ProjectView[];
  unmount: () => Promise<void>;
}

async function render(options: {
  client?: Partial<ApiClient>;
  accessScopeManagementSupported?: boolean;
  projects?: readonly Pick<ProjectView, "name">[];
  stacked?: boolean;
} = {}): Promise<Rendered> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const requests: unknown[] = [];
  const created: ProjectView[] = [];
  const client = {
    ...api,
    getIdentity: async () => identityAs("admin"),
    createProject: async (request: { name: string }) => {
      requests.push(request);
      return { project: createdProject(request.name) };
    },
    ...options.client,
  } as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <CreateProjectDialog
          accessScopeManagementSupported={options.accessScopeManagementSupported ?? false}
          projects={options.projects ?? []}
          stacked={options.stacked}
          onClose={() => {}}
          onCreated={(project) => { created.push(project); }}
        />
      </ApiProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return {
    requests,
    created,
    unmount: async () => {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

// The dialog is portalled to <body>.
const dialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const primary = () => [...dialog().querySelectorAll<HTMLButtonElement>(".modal-foot button")]
  .find((button) => text(button) === "Create Project")!;
const nameField = () => dialog().querySelector<HTMLInputElement>("input")!;
const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(" ")
  .map((id) => text(domWindow.document.getElementById(id) as unknown as Element));

async function typeName(value: string) {
  await act(async () => { fireDomEvent.change(nameField(), { target: { value } }); });
}

async function submit() {
  await act(async () => {
    dialog().querySelector("form")!.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }) as never);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

test("the dialog is titled New Project, its primary reads Create Project, and its description is one line", async () => {
  const view = await render();
  try {
    assert.equal(text(dialog().querySelector(".modal-title")), "New Project");
    assert.equal(text(primary()), "Create Project");
    const description = dialog().querySelector(".modal-desc");
    assert.equal(text(description), "Groups sessions by repository. You'll add its folders next.");
    assert.equal(dialog().getAttribute("aria-describedby"), description?.id);
    assert.equal(dialog().querySelectorAll("form p.muted").length, 0, "the form has no rules paragraph");
    assert.deepEqual(describedBy(nameField()), ["Use a name you'll recognize in the Sessions list."]);
    assert.ok(dialog().querySelector("form[novalidate]"), "no browser validation bubbles");
  } finally {
    await view.unmount();
  }
});

test("over New Session the description says the new project is selected there", async () => {
  const view = await render({ stacked: true });
  try {
    assert.equal(text(dialog().querySelector(".modal-desc")), "It's selected for this session once it's created.");
  } finally {
    await view.unmount();
  }
});

test("Create Project with an empty name shows the field error, focuses the name and sends nothing", async () => {
  const view = await render();
  try {
    assert.equal(primary().disabled, false, "a short form keeps its primary on (§8.5)");
    await submit();
    const error = dialog().querySelector(".field-error");
    assert.equal(text(error), "Enter a project name.");
    assert.equal(nameField().getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedBy(nameField()), ["Enter a project name."], "the error replaces the helper");
    assert.ok(domWindow.document.activeElement === (nameField() as unknown), "focus moves to the name");
    assertNoDomNode(dialog().querySelector(".form-error"), "no footer-style error");
    assertNoDomNode(dialog().querySelector('[role="alert"]'), "a field error is not an alert");
    assert.deepEqual(view.requests, []);

    await typeName("Docs Site");
    assertNoDomNode(dialog().querySelector(".field-error"), "the error clears once the name is valid");
    assert.equal(nameField().getAttribute("aria-invalid"), null);
  } finally {
    await view.unmount();
  }
});

test("a name another project uses warns with the count and that name, and creating stays allowed", async () => {
  const view = await render({ projects: [{ name: "Docs Site" }, { name: "docs site" }, { name: "Payments" }] });
  try {
    await typeName("DOCS SITE");
    const warning = dialog().querySelector(".field-warn");
    assert.equal(text(warning), "Two projects are already named Docs Site. A unique name keeps them apart in lists.");
    assert.deepEqual(describedBy(nameField()), [
      "Use a name you'll recognize in the Sessions list.",
      "Two projects are already named Docs Site. A unique name keeps them apart in lists.",
    ], "the helper stays and the warning describes the field too");
    assert.equal(nameField().getAttribute("aria-invalid"), null, "a warning is not an error");
    await submit();
    assert.deepEqual(view.requests, [{ name: "DOCS SITE" }]);
    assert.equal(view.created[0]?.name, "DOCS SITE");
  } finally {
    await view.unmount();
  }
});

test("duplicateProjectNameWarning counts case-insensitive matches and names the first one", () => {
  assert.equal(duplicateProjectNameWarning("  ", [{ name: "" }]), null);
  assert.equal(duplicateProjectNameWarning("Docs", [{ name: "Docs Site" }]), null);
  assert.equal(duplicateProjectNameWarning(" docs site ", [{ name: "Docs Site" }]),
    "A project is already named Docs Site. A unique name keeps them apart in lists.");
  assert.equal(duplicateProjectNameWarning("api", Array.from({ length: 12 }, () => ({ name: "API" }))),
    "12 projects are already named API. A unique name keeps them apart in lists.");
});

test("the Access field is labelled Access with its helper, and creates with the chosen owner", async () => {
  const view = await render({ accessScopeManagementSupported: true });
  try {
    const trigger = dialog().querySelector<HTMLButtonElement>("button.ui-select-trigger");
    assert.ok(trigger, "a full-width Select trigger");
    assert.equal(text(trigger.closest(".field")?.firstElementChild), "Access");
    assert.equal(trigger.getAttribute("aria-label"), "Access: Organization-Wide", "an admin's default is the organization");
    assert.match(text(trigger.closest(".field")), /Locations you add need at least this much access\./);
    assertNoDomNode(dialog().querySelector(".new-project-reason"), "nothing keeps Create Project off");
    await typeName("Docs Site");
    await submit();
    assert.deepEqual(view.requests, [{ name: "Docs Site", owner: { kind: "organization", organizationId: ORG } }]);
  } finally {
    await view.unmount();
  }
});

test("while access levels load, the Access field is a skeleton row and Create Project says why it's off", async () => {
  const view = await render({ accessScopeManagementSupported: true, client: { getIdentity: () => new Promise(() => {}) } });
  try {
    const skeleton = dialog().querySelector(".field .skeleton-row");
    assert.ok(skeleton, "a skeleton row holds the field's place");
    assert.equal(text(skeleton!.closest(".field")?.querySelector(".sr-only")), "Loading access levels…");
    assert.equal(primary().disabled, true);
    const reason = dialog().querySelector(".modal-foot .new-project-reason");
    assert.equal(text(reason), "Checking access levels…");
    assert.equal(primary().getAttribute("aria-describedby"), reason?.id);
  } finally {
    await view.unmount();
  }
});

test("a viewer sees the neutral notice and a disabled Create Project with the reason in the footer", async () => {
  const view = await render({ accessScopeManagementSupported: true, client: { getIdentity: async () => identityAs("viewer") } });
  try {
    const notice = dialog().querySelector(".notice.t-neutral");
    assert.equal(text(notice), "Your Viewer role can't create projects. Ask an admin for Operator access.");
    assert.ok(notice?.classList.contains("compact"));
    assert.equal(primary().disabled, true);
    const reason = dialog().querySelector(".modal-foot .new-project-reason");
    assert.equal(text(reason), "Your Viewer role can't create projects.");
    assert.equal(primary().getAttribute("aria-describedby"), reason?.id);
    assertNoDomNode(dialog().querySelector("button.ui-select-trigger"), "a viewer has no access to choose");
  } finally {
    await view.unmount();
  }
});

test("a failed request is Couldn't Create the Project above the footer, with the server's words behind Show Details", async () => {
  const view = await render({
    client: { createProject: async () => { throw new ApiError("name rejected by policy", 400); } },
  });
  try {
    await typeName("Docs Site");
    await submit();
    const alert = dialog().querySelector('[role="alert"]');
    assert.ok(alert?.classList.contains("t-danger"));
    assert.equal(text(alert?.querySelector(".notice-title")), "Couldn't Create the Project");
    assert.match(text(alert), /Wollipog refused the request\. Nothing was created\./);
    assert.doesNotMatch(text(alert), /name rejected by policy/, "the raw message waits behind Show Details");
    const form = dialog().querySelector("form")!;
    assert.ok(form.lastElementChild === alert, "the notice is the body's last element, directly above the footer");
    const toggle = [...alert!.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Show Details")!;
    await act(async () => { toggle.click(); });
    assert.match(text(alert), /name rejected by policy/);
    assert.equal(primary().disabled, false, "the person can try again");
  } finally {
    await view.unmount();
  }
});

test("a request that never reached Wollipog says it didn't respond", async () => {
  const view = await render({ client: { createProject: async () => { throw new TypeError("Failed to fetch"); } } });
  try {
    await typeName("Docs Site");
    await submit();
    assert.match(text(dialog().querySelector('[role="alert"]')), /^Couldn't Create the Project ?Wollipog didn't respond\. Nothing was created\./);
  } finally {
    await view.unmount();
  }
});
