import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { AddBoxRequest } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { RequestTimeoutError, TransportRequestError } from "../api-transport.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { AddBoxDialog, sshPortError, sshTargetError } from "./AddBoxDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
/** A mouse by default; a test sets it false for a touch screen. */
let finePointer = true;
Object.defineProperty(domWindow, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: query === "(pointer: fine)" ? finePointer : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
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
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 0)); });
};

const HOSTS = [
  { host: "golf-sim", hostName: "100.64.0.10", user: "misko", port: 2222 },
  { host: "build-box", hostName: "build.internal", user: "builder" },
];

async function mount(addBox: (body: AddBoxRequest) => Promise<unknown> = async () => ({ box: {} })) {
  const requests: AddBoxRequest[] = [];
  let closed = 0;
  const client = {
    ...api,
    sshConfigHosts: async () => ({ hosts: HOSTS }),
    addBox: async (body: AddBoxRequest) => { requests.push(body); return addBox(body); },
  } as ApiClient;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ApiProvider client={client}><AddBoxDialog onClose={() => { closed += 1; }} /></ApiProvider>,
  ));
  await settle();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  return {
    dialog,
    requests,
    closed: () => closed,
    footer: () => dialog.querySelector<HTMLElement>(".modal-foot")!,
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

const field = (dialog: HTMLElement, label: string) => {
  const found = [...dialog.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  assert.ok(found, `a field labelled ${label}`);
  return document.getElementById(found.htmlFor) as HTMLInputElement;
};
const button = (scope: ParentNode, name: string) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent?.trim()) === name);
  assert.ok(found, `a button named ${name}`);
  return found;
};
const describedBy = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
  .map((id) => document.getElementById(id)?.textContent ?? `missing #${id}`);

/** Type into a controlled field the way happy-dom lets React see it. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}
const blur = (input: HTMLInputElement) => act(async () => { input.blur(); });
const connect = async (dialog: HTMLElement) => {
  await act(async () => button(dialog, "Connect Machine").click());
  await settle();
};

test("validation copy: an SSH target is required and plain, and the port is 1 to 65535 or empty for 22", () => {
  assert.equal(sshTargetError(""), "Enter an SSH target, such as user@host.");
  assert.equal(sshTargetError("   "), "Enter an SSH target, such as user@host.");
  assert.equal(sshTargetError("-oProxyCommand=x"), "Use an SSH target such as user@host, with no spaces or leading dash.");
  assert.equal(sshTargetError("me@my host"), "Use an SSH target such as user@host, with no spaces or leading dash.");
  assert.equal(sshTargetError(" me@devbox "), null);
  for (const bad of ["0", "70000", "22.5", "abc", "-1", "1e3"]) assert.equal(sshPortError(bad), "Use 1 to 65535.", bad);
  for (const good of ["", "1", "22", " 2222 ", "65535"]) assert.equal(sshPortError(good), null, good);
});

test("Connect via SSH asks for the SSH target first, with the requirements folded and focus on the target for a mouse", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    assert.equal(dialog.querySelector("h2")?.textContent, "Connect via SSH");
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "Wollipog installs and starts a runner on the machine over SSH.");
    const labels = [...dialog.querySelectorAll(".modal-body .field > .field-head > label, .modal-body .field > span:first-child")]
      .map((label) => label.textContent);
    assert.deepEqual(labels, ["SSH Target", "Choose from SSH Config", "Machine Name (Optional)", "Workspace Folder (Optional)", "Port"]);
    const target = field(dialog, "SSH Target");
    assert.equal(target.placeholder, "user@host");
    assert.ok(document.activeElement === target, "a fine pointer opens with focus on SSH Target");

    const needs = dialog.querySelector<HTMLDetailsElement>("details.disclosure")!;
    assert.ok(needs, "the requirements are a disclosure");
    assert.equal(needs.open, false, "closed on open");
    assert.equal(needs.querySelector("summary")?.textContent, "What This Needs");
    assert.deepEqual([...needs.querySelectorAll("li")].map((item) => item.textContent), [
      "You can already ssh to the machine without a password.",
      "ssh and scp are on this computer.",
      "The machine runs Linux or macOS.",
    ]);
    const port = field(dialog, "Port");
    assert.ok(port.classList.contains("w-xs"), "Port is the 96px number field");
    assert.equal(port.value, "22");
    assert.doesNotMatch(dialog.textContent ?? "", /dashboard/i, "no copy says dashboard");
    assertNoDomNode(dialog.querySelector("select"), "the SSH config choice is the shared Select, not a native select");
    assert.equal(button(dialog, "Connect Machine").disabled, false, "Connect Machine stays enabled while the form is incomplete");
  } finally {
    await view.unmount();
  }
});

test("with touch, no field is focused on open", async () => {
  finePointer = false;
  const view = await mount();
  try {
    assert.ok(!view.dialog.contains(document.activeElement) || !(document.activeElement instanceof domWindow.HTMLInputElement),
      "no field takes focus, so the software keyboard stays down");
    assert.ok(document.activeElement !== field(view.dialog, "SSH Target"));
  } finally {
    finePointer = true;
    await view.unmount();
  }
});

test("70000 in Port is its field error on blur, and nothing is written into the footer", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    const port = field(dialog, "Port");
    await type(port, "70000");
    assertNoDomNode(dialog.querySelector(".field-error"), "no error while typing");
    await blur(port);
    assert.equal(port.getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedBy(port), ["Use 1 to 65535."]);
    const error = dialog.querySelector(".field-error")!;
    assert.ok(error.closest(".field") === port.closest(".field"), "the error is under Port");
    assert.ok(error.getAttribute("role") === null, "a field error is not an alert");
    const footer = view.footer();
    assert.deepEqual([...footer.querySelectorAll("button")].map((item) => item.textContent?.trim()), ["Cancel", "Connect Machine"]);
    assert.doesNotMatch(footer.textContent ?? "", /65535/);
    assertNoDomNode(footer.querySelector(".form-error, [role=alert]"), "the footer holds no error");

    await type(port, "2222");
    assert.equal(port.getAttribute("aria-invalid"), null, "the error clears as a valid value is typed");
    assertNoDomNode(dialog.querySelector(".field-error"), "no error once the port is valid");
  } finally {
    await view.unmount();
  }
});

test("submitting with an empty SSH target shows its error and moves focus there", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    await type(field(dialog, "Machine Name (Optional)"), "Studio Mac");
    await connect(dialog);
    const target = field(dialog, "SSH Target");
    assert.equal(view.requests.length, 0, "nothing is sent");
    assert.equal(target.getAttribute("aria-invalid"), "true");
    assert.deepEqual(describedBy(target), ["Enter an SSH target, such as user@host."]);
    assert.ok(document.activeElement === target, "focus moves to the first invalid field");

    await type(target, "me@devbox");
    assert.equal(target.getAttribute("aria-invalid"), null);
  } finally {
    await view.unmount();
  }
});

test("an invalid port on submit takes focus when the target is fine", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    await type(field(dialog, "SSH Target"), "me@devbox");
    await type(field(dialog, "Port"), "0");
    await connect(dialog);
    assert.equal(view.requests.length, 0);
    assert.ok(document.activeElement === field(dialog, "Port"));
    assert.deepEqual(describedBy(field(dialog, "Port")), ["Use 1 to 65535."]);
  } finally {
    await view.unmount();
  }
});

test("choosing a host from SSH config fills SSH Target, Port and an unedited Machine Name", async () => {
  const view = await mount();
  try {
    const { dialog } = view;
    const choose = async (host: string) => {
      await act(async () => [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.getAttribute("aria-label")?.startsWith("Choose from SSH Config:"))!.click());
      const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((item) => item.textContent?.startsWith(host));
      assert.ok(option, `the list offers ${host}`);
      assert.ok(option.textContent?.includes(host === "golf-sim" ? "misko@100.64.0.10:2222" : "builder@build.internal"),
        "each host shows where it goes");
      await act(async () => option.click());
    };
    await choose("golf-sim");
    assert.equal(field(dialog, "SSH Target").value, "golf-sim");
    assert.equal(field(dialog, "Port").value, "2222");
    assert.equal(field(dialog, "Machine Name (Optional)").value, "golf-sim");
    await type(field(dialog, "Machine Name (Optional)"), "Golf Simulator");
    await choose("build-box");
    assert.equal(field(dialog, "SSH Target").value, "build-box");
    assert.equal(field(dialog, "Port").value, "22", "a host without a Port goes back to 22");
    assert.equal(field(dialog, "Machine Name (Optional)").value, "Golf Simulator", "an edited name is kept");

    await connect(dialog);
    assert.deepEqual(view.requests, [{ displayName: "Golf Simulator", sshTarget: "build-box", workspacePath: undefined, sshPort: 22 }]);
    assert.equal(view.closed(), 1, "the dialog closes once the request is accepted");
  } finally {
    await view.unmount();
  }
});

test("a request failure is never an SSH diagnosis: no SSH runs before the control plane answers", async () => {
  const cases: Array<[Error, string]> = [
    [new TransportRequestError("The remote instance request failed."), "Wollipog couldn't be reached. Check the connection, then try again."],
    [new TypeError("Failed to fetch"), "Wollipog couldn't be reached. Check the connection, then try again."],
    [new RequestTimeoutError(45_000), "Wollipog didn't answer in time. Check the machine list before trying again."],
    [new ApiError("displayName must be 120 characters or fewer and contain no control characters", 400),
      "Use a machine name of 120 characters or fewer, with no control characters."],
    [new ApiError("forbidden", 403), "Wollipog refused the request. Check that you're signed in and allowed to connect machines."],
    [new ApiError("ssh me@devbox: Permission denied (publickey,password).", 500), "Wollipog couldn't start connecting to me@devbox. Try again."],
  ];
  for (const [cause, sentence] of cases) {
    const view = await mount(async () => { throw cause; });
    try {
      await type(field(view.dialog, "SSH Target"), "me@devbox");
      await connect(view.dialog);
      assert.equal(view.dialog.querySelector(".notice-body")?.textContent, sentence, cause.message);
      assert.doesNotMatch(sentence, /over SSH|SSH key/);
    } finally {
      await view.unmount();
    }
  }
});

test("a rejected request is one danger notice above the footer, its raw text behind Show Details", async () => {
  const raw = "SQLITE_BUSY: database is locked";
  const view = await mount(async () => { throw new ApiError(raw, 500); });
  try {
    const { dialog } = view;
    await type(field(dialog, "SSH Target"), "me@devbox");
    await connect(dialog);
    assert.equal(view.closed(), 0, "the dialog stays open");
    const notices = dialog.querySelectorAll(".notice");
    assert.equal(notices.length, 1, "one notice");
    const notice = notices[0] as HTMLElement;
    assert.ok(notice.classList.contains("t-danger"));
    assert.equal(notice.getAttribute("role"), "alert");
    assert.ok(notice.closest(".modal-body") !== null, "inside the body, above the footer");
    assert.ok(notice.parentElement?.lastElementChild === notice, "at the body's end");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Connect the Machine");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "Wollipog couldn't start connecting to me@devbox. Try again.");
    assert.doesNotMatch(notice.textContent ?? "", /SQLITE/, "the raw text is hidden until asked for");
    await act(async () => button(notice, "Show Details").click());
    assert.equal(notice.querySelector(".notice-details-body code")?.textContent, raw);

    const footer = view.footer();
    assert.deepEqual([...footer.querySelectorAll("button")].map((item) => item.textContent?.trim()), ["Cancel", "Connect Machine"]);
    assert.equal(footer.textContent?.replace(/\s+/g, ""), "CancelConnectMachine", "the footer holds only its two buttons");
  } finally {
    await view.unmount();
  }
});

test("Connect Machine shows a spinner while the request runs and keeps its label", async () => {
  let release: () => void = () => undefined;
  const view = await mount(() => new Promise((resolve) => { release = () => resolve({ box: {} }); }));
  try {
    const { dialog } = view;
    await type(field(dialog, "SSH Target"), "me@devbox");
    await connect(dialog);
    const primary = button(dialog, "Connect Machine");
    assert.equal(primary.getAttribute("aria-busy"), "true");
    assert.equal(primary.textContent?.trim(), "Connect Machine", "no Connecting… label swap");
    assert.ok(primary.querySelector(".spinner, [class*=spinner]"), "a spinner shows");
    assert.equal(button(dialog, "Cancel").disabled, true, "Cancel waits for the request");
    assert.equal(field(dialog, "SSH Target").readOnly, true);
    await act(async () => primary.click());
    assert.equal(view.requests.length, 1, "a busy press sends nothing more");
    await act(async () => release());
    await settle();
    assert.equal(view.closed(), 1);
  } finally {
    await view.unmount();
  }
});
