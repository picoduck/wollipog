import React, { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isTerminal,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BackgroundWorkState,
  type SessionView,
  type TranscriptShareView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { sessionArchiveActionLabel, sessionArchiveRequiresStop } from "../archive-actions.js";
import { titleCaseLabel } from "../format.js";
import { removeFromInstanceKeySet, SESSION_PIN_KEY } from "../pins.js";
import { discardComposerDraft } from "../composer-drafts.js";
import { useInstanceScope } from "../instance-scope.js";
import { instancePublicOrigin, useInstances } from "../instances-context.js";
import { absoluteViewUrl } from "../navigation.js";
import { requestTranscriptDownload } from "../transcript-download.js";
import { CONTROL_PLANE_HTTP, DASHBOARD_ORIGIN, hasSameOriginMarker } from "../config.js";
import { reachableTranscriptShareOrigin, transcriptShareUrl } from "../transcript-share-client.js";
import { StatusBadge, Modal, CopyButton } from "./common.js";
import { useAccessibleMenu } from "./interactions.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronLeftIcon } from "./Icons.js";

const BACKGROUND_WORK_DOT_LABELS: Record<BackgroundWorkState, string> = {
  running: "Waiting on External Job",
  continuation_pending: "Continuation Pending",
  orphaned: "Background Work: Orphaned",
  resumed: "Background Work: Resumed",
};

/**
 * The unified session bar: one compact row owning navigation (back, project breadcrumb, title),
 * live status, and every session action behind one ⋯ menu. The spec-bar facts this row used to
 * carry live in the pinned summary; model/effort/git context live at the composer edge.
 */
export function SessionHeader({
  session,
  onBack,
  runnerOnline,
  runnerProtocolVersion,
  providerLogoutSupported,
  stopBeforeArchiveSupported,
  exportReady,
  onArchive,
  onSnooze,
  projectCrumb,
  topbarControls,
  titleId,
}: {
  session: SessionView;
  onBack: () => void;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  providerLogoutSupported: boolean;
  stopBeforeArchiveSupported: boolean;
  exportReady: boolean;
  onArchive?: () => void;
  onSnooze?: () => void;
  /** The interactive Project chip, rendered as the breadcrumb's first segment. */
  projectCrumb?: ReactNode;
  /** App-shell control cluster (editor, pinned summary, terminal, side panel) when this bar
   * replaces the top-level app bar on desktop. */
  topbarControls?: ReactNode;
  /** Set when this bar owns the page heading (`page-title` focus-rescue anchor). */
  titleId?: string;
}) {
  const api = useApi();
  const instances = useInstances();
  const instanceScope = useInstanceScope();
  const { confirm, showUndo } = useFeedback();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(session.title);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const renameSubmittingRef = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "session-actions-menu");
  const terminal = isTerminal(session.status);
  const reprocessSupported = runnerSupportsProtocol(runnerProtocolVersion, "sessionReprocess");
  const logoutSupported = runnerSupportsProtocol(runnerProtocolVersion, "acpLogout");
  const dashboardOrigin = instancePublicOrigin(instances);
  const internalSessionUrl = dashboardOrigin
    ? absoluteViewUrl(dashboardOrigin, { name: "session", id: session.id })
    : null;

  const closeMenu = (restoreFocus = false) => {
    menu.close(restoreFocus);
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
      // Async menu actions disable the ⋯ trigger while they run, so a restoration queued at
      // menu close or confirmation settle can no-op against the disabled button and strand
      // focus on <body>. Reclaim it once the trigger is enabled again — but only when focus
      // was actually dropped, so a user who moved on is not yanked back (regression coverage).
      window.setTimeout(() => {
        if (document.activeElement === document.body || document.activeElement === null) {
          menu.triggerRef.current?.focus();
        }
      }, 0);
    }
  };

  // Re-import an adopted session: re-parse its original CLI transcript with the current formatter.
  // The control plane broadcasts a session_events_reset, so every open dashboard swaps in the fresh
  // timeline (no manual refetch needed).
  const reprocess = () =>
    run(async () => {
      closeMenu(true); // the invoking menu item unmounts; the ⋯ trigger is the durable focus home
      setNote("Reprocessing…");
      try {
        await api.reprocessSession(session.id);
        setNote(null);
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        window.setTimeout(() => menu.triggerRef.current?.focus(), 0);
      }
    });

  const downloadTranscript = (format: "json" | "markdown") =>
    run(async () => {
      closeMenu(true);
      setNote("Preparing export…");
      try {
        const { blob, filename } = await api.transcriptExport(session.id, format);
        requestTranscriptDownload(blob, filename);
        setNote("Download requested");
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        window.setTimeout(() => menu.triggerRef.current?.focus(), 0);
      }
    });

  // Focus restoration after dialogs is owned by Modal's returnFocusRef (the durable ⋯ trigger);
  // the menu item that launched them unmounts with the menu, so it can never take focus back.
  const closeShareDialog = () => {
    setShareDialogOpen(false);
  };

  const closeRenameDialog = () => {
    if (renameSubmittingRef.current) return;
    setRenameDialogOpen(false);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (renameSubmittingRef.current) return;
    const normalized = renameDraft.trim().replace(/\s+/g, " ");
    if (!normalized) {
      setRenameError("Enter a session name.");
      return;
    }
    if (normalized.length > 120) {
      setRenameError("Session names must be 120 characters or fewer.");
      return;
    }
    renameSubmittingRef.current = true;
    setRenameSubmitting(true);
    setBusy(true);
    setRenameError(null);
    try {
      await api.renameSession(session.id, normalized);
      setRenameDialogOpen(false);
      setNote("Session renamed");
    } catch (cause) {
      setRenameError((cause as Error).message);
    } finally {
      renameSubmittingRef.current = false;
      setRenameSubmitting(false);
      setBusy(false);
    }
  };

  return (
    <div className="detail-head">
      <button className="icon-btn back" onClick={onBack} title="Back to Inbox" aria-label="Back to Inbox">
        <ChevronLeftIcon size={22} />
      </button>
      <div className="detail-crumbs">
        {projectCrumb && (
          <>
            {projectCrumb}
            <span className="detail-crumb-sep" aria-hidden="true">/</span>
          </>
        )}
        <h1 className="detail-title" id={titleId} tabIndex={titleId ? -1 : undefined} title={session.title}>
          {session.title}
        </h1>
      </div>
      <StatusBadge
        status={session.status}
        archiveStatus={session.archiveStatus}
        archiveOperation={session.archiveOperation}
        stopOperation={session.stopOperation}
      />
      {session.backgroundWorkState && (
        <span
          className={session.backgroundWorkState === "orphaned"
            ? "bgwork-indicator bgwork-orphaned"
            : session.backgroundWorkState === "resumed"
              ? "bgwork-indicator bgwork-resumed"
              : "bgwork-indicator bgwork-running"}
          role="img"
          title={BACKGROUND_WORK_DOT_LABELS[session.backgroundWorkState]}
          aria-label={BACKGROUND_WORK_DOT_LABELS[session.backgroundWorkState]}
        />
      )}
      {!session.backgroundWorkState && session.backgroundWorkTracking === "untracked" && (
        <span
          className="bgwork-indicator bgwork-untracked"
          title="Detached Work: Untracked"
          aria-label="Detached Work: Untracked"
        />
      )}
      {!runnerOnline && <span className="tag tag-offline">Runner Offline</span>}
      <div className="detail-actions">
        {note && <span className="detail-note" role="status" aria-live="polite">{note}</span>}
        <div className="overflow-menu">
            <button
              ref={menu.triggerRef}
              className="btn ghost sm"
              onClick={menu.toggle}
              onKeyDown={menu.onTriggerKeyDown}
              disabled={busy}
              title="More Actions"
              aria-label="More Actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menu.menuId}
            >
              ⋯
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onClick={() => closeMenu(true)} />
                <div
                  className="menu-pop"
                  id={menu.menuId}
                  ref={menu.menuRef}
                  role="menu"
                  aria-label="Session Actions"
                  onKeyDown={menu.onMenuKeyDown}
                >
                  <button
                    className="menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu(false);
                      setRenameDraft(session.title);
                      setRenameError(null);
                      setRenameDialogOpen(true);
                    }}
                  >
                    Rename Session…
                  </button>
                  <button
                    className="menu-item"
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => {
                      closeMenu(true);
                      if (!session.archived && onArchive) {
                        onArchive();
                        return;
                      }
                      void run(async () => {
                        const nextArchived = !session.archived;
                        if (nextArchived && sessionArchiveRequiresStop(session, stopBeforeArchiveSupported)) {
                          const retrying = session.archiveStatus === "stop_failed";
                          const accepted = await confirm({
                            title: retrying ? "Retry stopping this session?" : "Archive and stop this session?",
                            message: retrying
                              ? "The previous Stop failed and runtime capacity may still be held. Retry the same archive operation?"
                              : "The session will move to Archived Sessions after its runtime stops. Queued work will be canceled and runtime capacity will be released. To keep work running outside the Inbox, use Snooze instead.",
                            confirmLabel: retrying ? "Retry Stop" : "Archive and Stop",
                            tone: "danger",
                          });
                          if (!accepted) return;
                        }
                        const updated = nextArchived && session.archiveStatus === "stop_failed"
                          ? await api.retryStop(session.id)
                          : await api.setArchived(session.id, nextArchived);
                        const message = !nextArchived
                          ? "Session restored."
                          : updated.archiveStatus === "stop_pending"
                            ? "Archive requested. Stop is pending until runtime capacity is released."
                            : updated.archiveStatus === "stop_failed"
                              ? "Stop failed. Runtime capacity may still be held."
                              : "Session archived.";
                        showUndo(message, async () => {
                          await api.setArchived(session.id, !nextArchived);
                        });
                      });
                    }}
                  >
                    {sessionArchiveActionLabel(session, stopBeforeArchiveSupported)}
                  </button>
                  {onSnooze && (
                    <button
                      className="menu-item"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        closeMenu(false);
                        onSnooze();
                      }}
                    >
                      Snooze Session…
                    </button>
                  )}
                  <div className="menu-label" id="transcript-export-warning" role="presentation">Operational Transcript</div>
                  <div className="menu-caution" id="transcript-export-caution" role="presentation">
                    {exportReady ? "Cached and possibly partial. Message text is operationally redacted but may still contain secrets or source." : "Export becomes available after the initial timeline load."}
                  </div>
                  <button className="menu-item" role="menuitem" aria-describedby="transcript-export-caution" onClick={() => void downloadTranscript("json")} disabled={busy || !exportReady}>
                    Export JSON
                  </button>
                  <button className="menu-item" role="menuitem" aria-describedby="transcript-export-caution" onClick={() => void downloadTranscript("markdown")} disabled={busy || !exportReady}>
                    Export Markdown
                  </button>
                  <div className="menu-caution" id="internal-session-link-caution" role="presentation">
                    {internalSessionUrl
                      ? "Internal links require access to this dashboard and do not grant transcript access."
                      : "Configure VITE_DASHBOARD_ORIGIN or open the browser-hosted dashboard to copy a usable link."}
                  </div>
                  {internalSessionUrl ? (
                    <CopyButton
                      text={internalSessionUrl}
                      label="Copy Internal Session Link"
                      className="menu-item"
                      role="menuitem"
                      describedBy="internal-session-link-caution"
                      onResult={(copied) => setNote(copied ? "Session link copied" : "Unable to copy session link")}
                    />
                  ) : (
                    <button className="menu-item" type="button" role="menuitem" disabled aria-describedby="internal-session-link-caution">
                      Copy Internal Session Link
                    </button>
                  )}
                  <button
                    className="menu-item menu-separated"
                    role="menuitem"
                    aria-describedby="transcript-export-caution"
                    disabled={busy || !exportReady}
                    onClick={() => {
                      closeMenu(false);
                      setShareDialogOpen(true);
                    }}
                  >
                    Share Transcript…
                  </button>
                  {session.adopted && (
                    <button
                      className="menu-item menu-separated"
                      role="menuitem"
                      onClick={reprocess}
                      disabled={busy || !reprocessSupported}
                      title={
                        reprocessSupported
                          ? "Re-parse this adopted session's original CLI transcript with the latest formatter"
                          : runnerCapabilityRequirement(runnerProtocolVersion, "sessionReprocess", "Session reprocessing")
                      }
                    >
                      ↻ Reprocess Transcript
                    </button>
                  )}
                  {session.driver === "acp" && !terminal && runnerOnline && logoutSupported && providerLogoutSupported && (
                    <button
                      className="menu-item menu-separated"
                      type="button"
                      role="menuitem"
                      disabled={busy || session.status !== "idle" || (session.queued?.length ?? 0) > 0}
                      title="Uses this ACP agent's negotiated logout capability; credentials stay on the runner host"
                      onClick={() => {
                        closeMenu(false);
                        void (async () => {
                          if (!await confirm({ title: "Sign out of this agent?", message: "Credentials remain on the runner host, but new sessions will require authentication.", confirmLabel: "Sign Out", tone: "danger", returnFocus: menu.triggerRef })) return;
                          void run(async () => {
                            setNote("Signing out…");
                            try {
                              await api.logoutAgent(session.id);
                              setNote("Signed out");
                            } catch (error) {
                              setNote((error as Error).message);
                            }
                          });
                        })();
                      }}
                    >
                      Sign Out
                    </button>
                  )}
                  {session.stopOperation?.status === "stop_failed" && !session.archiveStatus && (
                    <button
                      className="menu-item menu-danger menu-separated"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      title="Retry the same Stop operation without archiving the session"
                      onClick={() => {
                        closeMenu(true);
                        void run(() => api.retryStop(session.id));
                      }}
                    >
                      Retry Stop
                    </button>
                  )}
                  {terminal && runnerOnline && session.stopOperation?.status !== "stop_failed" && (
                    <button
                      className="menu-item menu-separated"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        closeMenu(true);
                        void run(() => api.restart(session.id));
                      }}
                    >
                      Restart
                    </button>
                  )}
                  {/* Process-lifecycle destruction stays last and visually distinct: Stop Session
                      keeps its confirmation dialog, so one extra menu click loses no safety, and
                      the frequent action (Stop Turn) lives on the composer's send button. */}
                  {!terminal && (
                    <button
                      className="menu-item menu-danger menu-separated"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      title="Terminate the agent process and discard queued messages"
                      onClick={() => {
                        closeMenu(false);
                        void (async () => {
                          if (!await confirm({
                            title: "Stop this session?",
                            message: "This terminates the agent process and discards every queued message. Use Stop Turn in the composer to interrupt only the active turn.",
                            confirmLabel: "Stop Session",
                            tone: "danger",
                            returnFocus: menu.triggerRef,
                          })) return;
                          await run(() => api.stop(session.id));
                        })();
                      }}
                    >
                      Stop Session
                    </button>
                  )}
                  {/* Delete remains archived-only, keeping the destructive action one deliberate
                      step beyond the everyday inbox. */}
                  {session.archived && (
                    <button
                      className="menu-item menu-danger menu-separated"
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => {
                        closeMenu(false);
                        void (async () => {
                          if (!await confirm({ title: "Delete this session?", message: "This permanently removes the session and its history from the dashboard.", confirmLabel: "Delete Session", tone: "danger", returnFocus: menu.triggerRef })) return;
                          void run(async () => {
                            try {
                              await api.deleteSession(session.id);
                              removeFromInstanceKeySet(SESSION_PIN_KEY, instanceScope, session.id); // a deleted session must not resurrect as pinned
                              void discardComposerDraft(session.id, instanceScope);
                              onBack(); // don't strand the user on a deleted session
                            } catch (e) {
                              setNote((e as Error).message);
                            }
                          });
                        })();
                      }}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        {topbarControls && (
          <>
            <span className="detail-actions-divider" aria-hidden="true" />
            <div className="topbar-actions">{topbarControls}</div>
          </>
        )}
        {shareDialogOpen && <TranscriptShareDialog sessionId={session.id} onClose={closeShareDialog} returnFocusRef={menu.triggerRef} />}
        {renameDialogOpen && (
          <Modal
            title="Rename Session"
            onClose={closeRenameDialog}
            returnFocusRef={menu.triggerRef}
            footer={(
              <>
                <button className="btn ghost" type="button" onClick={closeRenameDialog} disabled={renameSubmitting}>Cancel</button>
                <button className="btn primary" type="submit" form="rename-session-form" disabled={renameSubmitting}>
                  {renameSubmitting ? "Saving…" : "Save"}
                </button>
              </>
            )}
          >
            <form
              id="rename-session-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <label className="field-label" htmlFor="rename-session-title">Session Name</label>
              <input
                id="rename-session-title"
                className="input"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                maxLength={120}
                autoFocus
                disabled={renameSubmitting}
              />
              {renameError && <div className="form-error" role="alert">{renameError}</div>}
            </form>
          </Modal>
        )}
      </div>
    </div>
  );
}

const SHARE_EXPIRY_OPTIONS = [
  { seconds: 60 * 60, label: "1 Hour" },
  { seconds: 24 * 60 * 60, label: "1 Day" },
  { seconds: 7 * 24 * 60 * 60, label: "7 Days" },
  { seconds: 30 * 24 * 60 * 60, label: "30 Days" },
] as const;

function TranscriptShareDialog({ sessionId, onClose, returnFocusRef }: {
  sessionId: string;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const instances = useInstances();
  const { confirm } = useFeedback();
  const [shares, setShares] = useState<TranscriptShareView[] | null>(null);
  const [ttl, setTtl] = useState<number>(24 * 60 * 60);
  const [link, setLink] = useState<{ shareId: string; url: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const shareOrigin = reachableTranscriptShareOrigin(
    instances.activeProfile.kind === "remote" ? instances.activeProfile.origin : window.location.origin,
    instances.activeProfile.kind === "remote" ? instances.activeProfile.origin : CONTROL_PLANE_HTTP,
    instances.activeProfile.kind === "remote" || hasSameOriginMarker(window),
  );

  useEffect(() => {
    let cancelled = false;
    void api.transcriptShares(sessionId)
      .then(({ shares: next }) => { if (!cancelled) setShares(next); })
      .catch((error) => { if (!cancelled) setStatus((error as Error).message); });
    return () => { cancelled = true; };
  }, [api, sessionId]);

  const create = async () => {
    if (!shareOrigin) {
      setStatus("Open this dashboard through a reachable LAN, Tailscale, or reverse-proxy URL before creating a share link. No share was created.");
      return;
    }
    setBusy(true);
    setStatus("Freezing redacted transcript…");
    try {
      const result = await api.createTranscriptShare(sessionId, { expiresInSeconds: ttl });
      setLink({ shareId: result.share.shareId, url: transcriptShareUrl(shareOrigin, result.token) });
      setShares((current) => [result.share, ...(current ?? [])]);
      setStatus("Link created. Its secret is shown only here; copy it before closing.");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (share: TranscriptShareView) => {
    if (!await confirm({
      title: "Revoke transcript share?",
      message: `The share expiring ${new Date(share.expiresAt).toLocaleString()} will stop working immediately.`,
      confirmLabel: "Revoke Share",
      tone: "danger",
    })) return;
    setBusy(true);
    try {
      const result = await api.revokeTranscriptShare(sessionId, share.shareId);
      setShares((current) => current?.map((item) => item.shareId === share.shareId ? result.share : item) ?? []);
      setLink((current) => current?.shareId === share.shareId ? null : current);
      setStatus("Share revoked");
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Share Operational Transcript"
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={<button className="btn" type="button" onClick={onClose}>Done</button>}
    >
      <p className="share-disclosure" id="share-transcript-disclosure">
        This freezes the same cached, possibly partial, operationally redacted projection as export.
        It may still contain secrets, source code, or personal data. Anyone with the link can read it until expiry or revocation.
      </p>
      <div className="share-create-row">
        <label htmlFor="share-expiry">Expires After</label>
        <select id="share-expiry" value={ttl} onChange={(event) => setTtl(Number(event.target.value))} disabled={busy}>
          {SHARE_EXPIRY_OPTIONS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
        </select>
        <button
          className="btn primary"
          type="button"
          onClick={() => void create()}
          disabled={busy || !shareOrigin}
          aria-describedby={shareOrigin ? "share-transcript-disclosure" : "share-transcript-disclosure share-origin-status"}
        >
          Create Link
        </button>
      </div>
      {!shareOrigin && (
        <p id="share-origin-status" className="share-status">
          Sharing is unavailable from a loopback or desktop-only origin. Open this dashboard through a reachable control-plane URL first.
        </p>
      )}
      {link && (
        <div className="share-created-link">
          <label htmlFor="created-share-link">One-Time Share Link</label>
          <div className="share-link-controls">
            <input ref={linkInputRef} id="created-share-link" readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} />
            <CopyButton
              text={link.url}
              label="Copy Link"
              onResult={(copied) => {
                if (copied) {
                  setStatus("Link copied");
                  return;
                }
                linkInputRef.current?.focus();
                linkInputRef.current?.select();
                setStatus("Clipboard access is unavailable. The link is selected; press Ctrl+C or Command+C to copy it.");
              }}
            />
          </div>
        </div>
      )}
      {status && <p className="share-status" role="status" aria-live="polite">{status}</p>}
      <h3>Issued Links</h3>
      {shares === null ? <p>Loading…</p> : shares.length === 0 ? <p>No share links have been issued.</p> : (
        <ul className="share-list">
          {shares.map((share) => (
            <li key={share.shareId}>
              <span>
                <strong>{titleCaseLabel(share.status)}</strong>
                <small>Created {new Date(share.createdAt).toLocaleString()} · expires {new Date(share.expiresAt).toLocaleString()}</small>
              </span>
              {share.status === "active" && (
                <button className="btn danger sm" type="button" disabled={busy} onClick={() => void revoke(share)} aria-label={`Revoke share expiring ${new Date(share.expiresAt).toLocaleString()}`}>
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
