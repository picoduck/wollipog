import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { FeedbackContext } from "./FeedbackProvider.js";
import { CLOSE_WOULD_STOP_WORK, closeWarning, DesktopCloseGuard, type CloseGuardShell } from "./DesktopCloseGuard.js";

/**
 * §23.1's user-visible half.
 *
 * The shell decides whether to hold a close, by asking the local control plane. All this component
 * does is turn the shell's warning into something readable — so what is worth checking is that it
 * listens at all, that a browser never does, that the message survives on screen, and that it is
 * actually mounted in the app. The last one is the failure that would leave every other test here
 * green while the feature does nothing.
 */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

interface Harness {
  listeners: string[];
  unlistened: number;
  toasts: Array<{ message: string; durationMs?: number; tone?: string }>;
  emit: (event: string, payload: unknown) => void;
  shell: CloseGuardShell;
}

function harness(isTauri: boolean): Harness {
  const handlers = new Map<string, (payload: unknown) => void>();
  const state: Harness = {
    listeners: [],
    unlistened: 0,
    toasts: [],
    emit: (event, payload) => handlers.get(event)?.(payload),
    shell: {
      isTauri: () => isTauri,
      listen: async (event, handler) => {
        state.listeners.push(event);
        handlers.set(event, handler);
        return () => { state.unlistened += 1; handlers.delete(event); };
      },
    },
  };
  return state;
}

async function mount(h: Harness) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const feedback = {
    confirm: async () => false,
    showToast: (message: string, options: { tone?: string; durationMs?: number } = {}) => {
      h.toasts.push({ message, ...options });
      return h.toasts.length;
    },
    showUndo: () => -1,
    dismissToast: () => undefined,
  };
  await act(async () => {
    root.render(
      <FeedbackContext.Provider value={feedback as never}>
        <DesktopCloseGuard desktop={h.shell} />
      </FeedbackContext.Provider>,
    );
  });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("the shell's warning becomes a message that never dismisses itself", async () => {
  const h = harness(true);
  const { unmount } = await mount(h);
  assert.deepEqual(h.listeners, [CLOSE_WOULD_STOP_WORK]);

  await act(async () => { h.emit(CLOSE_WOULD_STOP_WORK, 2); });
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0]!.message, /2 sessions still have work running/);
  assert.match(h.toasts[0]!.message, /Closing again will stop them/,
    "it has to say what the second close does, or it is a scold rather than an instruction");
  // The claim is that it stays until dismissed. Reading the DOM a millisecond later cannot tell the
  // difference between that and a six-second toast; the requested duration can.
  assert.equal(h.toasts[0]!.durationMs, 0, "a warning that fades is one the user can miss entirely");
  assert.equal(h.toasts[0]!.tone, "error");

  await unmount();
  assert.equal(h.unlistened, 1, "the subscription is dropped on unmount");
});

test("the browser build never listens, because there is no shell to listen to", async () => {
  const h = harness(false);
  const { unmount } = await mount(h);
  assert.deepEqual(h.listeners, []);
  assert.deepEqual(h.toasts, []);
  await unmount();
});

test("an unknown count says so instead of inventing a number", () => {
  // The shell holds the close when the control plane is up but unanswerable, and has no count then.
  assert.match(closeWarning(0), /Agent work may still be running/);
  assert.doesNotMatch(closeWarning(0), /\d+ session/);
  assert.match(closeWarning(1), /^1 session still has work running\./);
  assert.match(closeWarning(3), /^3 sessions still have work running\./);
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
