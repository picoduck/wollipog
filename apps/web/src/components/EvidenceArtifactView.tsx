import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import { MAX_PROMPT_IMAGE_BYTES, MAX_SESSION_VIDEO_BYTES, PROMPT_IMAGE_MIME_TYPES, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { sha256Hex } from "../artifact-preview.js";
import { Modal } from "./common.js";
import { DecisionBlockedIcon, ErrorIcon, PlayIcon, SecureContextRequiredIcon } from "./Icons.js";

export type EvidenceItem = Extract<
  WorkflowDecisionResourceSnapshot,
  { category: "ui_evidence_approval" }
>["evidence"][number];

/** Every status but `ready` means the reviewer was not shown the evidence, so it cannot count as reviewed. */
export type EvidenceArtifactStatus = "pending" | "loading" | "ready" | "mismatch" | "unavailable" | "unverifiable";

export function evidenceStatusBlocksReview(status: EvidenceArtifactStatus): boolean {
  return status !== "ready";
}

/** Browsers expose SubtleCrypto only in a secure context: an HTTPS page or localhost. Plain HTTP at a
 * network address has none, and there the card cannot check any artifact against its digest. */
export function evidenceIntegrityCheckAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle);
}

/** An item that names a Session artifact is reviewed as that artifact's checked bytes or not at all. */
export function isArtifactBackedEvidence(item: EvidenceItem): item is EvidenceItem & { artifactId: string } {
  return typeof item.artifactId === "string" && item.artifactId.length > 0;
}

/** Only an artifact-backed image or browser-playable video is shown in place. Evidence without an artifact needs an
 * external link to be reviewable; an artifact of any other media type is blocked, even when it has a link. */
export function isRenderableEvidence(item: EvidenceItem): item is EvidenceItem & { artifactId: string; mediaType: string } {
  return isArtifactBackedEvidence(item) &&
    typeof item.mediaType === "string" &&
    [...PROMPT_IMAGE_MIME_TYPES, "video/mp4", "video/webm"].includes(item.mediaType.toLowerCase());
}

// A decision can carry 32 items. Loading waits for an item to approach the viewport, and even then
// only a few fetches run at once, so opening a large review does not pull every image immediately.
const MAX_CONCURRENT_LOADS = 3;
let activeLoads = 0;
const waitingLoads: Array<() => void> = [];

async function withLoadSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeLoads >= MAX_CONCURRENT_LOADS) await new Promise<void>((resolve) => waitingLoads.push(resolve));
  activeLoads += 1;
  try {
    return await task();
  } finally {
    activeLoads -= 1;
    waitingLoads.shift()?.();
  }
}

type LoadState =
  | { status: "pending" | "loading" }
  // The bytes matched the digest, but the browser has not yet proved it can draw them. A digest
  // match says the file is the one the request names; it does not say the file is a picture.
  | { status: "decoding"; url: string }
  | { status: "ready"; url: string }
  | { status: "mismatch" | "unverifiable" }
  | { status: "unavailable"; reason: string; retryable: boolean };

/** The pixel size the browser drew a shown artifact at: the capture's viewport. */
export interface EvidenceDimensions { width: number; height: number }

/**
 * A tile's state that is not a picture (§12.4; #2197): a 16px icon, a Title Case label and one short
 * sentence, with Retry when trying again can help. Shown in the tile's frame, where the image would be.
 */
export function EvidenceBlocked({ icon, label, detail, tone, action }: {
  icon: ReactNode;
  label: string;
  detail: ReactNode;
  /** `danger` for evidence that failed; `neutral` for evidence this page may not show. */
  tone: "danger" | "neutral";
  action?: ReactNode;
}) {
  return (
    <div className="ev-blocked" data-tone={tone}>
      <span className="ev-blocked-label">{icon}{label}</span>
      <span className="ev-blocked-detail">{detail}</span>
      {action}
    </div>
  );
}

/** One artifact-backed evidence image or recording, fetched with the reviewer's own access and checked
 * against the digest bound to the decision before anything is shown. It fills a tile's frame. */
export function EvidenceArtifactView({
  item,
  name,
  onStatusChange,
  onDimensions,
}: {
  item: EvidenceItem & { artifactId: string; mediaType: string };
  /** The tile's readable name ("Screenshot 2"), which also names its controls. */
  name: string;
  onStatusChange: (evidenceId: string, status: EvidenceArtifactStatus) => void;
  onDimensions?: (dimensions: EvidenceDimensions) => void;
}) {
  const api = useApi();
  const [state, setState] = useState<LoadState>({ status: "pending" });
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [attempt, setAttempt] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const isVideo = item.mediaType.toLowerCase().startsWith("video/");
  const containerRef = useRef<HTMLDivElement>(null);
  const enlargeRef = useRef<HTMLButtonElement>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onDimensionsRef = useRef(onDimensions);
  onDimensionsRef.current = onDimensions;
  const statusRef = useRef<LoadState["status"]>("pending");
  statusRef.current = state.status;

  useEffect(() => {
    if (visible || !containerRef.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "240px" });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    // Unchecked bytes are never shown as the evidence the request names, and there is no external
    // link to fall back on for an artifact-backed item, so bytes that cannot be checked are not
    // fetched at all: over plain HTTP they would only cross the network for nothing.
    if (!evidenceIntegrityCheckAvailable()) {
      setState({ status: "unverifiable" });
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void withLoadSlot(async (): Promise<LoadState> => {
      if (!active) return { status: "pending" };
      let blob: Blob;
      try {
        blob = await api.artifactExport(item.artifactId);
      } catch (error) {
        // The export route answers 404 both for a missing artifact and for a reviewer who may not
        // see it, deliberately. Neither will change on a retry, unlike a transport failure.
        const gone = error instanceof ApiError && (error.status === 404 || error.status === 403 || error.status === 410);
        return {
          status: "unavailable",
          reason: gone
            ? "It's gone, or you don't have access."
            : `Couldn't download it: ${error instanceof Error ? error.message : String(error)}`,
          retryable: !gone,
        };
      }
      if (blob.size > (isVideo ? MAX_SESSION_VIDEO_BYTES : MAX_PROMPT_IMAGE_BYTES)) {
        return { status: "unavailable", reason: "It's too large to show here.", retryable: false };
      }
      try {
        const bytes = await blob.arrayBuffer();
        if ((await sha256Hex(bytes)) !== item.sha256.toLowerCase()) return { status: "mismatch" };
        // Typed from the snapshot's allowlisted media type rather than the response header, so the
        // browser never interprets the bytes as anything but the raster image they were checked as.
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: item.mediaType.toLowerCase() }));
        return { status: "decoding", url: objectUrl };
      } catch (error) {
        // Reading or hashing failed. Without this the item would sit on "Loading" forever.
        return {
          status: "unavailable",
          reason: `Couldn't check it: ${error instanceof Error ? error.message : String(error)}`,
          retryable: true,
        };
      }
    }).then((next) => {
      if (active) setState(next);
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
    return () => {
      active = false;
      // Evidence may hold private data: release the bytes as soon as the card stops showing them.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, item.artifactId, item.mediaType, item.sha256, visible, attempt]);

  // To the card, an image still being decoded is an image that has not been shown.
  const reportedStatus: EvidenceArtifactStatus = state.status === "decoding" ? "loading" : state.status;
  useEffect(() => {
    onStatusChangeRef.current(item.evidenceId, reportedStatus);
  }, [item.evidenceId, reportedStatus]);

  const imageUrl = state.status === "decoding" || state.status === "ready" ? state.url : null;
  const onImageLoad = useCallback((dimensions: EvidenceDimensions) => {
    if (dimensions.width > 0 && dimensions.height > 0) onDimensionsRef.current?.(dimensions);
    setState((current) => current.status === "decoding" ? { status: "ready", url: current.url } : current);
  }, []);
  const onImageError = useCallback(() => {
    // Told to the card here, in the same event, rather than left to the status effect below. That
    // effect is passive: between this component committing "unavailable" and the effect running,
    // the card would still hold "ready" and leave Reviewed and Approve live for a queued click.
    // Both updates now land in one commit. The report is made under the same condition as the
    // state change below, so the card and this component can never disagree about an ignored event.
    if (statusRef.current !== "decoding" && statusRef.current !== "ready") return;
    onStatusChangeRef.current(item.evidenceId, "unavailable");
    setState((current) => current.status === "decoding" || current.status === "ready"
      ? {
          status: "unavailable",
          reason: "It matches its digest but can't be drawn.",
          retryable: false,
        }
      : current);
  }, [item.evidenceId]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return (
    <div className="ev-media" ref={containerRef} data-status={state.status} aria-busy={
      state.status === "pending" || state.status === "loading" || state.status === "decoding" || undefined}>
      {(state.status === "pending" || state.status === "loading" || state.status === "decoding") && (
        <span className="ev-loading">Loading…</span>
      )}
      {imageUrl && (
        <>
          {/* The tile's one viewer target. Mounted while decoding so the browser attempts the draw,
              but hidden and inert until it succeeds: a broken image must never look like evidence
              that was shown. The Evidence Viewer (#2207) takes over this button's activation. */}
          <button
            type="button"
            className="ev-thumb"
            ref={enlargeRef}
            hidden={state.status !== "ready"}
            disabled={state.status !== "ready"}
            onClick={() => setEnlarged(true)}
            aria-label={`Open ${name}`}
            data-ev-viewer-target=""
          >
            {isVideo ? (
              <>
                {/* The first frame, muted and still: the recording plays in the viewer. */}
                <video src={imageUrl} muted playsInline preload="auto" aria-hidden="true" tabIndex={-1}
                  onLoadedMetadata={(event) => {
                    if (!(event.currentTarget.videoWidth > 0 && event.currentTarget.videoHeight > 0)) onImageError();
                  }}
                  onLoadedData={(event) => {
                    const { videoWidth: width, videoHeight: height } = event.currentTarget;
                    if (width > 0 && height > 0) onImageLoad({ width, height });
                    else onImageError();
                  }}
                  onError={onImageError} />
                <span className="ev-play" aria-hidden="true"><PlayIcon /></span>
              </>
            ) : (
              <img src={imageUrl} alt={name}
                onLoad={(event) => onImageLoad({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                })}
                onError={onImageError} />
            )}
          </button>
          {enlarged && state.status === "ready" && (
            <Modal
              title={name}
              description={item.evidenceId}
              onClose={() => setEnlarged(false)}
              size="lg"
              returnFocusRef={enlargeRef}
            >
              {isVideo
                ? <video className="ev-full" src={imageUrl} controls playsInline preload="auto" aria-label={`Play ${name}`} />
                : <img className="ev-full" src={imageUrl} alt={name} />}
            </Modal>
          )}
        </>
      )}
      {state.status === "mismatch" && (
        <EvidenceBlocked tone="danger" icon={<DecisionBlockedIcon size={14} />} label="Doesn't Match"
          detail="It isn't the file the request names." />
      )}
      {state.status === "unavailable" && (
        <EvidenceBlocked tone="danger" icon={<ErrorIcon size={14} />} label="Can't Load" detail={state.reason}
          action={state.retryable
            ? <button type="button" className="btn sm" onClick={retry} aria-label={`Retry ${name}`}>Retry</button>
            : undefined} />
      )}
      {/* No external link here, even when the item has a `uri`: an artifact-backed item is reviewed
          as the checked artifact or not at all, so the reviewer never approves bytes nobody checked. */}
      {state.status === "unverifiable" && (
        <EvidenceBlocked tone="neutral" icon={<SecureContextRequiredIcon size={14} />} label="Not Shown"
          detail="Needs HTTPS or localhost." />
      )}
    </div>
  );
}

/** An artifact the card cannot draw. Its external copy, if any, is never offered in its place: nobody could check
 * that copy against the request's digest, so the item stays blocked and only Deny remains (#1792). */
export function UnrenderableEvidenceArtifact({ item }: { item: EvidenceItem }) {
  return (
    <div className="ev-media" data-status="unsupported">
      <EvidenceBlocked tone="danger" icon={<ErrorIcon size={14} />} label="Can't Show"
        detail={item.mediaType
          ? <><code>{item.mediaType}</code> can't be shown here.</>
          : "It declares no media type."} />
    </div>
  );
}

/** Says, once per card, why artifact evidence is not shown on this page and how to finish the review. */
export function EvidenceSecureContextNotice({ evidence }: { evidence: readonly EvidenceItem[] }) {
  if (evidenceIntegrityCheckAvailable() || !evidence.some(isRenderableEvidence)) return null;
  return (
    <Notice tone="warning" icon={<SecureContextRequiredIcon />} role="note" ariaLabel="HTTPS or Localhost Required"
      title="HTTPS or Localhost Required">
      <p>
        This page is open at <code>{window.location.origin}</code>. Browsers can check evidence against the
        request's digest only on HTTPS or localhost pages, so artifact evidence is not shown here and cannot be
        marked reviewed. You can still deny the request from this page.
      </p>
      <p>
        To finish the review, reopen Wollipog over HTTPS, for example through <code>tailscale serve</code>, or on
        localhost on the machine that runs it.
      </p>
    </Notice>
  );
}
