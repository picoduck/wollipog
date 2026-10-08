/**
 * The composer's text, kept out of the session view's render (#2764).
 *
 * The draft used to be React state at the top of `SessionDetailLoaded`, so every keystroke rendered
 * the whole session view: the transcript, the panels and the session bar, for a change only the
 * textarea shows. The text and caret now live in a `ComposerTextStore` that only the composer's own
 * components subscribe to. The session view reads the store in its callbacks, and in its render it
 * reads only coarse facts derived from the text (is it blank, is a slash token being typed), through
 * `useComposerTextSelector`, which re-renders it only when such a fact changes.
 */

import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEventHandler,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { ComposerButton } from "./ComposerControls.js";

export interface ComposerSelection {
  start: number;
  end: number;
}

export interface ComposerTextSnapshot {
  text: string;
  selection: ComposerSelection;
}

/** The composer's draft text and caret, readable at any time and observable without React state. */
export class ComposerTextStore {
  private snapshot: ComposerTextSnapshot = { text: "", selection: { start: 0, end: 0 } };
  private readonly listeners = new Set<() => void>();
  private committedText = "";

  get text(): string {
    return this.snapshot.text;
  }

  get selection(): ComposerSelection {
    return this.snapshot.selection;
  }

  readonly getSnapshot = (): ComposerTextSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setText(text: string): void {
    if (text === this.snapshot.text) return;
    this.publish({ ...this.snapshot, text });
  }

  setSelection(start: number, end = start): void {
    const current = this.snapshot.selection;
    if (current.start === start && current.end === end) return;
    this.publish({ ...this.snapshot, selection: { start, end } });
  }

  /**
   * Record the draft a textarea has just committed, and say whether it differs from the last one any
   * textarea committed. Kept here rather than in the textarea, because the textarea unmounts (Answer
   * Mode replaces it) while the draft can still change, and the one that mounts next has to know.
   */
  commit(text: string): boolean {
    if (text === this.committedText) return false;
    this.committedText = text;
    return true;
  }

  private publish(next: ComposerTextSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** One store for the life of the component that owns the composer. */
export function useComposerTextStore(): ComposerTextStore {
  const [store] = useState(() => new ComposerTextStore());
  return store;
}

/**
 * A fact derived from the composer's text, re-rendering the caller only when the fact changes.
 *
 * The selector may close over the caller's props and is re-applied on every render of the caller,
 * so it always sees current inputs; `isEqual` decides whether a recomputed fact is still the one
 * already returned, which is what keeps an unchanged object fact from re-rendering per keystroke.
 */
export function useComposerTextSelector<T>(
  store: ComposerTextStore,
  selector: (snapshot: ComposerTextSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cache = useRef<{ snapshot: ComposerTextSnapshot; selector: typeof selector; value: T } | null>(null);
  const select = (): T => {
    const snapshot = store.getSnapshot();
    const prior = cache.current;
    if (prior !== null && prior.snapshot === snapshot && prior.selector === selector) return prior.value;
    const next = selector(snapshot);
    const value = prior !== null && isEqual(prior.value, next) ? prior.value : next;
    cache.current = { snapshot, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, select, select);
}

/** The draft text itself. Only the composer's own components should read it in render. */
export function useComposerText(store: ComposerTextStore): string {
  return useSyncExternalStore(store.subscribe, () => store.text, () => store.text);
}

type ComposerTextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue"> & {
  store: ComposerTextStore;
  ref?: Ref<HTMLTextAreaElement>;
  /**
   * Runs in the layout phase after a changed draft is committed to a textarea, for the work that has
   * to see the new value in the DOM before paint (auto-grow, a pending focus restore). That includes
   * a textarea mounting with a draft that changed while none was mounted, and excludes one mounting
   * with the draft the last one showed: the owner's own layout effects cover that commit.
   */
  onTextCommitted?: () => void;
};

/** The composer's textarea, the one component that renders per keystroke. */
export const ComposerTextarea = memo(function ComposerTextarea({
  store,
  ref,
  onTextCommitted,
  ...props
}: ComposerTextareaProps) {
  const text = useComposerText(store);
  const onTextCommittedRef = useRef(onTextCommitted);
  useLayoutEffect(() => {
    onTextCommittedRef.current = onTextCommitted;
  });
  useLayoutEffect(() => {
    if (store.commit(text)) onTextCommittedRef.current?.();
  }, [store, text]);
  return <textarea {...props} ref={ref} value={text} />;
});

/**
 * The idle phone composer's one-line stand-in: the draft's first words, or the placeholder when
 * there is no draft. It shows the text, so it subscribes to it rather than its owner doing so.
 */
export const ComposerIdlePreview = memo(function ComposerIdlePreview({
  store,
  placeholder,
  onClick,
}: {
  store: ComposerTextStore;
  placeholder: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}) {
  const draft = useComposerText(store).trim();
  return (
    <ComposerButton
      variant="plain"
      className={`composer-idle-preview${draft ? "" : " is-empty"}`}
      aria-label={draft ? `Edit Draft: ${draft}` : placeholder}
      onClick={onClick}
    >
      {draft || placeholder}
    </ComposerButton>
  );
});
