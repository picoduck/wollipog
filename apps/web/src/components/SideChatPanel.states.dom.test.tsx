import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type SessionEvent, type SessionView, type SideChatView } from "@wollipog/protocol";
import { ApiError, api } from "../api.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { clearPanelScratch } from "../right-panel-scratch.js";
import { PanelActionSlotContext } from "./RightPanel.js";
import { SideChatPanel } from "./SideChatPanel.js";

/**
 * Side Chat's states (#2863): one context line, the composer card with Send or Stop Turn in one seat,
 * and Starting, Start Failed, Loading, Offline and Ended each saying what is happening once. The
 * panel renders without a store here, as on the harness pages, so the store-backed Open Session link
 * is absent and the machine is named by its runner id.
 */
beforeEach(() => clearPanelScratch());

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  ResizeObserver: domWindow.ResizeObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
installDomTestCleanup(domWindow);

const parent = {
  id: "primary-session",
  runnerId: "studio",
  agentId: "claude",
  driver: "claude-code",
  status: "idle",
  title: "Primary",
} as SessionView;

const child = {
  ...parent,
  id: "side-session",
  title: "Side chat: Primary",
  archived: true,
  useWorktree: true,
  eventEpoch: 0,
} as SessionView;

const reply: SessionEvent = {
  id: 1,
  sessionId: child.id,
  seq: 1,
  ts: 2,
  payload: { kind: "agent_message", text: "A side answer", final: true },
};

type Api = typeof api;
const ORIGINAL: Partial<Api> = {
  sideChat: api.sideChat,
  createSideChat: api.createSideChat,
  getSessionEventPage: api.getSessionEventPage,
  prompt: api.prompt,
  cancelTurn: api.cancelTurn,
};

const tick = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function render(node: React.ReactElement, stub: Partial<Api>) {
  Object.assign(api, stub);
  const host = domWindow.document.createElement("div");
  const slot = domWindow.document.createElement("div");
  domWindow.document.body.append(slot, host);
  const container = host as unknown as HTMLDivElement;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      // StrictMode, as the app runs in development: setup, cleanup and setup again must still settle.
      <React.StrictMode>
        <PanelActionSlotContext.Provider value={slot as unknown as HTMLElement}>{node}</PanelActionSlotContext.Provider>
      </React.StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const button = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === name);
  return {
    container,
    slot: slot as unknown as HTMLDivElement,
    button,
    textarea: () => container.querySelector("textarea"),
    type: async (value: string) => {
      const field = container.querySelector("textarea")!;
      await act(async () => {
        field.value = value;
        fireDomEvent.change(field);
      });
    },
    async dispose() {
      await act(async () => { root.unmount(); });
      host.remove();
      slot.remove();
      Object.assign(api, ORIGINAL);
    },
  };
}

test("while the side chat replies, Stop Turn takes Send's seat and interrupts the side chat's own turn", async () => {
  let current: SessionView = { ...child, status: "running", activeTurnId: "turn-7" } as SessionView;
  const cancelled: string[] = [];
  const view = await render(
    <SideChatPanel session={parent} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} onInsertDraft={() => {}} />,
    {
      sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: current, createdAt: 1 } }),
      getSessionEventPage: async () => ({ events: [reply], eventEpoch: 0, nextAfter: 1, cacheComplete: true }),
      cancelTurn: async (id: string) => {
        cancelled.push(id);
        // The stop's answer is the stored session: still running, and with no live turn coordinate.
        return { ...current, activeTurnId: undefined } as SessionView;
      },
    },
  );
  try {
    assert.equal(view.container.querySelector(".sc-context .status")?.textContent, "Running");
    assert.equal(view.button("Send"), undefined, "Send yields its seat while the side chat replies");
    const stop = view.button("Stop Turn")!;
    assert.ok(stop.closest(".sc-composer"), "Stop Turn sits inside the composer card");
    await act(async () => { stop.click(); });
    await tick(10);
    assert.deepEqual(cancelled, [child.id], "the side chat's own session is interrupted, never the parent");
    assert.equal(view.button("Stopping Turn")?.disabled, true, "the seat waits for the turn to end, not for the answer");
    assert.equal(view.button("Send"), undefined);

    current = { ...current, status: "idle", activeTurnId: undefined } as SessionView;
    await tick(1_700);
    assert.ok(view.button("Send"), "Send is back once polling reports the turn has stopped");
  } finally {
    await view.dispose();
  }
});

test("Shift+Esc in Side Chat stops the side chat's turn and never reaches the session behind it", async () => {
  const cancelled: string[] = [];
  const running = { ...child, status: "running", activeTurnId: "turn-8" } as SessionView;
  const view = await render(
    <SideChatPanel session={parent} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} onInsertDraft={() => {}} />,
    {
      sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: running, createdAt: 1 } }),
      getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
      cancelTurn: async (id: string) => {
        cancelled.push(id);
        return running;
      },
    },
  );
  let reachedWindow = false;
  const onWindow = (event: { defaultPrevented: boolean }) => { if (!event.defaultPrevented) reachedWindow = true; };
  domWindow.addEventListener("keydown", onWindow);
  try {
    const field = view.textarea()!;
    await act(async () => {
      field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", shiftKey: true, bubbles: true, cancelable: true }) as unknown as Event);
    });
    assert.deepEqual(cancelled, [child.id]);
    assert.equal(reachedWindow, false, "the main composer's window shortcut sees it handled");
    assert.equal(view.button("Stopping Turn")?.disabled, true, "the seat shows the stop in flight");
  } finally {
    domWindow.removeEventListener("keydown", onWindow);
    await view.dispose();
  }
});

test("Starting shows the badge and the sentence, takes a draft, and holds Send with that sentence as its reason", async () => {
  let finish: ((value: SideChatView) => void) | undefined;
  let related: SideChatView | null = null;
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: related }),
    createSideChat: () => new Promise<SideChatView>((resolve) => {
      finish = (value) => {
        related = value;
        resolve(value);
      };
    }),
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    await act(async () => { view.button("Start Side Chat")!.click(); });
    assert.equal(view.container.querySelector(".sc-context .status")?.textContent, "Starting");
    const field = view.textarea()!;
    assert.equal(field.disabled, false, "the person can type while the side chat starts");
    await view.type("what does this flag do");
    const send = view.button("Send")!;
    assert.equal(send.disabled, true);
    const reason = view.container.querySelector(`#${send.getAttribute("aria-describedby")}`);
    assert.equal(reason?.textContent,
      "Creating a worktree on studio. You can type your question now and send it when the side chat is ready.");

    await act(async () => { finish!({ parentSessionId: parent.id, session: child, createdAt: 1 }); });
    await tick(10);
    assert.equal(view.button("Send")!.disabled, false, "ready: the draft typed while starting can go");
    assert.equal(view.textarea()!.value, "what does this flag do");
  } finally {
    await view.dispose();
  }
});

test("a failed start says Couldn't Start Side Chat with Retry, keeps the draft, and puts the response behind Show Details", async () => {
  let attempts = 0;
  let related: SideChatView | null = null;
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: related }),
    createSideChat: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      related = { parentSessionId: parent.id, session: child, createdAt: 1 };
      return related;
    },
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    await act(async () => { view.button("Start Side Chat")!.click(); });
    await view.type("keep me");
    await tick(10);
    const notice = view.container.querySelector(".notice.t-danger")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Start Side Chat");
    assert.match(notice.textContent ?? "", /studio didn't respond\. Nothing was created, and your draft is kept\./);
    assert.doesNotMatch(notice.textContent ?? "", /Failed to fetch/, "the raw response waits behind Show Details");
    assert.equal(view.textarea()!.value, "keep me");

    await act(async () => { view.button("Show Details")!.click(); });
    assert.match(notice.textContent ?? "", /POST \/api\/sessions\/primary-session\/side-chat/);
    assert.match(notice.textContent ?? "", /No response: Failed to fetch/);

    await act(async () => { view.button("Retry")!.click(); });
    await tick(10);
    assert.equal(attempts, 2);
    assertNoDomNode(view.container.querySelector(".notice.t-danger"));
    assert.equal(view.textarea()!.value, "keep me", "the draft survives the retry too");
  } finally {
    await view.dispose();
  }
});

/**
 * Cross-model review CR-1.1. A replacement the control plane created while its response was lost
 * reads as a failed start; once polling adopts that replacement the failure is over. Left in place
 * it kept Send closed over a ready side chat, and its Retry (replaceEnded) was refused as replacing
 * a live one.
 */
test("a replacement whose response was lost clears the failure once polling finds it", async () => {
  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-new", status: "idle" } as SessionView;
  let related: SideChatView = { parentSessionId: parent.id, session: ended, createdAt: 1 };
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: related }),
    createSideChat: async () => {
      related = { parentSessionId: parent.id, session: replacement, createdAt: 2 };
      throw new TypeError("Failed to fetch");
    },
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    await act(async () => { view.button("Start New Side Chat")!.click(); });
    await tick(10);
    assert.ok(view.container.querySelector(".notice.t-danger"), "the lost response reads as a failed start");
    await view.type("still mine");
    await tick(1_700);
    assertNoDomNode(view.container.querySelector(".notice.t-danger"));
    assert.equal(view.container.querySelector(".sc-context .status")?.textContent, "Awaiting Prompt");
    assert.equal(view.button("Send")!.disabled, false, "the adopted replacement takes the kept draft");
    assert.equal(view.textarea()!.value, "still mine");
  } finally {
    await view.dispose();
  }
});

/** Cross-model review CR-1.3: the same, with the create's rejection arriving after the adoption. */
test("a create that rejects after polling adopted its replacement leaves no failure behind", async () => {
  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-late", status: "idle" } as SessionView;
  let related: SideChatView = { parentSessionId: parent.id, session: ended, createdAt: 1 };
  let reject: ((cause: Error) => void) | undefined;
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: related }),
    createSideChat: () => new Promise<SideChatView>((_resolve, fail) => {
      related = { parentSessionId: parent.id, session: replacement, createdAt: 2 };
      reject = fail;
    }),
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    await act(async () => { view.button("Start New Side Chat")!.click(); });
    await view.type("late answer");
    await tick(1_700);
    await act(async () => { reject!(new TypeError("Failed to fetch")); });
    await tick(1_700);
    assertNoDomNode(view.container.querySelector(".notice.t-danger"), "the adopted replacement is not a failed start");
    assert.equal(view.button("Send")!.disabled, false);
    assert.equal(view.textarea()!.value, "late answer");
  } finally {
    await view.dispose();
  }
});

/**
 * Cross-model review CR-2.1. Enter used to call send past the disabled seat: during a pending Stop
 * Turn, and while a replacement's create was still pending after polling had adopted it.
 */
test("Enter never sends past a pending Stop Turn or a pending start", async () => {
  const pressEnter = async (field: HTMLTextAreaElement) => {
    await act(async () => {
      field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
  };
  const prompted: string[] = [];
  const running = { ...child, status: "running", activeTurnId: "turn-9" } as SessionView;
  const stopping = await render(
    <SideChatPanel session={parent} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} onInsertDraft={() => {}} />,
    {
      sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: running, createdAt: 1 } }),
      getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
      cancelTurn: () => new Promise<SessionView>(() => {}),
      prompt: async (_id: string, text: string) => {
        prompted.push(text);
        return running;
      },
    },
  );
  try {
    await act(async () => { stopping.button("Stop Turn")!.click(); });
    await stopping.type("wait for the stop");
    await pressEnter(stopping.textarea()!);
    assert.equal(prompted.length, 0, "a pending Stop Turn holds the seat for Enter too");
    assert.equal(stopping.textarea()!.value, "wait for the stop");
  } finally {
    await stopping.dispose();
  }

  const ended = { ...child, status: "stopped" } as SessionView;
  const replacement = { ...child, id: "side-session-pending", status: "idle" } as SessionView;
  let related: SideChatView = { parentSessionId: parent.id, session: ended, createdAt: 1 };
  const starting = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: related }),
    createSideChat: () => {
      related = { parentSessionId: parent.id, session: replacement, createdAt: 2 };
      return new Promise<SideChatView>(() => {});
    },
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
    prompt: async (_id: string, text: string) => {
      prompted.push(text);
      return replacement;
    },
  });
  try {
    await act(async () => { starting.button("Start New Side Chat")!.click(); });
    await starting.type("not yet");
    await tick(1_700);
    assert.equal(starting.button("Send")!.disabled, true, "the start is still in flight");
    await pressEnter(starting.textarea()!);
    assert.equal(prompted.length, 0, "Enter waits for the start as Send does");
    assert.equal(starting.textarea()!.value, "not yet");
  } finally {
    await starting.dispose();
  }
});

/**
 * Cross-model review CR-3.1 and CR-3.2. A stop is held by its own press: an earlier press failing
 * late does not release a newer one, and a panel closed and reopened while a stop waits keeps the
 * seat held.
 */
test("a pending Stop Turn survives an earlier stop's late failure and a remount", async () => {
  const enter = async (field: HTMLTextAreaElement) => {
    await act(async () => {
      field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }) as unknown as Event);
    });
  };
  const prompted: string[] = [];
  const cancels: Array<{ reject: (cause: Error) => void }> = [];
  let current = { ...child, status: "running", activeTurnId: "turn-a" } as SessionView;
  const stub: Partial<Api> = {
    sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: current, createdAt: 1 } }),
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
    cancelTurn: () => new Promise<SessionView>((_resolve, reject) => { cancels.push({ reject }); }),
    prompt: async (_id: string, text: string) => {
      prompted.push(text);
      return current;
    },
  };
  const panel = <SideChatPanel session={parent} runnerOnline runnerProtocolVersion={PROTOCOL_VERSION} onInsertDraft={() => {}} />;
  const first = await render(panel, stub);
  try {
    await act(async () => { first.button("Stop Turn")!.click(); });
    // Turn A ends and turn B starts before A's stop request has answered.
    current = { ...current, activeTurnId: "turn-b" } as SessionView;
    await tick(1_700);
    await act(async () => { first.button("Stop Turn")!.click(); });
    assert.equal(cancels.length, 2);
    await act(async () => { cancels[0]!.reject(new Error("turn already finished")); });
    await first.type("not while B stops");
    assert.equal(first.button("Stopping Turn")?.disabled, true, "B's stop still holds the seat");
    await enter(first.textarea()!);
    assert.equal(prompted.length, 0);
  } finally {
    await first.dispose();
  }

  // Reopened while B's stop is still waiting: the seat stays held.
  const second = await render(panel, stub);
  try {
    assert.equal(second.button("Stopping Turn")?.disabled, true, "a remounted panel inherits the pending stop");
    await enter(second.textarea()!);
    assert.equal(prompted.length, 0, "nothing sends past a stop pressed before the remount");
    current = { ...current, status: "idle", activeTurnId: undefined } as SessionView;
    await tick(1_700);
    assert.ok(second.button("Send"), "the turn's end releases it");
  } finally {
    await second.dispose();
  }
});

test("a refused start keeps the draft without claiming the machine didn't respond", async () => {
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: null }),
    createSideChat: async () => { throw new ApiError("side chats are disabled for this project", 403); },
  });
  try {
    await act(async () => { view.button("Start Side Chat")!.click(); });
    await tick(10);
    const notice = view.container.querySelector(".notice.t-danger")!;
    assert.match(notice.textContent ?? "", /The side chat couldn't be created\. Your draft is kept\./);
    await act(async () => { view.button("Show Details")!.click(); });
    assert.match(notice.textContent ?? "", /HTTP 403: side chats are disabled for this project/);
  } finally {
    await view.dispose();
  }
});

test("an existing transcript loads under a skeleton, never under No messages yet", async () => {
  let serve: (() => void) | undefined;
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: child, createdAt: 1 } }),
    getSessionEventPage: () => new Promise((resolve) => {
      serve = () => resolve({ events: [reply], eventEpoch: 0, nextAfter: 1, cacheComplete: true });
    }),
  });
  try {
    assert.ok(view.container.querySelector(".sc-transcript .transcript-skeleton"));
    assert.doesNotMatch(view.container.textContent ?? "", /No messages yet/);
    await act(async () => { serve!(); });
    await tick(10);
    assertNoDomNode(view.container.querySelector(".transcript-skeleton"));
    assert.match(view.container.textContent ?? "", /A side answer/);
    assert.doesNotMatch(view.container.textContent ?? "", /No messages yet/);
  } finally {
    await view.dispose();
  }
});

test("About Side Chat holds the privacy text, and the panel body has none", async () => {
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: null }),
  });
  try {
    assert.doesNotMatch(view.container.textContent ?? "", /attachments|budget|copied/i);
    const about = view.slot.querySelector<HTMLButtonElement>('button[aria-label="About Side Chat"]')!;
    assert.equal(about.title, "About Side Chat");
    await act(async () => { about.click(); });
    const popover = domWindow.document.querySelector('[role="dialog"][aria-label="About Side Chat"]')!;
    assert.match(popover.textContent ?? "", /Ask this session's agent something without adding it to this conversation\./);
    const terms = [...popover.querySelectorAll("dt")].map((term) => term.textContent);
    assert.deepEqual(terms, ["Shared", "Not Shared", "Comes Back", "Send", "Open"]);
    assert.match(popover.textContent ?? "", /This conversation, its attachments, artifacts and budget/);
  } finally {
    await view.dispose();
  }
});

test("offline, the badge reads Unverified, one compact notice names the machine, and Send waits", async () => {
  const view = await render(<SideChatPanel session={parent} runnerOnline={false} onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: child, createdAt: 1 } }),
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    assert.equal(view.container.querySelector(".sc-context .status")?.textContent, "Unverified");
    const notice = view.container.querySelector(".notice.t-warning.compact")!;
    assert.match(notice.textContent ?? "", /studio is offline\. You can send again when it reconnects\./);
    await view.type("later");
    assert.equal(view.button("Send")!.disabled, true);
  } finally {
    await view.dispose();
  }
});

test("Insert into Draft says Inserted into Draft on the reply, then comes back", async () => {
  const inserted: string[] = [];
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={(text) => inserted.push(text)} />, {
    sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: child, createdAt: 1 } }),
    getSessionEventPage: async () => ({ events: [reply], eventEpoch: 0, nextAfter: 1, cacheComplete: true }),
  });
  try {
    await act(async () => { view.button("Insert into Draft")!.click(); });
    assert.deepEqual(inserted, ["A side answer"]);
    assert.ok(view.button("Inserted into Draft"), "the reply itself shows the insert worked");
    await tick(2_100);
    assert.ok(view.button("Insert into Draft"));
  } finally {
    await view.dispose();
  }
});

test("the composer card has a one-line textarea with no resize grip and Send inside the card", async () => {
  const view = await render(<SideChatPanel session={parent} runnerOnline onInsertDraft={() => {}} />, {
    sideChat: async () => ({ sideChat: { parentSessionId: parent.id, session: child, createdAt: 1 } }),
    getSessionEventPage: async () => ({ events: [], eventEpoch: 0, nextAfter: 0, cacheComplete: true }),
  });
  try {
    const card = view.container.querySelector(".sc-composer")!;
    assert.equal(card.querySelector("textarea")?.getAttribute("rows"), "1");
    assert.equal(card.querySelector("textarea")?.getAttribute("placeholder"), "Ask a side question…");
    const send = card.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    assert.equal(send.className, "icon-btn primary");
    assert.match(view.container.textContent ?? "", /No messages yet\./, "a loaded, empty live chat says so");
    assertNoDomNode(view.container.querySelector(".sidechat-boundary"));
  } finally {
    await view.dispose();
  }
});
