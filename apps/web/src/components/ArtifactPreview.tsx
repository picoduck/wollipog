import { Fragment, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { Modal } from "./Modal.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useFeedback } from "./FeedbackProvider.js";
import { useAccessibleMenu } from "./interactions.js";
import {
  ChevronDownIcon, CopyIcon, DiffIcon, DownloadIcon, HtmlIcon, ImageIcon, JsonIcon, LogIcon,
  Maximize2Icon, ReportIcon, ShieldCheckIcon, VideoIcon, WrapLinesIcon,
} from "./Icons.js";
import type { WorkflowArtifactKind, WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { writeClipboardText } from "../clipboard.js";
import { artifactDownloadFilename } from "../artifact-download.js";
import { artifactAuthorName } from "../artifact-author.js";
import { labelFor } from "../artifact-kind.js";
import {
  ArtifactVerificationError,
  classifyArtifactPreview,
  markdownWithoutTitle,
  sandboxHtmlDocument,
  verifyArtifactPreviewBlob,
  type ArtifactPreviewClass,
} from "../artifact-preview.js";
import { highlightDiffLine } from "../diff-view.js";
import { formatBytes } from "../files-panel.js";
import { formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { ViewerIdentityContext } from "../resolver-identity.js";
import { useOptionalStoreSelector } from "../store.js";
import { requestBlobDownload } from "../transcript-download.js";
import { sessionAgentLabel } from "./agent-options.js";
import { Markdown } from "./Markdown.js";
import { useTranscriptImageCache } from "./TranscriptImageCache.js";

type LoadedPreview =
  | { kind: "html"; source: string; blob: Blob }
  | { kind: "image"; objectUrl: string; blob: Blob }
  | { kind: "video"; objectUrl: string; blob: Blob }
  | { kind: "json" | "markdown" | "text"; text: string; blob: Blob };

type PreviewState =
  | { phase: "loading" }
  | { phase: "ready"; loaded: LoadedPreview }
  /** `verification`: bytes arrived and were not the artifact's. Otherwise they never arrived, or
   * could not be read as the artifact's type. */
  | { phase: "failed"; verification: boolean; message: string }
  | { phase: "unsupported" };

/** One artifact's preview: what it is showing, and what its header, meta line and body act on. */
export interface ArtifactPreviewModel {
  artifact: WorkflowArtifactView;
  previewClass: ArtifactPreviewClass;
  state: PreviewState;
  /** Load and check the bytes again, after a failure. */
  retry: () => void;
}

const KIND_ICONS: Readonly<Record<WorkflowArtifactKind, (props: { size?: number }) => ReactNode>> = {
  html_preview: HtmlIcon,
  patch: DiffIcon,
  review_report: ReportIcon,
  screenshot: ImageIcon,
  test_log: LogIcon,
  verdict: JsonIcon,
  video: VideoIcon,
};

/** The download menu's one warning: a raw artifact is the agent's exact bytes, never redacted. */
export const DOWNLOAD_WARNING = "Not redacted. It may contain secrets or personal data.";

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * Explicit, authenticated artifact materialization shared by Run detail and the Browser panel. Only
 * bytes that match the artifact's length, type and SHA-256 reach a renderer. With no artifact (a host
 * whose list shows in its place) it loads nothing and has no model.
 */
export function useArtifactPreview(artifact: WorkflowArtifactView): ArtifactPreviewModel;
export function useArtifactPreview(artifact: WorkflowArtifactView | null): ArtifactPreviewModel | null;
export function useArtifactPreview(artifact: WorkflowArtifactView | null): ArtifactPreviewModel | null {
  const api = useApi();
  const transcriptImageCache = useTranscriptImageCache();
  const previewClass = artifact ? classifyArtifactPreview(artifact) : "unsupported";
  // Bumped by Retry: the same artifact loads again.
  const [attempt, setAttempt] = useState(0);
  // Keyed by the load it describes, so another artifact or a Retry starts loading in the render that
  // asks for it, never showing the previous bytes (or their Verified) for a commit.
  const [settled, setSettled] = useState<{ artifact: WorkflowArtifactView; attempt: number; state: PreviewState } | null>(null);
  const state: PreviewState = previewClass === "unsupported" ? { phase: "unsupported" }
    : settled?.artifact === artifact && settled.attempt === attempt ? settled.state
      : { phase: "loading" };
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    let objectUrl: string | null = null;
    if (!artifact || previewClass === "unsupported") return () => { requestRef.current++; };
    const setState = (next: PreviewState) => setSettled({ artifact, attempt, state: next });

    void (async () => {
      const cachedImage = previewClass === "image" && transcriptImageCache;
      const blob = cachedImage
        ? await cachedImage.load(artifact, api.artifactExport)
        : await api.artifactExport(artifact.artifactId);
      const bytes = cachedImage ? null : await verifyArtifactPreviewBlob(artifact, blob);
      if (requestRef.current !== request) return;
      if (previewClass === "image" || previewClass === "video") {
        objectUrl = URL.createObjectURL(bytes
          ? new Blob([bytes], { type: artifact.mimeType })
          : blob);
        setState({ phase: "ready", loaded: previewClass === "image" ? { kind: "image", objectUrl, blob } : { kind: "video", objectUrl, blob } });
      } else {
        let text = decodeUtf8(bytes!);
        if (previewClass === "json") text = JSON.stringify(JSON.parse(text) as unknown, null, 2);
        setState({
          phase: "ready",
          loaded: previewClass === "html"
            ? { kind: "html", source: sandboxHtmlDocument(text), blob }
            : { kind: previewClass, text, blob },
        });
      }
    })().catch((cause: unknown) => {
      if (requestRef.current !== request) return;
      setState({
        phase: "failed",
        verification: cause instanceof ArtifactVerificationError,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    });

    return () => {
      requestRef.current++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, artifact, previewClass, transcriptImageCache, attempt]);

  return artifact && { artifact, previewClass, state, retry: () => setAttempt((count) => count + 1) };
}

/** Downloads the original bytes, checked like a preview's; the preview's own bytes when it has them. */
function useArtifactDownload(model: ArtifactPreviewModel) {
  const api = useApi();
  const { showToast } = useFeedback();
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const { artifact, state } = model;
  const download = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = state.phase === "ready" ? state.loaded.blob : await api.artifactExport(artifact.artifactId);
      if (state.phase !== "ready") await verifyArtifactPreviewBlob(artifact, blob);
      requestBlobDownload(blob, artifactDownloadFilename(artifact.kind, artifact.mimeType));
    } catch (cause) {
      showToast(cause instanceof ArtifactVerificationError
        ? "Couldn't verify the original file, so it wasn't downloaded."
        : "Couldn't download the original file.", { tone: "error" });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  return { busy, download, mountedRef };
}

/** Who saved the artifact, by name: never a session or user id (#2855). */
function useArtifactAuthor(artifact: WorkflowArtifactView): string | null {
  const viewer = useContext(ViewerIdentityContext);
  const agentSessionId = artifact.createdBy.kind === "agent" ? artifact.createdBy.id : undefined;
  const agent = useOptionalStoreSelector((state) => {
    const session = agentSessionId ? state.sessions.get(agentSessionId) : undefined;
    return session ? sessionAgentLabel(session.agentName, session.driver, session.agentId) : undefined;
  });
  return artifactAuthorName(artifact.createdBy, { viewer, sessionAgent: () => agent });
}

/**
 * Download (#2855; docs/design-system.md §9.1): a `.btn` that opens a menu of Download Original File,
 * which carries the one warning about raw bytes as its description, and Copy Checksum, which copies
 * the full SHA-256. `inline` keeps the menu inside a dialog's layer.
 */
export function ArtifactDownloadMenu({ model, inline = false }: { model: ArtifactPreviewModel; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "artifact-download");
  const { showToast } = useFeedback();
  const { busy, download, mountedRef } = useArtifactDownload(model);

  const downloadOriginal = () => {
    menu.triggerRef.current?.focus();
    menu.close(false);
    void download();
  };
  const copyChecksum = async () => {
    // The menu closes now, not when the write settles (see DiffFileActions).
    const trigger = menu.triggerRef.current;
    trigger?.focus();
    menu.close(false);
    const current = () => mountedRef.current && (document.activeElement === null ||
      document.activeElement === document.body || document.activeElement === trigger);
    const result = await writeClipboardText(model.artifact.sha256, current);
    if (result === null) return;
    if (document.activeElement === document.body || document.activeElement === null) trigger?.focus();
    if (result) showToast("Copied the checksum.", { tone: "success" });
    else showToast("Couldn't copy the checksum.", { tone: "error" });
  };

  return (
    <>
      <BusyButton
        ref={menu.triggerRef}
        className="btn"
        busy={busy}
        progress="Downloading the original file…"
        icon={<DownloadIcon size={16} />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        Download<ChevronDownIcon size={14} />
      </BusyButton>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Download"
          align="end"
          inline={inline}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem icon={<DownloadIcon size={16} />} description={DOWNLOAD_WARNING} onClick={downloadOriginal}>
            Download Original File
          </MenuItem>
          <MenuItem icon={<CopyIcon size={16} />} onClick={() => void copyChecksum()}>Copy Checksum</MenuItem>
        </MenuSurface>
      )}
    </>
  );
}

/** Enlarge, for an image or an HTML preview once its checked bytes are shown; nothing otherwise. */
function EnlargeButton({ model }: { model: ArtifactPreviewModel }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { state, artifact } = model;
  if (state.phase !== "ready" || (state.loaded.kind !== "image" && state.loaded.kind !== "html")) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        aria-label="Enlarge"
        title="Enlarge"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Maximize2Icon />
      </button>
      {open && <EnlargedArtifact artifact={artifact} loaded={state.loaded} returnFocusRef={buttonRef} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * An image or HTML preview in a full dialog, a full-height sheet on a phone, presented the way the
 * Evidence Viewer presents media (#2207) without its review controls. Done returns to Enlarge.
 */
function EnlargedArtifact({ artifact, loaded, returnFocusRef, onClose }: {
  artifact: WorkflowArtifactView;
  loaded: Extract<LoadedPreview, { kind: "image" | "html" }>;
  returnFocusRef: { current: HTMLElement | null };
  onClose: () => void;
}) {
  return (
    <Modal
      title={artifact.name}
      onClose={onClose}
      size="full"
      phoneSheet="full"
      className="art-enlarged"
      returnFocusRef={returnFocusRef}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <div className="art-stage">
        {loaded.kind === "image"
          ? <img className="art-stage-media" src={loaded.objectUrl} alt={artifact.name} />
          : <HtmlFrame artifact={artifact} source={loaded.source} className="art-frame art-stage-media" />}
      </div>
    </Modal>
  );
}

/** The untrusted HTML in a frame that runs no scripts, submits no forms and follows no links. */
function HtmlFrame({ artifact, source, className }: { artifact: WorkflowArtifactView; source: string; className: string }) {
  return (
    <iframe
      className={className}
      title={`${artifact.name} HTML preview`}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={source}
    />
  );
}

/**
 * The preview's bar in the Browser (#2855, #2914; docs/design-system.md §11.9): one 48px `.art-bar`
 * of Enlarge and Download at its trailing edge. The artifact is a page of the side panel, whose
 * header carries its Back and its title, so the bar has neither.
 */
export function ArtifactPreviewBar({ model }: { model: ArtifactPreviewModel }) {
  return (
    <div className="toolbar art-bar">
      <EnlargeButton model={model} />
      <ArtifactDownloadMenu model={model} />
    </div>
  );
}

/** The meta line's facts (§11.3): the kind, the size, who saved it and, once checked, Verified. */
function ArtifactMetaFacts({ model }: { model: ArtifactPreviewModel }) {
  const { artifact, state } = model;
  const author = useArtifactAuthor(artifact);
  return (
    <>
      <span>{labelFor(artifact.kind)}</span>
      <span>{formatBytes(artifact.sizeBytes)}</span>
      {author && <span>{author}</span>}
      {state.phase === "ready" && (
        <span className="art-verified"><ShieldCheckIcon size={14} />Verified</span>
      )}
    </>
  );
}

export function ArtifactPreviewMeta({ model }: { model: ArtifactPreviewModel }) {
  return <p className="art-meta"><ArtifactMetaFacts model={model} /></p>;
}

/** Text and JSON in a code well (§11.7) with Wrap Lines; JSON in the diff's token classes. */
function CodeWell({ text, json }: { text: string; json: boolean }) {
  const [wrap, setWrap] = useState(true);
  const content = useMemo(() => (json
    ? text.split("\n").map((line, index) => (
      <Fragment key={index}>
        {highlightDiffLine("artifact.json", line).map((segment, segmentIndex) => (
          segment.kind === "plain"
            ? segment.text
            : <span className={`diff-syntax-${segment.kind}`} key={segmentIndex}>{segment.text}</span>
        ))}
        {"\n"}
      </Fragment>
    ))
    : text), [text, json]);
  return (
    <div className={wrap ? "code-well art-code is-wrapped" : "code-well art-code"}>
      <pre><code>{content}</code></pre>
      <button
        type="button"
        className="icon-btn sm"
        aria-label="Wrap Lines"
        title="Wrap Lines"
        aria-pressed={wrap}
        onClick={() => setWrap(!wrap)}
      >
        <WrapLinesIcon size={16} />
      </button>
    </div>
  );
}

/** The preview's body and its states (§12.3, §12.4): loading, a failed check, no preview, or the bytes. */
export function ArtifactPreviewBody({ model }: { model: ArtifactPreviewModel }) {
  const { artifact, state } = model;
  const [mediaError, setMediaError] = useState<string | null>(null);
  const { busy, download } = useArtifactDownload(model);
  const loaded = state.phase === "ready" ? state.loaded : null;
  return (
    <div className="artifact-preview" aria-busy={state.phase === "loading"}>
      {state.phase === "loading" && (
        <div className="skeleton art-skeleton" role="status" aria-live="polite">
          <p className="art-skeleton-label">Loading and checking the preview…</p>
          <div aria-hidden="true" className="skeleton-row skeleton-block" />
        </div>
      )}
      {state.phase === "failed" && (
        <Notice
          tone="danger"
          role="alert"
          title={state.verification ? "Couldn't Verify This Artifact" : "Couldn't Load This Preview"}
          actions={<button type="button" className="btn sm" onClick={model.retry}>Retry</button>}
          details={<pre className="art-failure-detail">{state.message}</pre>}
        >
          {state.verification
            ? "The bytes that arrived don't match this artifact's checksum, so they aren't shown."
            : "The artifact didn't load. Retry to ask for it again."}
        </Notice>
      )}
      {state.phase === "unsupported" && (
        <State
          compact
          icon={<ReportIcon size={24} />}
          title="No Preview for This Type"
          actions={(
            <BusyButton className="btn" busy={busy} progress="Downloading the original file…" onClick={() => void download()}>
              Download Original File
            </BusyButton>
          )}
        >
          This kind of artifact can't be shown here. Download the original file to open it.
        </State>
      )}
      {mediaError && <Notice tone="danger" compact role="alert">{mediaError}</Notice>}
      {loaded?.kind === "image" && (
        <div className="art-well art-checker">
          <img className="art-image" src={loaded.objectUrl} alt={artifact.name} />
        </div>
      )}
      {loaded?.kind === "video" && (
        <video className="art-video" src={loaded.objectUrl} controls playsInline preload="metadata"
          aria-label={`Play ${artifact.name}`}
          onError={() => setMediaError("This video could not be played in this browser.")} />
      )}
      {loaded?.kind === "html" && (
        <figure className="art-well">
          <HtmlFrame artifact={artifact} source={loaded.source} className="art-frame" />
          <figcaption className="art-caption">Sandboxed: scripts, forms and links are turned off.</figcaption>
        </figure>
      )}
      {loaded?.kind === "markdown" && (
        <div className="art-markdown"><Markdown>{markdownWithoutTitle(loaded.text, artifact.name)}</Markdown></div>
      )}
      {(loaded?.kind === "text" || loaded?.kind === "json") && <CodeWell text={loaded.text} json={loaded.kind === "json"} />}
    </div>
  );
}

/**
 * A preview inside a host that already names the artifact (a transcript row): Download over the body.
 * Download Original File still carries the one warning about raw bytes.
 */
export function ArtifactInlinePreview({ artifact }: { artifact: WorkflowArtifactView }) {
  const model = useArtifactPreview(artifact);
  return (
    <div className="art-view">
      <div className="toolbar art-inline-actions"><ArtifactDownloadMenu model={model} /></div>
      <ArtifactPreviewBody model={model} />
    </div>
  );
}

/**
 * Run detail's preview (#2855; §7.1, §7.5): a large dialog, a sheet on a phone, titled with the
 * artifact over its meta line, with Enlarge in the header and Download and Done in the footer.
 */
export function ArtifactPreviewDialog({ artifact, onClose }: { artifact: WorkflowArtifactView; onClose: () => void }) {
  const model = useArtifactPreview(artifact);
  return (
    <Modal
      title={artifact.name}
      description={<span className="art-meta"><ArtifactMetaFacts model={model} /></span>}
      onClose={onClose}
      size="lg"
      headerActions={<EnlargeButton model={model} />}
      footer={(
        <>
          <ArtifactDownloadMenu model={model} inline />
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </>
      )}
    >
      <ArtifactPreviewBody model={model} />
    </Modal>
  );
}

/**
 * One artifact as a two-line row (§5.2): its kind on a 32px tile, the title over the kind, who saved
 * it where the host shows that, and when, and the size trailing on one line however narrow it gets.
 * No ids or hashes. `pageKey` names the side panel page the row opens (§4.9), where focus returns.
 */
export function ArtifactRow({ artifact, now, showAuthor = false, pageKey, onOpen }: {
  artifact: WorkflowArtifactView;
  now: number;
  showAuthor?: boolean;
  pageKey?: string;
  onOpen: () => void;
}) {
  const KindIcon = KIND_ICONS[artifact.kind] ?? ReportIcon;
  const created = formatRecordedTimestamp(artifact.createdAt);
  const author = useArtifactAuthor(artifact);
  return (
    <button type="button" className="row row-2" data-panel-page-key={pageKey} onClick={onOpen}>
      <span className="art-kind" aria-hidden="true"><KindIcon size={16} /></span>
      <span className="row-body">
        <span className="row-title" title={artifact.name}>{artifact.name}</span>
        <span className="row-sub art-row-meta">
          <span>{labelFor(artifact.kind)}</span>
          {showAuthor && author && <span>{author}</span>}
          {created && <time dateTime={created.dateTime} title={created.title}>{formatRecordedRelativeTime(artifact.createdAt, now)}</time>}
        </span>
      </span>
      <span className="row-trail art-size">{formatBytes(artifact.sizeBytes)}</span>
    </button>
  );
}
