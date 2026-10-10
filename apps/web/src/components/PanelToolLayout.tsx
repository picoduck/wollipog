import { useEffect, useState, type FocusEvent, type ReactNode, type Ref } from "react";
import { KEYBOARD_EDITABLE } from "../mobile-viewport.js";

/** Whether focus on this target summons the software keyboard (`KEYBOARD_EDITABLE`). */
function isTextField(target: EventTarget | null): target is HTMLElement {
  const element = target as HTMLElement | null;
  return element?.nodeType === 1 && element.matches(KEYBOARD_EDITABLE);
}

/**
 * A side panel tool laid out as fixed slots around one scroller (docs/design-system.md §4.9; #2846):
 * a fixed `.rpanel-toolbar` above, `.rpanel-scroll` (the tool's only vertical scroller) and an
 * optional fixed `.rpanel-foot` below. Render it as the tool's body, directly inside `.rpanel-body`:
 * the slots are the body's own children, so the body gives up its scroll and padding to them.
 *
 * The toolbar slot is only the place above the scroller; the row inside it is the shared `.toolbar`
 * (§4.7), which the tool renders itself.
 *
 * While a text field inside the scroller has focus, such as Review's finding editor, the foot is
 * marked `is-yielded`, and on a coarse pointer it gives its height to the scroller (#2907): there the
 * software keyboard already takes the sheet's lower part, and the foot's controls can't be used while
 * it serves that field. The foot stays mounted, so whatever it holds is intact when focus leaves.
 */
export function PanelToolLayout({ toolbar, foot, scrollRef, scrollLabel, children }: {
  /** The fixed content above the scroller: normally one `.toolbar` row. */
  toolbar?: ReactNode;
  /** The fixed content below the scroller, such as a commit bar. */
  foot?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  /** Names the scroller as a region when it holds the tool's main content. */
  scrollLabel?: string;
  children: ReactNode;
}) {
  const [writing, setWriting] = useState<HTMLElement | null>(null);
  // A field removed while it has focus may fire no blur: a tap on the finding card's Cancel moves no
  // focus on iOS, and the card that goes is the diff viewer's own state, so nothing here rerenders.
  // While a field is held, any removal under the scroller checks that it is still there.
  useEffect(() => {
    const scroller = writing?.closest(".rpanel-scroll");
    const Observer = writing?.ownerDocument.defaultView?.MutationObserver;
    if (!writing || !scroller || !Observer) return;
    const release = () => {
      if (!writing.isConnected) setWriting(null);
    };
    const observer = new Observer(release);
    observer.observe(scroller, { childList: true, subtree: true });
    release();
    return () => observer.disconnect();
  }, [writing]);
  // React's focus events also bubble out of portals (a dialog opened from the diff), which are not
  // in the scroller: only a field the scroller's own DOM contains counts.
  const fieldIn = (scroller: HTMLDivElement, target: EventTarget | null) =>
    isTextField(target) && scroller.contains(target) ? target : null;
  const onFocus = (event: FocusEvent<HTMLDivElement>) => setWriting(fieldIn(event.currentTarget, event.target));
  // Moving straight from one field in the scroller to another keeps the foot yielded, with no frame
  // in between that would bring it back.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => setWriting(fieldIn(event.currentTarget, event.relatedTarget));
  return (
    <>
      {toolbar != null && toolbar !== false && <div className="rpanel-toolbar">{toolbar}</div>}
      <div
        ref={scrollRef}
        className="rpanel-scroll"
        role={scrollLabel ? "region" : undefined}
        aria-label={scrollLabel}
        // A scroller with no focusable content still has to be reachable by keyboard to scroll.
        tabIndex={scrollLabel ? 0 : undefined}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </div>
      {foot != null && foot !== false && (
        <div className={writing ? "rpanel-foot is-yielded" : "rpanel-foot"}>{foot}</div>
      )}
    </>
  );
}
