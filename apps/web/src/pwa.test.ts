import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { shouldRegisterServiceWorker } from "./pwa.js";

test("registers on a secure remote origin (the phone case)", () => {
  assert.equal(
    shouldRegisterServiceWorker({ supported: true, secureContext: true, hostname: "desktop.tailnet.ts.net" }),
    true,
  );
});

test("registers on localhost (secure context by spec)", () => {
  assert.equal(shouldRegisterServiceWorker({ supported: true, secureContext: true, hostname: "127.0.0.1" }), true);
  assert.equal(shouldRegisterServiceWorker({ supported: true, secureContext: true, hostname: "localhost" }), true);
});

test("does not register without support or on an insecure origin", () => {
  assert.equal(shouldRegisterServiceWorker({ supported: false, secureContext: true, hostname: "localhost" }), false);
  // http://<lan-ip> — browsers refuse SW registration there; don't even try.
  assert.equal(shouldRegisterServiceWorker({ supported: true, secureContext: false, hostname: "192.168.1.20" }), false);
});

test("does not register inside the Tauri shell", () => {
  assert.equal(
    shouldRegisterServiceWorker({ supported: true, secureContext: true, hostname: "tauri.localhost" }),
    false,
  );
});

// INVARIANT: the worker must never intercept requests or cache the app shell. The control
// plane injects window.__WOLLIPOG_SAME_ORIGIN__ into index.html at REQUEST time; a SW-cached shell
// would drop the marker and point a remotely-served dashboard at 127.0.0.1 — itself.
test("REGRESSION: sw.js has no fetch interception or cache surface", () => {
  const src = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""); // strip comments
  for (const forbidden of ['"fetch"', "'fetch'", "respondWith", "caches.", "CacheStorage", "importScripts"]) {
    assert.ok(!code.includes(forbidden), `sw.js must not contain ${forbidden}`);
  }
  // The lifecycle handlers it SHOULD have, so a truncated/emptied file also fails loudly.
  assert.ok(code.includes('addEventListener("install"'), "install handler present");
  assert.ok(code.includes('addEventListener("activate"'), "activate handler present");
});

test("the service worker uses only the Wollipog generic notification tag", () => {
  const src = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /\|\| sessionId \|\| "wollipog"/);
  assert.doesNotMatch(code, /\|\| sessionId \|\| "mam"/);
});

type WorkerHandler = (event: {
  notification: { close(): void; data: { sessionId?: string | null; view?: string | null } };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

function notificationClickHarness(openClients: Array<{ focus(): Promise<void>; postMessage(message: unknown): void }> = []) {
  const handlers = new Map<string, WorkerHandler>();
  const opened: string[] = [];
  const self = {
    addEventListener(type: string, handler: WorkerHandler) { handlers.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => {},
      matchAll: async () => openClients,
      openWindow: async (path: string) => { opened.push(path); },
    },
    registration: { getNotifications: async () => [], showNotification: async () => {} },
  };
  const src = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");
  runInNewContext(src, { self, btoa });
  const click = handlers.get("notificationclick");
  assert.ok(click, "notificationclick handler registered");
  const dispatch = async (data: { sessionId?: string | null; view?: string | null }) => {
    let settled: Promise<unknown> | null = null;
    click({ notification: { close() {}, data }, waitUntil: (promise) => { settled = promise; } });
    await settled;
  };
  return { dispatch, opened };
}

test("closed-PWA notification clicks open canonical encoded destinations", async () => {
  const harness = notificationClickHarness();
  await harness.dispatch({ sessionId: "space / unicode ✅" });
  await harness.dispatch({ view: "automations" });
  await harness.dispatch({});
  assert.deepEqual(harness.opened, [
    "/sessions/~cwBwAGEAYwBlACAALwAgAHUAbgBpAGMAbwBkAGUAIAAFJw",
    "/automations",
    "/",
  ]);
});

test("live-PWA notification clicks focus and message the existing client", async () => {
  const messages: unknown[] = [];
  let focused = 0;
  const harness = notificationClickHarness([{
    async focus() { focused++; },
    postMessage(message) { messages.push(message); },
  }]);
  await harness.dispatch({ sessionId: "s_1" });
  await harness.dispatch({ view: "automations" });
  assert.equal(focused, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [
    { type: "wollipog:open-session", sessionId: "s_1" },
    { type: "wollipog:open-automations" },
  ]);
  assert.equal(JSON.stringify(messages).includes("mam:open-"), false,
    "the post-release service worker must emit only Wollipog messages");
  assert.deepEqual(harness.opened, []);
});
