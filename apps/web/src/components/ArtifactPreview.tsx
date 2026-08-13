import { useEffect, useRef, useState } from "react";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { artifactDownloadFilename } from "../artifact-download.js";
import {
  classifyArtifactPreview,
  sandboxHtmlDocument,
  verifyArtifactPreviewBlob,
  type ArtifactPreviewClass,
} from "../artifact-preview.js";
import { requestBlobDownload } from "../transcript-download.js";
import { Markdown } from "./Markdown.js";

type LoadedPreview =
  | { kind: "html"; source: string; blob: Blob }
  | { kind: "image"; objectUrl: string; blob: Blob }
  | { kind: "json" | "markdown" | "text"; text: string; blob: Blob };

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Explicit, authenticated artifact materialization shared by run detail and the Browser panel. */
export function ArtifactPreview({ artifact }: { artifact: WorkflowArtifactView }) {
  const api = useApi();
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    let objectUrl: string | null = null;
    setLoaded(null);
    setError(null);
    setBusy(true);

    const previewClass: ArtifactPreviewClass = classifyArtifactPreview(artifact);
    if (previewClass === "unsupported") {
      setBusy(false);
      setError("This artifact type has no safe in-app preview.");
      return () => { requestRef.current++; };
    }

    void api.artifactExport(artifact.artifactId).then(async (blob) => {
      const bytes = await verifyArtifactPreviewBlob(artifact, blob);
      if (requestRef.current !== request) return;
      if (previewClass === "image") {
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: artifact.mimeType }));
        setLoaded({ kind: "image", objectUrl, blob });
      } else {
        let text = decodeUtf8(bytes);
        if (previewClass === "json") text = JSON.stringify(JSON.parse(text) as unknown, null, 2);
        setLoaded(previewClass === "html"
          ? { kind: "html", source: sandboxHtmlDocument(text), blob }
          : { kind: previewClass, text, blob });
      }
    }).catch((cause: unknown) => {
      if (requestRef.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (requestRef.current === request) setBusy(false);
    });

    return () => {
      requestRef.current++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifact]);

  const download = async () => {
    if (downloadBusy) return;
    setDownloadBusy(true);
    try {
      const blob = loaded?.blob ?? await api.artifactExport(artifact.artifactId);
      if (!loaded) await verifyArtifactPreviewBlob(artifact, blob);
      requestBlobDownload(blob, artifactDownloadFilename(artifact.kind, artifact.mimeType));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloadBusy(false);
    }
  };

  return (
    <div className="artifact-preview" aria-busy={busy}>
      <div className="artifact-preview-meta">
        <span>{artifact.mimeType} · {artifact.sizeBytes.toLocaleString()} Bytes · {artifact.sha256.slice(0, 12)}</span>
        <button className="btn ghost sm" type="button" disabled={downloadBusy} onClick={() => void download()}>
          {downloadBusy ? "Downloading…" : "Download Raw"}
        </button>
      </div>
      <p className="muted sm">Previewed bytes are exact and authenticated. Raw downloads are not redacted and may contain secrets or personal data.</p>
      {busy && <div className="hint" role="status">Loading and verifying preview…</div>}
      {error && <div className="composer-error" role="alert">{error}</div>}
      {loaded?.kind === "image" && <img className="artifact-preview-image" src={loaded.objectUrl} alt={artifact.name} />}
      {loaded?.kind === "html" && (
        <iframe
          className="artifact-preview-frame"
          title={`${artifact.name} HTML preview`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={loaded.source}
        />
      )}
      {loaded?.kind === "markdown" && <div className="artifact-preview-markdown"><Markdown>{loaded.text}</Markdown></div>}
      {(loaded?.kind === "text" || loaded?.kind === "json") && <pre className="artifact-preview-text"><code>{loaded.text}</code></pre>}
    </div>
  );
}
