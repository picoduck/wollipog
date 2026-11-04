import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import type { ExecutionTargetBoundaries } from "@wollipog/protocol";
import { ChevronRightIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";

/** One current value in the closed head (§11.3 meta): a 14px icon and the value in Title Case. */
export interface SessionOptionsSummaryItem {
  key: string;
  icon: ReactNode;
  label: string;
}

/**
 * Something inside Options that needs the person before Create Session: an unsupported saved
 * default, skills missing on the chosen target, a defaults load error. Each one is named in the
 * closed head, and a new one opens Options by itself.
 */
export interface SessionOptionsAttention {
  key: string;
  /** Title Case, a few words: "Skills Unavailable". */
  label: string;
}

/**
 * New Session's options below Agent and Role, folded into one row (§5.5): a `.disclosure` whose
 * closed head lists the current values as meta, so most people never open it, and which opens by
 * itself when something inside needs attention (#2954). Role stays outside it (#3929).
 *
 * The body stays mounted while closed, `hidden`: Full Control's preparation and every draft inside
 * it keep their state, and a submit problem can open Options and focus the control it is about.
 */
export function SessionOptions({
  open,
  onOpenChange,
  summary,
  attention,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: readonly SessionOptionsSummaryItem[];
  attention: readonly SessionOptionsAttention[];
  children: ReactNode;
}) {
  const ids = useId();
  const labelId = `${ids}-label`;
  const summaryId = `${ids}-summary`;
  const bodyId = `${ids}-body`;
  // Opens for a NEW attention only, so closing Options over a known one keeps it closed, and the
  // same problem never reopens it on every render.
  const seen = useRef(new Set<string>());
  const attentionKeys = attention.map((item) => item.key).join("\0");
  useLayoutEffect(() => {
    const keys = new Set(attention.map((item) => item.key));
    const fresh = [...keys].some((key) => !seen.current.has(key));
    seen.current = keys;
    if (fresh && !open) onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionKeys]);
  return (
    <div className="disclosure">
      <button
        type="button"
        className="disclosure-trigger session-options-head"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-labelledby={labelId}
        aria-describedby={open ? undefined : summaryId}
        onClick={() => onOpenChange(!open)}
      >
        <ChevronRightIcon className="disclosure-chevron" size={14} aria-hidden="true" />
        <span id={labelId}>Options</span>
        {!open && (
          <span className="session-options-meta" id={summaryId}>
            {attention.map((item) => (
              <StatusBadge key={item.key} inline tone="warning" label={item.label} />
            ))}
            {summary.map((item) => (
              <span key={item.key} className="session-options-meta-item">
                <span className="session-options-meta-icon" aria-hidden="true">{item.icon}</span>
                {item.label}
              </span>
            ))}
          </span>
        )}
      </button>
      <div className="disclosure-body session-options-body" id={bodyId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

/** A list in prose: "network", "network or secrets", "network, secrets or billing". */
function proseList(items: readonly string[], conjunction: "and" | "or"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/**
 * What a target can reach, in words (§17), from its declared boundaries: "No network, secrets or
 * billing. Only the workspace is mounted." Never the enum values, which read as code ("Network
 * deny · Secrets none · Billing none").
 */
export function describeBoundaries(boundaries: ExecutionTargetBoundaries): string {
  const without: string[] = [];
  const machine: string[] = [];
  const scoped: string[] = [];
  if (boundaries.network === "deny") without.push("network");
  else if (boundaries.network === "policy") scoped.push("the network its policy allows");
  else machine.push("network");
  if (boundaries.secrets === "none") without.push("secrets");
  else if (boundaries.secrets === "references") scoped.push("only the secrets it references");
  else machine.push("secrets");
  if (boundaries.billing === "none") without.push("billing");
  const reaches = [...(machine.length > 0 ? [`this machine's ${proseList(machine, "and")}`] : []), ...scoped];
  const sentences = [
    without.length > 0 ? `No ${proseList(without, "or")}.` : null,
    reaches.length > 0 ? `Uses ${proseList(reaches, "and")}.` : null,
    boundaries.billing === "agent_account" ? "Billed to your agent account."
      : boundaries.billing === "target_metered" ? "Billed by this target as it runs."
        : boundaries.billing === "unknown" ? "Its billing isn't known." : null,
    boundaries.filesystem === "container" ? "Only the workspace is mounted."
      : boundaries.filesystem === "snapshot" ? "Works on a copy of the workspace."
        : boundaries.filesystem === "worktree" ? "Works in its own worktree."
          : "Works in your checkout.",
  ];
  return sentences.filter(Boolean).join(" ");
}
