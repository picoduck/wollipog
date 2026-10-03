import React, { useLayoutEffect, useRef, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type QueuedPromptView,
} from "@wollipog/protocol";
import {
  conversationSteeringAvailability,
  queuedPromptEditingAvailability,
  queuedPromptSteeringAvailability,
  STEERING_UNVERIFIED_REASON,
  type ConversationSteeringAvailabilityInput,
} from "../conversation-steering.js";
import { isTerminalDeliveryReceipt } from "../session-actions.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { ArrowUpIcon, CloseIcon, EditIcon, MoreHorizontalIcon, PaperclipIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { StatusBadge } from "./StatusBadge.js";
import { useIsMobile } from "./useIsMobile.js";
import { useRemovedFocus } from "./useRemovedFocus.js";

/** Why a `failed` or `uncertain` durable receipt offers only Dismiss. Worded for both states:
 * uncertain delivery may have landed, but either way no further attempt will be made. */
const TERMINAL_RECEIPT_REASON = "Delivery attempts for this message have ended, so it cannot be steered or edited.";

const HELD_REASON = "Held until the current turn or a pending decision settles. Resolve any visible prompt to continue.";

/** What a queued message reads as in one line: its first line, or what it carries when it has no
 * text. The queue only knows that a message has images, not how many. */
export function queuedMessageLabel(prompt: Pick<QueuedPromptView, "text" | "hasImages">): string {
  const firstLine = prompt.text.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
  if (firstLine) return firstLine;
  return prompt.hasImages ? "Image attachment" : "";
}

/** The opening words of a queued message, for a sentence that quotes it (the delivery-failure
 * notice). */
export function queuedMessageExcerpt(prompt: Pick<QueuedPromptView, "text" | "hasImages">, maxWords = 6): string {
  const words = queuedMessageLabel(prompt).split(/\s+/u).filter(Boolean);
  const excerpt = words.slice(0, maxWords).join(" ");
  return words.length > maxWords ? `${excerpt}…` : excerpt;
}

interface QueuedMessageAction {
  /** Why the action cannot run now; null when it can. */
  reason: string | null;
}

/** One row's state and actions, worked out once for both layouts. */
interface QueuedRow {
  prompt: QueuedPromptView;
  terminal: boolean;
  /** The row's status badge, only where it differs from an ordinary queued message (§11.2). */
  status: StatusMeta | null;
  /** Steering works for this row, so desktop shows Steer. */
  steerShown: boolean;
  /** Why steering does not work for this row, when it does not. */
  steerUnavailable: string | null;
  steer: QueuedMessageAction;
  edit: QueuedMessageAction;
  /** Cancel for work that may still run; Dismiss for a settled receipt. */
  remove: QueuedMessageAction & { kind: "cancel" | "dismiss"; busy: boolean };
}

export interface QueuedMessagesProps {
  sessionId: string;
  prompts: readonly QueuedPromptView[];
  queueHeld: boolean;
  /** The agent's name, for the sentence that says why nothing can steer. */
  agent: string;
  /** The session's steering gates, evaluated once for the whole queue. */
  steering: ConversationSteeringAvailabilityInput;
  /** A message request (send, steer, edit) is in flight. */
  requestBusy: boolean;
  /** Why the signed-in person may not manage the queue (a Viewer, #1857), or null. */
  refusal: string | null;
  /** Rows whose Steer this page has submitted and not yet heard back on. */
  steeringPending: ReadonlySet<string>;
  /** The row the composer is editing, if any. */
  editingPromptId: string | null;
  /** The composer holds a queued edit (of any row). */
  editOpen: boolean;
  /** A cancel or dismiss request in flight. */
  pendingAction: { commandId: string; action: string } | undefined;
  onSteer: (prompt: QueuedPromptView) => void;
  onEdit: (prompt: QueuedPromptView) => void;
  onCancel: (prompt: QueuedPromptView) => void;
  onDismiss: (prompt: QueuedPromptView) => void;
  /** Where focus goes when the control that held it leaves (a Steer that became Steering…, a row
   * that was canceled). */
  onFocusLost?: () => void;
}

function rowStatus(prompt: QueuedPromptView, locallyPromoting: boolean): StatusMeta | null {
  const value = prompt.durableDeliveryState === "failed"
    ? "failed"
    : prompt.durableDeliveryState === "uncertain"
      ? "uncertain"
      : prompt.durableDeliveryState === "pending"
        ? "pending_delivery"
        : locallyPromoting || prompt.steeringState === "promoting"
          ? "steering"
          : prompt.steeringState === "uncertain"
            ? "uncertain"
            : null;
  return value === null ? null : statusMeta("queuedMessage", value);
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The composer's queue tray (docs/design-system.md §11.2, §19.4; #2178): messages waiting behind
 * the turn, docked on the composer card. One header counts them and says once what holds for every
 * row: a held queue, a steering reason they share, a cancel they all lack, a Viewer's refusal. A row
 * carries a status only where it differs from "queued". On a phone each row is its text and one ⋯
 * button that opens the shared menu sheet, every action listed with its reason.
 */
export function QueuedMessages({
  sessionId,
  prompts,
  queueHeld,
  agent,
  steering,
  requestBusy,
  refusal,
  steeringPending,
  editingPromptId,
  editOpen,
  pendingAction,
  onSteer,
  onEdit,
  onCancel,
  onDismiss,
  onFocusLost,
}: QueuedMessagesProps) {
  const phone = useIsMobile();
  const trayRef = useRef<HTMLElement>(null);
  // A phone row's action sheet is portalled to <body>, so focus in it is tracked by its marker.
  const focusRemoved = useRemovedFocus(trayRef, "[data-queue-sheet]");
  useLayoutEffect(() => {
    if (focusRemoved()) onFocusLost?.();
  });

  const canCancel = runnerSupportsProtocol(steering.runnerProtocolVersion, "queuedPromptCancellation");
  const rows: QueuedRow[] = prompts.map((prompt) => {
    const terminal = isTerminalDeliveryReceipt(prompt);
    const locallyPromoting = steeringPending.has(prompt.id);
    const reserved = prompt.steeringState === "promoting" || prompt.steeringState === "uncertain";
    const availability = queuedPromptSteeringAvailability(steering, prompt);
    const editAvailability = queuedPromptEditingAvailability({
      runnerProtocolVersion: steering.runnerProtocolVersion,
      runnerOnline: steering.runnerOnline,
      requestBusy,
    }, prompt);
    const steerReason = refusal ?? (terminal
      ? TERMINAL_RECEIPT_REASON
      : locallyPromoting
        ? "Steering is being submitted for this queued message."
        : !availability.available
          ? availability.reason
          : requestBusy
            ? "Wait for the current message request to finish."
            : null);
    const editReason = refusal ?? (terminal
      ? TERMINAL_RECEIPT_REASON
      : editingPromptId === prompt.id
        ? "This queued message is already being edited."
        : editOpen
          ? "Finish editing the other queued message first."
          : !editAvailability.available
            ? editAvailability.reason
            : null);
    // A terminal durable receipt records delivery that has already stopped, so it can never be
    // canceled. It carries dismissal instead: cancellation removes work that may still run,
    // dismissal only hides settled evidence.
    const remove: QueuedRow["remove"] = terminal
      ? {
          kind: "dismiss",
          busy: pendingAction?.commandId === prompt.id && pendingAction.action === "dismiss",
          reason: refusal ?? (pendingAction !== undefined ? "Wait for the current message action to finish." : null),
        }
      : {
          kind: "cancel",
          busy: false,
          reason: refusal ?? (!canCancel
            ? runnerCapabilityRequirement(steering.runnerProtocolVersion, "queuedPromptCancellation",
              "queued prompt cancellation")
            : reserved || locallyPromoting
              ? "Resolve steering before canceling this queued message."
              : prompt.durableDeliveryState !== undefined
                ? "This message can't be canceled until its machine accepts it."
                : null),
        };
    return {
      prompt,
      terminal,
      status: rowStatus(prompt, locallyPromoting),
      steerShown: !terminal && !locallyPromoting && availability.available,
      steerUnavailable: availability.available ? null : availability.reason,
      steer: { reason: steerReason },
      edit: { reason: editReason },
      remove,
    };
  });
  // Mounted while the queue is empty too, so focus held by the last row's control still has
  // somewhere to go when that row leaves.
  if (rows.length === 0) return null;

  // What holds for every row is said once, in the header, rather than on each row.
  const live = rows.filter((row) => !row.terminal);
  const refusalId = `queued-refusal-${sessionId}`;
  const cancelReasonId = `queued-cancel-reason-${sessionId}`;
  const held = queueHeld && live.length > 0;
  let steeringNote: string | null = null;
  if (!held && live.length > 0) {
    const session = conversationSteeringAvailability(steering);
    if (!session.available) {
      steeringNote = session.reason === STEERING_UNVERIFIED_REASON
        ? `${sentenceStart(agent)} can't take steering mid-turn, so ${live.length === 1 ? "this sends" : "these send"} when the turn ends.`
        : session.reason;
    } else {
      const reasons = live.map((row) => queuedPromptSteeringAvailability(steering, row.prompt));
      const first = reasons[0];
      if (first && !first.available && reasons.every((reason) => !reason.available && reason.reason === first.reason)) {
        steeringNote = first.reason;
      }
    }
  }
  const cancelReasons = live.map((row) => row.remove.reason);
  const sharedCancelReason = refusal === null && cancelReasons.length > 0 &&
    cancelReasons.every((reason) => reason !== null && reason === cancelReasons[0])
    ? cancelReasons[0]
    : null;

  const describedBy = (row: QueuedRow, action: "steer" | "edit" | "remove"): string | undefined => {
    if (refusal !== null) return refusalId;
    if (action === "remove" && row.remove.kind === "cancel" && row.remove.reason !== null) {
      return sharedCancelReason !== null ? cancelReasonId : `queued-cancel-reason-${row.prompt.id}`;
    }
    return undefined;
  };

  return (
    <section ref={trayRef} className={`queue${phone ? " is-phone" : ""}`} aria-label="Queued Messages">
      <div className="queue-head">
        <span className="queue-count">{prompts.length} Queued</span>
        {held && <StatusBadge meta={statusMeta("queuedMessage", "held")} inline />}
        {refusal !== null && <p className="queue-note" id={refusalId}>{refusal}</p>}
        {held && <p className="queue-note">{HELD_REASON}</p>}
        {steeringNote !== null && <p className="queue-note">{steeringNote}</p>}
        {sharedCancelReason !== null && <p className="queue-note" id={cancelReasonId}>{sharedCancelReason}</p>}
      </div>
      <ul className="queue-rows">
        {rows.map((row) => {
          const { prompt } = row;
          const editing = editingPromptId === prompt.id;
          const ownCancelReason = row.remove.kind === "cancel" && row.remove.reason !== null &&
            refusal === null && sharedCancelReason === null ? row.remove.reason : null;
          // Where rows differ, an ordinary row that cannot steer says why on its own line; a row with
          // a status is explained by it, and a reason every row shares is in the header.
          const ownSteerReason = !row.terminal && row.status === null && steeringNote === null && !held
            ? row.steerUnavailable
            : null;
          return (
            <li
              key={prompt.id}
              className="queue-row"
              data-testid={`queued-prompt-${prompt.id}`}
              aria-current={editing ? "true" : undefined}
            >
              {row.status && (
                <StatusBadge meta={row.status} inline className="queue-status" title={row.steer.reason ?? undefined} />
              )}
              <span className="queue-text" title={prompt.text || undefined}>
                {prompt.hasImages && <PaperclipIcon size={14} className="queue-clip" aria-hidden="true" />}
                {queuedMessageLabel(prompt)}
              </span>
              {phone ? (
                <QueuedMessageActionMenu row={row} onSteer={onSteer} onEdit={onEdit} onCancel={onCancel}
                  onDismiss={onDismiss} />
              ) : (
                <>
                  <div className="queue-actions">
                    {row.steerShown && (
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={row.steer.reason !== null}
                        title={row.steer.reason ?? "Send this message into the current turn."}
                        aria-label="Steer Queued Message"
                        aria-describedby={describedBy(row, "steer")}
                        onClick={() => onSteer(prompt)}
                      >
                        Steer
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-btn sm"
                      disabled={row.edit.reason !== null}
                      title={row.edit.reason ?? "Edit this queued message."}
                      aria-label="Edit Queued Message"
                      aria-describedby={describedBy(row, "edit")}
                      onClick={() => onEdit(prompt)}
                    >
                      <EditIcon size={14} />
                    </button>
                    {row.remove.kind === "dismiss" ? (
                      <button
                        type="button"
                        className="icon-btn sm"
                        disabled={row.remove.reason !== null}
                        aria-busy={row.remove.busy || undefined}
                        title={refusal ?? "Remove this delivery receipt. The message already recorded in the transcript is kept, and no provider work is canceled, resent, or restarted."}
                        aria-label={prompt.durableDeliveryState === "failed"
                          ? "Dismiss Failed Message"
                          : "Dismiss Uncertain Message"}
                        aria-describedby={describedBy(row, "remove")}
                        onClick={() => onDismiss(prompt)}
                      >
                        <CloseIcon size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn sm"
                        disabled={row.remove.reason !== null}
                        title={row.remove.reason ?? "Cancel this queued message."}
                        aria-label="Cancel Queued Message"
                        aria-describedby={describedBy(row, "remove")}
                        onClick={() => onCancel(prompt)}
                      >
                        <CloseIcon size={14} />
                      </button>
                    )}
                  </div>
                  {ownSteerReason !== null && <span className="queue-reason">{ownSteerReason}</span>}
                  {ownCancelReason !== null && (
                    <span className="queue-reason" id={`queued-cancel-reason-${prompt.id}`}>{ownCancelReason}</span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A phone row's one ⋯ button and its sheet: every action listed, each disabled one with its
 * reason as the visible second line (§9.1). */
function QueuedMessageActionMenu({ row, onSteer, onEdit, onCancel, onDismiss }: {
  row: QueuedRow;
  onSteer: (prompt: QueuedPromptView) => void;
  onEdit: (prompt: QueuedPromptView) => void;
  onCancel: (prompt: QueuedPromptView) => void;
  onDismiss: (prompt: QueuedPromptView) => void;
}) {
  const [open, setOpen] = useState(false);
  // Unavailable items stay reachable, so a keyboard or screen-reader user hears each reason.
  const menu = useAccessibleMenu(open, setOpen, "queued-message-actions", "menu", { reachUnavailable: true });
  const { prompt } = row;
  const label = "Queued Message Actions";
  const items = [
    { key: "steer", label: "Steer into This Turn", icon: <ArrowUpIcon />, reason: row.steer.reason,
      run: () => onSteer(prompt) },
    { key: "edit", label: "Edit Message", icon: <EditIcon />, reason: row.edit.reason, run: () => onEdit(prompt) },
    row.remove.kind === "dismiss"
      ? { key: "dismiss", label: "Dismiss Message", icon: <CloseIcon />, reason: row.remove.reason,
          run: () => onDismiss(prompt) }
      : { key: "cancel", label: "Cancel Message", icon: <CloseIcon />, reason: row.remove.reason,
          run: () => onCancel(prompt) },
  ];
  const select = (item: (typeof items)[number]) => {
    if (item.reason !== null) return;
    // Focus the trigger before the action runs, so whatever it moves focus to starts from here.
    menu.triggerRef.current?.focus();
    menu.close(false);
    item.run();
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn queue-more"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
      >
        <MoreHorizontalIcon size={16} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          data-queue-sheet=""
          label={label}
          align="end"
          tabIndex={-1}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {items.map((item) => (
            <MenuItem
              key={item.key}
              icon={item.icon}
              data-menu-label={item.label}
              aria-disabled={item.reason === null ? undefined : true}
              description={item.reason ?? undefined}
              onClick={() => select(item)}
            >
              {item.label}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );
}
