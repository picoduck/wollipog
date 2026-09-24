import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_PROMPT_IMAGE_BYTES, PROMPT_IMAGE_MIME_TYPES, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { sha256Hex } from "../artifact-preview.js";
import { Modal } from "./common.js";

export type EvidenceItem = Extract<
  WorkflowDecisionResourceSnapshot,
  { category: "ui_evidence_approval" }
>["evidence"][number];

/** `blocked` statuses mean the reviewer was not shown the evidence, so it cannot count as reviewed. */
export type EvidenceArtifactStatus = "pending" | "loading" | "ready" | "mismatch" | "unavailable" | "unverifiable";

export function evidenceStatusBlocksReview(status: EvidenceArtifactStatus): boolean {
  return status === "pending" || status === "loading" || status === "mismatch" || status === "unavailable";
}

/** Only an artifact-backed raster image is shown in place. Other evidence needs an external link
 * to be reviewable; an item with neither a renderable artifact nor a link is blocked. */
export function isRenderableEvidence(item: EvidenceItem): item is EvidenceItem & { artifactId: string; mediaType: string } {
  return typeof item.artifactId === "string" && item.artifactId.length > 0 &&
    typeof item.mediaType === "string" &&
    (PROMPT_IMAGE_MIME_TYPES as readonly string[]).includes(item.mediaType.toLowerCase());
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

/** One artifact-backed evidence image, fetched with the reviewer's own access and checked against
 * the digest bound to the decision before anything is shown. */
export function EvidenceArtifactView({
  item,
  onStatusChange,
}: {
  item: EvidenceItem & { artifactId: string; mediaType: string };
  onStatusChange: (evidenceId: string, status: EvidenceArtifactStatus) => void;
}) {
  const api = useApi();
  const [state, setState] = useState<LoadState>({ status: "pending" });
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [attempt, setAttempt] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const enlargeRef = useRef<HTMLButtonElement>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
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
            ? "This artifact is no longer available, or you do not have access to it."
            : `This artifact could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          retryable: !gone,
        };
      }
      if (blob.size > MAX_PROMPT_IMAGE_BYTES) {
        return { status: "unavailable", reason: "This artifact is too large to show here.", retryable: false };
      }
      // Without SubtleCrypto (plain HTTP on a non-localhost origin) the bytes cannot be checked, and
      // unchecked bytes are not shown as the evidence the request names.
      if (!globalThis.crypto?.subtle) return { status: "unverifiable" };
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
          reason: `This artifact could not be checked: ${error instanceof Error ? error.message : String(error)}`,
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
  const onImageLoad = useCallback(() => {
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
          reason: "This artifact matches its recorded digest but could not be displayed as an image.",
          retryable: false,
        }
      : current);
  }, [item.evidenceId]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  return (
    <div className="evidence-artifact" ref={containerRef} data-status={state.status}>
      {(state.status === "pending" || state.status === "loading" || state.status === "decoding") && (
        <p className="evidence-artifact-state muted" role="status">Loading evidence…</p>
      )}
      {imageUrl && (
        <>
          {/* Mounted while decoding so the browser attempts the draw, but hidden and inert until it
              succeeds: a broken image must never look like evidence that was shown. */}
          <button
            type="button"
            className="evidence-artifact-thumb"
            ref={enlargeRef}
            hidden={state.status !== "ready"}
            disabled={state.status !== "ready"}
            onClick={() => setEnlarged(true)}
            aria-label={`Enlarge Evidence: ${item.evidenceId}`}
          >
            <img src={imageUrl} alt={`Evidence: ${item.evidenceId}`} onLoad={onImageLoad} onError={onImageError} />
          </button>
          {enlarged && state.status === "ready" && (
            <Modal
              title={item.evidenceId}
              onClose={() => setEnlarged(false)}
              wide
              returnFocusRef={enlargeRef}
            >
              <img className="evidence-artifact-full" src={imageUrl} alt={`Evidence: ${item.evidenceId}`} />
            </Modal>
          )}
        </>
      )}
      {state.status === "mismatch" && (
        <p className="evidence-artifact-state form-error" role="alert">
          This artifact does not match the digest recorded in the request, so it is not shown.
        </p>
      )}
      {state.status === "unavailable" && (
        <div className="evidence-artifact-state form-error" role="alert">
          <p>{state.reason}</p>
          {state.retryable && <button type="button" className="btn ghost sm" onClick={retry}>Retry</button>}
        </div>
      )}
      {state.status === "unverifiable" && (
        <div className="evidence-artifact-state muted" role="status">
          <p>Evidence integrity checks require HTTPS or localhost, so the artifact is not shown here.</p>
          {item.uri && <a className="btn ghost sm" href={item.uri} target="_blank" rel="noreferrer"
            aria-label={`View External Evidence: ${item.evidenceId}`}>
            View External Evidence
          </a>}
        </div>
      )}
    </div>
  );
}
