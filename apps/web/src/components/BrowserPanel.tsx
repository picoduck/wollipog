import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArtifactUploadNotice } from "./ArtifactUploadNotice.js";
import { Notice } from "./Notice.js";
import { TabList } from "./Tabs.js";
import { State } from "./State.js";
import { ListFoot } from "./ListFoot.js";
import { PanelToolLayout } from "./PanelToolLayout.js";
import { FieldError } from "./FieldError.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import {
  DiffIcon, ExternalLinkIcon, GlobeIcon, HtmlIcon, ImageIcon, JsonIcon, LogIcon, RefreshIcon, ReportIcon, VideoIcon,
} from "./Icons.js";
import type { SessionView, WorkflowArtifactKind, WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { normalizeBrowserUrl } from "../artifact-preview.js";
import { labelFor } from "../artifact-kind.js";
import { formatBytes } from "../files-panel.js";
import { formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { useTimelineClock } from "../timeline-clock.js";
import { ArtifactPreview } from "./ArtifactPreview.js";
import { usePanelScratchChoice, usePanelScratchScope, usePanelScratchText } from "../right-panel-scratch.js";

type BrowserMode = "artifacts" | "web";

/** How long a page may take to fire `load` before the frame says it can't be shown (#2854). A page
 * that refuses to be framed often never loads at all, and a blank white rectangle says nothing. */
export const PAGE_BLOCKED_AFTER_MS = 8_000;

const KIND_ICONS: Readonly<Record<WorkflowArtifactKind, (props: { size?: number }) => ReactNode>> = {
  html_preview: HtmlIcon,
  patch: DiffIcon,
  review_report: ReportIcon,
  screenshot: ImageIcon,
  test_log: LogIcon,
  verdict: JsonIcon,
  video: VideoIcon,
};

export function BrowserPanel({ session }: { session: SessionView }) {
  const api = useApi();
  // Where this session's browsing was left. The panel unmounts on every mode switch, so without
  // this the tab, the address, and the artifact being read are gone on return (#1202). The empty
  // string is "nothing opened yet" throughout.
  const panelScratch = usePanelScratchScope(session.id);
  const [mode, setMode] = usePanelScratchChoice<BrowserMode>(
    panelScratch, "browser.mode", "artifacts", (raw) => raw === "artifacts" || raw === "web",
  );
  // Recreatable, still, now that scratch survives a reload (#1282). An address is user-authored
  // text, but it is not unsent text: the field keeps whatever was opened, so classifying it as a
  // draft would exempt every session anyone ever browsed from eviction permanently — the shape of
  // #1375, spread across sessions. It survives a reload either way; what the classification buys is
  // only exemption from the scope bound, and a short address someone has not opened yet is the one
  // thing here cheap enough to retype.
  const [urlInput, setUrlInput] = usePanelScratchText(panelScratch, "browser.address");
  // Re-validated on restore: everything downstream (the iframe, Open in New Tab) assumes this
  // already passed `normalizeBrowserUrl`.
  const [openUrl, setOpenUrl] = usePanelScratchText(
    panelScratch, "browser.openUrl", "", (raw) => normalizeBrowserUrl(raw).ok,
  );
  const [artifacts, setArtifacts] = useState<WorkflowArtifactView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  // Bumped by Retry: the first page loads again from the top.
  const [listAttempt, setListAttempt] = useState(0);
  // The artifact is remembered by id and re-resolved against the list this mount loaded: an id the
  // reloaded pages no longer carry simply returns the list, never a stale preview.
  const [selectedId, setSelectedId] = usePanelScratchText(panelScratch, "browser.artifactId");
  const selected = artifacts.find((artifact) => artifact.artifactId === selectedId) ?? null;
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    setArtifacts([]);
    setCursor(undefined);
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
  }, [api, session.id, listAttempt]);

  const loadMore = async () => {
    if (!cursor || listBusy) return;
    const generation = generationRef.current;
    setListBusy(true);
    setListError(null);
    try {
      const page = await api.sessionWorkflowArtifacts(session.id, cursor);
      if (generation !== generationRef.current) return;
      setArtifacts((current) => {
        const merged = new Map(current.map((artifact) => [artifact.artifactId, artifact]));
        for (const artifact of page.artifacts) merged.set(artifact.artifactId, artifact);
        return [...merged.values()];
      });
      setCursor(page.nextCursor);
    } catch (cause) {
      if (generation === generationRef.current) setListError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current) setListBusy(false);
    }
  };

  // The tab's plain count is what has loaded; "+" while more pages wait behind Show More.
  const firstPageLoaded = !(listBusy && artifacts.length === 0) && !(listError && artifacts.length === 0);
  const count = firstPageLoaded ? `${artifacts.length}${cursor ? "+" : ""}` : null;

  // The tabs sit directly above the panel's slots, so their underline rests on a hairline (§10.1);
  // each tab's content is a PanelToolLayout of its own: Web Preview puts its address row in the
  // toolbar slot, and both scroll in the one scroller.
  return (
    <>
      <TabList label="Browser" className="browser-tabs" onKeyDown={(event) => handleRovingChoiceKeyDown(event, "tab")}>
        <button
          id="browser-artifacts-tab"
          type="button"
          role="tab"
          className="tab"
          aria-selected={mode === "artifacts"}
          aria-controls="browser-artifacts-panel"
          tabIndex={mode === "artifacts" ? 0 : -1}
          onClick={() => setMode("artifacts")}
        >
          Artifacts{count !== null && <span className="count">{count}</span>}
        </button>
        <button
          id="browser-web-tab"
          type="button"
          role="tab"
          className="tab"
          aria-selected={mode === "web"}
          aria-controls="browser-web-panel"
          tabIndex={mode === "web" ? 0 : -1}
          onClick={() => setMode("web")}
        >
          Web Preview
        </button>
      </TabList>

      {mode === "web" ? (
        <WebPreview
          urlInput={urlInput}
          setUrlInput={setUrlInput}
          url={openUrl || null}
          setUrl={setOpenUrl}
        />
      ) : (
        <PanelToolLayout>
          <div id="browser-artifacts-panel" role="tabpanel" aria-labelledby="browser-artifacts-tab" className="browser-artifacts">
            {selected ? (
              <div className="browser-artifact-detail">
                {/* #2855 replaces this head with the shared artifact preview header. */}
                <div className="browser-artifact-head">
                  <button className="icon-btn" type="button" aria-label="Back to Artifact List" onClick={() => setSelectedId("")}>‹</button>
                  <strong>{selected.name}</strong>
                </div>
                <ArtifactPreview artifact={selected} />
              </div>
            ) : (
              <>
                <ArtifactUploadNotice />
                {listBusy && artifacts.length === 0 ? (
                  <Skeleton rows={3} announce="Loading artifacts…" />
                ) : listError && artifacts.length === 0 ? (
                  <State
                    variant="error"
                    compact
                    title="Couldn't Load Artifacts"
                    actions={<button type="button" className="btn" onClick={() => setListAttempt((attempt) => attempt + 1)}>Retry</button>}
                    details={listError}
                  >
                    The session's artifact list didn't load. Retry to ask for it again.
                  </State>
                ) : artifacts.length === 0 ? (
                  <State
                    compact
                    icon={<ReportIcon size={24} />}
                    title="No Artifacts Yet"
                    actions={<button type="button" className="btn" onClick={() => setMode("web")}>Open Web Preview</button>}
                  >
                    Reports, screenshots and logs the agent saves appear here.
                  </State>
                ) : (
                  <>
                    <ArtifactList artifacts={artifacts} onOpen={setSelectedId} />
                    {listError && (
                      <Notice
                        tone="danger"
                        compact
                        role="alert"
                        title="Couldn't Load More Artifacts"
                        actions={<button type="button" className="btn sm" onClick={() => void loadMore()}>Retry</button>}
                        details={listError}
                      />
                    )}
                    {cursor && !listError && (
                      <ListFoot>
                        <BusyButton className="btn ghost sm" busy={listBusy} progress="Loading more artifacts…" onClick={() => void loadMore()}>
                          Show More
                        </BusyButton>
                      </ListFoot>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </PanelToolLayout>
      )}
    </>
  );
}

function ArtifactList({ artifacts, onOpen }: { artifacts: readonly WorkflowArtifactView[]; onOpen: (artifactId: string) => void }) {
  const now = useTimelineClock(artifacts.length > 0);
  return (
    <ul className="browser-artifact-list">
      {artifacts.map((artifact) => {
        const KindIcon = KIND_ICONS[artifact.kind] ?? ReportIcon;
        const created = formatRecordedTimestamp(artifact.createdAt);
        return (
          <li key={artifact.artifactId}>
            <button type="button" className="row row-2" onClick={() => onOpen(artifact.artifactId)}>
              <span className="browser-artifact-kind" aria-hidden="true"><KindIcon size={16} /></span>
              <span className="row-body">
                <span className="row-title" title={artifact.name}>{artifact.name}</span>
                <span className="row-sub browser-artifact-meta">
                  <span>{labelFor(artifact.kind)}</span>
                  {created && <time dateTime={created.dateTime} title={created.title}>{formatRecordedRelativeTime(artifact.createdAt, now)}</time>}
                </span>
              </span>
              <span className="row-trail browser-artifact-size">{formatBytes(artifact.sizeBytes)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

type FramePhase = "loading" | "loaded" | "blocked";

/**
 * Whether a frame that fired `load` holds nothing. A framed page's document is readable only when it
 * shares the app's origin, which the sandbox never grants, so a cross-origin page is taken at its
 * `load`; what can be read and is empty is a page that refused to render.
 */
function frameIsEmpty(frame: HTMLIFrameElement): boolean {
  let doc: Document | null;
  try {
    doc = frame.contentDocument;
  } catch {
    return false;
  }
  if (!doc) return false;
  const body = doc.body;
  return !body || (body.childElementCount === 0 && !(body.textContent ?? "").trim());
}

function WebPreview({ urlInput, setUrlInput, url, setUrl }: {
  urlInput: string;
  setUrlInput: (value: string) => void;
  url: string | null;
  setUrl: (value: string) => void;
}) {
  const [urlError, setUrlError] = useState<string | null>(null);
  // Bumped by Reload, and by opening the address already open: the frame is keyed by it, so the
  // same URL is set again on a fresh frame.
  const [loads, setLoads] = useState(0);
  const frameKey = `${loads}\n${url ?? ""}`;
  // Keyed by the frame it describes, so a new address starts loading without a render that still
  // shows the previous page's Reload.
  const [frameState, setFrameState] = useState<{ key: string; phase: FramePhase }>({ key: "", phase: "loading" });
  const phase: FramePhase = frameState.key === frameKey ? frameState.phase : "loading";
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!url) return;
    const timer = setTimeout(() => {
      setFrameState((current) => (current.key === frameKey && current.phase === "loaded" ? current : { key: frameKey, phase: "blocked" }));
    }, PAGE_BLOCKED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [frameKey, url]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeBrowserUrl(urlInput);
    if (!normalized.ok) {
      setUrlError(normalized.error);
      inputRef.current?.focus();
      return;
    }
    setUrlError(null);
    setUrlInput(normalized.url);
    if (normalized.url === url) setLoads((count) => count + 1);
    else setUrl(normalized.url);
  };

  const loaded = url !== null && phase === "loaded";
  const openInNewTab = (className: string, label?: string) => url && (
    <a
      className={className}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label ? undefined : "Open in New Tab"}
      title={label ? undefined : "Open in New Tab"}
    >
      {label ?? <ExternalLinkIcon />}
    </a>
  );

  const addressRow = (
    <>
      <form className="toolbar browser-address" noValidate onSubmit={navigate}>
        {loaded && (
          <button type="button" className="icon-btn sm" aria-label="Reload" title="Reload" onClick={() => setLoads((count) => count + 1)}>
            <RefreshIcon />
          </button>
        )}
        <label className="sr-only" htmlFor="browser-url">Web Preview URL</label>
        <span className="input-affix browser-address-field">
          <span className="input-affix-text" aria-hidden="true"><GlobeIcon size={14} /></span>
          <input
            ref={inputRef}
            id="browser-url"
            value={urlInput}
            onChange={(event) => {
              setUrlInput(event.target.value);
              // §8.5: the error clears as soon as the value would be accepted.
              if (urlError && normalizeBrowserUrl(event.target.value).ok) setUrlError(null);
            }}
            placeholder="https://localhost:3000"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? "browser-url-error" : undefined}
          />
        </span>
        {loaded ? openInNewTab("icon-btn sm") : <button className="btn" type="submit">Open</button>}
      </form>
      {urlError && <FieldError id="browser-url-error" className="browser-address-error">{urlError}</FieldError>}
    </>
  );

  return (
    <PanelToolLayout toolbar={addressRow}>
      <div id="browser-web-panel" role="tabpanel" aria-labelledby="browser-web-tab" className="browser-web">
        {url ? (
          <div className="browser-web-view">
            {phase === "loading" && <div className="browser-load-bar" role="progressbar" aria-label="Loading Page" />}
            {phase === "blocked" && (
              <Notice tone="warning" compact role="status" actions={openInNewTab("btn sm", "Open in New Tab")}>
                This page can't be shown inside Wollipog.
              </Notice>
            )}
            <iframe
              key={frameKey}
              className="browser-web-frame"
              hidden={phase === "blocked"}
              title={`Web preview of ${url}`}
              src={url}
              sandbox="allow-forms allow-scripts"
              referrerPolicy="no-referrer"
              onLoad={(event) => {
                const next: FramePhase = frameIsEmpty(event.currentTarget) ? "blocked" : "loaded";
                setFrameState({ key: frameKey, phase: next });
              }}
            />
          </div>
        ) : (
          <State compact icon={<GlobeIcon size={24} />} title="Preview a Web Page">
            Pages open in an isolated frame with no access to your session, device token or cookies.
          </State>
        )}
      </div>
    </PanelToolLayout>
  );
}
