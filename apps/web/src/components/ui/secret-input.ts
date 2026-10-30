import { useCallback, useRef, type ChangeEvent } from "react";

export interface SecretInput {
  /** Attach to the `<input type="password">`. A field that remounts gets back what was typed. */
  ref: (input: HTMLInputElement | null) => void;
  /** Call from the field's onChange; returns what is now typed. */
  remember: (event: ChangeEvent<HTMLInputElement>) => string;
  /** What is typed right now. */
  read: () => string;
  /** Empties the field and forgets what was typed. */
  clear: () => void;
}

/**
 * An uncontrolled secret field (#3814). A React-controlled input mirrors what is typed into its
 * `value` attribute, which puts a pairing link or an API key in `innerHTML` and in any DOM snapshot.
 * Here the secret lives only in the input's live value and in a ref, never in state or an attribute.
 * Callers keep a "has a value" flag in state when a button or a check depends on it.
 */
export function useSecretInput(): SecretInput {
  const node = useRef<HTMLInputElement | null>(null);
  const kept = useRef("");
  const ref = useCallback((input: HTMLInputElement | null) => {
    node.current = input;
    // The live value property, never the attribute: restoring it writes nothing to the DOM.
    if (input && input.value !== kept.current) input.value = kept.current;
  }, []);
  const remember = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    kept.current = event.target.value;
    return kept.current;
  }, []);
  const read = useCallback(() => kept.current, []);
  const clear = useCallback(() => {
    kept.current = "";
    if (node.current) node.current.value = "";
  }, []);
  return { ref, remember, read, clear };
}

/**
 * A callback ref for a secret field whose text lives in a draft the page must keep, such as a
 * secret answer that survives stepping between questions (#3814). The field stays uncontrolled, so
 * React never writes the text to the `value` attribute; this ref writes it to the live value
 * instead, whenever the draft and the field differ. `forward` also receives the input.
 */
export function secretValueRef(
  value: string,
  forward?: { current: HTMLInputElement | null },
): (input: HTMLInputElement | null) => void {
  return (input) => {
    if (forward) forward.current = input;
    if (input && input.value !== value) input.value = value;
  };
}
