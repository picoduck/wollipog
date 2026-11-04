import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { SessionArtifactDirectory } from "../artifact-directory.js";
import { referencedArtifactIds } from "../artifact-references.js";
import { ArtifactReferenceContext } from "./artifact-reference-context.js";
import { labelFor } from "../artifact-kind.js";
import { classifyArtifactPreview } from "../artifact-preview.js";
import { formatBytes } from "../files-panel.js";
import { ArtifactGallery, ARTIFACT_GALLERY_COPY, useCopyArtifactLink } from "./ArtifactGallery.js";
import { ArtifactDownloadMenu, ArtifactKindIcon, ArtifactPreviewBody, useArtifactPreview } from "./ArtifactPreview.js";
import { GridIcon, LinkIcon, Maximize2Icon, PanelRightIcon } from "./Icons.js";

/** A turn shows at most this many of its artifacts inline; a counted View All stands for the rest. */
export const INLINE_ARTIFACT_LIMIT = 3;

/** One attachment row's place among its turn's artifacts (#3924). */
export interface TranscriptArtifactSlot {
  /**
   * `preview`: one of the turn's first INLINE_ARTIFACT_LIMIT, shown inline. `more`: the first after
   * them, whose row is the turn's counted View All. `hidden`: a later one, or a repeat of one the
   * turn already shows; its row renders nothing.
   */
  role: "preview" | "more" | "hidden";
  /** The turn's artifacts, each once, in transcript order: what the viewer steps through. */
  group: readonly WorkflowArtifactView[];
  /** This row's artifact in `group`. */
  index: number;
}

export const TRANSCRIPT_ARTIFACT_COPY = {
  openInViewer: "Open in Viewer",
  viewAll: (count: number) => `View All ${count} Artifacts`,
  moreNote: (count: number) => `${count} more from this turn`,
  loadVideo: "Load Video",
  noPreview: "No inline preview for this type.",
} as const;

interface TranscriptArtifactActions {
  /** Open the viewer on `group`, at `artifactId`; focus returns to `opener` on close. */
  openViewer: (group: readonly WorkflowArtifactView[], artifactId: string, opener: HTMLElement | null) => void;
  openInBrowser?: (artifact: WorkflowArtifactView) => void;
}

const TranscriptArtifactContext = createContext<TranscriptArtifactActions | null>(null);
const ArtifactDirectoryContext = createContext<SessionArtifactDirectory | null>(null);

/** The transcript's directory of its session's artifacts; null where references do not resolve. */
export const useArtifactDirectory = (): SessionArtifactDirectory | null => useContext(ArtifactDirectoryContext);

/**
 * The transcript's one artifact viewer (#3924). It belongs to the transcript, not to a row, so a
 * row scrolled out of a virtual list and unmounted keeps the viewer it opened. Closing returns
 * focus to the control that opened it; the transcript's scroll and the composer's draft are never
 * touched.
 */
export function TranscriptArtifactViewerProvider({ children, onOpenInBrowser, sessionId }: {
  children: ReactNode;
  onOpenInBrowser?: (artifact: WorkflowArtifactView) => void;
  /** The session whose artifact ids a reply's references resolve against (#3970); none resolves
   * without it, as in a public shared transcript. */
  sessionId?: string;
}) {
  const api = useApi();
  const directory = useMemo(
    () => sessionId ? new SessionArtifactDirectory(sessionId, api.sessionWorkflowArtifacts) : null,
    [api, sessionId],
  );
  const [viewer, setViewer] = useState<{ group: readonly WorkflowArtifactView[]; artifactId: string } | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openViewer = useCallback((group: readonly WorkflowArtifactView[], artifactId: string, opener: HTMLElement | null) => {
    openerRef.current = opener;
    setViewer({ group, artifactId });
  }, []);
  const actions = useMemo<TranscriptArtifactActions>(
    () => ({ openViewer, ...(onOpenInBrowser ? { openInBrowser: onOpenInBrowser } : {}) }),
    [onOpenInBrowser, openViewer],
  );
  return (
    <TranscriptArtifactContext.Provider value={actions}>
    <ArtifactDirectoryContext.Provider value={directory}>
      {children}
    </ArtifactDirectoryContext.Provider>
      {viewer && (
        <ArtifactGallery
          artifacts={viewer.group}
          initialId={viewer.artifactId}
          returnFocusRef={openerRef}
          onClose={() => setViewer(null)}
          onOpenInBrowser={onOpenInBrowser}
        />
      )}
    </TranscriptArtifactContext.Provider>
  );
}

/** Starts loading when the row comes within reach of the viewport, and never before. */
function useNearViewport(enabled: boolean): [(element: HTMLElement | null) => void, boolean] {
  const [near, setNear] = useState(false);
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled || near || !element) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, enabled, near]);
  return [setElement, near];
}

/**
 * An attachment in the transcript (#389, #3924): a bounded thumbnail for an image, a player for a
 * video once asked for (it never plays by itself), or a file card. Its head names it and carries
 * Open in Viewer, Copy Link and Open in Browser. A turn's fourth artifact is its View All instead,
 * and later ones are not drawn; the viewer reaches every one of them.
 */
export function TranscriptArtifact({ artifact, slot }: { artifact: WorkflowArtifactView; slot?: TranscriptArtifactSlot }) {
  const actions = useContext(TranscriptArtifactContext);
  const group = slot?.group ?? [artifact];
  const index = slot?.index ?? 0;
  if (slot?.role === "hidden") return null;
  if (slot?.role === "more") {
    return <TranscriptArtifactsMore group={group} index={index} actions={actions} />;
  }
  return <TranscriptArtifactPreview artifact={artifact} group={group} actions={actions} />;
}

function TranscriptArtifactsMore({ group, index, actions }: {
  group: readonly WorkflowArtifactView[];
  index: number;
  actions: TranscriptArtifactActions | null;
}) {
  const first = group[index];
  if (!first) return null;
  return (
    <div className="tl-artifact tl-artifact-more">
      <button
        type="button"
        className="btn"
        aria-haspopup="dialog"
        disabled={!actions}
        onClick={(event) => actions?.openViewer(group, first.artifactId, event.currentTarget)}
      >
        <GridIcon size={16} />{TRANSCRIPT_ARTIFACT_COPY.viewAll(group.length)}
      </button>
      <span className="tl-artifact-note">{TRANSCRIPT_ARTIFACT_COPY.moreNote(group.length - index)}</span>
    </div>
  );
}

function TranscriptArtifactPreview({ artifact, group, actions }: {
  artifact: WorkflowArtifactView;
  group: readonly WorkflowArtifactView[];
  actions: TranscriptArtifactActions | null;
}) {
  const previewClass = classifyArtifactPreview(artifact);
  const inline = previewClass === "image" || previewClass === "video";
  // A video waits to be asked for; an image loads as it nears the viewport.
  const [ref, near] = useNearViewport(inline && previewClass !== "video");
  const [videoRequested, setVideoRequested] = useState(false);
  const load = previewClass === "video" ? videoRequested : inline && near;
  const model = useArtifactPreview(load ? artifact : null);
  const copyLink = useCopyArtifactLink();
  const openViewer = (opener: HTMLElement | null) => actions?.openViewer(group, artifact.artifactId, opener);
  return (
    <div className="tl-artifact" ref={ref} data-artifact-id={artifact.artifactId}>
      <div className="tl-artifact-head">
        <span className="art-kind" aria-hidden="true"><ArtifactKindIcon kind={artifact.kind} /></span>
        <span className="tl-artifact-title">
          <strong title={artifact.name}>{artifact.name}</strong>
          <span>{labelFor(artifact.kind)} · {formatBytes(artifact.sizeBytes)}</span>
        </span>
        <span className="tl-artifact-actions">
          {actions && (
            <button type="button" className="icon-btn sm" aria-label={TRANSCRIPT_ARTIFACT_COPY.openInViewer}
              title={TRANSCRIPT_ARTIFACT_COPY.openInViewer} aria-haspopup="dialog"
              onClick={(event) => openViewer(event.currentTarget)}>
              <Maximize2Icon size={16} />
            </button>
          )}
          {copyLink && (
            <button type="button" className="icon-btn sm" aria-label={ARTIFACT_GALLERY_COPY.copyLink}
              title={ARTIFACT_GALLERY_COPY.copyLink} onClick={() => copyLink(artifact)}>
              <LinkIcon size={16} />
            </button>
          )}
          {actions?.openInBrowser && (
            <button type="button" className="icon-btn sm" aria-label={ARTIFACT_GALLERY_COPY.openInBrowser}
              title={ARTIFACT_GALLERY_COPY.openInBrowser} onClick={() => actions.openInBrowser?.(artifact)}>
              <PanelRightIcon size={16} />
            </button>
          )}
          {model && <ArtifactDownloadMenu model={model} />}
        </span>
      </div>
      {previewClass === "video" && !videoRequested && (
        <button className="btn ghost sm" type="button" onClick={() => setVideoRequested(true)}>
          {TRANSCRIPT_ARTIFACT_COPY.loadVideo}
        </button>
      )}
      {model && <ArtifactPreviewBody model={model} onOpenImage={actions ? openViewer : undefined} />}
      {!inline && <p className="tl-artifact-note">{TRANSCRIPT_ARTIFACT_COPY.noPreview}</p>}
    </div>
  );
}

/** Which of a reply's cited artifacts preview under it (#3970), from `layoutReplyArtifactPreviews`. */
export interface ReplyArtifactPreviews {
  /** The ids this reply is the first in its turn to cite, of artifacts its turn did not attach. */
  ids: readonly string[];
  /** How many may preview inline: what the turn's attachments and earlier replies left of the limit. */
  budget: number;
}

const NO_IDS: readonly string[] = [];
const noSubscribe = () => () => undefined;
const noVersion = () => 0;

/**
 * The ids' artifacts as far as the transcript's directory resolves them, in order. `active` asks
 * the directory about ids it has not settled; a streaming reply waits, so a half-written id is never
 * looked up.
 */
function useResolvedArtifacts(ids: readonly string[], active: boolean): WorkflowArtifactView[] {
  const directory = useArtifactDirectory();
  const version = useSyncExternalStore(directory?.subscribe ?? noSubscribe, directory?.getVersion ?? noVersion, noVersion);
  useEffect(() => {
    if (directory && active && ids.length > 0) directory.request(ids);
  }, [active, directory, ids]);
  return useMemo(() => directory
    ? ids.flatMap((id) => {
      const resolution = directory.resolve(id);
      return resolution.state === "resolved" ? [resolution.artifact] : [];
    })
    : [], [directory, ids, version]);
}

const ReplyReferenceContext = createContext<{ ids: readonly string[]; settled: boolean } | null>(null);

/**
 * An artifact id cited in a reply (#3970), once the session's directory names it: a chip of its kind
 * and name that opens the viewer on it, stepping through every artifact the reply cites. Until then,
 * and for an id the session has no artifact for, it is the text the agent wrote, and says nothing
 * more. Copy Link and Open in Browser are the viewer's.
 */
function TranscriptArtifactReference({ id, code }: { id: string; code: boolean }) {
  const reply = useContext(ReplyReferenceContext);
  const actions = useContext(TranscriptArtifactContext);
  const group = useResolvedArtifacts(reply?.ids ?? NO_IDS, reply?.settled ?? false);
  const artifact = group.find((candidate) => candidate.artifactId === id);
  if (!artifact || !actions) return code ? <code>{id}</code> : <>{id}</>;
  return (
    <button
      type="button"
      className="art-ref"
      aria-haspopup="dialog"
      title={`${labelFor(artifact.kind)} · ${formatBytes(artifact.sizeBytes)} · ${id}`}
      data-artifact-id={id}
      onClick={(event) => actions.openViewer(group, id, event.currentTarget)}
    >
      <ArtifactKindIcon kind={artifact.kind} size={14} />
      <span className="art-ref-name">{artifact.name}</span>
    </button>
  );
}

const renderArtifactReference = (id: string, code: boolean) => <TranscriptArtifactReference id={id} code={code} />;

/**
 * The cited artifacts a reply's turn did not attach, under the reply: bounded previews within what
 * the turn's limit leaves, then a counted View All for the rest, the way attachments show.
 */
function ReplyReferencedArtifacts({ previews, settled }: { previews: ReplyArtifactPreviews; settled: boolean }) {
  const actions = useContext(TranscriptArtifactContext);
  const resolved = useResolvedArtifacts(previews.ids, settled);
  if (resolved.length === 0) return null;
  const shown = Math.min(previews.budget, resolved.length);
  return (
    <div className="tl-artifact-refs">
      {resolved.slice(0, shown).map((artifact) => (
        <TranscriptArtifactPreview key={artifact.artifactId} artifact={artifact} group={resolved} actions={actions} />
      ))}
      {resolved.length > shown && <TranscriptArtifactsMore group={resolved} index={shown} actions={actions} />}
    </div>
  );
}

/**
 * An agent reply's artifact references (#3970): the ids it cites become chips, and the artifacts
 * its turn did not attach preview under it. Without a session directory (a public share, a host
 * outside a session) or any cited id, the reply renders exactly as it did.
 */
export function ReplyArtifactScope({ text, settled, previews, children }: {
  text: string;
  settled: boolean;
  previews?: ReplyArtifactPreviews;
  children: ReactNode;
}) {
  const directory = useArtifactDirectory();
  const ids = useMemo(() => referencedArtifactIds(text), [text]);
  const reply = useMemo(() => ({ ids, settled }), [ids, settled]);
  if (!directory || ids.length === 0) return <>{children}</>;
  return (
    <ArtifactReferenceContext.Provider value={renderArtifactReference}>
      <ReplyReferenceContext.Provider value={reply}>
        {children}
        {previews && previews.ids.length > 0 && <ReplyReferencedArtifacts previews={previews} settled={settled} />}
      </ReplyReferenceContext.Provider>
    </ArtifactReferenceContext.Provider>
  );
}
