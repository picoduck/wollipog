import type { ReactNode } from "react";
import { relativeTime } from "../format.js";
import type { GitPresentation } from "../pinned-summary.js";
import { BranchIcon, GlobeIcon, RefreshIcon, WarningIcon } from "./Icons.js";
import { SummaryDisclosure, SummaryRow, SummarySection } from "./PinnedSummaryRows.js";

const GIT_DETAILS_OPEN_KEY = "wollipog.pinned.git.open";

function loadGitDetailsOpen(): boolean {
  try {
    return window.localStorage.getItem(GIT_DETAILS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveGitDetailsOpen(open: boolean) {
  try {
    window.localStorage.setItem(GIT_DETAILS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* disclosure simply won't persist */
  }
}

/** The session's branch when no Git read can say: the session record's worktree, or a legacy read. */
export interface GitBranchFallback {
  name: string;
  /** "Worktree" for a linked worktree; null when unknown. */
  kind: "Worktree" | null;
  title?: string;
}

/** The repository remote Git Details names, as a link when it has a safe web address. */
export interface GitRemoteFact {
  url: string;
  href: string | null;
}

/**
 * The Pinned Summary's Git section (#2160): the branch row with the folder's kind as its value, a
 * row for each state that needs attention, the caller's change and forge rows, then Git Details, a
 * disclosure holding every remaining fact in full. Refresh Git Status sits in the section head.
 */
export function GitPinnedSection({
  model,
  rich = true,
  onRefresh,
  folderPath = null,
  remote = null,
  branchFallback = null,
  checkedAt = null,
  children,
}: {
  model: GitPresentation;
  /** False on a runner too old for repository facts: only the fallback branch and the rows show. */
  rich?: boolean;
  onRefresh: () => Promise<void>;
  /** The session's folder: its linked worktree or the checkout it runs in. */
  folderPath?: string | null;
  remote?: GitRemoteFact | null;
  branchFallback?: GitBranchFallback | null;
  /** When Wollipog last read the repository (the later of the status and summary reads). */
  checkedAt?: number | null;
  /** Changes, the commit action, the pull request, checks and forge rows. */
  children?: ReactNode;
}) {
  const busy = model.state === "loading" || model.state === "updating";
  const announceState = model.state === "offline" || model.state === "unavailable" ||
    model.state === "not_repository" || model.state === "error";
  const unavailable = model.state === "offline" ||
    model.state === "loading" ||
    model.state === "unavailable" ||
    model.state === "not_repository" ||
    (model.state === "error" && !model.facts);
  const facts = rich && !unavailable ? model.facts : null;
  const kindLabel = model.worktreeKind === "linked"
    ? "Worktree"
    : model.worktreeKind === "primary" ? "Primary Checkout" : null;
  const branch = facts
    ? {
        name: model.branchLabel ?? "Branch Unavailable",
        kind: kindLabel,
        title: [model.branchLabel, kindLabel, model.headSha].filter(Boolean).join(" · ") || undefined,
      }
    : branchFallback;

  return (
    <SummarySection
      title="Git"
      aria-busy={busy}
      data-git-state={model.state}
      action={(
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Refresh Git Status"
          title="Refresh Git Status"
          onClick={() => void onRefresh()}
          disabled={model.state === "offline" || busy}
        >
          <RefreshIcon size={14} aria-hidden="true" />
        </button>
      )}
    >
      {rich && model.stateDetail && model.state !== "ready" && (
        <div
          className="ps-git-state"
          data-git-state={model.state}
          role={announceState ? "status" : undefined}
          aria-live={announceState ? "polite" : undefined}
        >
          {model.stateDetail}
        </div>
      )}

      {branch && (
        <SummaryRow
          icon={<BranchIcon className="ps-icon" size={14} aria-hidden="true" />}
          label={branch.name}
          value={branch.kind}
          longLabel
          title={branch.title ?? branch.name}
        />
      )}
      {facts && model.operation && (
        <SummaryRow
          icon={<WarningIcon className="ps-icon" size={14} aria-hidden="true" />}
          label={model.operation.label}
          warning
        />
      )}
      {facts && model.conflicts > 0 && (
        <SummaryRow
          icon={<WarningIcon className="ps-icon" size={14} aria-hidden="true" />}
          label="Conflicts"
          value={model.conflicts.toLocaleString()}
          title={`${model.conflicts} conflicted file${model.conflicts === 1 ? "" : "s"}`}
          warning
        />
      )}

      {children}

      {/* A runner too old for repository facts has no Git Details, but its remote is still known. */}
      {!rich && remote && (
        <SummaryRow
          icon={<GlobeIcon className="ps-icon" size={14} aria-hidden="true" />}
          label="Remote"
          value={remote.href ? remote.href.replace(/^https?:\/\//, "") : remote.url}
          href={remote.href}
          title={remote.href ?? remote.url}
        />
      )}

      {facts && (
        <SummaryDisclosure
          label="Git Details"
          defaultOpen={loadGitDetailsOpen()}
          onToggle={saveGitDetailsOpen}
        >
          <GitDetailsFacts model={model} folderPath={folderPath} remote={remote} checkedAt={checkedAt} />
        </SummaryDisclosure>
      )}
    </SummarySection>
  );
}

/** Every remaining Git fact as a `dl.facts` list (§5.4): values wrap in full, never truncate. */
function GitDetailsFacts({
  model,
  folderPath,
  remote,
  checkedAt,
}: {
  model: GitPresentation;
  folderPath: string | null;
  remote: GitRemoteFact | null;
  checkedAt: number | null;
}) {
  const facts = model.facts!;
  const baseRef = Object.prototype.hasOwnProperty.call(facts, "baseRef")
    ? facts.baseRef === null ? "None" : facts.baseRef ?? "Unavailable"
    : "Unavailable";
  const sync = [...model.base, ...model.upstream];
  return (
    <dl className="facts ps-facts">
      <div>
        <dt>Branch</dt>
        <dd>{model.branchLabel ?? "Unavailable"}</dd>
      </div>
      {model.headSha && (
        <div>
          <dt>Commit</dt>
          <dd className="ps-mono">{model.headSha.slice(0, 12)}</dd>
        </div>
      )}
      <div>
        <dt>Base</dt>
        <dd>{baseRef}</dd>
      </div>
      {folderPath && (
        <div>
          <dt>{model.worktreeKind === "linked" ? "Linked Worktree" : "Folder"}</dt>
          <dd className="ps-mono">{folderPath}</dd>
        </div>
      )}
      <div>
        <dt>Upstream</dt>
        <dd>{model.upstreamBranch === undefined ? "Unavailable" : model.upstreamBranch ?? "None"}</dd>
      </div>
      {sync.length > 0 && (
        <div>
          <dt>Sync</dt>
          <dd>
            {sync.map((line) => (
              <span key={line.text} className={line.tone === "warning" ? "ps-line is-warning" : "ps-line"}>
                {line.text}
              </span>
            ))}
          </dd>
        </div>
      )}
      {model.dirty && (
        <div>
          <dt>Working Tree</dt>
          <dd className={model.dirty.tone === "warning" ? "is-warning" : undefined}>
            {model.dirty.label === "Clean" ? "Clean" : model.dirty.detail ?? "Changed"}
          </dd>
        </div>
      )}
      {remote && (
        <div>
          <dt>Remote</dt>
          <dd>
            {remote.href
              ? <a href={remote.href} target="_blank" rel="noreferrer">{remote.href}</a>
              : remote.url}
          </dd>
        </div>
      )}
      <div>
        <dt>Remote Refs</dt>
        <dd>{model.remoteRefsAt ? `Updated ${model.remoteRefsAt}` : "Unknown"}</dd>
      </div>
      {checkedAt != null && (
        <div>
          <dt>Checked</dt>
          <dd title={new Date(checkedAt).toLocaleString()}>{relativeTime(checkedAt)}</dd>
        </div>
      )}
    </dl>
  );
}
