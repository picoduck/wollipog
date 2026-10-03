import React, { useState, type ReactNode } from "react";
import type { MessageReceiptStatus } from "../conversation-steering.js";
import { statusMeta } from "../status-meta.js";
import { Spinner } from "./common.js";
import { StatusBadge } from "./StatusBadge.js";

/** The attribute every receipt row carries, so the floating control can watch a failed one (#2153). */
export const RECEIPT_ROW_ATTRIBUTE = "data-receipt-id";

/** The ids receipt rows carry, one namespace per kind so a prompt and a steer never collide. */
export const receiptRowId = {
  prompt: (commandId: string) => `prompt:${commandId}`,
  steering: (submissionId: string) => `steering:${submissionId}`,
  command: (invocationId: string) => `command:${invocationId}`,
};

/** How the message's bubble is drawn: dashed while it is on its way, a red edge when it failed, and
 * mono for a provider command. None of them is filled (§11.2). */
export type ReceiptBubbleVariant = "pending" | "failed";

function Separator() {
  return <span className="tl-receipt-sep" aria-hidden="true">·</span>;
}

/**
 * The one line under a sent message that says what happened to it (#2171): the status first, then
 * the reason, then its actions. Sending is a spinner and a word, never a badge. Raw provider text
 * and attempt counts wait behind Show Details, which is not in the DOM until opened (§13.2).
 */
export function ReceiptLine({
  status,
  progress,
  reason,
  reasonId,
  actions,
  details,
  detailsId,
  role,
}: {
  status: MessageReceiptStatus;
  /** A sentence that replaces "Sending" while work is in flight ("Running in Codex…"). */
  progress?: string;
  reason?: string;
  /** Lets an action name the reason as its description. */
  reasonId?: string;
  actions?: ReactNode;
  details?: ReactNode;
  /** The id of the details region, unique on the page. */
  detailsId: string;
  role?: "status";
}) {
  const [open, setOpen] = useState(false);
  const meta = statusMeta("messageReceipt", status);
  const inFlight = status === "sending" || progress !== undefined;
  const trailing = actions !== undefined || details !== undefined;
  return (
    <>
      <div className="tl-receipt" data-status={status} role={role}>
        {/* Status and reason flow as one run of text, so a long reason wraps as prose. */}
        <span className="tl-receipt-text">
          {inFlight ? (
            <span className="tl-receipt-progress">
              <Spinner decorative />
              {progress ?? meta.label}
            </span>
          ) : (
            <StatusBadge meta={meta} inline className="tl-receipt-status" />
          )}
          {reason && (
            <>
              <Separator />
              <span className="tl-receipt-reason" id={reasonId}>{reason}</span>
            </>
          )}
        </span>
        {trailing && (
          <span className="tl-receipt-actions">
            <Separator />
            {actions}
            {details !== undefined && (
              <button
                type="button"
                className="btn ghost sm"
                aria-expanded={open}
                aria-controls={open ? detailsId : undefined}
                onClick={() => setOpen((current) => !current)}
              >
                {open ? "Hide Details" : "Show Details"}
              </button>
            )}
          </span>
        )}
      </div>
      {open && details !== undefined && (
        <div className="tl-receipt-details" id={detailsId}>{details}</div>
      )}
    </>
  );
}

/** A receipt row in the transcript: right-aligned like the person's own messages, with the
 * message's bubble (when it has one) and its receipt line under it. */
export function ReceiptRow({
  receiptId,
  testId,
  bubble,
  bubbleVariant,
  commandBubble = false,
  bubbleId,
  children,
  rowProps,
}: {
  receiptId: string;
  testId: string;
  bubble?: ReactNode;
  bubbleVariant?: ReceiptBubbleVariant;
  /** A provider command's bubble: mono text, with the variant's edge. */
  commandBubble?: boolean;
  bubbleId?: string;
  children: ReactNode;
  rowProps?: Record<`data-${string}`, string | boolean | undefined> & { "aria-busy"?: boolean };
}) {
  return (
    <div
      className="tl-row user tl-receipt-row"
      {...{ [RECEIPT_ROW_ATTRIBUTE]: receiptId }}
      data-testid={testId}
      {...rowProps}
    >
      <div className="tl-message-stack user">
        {bubble !== undefined && (
          <div
            id={bubbleId}
            className={[
              "tl-bubble",
              commandBubble ? "is-command" : "",
              bubbleVariant === "pending" ? "is-pending" : bubbleVariant === "failed" ? "is-failed" : "",
            ].filter(Boolean).join(" ")}
          >
            {bubble}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** The attachment a sent message carried, as the bubble's chip rather than a floating word. */
export function ReceiptAttachmentChip() {
  return (
    <div className="bubble-images">
      <span className="tl-receipt-attachment">Attachment</span>
    </div>
  );
}
