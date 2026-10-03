import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { OperationalTranscriptMessage, PublicTranscriptShare } from "@wollipog/protocol";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// The control plane's address is read from `window` when config loads, so import after the window.
const { SharedTranscript, sharedMessageCount } = await import("./SharedTranscript.js");

const TOKEN = "q7Lr2xVb9KcT4mWn8PzY3sHd6FgJ1aEu5oRi0tXkQwB";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function share(messages: OperationalTranscriptMessage[], expiresAt = new Date(2026, 8, 26, 0, 49, 58).getTime()): PublicTranscriptShare {
  return {
    expiresAt,
    transcript: { schemaVersion: 1, source: "control-plane-cache", completeness: "possibly-partial", messages },
  } as PublicTranscriptShare;
}

/** Answers every request with `respond`, and records the URLs asked for. */
function serve(respond: (url: string) => Promise<Response>): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  return requests;
}

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
}));

async function mount(token: string | null = TOKEN) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<SharedTranscript token={token} />));
  // Let the response body resolve and the page settle.
  for (let round = 0; round < 3; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}

const MARKDOWN_REPLY = [
  "## Findings",
  "",
  "| File | Status |",
  "| --- | --- |",
  "| api.ts | Changed |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "![diagram](https://media.example.com/diagram.png?X-Amz-Signature=abc)",
  "",
  "https://media.example.com/clip.mp4?X-Amz-Signature=abc",
  "",
  "<img src=\"https://evil.example.com/x.png\"><script>alert(1)</script>",
  "",
  "[Docs](https://example.com/docs)",
].join("\n");

test("a reply renders as markdown with no media fetched and raw HTML left inert", async () => {
  const requests = serve(() => json(share([
    { role: "user", text: "Review **api.ts**, please" },
    { role: "assistant", text: MARKDOWN_REPLY },
  ])));
  const view = await mount();
  try {
    const reply = view.container.querySelector(".timeline .tl-agent-msg");
    assert.ok(reply, "the reply is unframed document flow");
    assert.equal(reply.querySelector("h2")?.textContent, "Findings");
    assert.ok(reply.querySelector("table"), "the table renders as a table");
    assert.equal(reply.querySelector("pre code")?.textContent?.trim(), "const answer = 42;");
    assert.equal(view.container.querySelectorAll(".share-main :is(img, video, audio, source, script, iframe)").length, 0,
      "the transcript has no media element, so an anonymous viewer fetches nothing it names");
    assert.deepEqual([...view.container.querySelectorAll("img, video")].map((element) => element.getAttribute("src")),
      ["/icons/icon-192.png"], "the only image on the page is the bar's own product mark");
    // Raw HTML stays text, never markup.
    assert.match(reply.textContent ?? "", /<img src=/);
    const links = [...reply.querySelectorAll("a")];
    assert.ok(links.some((link) => link.getAttribute("href")?.startsWith("https://media.example.com/diagram.png")),
      "an image is a plain link");
    assert.ok(links.some((link) => link.getAttribute("href")?.startsWith("https://media.example.com/clip.mp4")),
      "a video is a plain link");
    for (const link of links) {
      assert.equal(link.getAttribute("rel"), "noopener noreferrer");
      assert.equal(link.getAttribute("target"), "_blank");
    }
    assert.doesNotMatch(reply.textContent ?? "", /X-Amz-Signature/, "a signed URL's query is not shown as text");
    assert.deepEqual(requests, ["http://127.0.0.1:4317/api/public/transcript-share"], "the share is the only request");
  } finally {
    await view.unmount();
  }
});

test("a person's message is a right-aligned bubble, and no internal word is visible", async () => {
  serve(() => json(share([
    { role: "user", text: "Fix the `login` test" },
    { role: "assistant", text: "Done." },
    { role: "user", text: "Thanks" },
    { role: "assistant", text: "[Turn interrupted]" },
  ])));
  const view = await mount();
  try {
    const items = [...view.container.querySelectorAll(".timeline > [role='listitem']")];
    assert.equal(items.length, 4);
    const bubble = items[0]!.querySelector(".tl-row.user .tl-bubble");
    assert.ok(bubble, "the person's message is a bubble in a right-aligned row");
    assert.equal(bubble.querySelector("code")?.textContent, "login", "with the inline markdown profile");
    assert.equal(items[0]!.className, "", "the first turn starts at the top");
    assert.equal(items[2]!.className, "tl-turn-start", "a later message from the person starts a new turn");
    assert.equal(items[3]!.querySelector(".tl-interrupted")?.textContent, "Stopped");

    const text = view.container.textContent ?? "";
    for (const word of ["USER", "ASSISTANT", "User", "Assistant", "Operational", "operationally", "capability", "Turn interrupted"]) {
      assert.ok(!text.includes(word), `"${word}" is not visible`);
    }
    assert.equal(view.container.querySelector("h1")?.textContent, "Shared Transcript");
    assert.equal(view.container.querySelector(".share-bar")?.textContent, "Shared Transcript");
    // The interruption is not a message.
    assert.equal(view.container.querySelector(".share-meta")?.textContent, "3 messages · Link expires Sep 26, 12:49 AM");
    const notice = view.container.querySelector(".share-head > .notice.t-warning.compact");
    assert.equal(notice?.textContent,
      "Secrets were removed automatically, but this may still contain code or personal information.");
  } finally {
    await view.unmount();
  }
});

test("an unknown or malformed link shows This Link Isn't Available", async () => {
  serve(() => Promise.resolve(new Response("not found", { status: 404 })));
  for (const token of [TOKEN, null]) {
    const view = await mount(token);
    try {
      assert.equal(view.container.querySelector(".state .state-title")?.textContent, "This Link Isn't Available");
      assert.equal(view.container.querySelector(".state .state-body")?.textContent, "Ask the person who shared it for a new link.");
      assertNoDomNode(view.container.querySelector(".share-meta"), "nothing about a transcript it cannot show");
      assertNoDomNode(view.container.querySelector(".notice"), "no warning about content that is not there");
      assert.equal(view.container.querySelector(".share-foot")?.textContent, "Shared from Wollipog.",
        "the foot describes the transcript only when there is one");
    } finally {
      await view.unmount();
    }
  }
});

test("a network failure is a danger notice with Retry, and the raw error waits behind Show Details", async () => {
  let fail = true;
  serve(() => fail ? Promise.reject(new TypeError("Failed to fetch")) : json(share([{ role: "user", text: "Hello" }])));
  const view = await mount();
  try {
    const notice = view.container.querySelector(".notice.t-danger");
    assert.ok(notice);
    assert.equal(notice.getAttribute("role"), "alert");
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Load This Transcript");
    assert.ok(!(notice.textContent ?? "").includes("Failed to fetch"), "the raw error is not shown up front");
    const toggle = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Show Details")!;
    await act(async () => toggle.click());
    assert.equal(notice.querySelector(".notice-details-body .code-well pre")?.textContent, "Failed to fetch");

    fail = false;
    const retry = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    for (let round = 0; round < 3; round += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertNoDomNode(view.container.querySelector(".notice.t-danger"), "Retry loads the transcript");
    assert.ok(view.container.querySelector(".timeline .tl-bubble"));
  } finally {
    await view.unmount();
  }
});

test("a server error is the same notice, with its status behind Show Details", async () => {
  serve(() => Promise.resolve(new Response("bad gateway", { status: 502 })));
  const view = await mount();
  try {
    const notice = view.container.querySelector(".notice.t-danger")!;
    const toggle = [...notice.querySelectorAll("button")].find((button) => button.textContent === "Show Details")!;
    await act(async () => toggle.click());
    assert.equal(notice.querySelector(".code-well pre")?.textContent, "Request failed (502)");
  } finally {
    await view.unmount();
  }
});

test("while loading the page shows the turn-shaped skeleton", async () => {
  serve(() => new Promise<Response>(() => undefined));
  const view = await mount();
  try {
    assert.equal(view.container.querySelector(".transcript-skeleton")?.getAttribute("aria-label"), "Loading Shared Transcript");
    assertNoDomNode(view.container.querySelector(".state"), "no state while loading");
  } finally {
    await view.unmount();
  }
});

test("an empty transcript says so", async () => {
  serve(() => json(share([])));
  const view = await mount();
  try {
    assert.equal(view.container.querySelector(".state .state-body")?.textContent, "This transcript has no messages yet.");
    assert.equal(view.container.querySelector(".share-meta")?.textContent?.startsWith("0 messages · "), true);
    assertNoDomNode(view.container.querySelector(".timeline"), "no empty list");
  } finally {
    await view.unmount();
  }
});

test("the message count leaves out interruptions and says one message in the singular", () => {
  assert.equal(sharedMessageCount([{ role: "user", text: "Hi" }]), "1 message");
  assert.equal(sharedMessageCount([{ role: "user", text: "Hi" }, { role: "assistant", text: "[Turn interrupted]" }]), "1 message");
  assert.equal(sharedMessageCount([{ role: "user", text: "[Turn interrupted]" }, { role: "assistant", text: "Hi" }]), "2 messages",
    "only the projection's own assistant marker is an interruption");
});
