import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PersonalIdentifier, PersonalIdentifierRevealButton, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";

Object.defineProperty(globalThis, "React", { configurable: true, writable: true, value: React });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const EMAIL = "person@example.com";

async function mount(element: React.ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, root };
}

async function unmount({ container, root }: { container: HTMLDivElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

function toggle(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button.personal-identifier-toggle");
  assert.ok(button, "a reveal control must be rendered");
  return button;
}

test("a personal identifier is absent from text, tooltips, and accessible names until revealed", async () => {
  const mounted = await mount(<PersonalIdentifier value={EMAIL} label="Account Email" />);
  try {
    const { container } = mounted;
    assert.equal(container.innerHTML.includes(EMAIL), false);
    assert.match(container.textContent ?? "", /Hidden/);
    const button = toggle(container);
    assert.equal(button.type, "button");
    assert.equal(button.getAttribute("aria-label"), "Show Account Email");
    assert.equal(button.title, "Show Account Email");

    await act(async () => fireDomEvent.click(button));
    assert.equal(container.querySelector(".personal-identifier-value")?.textContent, EMAIL);
    assert.equal(toggle(container).getAttribute("aria-label"), "Hide Account Email");
    assert.equal(toggle(container).title, "Hide Account Email");

    await act(async () => fireDomEvent.click(toggle(container)));
    assert.equal(container.innerHTML.includes(EMAIL), false);
    assert.equal(toggle(container).getAttribute("aria-label"), "Show Account Email");
  } finally {
    await unmount(mounted);
  }
});

test("the reveal control is a focusable native button so keyboard users can reveal and hide", async () => {
  const mounted = await mount(<PersonalIdentifier value={EMAIL} label="Account Email" />);
  try {
    const button = toggle(mounted.container);
    button.focus();
    assert.equal(document.activeElement, button);
    // Enter and Space activate a native button as a click; focus stays on the control.
    await act(async () => fireDomEvent.click(button));
    assert.equal(document.activeElement, toggle(mounted.container));
    assert.equal(mounted.container.querySelector(".personal-identifier-value")?.textContent, EMAIL);
  } finally {
    await unmount(mounted);
  }
});

test("a changed value is hidden again and a remount never inherits an earlier reveal", async () => {
  const mounted = await mount(<PersonalIdentifier value={EMAIL} label="Account Email" />);
  try {
    await act(async () => fireDomEvent.click(toggle(mounted.container)));
    assert.ok(mounted.container.innerHTML.includes(EMAIL));
    await act(async () => mounted.root.render(<PersonalIdentifier value="other@example.com" label="Account Email" />));
    assert.equal(mounted.container.innerHTML.includes("other@example.com"), false);
    assert.equal(toggle(mounted.container).getAttribute("aria-label"), "Show Account Email");
  } finally {
    await unmount(mounted);
  }
  const again = await mount(<PersonalIdentifier value={EMAIL} label="Account Email" />);
  try {
    assert.equal(again.container.innerHTML.includes(EMAIL), false);
  } finally {
    await unmount(again);
  }
});

test("returning to an earlier value after a change does not restore its reveal", async () => {
  const mounted = await mount(<PersonalIdentifier value={EMAIL} label="Account Email" />);
  try {
    await act(async () => fireDomEvent.click(toggle(mounted.container)));
    assert.ok(mounted.container.innerHTML.includes(EMAIL));
    await act(async () => mounted.root.render(<PersonalIdentifier value="other@example.com" label="Account Email" />));
    await act(async () => mounted.root.render(<PersonalIdentifier value={EMAIL} label="Account Email" />));
    assert.equal(mounted.container.innerHTML.includes(EMAIL), false);
    assert.equal(toggle(mounted.container).getAttribute("aria-label"), "Show Account Email");
  } finally {
    await unmount(mounted);
  }
});

test("a picker-level reveal is bound to its exact list and hides when the list changes", async () => {
  function Picker({ labels }: { labels: string[] }) {
    const [revealed, toggleReveal] = usePersonalIdentifierReveal(labels.join("\n"));
    return (
      <div>
        <PersonalIdentifierRevealButton label="Account Emails" revealed={revealed} onToggle={toggleReveal} withText />
        <ul>{labels.map((label) => <li key={label}>{revealed ? label : "Hidden Account"}</li>)}</ul>
      </div>
    );
  }
  const mounted = await mount(<Picker labels={["a@example.com", "b@example.com"]} />);
  try {
    await act(async () => fireDomEvent.click(toggle(mounted.container)));
    assert.ok(mounted.container.innerHTML.includes("a@example.com"));
    await act(async () => mounted.root.render(<Picker labels={["c@example.com"]} />));
    assert.equal(mounted.container.innerHTML.includes("c@example.com"), false);
    assert.equal(toggle(mounted.container).textContent, "Show Account Emails");
  } finally {
    await unmount(mounted);
  }
});

test("aliases stay readable and provenance can force masking of any value", async () => {
  const alias = await mount(<PersonalIdentifier value="Work" label="Account Email" />);
  try {
    assert.equal(alias.container.textContent, "Work");
    assert.equal(alias.container.querySelector("button"), null);
  } finally {
    await unmount(alias);
  }
  const forced = await mount(<PersonalIdentifier value="opaque-provider-login" label="Account Email" sensitive />);
  try {
    assert.equal(forced.container.innerHTML.includes("opaque-provider-login"), false);
    assert.ok(forced.container.querySelector("button.personal-identifier-toggle"));
  } finally {
    await unmount(forced);
  }
});
