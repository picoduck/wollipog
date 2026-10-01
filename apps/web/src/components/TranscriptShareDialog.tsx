import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type { TranscriptShareView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { CONTROL_PLANE_HTTP, hasSameOriginMarker } from "../config.js";
import { useInstances } from "../instances-context.js";
import { isMacPlatform } from "../shortcuts.js";
import { statusMeta } from "../status-meta.js";
import { reachableTranscriptShareOrigin, transcriptShareUrl } from "../transcript-share-client.js";
import { shareCreatedLabel, shareDisplayStatus, shareExpiryLabel, shareMoment } from "../transcript-share-time.js";
import { CopyButton } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";

type ShareExpiry = "hour" | "day" | "week" | "month";

const SHARE_EXPIRY_OPTIONS = [
  { value: "hour", label: "1 Hour" },
  { value: "day", label: "1 Day" },
  { value: "week", label: "7 Days" },
  { value: "month", label: "30 Days" },
] as const satisfies readonly { value: ShareExpiry; label: string }[];

const SHARE_EXPIRY_SECONDS: Record<ShareExpiry, number> = {
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
};

/** The dialog's fixed copy, read by the UI copy test: titles, labels and buttons in Title Case, the
 * description, helpers and toasts in sentence case (§17.1). */
export const TRANSCRIPT_SHARE_COPY = {
  title: "Share Transcript",
  description: "Anyone with the link can read this conversation until it expires or you revoke it.",
  expiryLabel: "Link Expires",
  expiryHelper: "The link shows a redacted copy of the transcript as it is now. It can still include secrets or source code.",
  create: "Create Link",
  creating: "Creating the link…",
  linkLabel: "New Link",
  copy: "Copy Link",
  linkHelper: "Copy it now. For your security, the full link isn't shown again.",
  copied: "Link copied.",
  unavailableTitle: "Sharing Needs a Reachable Address",
  unavailableBody: "Open Wollipog from an address other people can reach, such as your LAN or Tailscale URL, then create the link.",
  linksTitle: "Links",
  loading: "Loading links…",
  empty: "No links yet.",
  loadErrorTitle: "Couldn't Load Links",
  loadErrorBody: "Wollipog couldn't list this session's links.",
  createErrorTitle: "Couldn't Create the Link",
  revoke: "Revoke…",
  revoking: "Revoking the link…",
  revoked: "Link revoked.",
} as const;

/** What the helper under New Link says once copying failed and the link is selected instead. */
export function copyShortcutHelper(mac = isMacPlatform()): string {
  return `Your browser didn't allow copying, so the link is selected. Press ${mac ? "⌘C" : "Ctrl+C"} to copy it.`;
}

const STATUS_RANK: Record<TranscriptShareView["status"], number> = { active: 0, expired: 1, revoked: 2 };

/**
 * The list to show: the server's, with every link this dialog created or revoked laid over it. A list
 * requested before a create, or answered before a revoke, would otherwise drop the new row or bring a
 * revoked link back as Active. A link only moves forward (active, then expired or revoked), so of two
 * views of one link the further one wins, and the server's when they agree.
 */
export function mergeShareViews(
  server: readonly TranscriptShareView[],
  known: ReadonlyMap<string, TranscriptShareView>,
): TranscriptShareView[] {
  const merged = new Map(server.map((share) => [share.shareId, share]));
  for (const [shareId, local] of known) {
    const current = merged.get(shareId);
    if (!current || STATUS_RANK[local.status] > STATUS_RANK[current.status]) merged.set(shareId, local);
  }
  return [...merged.values()];
}

/** Focus is on nothing: the element that had it was removed, or it was never placed. */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** How often the rows' relative times are refreshed while the dialog is open. */
const CLOCK_MS = 30_000;
const SKELETON_ROWS = 3;

/**
 * Share Transcript (#2148; docs/design-system.md §7.2–§7.5, §10.2, §13.2, §5.2, §11.1, §13.1).
 *
 * One dialog anatomy: the title and a one-sentence description, then the one thing to decide (the
 * expiry), the new link once it exists, or why sharing is impossible from this address; under it the
 * Links section. Its footer is Cancel and Create Link until a link exists or sharing is unavailable,
 * and a single Done after.
 *
 * Room for one later row: a consent checkbox (include the session title, #2189) goes in the form
 * column above Link Expires, and its "Includes session title" fact joins `.share-link-meta` on line two
 * of a link row, after the creation time.
 */
export function TranscriptShareDialog({ sessionId, onClose, returnFocusRef }: {
  sessionId: string;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const instances = useInstances();
  const { confirm, showToast } = useFeedback();
  const ids = useId();
  const [shares, setShares] = useState<TranscriptShareView[] | null>(null);
  /** Every link this dialog created or revoked, as its response returned it (`mergeShareViews`). */
  const known = useRef(new Map<string, TranscriptShareView>());
  const remember = (share: TranscriptShareView) => {
    known.current.set(share.shareId, share);
    setShares((current) => current && mergeShareViews(current, known.current));
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<ShareExpiry>("day");
  const [link, setLink] = useState<{ shareId: string; url: string } | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const linkInputRef = useRef<HTMLInputElement>(null);
  const copyButtonHost = useRef<HTMLDivElement>(null);
  const linksTitleRef = useRef<HTMLHeadingElement>(null);
  const loadGeneration = useRef(0);
  const mounted = useRef(true);

  const remote = instances.activeProfile.kind === "remote";
  const sameOriginServed = remote || hasSameOriginMarker(window);
  // The address another browser would be sent to, shown behind Show Details when it is unreachable.
  const candidateOrigin = remote
    ? instances.activeProfile.origin
    : sameOriginServed ? window.location.origin : CONTROL_PLANE_HTTP;
  const shareOrigin = reachableTranscriptShareOrigin(candidateOrigin, candidateOrigin, true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Each load is fenced by its generation, so a slower earlier request can neither overwrite a newer
  // list nor raise an error over it; a newer success clears an earlier error.
  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setLoadError(null);
    setShares(null);
    void api.transcriptShares(sessionId).then(
      ({ shares: next }) => {
        if (!mounted.current || generation !== loadGeneration.current) return;
        setShares(mergeShareViews(next, known.current));
        setLoadError(null);
      },
      (error: unknown) => {
        if (!mounted.current || generation !== loadGeneration.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      },
    );
  }, [api, sessionId]);

  useEffect(() => {
    load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const create = async () => {
    if (!shareOrigin || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const result = await api.createTranscriptShare(sessionId, { expiresInSeconds: SHARE_EXPIRY_SECONDS[expiry] });
      if (!mounted.current) return;
      setLink({ shareId: result.share.shareId, url: transcriptShareUrl(shareOrigin, result.token) });
      setCopyFailed(false);
      setNow(Date.now());
      // A list still loading, or loaded again after a failure, takes the new row when it arrives.
      remember(result.share);
    } catch (error) {
      if (mounted.current) setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setCreating(false);
    }
  };

  // Whether keyboard focus was last inside Share Transcript, rather than in a confirmation stacked
  // over it or nowhere yet (the dialog focuses its card once open).
  const focusInside = useRef(false);
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const panel = linksTitleRef.current?.closest(".share-dialog");
      focusInside.current = Boolean(panel && event.target instanceof Node && panel.contains(event.target));
    };
    // Modal focuses its card before this effect runs, so the current focus is read once here.
    const panel = linksTitleRef.current?.closest(".share-dialog");
    focusInside.current = Boolean(panel && document.activeElement && panel.contains(document.activeElement));
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);

  // Several commits unmount the control that has focus: Create Link and the expiry when a link is
  // created, Revoke… when its link is revoked (even after the person cancelled the confirmation while
  // the request ran) or expires on the clock, and Retry when it starts loading. Focus would fall to the
  // page, outside the dialog's Tab trap. After every commit, focus that was in the dialog and is now
  // lost moves to the next step: Copy Link for a link just created, otherwise the Links title. Focus
  // that is still somewhere, such as in a confirmation stacked over the dialog, is never moved.
  const linkShareId = link?.shareId;
  const focusedLink = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusLost() || !focusInside.current) return;
    if (linkShareId && focusedLink.current !== linkShareId) {
      const copy = copyButtonHost.current?.querySelector<HTMLButtonElement>("button");
      if (copy) {
        focusedLink.current = linkShareId;
        copy.focus();
        return;
      }
    }
    linksTitleRef.current?.focus();
  });

  const revoke = async (share: TranscriptShareView, trigger: HTMLButtonElement) => {
    const moment = shareMoment(share.expiresAt, Date.now());
    const confirmed = await confirm({
      title: "Revoke Link",
      message: `The link that expires ${moment} stops working right away. Anyone who has it loses access.`,
      confirmLabel: "Revoke Link",
      tone: "danger",
      progress: TRANSCRIPT_SHARE_COPY.revoking,
      returnFocus: { current: trigger },
      onConfirm: async () => {
        const result = await api.revokeTranscriptShare(sessionId, share.shareId);
        if (!mounted.current) return;
        remember(result.share);
        setLink((current) => current?.shareId === result.share.shareId ? null : current);
      },
    });
    if (!confirmed) return;
    showToast(TRANSCRIPT_SHARE_COPY.revoked, { tone: "success" });
    // The confirmation's own focus return, which runs before this, found Revoke… gone and left focus
    // on nothing or on this dialog's card.
    window.setTimeout(() => {
      if (!mounted.current || trigger.isConnected) return;
      const card = linksTitleRef.current?.closest(".share-dialog");
      if (focusLost() || document.activeElement === card) linksTitleRef.current?.focus();
    }, 0);
  };

  const ordered = shares ? [...shares].sort((a, b) => b.createdAt - a.createdAt) : null;
  const canCreate = Boolean(shareOrigin) && !link;
  const footer = canCreate ? (
    <>
      <button className="btn" type="button" onClick={onClose}>Cancel</button>
      <BusyButton className="btn primary" busy={creating} progress={TRANSCRIPT_SHARE_COPY.creating} onClick={() => void create()}>
        {TRANSCRIPT_SHARE_COPY.create}
      </BusyButton>
    </>
  ) : (
    <button className="btn" type="button" onClick={onClose}>Done</button>
  );

  const linksTitleId = `${ids}-links`;
  const linkInputId = `${ids}-link`;
  const linkHelperId = `${ids}-link-helper`;

  return (
    <Modal
      title={TRANSCRIPT_SHARE_COPY.title}
      description={TRANSCRIPT_SHARE_COPY.description}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      className="share-dialog"
      footer={footer}
    >
      {!shareOrigin ? (
        <Notice
          tone="warning"
          title={TRANSCRIPT_SHARE_COPY.unavailableTitle}
          details={(
            <p className="share-address-detail">
              Wollipog is open at <code>{candidateOrigin}</code>, which other people can't reach.
            </p>
          )}
        >
          {TRANSCRIPT_SHARE_COPY.unavailableBody}
        </Notice>
      ) : link ? (
        <div className="field">
          <div className="field-head"><label htmlFor={linkInputId}>{TRANSCRIPT_SHARE_COPY.linkLabel}</label></div>
          <div className="share-link-controls" ref={copyButtonHost}>
            <input
              ref={linkInputRef}
              id={linkInputId}
              className="input share-link-input"
              readOnly
              value={link.url}
              aria-describedby={linkHelperId}
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton
              className="btn"
              text={link.url}
              label={TRANSCRIPT_SHARE_COPY.copy}
              describedBy={linkHelperId}
              onResult={(copied) => {
                setCopyFailed(!copied);
                if (copied) {
                  showToast(TRANSCRIPT_SHARE_COPY.copied, { tone: "success" });
                  return;
                }
                linkInputRef.current?.focus();
                linkInputRef.current?.select();
              }}
            />
          </div>
          <p className="field-helper" id={linkHelperId} aria-live="polite">
            {copyFailed ? copyShortcutHelper() : TRANSCRIPT_SHARE_COPY.linkHelper}
          </p>
        </div>
      ) : (
        <div className="field">
          <div className="field-head"><span id={`${ids}-expiry`}>{TRANSCRIPT_SHARE_COPY.expiryLabel}</span></div>
          <SegmentedControl<ShareExpiry>
            className="block"
            label={TRANSCRIPT_SHARE_COPY.expiryLabel}
            options={SHARE_EXPIRY_OPTIONS}
            value={expiry}
            onChange={setExpiry}
          />
          <p className="field-helper">{TRANSCRIPT_SHARE_COPY.expiryHelper}</p>
        </div>
      )}

      <section className="section share-links" aria-labelledby={linksTitleId}>
        <div className="section-head">
          <h3 className="section-title" id={linksTitleId} ref={linksTitleRef} tabIndex={-1}>
            {TRANSCRIPT_SHARE_COPY.linksTitle}
            {ordered && ordered.length > 0 && <span className="count share-links-count">{ordered.length}</span>}
          </h3>
        </div>
        {loadError !== null ? (
          <Notice
            tone="danger"
            role="alert"
            title={TRANSCRIPT_SHARE_COPY.loadErrorTitle}
            actions={<button className="btn sm" type="button" onClick={load}>Retry</button>}
            details={<p className="share-error-detail">{loadError}</p>}
          >
            {TRANSCRIPT_SHARE_COPY.loadErrorBody}
          </Notice>
        ) : ordered === null ? (
          <div className="surface" role="status" data-loading="links" aria-live="polite">
            <span className="sr-only">{TRANSCRIPT_SHARE_COPY.loading}</span>
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div className="row row-2" key={index} aria-hidden="true">
                <span className="row-body">
                  <span className="skeleton-bar title" />
                  <span className="skeleton-bar" />
                </span>
              </div>
            ))}
          </div>
        ) : ordered.length === 0 ? (
          <p className="share-links-empty">{TRANSCRIPT_SHARE_COPY.empty}</p>
        ) : (
          <div className="surface">
            {ordered.map((share) => {
              const status = shareDisplayStatus(share, now);
              return (
                <div className="row row-2" key={share.shareId} data-share-id={share.shareId}>
                  <span className="row-body">
                    <span className="row-line">
                      <span className="row-title">{shareExpiryLabel(share, now)}</span>
                      <StatusBadge meta={statusMeta("share", status)} inline />
                    </span>
                    <span className="row-sub share-link-meta">
                      <span>{shareCreatedLabel(share.createdAt, now)}</span>
                    </span>
                  </span>
                  {status === "active" && (
                    <button
                      className="btn sm ghost danger"
                      type="button"
                      aria-label={`Revoke Link That Expires ${shareMoment(share.expiresAt, now)}`}
                      onClick={(event) => void revoke(share, event.currentTarget)}
                    >
                      {TRANSCRIPT_SHARE_COPY.revoke}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {createError !== null && (
        <Notice tone="danger" role="alert" title={TRANSCRIPT_SHARE_COPY.createErrorTitle}>{createError}</Notice>
      )}
    </Modal>
  );
}
