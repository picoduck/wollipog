import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { verifyArtifactPreviewBlob } from "../artifact-preview.js";
import { DEVICE_TOKEN_CHANGED_EVENT } from "../device-token.js";

const MAX_RETAINED_IMAGES = 32;
const MAX_RETAINED_BYTES = 32 * 1024 * 1024;

/** Verified image bytes belong to one mounted transcript and one API client. Object URLs stay
 * with the visible preview and are revoked on row unmount. */
export class TranscriptImageCache {
  private retained = new Map<string, Blob>();
  private inFlight = new Map<string, Promise<Blob>>();
  private retainedBytes = 0;
  private disposed = false;
  private owners = 0;

  retain(): void {
    this.owners++;
  }

  release(): void {
    this.owners--;
    // StrictMode replays effect cleanup and setup in one task. Keep its in-flight request and
    // verified bytes through that replay, but clear them after a real transcript unmount.
    queueMicrotask(() => {
      if (this.owners === 0) this.dispose();
    });
  }

  async load(artifact: WorkflowArtifactView, exportArtifact: (id: string) => Promise<Blob>): Promise<Blob> {
    const key = JSON.stringify([
      artifact.sessionId, artifact.artifactId, artifact.kind, artifact.mimeType,
      artifact.encoding, artifact.sizeBytes, artifact.sha256,
    ]);
    const retained = this.retained.get(key);
    if (retained) {
      this.retained.delete(key);
      this.retained.set(key, retained);
      return retained;
    }
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      const blob = await exportArtifact(artifact.artifactId);
      const bytes = await verifyArtifactPreviewBlob(artifact, blob);
      const verified = new Blob([bytes], { type: artifact.mimeType });
      if (!this.disposed && verified.size <= MAX_RETAINED_BYTES) {
        while (this.retained.size >= MAX_RETAINED_IMAGES ||
            this.retainedBytes + verified.size > MAX_RETAINED_BYTES) {
          const oldest = this.retained.keys().next().value;
          if (oldest === undefined) break;
          this.retainedBytes -= this.retained.get(oldest)!.size;
          this.retained.delete(oldest);
        }
        this.retained.set(key, verified);
        this.retainedBytes += verified.size;
      }
      return verified;
    })();
    this.inFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retained.clear();
    this.inFlight.clear();
    this.retainedBytes = 0;
  }
}

const Context = createContext<TranscriptImageCache | null>(null);

export function TranscriptImageCacheProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const api = useApi();
  const [credentialEpoch, credentialChanged] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === "wollipog.deviceToken" || event.key === null) credentialChanged();
    };
    window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, credentialChanged);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, credentialChanged);
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled]);
  const cache = useMemo(() => enabled ? new TranscriptImageCache() : null, [api, enabled, credentialEpoch]);
  useEffect(() => {
    cache?.retain();
    return () => cache?.release();
  }, [cache]);
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}

export function useTranscriptImageCache(): TranscriptImageCache | null {
  return useContext(Context);
}
