import "./test-dom-events.js";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CreateTranscriptShareResult, TranscriptShareView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { shareMoment } from "../transcript-share-time.js";
import { copyShortcutHelper, mergeShareViews, TranscriptShareDialog } from "./TranscriptShareDialog.js";

/**
 * Share Transcript (#2148): the dialog's states (ready, a new link, sharing unavailable, loading,
 * a failed load) and the Revoke Link confirmation, with the real FeedbackProvider so the
 * confirmation, its focus return and the toasts are the ones a person sees.
 */

const domWindow = new Window({ url: "http://localhost/sessions/s_1" });
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

const document = domWindow.document as unknown as Document;
const TOKEN = "A".repeat(43);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Registered before the shared cleanup, so each mount is unmounted before that cleanup empties the
// document; the dialog refreshes its relative times on a repeating timer.
const unmounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (unmounts.length) await unmounts.pop()!();
});
installDomTestCleanup(domWindow);

/** A remote instance, which another browser can reach; the page itself is on loopback. */
const reachable: InstanceManager = {
  ...browserInstanceManager,
  activeProfile: {
    id: "remote-1",
    serverInstanceId: "remote-1",
    kind: "remote",
    label: "Studio",
    origin: "https://studio.tailnet.ts.net",
    createdAt: "",
  },
};

function share(shareId: string, overrides: Partial<TranscriptShareView> = {}): TranscriptShareView {
  const now = Date.now();
  return {
    shareId,
    sessionId: "s_1",
    createdByUserId: "user-1",
    createdAt: now - HOUR,
    expiresAt: now + 7 * DAY,
    status: "active",
    ...overrides,
  };
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function backend(initial: TranscriptShareView[] = []) {
  let shares = [...initial];
  const created: number[] = [];
  const revoked: string[] = [];
  const loads: Array<Deferred<{ shares: TranscriptShareView[] }>> = [];
  let manualLoads = false;
  const client: ApiClient = {
    ...api,
    transcriptShares: async () => {
      if (!manualLoads) return { shares };
      const load = deferred<{ shares: TranscriptShareView[] }>();
      loads.push(load);
      return load.promise;
    },
    createTranscriptShare: async (_id: string, body: { expiresInSeconds: number }): Promise<CreateTranscriptShareResult> => {
      created.push(body.expiresInSeconds);
      const now = Date.now();
      const next = share(`share-${created.length}`, { createdAt: now, expiresAt: now + body.expiresInSeconds * 1000 });
      shares = [next, ...shares];
      return { share: next, token: TOKEN };
    },
    revokeTranscriptShare: async (_id: string, shareId: string) => {
      revoked.push(shareId);
      const next = { ...shares.find((item) => item.shareId === shareId)!, status: "revoked" as const, revokedAt: Date.now() };
      shares = shares.map((item) => item.shareId === shareId ? next : item);
      return { share: next };
    },
  };
  return {
    client, created, revoked, loads,
    holdLoads() { manualLoads = true; },
  };
}

const settle = async () => {
  await act(async () => { await new Promise((resolve) => domWindow.setTimeout(resolve, 5)); });
};

async function mount(client: ApiClient, instances: InstanceManager = reachable) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let closed = 0;
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <InstancesContextProvider value={instances}>
          <FeedbackProvider>
            <TranscriptShareDialog sessionId="s_1" onClose={() => { closed += 1; }} />
          </FeedbackProvider>
        </InstancesContextProvider>
      </ApiProvider>,
    );
  });
  await settle();
  unmounts.push(async () => { await act(async () => { root.unmount(); }); container.remove(); });
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
  const share = () => dialogs().find((dialog) => dialog.classList.contains("share-dialog"))!;
  const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const buttonIn = (scope: ParentNode, name: string) => [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === name);
  return {
    dialogs, share, text, buttonIn,
    closed: () => closed,
    footerButtons: () => [...share().querySelectorAll<HTMLButtonElement>(".modal-foot button")].map((button) => button.textContent?.trim()),
    rows: () => [...share().querySelectorAll(".share-links .row[data-share-id]")].map((row) => ({
      expiry: text(row.querySelector(".row-title")),
      badge: text(row.querySelector(".status")),
      created: text(row.querySelector(".row-sub")),
      revoke: row.querySelector<HTMLButtonElement>("button")?.getAttribute("aria-label") ?? null,
    })),
    async click(button: HTMLElement | undefined) {
      assert.ok(button, "button not found");
      // A pointer click focuses a button in a browser; happy-dom's click() does not.
      await act(async () => { button.focus(); button.click(); });
      await settle();
    },
  };
}

test("the ready dialog is titled like its menu item, describes the risk in one sentence and asks only for the expiry", async () => {
  const view = await mount(backend().client);
  const dialog = view.share();
  assert.equal(view.text(dialog.querySelector(".modal-title, h2")), "Share Transcript");
  assert.equal(view.text(dialog.querySelector(".modal-desc")), "Anyone with the link can read this conversation until it expires or you revoke it.");
  assertNoDomNode(dialog.querySelector(".notice"), "no warning box while sharing is available");
  const group = dialog.querySelector('[role="radiogroup"]');
  assert.equal(group?.getAttribute("aria-label"), "Link Expires");
  assert.deepEqual([...group!.querySelectorAll('[role="radio"]')].map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    [["1 Hour", "false"], ["1 Day", "true"], ["7 Days", "false"], ["30 Days", "false"]]);
  assert.match(view.text(dialog), /The link shows a redacted copy of the transcript as it is now\. It can still include secrets or source code\./);
  assert.deepEqual(view.footerButtons(), ["Cancel", "Create Link"]);
  assert.equal(view.text(dialog.querySelector(".share-links .section-title")), "Links");
  assert.equal(view.text(dialog.querySelector(".share-links-empty")), "No links yet.");
  await view.click(view.buttonIn(dialog, "Cancel"));
  assert.equal(view.closed(), 1);
});

test("Create Link sends the chosen expiry, shows the new link once, and leaves a single Done", async () => {
  const server = backend([share("old", { createdAt: Date.now() - 2 * DAY })]);
  const view = await mount(server.client);
  const week = [...view.share().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === "7 Days");
  await view.click(week);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  assert.deepEqual(server.created, [7 * 24 * 60 * 60]);
  const dialog = view.share();
  const input = dialog.querySelector<HTMLInputElement>(".share-link-input");
  assert.equal(input?.readOnly, true);
  assert.equal(input?.value, `https://studio.tailnet.ts.net/#share=${TOKEN}`);
  assert.equal(view.text(dialog.querySelector(`label[for="${input!.id}"]`)), "New Link");
  assert.match(view.text(dialog), /Copy it now\. For your security, the full link isn't shown again\./);
  assertNoDomNode(dialog.querySelector('[role="radiogroup"]'), "the expiry is decided");
  assert.deepEqual(view.footerButtons(), ["Done"]);
  assert.equal(document.activeElement?.textContent?.trim(), "Copy Link", "focus moves to the next step");
  const rows = view.rows();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.expiry, "Expires in 7 days");
  assert.equal(rows[0]!.badge, "Active");
  assert.match(rows[0]!.created, /^Created today at \d{1,2}:\d{2} [AP]M$/);
  assert.equal(view.text(dialog.querySelector(".share-links-count")), "2");
});

test("a new 1 Day link is the first row and reads Expires in 1 day", async () => {
  const server = backend([share("old", { createdAt: Date.now() - DAY })]);
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  assert.deepEqual(server.created, [24 * 60 * 60]);
  assert.deepEqual(view.rows().map((row) => [row.expiry, row.badge]), [["Expires in 1 day", "Active"], ["Expires in 7 days", "Active"]]);
});

test("copying confirms with a toast, and a refused clipboard selects the link and names the shortcut", async () => {
  const server = backend();
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  let allow = true;
  Object.defineProperty(domWindow.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { if (!allow) throw new Error("denied"); } },
  });
  await view.click(view.buttonIn(view.share(), "Copy Link"));
  assert.ok([...document.querySelectorAll(".toast")].some((toast) => /Link copied\./.test(toast.textContent ?? "")), "toast shown");

  allow = false;
  const execCommand = document.execCommand;
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  try {
    await view.click(view.buttonIn(view.share(), "Copy Link"));
  } finally {
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  }
  const input = view.share().querySelector<HTMLInputElement>(".share-link-input")!;
  assert.ok(document.activeElement === input, "the link is selected for the shortcut");
  const helper = document.getElementById(input.getAttribute("aria-describedby")!);
  assert.equal(view.text(helper), copyShortcutHelper());
});

test("an unreachable address explains itself and offers only Done", async () => {
  // The page is on loopback and served by Vite, so another browser would be sent to the loopback
  // control plane.
  const view = await mount(backend([share("old")]).client, browserInstanceManager);
  const dialog = view.share();
  const notice = dialog.querySelector(".notice.t-warning");
  assert.ok(notice);
  assert.match(view.text(notice), /^Sharing Needs a Reachable Address/);
  assert.match(view.text(notice), /Open Wollipog from an address other people can reach, such as your LAN or Tailscale URL, then create the link\./);
  assertNoDomNode(dialog.querySelector('[role="radiogroup"]'));
  assert.equal(view.buttonIn(dialog, "Create Link"), undefined);
  assert.deepEqual(view.footerButtons(), ["Done"]);
  await view.click(view.buttonIn(notice!, "Show Details"));
  assert.match(view.text(notice), /Wollipog is open at http:\/\/(localhost|127\.0\.0\.1)(:\d+)?, which other people can't reach\./);
  // Existing links stay listed and revocable.
  assert.equal(view.rows().length, 1);
});

test("links load behind skeleton rows, a failed load offers Retry, and only the newest load is shown", async () => {
  const server = backend();
  server.holdLoads();
  const view = await mount(server.client);
  const skeleton = view.share().querySelector('.share-links [data-loading="links"]');
  assert.ok(skeleton, "skeleton rows while loading");
  assert.equal(skeleton!.querySelectorAll(".row.row-2").length, 3);
  assert.equal(view.text(skeleton!.querySelector(".sr-only")), "Loading links…");
  assertNoDomNode(view.share().querySelector(".share-links-empty"), "loading is not empty");

  await act(async () => { server.loads[0]!.reject(new Error("socket hang up")); });
  await settle();
  const error = view.share().querySelector(".share-links .notice.t-danger");
  assert.match(view.text(error), /^Couldn't Load Links/);
  assertNoDomNode(view.share().querySelector('.share-links [data-loading="links"]'), "an error replaces the skeleton");

  await view.click(view.buttonIn(error!, "Retry"));
  assert.equal(server.loads.length, 2);
  assert.ok(view.share().querySelector('.share-links [data-loading="links"]'), "the retry shows the skeleton again");
  assertNoDomNode(view.share().querySelector(".share-links .notice"), "and clears the error");
  await act(async () => { server.loads[1]!.resolve({ shares: [share("a")] }); });
  await settle();
  assert.equal(view.rows().length, 1);
  assertNoDomNode(view.share().querySelector('.share-links [data-loading="links"]'));
});

test("Revoke… names the link, Cancel returns focus to it, and confirming revokes with a toast", async () => {
  // Relative to the run's clock, so the expected words hold on any date; the formatter's own test
  // pins the calendar cases (another year, midnight).
  const expiresAt = Date.now() + 3 * DAY;
  const moment = shareMoment(expiresAt, Date.now());
  assert.match(moment, /^[A-Z][a-z]{2} \d{1,2}(, \d{4})? at \d{1,2}:\d{2} [AP]M$/);
  const server = backend([share("a", { expiresAt })]);
  const view = await mount(server.client);
  const [row] = view.rows();
  assert.equal(row!.revoke, `Revoke Link That Expires ${moment}`);
  const trigger = view.share().querySelector<HTMLButtonElement>(".share-links .row[data-share-id] button")!;
  assert.equal(trigger.textContent, "Revoke…");
  assert.ok(trigger.classList.contains("sm") && trigger.classList.contains("ghost") && trigger.classList.contains("danger"));

  await act(async () => { trigger.focus(); });
  await view.click(trigger);
  let confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"));
  assert.ok(confirmation, "the confirmation opens over the dialog");
  assert.match(view.text(confirmation), /Revoke Link/);
  assert.ok(view.text(confirmation).includes(`The link that expires ${moment} stops working right away. Anyone who has it loses access.`));
  await view.click(view.buttonIn(confirmation!, "Cancel"));
  assert.equal(server.revoked.length, 0);
  assert.ok(document.activeElement === trigger, "Cancel returns focus to Revoke…");

  await view.click(trigger);
  confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"));
  await view.click(view.buttonIn(confirmation!, "Revoke Link"));
  assert.deepEqual(server.revoked, ["a"]);
  assert.deepEqual(view.rows().map((each) => [each.expiry, each.badge, each.revoke]), [["Revoked", "Revoked", null]]);
  assert.ok([...document.querySelectorAll(".toast")].some((toast) => /Link revoked\./.test(toast.textContent ?? "")));
  await settle();
  assert.ok(document.activeElement === view.share().querySelector(".share-links .section-title"), "focus moves to the Links title");
});

test("a revoke cancelled while its request runs, which then succeeds, moves focus to Links rather than the page", async () => {
  const server = backend([share("a")]);
  const pending = deferred<{ share: TranscriptShareView }>();
  server.client.revokeTranscriptShare = async () => pending.promise;
  const view = await mount(server.client);
  const trigger = view.share().querySelector<HTMLButtonElement>(".share-links .row[data-share-id] button")!;
  await act(async () => { trigger.focus(); });
  await view.click(trigger);
  const confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"));
  await view.click(view.buttonIn(confirmation!, "Revoke Link"));
  await view.click(view.buttonIn(confirmation!, "Cancel"));
  assert.ok(document.activeElement === trigger, "Cancel returns focus to Revoke…");

  await act(async () => { pending.resolve({ share: share("a", { status: "revoked", revokedAt: Date.now() }) }); });
  await settle();
  assert.deepEqual(view.rows().map((row) => [row.expiry, row.revoke]), [["Revoked", null]]);
  assert.ok(document.activeElement === view.share().querySelector(".share-links .section-title"), "focus moves to the Links title");
  assert.ok(![...document.querySelectorAll(".toast")].some((toast) => /Link revoked\./.test(toast.textContent ?? "")),
    "a cancelled confirmation does not announce the outcome");
});

test("a link created while Revoke Link is open leaves focus in the confirmation", async () => {
  const server = backend([share("a")]);
  const pending = deferred<CreateTranscriptShareResult>();
  server.client.createTranscriptShare = async () => pending.promise;
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  await view.click(view.share().querySelector<HTMLButtonElement>(".share-links .row[data-share-id] button")!);
  const confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"))!;
  const cancel = view.buttonIn(confirmation, "Cancel")!;
  await act(async () => { cancel.focus(); });
  const now = Date.now();
  await act(async () => {
    pending.resolve({ share: share("new", { createdAt: now, expiresAt: now + DAY }), token: TOKEN });
  });
  await settle();
  assert.ok(view.share().querySelector(".share-link-input"), "the new link is shown");
  assert.ok(document.activeElement === cancel, "focus stays on the confirmation's Cancel");
});

test("a focused Revoke… whose link expires on the clock hands focus to Links", async () => {
  const ticks: Array<() => void> = [];
  const setInterval = domWindow.setInterval;
  domWindow.setInterval = ((callback: () => void) => { ticks.push(callback); return 0; }) as unknown as typeof domWindow.setInterval;
  const realNow = Date.now;
  try {
    const view = await mount(backend([share("a", { expiresAt: realNow() + 10_000 })]).client);
    const trigger = view.share().querySelector<HTMLButtonElement>(".share-links .row[data-share-id] button")!;
    await act(async () => { trigger.focus(); });
    Date.now = () => realNow() + 60_000;
    await act(async () => { for (const tick of ticks) tick(); });
    await settle();
    assert.deepEqual(view.rows().map((row) => [row.badge, row.revoke]), [["Expired", null]]);
    assert.ok(document.activeElement === view.share().querySelector(".share-links .section-title"), "focus moves to the Links title");
  } finally {
    Date.now = realNow;
    domWindow.setInterval = setInterval;
  }
});

test("Retry keeps focus in the dialog while the list loads again", async () => {
  const server = backend();
  server.holdLoads();
  const view = await mount(server.client);
  await act(async () => { server.loads[0]!.reject(new Error("socket hang up")); });
  await settle();
  await view.click(view.buttonIn(view.share().querySelector(".share-links .notice")!, "Retry"));
  assert.equal(server.loads.length, 2);
  assert.ok(document.activeElement === view.share().querySelector(".share-links .section-title"), "focus moves to the Links title");
});

test("a link's view only moves forward when the server's list and the dialog's own results meet", () => {
  const active = share("a");
  const revoked = { ...active, status: "revoked" as const, revokedAt: Date.now() };
  const created = share("new");
  const known = new Map([[revoked.shareId, revoked], [created.shareId, created]]);
  assert.deepEqual(mergeShareViews([active, share("b")], known).map((view) => [view.shareId, view.status]),
    [["a", "revoked"], ["b", "active"], ["new", "active"]], "an older list cannot undo a revoke or drop a new link");
  assert.deepEqual(mergeShareViews([revoked], new Map([[active.shareId, active]])).map((view) => view.status), ["revoked"],
    "a link revoked elsewhere stays revoked");
});

test("a link created while the list loads joins it when the list arrives", async () => {
  const server = backend([share("old", { createdAt: Date.now() - DAY })]);
  server.holdLoads();
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  assert.equal(server.loads.length, 1, "creating does not fetch the list again");
  // The list was requested before the link existed.
  await act(async () => { server.loads[0]!.resolve({ shares: [share("old", { createdAt: Date.now() - DAY })] }); });
  await settle();
  assert.deepEqual(view.rows().map((row) => [row.expiry, row.badge]), [["Expires in 1 day", "Active"], ["Expires in 7 days", "Active"]]);
});

test("a revoke is not undone by a list answered before it", async () => {
  // Create starts before the first list arrives; a revoke then succeeds; the list the server sent
  // before the revoke must not bring the link back as Active.
  const server = backend([share("a")]);
  server.holdLoads();
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  await act(async () => { server.loads[0]!.resolve({ shares: [share("a")] }); });
  await settle();
  const trigger = [...view.share().querySelectorAll<HTMLButtonElement>(".share-links .row[data-share-id] button")]
    .find((button) => button.closest("[data-share-id]")?.getAttribute("data-share-id") === "a")!;
  await view.click(trigger);
  const confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"))!;
  await view.click(view.buttonIn(confirmation, "Revoke Link"));
  for (const load of server.loads.slice(1)) {
    await act(async () => { load.resolve({ shares: [share("a")] }); });
  }
  await settle();
  const row = view.share().querySelector('.share-links .row[data-share-id="a"]');
  assert.equal(view.text(row?.querySelector(".status")), "Revoked");
  assertNoDomNode(row?.querySelector("button") ?? null, "no Revoke… on a revoked link");
});

test("revoking the link just created removes its one-time field and offers Create Link again", async () => {
  const server = backend();
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  assert.ok(view.share().querySelector(".share-link-input"));
  await view.click(view.share().querySelector<HTMLButtonElement>(".share-links .row[data-share-id] button")!);
  const confirmation = view.dialogs().find((dialog) => !dialog.classList.contains("share-dialog"));
  await view.click(view.buttonIn(confirmation!, "Revoke Link"));
  assertNoDomNode(view.share().querySelector(".share-link-input"));
  assert.deepEqual(view.footerButtons(), ["Cancel", "Create Link"]);
});

test("a failed create shows a danger notice above the footer and keeps Create Link", async () => {
  const server = backend();
  server.client.createTranscriptShare = async () => { throw new Error("Transcript too large to freeze"); };
  const view = await mount(server.client);
  await view.click(view.buttonIn(view.share(), "Create Link"));
  const notice = view.share().querySelector(".modal-body > .notice.t-danger:last-child");
  assert.match(view.text(notice), /^Couldn't Create the Link/);
  assert.deepEqual(view.footerButtons(), ["Cancel", "Create Link"]);
});
