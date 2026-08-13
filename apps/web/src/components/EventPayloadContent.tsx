import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  validateEventPayloadReferences,
  type EventPayloadReference,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";

function digestHex(bytes: ArrayBuffer): Promise<string> {
  if (!globalThis.crypto?.subtle) return Promise.reject(new Error("SHA-256 verification is unavailable"));
  return globalThis.crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(""));
}

export async function loadEventPayloadReferences(
  references: unknown,
  expectedMimeType: EventPayloadReference["mimeType"],
  fetchArtifact: (artifactId: string) => Promise<Blob>,
): Promise<string> {
  const validation = validateEventPayloadReferences(references, expectedMimeType);
  if (!validation.ok) throw new Error(validation.error);
  let total = 0;
  const parts: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const reference of validation.value) {
    total += reference.sizeBytes;
    if (total > EVENT_PAYLOAD_MAX_BYTES) throw new Error("event payload exceeds the aggregate fetch limit");
    const blob = await fetchArtifact(reference.artifactId);
    const mimeType = blob.type.split(";", 1)[0]!.trim().toLowerCase();
    if (mimeType !== reference.mimeType || blob.size !== reference.sizeBytes) {
      throw new Error("event payload artifact metadata does not match its reference");
    }
    const bytes = await blob.arrayBuffer();
    if (await digestHex(bytes) !== reference.sha256) {
      throw new Error("event payload artifact digest does not match its reference");
    }
    parts.push(decoder.decode(bytes));
  }
  return parts.join("");
}

function sizeLabel(references: readonly EventPayloadReference[]): string {
  const bytes = references.reduce((total, reference) => total + reference.sizeBytes, 0);
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`;
}

/** Preview-first, explicit-load rendering. Loaded text stays local to the virtualized row and is
 * discarded on hide, reference replacement, or unmount. */
export function EventPayloadContent({
  preview,
  references,
  mimeType,
  label,
  appendFull = false,
  children,
}: {
  preview: string;
  references?: EventPayloadReference[];
  mimeType: EventPayloadReference["mimeType"];
  label: string;
  appendFull?: boolean;
  children: (text: string, full: boolean) => ReactNode;
}) {
  const api = useApi();
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const referenceKey = useMemo(() => JSON.stringify(references ?? []), [references]);

  useEffect(() => {
    generation.current += 1;
    setLoaded(null);
    setError(null);
    setLoading(false);
    return () => { generation.current += 1; };
  }, [referenceKey]);

  const load = useCallback(() => {
    if (!references?.length || loading) return;
    const expectedGeneration = generation.current;
    setLoading(true);
    setError(null);
    void loadEventPayloadReferences(references, mimeType, api.artifactExport).then((text) => {
      if (generation.current === expectedGeneration) setLoaded(text);
    }).catch((cause) => {
      if (generation.current === expectedGeneration) setError((cause as Error).message);
    }).finally(() => {
      if (generation.current === expectedGeneration) setLoading(false);
    });
  }, [api, loading, mimeType, referenceKey, references]);

  if (!references?.length) return <>{children(preview, false)}</>;
  return (
    <div className="event-payload-content">
      {children(appendFull ? preview : (loaded ?? preview), Boolean(loaded) && !appendFull)}
      {appendFull && loaded && (
        <div className="event-payload-full">
          <div className="event-payload-full-label">Full {label}</div>
          {children(loaded, true)}
        </div>
      )}
      <div className="event-payload-actions">
        <button type="button" className="btn-link" disabled={loading} onClick={loaded ? () => setLoaded(null) : load}>
          {loaded ? `Hide full ${label}` : loading ? `Loading full ${label}…` : `Load full ${label} (${sizeLabel(references)})`}
        </button>
        {error && <span className="event-payload-error" role="alert">{error}; retry is available.</span>}
      </div>
    </div>
  );
}
