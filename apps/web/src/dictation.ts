/**
 * Pure helpers for voice dictation (the browser SpeechRecognition wiring lives in
 * components/useVoiceDictation.ts; this module is framework-free and unit-tested).
 */

/**
 * Append a recognized phrase to the composer draft: single separating space, no leading
 * whitespace buildup, and phrases are trimmed (recognizers pad them inconsistently).
 */
export function appendTranscript(existing: string, phrase: string): string {
  const p = phrase.trim();
  if (!p) return existing;
  if (!existing.trim()) return p;
  return existing.replace(/\s+$/, "") + " " + p;
}

/** Collect the FINAL phrases from a SpeechRecognition result list shape (index-accessible). */
export interface RecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

export function finalTranscripts(results: ArrayLike<RecognitionResultLike>, fromIndex: number): string {
  let out = "";
  for (let i = fromIndex; i < results.length; i++) {
    const r = results[i]!;
    if (r.isFinal) out = appendTranscript(out, r[0].transcript);
  }
  return out;
}
