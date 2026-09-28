import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, CloseIcon, WarningIcon } from "./Icons.js";
import { MOBILE_BREAKPOINT_PX } from "./useIsMobile.js";

/** Dialog widths (docs/design-system.md §7.1): confirmations, forms, review and pickers, rare long flows. */
export type ModalSize = "sm" | "md" | "lg" | "full";

/** At or below this width every dialog is a bottom sheet (§7.5). The stylesheet uses the same query. */
export const MODAL_SHEET_MEDIA = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
/** Opening focus moves to the first field only with a fine pointer: on a touch phone it would raise
 * the software keyboard over a sheet the user has not read yet. */
const FIRST_FIELD_MEDIA = "(pointer: fine)";
const FIRST_FIELD = [
  "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([readonly]):not(:disabled)",
  "textarea:not([readonly]):not(:disabled)",
  "select:not(:disabled)",
].join(", ");

interface ModalLayer {
  id: number;
  title: string;
  /** The dialog's own card or sheet; null while its panel is shown in another dialog's sheet. */
  surfaceRef: { current: HTMLDivElement | null };
  /** The panel's portal container. It is moved between surfaces, never re-created, so moving a
   * panel keeps its React state (every value the user entered). */
  panelHost: HTMLElement;
  panelRef: { current: HTMLDivElement | null };
  /** The element inside the panel that last had focus, restored after a move. */
  lastFocusRef: { current: HTMLElement | null };
  close: () => void;
}

let nextModalLayerId = 1;
/** Every open dialog, in the order it opened. The last one owns Escape. */
const modalLayers: ModalLayer[] = [];
const layerListeners = new Set<() => void>();
let layerVersion = 0;

function notifyLayers() {
  layerVersion += 1;
  layerListeners.forEach((listener) => listener());
}

function subscribeLayers(listener: () => void) {
  layerListeners.add(listener);
  return () => { layerListeners.delete(listener); };
}

/** Move `node` under `parent` (before `before`, or last). Moving a subtree blurs whatever inside
 * it had focus, so focus is put back on that element, or on `fallback` if it was already lost. */
function moveKeepingFocus(node: HTMLElement, parent: HTMLElement, before: Node | null, fallback: HTMLElement | null) {
  const focused = document.activeElement;
  const hadFocus = focused instanceof HTMLElement && node.contains(focused) ? focused : null;
  parent.insertBefore(node, before);
  const restore = hadFocus ?? fallback;
  if ((document.activeElement === document.body || document.activeElement === null) &&
      restore?.isConnected && node.contains(restore)) {
    restore.focus();
  }
}

/**
 * Put every open panel in its surface for the current width (§7.1, §7.5).
 *
 * On desktop each dialog is its own card, stacked. On a phone every panel is shown in the oldest
 * dialog's sheet, so a second sheet never stacks: only the newest panel is visible, and the ones
 * under it stay mounted (their values are kept) but are hidden and inert until it closes. Crossing
 * the breakpoint moves the panels without remounting them.
 */
function placePanels(phone: boolean) {
  const owner = modalLayers[0];
  modalLayers.forEach((layer, index) => {
    const target = (phone ? owner : layer)?.surfaceRef.current;
    if (target && layer.panelHost.parentElement !== target) {
      moveKeepingFocus(layer.panelHost, target, null, layer.lastFocusRef.current);
    }
    const covered = phone && index < modalLayers.length - 1;
    layer.panelRef.current?.toggleAttribute("hidden", covered);
    layer.panelRef.current?.toggleAttribute("inert", covered);
  });
}

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    if (typeof window.matchMedia !== "function") return () => undefined;
    const mq = window.matchMedia(query);
    mq.addEventListener("change", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("resize", onChange);
    };
  };
}

function mediaMatches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

const subscribeSheetMedia = subscribeMedia(MODAL_SHEET_MEDIA);
const noopSubscribe = () => () => undefined;

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  tertiary,
  size = "md",
  tone,
  closeButton = true,
  phoneSheet = "fit",
  describedBy,
  className,
  returnFocusRef,
  onKeyDown,
}: {
  title: string;
  /** Optional one-line description under the title, in `--text-dim` (§7.2). */
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** A third action beside Cancel and the primary: usually a destructive tertiary (§7.3). Far left
   * of the footer on desktop; a full-width row at the end of the body on a phone sheet, whose
   * footer holds at most two buttons (§7.5). */
  tertiary?: ReactNode;
  size?: ModalSize;
  /** `danger` puts the red warning icon before the title (§7.4). */
  tone?: "danger";
  /** Confirmations have no close button: Cancel does that job (§7.2). */
  closeButton?: boolean;
  /** `full` opens a long form as a full-height phone sheet with a back arrow and no grabber (§7.5). */
  phoneSheet?: "fit" | "full";
  describedBy?: string;
  /** Applied to the dialog panel (the `role="dialog"` element), so a dialog's own rules never reach
   * a panel shown in the same sheet. */
  className?: string;
  /** Durable element to restore focus to on close. Without it the dialog restores to whatever
   * was focused at open — which fails when the opener was a menu item removed in the same
   * commit that opened the dialog (the menu closes as the dialog mounts). */
  returnFocusRef?: { current: HTMLElement | null };
  /** Optional dialog-scoped keyboard contract; runs after the shared focus trap. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const openerFocusRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const explicitReturnFocusRef = useRef(returnFocusRef);
  explicitReturnFocusRef.current = returnFocusRef;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const layerIdRef = useRef<number | undefined>(undefined);
  if (layerIdRef.current == null) layerIdRef.current = nextModalLayerId++;
  const layerId = layerIdRef.current;

  // Portals do not exist in a server render; render in place there.
  const canPortal = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const phone = useSyncExternalStore(subscribeSheetMedia, () => mediaMatches(MODAL_SHEET_MEDIA), () => false);
  useSyncExternalStore(subscribeLayers, () => layerVersion, () => 0);
  // The panel's portal container, moved between surfaces by placePanels.
  const [panelHost] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.className = "modal-panel-host";
    return host;
  });
  // On a phone a dialog opened over another shows its panel in the oldest dialog's sheet instead of
  // stacking a second sheet (§7.1, §7.5). Desktop always stacks. This follows the live width.
  const owner = modalLayers[0];
  const hosted = canPortal && panelHost !== null && phone && owner !== undefined && owner.id !== layerId;
  const ownIndex = modalLayers.findIndex((layer) => layer.id === layerId);
  const parentLayer = hosted ? (ownIndex === -1 ? modalLayers.at(-1) : modalLayers[ownIndex - 1]) : undefined;
  const backLabel = parentLayer ? `Back to ${parentLayer.title}` : "Back";

  // React focuses an `autoFocus` field (Cancel in a confirmation, Delete Project's name field) as
  // it commits the field, which is before this component's layout effects run. The container must
  // be in the document by then, so the header — committed before the body and footer — places it.
  const lastFocusRef = useRef<HTMLElement | null>(null);
  const placeOnMount = (head: HTMLDivElement | null) => {
    if (!head || !panelHost || panelHost.isConnected) return;
    const sheetOwner = mediaMatches(MODAL_SHEET_MEDIA) ? modalLayers[0] : undefined;
    const target = sheetOwner && sheetOwner.id !== layerId ? sheetOwner.surfaceRef.current : surfaceRef.current;
    if (target) moveKeepingFocus(panelHost, target, null, lastFocusRef.current);
  };

  const layerRef = useRef<ModalLayer | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const footRef = useRef<HTMLDivElement>(null);
  // The tertiary's portal container: far left of the footer on desktop, the body's end on a phone.
  // Moved, never re-created, so a focused tertiary keeps focus across the breakpoint.
  const [tertiaryHost] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    const host = document.createElement("div");
    host.className = "modal-tertiary";
    return host;
  });
  const tertiaryPortable = canPortal && tertiaryHost !== null;
  useLayoutEffect(() => {
    if (!tertiaryHost) return;
    if (tertiary == null) {
      tertiaryHost.remove();
      return;
    }
    const parent = phone ? bodyRef.current : footRef.current;
    if (!parent) return;
    const before = phone ? null : parent.firstChild;
    if (tertiaryHost.parentElement !== parent || (!phone && parent.firstChild !== tertiaryHost)) {
      moveKeepingFocus(tertiaryHost, parent, before === tertiaryHost ? tertiaryHost.nextSibling : before, lastFocusRef.current);
    }
  });
  useLayoutEffect(() => () => { tertiaryHost?.remove(); }, [tertiaryHost]);
  useLayoutEffect(() => {
    if (layerRef.current) layerRef.current.title = title;
    placePanels(phone);
  });

  useLayoutEffect(() => {
    if (!panelHost) return;
    const layer: ModalLayer = {
      id: layerId,
      title,
      surfaceRef,
      panelHost,
      panelRef,
      lastFocusRef,
      close: () => onCloseRef.current(),
    };
    layerRef.current = layer;
    modalLayers.push(layer);
    placePanels(mediaMatches(MODAL_SHEET_MEDIA));
    // StrictMode re-runs this effect after a simulated cleanup that detached the container.
    const refocus = lastFocusRef.current;
    if ((document.activeElement === document.body || document.activeElement === null) &&
        refocus?.isConnected && panelHost.contains(refocus)) {
      refocus.focus();
    }
    notifyLayers();
    const onKey = (e: KeyboardEvent) => {
      // Nested UI (e.g. the directory browser) claims Escape for itself via preventDefault —
      // don't tear the whole dialog down over it.
      if (e.key === "Escape" && !e.defaultPrevented && modalLayers.at(-1)?.id === layerId) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const index = modalLayers.indexOf(layer);
      if (index !== -1) modalLayers.splice(index, 1);
      layerRef.current = null;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (active && panelHost.contains(active)) lastFocusRef.current = active;
      // A panel shown in this dialog's phone sheet loses its place with it; remember its focus so
      // it is restored when that dialog takes the sheet over.
      for (const other of modalLayers) {
        if (active && other.panelHost.contains(active)) other.lastFocusRef.current = active;
      }
      panelHost.remove();
      // Uncover the panel beneath before focus is restored into it. If this dialog owned the phone
      // sheet, the next one takes it over when it re-renders.
      placePanels(mediaMatches(MODAL_SHEET_MEDIA));
      notifyLayers();
      const explicit = explicitReturnFocusRef.current?.current;
      const target = explicit?.isConnected ? explicit : openerFocusRef.current;
      window.setTimeout(() => {
        // A queued dialog can replace this one in the same commit. Do not steal focus back to
        // the page from that newer modal; nested dialogs may still restore into their owning
        // dialog — but only the TOPMOST one, so a dying layer can never pull focus out from
        // under a newer dialog stacked above its opener (regression coverage).
        const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]:not([hidden])');
        const topmost = dialogs[dialogs.length - 1] ?? null;
        if (target?.isConnected &&
            (modalLayers.length === 0 || (topmost !== null && target.closest('[role="dialog"]') === topmost))) {
          target.focus();
          // A connected target can still refuse focus — e.g. it became disabled while the
          // dialog's action ran. Fall through so keyboard position never lands on <body>.
          if (document.activeElement === target) return;
        }
        // The opener is gone or unfocusable — a breakpoint crossing unmounted the layout that
        // held it, or a busy state disabled it. Focus was live inside the dialog the whole
        // time, so no layout rescue fired and none will. Without this the close drops focus on
        // <body> and the next Tab restarts at the top of the document.
        if (modalLayers.length === 0) {
          document.getElementById("page-title")?.focus();
          return;
        }
        // Restoration failed while other dialogs remain open: keep keyboard position inside
        // the modal system and its Tab trap rather than on <body>.
        if (document.activeElement === document.body || document.activeElement === null) {
          topmost?.focus();
        }
      }, 0);
    };
    // The layer is registered once; the effect above keeps its fields current.
  }, []);

  // Move focus into the dialog on open so Escape/Tab work immediately — unless a field inside
  // already claimed it (autoFocus). The panel takes focus without a ring (§16.1), then the first
  // field does (§7.2).
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    const field = mediaMatches(FIRST_FIELD_MEDIA)
      ? panel.querySelector<HTMLElement>(`.modal-body :is(${FIRST_FIELD})`)
      : null;
    (field ?? panel).focus();
  }, []);

  // Keep Tab cycling inside the dialog instead of escaping to the page behind it.
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // The scrim closes only what is on top of it: the newest panel in a phone sheet.
  const closeTopOfSheet = () => {
    const top = mediaMatches(MODAL_SHEET_MEDIA) && modalLayers[0]?.id === layerId ? modalLayers.at(-1) : undefined;
    (top?.close ?? onCloseRef.current)();
  };

  const showBack = hosted || (phone && phoneSheet === "full");
  const showClose = closeButton && !showBack;
  const hasTertiary = tertiary != null;
  const panel = (
    <div
      ref={panelRef}
      className={["modal-panel", hosted ? "pushed" : "", className ?? ""].filter(Boolean).join(" ")}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedBy ?? (description ? descriptionId : undefined)}
      tabIndex={-1}
      onFocus={(event) => { if (event.target instanceof HTMLElement) lastFocusRef.current = event.target; }}
      onKeyDown={(event) => {
        // A dialog portalled from inside this one still bubbles through it in React's tree.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        trapTab(event);
        onKeyDown?.(event);
      }}
    >
      <div className="modal-head" ref={placeOnMount}>
        {tone === "danger" && !showBack && (
          <span className="modal-tone-icon" aria-hidden="true"><WarningIcon size={20} /></span>
        )}
        <div className="modal-heading">
          <h2 id={titleId} className="modal-title">{title}</h2>
          {description && <p id={descriptionId} className="modal-desc">{description}</p>}
        </div>
        {/* One element for Close and Back: a breakpoint crossing swaps its glyph, name and side
            (`order`), and never unmounts the button that holds focus. */}
        {(showBack || showClose) && (
          <button
            type="button"
            className={`icon-btn ${showBack ? "modal-back" : "modal-close"}`}
            onClick={onClose}
            aria-label={showBack ? backLabel : "Close"}
            title={showBack ? backLabel : "Close"}
          >
            {showBack ? <ChevronLeftIcon /> : <CloseIcon />}
          </button>
        )}
      </div>
      <div className="modal-body" ref={bodyRef}>
        {children}
        {hasTertiary && !tertiaryPortable && phone && <div className="modal-tertiary">{tertiary}</div>}
      </div>
      {(footer || (hasTertiary && !phone)) && (
        <div className="modal-foot" ref={footRef}>
          {hasTertiary && !tertiaryPortable && !phone && <div className="modal-tertiary">{tertiary}</div>}
          {footer}
        </div>
      )}
    </div>
  );

  if (!canPortal || !panelHost) {
    // A server render has no portals: render the whole dialog in place.
    return (
      <div className="modal-backdrop">
        <div className={["modal", size === "md" ? "" : size, phoneSheet === "full" ? "sheet-full" : ""].filter(Boolean).join(" ")}>
          {phoneSheet !== "full" && <div className="sheet-grabber" aria-hidden="true" />}
          {panel}
        </div>
      </div>
    );
  }
  const panelPortal = createPortal(panel, panelHost);
  const sheet = (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTopOfSheet(); }}>
      <div
        ref={surfaceRef}
        className={["modal", size === "md" ? "" : size, phoneSheet === "full" ? "sheet-full" : ""].filter(Boolean).join(" ")}
      >
        {phoneSheet !== "full" && <div className="sheet-grabber" aria-hidden="true" />}
      </div>
    </div>
  );
  // The panel's container is placed in this surface (or the phone sheet's) by placePanels. The
  // panel keeps its slot whether or not this dialog has a surface, so crossing the breakpoint
  // never remounts it.
  return (
    <>
      {hosted ? null : createPortal(sheet, document.body)}
      {panelPortal}
      {hasTertiary && tertiaryHost ? createPortal(tertiary, tertiaryHost) : null}
    </>
  );
}
