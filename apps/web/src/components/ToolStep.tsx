import { useId, type ReactNode } from "react";
import { formatDuration, titleCaseLabel } from "../format.js";
import { toolStatusMeta } from "../status-meta.js";
import { failureLines, type WorkLedger } from "../work-steps.js";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  DeleteIcon,
  ErrorIcon,
  FileEditIcon,
  FileSearchIcon,
  GlobeIcon,
  MoveIcon,
  ReadIcon,
  SkillsIcon,
  TerminalIcon,
  ThoughtIcon,
  ToolIcon,
} from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";

/** The 16px glyph for a kind of work (docs/design-system.md §18); never an emoji. */
export function toolIcon(kind?: string): ReactNode {
  switch (kind) {
    case "read": return <ReadIcon size={16} />;
    case "edit": return <FileEditIcon size={16} />;
    case "delete": return <DeleteIcon size={16} />;
    case "move": return <MoveIcon size={16} />;
    case "search": return <FileSearchIcon size={16} />;
    case "execute": return <TerminalIcon size={16} />;
    case "fetch": return <GlobeIcon size={16} />;
    case "think": return <ThoughtIcon size={16} />;
    case "agent": return <BotIcon size={16} />;
    case "skill": return <SkillsIcon size={16} />;
    default: return <ToolIcon size={16} />;
  }
}

/**
 * §11.2 for a step: Running is the inline info status with its pulse, Failed the inline danger
 * status, and Completed a 14px check in the success colour with no label.
 */
export function StepStatus({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="tl-step-done">
        <CheckIcon size={14} />
        <span className="sr-only">Completed</span>
      </span>
    );
  }
  return <StatusBadge meta={toolStatusMeta(status)} inline className="tl-step-status" />;
}

/**
 * One step of agent work (#2168): a chevron, a 16px icon, a verb with its object in mono, one
 * trailing fact and a status. A step with a body is a `<details>`; without one it is a plain row
 * that keeps the chevron's column so every icon lines up. No card and no clipping ancestor, so the
 * summary's focus ring paints outside the row (§16.1). The exact start and finish live in the
 * trailing fact's tooltip, which is also the summary's accessible description.
 */
export function ToolStep({
  icon,
  verb,
  object,
  trail,
  timing,
  status,
  label,
  open = false,
  onToggle,
  children,
}: {
  icon: ReactNode;
  verb: ReactNode;
  /** The thing acted on: a path, a command, a query. Rendered in mono 12px. */
  object?: ReactNode;
  /** The one trailing fact: a duration, a line count or a result count. */
  trail?: ReactNode;
  /** "Started …, finished … (26s)", shown on the trailing fact's hover and the summary's focus. */
  timing?: string;
  status?: ReactNode;
  /** The summary's accessible name when the visible title is not enough on its own. */
  label?: string;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const timingId = useId();
  const head = (disclosure: boolean) => (
    <>
      {disclosure
        ? <ChevronRightIcon size={14} className="disclosure-chevron" />
        : <span className="tl-step-chevron-space" aria-hidden="true" />}
      <span className="tl-step-icon">{icon}</span>
      <span className="tl-step-title">
        {verb}
        {object && <> <span className="tl-step-object">{object}</span></>}
      </span>
      {(trail || timing) && (
        <span className="tl-step-trail">
          {trail}
          {timing && (
            <span id={timingId} className={trail ? "tl-tooltip" : "sr-only"} role={trail ? "tooltip" : undefined}>
              {timing}
            </span>
          )}
        </span>
      )}
      {status}
    </>
  );
  if (!children) {
    return <div className="tl-step"><div className="tl-step-head">{head(false)}</div></div>;
  }
  return (
    <details
      className="tl-step disclosure"
      open={open}
      onToggle={(event) => {
        if (event.nativeEvent.isTrusted && event.currentTarget.open !== open) onToggle?.();
      }}
    >
      <summary className="tl-step-head" aria-label={label} aria-describedby={timing ? timingId : undefined}>
        {head(true)}
      </summary>
      <div className="tl-step-body">{children}</div>
    </details>
  );
}

/**
 * A step's output in a neutral well. A failed step's exit code and error lines read in the danger
 * text colour; everything else stays neutral, so the failure is what stands out.
 */
export function StepOutput({ text, failed = false }: { text: string; failed?: boolean }) {
  if (!failed) return <pre className="tl-step-output">{text}</pre>;
  const { lines, failing } = failureLines(text);
  return (
    <pre className="tl-step-output">
      {lines.map((line, index) => (
        <span key={index} className={failing[index] ? "tl-step-error" : undefined}>
          {line}{index < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </pre>
  );
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The one line a run of work collapses to (#2168): "Worked for 26s" once it settles, "Working"
 * while it runs, then its counts 12px apart. A failure is counted in the danger colour with an
 * alert icon; a zero count never renders. The line never wraps: on a narrow screen its meta clips
 * at the end.
 */
export function WorkLedgerLine({ ledger, live, open, onToggle }: {
  ledger: WorkLedger;
  live: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const span = ledger.startedAt !== undefined && ledger.finishedAt !== undefined
    ? ledger.finishedAt - ledger.startedAt
    : 0;
  const title = live ? "Working" : span >= 1_000 ? `Worked for ${formatDuration(span)}` : "Worked";
  const meta: ReactNode[] = [];
  if (ledger.tools) meta.push(<span key="tools">{plural(ledger.tools, "Command")}</span>);
  if (ledger.edits) meta.push(<span key="edits">{plural(ledger.edits, "Edit")}</span>);
  if (!ledger.tools && !ledger.edits && ledger.thoughts) {
    meta.push(<span key="thoughts">{plural(ledger.thoughts, "Reasoning Step")}</span>);
  }
  if (ledger.failed) {
    meta.push(
      <span key="failed" className="tl-work-failed">
        <ErrorIcon size={14} />
        {ledger.failed} Failed
      </span>,
    );
  }
  if (ledger.autoApproved) {
    const risk = ledger.highestReviewRisk ? ` · ${titleCaseLabel(ledger.highestReviewRisk)} Risk` : "";
    meta.push(<span key="approved">{plural(ledger.autoApproved, "Tool Call")} Auto-Approved{risk}</span>);
  }
  return (
    <div className={`tl-work${open ? " open" : ""}`}>
      <button type="button" className="disclosure-trigger" aria-expanded={open} onClick={onToggle}>
        <ChevronRightIcon size={14} className="disclosure-chevron" />
        <span className="tl-work-title">{title}</span>
        {meta.length > 0 && <span className="tl-work-meta">{meta}</span>}
      </button>
    </div>
  );
}
