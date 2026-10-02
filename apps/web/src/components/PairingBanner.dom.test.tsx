import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken } from "../device-token.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { PairingBanner, type PairingBannerProps } from "./PairingBanner.js";

/**
 * The pairing banner speaks in the person's terms (#2303): no "control plane" in any of its copy,
 * the startup-link command behind Show Details (§12.5, §13.2), and the pairing field, Pair, Retry
 * Pairing and their error lines behave as they did inside App.tsx.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const CONTROL_PLANE = /control[\s-]*plane/iu;
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";

const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;

async function mount(props: PairingBannerProps) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const render = (next: PairingBannerProps) => act(async () => { root.render(<PairingBanner {...next} />); });
  await render(props);
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
  const view = {
    banner: () => container.querySelector<HTMLElement>(".notice.page-banner")!,
    body: () => container.querySelector<HTMLElement>(".notice-body")!.textContent ?? "",
    input: () => container.querySelector<HTMLInputElement>('input[aria-label="Pairing Token"]')!,
    button: (name: string) => buttons().find((button) => button.textContent === name),
    errors: () => [...container.querySelectorAll(".notice-error")].map((line) => line.textContent),
    rerender: render,
    async click(name: string) {
      const button = view.button(name);
      assert.ok(button, `${name} is rendered`);
      await act(async () => { button.click(); });
    },
    /** React's change plugin watches the focused input through keyup here, so type as a person would. */
    async type(value: string) {
      const input = view.input();
      await act(async () => {
        input.focus();
        setValue.call(input, value);
        input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: "x" }) as never);
        input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true, key: "k" }) as never);
      });
    },
    async press(key: string) {
      await act(async () => {
        view.input().dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key }) as never);
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  return view;
}

function countTokenChanges() {
  let count = 0;
  const listener = () => { count += 1; };
  window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
  return { get count() { return count; }, stop: () => window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener) };
}

test("the browser banner says how to pair in the person's terms and keeps the startup command behind Show Details", async () => {
  const view = await mount({ connecting: false, nativePairingFailure: null });
  try {
    const banner = view.banner();
    assert.equal(banner.getAttribute("role"), "status");
    assert.equal(view.body(), "Pair this device to use Wollipog: open a pairing link on it, or paste the link or token here. "
      + "An owner or admin can create one in Connections › People & Devices.");
    assert.doesNotMatch(banner.textContent ?? "", CONTROL_PLANE);
    assert.doesNotMatch(banner.textContent ?? "", /print-pair-url/u, "the operator command is not the main sentence");
    assert.equal(view.button("Retry Pairing"), undefined, "Retry Pairing is the desktop app's alone");

    await view.click("Show Details");
    const details = banner.querySelector(".notice-details-body");
    assert.ok(details, "Show Details opens the details");
    assert.equal(details.textContent, "The computer running Wollipog prints a pairing link when it starts. "
      + "To print it again, run wollipog pair url there, or start Wollipog with --print-pair-url.");
    assert.deepEqual([...details.querySelectorAll("code")].map((code) => code.textContent), ["wollipog pair url", "--print-pair-url"]);
    assert.doesNotMatch(banner.textContent ?? "", CONTROL_PLANE, "nor with the details open");
    assert.equal(view.button("Hide Details")?.getAttribute("aria-expanded"), "true");

    await view.click("Hide Details");
    assertNoDomNode(banner.querySelector(".notice-details-body"));
  } finally {
    await view.dispose();
  }
});

test("the desktop app's managed-pairing failure and its Retry Pairing error never name the control plane", async () => {
  let adopt = async () => false;
  const view = await mount({
    connecting: false,
    nativePairingFailure: "could not read the local dashboard credential",
    retryDesktopPairing: () => adopt(),
  });
  try {
    assert.equal(view.body(), "This app couldn't pair itself with Wollipog. Retry pairing, or paste a pairing link or token here.");
    assert.doesNotMatch(view.banner().textContent ?? "", CONTROL_PLANE);

    // The native command answers null when another server owns the local port.
    await view.click("Retry Pairing");
    assert.deepEqual(view.errors(), [
      "Another Wollipog is already running on this computer. Paste a pairing link or token from it to pair with it.",
    ]);
    assert.doesNotMatch(view.banner().textContent ?? "", CONTROL_PLANE);
    await view.click("Show Details");
    assert.doesNotMatch(view.banner().textContent ?? "", CONTROL_PLANE, "nor with the details open");

    // A thrown native error is shown as it was; a successful adoption reconnects.
    adopt = async () => { throw new Error("the local dashboard credential is invalid"); };
    await view.click("Retry Pairing");
    assert.deepEqual(view.errors(), ["the local dashboard credential is invalid"]);
    const changes = countTokenChanges();
    adopt = async () => true;
    await view.click("Retry Pairing");
    changes.stop();
    assert.equal(changes.count, 1, "an adopted credential reconnects in-process");
    assert.deepEqual(view.errors(), [], "the retry clears the previous error");

    await view.rerender({ connecting: true, nativePairingFailure: "x", retryDesktopPairing: () => adopt() });
    assert.equal(view.button("Retry Pairing")?.disabled, true, "Retry Pairing waits out an open attempt");
  } finally {
    await view.dispose();
  }
});

test("the pairing field, Pair and the error lines behave as before", async () => {
  const view = await mount({ connecting: false, nativePairingFailure: null });
  try {
    assert.equal(view.input().type, "password");
    assert.equal(view.input().placeholder, "#pair=… link or token");
    assert.equal(view.button("Pair")?.disabled, true, "Pair waits for something to pair with");

    await view.type("not a token");
    assert.equal(view.button("Pair")?.disabled, false);
    await view.click("Pair");
    assert.deepEqual(view.errors(), ["that doesn't look like a pairing token or link"]);
    await view.type("not a token either");
    assert.deepEqual(view.errors(), [], "typing clears the error");

    const changes = countTokenChanges();
    await view.type(`http://127.0.0.1:4317/#pair=${TOKEN}`);
    await view.press("Enter");
    changes.stop();
    assert.equal(deviceToken(), TOKEN, "a whole link is accepted and its token stored");
    assert.equal(changes.count, 1, "the socket reconnects in-process, with no reload");
    assert.deepEqual(view.errors(), ["Still not accepted. Check the token or pair a fresh one."],
      "once the attempt settles without being accepted, the banner says so");

    await view.rerender({ connecting: true, nativePairingFailure: null });
    assert.equal(view.button("Pairing…")?.disabled, true, "the connecting state reads Pairing…");
    assert.deepEqual(view.errors(), [], "no rejection line while the attempt is open");
  } finally {
    await view.dispose();
  }
});
