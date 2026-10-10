import { useId, useState, type ReactNode } from "react";
import type { GitCommitInfo } from "@wollipog/protocol";
import type { GitFailure } from "../git-failure.js";
import { CopyButton } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ChevronDownIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Which of the bar's actions is running. */
export type CommitBarBusy = "commit" | "commit_all" | "open" | "push";

/** Where a request's link goes, as the button names it: "Open on GitHub". */
export interface RequestLink {
  /** A safe external href, or null when the forge returned a link that is not one. */
  href: string | null;
  url: string;
  /** "GitHub" or "GitLab"; null for a remote with no forge integration. */
  forge: string | null;
}

/**
 * The bar's one result (§13.2): the newest replaces the last, so the commit bar never stacks them.
 * A failure carries the action to run again.
 */
export type CommitBarNotice =
  | { kind: "committed"; commit: GitCommitInfo }
  | { kind: "opened"; link: RequestLink }
  | { kind: "pushed"; link: RequestLink }
  | { kind: "finish"; link: RequestLink; detail?: string }
  | { kind: "stale" }
  | { kind: "failed"; failure: GitFailure; onRetry: () => void };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
/** "Pull Request" in a sentence: "Pull request opened." */
const sentenceStart = (name: string) => `${name.charAt(0)}${name.slice(1).toLowerCase()}`;

/** "Committed 5 staged files as 9d2a7da." The hash is what the person copies, so it is never cut. */
function CommittedNotice({ commit, onDismiss }: { commit: GitCommitInfo; onDismiss: () => void }) {
  const files = plural(commit.filesChanged, commit.stagedOnly ? "staged file" : "file");
  return (
    <Notice
      tone="success"
      compact
      role="status"
     
      actions={<CopyButton text={commit.sha} label="Copy Hash" className="btn sm" />}
      onDismiss={onDismiss}
    >
      Committed {files} as <code>{commit.sha}</code>.
    </Notice>
  );
}

/** The forge link as a button-styled anchor (§3.1: `a.btn` never underlines), or the bare URL. */
function RequestLinkButton({ link, label }: { link: RequestLink; label: string }) {
  if (!link.href) return <code className="commit-bar-url">{link.url}</code>;
  return <a className="btn sm" href={link.href} target="_blank" rel="noreferrer">{label}</a>;
}

function BarNotice({ notice, requestName, onDismiss }: {
  notice: CommitBarNotice;
  requestName: string;
  onDismiss: () => void;
}) {
  const request = requestName.toLowerCase();
  switch (notice.kind) {
    case "committed":
      return <CommittedNotice commit={notice.commit} onDismiss={onDismiss} />;
    case "opened":
    case "pushed":
      return (
        <Notice
          tone="success"
          compact
          role="status"
         
          actions={<RequestLinkButton link={notice.link}
            label={notice.link.forge ? `Open on ${notice.link.forge}` : `Open ${requestName}`} />}
          onDismiss={onDismiss}
        >
          {notice.kind === "opened" ? `${sentenceStart(requestName)} opened.` : `Pushed to the ${request}.`}
        </Notice>
      );
    case "finish":
      return (
        <Notice
          tone="warning"
          role="status"
         
          actions={<RequestLinkButton link={notice.link}
            label={notice.link.forge ? `Finish on ${notice.link.forge}` : "Finish in Browser"} />}
          details={notice.detail ? <p className="commit-bar-detail">{notice.detail}</p> : undefined}
          onDismiss={onDismiss}
        >
          {notice.link.forge
            ? `Pushed the branch. Finish opening the ${request} on ${notice.link.forge}.`
            : `Pushed the branch. Finish opening the ${request} in your browser.`}
        </Notice>
      );
    case "stale":
      return (
        <Notice tone="warning" compact role="status" onDismiss={onDismiss}>
          The staged files changed since Review loaded. Check them, then commit again.
        </Notice>
      );
    case "failed":
      return (
        <Notice
          tone="danger"
          role="alert"
         
          actions={<button type="button" className="btn sm" onClick={notice.onRetry}>Try Again</button>}
          details={<div className="code-well commit-bar-output"><pre>{notice.failure.detail}</pre></div>}
          onDismiss={onDismiss}
        >
          {notice.failure.sentence}
        </Notice>
      );
  }
}

/**
 * Review's commit bar (#2847; docs/design-system.md §3.1–§3.2, §4.9, §13.2): the commit message and
 * the next step, fixed in the panel's foot so they are on screen in every Review state. One
 * primary: Commit Staged as a split button whose menu holds Commit All Changes, or plain Commit with
 * nothing staged; with nothing to commit, the request action takes the primary and Commit says why
 * it can't run. The bar's one notice is the result of what its buttons last did.
 */
export function CommitBar({
  message,
  onMessageChange,
  stagedCount,
  fileCount,
  hasChanges,
  requestName,
  requestOpen,
  busy,
  disabled,
  offline,
  refusal,
  notice,
  onDismissNotice,
  onCommit,
  onOpenRequest,
  onPushToRequest,
  openRequestRef,
}: {
  message: string;
  onMessageChange: (message: string) => void;
  stagedCount: number;
  /** Changed files, as the summary counts them ("9", or "500+" when the list was capped). */
  fileCount: { count: number; label: string };
  /** Null until the first status read says. */
  hasChanges: boolean | null;
  /** "Pull Request" or "Merge Request". */
  requestName: string;
  /** The branch already has an open request, so the request action pushes to it. */
  requestOpen: boolean;
  busy: CommitBarBusy | null;
  /** Reads or other mutations hold every action. */
  disabled: boolean;
  /** The machine is offline: every action is disabled and the bar says "Reconnect to commit." */
  offline: boolean;
  /** A person the server refuses Git actions to (#1870): every action is disabled and described by
   * the refusal already shown in Review's toolbar, which stays on screen above the scroller. */
  refusal: { reason: string; id: string } | null;
  notice: CommitBarNotice | null;
  onDismissNotice: () => void;
  onCommit: (all: boolean) => void;
  onOpenRequest: () => void;
  onPushToRequest: () => void;
  /** The Open Request… button, for the dialog to return focus to. */
  openRequestRef?: { current: HTMLButtonElement | null };
}) {
  const uid = useId().replace(/:/g, "");
  const inputId = `${uid}-message`;
  const errorId = `${uid}-message-error`;
  const reasonId = `${uid}-reason`;
  const [messageError, setMessageError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "commit-menu");

  const nothingToCommit = hasChanges === false;
  // The bar's own visible reason; a refusal's is the toolbar's.
  const reason = offline ? "Reconnect to commit." : nothingToCommit && !refusal ? "Nothing to commit." : null;
  const anyBusy = busy !== null;
  // A held action is disabled; the running one stays focusable and refuses presses (BusyButton).
  const held = (kind: CommitBarBusy[]) => disabled || offline || refusal !== null || (anyBusy && !kind.includes(busy!));
  const commitDisabled = held(["commit", "commit_all"]) || nothingToCommit;
  const requestDisabled = held(["open", "push"]);
  /** A disabled action names why: the refusal, else the bar's own reason (§3.1, §13.2). */
  const gate = (blocked: boolean, ownReason: boolean) => ({
    disabled: blocked,
    ...(blocked && refusal
      ? { title: refusal.reason, "aria-describedby": refusal.id }
      : blocked && ownReason ? { "aria-describedby": reasonId } : {}),
  });
  const commitGate = gate(commitDisabled, offline || nothingToCommit);
  const requestGate = gate(requestDisabled, offline);

  const commit = (all: boolean) => {
    if (!message.trim()) {
      setMessageError("Enter a commit message.");
      document.getElementById(inputId)?.focus();
      return;
    }
    setMessageError(null);
    onCommit(all);
  };

  const requestAction = requestOpen
    ? { label: `Push to ${requestName}`, busyKind: "push" as const, progress: `Pushing to the ${requestName.toLowerCase()}…`, run: onPushToRequest }
    : { label: `Open ${requestName}…`, busyKind: "open" as const, progress: `Opening the ${requestName.toLowerCase()}…`, run: onOpenRequest };
  const requestButton = (primary: boolean) => (
    <BusyButton
      ref={requestOpen ? undefined : openRequestRef}
      className={primary ? "btn primary sm" : "btn sm"}
      busy={busy === requestAction.busyKind}
      progress={requestAction.progress}
      {...requestGate}
      onClick={requestAction.run}
    >
      {requestAction.label}
    </BusyButton>
  );

  const staged = stagedCount > 0;
  let commitControl: ReactNode;
  if (nothingToCommit) {
    commitControl = (
      <button type="button" className="btn sm" {...commitGate}>Commit</button>
    );
  } else if (!staged) {
    commitControl = (
      <BusyButton
        className="btn primary sm"
        busy={busy === "commit" || busy === "commit_all"}
        progress="Committing the changes…"
        {...commitGate}
        onClick={() => commit(false)}
      >
        Commit
      </BusyButton>
    );
  } else {
    commitControl = (
      <div className="split">
        <BusyButton
          className="btn primary sm"
          busy={busy === "commit" || busy === "commit_all"}
          progress={busy === "commit_all" ? "Committing all changes…" : "Committing the staged files…"}
          {...commitGate}
          onClick={() => commit(false)}
        >
          Commit Staged
        </BusyButton>
        <button
          ref={menu.triggerRef}
          type="button"
          className="btn primary sm"
          aria-label="More Commit Options"
          title="More Commit Options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menu.menuId}
          {...commitGate}
          disabled={commitDisabled || anyBusy}
          onClick={menu.toggle}
          onKeyDown={menu.onTriggerKeyDown}
        >
          <ChevronDownIcon size={14} aria-hidden="true" />
        </button>
        {menuOpen && (
          <MenuSurface
            surfaceRef={menu.menuRef}
            anchor={{ trigger: menu.triggerRef }}
            id={menu.menuId}
            label="Commit Options"
            align="end"
            onDismiss={() => menu.close(true)}
            onKeyDown={menu.onMenuKeyDown}
          >
            <MenuItem
              description={`All ${fileCount.label} ${fileCount.count === 1 ? "file" : "files"}, including unstaged and untracked ones.`}
              onClick={() => {
                menu.close(true);
                commit(true);
              }}
            >
              Commit All Changes
            </MenuItem>
          </MenuSurface>
        )}
      </div>
    );
  }

  const files = fileCount.count === 1 ? "file" : "files";
  const countLabel = staged
    ? `${stagedCount} of ${fileCount.label} ${files} staged`
    : hasChanges && fileCount.count > 0 ? `${fileCount.label} uncommitted ${files}` : null;

  return (
    <section className="commit-bar" aria-label="Commit">
      {notice && <BarNotice notice={notice} requestName={requestName} onDismiss={onDismissNotice} />}
      <div className="field">
        <div className="field-head">
          <label htmlFor={inputId}>Commit Message</label>
          {countLabel && <span className="commit-bar-count">{countLabel}</span>}
        </div>
        <input
          id={inputId}
          value={message}
          autoComplete="off"
          placeholder="Describe the change"
          aria-invalid={messageError ? true : undefined}
          aria-describedby={messageError ? errorId : undefined}
          onChange={(event) => {
            onMessageChange(event.target.value);
            if (messageError && event.target.value.trim()) setMessageError(null);
          }}
        />
        {messageError && <FieldError id={errorId}>{messageError}</FieldError>}
      </div>
      {reason && <p className="commit-bar-reason" id={reasonId}>{reason}</p>}
      <div className="commit-bar-actions">
        {nothingToCommit ? (
          <>
            {commitControl}
            {requestButton(true)}
          </>
        ) : (
          <>
            {requestButton(false)}
            {commitControl}
          </>
        )}
      </div>
    </section>
  );
}
