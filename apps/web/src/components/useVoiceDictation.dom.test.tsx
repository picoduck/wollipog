import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { DictationStrip } from "./DictationStrip.js";
import { HOLD_THRESHOLD_MS, useVoiceDictation } from "./useVoiceDictation.js";

/**
 * Tap-or-hold dictation (#2193) against a fake SpeechRecognition: a press shorter than the hold
 * threshold toggles, a longer one is push-to-talk, and the engine's own endings restart while the
 * person still wants to dictate.
 */

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

type Result = { isFinal: boolean; 0: { transcript: string } };

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((ev: { resultIndex: number; results: Result[] }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.started += 1; }
  stop() { this.stopped += 1; }
  abort() { this.aborted += 1; }
  /** The engine reports results; `results` is the whole list, as Chrome's continuous mode does. */
  emit(results: Result[], resultIndex = 0) { this.onresult?.({ resultIndex, results }); }
  end(error?: string) {
    if (error) this.onerror?.({ error });
    this.onend?.();
  }
}

const speech = domWindow as unknown as { SpeechRecognition?: unknown };

type Dictation = ReturnType<typeof useVoiceDictation>;

async function renderHook() {
  const phrases: string[] = [];
  const current: { value: Dictation | null } = { value: null };
  function Probe() {
    current.value = useVoiceDictation((phrase) => phrases.push(phrase));
    return null;
  }
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const root: Root = createRoot(host);
  await act(async () => root.render(<Probe />));
  const dictation = () => {
    assert.ok(current.value);
    return current.value;
  };
  return {
    phrases,
    dictation,
    act: async (fn: (d: Dictation) => void) => { await act(async () => fn(dictation())); },
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function withFakeSpeech(body: () => Promise<void>) {
  return async () => {
    FakeRecognition.instances = [];
    speech.SpeechRecognition = FakeRecognition;
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
    try {
      await body();
    } finally {
      mock.timers.reset();
      delete speech.SpeechRecognition;
    }
  };
}

async function advance(ms: number) {
  await act(async () => { mock.timers.tick(ms); });
}

test("a tap shorter than the hold threshold starts dictation, and the next tap stops it", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    assert.equal(hook.dictation().supported, true);
    assert.equal(hook.dictation().recording, false);
    await hook.act((d) => d.pressStart());
    const recognizer = FakeRecognition.instances[0]!;
    assert.equal(recognizer.started, 1, "the press starts the recognizer");
    assert.equal(hook.dictation().recording, true);
    assert.equal(hook.dictation().startedAt, 1_000_000);
    await advance(HOLD_THRESHOLD_MS - 150);
    await hook.act((d) => d.pressEnd());
    assert.equal(hook.dictation().recording, true, "a short press leaves it recording");
    assert.equal(recognizer.stopped, 0);
    assert.equal(hook.dictation().held, false);

    // Well past the threshold, the hold timer of the finished tap never claims a hold.
    await advance(2_000);
    assert.equal(hook.dictation().held, false);

    await hook.act((d) => d.pressStart());
    assert.equal(hook.dictation().recording, false, "the second tap stops it");
    assert.equal(recognizer.stopped, 1);
    assert.equal(hook.dictation().startedAt, null);
    // That tap's own release does nothing more, and neither does a stray pointerleave.
    await hook.act((d) => d.pressEnd());
    await hook.act((d) => d.pressEnd());
    assert.equal(recognizer.stopped, 1);
    assert.equal(FakeRecognition.instances.length, 1, "no recognizer starts again");
  } finally {
    await hook.unmount();
  }
}));

test("a hold past the threshold says so, and its release stops dictation", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    await hook.act((d) => d.pressStart());
    assert.equal(hook.dictation().held, false, "a press is not a hold until the threshold passes");
    await advance(HOLD_THRESHOLD_MS);
    assert.equal(hook.dictation().held, true);
    assert.equal(hook.dictation().recording, true);
    await hook.act((d) => d.pressEnd());
    assert.equal(hook.dictation().recording, false, "releasing a hold stops");
    assert.equal(hook.dictation().held, false);
    assert.equal(FakeRecognition.instances[0]!.stopped, 1);
  } finally {
    await hook.unmount();
  }
}));

test("toggle starts and stops, as Enter or Space on the mic do", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    await hook.act((d) => d.toggle());
    assert.equal(hook.dictation().recording, true);
    assert.equal(hook.dictation().held, false, "a keyboard start is never a hold");
    await advance(5_000);
    assert.equal(hook.dictation().recording, true);
    await hook.act((d) => d.toggle());
    assert.equal(hook.dictation().recording, false);
    assert.equal(FakeRecognition.instances[0]!.stopped, 1);
  } finally {
    await hook.unmount();
  }
}));

test("interim words surface separately, and only final phrases reach the message", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    await hook.act((d) => d.toggle());
    const recognizer = FakeRecognition.instances[0]!;
    await act(async () => recognizer.emit([{ isFinal: false, 0: { transcript: "fix the" } }]));
    assert.equal(hook.dictation().interim, "fix the");
    assert.deepEqual(hook.phrases, [], "unsettled words are not added to the message");
    await act(async () => recognizer.emit([
      { isFinal: true, 0: { transcript: "fix the sidebar" } },
      { isFinal: false, 0: { transcript: "and the" } },
    ]));
    assert.deepEqual(hook.phrases, ["fix the sidebar"]);
    assert.equal(hook.dictation().interim, "and the");

    // Stopping clears the strip's words at once; the phrase the engine settles afterwards still lands.
    await hook.act((d) => d.stop());
    assert.equal(hook.dictation().interim, "");
    await act(async () => recognizer.emit([
      { isFinal: true, 0: { transcript: "fix the sidebar" } },
      { isFinal: true, 0: { transcript: "and the header" } },
    ], 1));
    assert.deepEqual(hook.phrases, ["fix the sidebar", "and the header"]);
    assert.equal(hook.dictation().interim, "");
    await act(async () => recognizer.end());
    assert.equal(FakeRecognition.instances.length, 1, "a stopped recognizer is not restarted");
  } finally {
    await hook.unmount();
  }
}));

test("an engine that ends on its own restarts while dictation is wanted, keeping the start time", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    await hook.act((d) => d.toggle());
    const startedAt = hook.dictation().startedAt;
    await advance(8_000);
    await act(async () => FakeRecognition.instances[0]!.end("no-speech"));
    assert.equal(FakeRecognition.instances.length, 2, "a fresh recognizer picks up");
    assert.equal(FakeRecognition.instances[1]!.started, 1);
    assert.equal(hook.dictation().recording, true);
    assert.equal(hook.dictation().startedAt, startedAt, "the timer keeps counting from the first start");

    // A fatal ending (the mic was refused) does not loop; the mic reads as off.
    await act(async () => FakeRecognition.instances[1]!.end("not-allowed"));
    assert.equal(FakeRecognition.instances.length, 2);
    assert.equal(hook.dictation().recording, false);
    assert.equal(hook.dictation().startedAt, null);
  } finally {
    await hook.unmount();
  }
}));

test("starting again while the last stop is still settling reuses that recognizer", withFakeSpeech(async () => {
  const hook = await renderHook();
  try {
    await hook.act((d) => d.toggle());
    await hook.act((d) => d.toggle());
    await hook.act((d) => d.pressStart());
    assert.equal(FakeRecognition.instances.length, 1, "no second recognizer captures alongside the first");
    assert.equal(hook.dictation().recording, true);
    await act(async () => FakeRecognition.instances[0]!.end());
    assert.equal(FakeRecognition.instances.length, 2, "the settled recognizer hands over to a fresh one");
    assert.equal(hook.dictation().recording, true);
  } finally {
    await hook.unmount();
  }
}));

test("unmounting mid-dictation aborts the recognizer without restarting it", withFakeSpeech(async () => {
  const hook = await renderHook();
  await hook.act((d) => d.pressStart());
  const recognizer = FakeRecognition.instances[0]!;
  await hook.unmount();
  assert.equal(recognizer.aborted, 1);
  recognizer.end("aborted");
  assert.equal(FakeRecognition.instances.length, 1);
}));

test("without SpeechRecognition the mic is unsupported and nothing starts", async () => {
  delete speech.SpeechRecognition;
  const hook = await renderHook();
  try {
    assert.equal(hook.dictation().supported, false);
    await hook.act((d) => d.pressStart());
    assert.equal(hook.dictation().recording, false);
  } finally {
    await hook.unmount();
  }
});

test("the Listening strip counts each second and names the stop for the gesture", withFakeSpeech(async () => {
  const host = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(host as never);
  const root = createRoot(host);
  const render = (held: boolean, interim = "") => act(async () => root.render(
    <DictationStrip startedAt={Date.now()} held={held} interim={interim} />,
  ));
  try {
    const startedAt = Date.now();
    await act(async () => root.render(<DictationStrip startedAt={startedAt} held={false} interim="" />));
    const strip = host.querySelector(".dictation-strip");
    assert.equal(strip?.getAttribute("role"), "status");
    assert.equal(host.querySelector(".dictation-dot")?.getAttribute("aria-hidden"), "true");
    assert.equal(host.querySelector(".dictation-label")?.textContent, "Listening…");
    assert.equal(host.querySelector(".dictation-hint")?.textContent, "Tap the mic to stop");
    const timer = () => host.querySelector(".dictation-timer");
    assert.equal(timer()?.textContent, "00:00");
    assert.equal(timer()?.getAttribute("aria-live"), "off", "a ticking clock is not announced");
    await advance(999);
    assert.equal(timer()?.textContent, "00:00");
    await advance(1);
    assert.equal(timer()?.textContent, "00:01");
    await advance(1_000);
    assert.equal(timer()?.textContent, "00:02");
    await advance(60_000);
    assert.equal(timer()?.textContent, "01:02");
    assertNoDomNode(host.querySelector(".dictation-interim"), "no unsettled words, no slot for them");

    await act(async () => root.render(<DictationStrip startedAt={startedAt} held interim="and the" />));
    assert.equal(host.querySelector(".dictation-hint")?.textContent, "Release to stop");
    const interim = host.querySelector(".dictation-interim");
    assert.equal(interim?.textContent, "and the");
    assert.equal(interim?.getAttribute("aria-live"), "off");

    // A new start restarts the count.
    await render(false);
    assert.equal(timer()?.textContent, "00:00");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}));
