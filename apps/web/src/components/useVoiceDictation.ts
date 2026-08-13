/**
 * Hold-to-talk dictation on the browser's built-in SpeechRecognition (Chrome/Edge webkit-prefixed;
 * no transcription backend, no audio leaves the page except to the browser's own service).
 * Feature-detected — callers hide the mic entirely when unsupported (e.g. Firefox).
 *
 * The engine ends itself in ways a hold-to-talk contract must survive: `stop()` finalizes
 * asynchronously (~100ms–1s), and Chrome self-terminates on ~8s of silence ('no-speech') or
 * transient 'network' errors even with continuous=true. So the hook tracks HOLD INTENT in a ref
 * and restarts a recognizer from `onend` whenever the user is still holding and the termination
 * wasn't fatal — the mic stays honest for the whole press.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { finalTranscripts } from "../dictation.js";

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

/** Terminations that must NOT auto-restart while held (a denied mic would loop forever). */
const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture", "aborted"]);

export function useVoiceDictation(onPhrase: (text: string) => void) {
  const [recording, setRecording] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const heldRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  // Keep the callback fresh without re-subscribing the recognizer.
  const onPhraseRef = useRef(onPhrase);
  onPhraseRef.current = onPhrase;

  const supported = typeof window !== "undefined" && recognitionCtor() !== null;

  const startFresh = useCallback(function startFresh() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    rec.onresult = (ev) => {
      const text = finalTranscripts(ev.results, ev.resultIndex);
      if (text) onPhraseRef.current(text);
    };
    rec.onerror = (ev) => {
      lastErrorRef.current = ev.error ?? "unknown";
    };
    rec.onend = () => {
      recRef.current = null;
      const fatal = FATAL_ERRORS.has(lastErrorRef.current ?? "");
      lastErrorRef.current = null;
      if (heldRef.current && !fatal) {
        // Still held: the engine ended on its own (silence timeout, network blip) or the user
        // re-pressed during the async stop window — pick up seamlessly with a fresh recognizer.
        startFresh();
        return;
      }
      setRecording(false);
    };
    recRef.current = rec;
    setRecording(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setRecording(false);
    }
  }, []);

  const start = useCallback(() => {
    heldRef.current = true;
    lastErrorRef.current = null;
    // If a recognizer is still finalizing a previous stop(), its onend sees heldRef and
    // restarts — starting a second instance here would double-capture.
    if (recRef.current) return;
    startFresh();
  }, [startFresh]);

  const stop = useCallback(() => {
    heldRef.current = false;
    // `recording` clears in onend — stop() is async in the engine (pending audio finalizes).
    recRef.current?.stop();
  }, []);

  // Never leave the mic hot after unmount (navigation away mid-hold). Clearing the hold flag
  // first keeps the 'aborted' onend from restarting.
  useEffect(
    () => () => {
      heldRef.current = false;
      recRef.current?.abort();
    },
    [],
  );

  return { supported, recording, start, stop };
}
