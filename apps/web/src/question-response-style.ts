import { useSyncExternalStore } from "react";

export type QuestionResponseStyle = "interactive" | "text";

export const QUESTION_RESPONSE_STYLE_STORAGE_KEY = "wollipog.question-response-style";
const QUESTION_RESPONSE_STYLE_CHANGE_EVENT = "wollipog:question-response-style-change";
const unstorableChoice = new WeakMap<Window, QuestionResponseStyle>();

export function questionResponseStyle(win: Window = window): QuestionResponseStyle {
  const remembered = unstorableChoice.get(win);
  if (remembered) return remembered;
  try {
    return win.localStorage.getItem(QUESTION_RESPONSE_STYLE_STORAGE_KEY) === "text" ? "text" : "interactive";
  } catch {
    return "interactive";
  }
}

export function setQuestionResponseStyle(value: QuestionResponseStyle, win: Window = window): void {
  try {
    win.localStorage.setItem(QUESTION_RESPONSE_STYLE_STORAGE_KEY, value);
    unstorableChoice.delete(win);
  } catch {
    // Keep the explicit choice effective for this page even when storage is best-effort.
    unstorableChoice.set(win, value);
  }
  win.dispatchEvent(new Event(QUESTION_RESPONSE_STYLE_CHANGE_EVENT));
}

export function useQuestionResponseStyle(): QuestionResponseStyle {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(QUESTION_RESPONSE_STYLE_CHANGE_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(QUESTION_RESPONSE_STYLE_CHANGE_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => questionResponseStyle(),
    () => "interactive",
  );
}
