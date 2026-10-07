import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ProviderLoginView, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { SessionsListNotices, type MachineSignIn } from "./SessionsListNotices.js";

const domWindow = new Window({ url: "http://localhost/" });
const { cleanup } = installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  InputEvent: domWindow.InputEvent,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); };

const builtIn = { release: "0.28.0", heldUpdate: null };
const skill = (id: string, name: string) =>
  ({ id, name, builtIn, recommendation: { dismissed: false }, assignmentCount: 0 });

function login(overrides: Partial<ProviderLoginView> = {}): ProviderLoginView {
  return {
    operationId: "op-1", accountId: "acct-1", label: "Work Account", provider: "codex",
    status: "waiting_for_provider", verificationUrl: "https://auth.example.com/device", userCode: "WXYZ-1234",
    startedAt: 1, ...overrides,
  };
}

const setupSession = {
  id: "pay-1", projectId: "payments", runnerId: "runner-1", worktreePath: "/worktrees/pay-1",
} as unknown as SessionView & { projectId: string };

const MACHINES: Record<string, string> = { "runner-1": "Build Box", "runner-2": "Studio Mac" };

type Props = {
  signIns?: MachineSignIn[];
  setup?: boolean;
  hidden?: boolean;
};

async function mount(client: ApiClient, initial: Props) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });
  const render = async ({ signIns = [], setup = false, hidden = false }: Props) => {
    await act(async () => {
      root.render(
        <ApiProvider client={client}>
          <SessionsListNotices
            signIns={signIns}
            machineName={(runnerId) => MACHINES[runnerId] ?? runnerId}
            {...(setup ? { setup: { session: setupSession, projectName: "Payments Service" } } : {})}
            hidden={hidden}
            onOpenSkill={() => {}}
            onSetupGenerated={() => {}}
          />
        </ApiProvider>,
      );
    });
    await act(settle);
  };
  await render(initial);
  const body = domWindow.document.body as unknown as HTMLElement;
  return {
    container,
    render,
    notices: () => [...container.querySelectorAll<HTMLElement>(".notice")],
    title: () => container.querySelector(".notice-title")?.textContent ?? null,
    more: () => container.querySelector<HTMLButtonElement>(".session-notice-more"),
    menuItems: () => [...body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    button: (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name),
  };
}

function client(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    ...api,
    listSkills: async () => ({ skills: [skill("a", "orchestrate-issues"), skill("b", "using-wollipog")] }),
    ...overrides,
  } as unknown as ApiClient;
}

test("a pending sign-in, two recommended skills and a setup suggestion are one notice: the sign-in, with +2 More", async () => {
  const view = await mount(client(), { signIns: [{ runnerId: "runner-1", login: login() }], setup: true });
  assert.equal(view.notices().length, 1, "exactly one notice shows");
  assert.equal(view.title(), "Sign In to Codex on Build Box");
  assert.ok(view.notices()[0]!.classList.contains("t-warning"), "a pending sign-in is a warning");
  assert.equal(view.more()?.textContent, "+2 More");
  await act(async () => { view.more()!.click(); });
  assert.deepEqual(view.menuItems(), ["Set Up Payments Service", "Recommended Skills"],
    "the others wait behind it, the lower rank first");
  assert.equal(domWindow.document.body.querySelector('[role="menu"]')?.getAttribute("aria-label"), "Sessions Notices");

  // The sign-in resolves: on the Project's tab the setup suggestion shows, with Recommended Skills
  // behind it.
  await view.render({ setup: true });
  assert.equal(view.notices().length, 1);
  assert.equal(view.title(), "Set Up Payments Service");
  assert.equal(view.more()?.textContent, "+1 More");

  // Elsewhere there is no setup suggestion, so Recommended Skills shows alone.
  await view.render({});
  assert.equal(view.notices().length, 1);
  assert.equal(view.title(), "Recommended Skills");
  assertNoDomNode(view.more(), "a lone notice has no +N More");
});

test("two pending sign-ins are one notice with +1 More, and choosing the other shows it", async () => {
  const view = await mount(client({ listSkills: async () => ({ skills: [] }) }), {
    signIns: [
      { runnerId: "runner-1", login: login() },
      { runnerId: "runner-2", login: login({ operationId: "op-2", provider: "claude", userCode: "ABCD-9876" }) },
    ],
  });
  assert.equal(view.notices().length, 1);
  assert.equal(view.more()?.textContent, "+1 More");
  const first = view.title();
  await act(async () => { view.more()!.click(); });
  const [other] = view.menuItems();
  assert.ok(other && other !== first);
  await act(async () => {
    (domWindow.document.body as unknown as HTMLElement).querySelector<HTMLElement>('[role="menuitem"]')!.click();
  });
  assert.equal(view.title(), other);
});

const chooseFromMore = async (view: Awaited<ReturnType<typeof mount>>, title: string) => {
  await act(async () => { view.more()!.click(); });
  const item = [...(domWindow.document.body as unknown as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === title);
  assert.ok(item, `"${title}" is in +N More`);
  await act(async () => { item.click(); });
};

test("a code typed for one sign-in never carries to another shown in its place", async () => {
  const submitted: unknown[] = [];
  const view = await mount(client({
    listSkills: async () => ({ skills: [] }),
    submitProviderLoginCode: async (runnerId: string, operationId: string, code: string) => {
      submitted.push([runnerId, operationId, code]);
    },
  }), {
    signIns: [
      { runnerId: "runner-1", login: login({ status: "awaiting_code", userCode: undefined, expectsCode: true }) },
      { runnerId: "runner-2", login: login({ operationId: "op-2", status: "awaiting_code", userCode: undefined, expectsCode: true }) },
    ],
  });
  const first = view.title()!;
  await act(async () => {
    fireDomEvent.change(view.container.querySelector<HTMLInputElement>("form input")!, { target: { value: "secret-for-first" } } as never);
  });
  const other = first === "Sign In to Codex on Build Box" ? "Sign In to Codex on Studio Mac" : "Sign In to Codex on Build Box";
  await chooseFromMore(view, other);
  assert.equal(view.title(), other);
  assert.equal(view.container.querySelector<HTMLInputElement>("form input")!.value, "", "the other sign-in starts empty");
  assert.equal(view.button("Submit Code")!.disabled, true);
  assert.deepEqual(submitted, []);
});

test("a sign-in's request in flight still holds its buttons after another notice was shown in between", async () => {
  let finishSubmit: () => void = () => {};
  const calls: string[] = [];
  const view = await mount(client({
    submitProviderLoginCode: () => {
      calls.push("submit");
      return new Promise<void>((resolve) => { finishSubmit = resolve; });
    },
    cancelProviderLogin: async () => { calls.push("cancel"); },
  }), { signIns: [{ runnerId: "runner-1", login: login({ status: "awaiting_code", userCode: undefined, expectsCode: true }) }] });
  await act(async () => {
    fireDomEvent.change(view.container.querySelector<HTMLInputElement>("form input")!, { target: { value: "auth-response" } } as never);
  });
  await act(async () => { view.button("Submit Code")!.click(); });
  assert.equal(view.button("Cancel Sign-In")!.disabled, true, "Cancel waits for the submission");

  await chooseFromMore(view, "Recommended Skills");
  assert.equal(view.title(), "Recommended Skills");
  await chooseFromMore(view, "Sign In to Codex on Build Box");
  assert.equal(view.button("Submit Code")!.getAttribute("aria-busy"), "true", "the submission still shows as running");
  const cancel = view.button("Cancel Sign-In")!;
  assert.equal(cancel.disabled, true, "Cancel still waits for the submission");
  await act(async () => { cancel.click(); });
  assert.deepEqual(calls, ["submit"]);

  await act(async () => { finishSubmit(); });
  await act(settle);
  assert.equal(view.button("Cancel Sign-In")!.disabled, false);
});

test("the sign-in notice shows the device code inline, Open Sign-In Page and Cancel Sign-In", async () => {
  let finishCancel: () => void = () => {};
  const cancels: unknown[] = [];
  const view = await mount(client({
    listSkills: async () => ({ skills: [] }),
    cancelProviderLogin: (runnerId: string, operationId: string) => {
      cancels.push([runnerId, operationId]);
      return new Promise<void>((resolve) => { finishCancel = resolve; });
    },
  }), { signIns: [{ runnerId: "runner-1", login: login() }] });
  const notice = view.notices()[0]!;
  assert.equal(notice.querySelector(".notice-body .code-well > code")?.textContent, "WXYZ-1234",
    "the device code is in a code well after the sentence");
  assert.ok(notice.querySelector('button[aria-label="Copy Device Code"]'));
  const open = [...notice.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.includes("Open Sign-In Page"));
  assert.ok(open, "Open Sign-In Page is an action");
  assert.equal(open.getAttribute("href"), "https://auth.example.com/device");
  assert.equal(open.getAttribute("target"), "_blank");
  assert.equal(open.getAttribute("rel"), "noreferrer");
  const actions = [...notice.querySelectorAll(".notice-actions > *")].map((element) => element.textContent?.trim());
  assert.deepEqual(actions.filter((label) => label !== ""), ["Open Sign-In Page", "Cancel Sign-In"],
    "the resolving action first");

  const cancel = view.button("Cancel Sign-In")!;
  await act(async () => { cancel.click(); });
  assert.deepEqual(cancels, [["runner-1", "op-1"]]);
  assert.equal(cancel.getAttribute("aria-busy"), "true", "Cancel Sign-In shows it is running");
  await act(async () => { cancel.click(); });
  assert.equal(cancels.length, 1, "a busy Cancel Sign-In does not run twice");
  await act(async () => { finishCancel(); });
  await act(settle);
  assert.equal(cancel.getAttribute("aria-busy"), null);
});

test("a sign-in that expects a code shows the labeled field and Submit Code, busy while it submits", async () => {
  let finishSubmit: () => void = () => {};
  const submitted: unknown[] = [];
  const view = await mount(client({
    listSkills: async () => ({ skills: [] }),
    submitProviderLoginCode: (runnerId: string, operationId: string, code: string) => {
      submitted.push([runnerId, operationId, code]);
      return new Promise<void>((resolve) => { finishSubmit = resolve; });
    },
  }), { signIns: [{ runnerId: "runner-1", login: login({ status: "awaiting_code", userCode: undefined, expectsCode: true }) }] });
  const notice = view.notices()[0]!;
  assert.equal(view.title(), "Sign In to Codex on Build Box");
  const field = notice.querySelector<HTMLInputElement>("form input")!;
  assert.equal(field.type, "password");
  assert.equal(field.getAttribute("autocomplete"), "off");
  const label = notice.querySelector<HTMLLabelElement>("form label")!;
  assert.equal(label.textContent, "Authorization Code");
  assert.equal(label.htmlFor, field.id, "the field is labeled");
  const submit = view.button("Submit Code")!;
  assert.equal(submit.disabled, true, "nothing to submit yet");

  await act(async () => { fireDomEvent.change(field, { target: { value: "auth-response" } } as never); });
  assert.equal(submit.disabled, false);
  await act(async () => { submit.click(); });
  assert.deepEqual(submitted, [["runner-1", "op-1", "auth-response"]]);
  assert.equal(submit.getAttribute("aria-busy"), "true");
  assert.ok(submit.querySelector(".spinner, [class*=spinner], svg"), "a spinner shows while it submits");
  await act(async () => { finishSubmit(); });
  await act(settle);
  assert.equal(submit.getAttribute("aria-busy"), null);
  assert.equal(field.value, "", "the code is never kept");
});

test("a failed sign-in is a danger notice with its reason and Dismiss", async () => {
  const dismissed: unknown[] = [];
  const view = await mount(client({
    listSkills: async () => ({ skills: [] }),
    dismissProviderLoginNotice: async (runnerId: string, operationId: string) => { dismissed.push([runnerId, operationId]); },
  }), { signIns: [{ runnerId: "runner-1", login: login({ status: "failed", error: "The provider refused the sign-in." }) }] });
  const notice = view.notices()[0]!;
  assert.ok(notice.classList.contains("t-danger"));
  assert.equal(view.title(), "Sign-In to Codex on Build Box Failed");
  assert.match(notice.textContent ?? "", /The provider refused the sign-in\./);
  assertNoDomNode(notice.querySelector(".code-well"), "no code for a sign-in that has ended");
  await act(async () => { view.button("Dismiss")!.click(); });
  await act(settle);
  assert.deepEqual(dismissed, [["runner-1", "op-1"]]);
});

test("Recommended Skills has Dismiss beside each skill and Dismiss All as its one action, disabled while a dismissal runs", async () => {
  const pending: Array<() => void> = [];
  const view = await mount(client({
    setSkillRecommendationDismissed: () => new Promise<void>((resolve) => { pending.push(resolve); }),
  }), {});
  const notice = view.notices()[0]!;
  assert.equal(view.title(), "Recommended Skills");
  assertNoDomNode(notice.querySelector(".notice-dismiss"), "Dismiss All is the notice's only way out");
  const items = [...notice.querySelectorAll(".skill-recommendations-list > li")];
  assert.deepEqual(items.map((item) => item.querySelector("a")?.textContent), ["orchestrate-issues", "using-wollipog"]);
  assert.deepEqual(items.map((item) => item.querySelector("button")?.getAttribute("aria-label")),
    ["Dismiss orchestrate-issues", "Dismiss using-wollipog"]);
  const all = view.button("Dismiss All")!;
  assert.ok(all.parentElement?.classList.contains("skill-recommendations-row"), "Dismiss All shares the skills' row");
  await act(async () => { all.click(); });
  assert.ok([...notice.querySelectorAll("button")].filter((button) => !button.matches('[aria-label^="Copy"]'))
    .every((button) => button.disabled), "every button waits for the request");
  await act(async () => { for (const resolve of pending) resolve(); });
  await act(settle);
  assert.equal(view.notices().length, 0);
});

test("while reconnecting the slot is hidden, and its notices return with the connection", async () => {
  const view = await mount(client(), { signIns: [{ runnerId: "runner-1", login: login() }], hidden: true });
  assert.equal(view.notices().length, 0);
  await view.render({ signIns: [{ runnerId: "runner-1", login: login() }] });
  assert.equal(view.title(), "Sign In to Codex on Build Box");
  assert.equal(view.more()?.textContent, "+1 More", "the skills loaded while hidden");
});
