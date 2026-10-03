import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { AccountIdentifier, AccountIdentifierRevealButton, AccountLabel, useAccountIdentifierReveal } from "./AccountIdentifier.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { BehaviorPanel } from "./SettingsView.js";
import { FeedbackProvider, useFeedback } from "./FeedbackProvider.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { setHideAccountEmails, HIDE_ACCOUNT_EMAILS_STORAGE_KEY as KEY } from "../account-email-privacy.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const EMAIL = "person@example.com";

function Picker({ identity }: { identity: string }) {
  const [revealed, toggle] = useAccountIdentifierReveal(identity);
  return <section className="picker"><AccountIdentifierRevealButton label="Emails" revealed={revealed} onToggle={toggle} withText /><span>{revealed ? EMAIL : "Hidden Account"}</span></section>;
}
function OpenToast() {
  const { showToast } = useFeedback();
  return <button onClick={() => showToast("Moved to another account.", { durationMs: 0, messageContent: <>Moved to <AccountLabel value={EMAIL} />.</> })}>Toast</button>;
}
function Surfaces({ identity = "account-1" }: { identity?: string }) {
  return <FeedbackProvider><BehaviorPanel /><section className="accounts"><AccountIdentifier identity={identity} value={EMAIL} label="Account Email" /><AccountIdentifier value="Work" label="Account Email" /></section><Picker identity={identity} /><p className="user-content">User wrote {EMAIL}.</p><section className="person"><PersonalIdentifier value={EMAIL} label="Person Email" /></section><OpenToast /></FeedbackProvider>;
}
async function mount(identity = "account-1") {
  setHideAccountEmails(false);
  window.localStorage.removeItem(KEY);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Surfaces identity={identity} />));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
function button(container: HTMLElement, label: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === label);
  assert.ok(result, label);
  return result;
}
function privacySwitch(container: HTMLElement) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(b => b.textContent?.includes('Hide Account Emails'));
  assert.ok(result);
  return result;
}

test("Settings defaults off, persists, and updates open identifiers, pickers and retained notices immediately", async () => {
  const view = await mount();
  try {
    assert.equal(window.localStorage.getItem(KEY), null);
    assert.equal(privacySwitch(view.container).getAttribute("aria-checked"), "false");
    assert.ok(view.container.querySelector(".accounts")!.innerHTML.includes(EMAIL));
    assertNoDomNode(view.container.querySelector(".accounts button"));
    assertNoDomNode(view.container.querySelector(".picker button"));
    await act(async () => fireDomEvent.click(button(view.container, "Toast")));
    assert.ok(view.container.querySelector(".toast-message")!.textContent!.includes(EMAIL));
    await act(async () => fireDomEvent.click(privacySwitch(view.container)));
    assert.equal(window.localStorage.getItem(KEY), "true");
    for (const selector of [".accounts", ".picker", ".toast-message"]) {
      assert.equal(view.container.querySelector(selector)!.innerHTML.includes(EMAIL), false, selector);
    }
    assert.ok(view.container.querySelector(".accounts")!.textContent!.includes("Work"));
    assert.ok(view.container.querySelector(".user-content")!.textContent!.includes(EMAIL));
    assert.equal(view.container.querySelector(".person")!.innerHTML.includes(EMAIL), false);
    await act(async () => fireDomEvent.click(button(view.container, "Show Account Email")));
    await act(async () => fireDomEvent.click(button(view.container, "Show Emails")));
    assert.ok(view.container.querySelector(".accounts")!.textContent!.includes(EMAIL));
    await act(async () => { setHideAccountEmails(false); setHideAccountEmails(true); });
    assert.equal(view.container.querySelector(".accounts")!.innerHTML.includes(EMAIL), false);
    assert.equal(view.container.querySelector(".picker")!.innerHTML.includes(EMAIL), false);
    await act(async () => fireDomEvent.click(privacySwitch(view.container)));
    assert.equal(window.localStorage.getItem(KEY), "false");
    assert.ok(view.container.querySelector(".toast-message")!.textContent!.includes(EMAIL));
    assertNoDomNode(view.container.querySelector(".accounts button"));
  } finally { await view.close(); }
});

test("same-label account changes and reopening discard temporary reveals", async () => {
  const view = await mount();
  try {
    await act(async () => setHideAccountEmails(true));
    await act(async () => fireDomEvent.click(button(view.container, "Show Account Email")));
    await act(async () => fireDomEvent.click(button(view.container, "Show Emails")));
    await act(async () => view.root.render(<Surfaces identity="account-2" />));
    assert.equal(view.container.querySelector(".accounts")!.innerHTML.includes(EMAIL), false);
    assert.equal(view.container.querySelector(".picker")!.innerHTML.includes(EMAIL), false);
    await act(async () => fireDomEvent.click(button(view.container, "Show Account Email")));
    await act(async () => view.root.render(<></>));
    await act(async () => view.root.render(<Surfaces identity="account-2" />));
    assert.equal(view.container.querySelector(".accounts")!.innerHTML.includes(EMAIL), false);
    assert.equal(privacySwitch(view.container).getAttribute("aria-checked"), "true");
    const show = button(view.container, "Show Account Email");
    show.focus();
    await act(async () => fireDomEvent.click(show));
    assert.equal(document.activeElement, show);
    assert.equal(show.getAttribute("aria-label"), "Hide Account Email");
  } finally { await view.close(); setHideAccountEmails(false); window.localStorage.removeItem(KEY); }
});
