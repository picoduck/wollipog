import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type QueuedPromptView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  conversationSteeringAvailability,
  queuedPromptEditingAvailability,
  queuedPromptSteeringAvailability,
  STEERING_UNVERIFIED_REASON,
  type ConversationSteeringAvailabilityInput,
} from "../conversation-steering.js";
import {
  QUEUE_HOLD_RELEASED,
  queueHoldReleaseOutcome,
  requestQueueHoldRelease,
  type QueueHoldReleaseResult,
  type QueueHoldTrayView,
} from "../queue-hold-release.js";
import { isTerminalDeliveryReceipt } from "../session-actions.js";
import { statusMeta, type StatusMeta } from "../status-meta.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ArrowUpIcon, ChevronRightIcon, CloseIcon, EditIcon, MoreHorizontalIcon, PaperclipIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useIsMobile } from "./useIsMobile.js";
import { useRemovedFocus } from "./useRemovedFocus.js";

/** Why a `failed` or `uncertain` durable receipt offers only Dismiss. Worded for both states:
 * uncertain delivery may have landed, but either way no further attempt will be made. */
const TERMINAL_RECEIPT_REASON = "Delivery attempts for this message have ended, so it cannot be steered or edited.";

const HELD_REASON = "Held until the current turn or a pending decision settles. Resolve any visible prompt to continue.";

/** What a queued message reads as in one line: its first line, or what it carries when it has no
 * text. An older runner or control plane reports that a message has attachments but not how many
 * are images, so its message reads "Image attachment". A count of 0 means the attachments are all
 * workspace references. */
export function queuedMessageLabel(prompt: Pick<QueuedPromptView, "text" | "hasImages" | "imageCount">): string {
  const firstLine = prompt.text.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
  if (firstLine) return firstLine;
  if (!prompt.hasImages) return "";
  const count = prompt.imageCount;
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) return "Image attachment";
  if (count === 0) return "Attachment";
  return count === 1 ? "1 image" : `${count} images`;
}

/** The opening words of a queued message, for a sentence that quotes it (the delivery-failure
 * notice). */
export function queuedMessageExcerpt(
  prompt: Pick<QueuedPromptView, "text" | "hasImages" | "imageCount">,
  maxWords = 6,
): string {
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
  /** The row's status, only where it differs from an ordinary queued message (§11.2). */
  statusKey: QueuedRowStatus | null;
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
  /** The worktree or account handoff the queue waits behind (#3752), from `queueHoldTrayView`. */
  queueHold?: QueueHoldTrayView | null;
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

type QueuedRowStatus = "failed" | "uncertain" | "pending_delivery" | "steering";

/** Row statuses the collapsed summary carries, most severe first: the ones that need the person. */
const SUMMARY_STATUSES = ["failed", "uncertain"] as const satisfies readonly QueuedRowStatus[];

function rowStatus(prompt: QueuedPromptView, locallyPromoting: boolean): QueuedRowStatus | null {
  return prompt.durableDeliveryState === "failed"
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
}

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The composer's queue tray (docs/design-system.md §11.2, §19.4; #2178): messages waiting behind
 * the turn, docked on the composer card. It starts as one summary line (#2788): a disclosure that
 * counts them, with the Held badge and the most severe row status beside the count. Expanded, it says
 * once what holds for every row: a held queue, a steering reason they share, a cancel they all lack,
 * a Viewer's refusal. A row carries a status only where it differs from "queued". On a phone each
 * row is its text and one ⋯ button that opens the shared menu sheet, every action listed with its
 * reason. A queue held behind a worktree or account handoff (#3752) says why under the summary,
 * collapsed or expanded, with Proceed Now… for a reader who may end the work it waits on.
 *
 * One queued message is its own row in place of the summary (#3962): the same one line, but with
 * the message's words and a Steer that takes one tap, so steering never waits behind a disclosure
 * and a menu. On a phone that Steer leaves the row's sheet, which keeps Edit and Cancel; when the
 * row cannot steer, the sheet still lists Steer with its reason. On desktop what the expanded tray
 * would say about the row is said under it.
 */
export function QueuedMessages({
  sessionId,
  prompts,
  queueHeld,
  queueHold = null,
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
  const summaryRef = useRef<HTMLButtonElement>(null);
  // The person's choice for this session only: a new session starts collapsed, and nothing but the
  // summary changes it, so arrivals and status updates never open the tray.
  const [disclosure, setDisclosure] = useState({ sessionId, expanded: false });
  const expanded = disclosure.sessionId === sessionId && disclosure.expanded;
  const single = prompts.length === 1;
  // A second arrival brings the summary back, collapsed as the person last left it, unless they are
  // using the lone row: then the tray opens, so the control they hold does not vanish under them.
  const [shape, setShape] = useState({ sessionId, single });
  if (shape.sessionId !== sessionId || shape.single !== single) {
    setShape({ sessionId, single });
    const active = trayRef.current?.ownerDocument.activeElement;
    if (shape.sessionId === sessionId && shape.single && prompts.length > 1 && !expanded && active &&
        (trayRef.current?.contains(active) || active.closest("[data-queue-sheet]") !== null)) {
      setDisclosure({ sessionId, expanded: true });
    }
  }
  const toggleExpanded = () => {
    // Collapsing hides the rows and closes a phone row's sheet (QueuedMessageActionMenu); focus left
    // in either returns to the summary rather than to <body>.
    const summary = summaryRef.current;
    const active = summary?.ownerDocument.activeElement;
    if (expanded && active && active !== summary &&
        (trayRef.current?.contains(active) || active.closest("[data-queue-sheet]") !== null)) {
      summary?.focus();
    }
    setDisclosure({ sessionId, expanded: !expanded });
  };
  // A phone row's action sheet is portalled to <body>, so focus in it is tracked by its marker.
  const focusRemoved = useRemovedFocus(trayRef, "[data-queue-sheet]");
  useLayoutEffect(() => {
    if (!focusRemoved()) return;
    // A queue down to one message loses its summary; focus that was there, or on a control the lone
    // row dropped, stays on the row while it has a control to take it. A sheet still open keeps it
    // first: its Steer item can move onto the row, and focus outside an open sheet escapes its keys.
    const sheetItem = trayRef.current?.ownerDocument.querySelector<HTMLElement>('[data-queue-sheet] [role="menuitem"]');
    const next = single
      ? sheetItem ?? trayRef.current?.querySelector<HTMLButtonElement>(".queue-row button:not(:disabled)")
      : null;
    if (next) next.focus();
    else onFocusLost?.();
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
    const statusKey = rowStatus(prompt, locallyPromoting);
    return {
      prompt,
      terminal,
      statusKey,
      status: statusKey === null ? null : statusMeta("queuedMessage", statusKey),
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

  const summaryStatus = expanded
    ? undefined
    : SUMMARY_STATUSES.find((key) => rows.some((row) => row.statusKey === key));
  const rowsId = `queued-rows-${sessionId}`;

  const describedBy = (row: QueuedRow, action: "steer" | "edit" | "remove"): string | undefined => {
    if (refusal !== null) return refusalId;
    if (action === "remove" && row.remove.kind === "cancel" && row.remove.reason !== null) {
      return sharedCancelReason !== null ? cancelReasonId : `queued-cancel-reason-${row.prompt.id}`;
    }
    return undefined;
  };

  const holdLine = queueHold !== null && (
    <QueueHoldLine key={`${sessionId}\n${queueHold.hold.holdId}`} sessionId={sessionId} view={queueHold} />
  );
  // A phone's lone row keeps every reason in its sheet, so its notes stay hidden like a collapsed
  // tray's; they still describe the controls that reference them.
  const notes = (refusal !== null || held || steeringNote !== null || sharedCancelReason !== null) && (
    <div key="notes" className="queue-notes" hidden={single ? phone : !expanded}>
      {refusal !== null && <p className="queue-note" id={refusalId}>{refusal}</p>}
      {held && <p className="queue-note">{HELD_REASON}</p>}
      {steeringNote !== null && <p className="queue-note">{steeringNote}</p>}
      {sharedCancelReason !== null && <p className="queue-note" id={cancelReasonId}>{sharedCancelReason}</p>}
    </div>
  );
  const rowList = (
    <ul key="rows" id={rowsId} className="queue-rows" hidden={!single && !expanded}>
      {rows.map((row) => {
        const { prompt } = row;
        const editing = editingPromptId === prompt.id;
        const ownCancelReason = row.remove.kind === "cancel" && row.remove.reason !== null &&
          refusal === null && sharedCancelReason === null ? row.remove.reason : null;
        // Where rows differ, an ordinary row that cannot steer says why on its own line; a row with
        // a status is explained by it, and a reason every row shares is said once above the rows.
        const ownSteerReason = !row.terminal && row.status === null && steeringNote === null && !held
          ? row.steerUnavailable
          : null;
        // A phone's lone row steers in one tap whenever the person may steer it; a Viewer's
        // refusal stays in the sheet, where a phone can read it.
        const steerInline = phone ? single && row.steerShown && refusal === null : row.steerShown;
        const steerButton = steerInline && (
          <button
            type="button"
            className="btn sm ghost queue-steer"
            disabled={row.steer.reason !== null}
            title={row.steer.reason ?? "Send this message into the current turn."}
            aria-label="Steer Queued Message"
            aria-describedby={describedBy(row, "steer")}
            onClick={() => onSteer(prompt)}
          >
            Steer
          </button>
        );
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
            {/* With no summary, the lone row carries the queue's Held badge. */}
            {single && held && <StatusBadge meta={statusMeta("queuedMessage", "held")} inline className="queue-held" />}
            {phone ? (
              <>
                {steerButton}
                <QueuedMessageActionMenu row={row} concealed={!single && !expanded} steerInline={steerInline}
                  onSteer={onSteer} onEdit={onEdit} onCancel={onCancel} onDismiss={onDismiss} />
              </>
            ) : (
              <>
                <div className="queue-actions">
                  {steerButton}
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
  );

  const summary = (
    <button
      key="summary"
      ref={summaryRef}
      type="button"
      className="disclosure-trigger queue-summary"
      aria-expanded={expanded}
      aria-controls={rowsId}
      onClick={toggleExpanded}
    >
      <ChevronRightIcon className="disclosure-chevron" />
      <span className="queue-count">{prompts.length} Queued Messages</span>
      {held && <StatusBadge meta={statusMeta("queuedMessage", "held")} inline />}
      {summaryStatus !== undefined && (
        <StatusBadge meta={statusMeta("queuedMessage", summaryStatus)} inline />
      )}
    </button>
  );
  // Keyed, so the row list moves rather than remounts when the queue grows past one or shrinks to
  // it: a row's open sheet and focused control survive the change.
  return (
    <section ref={trayRef} className={`queue${single ? " is-single" : ""}${phone ? " is-phone" : ""}`}
      aria-label="Queued Messages">
      {single ? [rowList, holdLine, notes] : [summary, holdLine, notes, rowList]}
    </section>
  );
}

/**
 * Why a handoff holds the queue, and Proceed Now… (#3752). Shown under the summary whether the tray
 * is collapsed or expanded, since the hold is what the person is waiting on. Proceed Now asks first,
 * in the shared danger confirmation with Cancel focused, mirroring Stop Job…; the request names the
 * hold that was on screen when the confirmation opened, and is sent only if that hold is still shown
 * and still releasable when it is answered. The tray keys this line by session and hold, so a new hold
 * starts with no outcome.
 */
function QueueHoldLine({ sessionId, view }: { sessionId: string; view: QueueHoldTrayView }) {
  const api = useApi();
  const { confirm } = useFeedback();
  const reasonId = useId();
  const unavailableId = useId();
  const [outcome, setOutcome] = useState<"pending" | QueueHoldReleaseResult | null>(null);
  const inFlight = useRef(false);
  const shown = useRef({ mounted: false, available: false });
  shown.current = { ...shown.current, available: view.release?.available === true };
  useEffect(() => {
    shown.current.mounted = true;
    return () => { shown.current.mounted = false; };
  }, []);
  const { hold, release } = view;
  const proceed = async () => {
    if (inFlight.current) return;
    const holdId = hold.holdId;
    const confirmed = await confirm({
      title: "Proceed Now",
      message: queueHoldReleaseOutcome(hold),
      confirmLabel: "Proceed Now",
      tone: "danger",
    });
    if (!confirmed || inFlight.current || !shown.current.mounted || !shown.current.available) return;
    inFlight.current = true;
    setOutcome("pending");
    const result = await requestQueueHoldRelease(api, sessionId, holdId);
    inFlight.current = false;
    if (shown.current.mounted) setOutcome(result);
  };
  const released = outcome !== null && outcome !== "pending" && outcome.state === "released";
  return (
    <div className="queue-hold">
      <p className="queue-note" id={reasonId}>{view.reason}</p>
      {release !== null && !released && (release.available ? (
        <BusyButton
          className="btn sm"
          busy={outcome === "pending"}
          progress="Proceeding…"
          aria-describedby={reasonId}
          onClick={() => void proceed()}
        >
          Proceed Now…
        </BusyButton>
      ) : (
        <>
          <button type="button" className="btn sm" disabled aria-describedby={unavailableId}>Proceed Now…</button>
          <p className="queue-note" id={unavailableId}>{release.reason}</p>
        </>
      ))}
      {released && <p className="queue-note" role="status">{QUEUE_HOLD_RELEASED}</p>}
      {outcome !== null && outcome !== "pending" && outcome.state === "error" && (
        <Notice tone="danger" compact role="alert">{outcome.message}</Notice>
      )}
    </div>
  );
}

/** A phone row's one ⋯ button and its sheet: every action listed, each disabled one with its
 * reason as the visible second line (§9.1), except a Steer the row already shows beside it. */
function QueuedMessageActionMenu({ row, concealed, steerInline, onSteer, onEdit, onCancel, onDismiss }: {
  row: QueuedRow;
  /** The tray is collapsed, hiding this row. */
  concealed: boolean;
  /** The row shows its own Steer button (a lone queued message, #3962). */
  steerInline: boolean;
  onSteer: (prompt: QueuedPromptView) => void;
  onEdit: (prompt: QueuedPromptView) => void;
  onCancel: (prompt: QueuedPromptView) => void;
  onDismiss: (prompt: QueuedPromptView) => void;
}) {
  const [open, setOpen] = useState(false);
  // The sheet is portalled to <body>, so hiding the row would not hide it: a collapse closes it. The
  // summary that collapsed the tray already holds any focus the sheet had.
  if (concealed && open) setOpen(false);
  // Unavailable items stay reachable, so a keyboard or screen-reader user hears each reason.
  const menu = useAccessibleMenu(open, setOpen, "queued-message-actions", "menu", { reachUnavailable: true });
  const { prompt } = row;
  const label = "Queued Message Actions";
  const items = [
    ...(steerInline ? [] : [{ key: "steer", label: "Steer into This Turn", icon: <ArrowUpIcon />, reason: row.steer.reason,
      run: () => onSteer(prompt) }]),
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
