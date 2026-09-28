import React, { type ReactNode } from "react";
import { CloseIcon, ErrorIcon, InfoIcon, SuccessIcon, WarningIcon } from "./Icons.js";

export type NoticeTone = "info" | "success" | "warning" | "danger" | "neutral";

/** The 16px icon that carries a tone, so a notice or toast never depends on colour alone (§13). */
export function ToneIcon({ tone }: { tone: NoticeTone }) {
  return tone === "success" ? <SuccessIcon />
    : tone === "warning" ? <WarningIcon />
      : tone === "danger" ? <ErrorIcon />
        : <InfoIcon />;
}

export interface NoticeProps {
  tone?: NoticeTone;
  /** Optional Title Case title, above a sentence-case body. */
  title?: ReactNode;
  /** The body: one or two sentences in sentence case. */
  children?: ReactNode;
  /** A left-aligned row of `.btn.sm` actions, the resolving action first. */
  actions?: ReactNode;
  /** Adds an icon dismiss button with this handler. */
  onDismiss?: () => void;
  dismissLabel?: string;
  dismissDisabled?: boolean;
  /** One line: icon, sentence and a trailing action (field and composer notices). */
  compact?: boolean;
  /** Spans the top of the main area for offline, pairing and held-update states (§13.3). */
  pageBanner?: boolean;
  as?: "div" | "section" | "aside";
  role?: "status" | "alert" | "note" | "region";
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaBusy?: boolean;
  /** Hides a notice whose words another live notice already announces. */
  ariaHidden?: boolean;
  id?: string;
  className?: string;
  tabIndex?: number;
  dataState?: string;
  noticeRef?: React.Ref<HTMLElement>;
}

/**
 * The one inline notice (docs/design-system.md §13.2): a 16px tone icon at the first line, an
 * optional title, a body and an action row, on a 7% wash of the tone. Every banner, callout and
 * boxed inline error in the app is this recipe; only the tone and the variant change.
 */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  dismissDisabled = false,
  compact = false,
  pageBanner = false,
  as: Element = "div",
  role,
  ariaLabel,
  ariaLabelledBy,
  ariaBusy,
  ariaHidden,
  id,
  className,
  tabIndex,
  dataState,
  noticeRef,
}: NoticeProps) {
  const Tag = Element as "div";
  return (
    <Tag
      ref={noticeRef as React.Ref<HTMLDivElement>}
      id={id}
      className={[
        "notice",
        tone === "success" ? "t-success"
          : tone === "warning" ? "t-warning"
            : tone === "danger" ? "t-danger"
              : tone === "neutral" ? "t-neutral"
                : "t-info",
        compact ? "compact" : "",
        pageBanner ? "page-banner" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      role={role}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-busy={ariaBusy || undefined}
      aria-hidden={ariaHidden || undefined}
      tabIndex={tabIndex}
      data-state={dataState}
    >
      <span className="notice-icon" aria-hidden="true"><ToneIcon tone={tone} /></span>
      <div className="notice-content">
        {title && <strong className="notice-title">{title}</strong>}
        {children != null && children !== false && <div className="notice-body">{children}</div>}
        {actions && <div className="notice-actions">{actions}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="icon-btn sm notice-dismiss" aria-label={dismissLabel} title={dismissLabel}
          disabled={dismissDisabled} onClick={onDismiss}>
          <CloseIcon />
        </button>
      )}
    </Tag>
  );
}
