/**
 * Tap-or-hold dictation on the browser's built-in SpeechRecognition (Chrome/Edge webkit-prefixed;
 * no transcription backend, no audio leaves the page except to the browser's own service).
 * Feature-detected — callers hide the mic entirely when unsupported (e.g. Firefox).
 *
 * One press starts dictation. Released within `HOLD_THRESHOLD_MS` it was a tap, and dictation runs
 * until the next tap, `toggle()` (Enter or Space on the mic) or `stop()` (Escape); held longer it
 * was push-to-talk, and the release stops it. A press the browser cancels, or a mouse that leaves
 * the mic mid-press, stops it too: that gesture never completed (#2193). Sending calls `cancel()`,
 * which drops what the engine has not settled, so what is sent is what the message showed.
 *
 * The engine ends itself in ways that contract must survive: `stop()` finalizes asynchronously
 * (~100ms–1s), and Chrome self-terminates on ~8s of silence ('no-speech') or transient 'network'
 * errors even with continuous=true. So the hook tracks the person's INTENT in a ref and restarts a
 * recognizer from `onend` whenever they still want to dictate and the termination wasn't fatal —
 * the mic stays honest for the whole tap or press.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { finalTranscripts, interimTranscripts } from "../dictation.js";

/* Minimal local typings — SpeechRecognition isn't in TS's standard dom lib. */
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Terminations that must NOT auto-restart (a denied mic would loop forever). */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "aborted"]);

/** A press on the mic this long is push-to-talk: its release stops dictation. */
export const HOLD_THRESHOLD_MS = 400;

export function useVoiceDictation(onPhrase: (text: string) => void) {
  // `recording` is the person's intent, so the mic and the strip answer the press at once; the
  // engine's own asynchronous stop only decides whether a late final phrase still lands.
  const [recording, setRecording] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [interim, setInterim] = useState("");
  // The press that started dictation has lasted past the hold threshold, so releasing it stops.
  const [held, setHeld] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const wantedRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  const pressRef = useRef<{ at: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Keep the callback fresh without re-subscribing the recognizer.
  const onPhraseRef = useRef(onPhrase);
  onPhraseRef.current = onPhrase;

  const supported = typeof window !== "undefined" && recognitionCtor() !== null;

  const endPress = useCallback(() => {
    if (pressRef.current) clearTimeout(pressRef.current.timer);
    pressRef.current = null;
    setHeld(false);
  }, []);

  const settle = useCallback(() => {
    wantedRef.current = false;
    endPress();
    setRecording(false);
    setStartedAt(null);
    setInterim("");
  }, [endPress]);

  const startFresh = useCallback(function startFresh() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (ev) => {
      // `resultIndex` marks only the changed suffix: final phrases are new from there, but a result
      // before it can still be unsettled, so the interim words come from the whole list.
      const text = finalTranscripts(ev.results, ev.resultIndex);
      if (text) onPhraseRef.current(text);
      setInterim(wantedRef.current ? interimTranscripts(ev.results, 0) : "");
    };
    rec.onerror = (ev) => {
      lastErrorRef.current = ev.error ?? "unknown";
    };
    rec.onend = () => {
      recRef.current = null;
      const fatal = FATAL_ERRORS.has(lastErrorRef.current ?? "");
      lastErrorRef.current = null;
      setInterim("");
      if (wantedRef.current && !fatal) {
        // Still wanted: the engine ended on its own (silence timeout, network blip) or the person
        // started again during the async stop window — pick up seamlessly with a fresh recognizer.
        startFresh();
        return;
      }
      if (wantedRef.current) settle();
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      recRef.current = null;
      settle();
    }
  }, [settle]);

  const start = useCallback(() => {
    if (!recognitionCtor() || wantedRef.current) return;
    wantedRef.current = true;
    lastErrorRef.current = null;
    setRecording(true);
    setStartedAt(Date.now());
    setInterim("");
    // If a recognizer is still finalizing a previous stop(), its onend sees the intent and
    // restarts — starting a second instance here would double-capture.
    if (recRef.current) return;
    startFresh();
  }, [startFresh]);

  const stop = useCallback(() => {
    if (!wantedRef.current) return;
    settle();
    // The engine finalizes pending audio after stop(); a final phrase may still arrive.
    recRef.current?.stop();
  }, [settle]);

  /** End dictation and drop whatever the engine has not settled yet (sending, #2193). */
  const cancel = useCallback(() => {
    settle();
    const rec = recRef.current;
    if (!rec) return;
    // Detached first: no late phrase reaches the draft being sent, and the 'aborted' ending cannot
    // settle or restart a dictation started right after.
    recRef.current = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    rec.abort();
  }, [settle]);

  const toggle = useCallback(() => {
    if (wantedRef.current) stop();
    else start();
  }, [start, stop]);

  /** A primary pointer pressed the mic: start if idle, otherwise this tap is the one that stops. */
  const pressStart = useCallback(() => {
    if (wantedRef.current) {
      stop();
      return;
    }
    start();
    if (!wantedRef.current) return;
    const at = Date.now();
    pressRef.current = { at, timer: setTimeout(() => setHeld(true), HOLD_THRESHOLD_MS) };
  }, [start, stop]);

  /** The press that started dictation was released on the mic. */
  const pressEnd = useCallback(() => {
    const press = pressRef.current;
    if (!press) return;
    endPress();
    // The same instant the strip starts saying "Release to stop".
    if (Date.now() - press.at >= HOLD_THRESHOLD_MS) stop();
  }, [endPress, stop]);

  /** The press that started dictation never completed (pointercancel, or leaving the mic). */
  const pressCancel = useCallback(() => {
    if (!pressRef.current) return;
    stop();
  }, [stop]);

  // Never leave the mic hot after unmount (navigation away mid-dictation). Clearing the intent
  // first keeps the 'aborted' onend from restarting.
  useEffect(
    () => () => {
      wantedRef.current = false;
      if (pressRef.current) clearTimeout(pressRef.current.timer);
      recRef.current?.abort();
    },
    [],
  );

  return { supported, recording, startedAt, interim, held, start, stop, cancel, toggle, pressStart, pressEnd, pressCancel };
}
