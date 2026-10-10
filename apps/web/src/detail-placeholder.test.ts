import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detailPlaceholder,
  listPlaceholder,
  routedSessionPlaceholder,
  shouldHydrateRoutedSession,
} from "./detail-placeholder.js";

const RESOURCES = ["Session", "Run", "Pod"] as const;
const CONNS = ["connecting", "online", "offline", "unauthorized"] as const;

test("detail placeholders do not claim a resource is missing before authoritative data", () => {
  assert.deepEqual(detailPlaceholder("Session", { authoritative: false, conn: "connecting" }), {
    title: "Loading Session…", hint: null, variant: "loading", actions: [],
  });
  assert.equal(detailPlaceholder("Run", { authoritative: false, conn: "offline" }).title, "Waiting to Reconnect");
  assert.equal(detailPlaceholder("Pod", { authoritative: false, conn: "unauthorized" }).title, "Pair to Load Pod");
});

test("every detail placeholder names a next step in the person's terms, never the control plane (#2202)", () => {
  for (const resource of RESOURCES) {
    const noun = resource.toLowerCase();
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "connecting" }), {
      title: `Loading ${resource}…`, hint: null, variant: "loading", actions: [],
    });
    assert.deepEqual(detailPlaceholder(resource, { authoritative: true, conn: "online" }), {
      title: `${resource} Not Found`,
      hint: "It may have been deleted, or you may not have access.",
      variant: "empty",
      actions: resource === "Session" ? ["back", "search"] : ["back"],
    });
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "offline" }), {
      title: "Waiting to Reconnect",
      hint: `Wollipog opens this ${noun} when the connection comes back.`,
      variant: "offline",
      actions: [],
    });
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "unauthorized" }), {
      title: `Pair to Load ${resource}`,
      hint: `This device needs to be paired before it can open ${noun}s.`,
      variant: "offline",
      actions: [],
    });
    assert.deepEqual(detailPlaceholder(resource, { authoritative: false, conn: "online", error: "HTTP 502: bad gateway" }), {
      title: `Couldn't Load ${resource}`,
      hint: `Something went wrong while opening this ${noun}.`,
      variant: "error",
      actions: ["retry"],
      details: "HTTP 502: bad gateway",
    });
  }
  for (const resource of RESOURCES) {
    for (const conn of CONNS) {
      for (const authoritative of [false, true]) {
        for (const error of [null, "control-plane snapshot failed"]) {
          const placeholder = detailPlaceholder(resource, { authoritative, conn, error });
          // The raw error is only behind Show Details, so it never reaches the hint.
          assert.doesNotMatch(placeholder.hint ?? "", /control[ -]plane/iu, `${resource} ${conn} ${authoritative} ${error}`);
          assert.doesNotMatch(placeholder.title, /control[ -]plane/iu);
        }
      }
    }
  }
});

test("list placeholders name the loading, offline and unpaired states without Wollipog's internals", () => {
  assert.deepEqual(listPlaceholder("runs", "connecting"), {
    title: "Loading Multi-Agent Runs…", hint: null, variant: "loading",
  });
  assert.deepEqual(listPlaceholder("pods", "offline"), {
    title: "Pods Unavailable", hint: "Wollipog loads pods when the connection comes back.", variant: "offline",
  });
  assert.deepEqual(listPlaceholder("runs", "unauthorized"), {
    title: "Pair to Load Multi-Agent Runs",
    hint: "This device needs to be paired before it can load multi-agent runs.",
    variant: "offline",
  });
});

test("only an authoritative miss renders Not Found and transport errors stay distinct", () => {
  assert.equal(detailPlaceholder("Session", { authoritative: true, conn: "online" }).title, "Session Not Found");
  const failed = detailPlaceholder("Session", { authoritative: false, conn: "online", error: "request failed" });
  assert.equal(failed.title, "Couldn't Load Session");
  assert.equal(failed.variant, "error");
  assert.equal(failed.details, "request failed");
});

test("current pairing and offline state outrank a stale lookup error", () => {
  const failed = { sessionId: "session-a", complete: true, error: "request failed" };
  assert.equal(routedSessionPlaceholder("session-a", failed, "unauthorized").title, "Pair to Load Session");
  assert.equal(routedSessionPlaceholder("session-a", failed, "offline").title, "Waiting to Reconnect");
  assert.equal(routedSessionPlaceholder("session-a", failed, "online").title, "Couldn't Load Session");
});

test("after the first snapshot, a reconnect attempt is Waiting to Reconnect, not Loading", () => {
  const pending = { sessionId: "session-a", complete: false, error: null };
  assert.equal(routedSessionPlaceholder("session-a", pending, "connecting").title, "Loading Session…",
    "before any snapshot the page is loading");
  assert.equal(routedSessionPlaceholder("session-a", pending, "connecting", true).title, "Waiting to Reconnect");
  const missed = { sessionId: "session-a", complete: true, error: null };
  assert.equal(routedSessionPlaceholder("session-a", missed, "connecting", true).title, "Waiting to Reconnect",
    "a retry never vouches for Not Found");
  assert.equal(routedSessionPlaceholder("session-a", missed, "online", true).title, "Session Not Found");
});

test("archived revalidation waits for an authenticated online connection", () => {
  const archived = { archived: true };
  assert.equal(shouldHydrateRoutedSession(archived, 2, "unauthorized"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "connecting"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "offline"), false);
  assert.equal(shouldHydrateRoutedSession(archived, 2, "online"), true);
  assert.equal(shouldHydrateRoutedSession(archived, 0, "online"), false);
  assert.equal(shouldHydrateRoutedSession({ archived: false }, 2, "online"), false);
  assert.equal(shouldHydrateRoutedSession({ archived: false,projection: "summary" }, 2, "online"), true);
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
