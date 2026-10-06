import React, { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import type { SessionCondition, SessionStatusSummary } from "../status-meta.js";
import type { DismissiblePopoverController } from "./interactions.js";
import { MenuSurface } from "./Menu.js";
import { DETAIL_TITLE_READABLE_PX } from "./PageHeader.js";
import { StatusBadge, StatusCount } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useIsCompact } from "./useIsMobile.js";

/** Where each condition's action leads. A condition whose place is not wired here has no action. */
export interface SessionStatusActions {
  /** Opens the session's own requests: the request panel, or Agents for a worker's request. */
  onOpenAttention?: () => void;
  /** Opens the Requests panel's list of child requests (#2206). */
  onOpenChildRequests?: () => void;
  onOpenBackgroundWork?: () => void;
  onOpenWorkers?: () => void;
  /** The step a background result that waits on the person takes from its row (#2275): Stop Job…
   * for Result Blocked, Acknowledge Missing Result for Result Missing. Absent where this surface
   * cannot take it, so the row opens Background Work instead. */
  deliveryStep?: SessionStatusStep;
}

/** An action a row runs itself rather than opening a panel. */
export interface SessionStatusStep {
  label: string;
  /** Sentence case, announced while the step's request runs. */
  progress: string;
  /** Its request is in flight: the button stays, busy, and refuses another press. */
  busy: boolean;
  run: () => void;
}

interface ConditionAction {
  label: string;
  /** Set where the visible label alone does not say what opens. */
  ariaLabel?: string;
  run: () => void;
  /** Set for a step that runs a request, which draws the button busy while it runs. */
  progress?: string;
  busy?: boolean;
}

function conditionAction(condition: SessionCondition, actions: SessionStatusActions): ConditionAction | null {
  const action = (label: string, run: (() => void) | undefined, ariaLabel?: string) =>
    run ? { label, ariaLabel, run } : null;
  switch (condition.kind) {
    case "attention":
      return condition.attentionKind === "answer_required" || condition.attentionKind === "recovery_required"
        ? action("Answer", actions.onOpenAttention)
        : condition.attentionKind === "authentication_required"
          ? action("Sign In…", actions.onOpenAttention)
          : action("Review Request", actions.onOpenAttention);
    case "child_requests":
      return action("Open Requests", actions.onOpenChildRequests);
    case "background_delivery":
      if (condition.needsYou && actions.deliveryStep) {
        const step = actions.deliveryStep;
        return { label: step.label, run: step.run, progress: step.progress, busy: step.busy };
      }
      return action("Open", actions.onOpenBackgroundWork, "Open Background Work");
    case "background_work":
      return action("Open", actions.onOpenBackgroundWork, "Open Background Work");
    case "workers":
      return action("Open Agents", actions.onOpenWorkers);
    default:
      return null;
  }
}

function requestCount(count: number): string {
  return `${count} ${count === 1 ? "Request" : "Requests"}`;
}

function conditionName(condition: SessionCondition): string {
  return condition.count === undefined ? condition.meta.label : `${condition.meta.label}, ${requestCount(condition.count)}`;
}

/** A row's identity: the same condition keeps its row, and its focused action, as others come and go. */
function conditionKey(condition: SessionCondition): string {
  return condition.kind === "attention" ? `attention:${condition.attentionKind}:${condition.meta.label}` : condition.kind;
}

/** The count is drawn as a hidden numeral and said in words, so a row's badge reads "Approval
 * Required, 2 Requests" to a screen reader as it does to the eye. */
export function ConditionBadge({ condition }: { condition: SessionCondition }) {
  return (
    <StatusBadge meta={condition.meta}>
      {condition.count !== undefined && (
        <>
          <StatusCount>{condition.count}</StatusCount>
          <span className="sr-only">, {requestCount(condition.count)}</span>
        </>
      )}
    </StatusBadge>
  );
}

/**
 * The Session Status control (docs/design-system.md §4.3, §9.2, #2182): one ghost button right
 * after the title holding the session's one status badge (`sessionStatusSummary()`) and, when other
 * conditions need the person, a plain "+N". It opens the Session Status popover, which lists every
 * condition with one sentence and the action that resolves it; on a phone that is a bottom sheet.
 *
 * In the compact tier (761–1099px, §15.2) the badge is drawn as its dot and label. Where that would
 * leave a truncated title under `DETAIL_TITLE_READABLE_PX`, the badge becomes its dot alone with the
 * label in the tooltip, measured against the dot-and-label form every time, as `DetailBar` does. At
 * 1100px and wider, and on phones, it is always the full badge.
 */
export function SessionStatusButton({
  summary,
  open,
  popover,
  onToggle,
  onTriggerKeyDown,
  titleRef,
  small = false,
  actions,
}: {
  summary: SessionStatusSummary;
  open: boolean;
  popover: DismissiblePopoverController;
  /** Opens or closes the popover; the bar closes its other menus first. */
  onToggle: () => void;
  onTriggerKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  /** The bar's title, whose readable width decides the compact dot. Absent on phones. */
  titleRef?: RefObject<HTMLElement | null>;
  /** The phone line's small size: 36px, borrowing a 44px target on touch like Share (§2.8). */
  small?: boolean;
  actions: SessionStatusActions;
}) {
  const { primary, more, conditions } = summary;
  const name = `Session Status: ${conditionName(primary)}${more > 0 ? ` and ${more} More` : ""}`;
  const tooltip = `${primary.meta.label}${more > 0 ? ` and ${more} more` : ""}`;
  // Phones have no title in this bar, so only a desktop bar in the compact tier ever measures.
  const compact = useIsCompact() && titleRef !== undefined;

  // The attribute and tooltip are written straight to the DOM inside one layout pass, as DetailBar
  // does: React does not own them, and nothing paints between taking them off and putting them back.
  useLayoutEffect(() => {
    const trigger = popover.triggerRef.current;
    if (!trigger) return;
    // Cleared first, every time: the same button stays mounted when a compact window narrows to a
    // phone, where there is no title to measure and the badge must be whole again.
    trigger.removeAttribute("data-dot");
    trigger.removeAttribute("title");
    const title = titleRef?.current;
    if (!title) return;
    const measure = () => {
      trigger.removeAttribute("data-dot");
      trigger.removeAttribute("title");
      if (!compact) return;
      const truncated = title.scrollWidth > title.clientWidth;
      if (!truncated || title.clientWidth >= DETAIL_TITLE_READABLE_PX) return;
      trigger.setAttribute("data-dot", "");
      trigger.title = tooltip;
    };
    measure();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    // The bar's width is set by the pane, never by the badge, so a collapse cannot re-trigger it.
    const bar = trigger.parentElement;
    const observer = typeof ResizeObserver === "undefined" || !bar ? null : new ResizeObserver(measure);
    if (bar) observer?.observe(bar);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  });

  // A popover with nothing to act on holds focus itself, so Escape and Tab still work from it.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = popover.panelRef.current;
    if (panel && !panel.querySelector("button")) panel.focus();
  }, [open, popover.panelRef]);

  // A live update can remove the row whose action holds focus. The browser then drops focus to
  // <body>, outside the dialog and its Escape handler, so it is taken back to the dialog: lost focus
  // only, never focus that has moved somewhere else. Where focus last landed is read from `focusin`,
  // which a removal never fires (a `focusout` from the removed node would read as leaving).
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    const onFocusIn = (event: FocusEvent) => {
      focusInside.current = popover.panelRef.current?.contains(event.target as Node) ?? false;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      focusInside.current = false;
    };
  }, [open, popover.panelRef]);
  useLayoutEffect(() => {
    if (!open) return;
    const panel = popover.panelRef.current;
    const active = document.activeElement;
    if (focusInside.current && panel && (active === null || active === document.body || !active.isConnected)) {
      panel.focus();
    }
  });

  const run = (action: ConditionAction) => {
    // The row's button unmounts with the popover, so the trigger takes focus first. A panel the
    // action opens then records the trigger, not <body>, as where to return focus when it closes,
    // and the action is still free to move focus into what it opens.
    popover.triggerRef.current?.focus();
    popover.close(false);
    action.run();
  };

  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        className={small ? "btn sm ghost session-status-button" : "btn ghost session-status-button"}
        data-compact={compact ? "" : undefined}
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popover.panelId : undefined}
        onClick={onToggle}
        onKeyDown={onTriggerKeyDown}
      >
        <ConditionBadge condition={primary} />
        {more > 0 && <span className="session-status-more" aria-hidden="true">+{more}</span>}
      </button>
      {open && (
        <MenuSurface
          surfaceRef={popover.panelRef}
          anchor={{ trigger: popover.triggerRef }}
          id={popover.panelId}
          kind="popover"
          role="dialog"
          label="Session Status"
          head={<div className="menu-head session-status-head" aria-hidden="true">Session Status</div>}
          width={340}
          tabIndex={-1}
          onDismiss={() => popover.close(true)}
          onKeyDown={popover.onPanelKeyDown}
        >
          <ul className="session-status-rows">
            {conditions.map((condition) => {
              const action = conditionAction(condition, actions);
              return (
                <li key={conditionKey(condition)} className="session-status-row">
                  {condition.fact
                    ? <span className="session-status-fact">{condition.meta.label}</span>
                    : <ConditionBadge condition={condition} />}
                  {action && (action.progress === undefined ? (
                    <button type="button" className="btn sm session-status-action" aria-label={action.ariaLabel}
                      onClick={() => run(action)}>
                      {action.label}
                    </button>
                  ) : (
                    <BusyButton className="btn sm session-status-action" busy={action.busy ?? false}
                      progress={action.progress} onClick={() => run(action)}>
                      {action.label}
                    </BusyButton>
                  ))}
                  <p className="session-status-text">{condition.description}</p>
                </li>
              );
            })}
          </ul>
        </MenuSurface>
      )}
    </>
  );
}
