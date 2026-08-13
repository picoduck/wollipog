import { useEffect, useRef, useState, type FormEvent } from "react";
import type { SessionView, WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { normalizeBrowserUrl } from "../artifact-preview.js";
import { formatBytes } from "../files-panel.js";
import { titleCaseLabel } from "../format.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { ArtifactPreview } from "./ArtifactPreview.js";

type BrowserMode = "artifacts" | "web";

export function BrowserPanel({ session }: { session: SessionView }) {
  const api = useApi();
  const [mode, setMode] = useState<BrowserMode>("artifacts");
  const [urlInput, setUrlInput] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<WorkflowArtifactView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkflowArtifactView | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setArtifacts([]);
    setCursor(undefined);
    setSelected(null);
    setListBusy(true);
    setListError(null);
    void api.sessionWorkflowArtifacts(session.id).then((page) => {
      if (generation !== generationRef.current) return;
      setArtifacts(page.artifacts);
      setCursor(page.nextCursor);
    }).catch((cause: unknown) => {
      if (generation === generationRef.current) setListError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (generation === generationRef.current) setListBusy(false);
    });
    return () => { generationRef.current++; };
  }, [api, session.id]);

  const loadMore = async () => {
    if (!cursor || listBusy) return;
    const generation = generationRef.current;
    setListBusy(true);
    try {
      const page = await api.sessionWorkflowArtifacts(session.id, cursor);
      if (generation !== generationRef.current) return;
      setArtifacts((current) => {
        const merged = new Map(current.map((artifact) => [artifact.artifactId, artifact]));
        for (const artifact of page.artifacts) merged.set(artifact.artifactId, artifact);
        return [...merged.values()];
      });
      setCursor(page.nextCursor);
      setListError(null);
    } catch (cause) {
      if (generation === generationRef.current) setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current) setListBusy(false);
    }
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBrowserUrl(urlInput);
    if (!normalized.ok) {
      setUrlError(normalized.error);
      return;
    }
    setUrl(normalized.url);
    setUrlInput(normalized.url);
    setUrlError(null);
  };

  return (
    <div className="browser-panel">
      <div className="scope-seg browser-tabs" role="radiogroup" aria-label="Browser Content" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "radio")}>
        {(["artifacts", "web"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="radio"
            aria-checked={mode === candidate}
            tabIndex={mode === candidate ? 0 : -1}
            className={`scope-opt${mode === candidate ? " is-active" : ""}`}
            onClick={() => setMode(candidate)}
          >
            {candidate === "artifacts" ? "Artifacts" : "Web URL"}
          </button>
        ))}
      </div>

      {mode === "web" ? (
        <div className="browser-web">
          <form className="browser-address" onSubmit={navigate}>
            <label className="sr-only" htmlFor="browser-url">Web Preview URL</label>
            <input
              id="browser-url"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder="https://localhost:3000"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="btn primary sm" type="submit">Go</button>
          </form>
          {urlError && <div className="composer-error" role="alert">{urlError}</div>}
          <div className="muted sm browser-security-note">Remote pages receive no device token, referrer, session data, or same-origin privileges.</div>
          {url ? (
            <>
              <div className="browser-web-actions">
                <span className="muted sm" title={url}>{new URL(url).host}</span>
                <button className="btn ghost sm" type="button" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>Open Externally</button>
              </div>
              <iframe
                key={url}
                className="browser-web-frame"
                title={`Web preview of ${url}`}
                src={url}
                sandbox="allow-forms allow-scripts"
                referrerPolicy="no-referrer"
              />
            </>
          ) : <div className="hint">Enter a complete HTTP or HTTPS URL to open it in the isolated preview.</div>}
        </div>
      ) : selected ? (
        <div className="browser-artifact-detail">
          <div className="browser-artifact-head">
            <button className="icon-btn" type="button" aria-label="Back to Artifact List" onClick={() => setSelected(null)}>‹</button>
            <strong>{selected.name}</strong>
          </div>
          <ArtifactPreview artifact={selected} />
        </div>
      ) : (
        <div className="browser-artifacts">
          <p className="muted sm">Session artifacts are listed without loading their bodies. Choose one to fetch and verify its exact bytes.</p>
          {listError && <div className="composer-error" role="alert">{listError}</div>}
          <ul className="browser-artifact-list" aria-busy={listBusy}>
            {artifacts.map((artifact) => (
              <li key={artifact.artifactId}>
                <button type="button" className="browser-artifact-row" onClick={() => setSelected(artifact)}>
                  <span><strong>{artifact.name}</strong><small>{titleCaseLabel(artifact.kind.replaceAll("_", " "))}</small></span>
                  <span className="muted sm">{formatBytes(artifact.sizeBytes)}</span>
                </button>
              </li>
            ))}
          </ul>
          {!listBusy && artifacts.length === 0 && !listError && <div className="hint">No artifacts are attached to this session yet.</div>}
          {listBusy && artifacts.length === 0 && <div className="hint" role="status">Loading artifacts…</div>}
          {cursor && <button className="btn ghost sm" type="button" disabled={listBusy} onClick={() => void loadMore()}>{listBusy ? "Loading…" : "Load More"}</button>}
        </div>
      )}
    </div>
  );
}
