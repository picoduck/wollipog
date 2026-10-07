import React, { useCallback, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type Ref } from "react";
import { Spinner } from "../common.js";

export interface BusyButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** True while the button's action runs. */
  busy: boolean;
  /** Sentence case, announced politely when the button becomes busy: "Installing the update…". The
   * visible label does not change, so without this the change would be silent to a screen reader. */
  progress: string;
  /** The Title Case label. It stays the same while busy, so the button still names what is running. */
  children: ReactNode;
  /** A leading icon. The spinner takes its place while busy. */
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A button that shows its action running (docs/design-system.md §3.1, Busy).
 *
 * Swapping the label for "Installing…" made the button change width, so its neighbours shifted and
 * a narrow row could wrap, and the label stopped naming the action. Here the label stays, a 14px
 * spinner takes the leading icon's place (or is prepended), and the button is locked to the width it
 * had just before it became busy.
 *
 * A `.btn` without a leading icon carries the spinner's room at rest (`[data-spinner-room]` in
 * styles.css): half the spinner and its gap as extra inline padding on each side, so the label is
 * centred. Busy, the spinner and label move into the button's normal padding at the same width, so
 * neither touches an edge and nothing beside it moves (#2645). Any other class has no reserved room,
 * so there a prepended spinner still takes its room from the inline padding.
 *
 * Busy is `aria-busy` plus `aria-disabled`, not `disabled`: a disabled button drops the focus the
 * person just pressed it with, so the click is refused here instead. The live line is a sibling, since
 * text inside the button would become part of its name.
 */
export function BusyButton({ busy, progress, children, icon, ref, className, style, onClick, type = "button", ...rest }: BusyButtonProps) {
  const button = useRef<HTMLButtonElement | null>(null);
  const idleWidth = useRef(0);
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);

  // The width to keep is the idle one, so it is read after every idle commit: by the time `busy` is
  // true, the spinner is already in the DOM. The computed width ignores transforms, so a toast that
  // is still scaling in does not record a shrunken width.
  useLayoutEffect(() => {
    const view = button.current?.ownerDocument.defaultView;
    if (busy || !button.current || !view) return;
    idleWidth.current = Number.parseFloat(view.getComputedStyle(button.current).width) || 0;
  });
  useLayoutEffect(() => {
    setLockedWidth(busy && idleWidth.current > 0 ? idleWidth.current : null);
  }, [busy]);

  const setRef = useCallback((element: HTMLButtonElement | null) => {
    button.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  }, [ref]);
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (busy) {
      // What `disabled` would do: no default action (a form submit) and no click reaching a
      // clickable row or card around the button.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  };
  // A `.btn` keeps the spinner's room reserved in its idle padding. Without that room, a prepended
  // spinner takes it from the inline padding: inline, so a caller's own padding (a `style` prop or a
  // more specific class) cannot push the spinner and label past the edges.
  const reservesRoom = !icon && (className ?? "").split(/\s+/u).includes("btn");
  const prepended = busy && !icon;
  const lockedStyle = lockedWidth == null ? style : {
    ...style,
    width: lockedWidth,
    minWidth: lockedWidth,
    ...(prepended && !reservesRoom ? { paddingInline: 0 } : {}),
  };

  return (
    <>
      <button
        {...rest}
        ref={setRef}
        type={type}
        className={className}
        style={lockedStyle}
        aria-busy={busy || undefined}
        aria-disabled={busy ? true : rest["aria-disabled"]}
        data-busy-spinner={busy ? (prepended ? "prepended" : "replaced") : undefined}
        data-spinner-room={reservesRoom ? "" : undefined}
        // Only a locked width can give up its padding: a button that mounts busy has no idle width
        // to hold, so a dialog footer's padding rule (styles.css) leaves its padding alone.
        data-width-locked={lockedWidth == null ? undefined : ""}
        onClick={handleClick}
      >
        {busy ? <Spinner decorative /> : icon}
        {children}
      </button>
      <span className="sr-only" role="status">{busy ? progress : ""}</span>
    </>
  );
}
