import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArtifactUploadNotice } from "./ArtifactUploadNotice.js";
import { Notice } from "./Notice.js";
import { TabList } from "./Tabs.js";
import { State } from "./State.js";
import { ListFoot } from "./ListFoot.js";
import { PanelToolLayout } from "./PanelToolLayout.js";
import { FieldError } from "./FieldError.js";
import { Skeleton } from "./common.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ExternalLinkIcon, GlobeIcon, RefreshIcon, ReportIcon } from "./Icons.js";
import type { SessionView, WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { normalizeBrowserUrl } from "../artifact-preview.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { useTimelineClock } from "../timeline-clock.js";
import { ArtifactPreviewBar, ArtifactPreviewBody, ArtifactPreviewMeta, ArtifactRow, useArtifactPreview } from "./ArtifactPreview.js";
import { usePanelScratchChoice, usePanelScratchScope, usePanelScratchText } from "../right-panel-scratch.js";
import { PanelPageTitle, usePanelPages } from "./PanelPages.js";
import { TranscriptImageCacheProvider } from "./TranscriptImageCache.js";
import { ArtifactGallery } from "./ArtifactGallery.js";
import type { BrowserArtifactRequest } from "./right-panel-state.js";

type BrowserMode = "artifacts" | "web";

/** How long a page may take to fire `load` before the frame says it can't be shown (#2854). A page
 * that refuses to be framed often never loads at all, and a blank white rectangle says nothing. */
export const PAGE_BLOCKED_AFTER_MS = 8_000;

export interface BrowserPanelProps {
  session: SessionView;
  /** An artifact link or the transcript's Open in Browser (#3924): the Artifacts tab, on the
   * artifact it names, found however many list pages away it is. Acted on once per request. */
  openArtifact?: BrowserArtifactRequest | null;
  onOpenArtifactHandled?: (request: number) => void;
}

/** The checked image bytes are shared by the open page and its viewer, so Enlarge never fetches
 * them again. */
export function BrowserPanel(props: BrowserPanelProps) {
  return (
    <TranscriptImageCacheProvider>
      <BrowserPanelBody {...props} />
    </TranscriptImageCacheProvider>
  );
}

/** What the Browser shows while it looks for, or failed to find, a linked artifact. */
type ArtifactLookup =
  | { phase: "searching"; artifactId: string }
  | { phase: "missing" };

function BrowserPanelBody({ session, openArtifact = null, onOpenArtifactHandled }: BrowserPanelProps) {
  const api = useApi();
  // Where this session's browsing was left. The panel unmounts on every mode switch, so without
  // this the tab and the address are gone on return (#1202). The empty string is "nothing opened
  // yet" throughout. An open artifact is a pushed page instead (#2914), so like every tool's page it
  // clears on a switch and the Browser reopens on its list (§4.9).
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
  // Busy from the first render: the first page is asked for as the panel mounts, and a linked
  // artifact must not be judged missing from a list that has not loaded yet.
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // Bumped by Retry: the first page loads again from the top.
  const [listAttempt, setListAttempt] = useState(0);
  // The open artifact is the page on top of the panel's stack, keyed by its id (#2914), and resolved
  // against the list this mount loaded: an id the list doesn't carry shows the list, never a stale
  // preview.
  const pages = usePanelPages();
  const selected = pages.current === null ? null : artifacts.find((artifact) => artifact.artifactId === pages.current) ?? null;
  const preview = useArtifactPreview(selected);
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

  // A page whose artifact the settled list doesn't carry (another session's) gives way to the list,
  // so the header never keeps a Back and an empty title over it.
  const stalePage = pages.current !== null && selected === null && !listBusy;
  useEffect(() => {
    if (stalePage) pages.clear();
  }, [stalePage, pages]);

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

  // A linked artifact (#3924) opens on the Artifacts tab as a page from outside the panel, so Back
  // goes to the list. One beyond the loaded pages is looked for page by page; the list holds at most
  // a few hundred. One no page carries says so, and nothing else about it.
  const [lookup, setLookup] = useState<ArtifactLookup | null>(null);
  useEffect(() => {
    if (!openArtifact) return;
    setMode("artifacts");
    // An artifact already open gives way at once: it is not the one asked for, and a link that finds
    // nothing must show its notice over the list, not under that page.
    if (openArtifact.artifactId !== pages.current) pages.clear();
    setLookup(openArtifact.artifactId === undefined ? null : { phase: "searching", artifactId: openArtifact.artifactId });
    onOpenArtifactHandled?.(openArtifact.request);
    // Each request is acted on once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openArtifact?.request]);
  const searchingFor = lookup?.phase === "searching" ? lookup.artifactId : null;
  useEffect(() => {
    // While a page loads, wait for it; a failed page shows its own Retry, and the search resumes.
    if (searchingFor === null || listBusy || listError) return;
    if (artifacts.some((artifact) => artifact.artifactId === searchingFor)) {
      setLookup(null);
      pages.push(searchingFor, { root: true });
    } else if (cursor) {
      void loadMore();
    } else {
      setLookup({ phase: "missing" });
    }
    // loadMore reads this render's cursor and busy state, which are deps already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchingFor, listBusy, listError, artifacts, cursor]);

  // The viewer (#3924) over the loaded list, opened from the page's Enlarge or its image. Closing it
  // leaves the page where it was, with focus back on what opened it.
  const [galleryId, setGalleryId] = useState<string | null>(null);
  const galleryOpenerRef = useRef<HTMLElement | null>(null);
  const openGallery = (opener: HTMLElement | null) => {
    if (!selected) return;
    galleryOpenerRef.current = opener;
    setGalleryId(selected.artifactId);
  };

  // The tab's plain count is what has loaded; "+" while more pages wait behind Show More.
  const firstPageLoaded = !(listBusy && artifacts.length === 0) && !(listError && artifacts.length === 0);
  const count = firstPageLoaded ? `${artifacts.length}${cursor ? "+" : ""}` : null;

  // The tabs sit directly above the panel's slots, so their underline rests on a hairline (§10.1);
  // each tab's content is a PanelToolLayout of its own: Web Preview puts its address row in the
  // toolbar slot, and both scroll in the one scroller. An open artifact is a page over the Artifacts
  // tab (#2914): the panel header carries its Back and title, so the tabs give way to it, its bar
  // (Enlarge and Download) takes the toolbar slot, and the list waits hidden in the same scroller,
  // with its rows and scroll there again on Back.
  return (
    <>
      {!preview && (
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
      )}

      {mode === "web" && !preview ? (
        <WebPreview
          urlInput={urlInput}
          setUrlInput={setUrlInput}
          url={openUrl || null}
          setUrl={setOpenUrl}
        />
      ) : (
        <PanelToolLayout toolbar={preview && <ArtifactPreviewBar key={preview.artifact.artifactId} model={preview} onEnlarge={openGallery} />}>
          <div
            id="browser-artifacts-panel"
            role="tabpanel"
            aria-labelledby="browser-artifacts-tab"
            className="browser-artifacts"
            hidden={preview !== null}
          >
            <ArtifactUploadNotice />
            {lookup?.phase === "missing" && (
              <Notice
                tone="warning"
                compact
                role="status"
                title="Artifact Unavailable"
                actions={<button type="button" className="btn sm" onClick={() => setLookup(null)}>Dismiss</button>}
              >
                This session has no artifact the link names. It may have been removed, or the link may be for another session.
              </Notice>
            )}
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
                <ArtifactList artifacts={artifacts} onOpen={(artifactId) => pages.push(artifactId)} />
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
          </div>
          {/* The open artifact (#2855): the meta line and the body, under its title in the panel
              header. The page takes focus on its title as it opens (§4.9). */}
          {preview && (
            <div key={preview.artifact.artifactId} className="browser-artifacts">
              <PanelPageTitle>{preview.artifact.name}</PanelPageTitle>
              <ArtifactPreviewMeta model={preview} />
              <ArtifactPreviewBody model={preview} onOpenImage={openGallery} />
            </div>
          )}
        </PanelToolLayout>
      )}
      {galleryId !== null && artifacts.some((artifact) => artifact.artifactId === galleryId) && (
        <ArtifactGallery
          artifacts={artifacts}
          initialId={galleryId}
          sessionId={session.id}
          returnFocusRef={galleryOpenerRef}
          onClose={() => setGalleryId(null)}
        />
      )}
    </>
  );
}

/** The rows. Each carries its artifact's page key, where focus returns on Back (#2914). */
function ArtifactList({ artifacts, onOpen }: {
  artifacts: readonly WorkflowArtifactView[];
  onOpen: (artifactId: string) => void;
}) {
  const now = useTimelineClock(artifacts.length > 0);
  return (
    <ul className="browser-artifact-list">
      {artifacts.map((artifact) => (
        <li key={artifact.artifactId}>
          <ArtifactRow artifact={artifact} now={now} pageKey={artifact.artifactId} onOpen={() => onOpen(artifact.artifactId)} />
        </li>
      ))}
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
  // Bumped by every Open and Reload: the frame is keyed by it, so each navigation is a fresh frame
  // with a load of its own, even back to an address that loaded before (or the one already open).
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
    setUrl(normalized.url);
    setLoads((count) => count + 1);
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
