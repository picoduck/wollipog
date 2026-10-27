import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderLoginView } from "@wollipog/protocol";
import { HIDE_ACCOUNT_EMAILS_STORAGE_KEY } from "../account-email-privacy.js";
import { ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ProviderLoginCard, ProviderSignIn, providerSignInAlreadyOnMachine } from "./ProviderLoginCard.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const login: ProviderLoginView = {
  operationId: "login_12345678-1234-4123-8123-123456789abc",
  accountId: "work",
  label: "Work Claude",
  provider: "claude",
  status: "awaiting_code",
  verificationUrl: "https://claude.ai/oauth/authorize",
  expectsCode: true,
  startedAt: 1,
};

const device: ProviderLoginView = {
  ...login,
  label: "Work Codex",
  provider: "codex",
  status: "waiting_for_provider",
  verificationUrl: "https://auth.openai.com/codex/device",
  expectsCode: false,
  userCode: "ABCD-EFGH",
};

/** The runner's message when a new account turns out to be one already on the Machine (provider-login.ts). */
const DUPLICATE = "This Claude account is already on this Machine. The duplicate sign-in was discarded.";

async function mount(element: React.ReactElement, client: Partial<ApiClient> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settle = () => act(async () => { for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { root.render(<ApiProvider client={client as ApiClient}>{element}</ApiProvider>); });
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent?.trim());
  const button = (name: string) => {
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name);
    assert.ok(match, `expected ${name}`);
    return match;
  };
  return {
    container, settle, buttons, button,
    steps: () => [...container.querySelectorAll<HTMLElement>("ol.steps > li")],
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("an authorization-code sign-in is two steps: Open Claude Sign-In in a new tab, then the code field and Submit Code", async () => {
  const submitted: string[] = [];
  const view = await mount(<ProviderSignIn runnerId="runner-1" login={login} />, {
    submitProviderLoginCode: async (_runnerId: string, _operationId: string, code: string) => {
      submitted.push(code);
      return { login: { ...login, status: "waiting_for_provider" as const, expectsCode: false } };
    },
  });
  try {
    const [open, paste] = view.steps();
    assert.equal(view.steps().length, 2);
    const link = open!.querySelector<HTMLAnchorElement>("a.btn.sm")!;
    assert.equal(link.textContent, "Open Claude Sign-In");
    assert.ok(link.querySelector("svg"), "an external-link icon");
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noreferrer");
    assert.equal(link.href, "https://claude.ai/oauth/authorize");
    const input = paste!.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.type, "password", "the code is never shown");
    assert.equal(paste!.querySelector(`label[for="${input.id}"]`)?.textContent, "Paste the Code It Shows");
    const submit = view.button("Submit Code");
    assert.equal(submit.className, "btn", "Submit Code is a .btn, not a second primary");
    assert.equal(submit.disabled, true, "nothing to submit yet");
    await act(async () => fireDomEvent.change(input, { target: { value: "transient-response" } }));
    assert.equal(submit.disabled, false);
    assert.doesNotMatch(view.container.innerHTML, /transient-response/, "a typed code is not mirrored into a value attribute");
    await act(async () => fireDomEvent.submit(paste!.querySelector("form")!));
    await view.settle();
    assert.deepEqual(submitted, ["transient-response"]);
    assert.equal(input.value, "");
    assert.doesNotMatch(view.container.innerHTML, /transient-response/, "the code is never echoed");
  } finally {
    await view.unmount();
  }
});

test("a rejected code is a field error under the field, with the field invalid and focused", async () => {
  const view = await mount(<ProviderSignIn runnerId="runner-1" login={login} />, {
    submitProviderLoginCode: async () => { throw new ApiError("The provider rejected this code. Paste the code the page shows.", 409); },
  });
  try {
    const input = view.container.querySelector<HTMLInputElement>("input")!;
    await act(async () => fireDomEvent.change(input, { target: { value: "wrong-code" } }));
    await act(async () => fireDomEvent.submit(view.container.querySelector("form")!));
    await view.settle();
    const error = view.container.querySelector<HTMLElement>(".field-error")!;
    assert.equal(error.textContent, "The provider rejected this code. Paste the code the page shows.");
    assert.equal(error.getAttribute("role"), null, "§8.5: focus announces it, not an alert");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(input.getAttribute("aria-describedby"), error.id);
    assert.equal(document.activeElement, input);
    assert.ok(input.compareDocumentPosition(error) & 4, "the error follows the field");
    assert.doesNotMatch(view.container.innerHTML, /wrong-code/);
    await act(async () => fireDomEvent.change(input, { target: { value: "wrong-code2" } }));
    assertNoDomNode(view.container.querySelector(".field-error"), "typing clears the error");
  } finally {
    await view.unmount();
  }
});

test("the embedded sign-in's code field never puts the code in the DOM: typed, rejected, failed or submitted (#3529)", async () => {
  const submitted: string[] = [];
  const replies: Array<() => never | undefined> = [
    () => { throw new ApiError("The provider rejected this code. Paste the code the page shows.", 409); },
    () => { throw new TypeError("Failed to fetch"); },
    () => undefined,
  ];
  const view = await mount(<ProviderLoginCard runnerId="runner-1" login={login} embedded />, {
    submitProviderLoginCode: async (_runnerId: string, _operationId: string, code: string) => {
      submitted.push(code);
      replies.shift()!();
      return { login };
    },
  });
  try {
    const card = view.container.querySelector<HTMLElement>("article.provider-login-card")!;
    assert.equal(card.dataset.embedded, "true");
    const input = card.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.type, "password");
    const submit = view.button("Submit Code");
    assert.equal(submit.disabled, true, "nothing to submit yet");
    await act(async () => fireDomEvent.change(input, { target: { value: "   " } }));
    assert.equal(submit.disabled, true, "a whitespace-only field has nothing to submit");
    await act(async () => fireDomEvent.change(input, { target: { value: "embedded-secret" } }));
    assert.equal(submit.disabled, false);
    assert.equal(input.getAttribute("value"), null, "the code is not a value attribute");
    assert.doesNotMatch(view.container.innerHTML, /embedded-secret/, "a typed code is not in the DOM");

    await act(async () => fireDomEvent.submit(card.querySelector("form")!));
    await view.settle();
    assert.equal(card.querySelector(".form-error")?.textContent, "The provider rejected this code. Paste the code the page shows.");
    assert.equal(input.value, "embedded-secret", "a rejected code stays in the field to correct");
    assert.doesNotMatch(view.container.innerHTML, /embedded-secret/, "a rejected code is not in the DOM");

    await act(async () => fireDomEvent.submit(card.querySelector("form")!));
    await view.settle();
    assert.equal(card.querySelector(".form-error")?.textContent, "Failed to fetch");
    assert.doesNotMatch(view.container.innerHTML, /embedded-secret/, "a code whose request failed is not in the DOM");

    await act(async () => fireDomEvent.submit(card.querySelector("form")!));
    await view.settle();
    assert.deepEqual(submitted, ["embedded-secret", "embedded-secret", "embedded-secret"]);
    assert.equal(input.value, "", "a submitted code is cleared");
    assert.equal(submit.disabled, true, "nothing to submit after it");
    assert.doesNotMatch(view.container.innerHTML, /embedded-secret/);
  } finally {
    await view.unmount();
  }
});

test("a device-code sign-in shows the code with its copy button and the waiting line, with nothing to paste", async () => {
  const view = await mount(<ProviderSignIn runnerId="runner-1" login={device} />);
  try {
    const [open, enter] = view.steps();
    assert.equal(open!.querySelector("a")?.textContent, "Open Codex Sign-In");
    assert.equal(enter!.querySelector(".signin-code code")?.textContent, "ABCD-EFGH");
    assert.ok(enter!.querySelector('button[aria-label="Copy Device Code"].icon-btn'));
    assert.equal(enter!.querySelector(".signin-waiting")?.textContent, "Waiting for Codex to confirm…");
    assert.ok(enter!.querySelector(".signin-waiting .spinner"));
    assertNoDomNode(view.container.querySelector("input"));
  } finally {
    await view.unmount();
  }
});

test("a failed sign-in is one danger notice with its reason in one sentence, Try Again and Dismiss", async () => {
  const calls: string[] = [];
  const view = await mount(
    <ProviderSignIn runnerId="runner-1" login={{ ...login, status: "failed", expectsCode: false,
      error: "The provider did not confirm authentication. Check the account and try again." }} restart={{ accountId: "work" }} />,
    {
      startProviderLogin: async (_runnerId: string, body: unknown) => { calls.push(`start:${JSON.stringify(body)}`); return { login }; },
      dismissProviderLoginNotice: async (_runnerId: string, operationId: string) => { calls.push(`dismiss:${operationId}`); return { dismissed: true }; },
    } as unknown as Partial<ApiClient>,
  );
  try {
    assertNoDomNode(view.container.querySelector("ol.steps"), "the ending replaces the steps");
    const notice = view.container.querySelector<HTMLElement>(".notice")!;
    assert.match(notice.className, /\bt-danger\b.*\bcompact\b/);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Sign-In Failed");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "The provider did not confirm authentication.");
    assert.deepEqual(view.buttons(), ["Try Again", "Dismiss"]);
    await act(async () => { view.button("Try Again").click(); });
    await view.settle();
    assert.deepEqual(calls, ['start:{"accountId":"work"}', `dismiss:${login.operationId}`],
      "the new sign-in starts, then this ending is dismissed so it does not come back when that one settles");
  } finally {
    await view.unmount();
  }
});

test("a timed-out sign-in is a neutral notice with Start Again and Dismiss; Dismiss is the durable dismissal", async () => {
  const calls: string[] = [];
  const view = await mount(
    <ProviderSignIn runnerId="runner-1" login={{ ...login, status: "timed_out", expectsCode: false,
      error: "Sign-in timed out before the provider confirmed authentication." }} restart={{ provider: "claude", label: "Work Claude" }} />,
    {
      dismissProviderLoginNotice: async (_runnerId: string, operationId: string) => { calls.push(`dismiss:${operationId}`); return { dismissed: true }; },
    } as unknown as Partial<ApiClient>,
  );
  try {
    const notice = view.container.querySelector<HTMLElement>(".notice")!;
    assert.match(notice.className, /\bt-neutral\b/);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Sign-In Timed Out");
    assert.deepEqual(view.buttons(), ["Start Again", "Dismiss"]);
    await act(async () => { view.button("Dismiss").click(); });
    await view.settle();
    assert.deepEqual(calls, [`dismiss:${login.operationId}`]);
  } finally {
    await view.unmount();
  }
});

test("a sign-in that found its account already on the Machine says so with Dismiss only", async () => {
  const view = await mount(
    <ProviderSignIn runnerId="runner-1" login={{ ...login, status: "failed", expectsCode: false, error: DUPLICATE }}
      restart={{ provider: "claude", label: "Work Claude" }} />,
  );
  try {
    const notice = view.container.querySelector<HTMLElement>(".notice")!;
    assert.match(notice.className, /\bt-neutral\b/);
    assert.ok(notice.querySelector(".notice-icon svg"), "the info icon");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Already on This Machine");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "This Claude account is already on this machine, so Wollipog discarded the duplicate sign-in.");
    assert.deepEqual(view.buttons(), ["Dismiss"], "trying again would reach the same account");
  } finally {
    await view.unmount();
  }
});

test("the duplicate-account ending is recognized by the runner's message, for either provider and nothing else", () => {
  assert.equal(providerSignInAlreadyOnMachine({ status: "failed", error: DUPLICATE }), true);
  assert.equal(providerSignInAlreadyOnMachine({ status: "failed",
    error: "This Codex account is already on this Machine. The duplicate sign-in was discarded." }), true);
  assert.equal(providerSignInAlreadyOnMachine({ status: "timed_out", error: DUPLICATE }), false);
  assert.equal(providerSignInAlreadyOnMachine({ status: "failed", error: "The provider did not confirm authentication." }), false);
  assert.equal(providerSignInAlreadyOnMachine({ status: "failed",
    error: "A Claude account with this label is already on this Machine. Use Sign In on that account to refresh its login." }), false,
    "a label clash refuses the start; it is not this ending");
  assert.equal(providerSignInAlreadyOnMachine({ status: "failed" }), false);
});

test("a session's sign-in has no Dismiss, and without a restart there is no Try Again", async () => {
  const view = await mount(<ProviderSignIn runnerId="runner-1" login={{ ...login, status: "failed", expectsCode: false, sessionId: "s" }} />);
  try {
    assert.equal(view.container.querySelector(".notice-body")?.textContent, "The sign-in didn't finish.");
    assert.deepEqual(view.buttons(), []);
  } finally {
    await view.unmount();
  }
});

test("Choose Another Account's sign-in has a plain head with the Signing In badge and Cancel over the same steps", async () => {
  const cancelled: string[] = [];
  const view = await mount(<ProviderLoginCard runnerId="runner-1" login={device} />, {
    cancelProviderLogin: async (_runnerId: string, operationId: string) => { cancelled.push(operationId); return { login: device }; },
  });
  try {
    const card = view.container.querySelector<HTMLElement>("article.signin-card")!;
    assert.equal(card.getAttribute("aria-label"), "Work Codex Provider Sign-In");
    assert.equal(card.querySelector(".signin-head-title")?.textContent, "Work Codex");
    assert.equal(card.querySelector(".signin-head-sub")?.textContent, "Codex");
    assert.equal(card.querySelector(".signin-head .status")?.textContent, "Signing In");
    assertNoDomNode(card.querySelector('[aria-haspopup="menu"]'), "no ⋯ here");
    assert.equal(view.steps().length, 2);
    const cancel = view.button("Cancel");
    assert.match(cancel.className, /\bbtn sm ghost\b/);
    await act(async () => { cancel.click(); });
    await view.settle();
    assert.deepEqual(cancelled, [device.operationId]);
    assertNoDomNode(view.container.querySelector(".provider-login-card"), "the old card and its status colours are gone");
  } finally {
    await view.unmount();
  }
});

test("with a hidden email label, the head reads Signing In to Codex and Email hidden", async () => {
  window.localStorage.setItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY, "true");
  const view = await mount(<ProviderLoginCard runnerId="runner-1" login={{ ...device, label: "morgan@example.com" }} />);
  try {
    assert.equal(view.container.querySelector(".signin-head-title")?.textContent, "Signing In to Codex");
    assert.equal(view.container.querySelector(".signin-head-sub")?.textContent, "Email hidden");
    assert.doesNotMatch(view.container.innerHTML, /morgan@example\.com/);
  } finally {
    await view.unmount();
    window.localStorage.removeItem(HIDE_ACCOUNT_EMAILS_STORAGE_KEY);
  }
});
