import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken } from "../device-token.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import type { UiConnectionRuntime, UiSocket } from "../ui-transport.js";
import { PairingBanner, type PairingBannerProps } from "./PairingBanner.js";
import { PAIRING_INPUT_EMPTY, PAIRING_INPUT_INVALID } from "./PairThisDeviceDialog.js";

/**
 * The pairing banner is one sentence and its actions; Pair This Device is the dialog with the field
 * (#3005). The dialog runs against the real store: a stored link reopens its socket in-process, and
 * what that socket does (a snapshot, or another 1008) is what the dialog reports.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
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
  PointerEvent: domWindow.PointerEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

/** Copy no banner or dialog may show (#2303, #3005). */
const INTERNAL = /control[\s-]*plane|token|still not accepted/iu;
const TOKEN = "abcdefghijklmnopqrstuvwxyz012345";
const OTHER_TOKEN = "zyxwvutsrqponmlkjihgfedcba543210";

class FakeSocket implements UiSocket {
  readonly readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

/** The shell's pairing slot, as App.tsx draws it: the banner while a 1008 latch holds. */
function PairingSlot(props: Omit<PairingBannerProps, "conn">) {
  const conn = useStoreSelector((state) => state.conn);
  const authRequired = useStoreSelector((state) => state.authRequired);
  return authRequired && conn !== "online" ? <PairingBanner conn={conn} {...props} /> : null;
}

async function mount(props: Omit<PairingBannerProps, "conn"> = { nativePairingFailure: null }) {
  const sockets: FakeSocket[] = [];
  let credentialChanges = 0;
  const runtime: UiConnectionRuntime = {
    instanceId: "pairing-banner",
    runtimeKey: `pairing-banner:${Math.random()}`,
    createSocket() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onCredentialChange(listener) {
      const counted = () => {
        credentialChanges += 1;
        listener();
      };
      window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, counted);
      return () => window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, counted);
    },
    close() {},
  };
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const root = createRoot(host);
  await act(async () => {
    root.render(<StoreProvider connection={runtime}><PairingSlot {...props} /></StoreProvider>);
  });
  const latest = () => sockets.at(-1)!;
  // The first socket is refused as an unpaired device's is.
  await act(async () => { latest().onclose?.({ code: 1008 }); });
  const body = domWindow.document.body as unknown as HTMLElement;
  const banner = () => host.querySelector<HTMLElement>(".notice.page-banner");
  const dialog = () => body.querySelector<HTMLElement>('[role="dialog"]');
  const buttonIn = (scope: HTMLElement | null, name: string) =>
    [...(scope?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.trim() === name);
  const field = () => {
    const label = [...(dialog()?.querySelectorAll<HTMLLabelElement>("label.field-label") ?? [])]
      .find((candidate) => candidate.textContent === "Pairing Link or Code");
    return label ? dialog()!.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`) : null;
  };
  const view = {
    banner,
    dialog,
    field,
    latest,
    get sockets() { return sockets.length; },
    get credentialChanges() { return credentialChanges; },
    sentence: () => banner()?.querySelector(".notice-body")?.textContent ?? "",
    bannerButtons: () => [...(banner()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map((button) => button.textContent?.trim()),
    bannerButton: (name: string) => buttonIn(banner(), name),
    dialogButton: (name: string) => buttonIn(dialog(), name),
    async click(button: HTMLButtonElement | undefined, name = "button") {
      assert.ok(button, `${name} is rendered`);
      await act(async () => {
        button.click();
        await tick();
      });
    },
    async type(value: string) {
      const input = field();
      assert.ok(input, "the Pairing Link or Code field is rendered");
      await act(async () => {
        input.value = value;
        fireDomEvent.change(input);
      });
    },
    async pressEnter() {
      await act(async () => {
        field()!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as never);
        await tick();
      });
    },
    description: (input: Element) => (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean)
      .map((id) => domWindow.document.getElementById(id)?.textContent ?? "").join(" "),
    async openDialog(name = "Pair This Device…") {
      await view.click(view.bannerButton(name), name);
      assert.ok(dialog(), "the dialog opens");
    },
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
  return view;
}

test("an unpaired browser's banner is one sentence and Pair This Device…, with no field in it", async () => {
  const view = await mount();
  try {
    const banner = view.banner()!;
    assert.equal(banner.getAttribute("role"), "status");
    assert.equal(view.sentence(), "This device isn't paired with Wollipog yet.");
    assert.deepEqual(view.bannerButtons(), ["Pair This Device…"]);
    const pair = view.bannerButton("Pair This Device…")!;
    assert.equal(pair.className, "btn sm primary");
    assert.equal(pair.getAttribute("aria-haspopup"), "dialog");
    assertNoDomNode(banner.querySelector("input, textarea"), "no field renders inside the banner");
    assert.doesNotMatch(banner.textContent ?? "", INTERNAL);
    assert.doesNotMatch(banner.textContent ?? "", /print-pair-url|wollipog pair url/u, "the commands are the dialog's");
  } finally {
    await view.dispose();
  }
});

test("Pair This Device names its field and keeps where to find a link behind its disclosure", async () => {
  const view = await mount();
  try {
    await view.openDialog();
    const dialog = view.dialog()!;
    assert.equal(dialog.querySelector("h2")?.textContent, "Pair This Device");
    assert.match(dialog.textContent ?? "", /Paste the pairing link from the computer running Wollipog\./u);
    const input = view.field()!;
    assert.equal(input.type, "password");
    assert.equal(input.maxLength, 2048);
    assert.equal(view.description(input), "The link opens this page on its own; pasting it here works too.");
    assert.equal(input.getAttribute("aria-invalid"), null);
    assert.ok(view.dialogButton("Cancel"));
    assert.ok(view.dialogButton("Pair This Device"));

    const disclosure = dialog.querySelector<HTMLDetailsElement>("details.disclosure")!;
    assert.equal(disclosure.querySelector("summary")?.textContent, "Where Do I Find the Link?");
    assert.equal(disclosure.open, false);
    const body = disclosure.querySelector(".disclosure-body")!;
    assert.match(body.textContent ?? "", /On the computer running Wollipog, choose Pair Device… in Connections › People and Devices\. If you can't open Wollipog there, run this in its terminal:/u);
    assert.equal(body.querySelector(".code-well > code")?.textContent, "wollipog pair url");
    assert.equal(body.querySelector(".code-well > button")?.getAttribute("aria-label"), "Copy Pairing Command");
    assert.match(body.textContent ?? "", /or start Wollipog with --print-pair-url\./u);
    // The commands appear only inside the disclosure.
    const outside = (dialog.textContent ?? "").replace(disclosure.textContent ?? "", "");
    assert.doesNotMatch(outside, /print-pair-url|wollipog pair url/u);
    assert.doesNotMatch(dialog.textContent ?? "", INTERNAL);
  } finally {
    await view.dispose();
  }
});

test("a malformed paste is the field's error, and nothing is stored or reconnected", async () => {
  const view = await mount();
  try {
    await view.openDialog();
    const before = deviceToken();
    await view.click(view.dialogButton("Pair This Device"), "Pair This Device");
    let input = view.field()!;
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.equal(view.description(input), PAIRING_INPUT_EMPTY);

    await view.type("https://studio.example.com/#pair=");
    assert.equal(view.field()!.getAttribute("aria-invalid"), null, "typing clears the error");
    await view.pressEnter();
    input = view.field()!;
    assert.equal(input.getAttribute("aria-invalid"), "true", "Enter submits");
    const error = view.dialog()!.querySelector(".field-error")!;
    assert.equal(error.textContent, PAIRING_INPUT_INVALID);
    assert.equal(error.id, input.getAttribute("aria-describedby"));
    assert.equal(domWindow.document.activeElement, input, "focus moves to the invalid field");
    assert.equal(deviceToken(), before);
    assert.equal(view.credentialChanges, 0);
    assert.doesNotMatch(view.dialog()!.textContent ?? "", INTERNAL);
  } finally {
    await view.dispose();
  }
});

test("a link the server refuses says so above the footer, and an accepted one pairs in-process and closes", async () => {
  const view = await mount();
  try {
    await view.openDialog();
    await view.type(`http://127.0.0.1:4317/#pair=${OTHER_TOKEN}`);
    const sockets = view.sockets;
    await view.click(view.dialogButton("Pair This Device"), "Pair This Device");
    assert.equal(deviceToken(), OTHER_TOKEN, "the link's code is stored");
    assert.equal(view.credentialChanges, 1, "the socket reopens in-process, with no reload");
    assert.equal(view.sockets, sockets + 1);
    const submit = view.dialogButton("Pair This Device")!;
    assert.equal(submit.getAttribute("aria-busy"), "true", "the new connection is opening");
    assert.equal(view.field()!.value, "", "a stored link is cleared from the field");

    await act(async () => { view.latest().onclose?.({ code: 1008 }); });
    const dialog = view.dialog()!;
    const notice = dialog.querySelector<HTMLElement>(".notice.t-danger")!;
    assert.ok(notice, "a refused link is a danger notice");
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Wollipog Didn't Accept This Link");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "It may have been used already or revoked. Create a new one with Pair Device… and paste it here.");
    const footer = dialog.querySelector(".modal-foot")!;
    assert.ok(notice.compareDocumentPosition(footer) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING, "the notice sits above the footer");
    assert.equal(view.dialogButton("Pair This Device")!.getAttribute("aria-busy"), null);
    assert.doesNotMatch(dialog.textContent ?? "", INTERNAL);

    await view.type(TOKEN);
    assertNoDomNode(view.dialog()!.querySelector(".notice.t-danger"), "a new paste clears the notice");
    await view.pressEnter();
    assert.equal(deviceToken(), TOKEN, "a bare code works too");
    assert.equal(view.credentialChanges, 2);
    await act(async () => {
      view.latest().onmessage?.({ data: JSON.stringify({ type: "snapshot", runners: [], runs: [], pods: [], sessions: [] }) });
      await tick();
    });
    assertNoDomNode(view.dialog(), "the dialog closes");
    assertNoDomNode(view.banner(), "and the banner goes away");
  } finally {
    await view.dispose();
  }
});

test("a typed pairing link never reaches the DOM (#3814)", async () => {
  const view = await mount();
  try {
    await view.openDialog();
    const html = () => view.dialog()!.outerHTML;
    await view.type("not a pairing-secret link");
    assert.equal(view.field()!.value, "not a pairing-secret link", "the field still holds what was typed");
    assert.doesNotMatch(html(), /pairing-secret/u);
    await view.pressEnter();
    assert.equal(view.field()!.value, "not a pairing-secret link", "a rejected paste stays in the field to correct");
    assert.doesNotMatch(html(), /pairing-secret/u);
    await view.type(`http://127.0.0.1:4317/#pair=${TOKEN}`);
    assert.doesNotMatch(html(), new RegExp(TOKEN, "u"));
  } finally {
    await view.dispose();
  }
});

test("the desktop app's managed-pairing failure offers Retry Pairing and Paste a Link…, with its words behind Show Details", async () => {
  let adopt: () => Promise<boolean> = async () => false;
  let settle: (adopted: boolean) => void = () => {};
  const view = await mount({
    nativePairingFailure: "could not read the local dashboard credential",
    retryDesktopPairing: () => adopt(),
  });
  try {
    assert.equal(view.sentence(), "This app couldn't read its saved pairing, so it can't connect.");
    assert.deepEqual(view.bannerButtons(), ["Retry Pairing", "Paste a Link…", "Show Details"]);
    assert.doesNotMatch(view.banner()!.textContent ?? "", INTERNAL);
    await view.click(view.bannerButton("Show Details"), "Show Details");
    assert.equal(view.banner()!.querySelector(".notice-details-body")?.textContent, "could not read the local dashboard credential");
    assertNoDomNode(view.banner()!.querySelector(".notice-error"), "no red line in the banner");

    // Busy keeps the label: a spinner, aria-busy and the same name.
    adopt = () => new Promise<boolean>((resolve) => { settle = resolve; });
    await view.click(view.bannerButton("Retry Pairing"), "Retry Pairing");
    const retry = view.bannerButton("Retry Pairing")!;
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.equal(retry.getAttribute("data-busy-spinner"), "prepended");
    // The native command answers false when another server owns the local port.
    await act(async () => {
      settle(false);
      await tick();
    });
    assert.equal(view.sentence(), "Another Wollipog is already running on this computer. Paste a pairing link from it.");
    assert.equal(view.bannerButton("Retry Pairing")!.getAttribute("aria-busy"), null);
    assert.equal(view.bannerButton("Show Details"), undefined, "nothing more to show");

    // Any other thrown message goes behind Show Details.
    adopt = async () => { throw new Error("the local dashboard credential is invalid"); };
    await view.click(view.bannerButton("Retry Pairing"), "Retry Pairing");
    assert.equal(view.sentence(), "This app couldn't read its saved pairing, so it can't connect.");
    // The details were left open, so they show again opened.
    assert.equal(view.bannerButton("Hide Details")?.getAttribute("aria-expanded"), "true");
    assert.equal(view.banner()!.querySelector(".notice-details-body")?.textContent, "the local dashboard credential is invalid");
    assertNoDomNode(view.banner()!.querySelector(".notice-error"), "nor a red line for a thrown message");

    // An adopted credential reconnects in-process, and stays busy while that connection opens.
    adopt = async () => true;
    await view.click(view.bannerButton("Retry Pairing"), "Retry Pairing");
    assert.equal(view.credentialChanges, 1);
    assert.equal(view.bannerButton("Retry Pairing")!.getAttribute("aria-busy"), "true");

    // Paste a Link… opens the same dialog.
    await act(async () => { view.latest().onclose?.({ code: 1008 }); });
    assert.equal(view.bannerButton("Retry Pairing")!.getAttribute("aria-busy"), null);
    await view.openDialog("Paste a Link…");
    assert.equal(view.dialog()!.querySelector("h2")?.textContent, "Pair This Device");
  } finally {
    await view.dispose();
  }
});
