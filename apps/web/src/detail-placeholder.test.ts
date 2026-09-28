import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailPlaceholder,
  listPlaceholder,
  routedSessionPlaceholder,
  shouldHydrateRoutedSession,
  shouldLookupRoutedSession,
} from "./detail-placeholder.js";

test("detail placeholders do not claim a resource is missing before authoritative data", () => {
  assert.deepEqual(detailPlaceholder("Session", { authoritative: false, conn: "connecting" }), {
    title: "Loading Session…", hint: "Waiting for the control-plane snapshot.", variant: "loading",
  });
  assert.equal(detailPlaceholder("Run", { authoritative: false, conn: "offline" }).title, "Run Unavailable");
  assert.equal(detailPlaceholder("Pod", { authoritative: false, conn: "unauthorized" }).title, "Pair to Load Pod");
});

test("detail placeholder loading and unpaired titles are in Title Case with sentence-case hints", () => {
  for (const resource of ["Session", "Run", "Pod"] as const) {
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "connecting" }), {
      title: `Loading ${resource}…`, hint: "Waiting for the control-plane snapshot.", variant: "loading",
    });
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "unauthorized" }), {
      title: `Pair to Load ${resource}`, hint: "This device needs access to the control plane.", variant: "offline",
    });
  }
});

test("list placeholders name the loading, offline and unpaired states in Title Case", () => {
  assert.deepEqual(listPlaceholder("Multi-Agent Runs", "connecting"), {
    title: "Loading Multi-Agent Runs…", hint: "Waiting for the control-plane snapshot.", variant: "loading",
  });
  assert.deepEqual(listPlaceholder("Collaboration Pods", "offline"), {
    title: "Collaboration Pods Unavailable", hint: "Reconnect to the control plane to load this list.", variant: "offline",
  });
  assert.deepEqual(listPlaceholder("Multi-Agent Runs", "unauthorized"), {
    title: "Pair to Load Multi-Agent Runs", hint: "This device needs access to the control plane.", variant: "offline",
  });
});

test("only an authoritative miss renders Not Found and transport errors stay distinct", () => {
  assert.equal(detailPlaceholder("Session", { authoritative: true, conn: "online" }).title, "Session Not Found");
  assert.deepEqual(detailPlaceholder("Session", { authoritative: false, conn: "online", error: "request failed" }), {
    title: "Session Unavailable", hint: "request failed", variant: "error",
  });
});

test("current pairing and offline state outrank a stale lookup error", () => {
  const failed = { sessionId: "session-a", complete: true, error: "request failed" };
  assert.deepEqual(routedSessionPlaceholder("session-a", failed, "unauthorized"), {
    title: "Pair to Load Session", hint: "This device needs access to the control plane.", variant: "offline",
  });
  assert.deepEqual(routedSessionPlaceholder("session-a", failed, "offline"), {
    title: "Session Unavailable", hint: "Reconnect to the control plane to load this link.", variant: "offline",
  });
});

test("archived lookup retries as connection state recovers", () => {
  assert.equal(shouldLookupRoutedSession(false, "unauthorized"), false);
  assert.equal(shouldLookupRoutedSession(false, "offline"), false);
  assert.equal(shouldLookupRoutedSession(false, "connecting"), false);
  assert.equal(shouldLookupRoutedSession(false, "online"), true);
  assert.equal(shouldLookupRoutedSession(true, "online"), false);
});

test("archived revalidation waits for an authenticated online connection", () => {
  const archived = { archived: true };
  assert.equal(shouldHydrateRoutedSession(archived, 2, "unauthorized"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "connecting"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "offline"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "online"), true);
  assert.equal(shouldHydrateRoutedSession(archived, 0, "online"), false);
  assert.equal(shouldHydrateRoutedSession({ archived: false }, 2, "online"), false);
  assert.equal(shouldHydrateRoutedSession(undefined, 0, "online"), true);
});

test("a completed lookup cannot leak a false missing state into the next session route", () => {
  const previousMiss = { sessionId: "session-a", complete: true, error: null };
  assert.equal(routedSessionPlaceholder("session-a", previousMiss, "online").title, "Session Not Found");
  assert.equal(routedSessionPlaceholder("session-b", previousMiss, "online").title, "Loading Session…");

  const previousFailure = { sessionId: "session-a", complete: true, error: "request failed" };
  assert.equal(routedSessionPlaceholder("session-b", previousFailure, "online").title, "Loading Session…");
});

test("an unauthenticated lookup race never becomes an authoritative missing session", () => {
  const unauthenticatedMiss = { sessionId: "session-a", complete: true, error: null };
  assert.equal(routedSessionPlaceholder("session-a", unauthenticatedMiss, "connecting").title, "Loading Session…");
  assert.equal(routedSessionPlaceholder("session-a", unauthenticatedMiss, "unauthorized").title, "Pair to Load Session");
});
