import assert from "node:assert/strict";
import test from "node:test";
import { pageInboxPreview } from "./InboxView.js";

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
    scrollTo: (options: ScrollToOptions) => calls.push(`scroll:${options.top}:${options.behavior}`),
  };

  pageInboxPreview(scroll, "next", (direction) => calls.push(`preview:${direction}`));
  assert.deepEqual(calls, ["intent:wollipog:virtual-viewport-intent", "preview:next", "scroll:980:auto"]);

  calls.length = 0;
  pageInboxPreview(scroll, "previous", (direction) => calls.push(`preview:${direction}`));
  assert.deepEqual(calls, ["intent:wollipog:virtual-viewport-intent", "preview:previous", "scroll:20:auto"]);
});

test("preview paging leaves follow state alone when the requested edge cannot move", () => {
  const calls: string[] = [];
  const scroll = {
    clientHeight: 480,
    scrollHeight: 1_000,
    scrollTop: 520,
    dispatchEvent: (event: Event) => {
      calls.push(`intent:${(event as CustomEvent<{ direction?: string }>).detail?.direction ?? "none"}`);
      return true;
    },
    scrollTo: () => calls.push("scroll"),
  };

  pageInboxPreview(scroll, "next", () => calls.push("preview"));
  assert.deepEqual(calls, [], "paging forward at the live tail must keep following");

  scroll.scrollTop = 0;
  pageInboxPreview(scroll, "previous", () => calls.push("preview"));
  assert.deepEqual(calls, ["intent:up"],
    "paging backward at the top asks the transcript for earlier activity without claiming preview ownership");
});
