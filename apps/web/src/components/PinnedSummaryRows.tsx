import { useId, useState, type ReactNode } from "react";
import { ChevronRightIcon, ExternalLinkIcon } from "./Icons.js";

/**
 * The Pinned Summary's building blocks (#2160; docs/design-system.md §5.2, §5.5): sections of
 * one-line rows that state each fact once. A row is a 14px icon, a label `.k` that keeps its width
 * and a value `.v` that truncates. Where the label is the long part (a branch name, a pull request's
 * title) `longLabel` swaps them, so the short value ("Worktree", "Open") stays whole.
 */

export function SummarySection({
  title,
  action,
  children,
  ...attributes
}: {
  title: string;
  /** A control at the end of the section head, such as Refresh Git Status. */
  action?: ReactNode;
  children: ReactNode;
  "aria-busy"?: boolean;
  "data-git-state"?: string;
}) {
  const headingId = useId();
  return (
    <section className="ps-sec" aria-labelledby={headingId} {...attributes}>
      <div className="ps-head">
        <h3 id={headingId}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function SummaryRow({
  icon,
  label,
  value,
  longLabel = false,
  warning = false,
  title,
  onClick,
  href,
  note,
  trailing,
}: {
  icon: ReactNode;
  label: ReactNode;
  value?: ReactNode;
  /** The label truncates and the value stays whole. */
  longLabel?: boolean;
  warning?: boolean;
  /** The row's tooltip: the full text of whatever truncates. */
  title?: string;
  /** A row that opens something in Wollipog is a button with a trailing chevron. */
  onClick?: () => void;
  /** A row that opens a page outside Wollipog is a link with a trailing external-link icon. */
  href?: string | null;
  /** A one-line reason under the fact, aligned with the label. */
  note?: ReactNode;
  /** A control after the value. Only on a static row: a control cannot nest in a button or link. */
  trailing?: ReactNode;
}) {
  const body = (
    <>
      {icon}
      <span className="k">{label}</span>
      {value != null && value !== false && <span className="v">{value}</span>}
      {onClick && <ChevronRightIcon className="ps-go" size={14} aria-hidden="true" />}
      {!onClick && href && <ExternalLinkIcon className="ps-go" size={14} aria-hidden="true" />}
      {!onClick && !href && trailing}
      {note && <span className="ps-note">{note}</span>}
    </>
  );
  if (onClick) {
    return <button type="button" className={`ps-row is-nav${longLabel ? " long-k" : ""}${warning ? " is-warning" : ""}${note ? " has-note" : ""}`} title={title} onClick={onClick}>{body}</button>;
  }
  if (href) {
    return <a className={`ps-row is-nav${longLabel ? " long-k" : ""}${warning ? " is-warning" : ""}${note ? " has-note" : ""}`} href={href} target="_blank" rel="noreferrer" title={title}>{body}</a>;
  }
  return <div className={`ps-row${longLabel ? " long-k" : ""}${warning ? " is-warning" : ""}${note ? " has-note" : ""}`} title={title}>{body}</div>;
}

/**
 * An expand-and-collapse row (§5.5): the shared chevron, a label and a plain count (§11.4). Closed
 * by default unless `defaultOpen`; `onToggle` lets a caller persist it.
 */
export function SummaryDisclosure({
  label,
  count,
  defaultOpen = false,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div className="disclosure ps-disclosure">
      <button
        type="button"
        className="disclosure-trigger"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          onToggle?.(next);
        }}
      >
        <ChevronRightIcon className="disclosure-chevron" size={14} aria-hidden="true" />
        <span className="k">{label}</span>
        {count != null && <span className="ps-count">{count}</span>}
      </button>
      {open && <div className="disclosure-body" id={bodyId}>{children}</div>}
    </div>
  );
}
