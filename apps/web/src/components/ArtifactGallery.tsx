import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { WorkflowArtifactView } from "@wollipog/protocol";
import { Modal } from "./Modal.js";
import { useFeedback } from "./FeedbackProvider.js";
import { ChevronLeftIcon, ChevronRightIcon, LinkIcon, Minimize2Icon, PanelRightIcon, PlusIcon } from "./Icons.js";
import { ArtifactDownloadMenu, ArtifactMetaFacts, ArtifactPreviewBody, useArtifactPreview } from "./ArtifactPreview.js";
import { writeClipboardText } from "../clipboard.js";
import { absoluteViewUrl } from "../navigation.js";
import { useDashboardPublicOrigin } from "../remote-access-context.js";
import {
  clampTransform,
  distanceBetween,
  FIT_TRANSFORM,
  isZoomed,
  MAX_ZOOM,
  midpointOf,
  pinchTransform,
  STEP_ZOOM,
  swipeDirection,
  zoomAt,
  type Point,
  type ZoomTransform,
} from "../artifact-gallery-gestures.js";

export const ARTIFACT_GALLERY_COPY = {
  previous: "Previous",
  next: "Next",
  position: (index: number, total: number) => `${index} of ${total}`,
  zoomIn: "Zoom In",
  fit: "Fit to Screen",
  openInBrowser: "Open in Browser",
  copyLink: "Copy Link",
  done: "Done",
} as const;

/** How long two taps may be apart, and how far, to count as a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;
/** A tap moves less than this; anything further is a drag. */
const TAP_SLOP = 10;

/**
 * An artifact's stable link (#3924): its session's Browser → Artifacts tab on it. Null where this
 * dashboard has no address another device can open.
 */
export function useArtifactLink(sessionId?: string): (artifact: WorkflowArtifactView) => string | null {
  const origin = useDashboardPublicOrigin();
  return useCallback((artifact: WorkflowArtifactView) => {
    const owner = artifact.sessionId ?? sessionId;
    return origin && owner
      ? absoluteViewUrl(origin, { name: "session", id: owner, artifacts: { artifactId: artifact.artifactId } })
      : null;
  }, [origin, sessionId]);
}

/** Copy Link, with its toast; focus stays where the copy was asked for. */
export function useCopyArtifactLink(sessionId?: string): ((artifact: WorkflowArtifactView) => void) | null {
  const linkFor = useArtifactLink(sessionId);
  const { showToast } = useFeedback();
  const origin = useDashboardPublicOrigin();
  const copy = useCallback((artifact: WorkflowArtifactView) => {
    const link = linkFor(artifact);
    if (!link) return;
    const from = document.activeElement;
    const current = () => document.activeElement === null || document.activeElement === document.body ||
      document.activeElement === from;
    void writeClipboardText(link, current).then((result) => {
      if (result === null) return;
      if (from instanceof HTMLElement && from.isConnected &&
          (document.activeElement === document.body || document.activeElement === null)) from.focus();
      if (result) showToast("Copied the link.", { tone: "success" });
      else showToast("Couldn't copy the link.", { tone: "error" });
    });
  }, [linkFor, showToast]);
  return origin ? copy : null;
}

/** A gesture that starts here belongs to the control under it: a player's seek bar, a field, a
 * link, a button, or a well that scrolls sideways. */
function ownsGesture(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("video, audio, iframe, input, textarea, select, button, a, [contenteditable], .code-well, .menu") !== null;
}

/** Arrow keys belong to a focused player's seek bar or a text field, not to the viewer. */
function keepsKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.matches("video, audio, textarea, select")) return true;
  return target instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(target.type);
}

type Gesture =
  | { kind: "none" }
  | { kind: "swipe"; pointerId: number; start: Point; at: number }
  | { kind: "pan"; pointerId: number; start: Point; origin: ZoomTransform; moved: boolean }
  | { kind: "pinch"; startMidpoint: Point; startDistance: number; origin: ZoomTransform };

/**
 * The full-screen artifact viewer (#3924; docs/design-system.md §7.1, §7.5): a full dialog, a
 * full-height sheet on phones, the way the Evidence Viewer presents media (#2207) without its review
 * controls. It steps through `artifacts` in their order with Previous, Next, ← → and a horizontal
 * swipe, and says where it is ("2 of 8"). An image fits the stage and zooms with a pinch, a double
 * tap or click, Ctrl+wheel, + and -; zoomed, a drag pans it instead of moving on, and Fit to Screen
 * or 0 returns it. A video plays only when asked; a swipe never starts on its controls. Viewing marks
 * nothing reviewed and approves nothing.
 */
export function ArtifactGallery({ artifacts, initialId, sessionId, onClose, returnFocusRef, onOpenInBrowser }: {
  artifacts: readonly WorkflowArtifactView[];
  initialId: string;
  /** The session the artifacts belong to, for Copy Link when an artifact does not name it. */
  sessionId?: string;
  onClose: () => void;
  /** What opened the viewer, where focus returns on close. */
  returnFocusRef: { current: HTMLElement | null };
  /** Open in Browser: absent where the viewer is opened from the Browser itself. */
  onOpenInBrowser?: (artifact: WorkflowArtifactView) => void;
}) {
  const [currentId, setCurrentId] = useState(initialId);
  const found = artifacts.findIndex((artifact) => artifact.artifactId === currentId);
  const index = Math.max(found, 0);
  const artifact = artifacts[index]!;
  const previous = artifacts[index - 1];
  const next = artifacts[index + 1];
  const model = useArtifactPreview(artifact);
  const copyLink = useCopyArtifactLink(sessionId);
  const doneRef = useRef<HTMLButtonElement>(null);
  const zoomRef = useRef<ZoomControls | null>(null);

  // After every commit, not only a step: Previous or Next turns disabled at either end, and focus
  // must not fall out of the dialog, where ← → and its Tab trap no longer reach the person.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (!focused || focused === document.body || (focused instanceof HTMLElement && focused.matches(":disabled"))) {
      doneRef.current?.focus();
    }
  });

  const show = (target: WorkflowArtifactView | undefined) => {
    if (target) setCurrentId(target.artifactId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || keepsKeys(event.target)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (event.shiftKey) return;
      event.preventDefault();
      show(event.key === "ArrowLeft" ? previous : next);
      return;
    }
    const zoom = zoomRef.current;
    if (!zoom) return;
    if (event.key === "+" || event.key === "=") zoom.zoomBy(STEP_ZOOM);
    else if (event.key === "-") zoom.zoomBy(1 / STEP_ZOOM);
    else if (event.key === "0") zoom.fit();
    else return;
    event.preventDefault();
  };
  const onSwipe = (direction: "previous" | "next") => show(direction === "previous" ? previous : next);

  const loaded = model.state.phase === "ready" ? model.state.loaded : null;
  return (
    <Modal
      title={artifact.name}
      description={<span className="art-meta"><ArtifactMetaFacts model={model} /></span>}
      onClose={onClose}
      size="full"
      phoneSheet="full"
      className="art-gallery"
      returnFocusRef={returnFocusRef}
      onKeyDown={onKeyDown}
      headerActions={(
        <>
          {copyLink && (
            <button type="button" className="icon-btn" aria-label={ARTIFACT_GALLERY_COPY.copyLink}
              title={ARTIFACT_GALLERY_COPY.copyLink} onClick={() => copyLink(artifact)}>
              <LinkIcon />
            </button>
          )}
          {onOpenInBrowser && (
            <button type="button" className="icon-btn" aria-label={ARTIFACT_GALLERY_COPY.openInBrowser}
              title={ARTIFACT_GALLERY_COPY.openInBrowser} onClick={() => { onClose(); onOpenInBrowser(artifact); }}>
              <PanelRightIcon />
            </button>
          )}
        </>
      )}
      footer={(
        <>
          <p className="art-gallery-position" aria-live="polite">
            {ARTIFACT_GALLERY_COPY.position(index + 1, artifacts.length)}
          </p>
          {artifacts.length > 1 && (
            <>
              <button type="button" className="btn ev-viewer-step" disabled={!previous} aria-keyshortcuts="ArrowLeft"
                onClick={() => show(previous)}>
                <ChevronLeftIcon size={16} />
                <span className="ev-viewer-step-label">{ARTIFACT_GALLERY_COPY.previous}</span>
              </button>
              <button type="button" className="btn ev-viewer-step" disabled={!next} aria-keyshortcuts="ArrowRight"
                onClick={() => show(next)}>
                <span className="ev-viewer-step-label">{ARTIFACT_GALLERY_COPY.next}</span>
                <ChevronRightIcon size={16} />
              </button>
            </>
          )}
          <ArtifactDownloadMenu key={artifact.artifactId} model={model} inline />
          <button ref={doneRef} type="button" className="btn art-gallery-done" autoFocus onClick={onClose}>{ARTIFACT_GALLERY_COPY.done}</button>
        </>
      )}
    >
      {loaded?.kind === "image" ? (
        <ZoomableImage key={artifact.artifactId} src={loaded.objectUrl} alt={artifact.name} controlsRef={zoomRef} onSwipe={onSwipe} />
      ) : (
        <SwipeStage key={artifact.artifactId} onSwipe={onSwipe}>
          <ArtifactPreviewBody model={model} />
        </SwipeStage>
      )}
    </Modal>
  );
}

interface ZoomControls {
  zoomBy: (factor: number) => void;
  fit: () => void;
}

function pointIn(element: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
}

/**
 * Anything but a shown image: the preview body in a stage of its own, where a horizontal swipe that
 * starts outside a control moves on. Vertical scrolling stays the browser's (`touch-action: pan-y`),
 * a mouse drag selects text, and a drag that leaves a selection behind is not a swipe.
 */
function SwipeStage({ children, onSwipe }: {
  children: ReactNode;
  onSwipe: (direction: "previous" | "next") => void;
}) {
  const gesture = useRef<Gesture>({ kind: "none" });
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || !event.isPrimary || ownsGesture(event.target)) {
      gesture.current = { kind: "none" };
      return;
    }
    gesture.current = { kind: "swipe", pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, at: event.timeStamp };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    gesture.current = { kind: "none" };
    if (current.kind !== "swipe" || current.pointerId !== event.pointerId) return;
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (selection && !selection.isCollapsed) return;
    const direction = swipeDirection(event.clientX - current.start.x, event.clientY - current.start.y, event.timeStamp - current.at);
    if (direction) onSwipe(direction);
  };
  return (
    <div className="art-gallery-stage art-gallery-scroll" onPointerDown={onPointerDown} onPointerUp={onPointerUp}
      onPointerCancel={() => { gesture.current = { kind: "none" }; }}>
      {children}
    </div>
  );
}

/**
 * A shown image, fitted to the stage. Every touch on it is the viewer's (`touch-action: none`), so a
 * pinch zooms the image rather than the page: one finger swipes at fit and pans once zoomed, two
 * pinch, and a double tap zooms in at the tap or back to fit.
 */
function ZoomableImage({ src, alt, controlsRef, onSwipe }: {
  src: string;
  alt: string;
  controlsRef: { current: ZoomControls | null };
  onSwipe: (direction: "previous" | "next") => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [transform, setTransform] = useState<ZoomTransform>(FIT_TRANSFORM);
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: "none" });
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  // A touch double tap is read from its own taps above. The browser reports it as a `dblclick` as
  // well, which must not toggle the zoom a second time and so undo it.
  const lastPointerType = useRef<string>("mouse");

  /** The image's fitted size: `object-fit: contain` inside the stage-sized element. */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    const image = imageRef.current;
    const box = stage?.getBoundingClientRect();
    const stageSize = { width: box?.width ?? 0, height: box?.height ?? 0 };
    const natural = { width: image?.naturalWidth ?? 0, height: image?.naturalHeight ?? 0 };
    if (!natural.width || !natural.height) return { stage: stageSize, content: stageSize };
    const fit = Math.min(stageSize.width / natural.width, stageSize.height / natural.height);
    return { stage: stageSize, content: { width: natural.width * fit, height: natural.height * fit } };
  }, []);
  const apply = useCallback((next: ZoomTransform) => {
    const { stage, content } = measure();
    const clamped = clampTransform(next, stage, content);
    transformRef.current = clamped;
    setTransform(clamped);
  }, [measure]);

  useLayoutEffect(() => {
    controlsRef.current = {
      zoomBy: (factor) => {
        const current = transformRef.current;
        apply(zoomAt(current, { x: 0, y: 0 }, Math.min(MAX_ZOOM, Math.max(1, current.scale * factor))));
      },
      fit: () => apply(FIT_TRANSFORM),
    };
    return () => { controlsRef.current = null; };
  }, [apply, controlsRef]);

  // A trackpad pinch arrives as Ctrl+wheel. React's wheel listener is passive, so this one is not.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = transformRef.current;
      const scale = Math.min(MAX_ZOOM, Math.max(1, current.scale * Math.exp(-event.deltaY * 0.01)));
      apply(zoomAt(current, pointIn(stage, event), scale));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [apply]);

  // A resize (a phone turning) refits the bounds the image may pan within.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => apply(transformRef.current));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [apply]);

  const toggleZoomAt = (point: Point) => {
    const current = transformRef.current;
    apply(isZoomed(current) ? FIT_TRANSFORM : zoomAt(current, point, STEP_ZOOM));
  };

  const startGesture = () => {
    const entries = [...pointers.current.entries()];
    const current = transformRef.current;
    if (entries.length >= 2) {
      const [a, b] = [entries[0]![1], entries[1]![1]];
      gesture.current = { kind: "pinch", startMidpoint: midpointOf(a, b), startDistance: distanceBetween(a, b), origin: current };
    } else if (entries.length === 1) {
      const [pointerId, start] = entries[0]!;
      gesture.current = isZoomed(current)
        ? { kind: "pan", pointerId, start, origin: current, moved: false }
        : { kind: "swipe", pointerId, start, at: performance.now() };
    } else {
      gesture.current = { kind: "none" };
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    lastPointerType.current = event.pointerType;
    const stage = stageRef.current;
    if (!stage || ownsGesture(event.target) || (event.pointerType === "mouse" && event.button !== 0)) return;
    // A mouse never swipes: at fit its drag does nothing, and zoomed it pans.
    if (event.pointerType === "mouse" && !isZoomed(transformRef.current)) return;
    event.preventDefault();
    stage.setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, pointIn(stage, event));
    startGesture();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || !pointers.current.has(event.pointerId)) return;
    const point = pointIn(stage, event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (current.kind === "pinch") {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      apply(pinchTransform(current.origin, current.startMidpoint, current.startDistance, midpointOf(a, b), distanceBetween(a, b)));
    } else if (current.kind === "pan" && current.pointerId === event.pointerId) {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      if (Math.hypot(dx, dy) > TAP_SLOP) current.moved = true;
      apply({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });
    }
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const stage = stageRef.current;
    const start = pointers.current.get(event.pointerId);
    if (!stage || !start) return;
    const point = pointIn(stage, event);
    pointers.current.delete(event.pointerId);
    const current = gesture.current;
    if (!cancelled && pointers.current.size === 0 && event.pointerType !== "mouse") {
      const tapped = current.kind === "swipe"
        ? Math.hypot(point.x - current.start.x, point.y - current.start.y) <= TAP_SLOP
        : current.kind === "pan" && !current.moved;
      if (tapped) {
        const previousTap = lastTap.current;
        const now = performance.now();
        if (previousTap && now - previousTap.at <= DOUBLE_TAP_MS &&
            Math.hypot(point.x - previousTap.point.x, point.y - previousTap.point.y) <= DOUBLE_TAP_SLOP) {
          lastTap.current = null;
          toggleZoomAt(point);
          gesture.current = { kind: "none" };
          return;
        }
        lastTap.current = { at: now, point };
      } else {
        lastTap.current = null;
      }
      if (current.kind === "swipe" && current.pointerId === event.pointerId) {
        const direction = swipeDirection(point.x - current.start.x, point.y - current.start.y, performance.now() - current.at);
        gesture.current = { kind: "none" };
        if (direction) onSwipe(direction);
        return;
      }
    }
    // A pinch that lifts one finger carries on as a pan with the other, never as a swipe.
    if (current.kind === "pinch" && pointers.current.size === 1) {
      const [pointerId, remaining] = [...pointers.current.entries()][0]!;
      gesture.current = { kind: "pan", pointerId, start: remaining, origin: transformRef.current, moved: true };
      return;
    }
    if (pointers.current.size === 0) gesture.current = { kind: "none" };
  };

  const zoomed = isZoomed(transform);
  return (
    <div
      ref={stageRef}
      className="art-gallery-stage art-gallery-zoomable"
      data-zoomed={zoomed || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endPointer(event, false)}
      onPointerCancel={(event) => endPointer(event, true)}
      onDoubleClick={(event) => {
        const stage = stageRef.current;
        if (stage && lastPointerType.current !== "touch" && !ownsGesture(event.target)) toggleZoomAt(pointIn(stage, event));
      }}
    >
      <img
        ref={imageRef}
        className="art-gallery-media"
        src={src}
        alt={alt}
        draggable={false}
        onLoad={() => apply(transformRef.current)}
        style={zoomed ? { transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` } : undefined}
      />
      <div className="art-gallery-zoom">
        {zoomed ? (
          <button type="button" className="btn sm" aria-keyshortcuts="0" onClick={() => apply(FIT_TRANSFORM)}>
            <Minimize2Icon size={16} />{ARTIFACT_GALLERY_COPY.fit}
          </button>
        ) : (
          <button type="button" className="icon-btn sm" aria-label={ARTIFACT_GALLERY_COPY.zoomIn} title={ARTIFACT_GALLERY_COPY.zoomIn}
            aria-keyshortcuts="+" onClick={() => apply(zoomAt(transformRef.current, { x: 0, y: 0 }, STEP_ZOOM))}>
            <PlusIcon size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
