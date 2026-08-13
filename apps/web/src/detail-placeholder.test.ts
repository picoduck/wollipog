import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailPlaceholder,
  routedSessionPlaceholder,
  shouldHydrateRoutedSession,
  shouldLookupRoutedSession,
} from "./detail-placeholder.js";

test("detail placeholders do not claim a resource is missing before authoritative data", () => {
  assert.deepEqual(detailPlaceholder("Session", { authoritative: false, conn: "connecting" }), {
    title: "Loading session…", hint: "Waiting for the control-plane snapshot.",
  });
  assert.equal(detailPlaceholder("Run", { authoritative: false, conn: "offline" }).title, "Run Unavailable");
  assert.equal(detailPlaceholder("Pod", { authoritative: false, conn: "unauthorized" }).title, "Pair to load pod");
});

test("only an authoritative miss renders Not Found and transport errors stay distinct", () => {
  assert.equal(detailPlaceholder("Session", { authoritative: true, conn: "online" }).title, "Session Not Found");
  assert.deepEqual(detailPlaceholder("Session", { authoritative: false, conn: "online", error: "request failed" }), {
    title: "Session Unavailable", hint: "request failed",
  });
});

test("current pairing and offline state outrank a stale lookup error", () => {
  const failed = { sessionId: "session-a", complete: true, error: "request failed" };
  assert.deepEqual(routedSessionPlaceholder("session-a", failed, "unauthorized"), {
    title: "Pair to load session", hint: "This device needs access to the control plane.",
  });
  assert.deepEqual(routedSessionPlaceholder("session-a", failed, "offline"), {
    title: "Session Unavailable", hint: "Reconnect to the control plane to load this link.",
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
  assert.equal(routedSessionPlaceholder("session-b", previousMiss, "online").title, "Loading session…");

  const previousFailure = { sessionId: "session-a", complete: true, error: "request failed" };
  assert.equal(routedSessionPlaceholder("session-b", previousFailure, "online").title, "Loading session…");
});

test("an unauthenticated lookup race never becomes an authoritative missing session", () => {
  const unauthenticatedMiss = { sessionId: "session-a", complete: true, error: null };
  assert.equal(routedSessionPlaceholder("session-a", unauthenticatedMiss, "connecting").title, "Loading session…");
  assert.equal(routedSessionPlaceholder("session-a", unauthenticatedMiss, "unauthorized").title, "Pair to load session");
});
