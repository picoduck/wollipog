import assert from "node:assert/strict";
import test from "node:test";
import type { SessionView } from "@wollipog/protocol";
import { inboxSessionMatchesQuery, pageInboxPreview } from "./InboxView.js";

function session(agentName: string): SessionView {
  return {
    id: "session",
    title: "Managed Session",
    preview: null,
    agentId: "conductor",
    agentName,
    driver: "claude-code",
  } as SessionView;
}

test("Inbox search uses the canonical label for either persisted Conductor generation", () => {
  assert.equal(inboxSessionMatchesQuery(session("Conductor (Agent Manager)"), "wollipog", "Project"), true);
  assert.equal(inboxSessionMatchesQuery(session("Conductor (Wollipog)"), "wollipog", "Project"), true);
  assert.equal(inboxSessionMatchesQuery(session("Conductor (Wollipog)"), "unrelated", "Project"), false);
});

test("preview paging changes follow state before programmatic scrolling", () => {
  const calls: string[] = [];
  const scroll = {
    clientHeight: 480,
    scrollHeight: 2_000,
    scrollTop: 500,
    dispatchEvent: (event: Event) => {
      calls.push(`intent:${event.type}`);
      return true;
    },
    scrollBy: (options: ScrollToOptions) => calls.push(`scroll:${options.top}`),
  };

  pageInboxPreview(scroll, "next", (direction) => calls.push(`preview:${direction}`));
  assert.deepEqual(calls, ["intent:wollipog:virtual-viewport-intent", "preview:next", "scroll:480"]);

  calls.length = 0;
  pageInboxPreview(scroll, "previous", (direction) => calls.push(`preview:${direction}`));
  assert.deepEqual(calls, ["intent:wollipog:virtual-viewport-intent", "preview:previous", "scroll:-480"]);
});

test("preview paging leaves follow state alone when the requested edge cannot move", () => {
  const calls: string[] = [];
  const scroll = {
    clientHeight: 480,
    scrollHeight: 1_000,
    scrollTop: 520,
    scrollBy: () => calls.push("scroll"),
  };

  pageInboxPreview(scroll, "next", () => calls.push("preview"));
  assert.deepEqual(calls, [], "paging forward at the live tail must keep following");

  scroll.scrollTop = 0;
  pageInboxPreview(scroll, "previous", () => calls.push("preview"));
  assert.deepEqual(calls, [], "paging backward at the top must not claim preview ownership");
});
