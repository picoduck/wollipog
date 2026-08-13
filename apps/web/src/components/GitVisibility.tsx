import { useId, useState } from "react";
import type { GitPresentation, GitPresentationRow } from "../pinned-summary.js";
import { deriveGitHeadline } from "../pinned-summary.js";
import { BranchIcon, ChainIcon, DialIcon, WarningTriangleIcon } from "./Icons.js";

function rowText(row: GitPresentationRow): string {
  return row.detail ? `${row.label} ${row.detail}` : row.label;
}

function GitRow({
  row,
  icon = "branch",
}: {
  row: GitPresentationRow;
  icon?: "branch" | "worktree" | "warning";
}) {
  const Icon = icon === "worktree" ? ChainIcon : icon === "warning" ? WarningTriangleIcon : BranchIcon;
  return (
    <div
      className={`ps-row is-static ps-git-row${row.tone === "warning" ? " is-warning" : ""}`}
      title={row.title ?? rowText(row)}
    >
      <Icon className="ps-icon" size={14} aria-hidden="true" />
      <span className="ps-git-label">{row.label}</span>
      {row.detail && <span className="ps-right ps-detail">{row.detail}</span>}
    </div>
  );
}

const GIT_DETAILS_OPEN_KEY = "wollipog.pinned.git.open";

function loadGitDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(GIT_DETAILS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The canonical Git surface, collapsed by default so the pinned summary never becomes a
 * permanently tall Git block. Collapsed, it keeps the headline (branch, worktree identity,
 * dirty/conflicts, most actionable divergence) plus explicit non-ready states; Show Git
 * Details reveals SHA, upstream and base divergence, counts, paths, freshness, and Refresh
 * Git Status. Disclosure persists app-wide.
 */
export function GitPinnedSection({
  model,
  onRefresh,
}: {
  model: GitPresentation;
  onRefresh: () => Promise<void>;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(loadGitDetailsOpen);
  const busy = model.state === "loading" || model.state === "updating";
  const announceState = model.state === "offline" || model.state === "unavailable" ||
    model.state === "not_repository" || model.state === "error";
  const unavailable = model.state === "offline" ||
    model.state === "loading" ||
    model.state === "unavailable" ||
    model.state === "not_repository" ||
    (model.state === "error" && !model.facts);
  const headline = deriveGitHeadline(model);

  const toggle = () => setOpen((current) => {
    const next = !current;
    try {
      window.localStorage.setItem(GIT_DETAILS_OPEN_KEY, next ? "1" : "0");
    } catch {
      /* disclosure simply won't persist */
    }
    return next;
  });

  return (
    <section
      className="ps-section ps-git-section"
      aria-labelledby={headingId}
      aria-busy={busy}
      data-git-state={model.state}
    >
      <div className="ps-section-head">
        <span id={headingId}>Git</span>
        <button
          type="button"
          className="btn ghost sm ps-git-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? "Hide Git Details" : "Show Git Details"}
        </button>
      </div>

      {model.stateDetail && model.state !== "ready" && (
        <div
          className="ps-git-state"
          data-git-state={model.state}
          role={announceState ? "status" : undefined}
          aria-live={announceState ? "polite" : undefined}
        >
          {model.stateDetail}
        </div>
      )}

      {!open && headline.length > 0 && (
        <div className="ps-git-headline">
          {headline.map((segment, index) => (
            <span
              key={`${index}:${segment.text}`}
              className={segment.tone === "warning" ? "ps-git-headline-seg is-warning" : "ps-git-headline-seg"}
              title={segment.expandedLabel ?? segment.text}
            >
              {segment.expandedLabel ? (
                <>
                  <span aria-hidden="true">{segment.text}</span>
                  <span className="sr-only">{segment.expandedLabel}</span>
                </>
              ) : segment.text}
            </span>
          ))}
        </div>
      )}

      {open && (
        <>
          {!unavailable && model.facts && (
            <>
              <GitRow
                row={{
                  label: model.branchLabel ?? "Branch Unavailable",
                  detail: model.headSha,
                  title: model.headSha
                    ? `${model.branchLabel ?? "Branch Unavailable"} · ${model.headSha}`
                    : model.branchLabel ?? undefined,
                }}
              />
              <GitRow row={model.worktree} icon="worktree" />
              {model.dirty && (
                <GitRow
                  row={{
                    label: model.dirty.label,
                    detail: model.dirty.detail,
                    tone: model.dirty.tone,
                  }}
                  icon={model.dirty.tone === "warning" ? "warning" : "branch"}
                />
              )}
              {model.operation && <GitRow row={model.operation} icon="warning" />}
              {model.upstream.map((row, index) => (
                <GitRow key={`upstream-${index}-${row.label}`} row={row} />
              ))}
              {model.base.map((row, index) => (
                <GitRow key={`base-${index}-${row.label}`} row={row} />
              ))}
              <div
                className="ps-row is-static ps-git-row ps-git-freshness is-warning"
                title={model.remoteFreshness.detail}
              >
                <DialIcon className="ps-icon" size={14} aria-hidden="true" />
                <span className="ps-git-label">{model.remoteFreshness.label}</span>
                <span className="ps-right ps-detail ps-git-freshness-detail">
                  {model.remoteFreshness.detail}
                </span>
              </div>
            </>
          )}
          <button
            type="button"
            className="btn ghost sm ps-git-refresh"
            onClick={() => void onRefresh()}
            disabled={model.state === "offline" || busy}
          >
            {busy ? "Updating Git Status" : "Refresh Git Status"}
          </button>
        </>
      )}
    </section>
  );
}
