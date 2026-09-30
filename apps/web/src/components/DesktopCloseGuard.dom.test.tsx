import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { PendingApproval } from "@wollipog/protocol";
import { FeedbackProvider } from "./FeedbackProvider.js";
import {
  CLOSE_WOULD_STOP_WORK,
  closeWarning,
  DesktopCloseGuard,
  heldClose,
  type CloseGuardShell,
} from "./DesktopCloseGuard.js";
import { createCloseGuardLinks, type CloseGuardLinks, type CloseGuardSession } from "../desktop-close-guard.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

/**
 * §23.1's user-visible half, as a decision (#1965).
 *
 * The shell decides whether to hold a close, by asking the local control plane. This component turns
 * the held close into a confirmation — Keep Open, Show Sessions, Quit Anyway — so what is worth
 * checking is what that dialog says and names, what each choice does, that a browser never listens,
 * and that it is actually mounted in the app. The last one is the failure that would leave every
 * other test here green while the feature does nothing.
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  KeyboardEvent: domWindow.KeyboardEvent,
  MouseEvent: domWindow.MouseEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const document = domWindow.document as unknown as Document;
const tick = () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0));

const approval = (requestId: string, extra: Partial<PendingApproval> = {}): PendingApproval =>
  ({ requestId, title: "Run pnpm test", options: [{ optionId: "allow", name: "Allow" }], ...extra });

const SESSIONS: Record<string, CloseGuardSession> = {
  s_rounding: { title: "Fix the invoice rounding bug", status: "running", pendingApproval: null },
  s_migration: { title: "Review the migration plan", status: "input_required", pendingApproval: null },
  // The shell counts these for their pending request, not their status (#2057).
  s_idle_approval: { title: "Tidy the release notes", status: "idle", pendingApproval: approval("r_idle") },
  s_completed_approval: { title: "Rename the billing module", status: "completed", pendingApproval: approval("r_completed") },
  s_input_approval: { title: "Bump the lockfile", status: "input_required", pendingApproval: approval("r_input") },
  s_idle_question: {
    title: "Pick a migration strategy",
    status: "idle",
    pendingApproval: approval("r_question", { kind: "question", options: [] }),
  },
};

interface Harness {
  listeners: string[];
  unlistened: number;
  quits: number;
  shown: number;
  emit: (payload: unknown) => Promise<void>;
  shell: CloseGuardShell;
  links: CloseGuardLinks;
}

function harness({ isTauri = true, localInstanceOpen = true, quit }: {
  isTauri?: boolean;
  localInstanceOpen?: boolean;
  quit?: () => Promise<void>;
} = {}): Harness {
  const handlers = new Map<string, (payload: unknown) => void>();
  const links = createCloseGuardLinks();
  const state: Harness = {
    listeners: [],
    unlistened: 0,
    quits: 0,
    shown: 0,
    emit: async (payload) => {
      await act(async () => { handlers.get(CLOSE_WOULD_STOP_WORK)?.(payload); await tick(); });
    },
    shell: {
      isTauri: () => isTauri,
      listen: async (event, handler) => {
        state.listeners.push(event);
        handlers.set(event, handler);
        return () => { state.unlistened += 1; handlers.delete(event); };
      },
      quit: async () => {
        state.quits += 1;
        await quit?.();
      },
    },
    links,
  };
  // The desktop instance manager provides Show Sessions whatever instance is open; the local
  // instance's store provides titles only while it is the one open.
  links.provide({ showSessions: () => { state.shown += 1; } });
  if (localInstanceOpen) links.provide({ session: (id) => SESSIONS[id] ?? null });
  return state;
}

const mounted: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (mounted.length) await mounted.pop()!();
});

async function mount(h: Harness) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <FeedbackProvider>
        <DesktopCloseGuard desktop={h.shell} links={h.links} />
      </FeedbackProvider>,
    );
  });
  const unmount = async () => { await act(async () => root.unmount()); container.remove(); };
  let unmounted = false;
  mounted.push(async () => { if (!unmounted) await unmount(); });
  return { unmount: async () => { unmounted = true; await unmount(); } };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const footButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".modal-foot > button")];
const button = (label: string) => footButtons().find((candidate) => candidate.textContent === label);
const rowTitles = () => [...document.querySelectorAll(".confirmation-rows .row-title")].map((row) => row.textContent);
const rowStatuses = () => [...document.querySelectorAll(".confirmation-rows .status.inline")].map((badge) => badge.textContent);
const more = () => document.querySelector(".confirmation-rows-more")?.textContent ?? null;

test("a held close opens Quit Wollipog on Keep Open, with Show Sessions and Quit Anyway, and no toast", async () => {
  const h = harness();
  await mount(h);
  assert.deepEqual(h.listeners, [CLOSE_WOULD_STOP_WORK]);

  await h.emit(2);
  const shown = dialog();
  assert.ok(shown, "the held close is a dialog");
  assert.equal(document.getElementById(shown.getAttribute("aria-labelledby")!)?.textContent, "Quit Wollipog");
  assert.equal(shown.querySelector(".confirmation-message")?.textContent,
    "2 sessions are still working. Quitting stops their current turns; you can continue them after you reopen Wollipog.");
  assert.deepEqual(footButtons().map((candidate) => [candidate.textContent, candidate.className]), [
    ["Show Sessions", "btn ghost"],
    ["Keep Open", "btn"],
    ["Quit Anyway", "btn danger"],
  ]);
  assert.equal(domWindow.document.activeElement, button("Keep Open") as unknown, "the safe choice has focus");
  assert.equal(document.querySelectorAll(".toast").length, 0, "a decision is never a toast (§13.1)");
  assert.deepEqual(rowTitles(), [], "a bare count names no one");
  assert.equal(more(), null);
});

test("the working sessions the local instance knows are named with their status, and the rest counted", async () => {
  const h = harness();
  await mount(h);

  await h.emit({ count: 2, sessionIds: ["s_rounding", "s_migration"] });
  assert.deepEqual(rowTitles(), ["Fix the invoice rounding bug", "Review the migration plan"]);
  assert.deepEqual(rowStatuses(), ["Running", "Awaiting Input"]);
  assert.equal(more(), null);
  await act(async () => { button("Keep Open")!.click(); await tick(); });

  await h.emit({ count: 2, sessionIds: ["s_rounding", "s_elsewhere"] });
  assert.deepEqual(rowTitles(), ["Fix the invoice rounding bug"]);
  assert.equal(more(), "and 1 more", "an id the loaded instance does not know is counted, not guessed");
  await act(async () => { button("Keep Open")!.click(); await tick(); });

  // A count larger than the ids — rows the control plane sent without one — is counted too.
  await h.emit({ count: 4, sessionIds: ["s_rounding", "s_migration"] });
  assert.equal(rowTitles().length, 2);
  assert.equal(more(), "and 2 more");
});

test("a session listed for its pending approval says so, whatever its lifecycle status (#2057)", async () => {
  const h = harness();
  await mount(h);

  await h.emit({ count: 2, sessionIds: ["s_idle_approval", "s_rounding"] });
  assert.deepEqual(rowTitles(), ["Tidy the release notes", "Fix the invoice rounding bug"]);
  // Not "Awaiting Prompt", which would contradict "still working" and hide why the row is there.
  assert.deepEqual(rowStatuses(), ["Approval Required", "Running"]);
  const badge = document.querySelector(".confirmation-rows .status.inline");
  assert.match(badge?.className ?? "", /\bt-warning\b/, "the shared attention badge, in its own tone");
  await act(async () => { button("Keep Open")!.click(); await tick(); });

  await h.emit({ count: 4, sessionIds: ["s_completed_approval", "s_input_approval", "s_migration", "s_idle_question"] });
  assert.deepEqual(rowStatuses(), ["Approval Required", "Approval Required", "Awaiting Input", "Answer Required"],
    "attention outranks every lifecycle status, and names what kind of request it is");
});

test("with the local instance not open, the count sentence stands alone", async () => {
  // Another instance may be open, holding its own sessions. Titles never come from it.
  const h = harness({ localInstanceOpen: false });
  await mount(h);
  await h.emit({ count: 2, sessionIds: ["s_rounding", "s_migration"] });
  assert.match(dialog()!.querySelector(".confirmation-message")!.textContent!, /^2 sessions are still working\./);
  assert.deepEqual(rowTitles(), []);
  assert.equal(more(), null, "no \"and 2 more\" under a list that names no one");
});

test("a count of 0 says Wollipog couldn't check, and names no one", async () => {
  const h = harness();
  await mount(h);
  await h.emit({ count: 0, sessionIds: ["s_rounding"] });
  assert.equal(dialog()!.querySelector(".confirmation-message")?.textContent,
    "Wollipog couldn't check whether agents are still working. Quitting stops any turn that is in progress.");
  assert.deepEqual(rowTitles(), []);
});

test("Quit Anyway runs the shell's quit command once, and the dialog cannot be dismissed while it runs", async () => {
  let finish: () => void = () => undefined;
  const h = harness({ quit: () => new Promise<void>((resolve) => { finish = resolve; }) });
  await mount(h);
  await h.emit(2);
  const quit = button("Quit Anyway")!;
  await act(async () => { quit.click(); quit.click(); await tick(); });
  assert.equal(h.quits, 1);
  assert.equal(quit.getAttribute("aria-busy"), "true");
  assert.equal(button("Keep Open")!.disabled, true, "quitting cannot be withdrawn once the shell is exiting");
  await act(async () => { finish(); await tick(); });
  assert.equal(h.quits, 1);
});

test("a quit the shell refuses stays in the dialog, so the person can try again or keep the app open", async () => {
  const h = harness({ quit: async () => { throw new Error("The shell did not quit."); } });
  await mount(h);
  await h.emit(2);
  await act(async () => { button("Quit Anyway")!.click(); await tick(); });
  assert.ok(dialog());
  assert.equal(dialog()!.querySelector('[role="alert"]')?.textContent, "The shell did not quit.");
  await act(async () => { button("Keep Open")!.click(); await tick(); });
  assertNoDomNode(dialog());
});

test("Keep Open and Escape close the dialog without quitting", async () => {
  const h = harness();
  await mount(h);
  await h.emit(2);
  await act(async () => { button("Keep Open")!.click(); await tick(); });
  assertNoDomNode(dialog());

  await h.emit(2);
  await act(async () => { domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape" })); await tick(); });
  assertNoDomNode(dialog());
  assert.equal(h.quits, 0);
  assert.equal(h.shown, 0);
});

test("Show Sessions closes the dialog and opens Sessions, without quitting", async () => {
  const h = harness();
  await mount(h);
  await h.emit({ count: 2, sessionIds: ["s_rounding"] });
  await act(async () => { button("Show Sessions")!.click(); await tick(); });
  assertNoDomNode(dialog());
  assert.equal(h.shown, 1);
  assert.equal(h.quits, 0);
});

test("a close held again while the dialog is open does not stack a second one", async () => {
  // The shell's grace period can end with the dialog still open, and the next close is held again.
  const h = harness();
  await mount(h);
  await h.emit(2);
  await h.emit(3);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
  await act(async () => { button("Keep Open")!.click(); await tick(); });
  assertNoDomNode(dialog(), "nothing was queued behind it");

  await h.emit(3);
  assert.match(dialog()!.querySelector(".confirmation-message")!.textContent!, /^3 sessions/, "and the next hold asks again");
});

test("the subscription is dropped on unmount", async () => {
  const h = harness();
  const { unmount } = await mount(h);
  await unmount();
  assert.equal(h.unlistened, 1);
});

test("the browser build never listens, because there is no shell to listen to", async () => {
  const h = harness({ isTauri: false });
  await mount(h);
  assert.deepEqual(h.listeners, []);
});

test("the body says how many are working, and never invents a count", () => {
  // The shell holds the close when the control plane is up but unanswerable, and has no count then.
  assert.equal(closeWarning(0),
    "Wollipog couldn't check whether agents are still working. Quitting stops any turn that is in progress.");
  assert.doesNotMatch(closeWarning(0), /\d/);
  assert.equal(closeWarning(1),
    "1 session is still working. Quitting stops its current turn; you can continue it after you reopen Wollipog.");
  assert.equal(closeWarning(3),
    "3 sessions are still working. Quitting stops their current turns; you can continue them after you reopen Wollipog.");
});

test("the shell's payload is read as a count and ids, and an older shell's bare number still works", () => {
  assert.deepEqual(heldClose(2), { count: 2, sessionIds: [] });
  assert.deepEqual(heldClose({ count: 2, sessionIds: ["s_one", "s_two"] }), { count: 2, sessionIds: ["s_one", "s_two"] });
  assert.deepEqual(heldClose({ count: 1, sessionIds: ["s_one", 7, "", null] }), { count: 1, sessionIds: ["s_one"] });
  assert.deepEqual(heldClose({ count: 2 }), { count: 2, sessionIds: [] });
  // Anything unreadable is a count the shell could not give, which already has a sentence.
  for (const unreadable of [undefined, null, "2", {}, { count: "2" }, { count: -1 }, Number.NaN]) {
    assert.equal(heldClose(unreadable).count, 0, JSON.stringify(unreadable));
  }
});

test("the app mounts the guard where nothing can unmount it", () => {
  // Presence is not enough, and asserting only presence is what let the previous placement pass:
  // inside `Shell`, the guard unmounted whenever the instance was opening, failed or missing, so
  // the shell warned into nothing. It has to sit directly under the desktop FeedbackProvider,
  // above the error boundary and above every recovery conditional.
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  assert.match(app, /import \{ DesktopCloseGuard \} from "\.\/components\/DesktopCloseGuard\.js";/);

  const desktop = /function DesktopApp\(\)[\s\S]*?\n\}/.exec(app)?.[0];
  assert.ok(desktop, "DesktopApp is where the desktop tree is rooted");
  const guardAt = desktop!.indexOf("<DesktopCloseGuard />");
  const boundaryAt = desktop!.indexOf("<ErrorBoundary");
  assert.ok(guardAt > 0, "the desktop tree does not mount the guard at all");
  assert.ok(boundaryAt > guardAt,
    "the guard must be mounted before the error boundary, or a render error takes the warning with it");

  // And it must NOT be inside Shell, which is the placement that failed.
  const shell = /function Shell\(\)[\s\S]*?\n\}\n/.exec(app)?.[0] ?? "";
  assert.doesNotMatch(shell, /<DesktopCloseGuard \/>/,
    "mounted inside Shell, the guard disappears during instance recovery");
});

test("the local instance's sessions are offered to the guard from inside that instance's store", () => {
  // Titles come from the store of the instance that is open, and only when that is the local one.
  // Mounted outside the runtime host there is no store to read; mounted in the browser app there is
  // no guard to read it.
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
  const boundary = /function DesktopInstanceBoundary\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(boundary, /<InstanceRuntimeHost[\s\S]*<CloseGuardSessionSource \/>[\s\S]*<\/InstanceRuntimeHost>/);
  const source = /function CloseGuardSessionSource\(\)[\s\S]*?\n\}/.exec(app)?.[0] ?? "";
  assert.match(source, /if \(scope !== LOCAL_INSTANCE_SCOPE\) return undefined;/);
});
