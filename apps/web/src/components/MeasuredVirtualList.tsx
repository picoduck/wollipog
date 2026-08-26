import {
  createContext,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { flushSync } from "react-dom";
import { VIRTUAL_VIEWPORT_INTENT_EVENT } from "../viewport-intent.js";

type CancelVirtualMeasurementCommit = () => void;
type VirtualMeasurementCommit = (commit: () => void) => CancelVirtualMeasurementCommit | void;

const commitVirtualMeasurementsSynchronously: VirtualMeasurementCommit = (commit) => flushSync(commit);
const deferVirtualMeasurementsForTest: VirtualMeasurementCommit = (commit) => {
  // Cross multiple paint boundaries so rendered negative controls sample an untrusted frame even
  // when the initiating Playwright action consumes one browser frame for actionability checks.
  let frame: number | null = null;
  let framesRemaining = 3;
  const advance = () => {
    if (framesRemaining <= 0) {
      frame = null;
      commit();
      return;
    }
    framesRemaining -= 1;
    frame = requestAnimationFrame(advance);
  };
  frame = requestAnimationFrame(advance);
  return () => {
    if (frame != null) cancelAnimationFrame(frame);
  };
};

interface VirtualMeasurementCommitController {
  commit: VirtualMeasurementCommit;
  deferInitialMeasurements: boolean;
}

const synchronousMeasurementController: VirtualMeasurementCommitController = {
  commit: commitVirtualMeasurementsSynchronously,
  deferInitialMeasurements: false,
};
const deferredMeasurementController: VirtualMeasurementCommitController = {
  commit: deferVirtualMeasurementsForTest,
  deferInitialMeasurements: true,
};
const VirtualMeasurementCommitContext = createContext<VirtualMeasurementCommitController>(
  synchronousMeasurementController,
);

/** Fault-injection seam for rendered behavior tests. Production must use the synchronous default. */
export function VirtualMeasurementCommitTestProvider({ deferred, children }: {
  deferred: boolean;
  children: ReactNode;
}) {
  return (
    <VirtualMeasurementCommitContext.Provider
      value={deferred ? deferredMeasurementController : synchronousMeasurementController}
    >
      {children}
    </VirtualMeasurementCommitContext.Provider>
  );
}

export interface VirtualRowState {
  index: number;
  /** True only for the actual viewport, not overscan. */
  visible: boolean;
  /** Visible and no longer in an active scroll gesture; safe for idle enhancement work. */
  settledVisible: boolean;
}

export function pinnedRangeExtractor(range: Range, pinned: readonly number[]): number[] {
  const indexes = new Set(defaultRangeExtractor(range));
  for (const index of pinned) {
    if (Number.isSafeInteger(index) && index >= 0 && index < range.count) indexes.add(index);
  }
  return [...indexes].sort((left, right) => left - right);
}

export function scrollAnchorAdjustment(previousOffset: number, currentOffset: number): number {
  return currentOffset - previousOffset;
}

export function shouldAdjustVirtualScrollForResize({
  itemStart,
  scrollOffset,
  scrollAdjustments,
  anchorPending,
}: {
  itemStart: number;
  scrollOffset: number;
  scrollAdjustments: number;
  measured: boolean;
  scrollDirection: "forward" | "backward" | null;
  anchorPending: boolean;
}): boolean {
  return !anchorPending && itemStart < scrollOffset + scrollAdjustments;
}

interface VirtualMeasurementReseeder {
  measure: () => void;
  getVirtualItems: () => unknown;
  resizeItem: (index: number, size: number) => void;
}

/**
 * Invalidates width-owned measurements, then restores the mounted rows before paint.
 *
 * The ordering is intentional. TanStack retains a stale flat measurement array when `measure()`
 * clears its item-size cache. Rebuilding that array from estimates before `resizeItem()` makes the
 * mounted DOM heights produce real deltas and repopulate the cache.
 */
export function reseedMountedVirtualRows(
  root: Pick<ParentNode, "querySelectorAll"> | null,
  virtualizer: VirtualMeasurementReseeder,
): void {
  const mountedSizes = [...root?.querySelectorAll<HTMLElement>("[data-virtual-row]") ?? []]
    .map((row) => ({
      index: Number(row.dataset.index),
      size: row.offsetHeight,
    }))
    .filter(({ index }) => Number.isSafeInteger(index));
  virtualizer.measure();
  virtualizer.getVirtualItems();
  for (const { index, size } of mountedSizes) {
    virtualizer.resizeItem(index, size);
  }
}

interface MeasuredVirtualListProps<T> {
  items: readonly T[];
  /** Bumps when a cache-owned items array is updated in place at its tail. */
  itemsVersion?: number;
  /** Earliest index whose key or position may have changed for an in-place version bump. */
  itemsDirtyFrom?: number;
  getKey: (item: T) => string;
  renderItem: (item: T, state: VirtualRowState) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  estimateSize: (item: T, index: number) => number;
  overscan: number;
  className?: string;
  rowClassName?: string;
  ariaLabel?: string;
  /** Adds drag-source pinning and window-level cleanup for native HTML drag/drop lists. */
  pinDraggedRow?: boolean;
  /**
   * A row that must stay mounted regardless of the viewport.
   *
   * The focused-row pin keys off DOM focus, which is right for a list whose ROWS take focus. A list
   * driven by `aria-activedescendant` keeps focus on the container, so no row is ever focused and
   * that pin never fires — while the id the container points at must refer to a mounted element.
   */
  pinnedKey?: string | null;
  /**
   * Roles for the virtual root and its positioned wrappers.
   *
   * The defaults suit a standalone list. Inside a `grid` they are wrong twice over: a separately
   * named `role="list"` nests a second structure inside the grid, and `aria-posinset`/`aria-setsize`
   * land on the wrappers rather than on the `role="row"` elements the grid actually exposes. Pass
   * `rowgroup`/`presentation` there and let the rows carry `aria-rowindex` themselves.
   */
  rootRole?: string;
  rowRole?: string;
  rowGap?: number;
  dataKind?: string;
  /** Reads the logical row position once, when this list instance mounts. */
  getInitialAnchor?: () => VirtualScrollAnchor | null;
  /** Whether structural and width changes should preserve the current logical row. */
  preserveAnchor?: boolean;
  /**
   * The current item set is a partial history page that may still recover the requested key.
   * Missing anchors remain pending until the authoritative history chain completes.
   */
  anchorRecoveryPending?: boolean;
  /** Reports the first visible logical row as the reader moves through the list. */
  onVisibleAnchorChange?: (anchor: VirtualScrollAnchor) => void;
  /** Reports that a requested logical anchor no longer exists in the item set. */
  onAnchorLost?: (anchor: VirtualScrollAnchor) => void;
  /** Explicit logical-row navigation. `requestId` makes same-row replay intentional. */
  revealRequest?: VirtualRevealRequest | null;
  /** Reports whether explicit navigation reached a mounted row. */
  onRevealHandled?: (requestId: number, outcome: VirtualRevealOutcome) => void;
}

export interface VirtualScrollAnchor {
  key: string;
  /** Row top relative to the scroll viewport, not the document. */
  offset: number;
  /** Last known logical row index, used to survive a provider-driven key rewrite. */
  index?: number;
}

export interface VirtualRevealRequest {
  key: string;
  requestId: number;
  align?: "start" | "center" | "end" | "auto";
  /** Focus the row after navigation so keyboard and assistive-technology users land there. */
  focus?: boolean;
}

export type VirtualRevealOutcome = "revealed" | "unresolved" | "cancelled";

export function virtualTargetScrollAdjustment({
  align,
  rowStart,
  rowEnd,
  viewportStart,
  viewportEnd,
}: {
  align: NonNullable<VirtualRevealRequest["align"]>;
  rowStart: number;
  rowEnd: number;
  viewportStart: number;
  viewportEnd: number;
}): number {
  if (align === "start") return rowStart - viewportStart;
  if (align === "end") return rowEnd - viewportEnd;
  if (align === "center") return (rowStart + rowEnd) / 2 - (viewportStart + viewportEnd) / 2;
  if (rowStart < viewportStart) return rowStart - viewportStart;
  if (rowEnd > viewportEnd) return rowEnd - viewportEnd;
  return 0;
}

export function reanchorAtLogicalIndex(
  anchor: VirtualScrollAnchor,
  keys: readonly string[],
  clamp = false,
): VirtualScrollAnchor | null {
  const index = anchor.index;
  if (index == null || !Number.isSafeInteger(index) || index < 0 || keys.length === 0) return null;
  const nearestIndex = clamp ? Math.min(index, keys.length - 1) : index;
  if (nearestIndex >= keys.length) return null;
  const key = keys[nearestIndex];
  return key == null ? null : { ...anchor, key, index: nearestIndex };
}

/**
 * Shared variable-height list adapter. It keeps logical ordering/accessibility in React while
 * TanStack Virtual owns measurement, resize correction, and viewport range selection. Focused and
 * dragged rows are included in the range extractor so a scroll cannot destroy browser ownership.
 */
export function MeasuredVirtualList<T>(props: MeasuredVirtualListProps<T>) {
  if (typeof document === "undefined") return <StaticList {...props} />;
  return <VirtualList {...props} />;
}

function StaticList<T>({
  items,
  getKey,
  renderItem,
  className,
  rowClassName,
  ariaLabel,
  dataKind,
  rootRole = "list",
  rowRole = "listitem",
  revealRequest,
  onRevealHandled,
}: MeasuredVirtualListProps<T>) {
  const revealExists = revealRequest != null && items.some((item) => getKey(item) === revealRequest.key);
  useEffect(() => {
    if (!revealRequest) return;
    onRevealHandled?.(revealRequest.requestId, revealExists ? "revealed" : "unresolved");
  }, [onRevealHandled, revealExists, revealRequest]);
  return (
    <div className={className} role={rootRole} aria-label={ariaLabel} data-virtual-kind={dataKind}>
      {items.map((item, index) => (
        <div
          key={getKey(item)}
          className={rowClassName}
          role={rowRole}
          {...(rowRole === "listitem" ? { "aria-posinset": index + 1, "aria-setsize": items.length } : {})}
          data-virtual-key={getKey(item)}
          data-virtual-target={revealRequest?.key === getKey(item) ? "true" : undefined}
          aria-current={revealRequest?.key === getKey(item) ? "location" : undefined}
        >
          {renderItem(item, { index, visible: true, settledVisible: true })}
        </div>
      ))}
    </div>
  );
}

function VirtualList<T>({
  items,
  getKey,
  renderItem,
  scrollRef,
  estimateSize,
  overscan,
  className,
  rowClassName,
  ariaLabel,
  pinDraggedRow = false,
  pinnedKey = null,
  rowGap = 0,
  dataKind,
  rootRole = "list",
  rowRole = "listitem",
  itemsVersion = 0,
  itemsDirtyFrom = 0,
  getInitialAnchor,
  preserveAnchor = true,
  anchorRecoveryPending = false,
  onVisibleAnchorChange,
  onAnchorLost,
  revealRequest = null,
  onRevealHandled,
}: MeasuredVirtualListProps<T>) {
  const {
    commit: commitVirtualMeasurements,
    deferInitialMeasurements,
  } = useContext(VirtualMeasurementCommitContext);
  const rootRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const scrollMarginRef = useRef(0);
  const viewportWidthRef = useRef(0);
  const [measurementEpoch, setMeasurementEpoch] = useState(0);
  const [initialMeasurementsReady, setInitialMeasurementsReady] = useState(false);
  const initialMeasurementsReadyRef = useRef(initialMeasurementsReady);
  initialMeasurementsReadyRef.current = initialMeasurementsReady;
  const initialTotalHeightRef = useRef<number | null>(null);
  const [, forceAnchorRetry] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [revealPinnedKey, setRevealPinnedKey] = useState<string | null>(null);
  const [revealedLocationKey, setRevealedLocationKey] = useState<string | null>(null);
  const previousItemsRef = useRef(items);
  const visibleAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  const mountAnchorRef = useRef<VirtualScrollAnchor | null | undefined>(undefined);
  if (mountAnchorRef.current === undefined) mountAnchorRef.current = getInitialAnchor?.() ?? null;
  const pendingAnchorRef = useRef<VirtualScrollAnchor | null>(mountAnchorRef.current);
  const lostAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  const lostAnchorIsMountRestoreRef = useRef(false);
  const lostAnchorIntentVersionRef = useRef<number | null>(null);
  const rekeyedAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  // Mount restoration ignores incidental focus/layout movement. Ordinary structural anchors keep
  // the existing delta ownership rule so a concurrent reader/programmatic travel still wins.
  const anchorCorrectionRequiresIntentRef = useRef(mountAnchorRef.current != null);
  const preserveAnchorRef = useRef(preserveAnchor);
  preserveAnchorRef.current = preserveAnchor;
  const anchorRecoveryPendingRef = useRef(anchorRecoveryPending);
  anchorRecoveryPendingRef.current = anchorRecoveryPending;
  const initialAnchorAppliedRef = useRef(mountAnchorRef.current == null);
  const onVisibleAnchorChangeRef = useRef(onVisibleAnchorChange);
  onVisibleAnchorChangeRef.current = onVisibleAnchorChange;
  const onAnchorLostRef = useRef(onAnchorLost);
  onAnchorLostRef.current = onAnchorLost;
  const onRevealHandledRef = useRef(onRevealHandled);
  onRevealHandledRef.current = onRevealHandled;
  const clearAnchorFrameRef = useRef<number | null>(null);
  const widthAnchorFrameRef = useRef<number | null>(null);
  const widthAnchorRef = useRef<VirtualScrollAnchor | null>(null);
  const anchorCorrectionScrollTopRef = useRef<number | null>(null);
  const anchorCorrectionIntentVersionRef = useRef<number | null>(null);
  const viewportIntentVersionRef = useRef(0);
  const lostAnchorFrameRef = useRef<number | null>(null);
  const revealFrameRef = useRef<number | null>(null);
  const handledRevealRef = useRef<{ key: string; requestId: number } | null>(null);
  const pendingRevealOutcomeRef = useRef<number | null>(null);
  const previousItemsVersionRef = useRef(itemsVersion);
  if (preserveAnchor && (previousItemsRef.current !== items || previousItemsVersionRef.current !== itemsVersion) &&
      pendingAnchorRef.current == null && lostAnchorRef.current == null) {
    pendingAnchorRef.current = visibleAnchorRef.current;
    anchorCorrectionRequiresIntentRef.current = false;
  }
  if (!preserveAnchor && pendingAnchorRef.current != null) {
    pendingAnchorRef.current = null;
    anchorCorrectionRequiresIntentRef.current = false;
    initialAnchorAppliedRef.current = true;
  }
  const keyIndexRef = useRef<{
    items: readonly T[];
    version: number;
    getKey: (item: T) => string;
    length: number;
    map: Map<string, number>;
    keys: string[];
  } | null>(null);
  let keyIndex = keyIndexRef.current;
  if (!keyIndex || keyIndex.items !== items || keyIndex.getKey !== getKey || items.length < keyIndex.length) {
    const map = new Map<string, number>();
    const keys = items.map((item, index) => {
      const key = getKey(item);
      map.set(key, index);
      return key;
    });
    keyIndex = { items, version: itemsVersion, getKey, length: items.length, map, keys };
    keyIndexRef.current = keyIndex;
  } else if (keyIndex.version !== itemsVersion) {
    const start = Math.max(0, Math.min(itemsDirtyFrom, keyIndex.length, items.length));
    for (let index = start; index < keyIndex.length; index += 1) {
      keyIndex.map.delete(keyIndex.keys[index]!);
    }
    keyIndex.keys.length = start;
    for (let index = start; index < items.length; index += 1) {
      const key = getKey(items[index]!);
      keyIndex.map.set(key, index);
      keyIndex.keys[index] = key;
    }
    keyIndex.version = itemsVersion;
    keyIndex.length = items.length;
  }
  const indexByKey = keyIndex.map;
  const revealKey = revealRequest?.key ?? null;
  const revealRequestId = revealRequest?.requestId ?? null;
  const revealAlign = revealRequest?.align ?? "center";
  const revealFocus = revealRequest?.focus ?? true;
  const locationKey = revealKey ?? revealedLocationKey;
  const missing = pendingAnchorRef.current;
  if (missing) {
    const currentIndex = indexByKey.get(missing.key);
    if (currentIndex != null) {
      if (missing.index !== currentIndex) pendingAnchorRef.current = { ...missing, index: currentIndex };
    } else {
      // A reconnect can mount from an incomplete cache before the history effect starts. Never
      // bind the saved ordinal to a transient row in that render; give the original key at least
      // one frame, then wait for authoritative history before choosing a surviving neighbour.
      if (lostAnchorRef.current == null) {
        lostAnchorRef.current = missing;
        lostAnchorIsMountRestoreRef.current = anchorCorrectionRequiresIntentRef.current;
        lostAnchorIntentVersionRef.current = viewportIntentVersionRef.current;
      }
      pendingAnchorRef.current = null;
      initialAnchorAppliedRef.current = true;
    }
  }
  const pendingAnchorKey = pendingAnchorRef.current?.key ?? null;
  const pinned = useMemo(() => {
    const next: number[] = [];
    const focused = focusedKey == null ? undefined : indexByKey.get(focusedKey);
    const dragged = draggedKey == null ? undefined : indexByKey.get(draggedKey);
    const anchor = pendingAnchorKey == null ? undefined : indexByKey.get(pendingAnchorKey);
    const explicit = pinnedKey == null ? undefined : indexByKey.get(pinnedKey);
    const navigationTarget = revealPinnedKey == null ? undefined : indexByKey.get(revealPinnedKey);
    if (focused != null) next.push(focused);
    if (dragged != null && dragged !== focused) next.push(dragged);
    if (anchor != null && anchor !== focused && anchor !== dragged) next.push(anchor);
    if (explicit != null && !next.includes(explicit)) next.push(explicit);
    if (navigationTarget != null && !next.includes(navigationTarget)) next.push(navigationTarget);
    return next;
  }, [focusedKey, draggedKey, pendingAnchorKey, pinnedKey, revealPinnedKey, indexByKey, itemsVersion]);
  const rangeExtractor = useCallback((range: Range) => pinnedRangeExtractor(range, pinned), [pinned]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => getKey(items[index]!),
    estimateSize: (index) => estimateSize(items[index]!, index) + rowGap,
    overscan,
    rangeExtractor,
    scrollMargin,
    initialRect: { width: 800, height: 600 },
    useAnimationFrameWithResizeObserver: true,
  });
  const initialMeasurementVirtualizerRef = useRef(virtualizer);
  initialMeasurementVirtualizerRef.current = virtualizer;
  // Our logical-key anchor correction owns structural/width changes while pending. Otherwise,
  // retain TanStack's positional rule: only measurements above the viewport may compensate the
  // scroll offset. Returning true for a late below-viewport resize moves paused readers.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    shouldAdjustVirtualScrollForResize({
      itemStart: item.start,
      scrollOffset: instance.scrollOffset ?? 0,
      // TanStack uses this private accumulator in its own default predicate. Reading it preserves
      // the same multi-row batch semantics until the library exposes a public accessor.
      scrollAdjustments: (instance as unknown as { scrollAdjustments: number }).scrollAdjustments ?? 0,
      measured: instance.itemSizeCache.has(item.key),
      scrollDirection: instance.scrollDirection,
      anchorPending: pendingAnchorRef.current != null,
    });

  useEffect(() => {
    const root = rootRef.current;
    const scroll = scrollRef.current;
    if (!root || !scroll) return;

    let cancelPendingCommit: CancelVirtualMeasurementCommit | null = null;
    let widthObserver: ResizeObserver | null = null;
    const seedMountedRows = () => {
      const width = Math.round(scroll.getBoundingClientRect().width);
      if (width <= 0) return false;
      // The first real viewport width owns every cached size. Capture it before the passive
      // observer setup, invalidate estimate-backed geometry, and synchronously restore mounted DOM
      // heights. Dependent absolute rows stay hidden until the render using that cache commits.
      viewportWidthRef.current = width;
      reseedMountedVirtualRows(root, initialMeasurementVirtualizerRef.current);
      setInitialMeasurementsReady(true);
      return true;
    };
    const scheduleSeed = (observerDelivery: boolean) => {
      const seed = () => {
        cancelPendingCommit = null;
        seedMountedRows();
      };
      if (deferInitialMeasurements || observerDelivery) {
        cancelPendingCommit?.();
        cancelPendingCommit = commitVirtualMeasurements(seed) ?? null;
      } else {
        seed();
      }
    };

    if (Math.round(scroll.getBoundingClientRect().width) > 0) {
      scheduleSeed(false);
    } else {
      // A virtual surface can mount inside a temporarily collapsed panel. A zero-width layout
      // cannot produce trustworthy wrapped heights, so keep it unpainted until its first real
      // ResizeObserver delivery can seed and reveal it in the same pre-paint commit.
      widthObserver = new ResizeObserver(() => {
        if (Math.round(scroll.getBoundingClientRect().width) <= 0) return;
        widthObserver?.disconnect();
        widthObserver = null;
        scheduleSeed(true);
      });
      widthObserver.observe(scroll);
    }

    return () => {
      cancelPendingCommit?.();
      widthObserver?.disconnect();
    };
  }, [commitVirtualMeasurements, deferInitialMeasurements, scrollRef]);

  // TanStack delivers its row ResizeObserver measurements through an animation frame, so they
  // land after the browser has already painted the resized row against its neighbours' old
  // offsets. A row growing mid-list without a width change — a streaming tool row, late-loading
  // content — therefore paints one frame of overlapping text per change, and continuous updates
  // read as transcript flashing. Observe the mounted rows here and commit their measurements in
  // the same pre-paint ResizeObserver phase; TanStack's deferred delivery then finds no delta.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let cancelPendingCommit: CancelVirtualMeasurementCommit | null = null;
    // Keyed by element so a fault-injected deferred commit merges later deliveries instead of
    // dropping them, and so row indexes are resolved at commit time rather than delivery time.
    const pendingSizes = new Map<HTMLElement, number>();
    const commitPendingSizes = () => {
      cancelPendingCommit = null;
      // A scroller width change means these row sizes are a rewrap, not content growth. That
      // delivery is owned by the width epoch: its reseed re-reads every mounted row after the
      // logical anchor has been captured, while committing here first would apply TanStack's raw
      // scroll compensation before anchor preservation engages and drag the anchored row.
      const scroll = scrollRef.current;
      if (!scroll || viewportWidthRef.current !== Math.round(scroll.getBoundingClientRect().width)) {
        pendingSizes.clear();
        return;
      }
      const virtualizer = initialMeasurementVirtualizerRef.current;
      // TanStack's own delivery skips measurements while `isScrolling`, but a logical-anchor
      // correction raises that flag too, and skipping a mounted row whose content just changed
      // paints it over its neighbours for every frame until the flag resets. A pure scroll never
      // resizes a row, so committing every delivery only affects frames that must repaint anyway;
      // scroll compensation policy stays with `shouldAdjustScrollPositionOnItemSizeChange`.
      for (const [row, size] of pendingSizes) {
        if (!row.isConnected) continue;
        const index = Number(row.dataset.index);
        if (!Number.isSafeInteger(index)) continue;
        virtualizer.resizeItem(index, size);
      }
      pendingSizes.clear();
    };
    const observer = new ResizeObserver((entries) => {
      if (!initialMeasurementsReadyRef.current) return;
      for (const entry of entries) {
        const row = entry.target;
        if (!(row instanceof HTMLElement) || !row.isConnected) continue;
        const box = entry.borderBoxSize?.[0];
        pendingSizes.set(row, box ? Math.round(box.blockSize) : row.offsetHeight);
      }
      if (pendingSizes.size === 0) return;
      cancelPendingCommit?.();
      cancelPendingCommit = commitVirtualMeasurements(commitPendingSizes) ?? null;
    });
    for (const row of root.querySelectorAll<HTMLElement>("[data-virtual-row]")) {
      observer.observe(row, { box: "border-box" });
    }
    const isRow = (node: Node): node is HTMLElement =>
      node instanceof HTMLElement && node.dataset.virtualRow != null;
    const MutationObserverConstructor = root.ownerDocument.defaultView?.MutationObserver;
    const mutationObserver = MutationObserverConstructor ? new MutationObserverConstructor((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (isRow(node)) observer.observe(node, { box: "border-box" });
        for (const node of record.removedNodes) if (isRow(node)) observer.unobserve(node);
      }
    }) : null;
    mutationObserver?.observe(root, { childList: true });
    return () => {
      cancelPendingCommit?.();
      mutationObserver?.disconnect();
      observer.disconnect();
    };
  }, [commitVirtualMeasurements, scrollRef]);

  useLayoutEffect(() => {
    if (!initialMeasurementsReady) return;
    if (revealKey == null || revealRequestId == null) {
      pendingRevealOutcomeRef.current = null;
      handledRevealRef.current = null;
      if (revealFrameRef.current != null) cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
      setRevealPinnedKey(null);
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.key === revealKey && handled.requestId === revealRequestId) return;
    if (revealFrameRef.current != null) cancelAnimationFrame(revealFrameRef.current);
    revealFrameRef.current = null;
    setRevealPinnedKey(null);
    const index = indexByKey.get(revealKey);
    if (index == null) {
      handledRevealRef.current = { key: revealKey, requestId: revealRequestId };
      pendingRevealOutcomeRef.current = null;
      onRevealHandledRef.current?.(revealRequestId, "unresolved");
      return;
    }

    // Explicit navigation owns the viewport. A saved reader anchor must not pull the requested row
    // back out of view on the next streamed measurement.
    if (clearAnchorFrameRef.current != null) cancelAnimationFrame(clearAnchorFrameRef.current);
    if (lostAnchorFrameRef.current != null) cancelAnimationFrame(lostAnchorFrameRef.current);
    clearAnchorFrameRef.current = null;
    lostAnchorFrameRef.current = null;
    pendingAnchorRef.current = null;
    anchorCorrectionRequiresIntentRef.current = false;
    if (widthAnchorFrameRef.current != null) cancelAnimationFrame(widthAnchorFrameRef.current);
    widthAnchorFrameRef.current = null;
    widthAnchorRef.current = null;
    lostAnchorRef.current = null;
    lostAnchorIsMountRestoreRef.current = false;
    lostAnchorIntentVersionRef.current = null;
    rekeyedAnchorRef.current = null;
    anchorCorrectionScrollTopRef.current = null;
    anchorCorrectionIntentVersionRef.current = null;

    handledRevealRef.current = { key: revealKey, requestId: revealRequestId };
    pendingRevealOutcomeRef.current = revealRequestId;
    setRevealPinnedKey(revealKey);
    const align = revealAlign;
    virtualizer.scrollToIndex(index, { align, behavior: "auto" });

    let framesRemaining = 8;
    let focusApplied = false;
    let resultReported = false;
    const settle = () => {
      revealFrameRef.current = null;
      const root = rootRef.current;
      const currentScroll = scrollRef.current;
      if (!root || !currentScroll) return;
      const row = [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .find((candidate) => candidate.dataset.virtualKey === revealKey);
      if (row) {
        const rowRect = row.getBoundingClientRect();
        const viewport = currentScroll.getBoundingClientRect();
        const adjustment = virtualTargetScrollAdjustment({
          align,
          rowStart: rowRect.top,
          rowEnd: rowRect.bottom,
          viewportStart: viewport.top,
          viewportEnd: viewport.bottom,
        });
        if (Math.abs(adjustment) >= 0.5) currentScroll.scrollTop += adjustment;
        if (!focusApplied && revealFocus) {
          row.focus({ preventScroll: true });
          focusApplied = true;
        }
        if (!resultReported) {
          resultReported = true;
          pendingRevealOutcomeRef.current = null;
          setRevealedLocationKey(revealKey);
          onRevealHandled?.(revealRequestId, "revealed");
        }
      }
      framesRemaining -= 1;
      if (framesRemaining > 0) revealFrameRef.current = requestAnimationFrame(settle);
      else {
        setRevealPinnedKey((current) => current === revealKey ? null : current);
        if (!resultReported) {
          pendingRevealOutcomeRef.current = null;
          onRevealHandled?.(revealRequestId, "unresolved");
        }
      }
    };
    revealFrameRef.current = requestAnimationFrame(settle);
  }, [indexByKey, initialMeasurementsReady, items.length, itemsVersion, onRevealHandled, revealAlign, revealFocus, revealKey, revealRequestId, scrollRef, virtualizer]);

  useEffect(() => {
    if (revealedLocationKey != null && !indexByKey.has(revealedLocationKey)) setRevealedLocationKey(null);
  }, [indexByKey, revealedLocationKey]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const cancelRevealSettle = () => {
      if (revealFrameRef.current != null) cancelAnimationFrame(revealFrameRef.current);
      revealFrameRef.current = null;
      setRevealPinnedKey(null);
      const pendingRequestId = pendingRevealOutcomeRef.current;
      pendingRevealOutcomeRef.current = null;
      if (pendingRequestId != null) onRevealHandledRef.current?.(pendingRequestId, "cancelled");
    };
    scroll.addEventListener("wheel", cancelRevealSettle, { passive: true });
    scroll.addEventListener("pointerdown", cancelRevealSettle, { passive: true });
    scroll.addEventListener("touchstart", cancelRevealSettle, { passive: true });
    scroll.addEventListener("keydown", cancelRevealSettle);
    return () => {
      scroll.removeEventListener("wheel", cancelRevealSettle);
      scroll.removeEventListener("pointerdown", cancelRevealSettle);
      scroll.removeEventListener("touchstart", cancelRevealSettle);
      scroll.removeEventListener("keydown", cancelRevealSettle);
    };
  }, [scrollRef]);

  useEffect(() => {
    const root = rootRef.current;
    const scroll = scrollRef.current;
    if (!root || !scroll) return;
    const cancelWidthAnchor = () => {
      widthAnchorRef.current = null;
      if (widthAnchorFrameRef.current != null) cancelAnimationFrame(widthAnchorFrameRef.current);
      widthAnchorFrameRef.current = null;
    };
    const correctWidthAnchor = () => {
      const anchor = widthAnchorRef.current;
      const row = anchor
        ? [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
          .find((candidate) => candidate.dataset.virtualKey === anchor.key)
        : null;
      if (!anchor || !row) return;
      const adjustment = scrollAnchorAdjustment(
        anchor.offset,
        row.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
      );
      if (Math.abs(adjustment) >= 0.5) scroll.scrollTop += adjustment;
      // The generic bounded anchor window treats any scrollTop change after its last correction
      // as reader intent. Record this companion correction so our own width settle does not make
      // that owner relinquish the same logical anchor early.
      if (anchorCorrectionScrollTopRef.current != null) {
        anchorCorrectionScrollTopRef.current = scroll.scrollTop;
        anchorCorrectionIntentVersionRef.current = viewportIntentVersionRef.current;
      }
    };
    const settleWidthAnchor = (correctionFrames: number) => {
      if (widthAnchorFrameRef.current != null) cancelAnimationFrame(widthAnchorFrameRef.current);
      widthAnchorFrameRef.current = requestAnimationFrame(() => {
        widthAnchorFrameRef.current = null;
        if (!widthAnchorRef.current) {
          widthAnchorRef.current = null;
          return;
        }
        correctWidthAnchor();
        if (correctionFrames > 1) settleWidthAnchor(correctionFrames - 1);
        else widthAnchorRef.current = null;
      });
    };
    const update = (synchronous: boolean) => {
      const rootRect = root.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const captureAnchor = (): VirtualScrollAnchor | null => {
        const row = [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
          .find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.bottom > scrollRect.top && rect.top < scrollRect.bottom;
          });
        return row?.dataset.virtualKey
          ? {
            key: row.dataset.virtualKey,
            offset: row.getBoundingClientRect().top - scrollRect.top,
            index: Number(row.dataset.index),
          }
          : null;
      };
      const next = rootRect.top - scrollRect.top + scroll.scrollTop;
      const marginChanged = Math.abs(scrollMarginRef.current - next) >= 0.5;
      const width = Math.round(scrollRect.width);
      const widthChanged = viewportWidthRef.current !== 0 && viewportWidthRef.current !== width;
      if (initialMeasurementsReadyRef.current && (marginChanged || widthChanged)) {
        if (preserveAnchorRef.current) {
          if (pendingAnchorRef.current == null && lostAnchorRef.current == null) {
            pendingAnchorRef.current = visibleAnchorRef.current ?? captureAnchor();
            anchorCorrectionRequiresIntentRef.current = false;
          }
        }
      }
      if (marginChanged) {
        scrollMarginRef.current = next;
      }
      if (marginChanged || widthChanged) {
        // ResizeObserver delivers before paint. Commit every geometry field in one synchronous
        // render: width changes need a new measurement epoch, while a height-only notice above the
        // list can change only scrollMargin. Deferring either value would expose one painted frame
        // with row transforms from a stale coordinate system.
        const commit = () => {
          if (marginChanged) setScrollMargin(next);
          if (widthChanged) setMeasurementEpoch((epoch) => epoch + 1);
        };
        // This effect's initial setup is passive and therefore already outside the pre-paint
        // observer phase. A plain state update avoids React's lifecycle flushSync warning. Every
        // subsequent ResizeObserver/MutationObserver notification takes the synchronous path.
        if (synchronous) commitVirtualMeasurements(commit);
        else commit();
      }
      if (widthChanged && preserveAnchorRef.current) {
        // Preserve one baseline for the complete drag, even if the generic bounded measurement
        // anchor releases between delivered widths. Restarting this short post-width settle window
        // restores the exact row after the final wrapped-height cascade. Explicit reader input
        // cancels it through the intent listeners below. Follow-tail explicitly disables anchor
        // preservation, so it remains the sole owner of the viewport while following live output.
        widthAnchorRef.current ??= pendingAnchorRef.current ?? visibleAnchorRef.current ?? captureAnchor();
        if (widthAnchorRef.current) {
          // ResizeObserver delivery is already pre-paint. Correct the committed DOM immediately so
          // a slow frame cannot expose the final width with an old logical offset, then retain the
          // bounded rAF window for later virtualizer/row measurement deliveries.
          correctWidthAnchor();
          settleWidthAnchor(8);
        }
      }
      viewportWidthRef.current = width;
    };
    update(false);
    const recordVisibleAnchor = () => {
      if (!initialMeasurementsReadyRef.current || pendingAnchorRef.current != null) return;
      const lostIntent = lostAnchorIntentVersionRef.current;
      if (lostAnchorRef.current != null &&
          (lostIntent == null || lostIntent === viewportIntentVersionRef.current)) return;
      const viewport = scroll.getBoundingClientRect();
      const row = [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
        .find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      if (row?.dataset.virtualKey) {
        const anchor = {
          key: row.dataset.virtualKey,
          offset: row.getBoundingClientRect().top - viewport.top,
          index: Number(row.dataset.index),
        };
        visibleAnchorRef.current = anchor;
        onVisibleAnchorChangeRef.current?.(anchor);
      }
    };
    recordVisibleAnchor();
    scroll.addEventListener("scroll", recordVisibleAnchor, { passive: true });
    const observer = new ResizeObserver(() => update(true));
    observer.observe(root);
    observer.observe(scroll);
    const observedPredecessors = new Set<Element>();
    const reconcilePredecessors = () => {
      const nextPredecessors = new Set<Element>();
      for (let sibling = root.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        nextPredecessors.add(sibling);
        if (!observedPredecessors.has(sibling)) observer.observe(sibling);
      }
      for (const previous of observedPredecessors) {
        if (!nextPredecessors.has(previous)) observer.unobserve(previous);
      }
      observedPredecessors.clear();
      for (const predecessor of nextPredecessors) observedPredecessors.add(predecessor);
    };
    reconcilePredecessors();
    // A preceding notice can mount, unmount, or reorder without changing the root or viewport
    // border box. Reconcile the exact current sibling chain on child-list mutations, then measure
    // the new root offset in the same pre-paint microtask. Set membership prevents duplicate
    // observations, and removed predecessors are explicitly unobserved.
    const MutationObserverConstructor = root.ownerDocument.defaultView?.MutationObserver;
    const mutationObserver = MutationObserverConstructor ? new MutationObserverConstructor(() => {
      reconcilePredecessors();
      // Mutation delivery runs after the React commit stack in the browser's pre-paint microtask
      // checkpoint. Commit synchronously here so a newly inserted or removed predecessor cannot
      // paint once with a stale scroll margin.
      update(true);
    }) : null;
    if (root.parentElement) mutationObserver?.observe(root.parentElement, { childList: true });
    const markViewportIntent = () => {
      viewportIntentVersionRef.current += 1;
      cancelWidthAnchor();
    };
    const markKeyboardViewportIntent = (event: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      markViewportIntent();
    };
    const markProgrammaticViewportIntent = () => {
      markViewportIntent();
      // Session Reading and Inbox paging claim ownership immediately before calling scrollBy or
      // scrollTo. Sample once after that synchronous call returns: native scroll delivery is not
      // guaranteed before a following session-selection task unmounts this surface.
      queueMicrotask(() => {
        if (scrollRef.current === scroll) recordVisibleAnchor();
      });
    };
    scroll.addEventListener("wheel", markViewportIntent, { passive: true });
    scroll.addEventListener("pointerdown", markViewportIntent, { passive: true });
    scroll.addEventListener("touchstart", markViewportIntent, { passive: true });
    scroll.addEventListener("keydown", markKeyboardViewportIntent);
    scroll.addEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markProgrammaticViewportIntent);
    return () => {
      mutationObserver?.disconnect();
      observer.disconnect();
      observedPredecessors.clear();
      cancelWidthAnchor();
      scroll.removeEventListener("scroll", recordVisibleAnchor);
      scroll.removeEventListener("wheel", markViewportIntent);
      scroll.removeEventListener("pointerdown", markViewportIntent);
      scroll.removeEventListener("touchstart", markViewportIntent);
      scroll.removeEventListener("keydown", markKeyboardViewportIntent);
      scroll.removeEventListener(VIRTUAL_VIEWPORT_INTENT_EVENT, markProgrammaticViewportIntent);
    };
  }, [commitVirtualMeasurements, scrollRef]);

  useLayoutEffect(() => {
    if (measurementEpoch <= 0) return;
    // `measure()` invalidates offscreen widths, but it also clears the mounted rows' size cache.
    // Rebuild the estimate-backed measurements before restoring the actual mounted sizes. Calling
    // `measureElement` immediately is insufficient: when the row ResizeObserver ran first, its
    // freshly measured size still lives in `measurementsCache`; TanStack sees a zero delta and does
    // not put that size back into the cache that `measure()` just cleared. The following render then
    // positions every row from estimates and wrapped messages overlap. Re-seeding through
    // `resizeItem` after the synchronous rebuild preserves the measured rows before paint while
    // leaving offscreen rows invalidated for measurement at their new width.
    reseedMountedVirtualRows(rootRef.current, virtualizer);
  }, [measurementEpoch, virtualizer]);

  useEffect(() => {
    if (!draggedKey) return;
    const clear = () => setDraggedKey(null);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
    };
  }, [draggedKey]);

  useLayoutEffect(() => {
    if (!initialMeasurementsReady) return;
    const root = rootRef.current;
    const scroll = scrollRef.current;
    if (!root || !scroll) return;

    const viewport = scroll.getBoundingClientRect();
    const findRow = (key: string) => [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((row) => row.dataset.virtualKey === key);
    let pending = pendingAnchorRef.current;
    const correctionScrollTop = anchorCorrectionScrollTopRef.current;
    const correctionIntentVersion = anchorCorrectionIntentVersionRef.current;
    const correctionRelinquished = !anchorCorrectionRequiresIntentRef.current ||
      (correctionIntentVersion != null && correctionIntentVersion !== viewportIntentVersionRef.current);
    if (pending && correctionScrollTop != null && correctionRelinquished &&
        Math.abs(scroll.scrollTop - correctionScrollTop) > 0.5) {
      // A smooth scroll can cause a virtualizer render before the next settle callback. Apply the
      // same ownership rule before this layout correction so that render cannot hide the movement.
      pendingAnchorRef.current = null;
      pending = null;
      anchorCorrectionRequiresIntentRef.current = false;
      rekeyedAnchorRef.current = null;
      anchorCorrectionScrollTopRef.current = null;
      anchorCorrectionIntentVersionRef.current = null;
      if (clearAnchorFrameRef.current != null) cancelAnimationFrame(clearAnchorFrameRef.current);
      clearAnchorFrameRef.current = null;
    }
    if (pending) {
      const row = findRow(pending.key);
      if (row) {
        const adjustment = scrollAnchorAdjustment(
          pending.offset,
          row.getBoundingClientRect().top - viewport.top,
        );
        if (Math.abs(adjustment) >= 0.5) scroll.scrollTop += adjustment;
        anchorCorrectionScrollTopRef.current = scroll.scrollTop;
        anchorCorrectionIntentVersionRef.current = viewportIntentVersionRef.current;
        initialAnchorAppliedRef.current = true;
      }
    }

    const correctedViewport = scroll.getBoundingClientRect();
    const firstVisible = [...root.querySelectorAll<HTMLElement>("[data-virtual-row]")]
      .find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > correctedViewport.top && rect.top < correctedViewport.bottom;
      });
    if (firstVisible?.dataset.virtualKey) {
      const anchor = {
        key: firstVisible.dataset.virtualKey,
        offset: firstVisible.getBoundingClientRect().top - correctedViewport.top,
        index: Number(firstVisible.dataset.index),
      };
      visibleAnchorRef.current = anchor;
      const lostIntent = lostAnchorIntentVersionRef.current;
      const waitingForLostAnchor = lostAnchorRef.current != null &&
        (lostIntent == null || lostIntent === viewportIntentVersionRef.current);
      if (!pending && !waitingForLostAnchor) onVisibleAnchorChangeRef.current?.(anchor);
    }
    const rekeyed = rekeyedAnchorRef.current;
    if (pending && rekeyed?.key === pending.key) {
      rekeyedAnchorRef.current = null;
      visibleAnchorRef.current = pending;
      onVisibleAnchorChangeRef.current?.(pending);
    }
    previousItemsRef.current = items;
    previousItemsVersionRef.current = itemsVersion;

    // ResizeObserver-backed measurements may land in the following frame. Keep the old logical
    // row pinned until those corrections have rendered, then allow the normal viewport range to
    // take ownership again. Do not restart this window on every streaming render: a continuously
    // changing tail must never keep an old anchor alive long enough to fight a user's scroll.
    if (pending && initialAnchorAppliedRef.current && clearAnchorFrameRef.current == null) {
      const clearAfterMeasurements = (frames: number) => {
        clearAnchorFrameRef.current = requestAnimationFrame(() => {
          const current = pendingAnchorRef.current;
          const currentRoot = rootRef.current;
          const currentScroll = scrollRef.current;
          const currentRow = current && currentRoot
            ? [...currentRoot.querySelectorAll<HTMLElement>("[data-virtual-row]")]
              .find((row) => row.dataset.virtualKey === current.key)
            : null;
          if (!current || !currentScroll) {
            anchorCorrectionRequiresIntentRef.current = false;
            clearAnchorFrameRef.current = null;
            anchorCorrectionScrollTopRef.current = null;
            anchorCorrectionIntentVersionRef.current = null;
            return;
          }
          const correctionScrollTop = anchorCorrectionScrollTopRef.current;
          const correctionIntentVersion = anchorCorrectionIntentVersionRef.current;
          const correctionRelinquished = !anchorCorrectionRequiresIntentRef.current ||
            (correctionIntentVersion != null && correctionIntentVersion !== viewportIntentVersionRef.current);
          if (correctionScrollTop != null && correctionRelinquished &&
              Math.abs(currentScroll.scrollTop - correctionScrollTop) > 0.5) {
            // A reader, assistive technology, or programmatic paging operation moved the viewport
            // after our last correction. Relinquish the old anchor instead of snapping it back.
            pendingAnchorRef.current = null;
            anchorCorrectionRequiresIntentRef.current = false;
            clearAnchorFrameRef.current = null;
            anchorCorrectionScrollTopRef.current = null;
            anchorCorrectionIntentVersionRef.current = null;
            rekeyedAnchorRef.current = null;
            const viewport = currentScroll.getBoundingClientRect();
            const adoptedRow = currentRoot
              ? [...currentRoot.querySelectorAll<HTMLElement>("[data-virtual-row]")]
                .find((row) => {
                  const rect = row.getBoundingClientRect();
                  return rect.bottom > viewport.top && rect.top < viewport.bottom;
                })
              : null;
            if (adoptedRow?.dataset.virtualKey) {
              const adopted = {
                key: adoptedRow.dataset.virtualKey,
                offset: adoptedRow.getBoundingClientRect().top - viewport.top,
                index: Number(adoptedRow.dataset.index),
              };
              visibleAnchorRef.current = adopted;
              onVisibleAnchorChangeRef.current?.(adopted);
            }
            return;
          }
          if (currentRow) {
            const adjustment = scrollAnchorAdjustment(
              current.offset,
              currentRow.getBoundingClientRect().top - currentScroll.getBoundingClientRect().top,
            );
            if (Math.abs(adjustment) >= 0.5) currentScroll.scrollTop += adjustment;
          }
          anchorCorrectionScrollTopRef.current = currentScroll.scrollTop;
          anchorCorrectionIntentVersionRef.current = viewportIntentVersionRef.current;
          if (frames > 1) clearAfterMeasurements(frames - 1);
          else {
            pendingAnchorRef.current = null;
            anchorCorrectionRequiresIntentRef.current = false;
            clearAnchorFrameRef.current = null;
            anchorCorrectionScrollTopRef.current = null;
            anchorCorrectionIntentVersionRef.current = null;
          }
        });
      };
      // A width invalidation can produce several ResizeObserver/virtualizer renders. Keep the
      // logical row pinned through that bounded cascade, then release it before a stream can
      // contend with deliberate user scrolling.
      clearAfterMeasurements(8);
    }
  });

  useLayoutEffect(() => {
    const lost = lostAnchorRef.current;
    if (!lost || lostAnchorFrameRef.current != null) return;
    // A key can disappear for one render while a streaming projection rewrites duplicate tool ids.
    // Confirm on the next frame before treating the logical row as genuinely gone.
    lostAnchorFrameRef.current = requestAnimationFrame(() => {
      lostAnchorFrameRef.current = null;
      const candidate = lostAnchorRef.current;
      if (!candidate) return;
      const mountRestore = lostAnchorIsMountRestoreRef.current;
      const intentAtLoss = lostAnchorIntentVersionRef.current;
      if (mountRestore && intentAtLoss != null && intentAtLoss !== viewportIntentVersionRef.current) {
        lostAnchorRef.current = null;
        lostAnchorIsMountRestoreRef.current = false;
        lostAnchorIntentVersionRef.current = null;
        anchorCorrectionRequiresIntentRef.current = false;
        anchorCorrectionScrollTopRef.current = null;
        anchorCorrectionIntentVersionRef.current = null;
        const adopted = visibleAnchorRef.current;
        if (adopted) onVisibleAnchorChangeRef.current?.(adopted);
        return;
      }
      const currentIndex = keyIndexRef.current?.map.get(candidate.key);
      if (currentIndex != null) {
        lostAnchorRef.current = null;
        lostAnchorIsMountRestoreRef.current = false;
        lostAnchorIntentVersionRef.current = null;
        anchorCorrectionRequiresIntentRef.current = mountRestore;
        anchorCorrectionScrollTopRef.current = null;
        anchorCorrectionIntentVersionRef.current = null;
        pendingAnchorRef.current = { ...candidate, index: currentIndex };
        forceAnchorRetry((epoch) => epoch + 1);
        return;
      }
      if (mountRestore && anchorRecoveryPendingRef.current) return;
      const replacement = reanchorAtLogicalIndex(
        candidate,
        keyIndexRef.current?.keys ?? [],
        mountRestore,
      );
      if (replacement) {
        lostAnchorRef.current = null;
        lostAnchorIsMountRestoreRef.current = false;
        lostAnchorIntentVersionRef.current = null;
        anchorCorrectionRequiresIntentRef.current = mountRestore;
        anchorCorrectionScrollTopRef.current = null;
        anchorCorrectionIntentVersionRef.current = null;
        pendingAnchorRef.current = replacement;
        rekeyedAnchorRef.current = replacement;
        forceAnchorRetry((epoch) => epoch + 1);
        return;
      }
      lostAnchorRef.current = null;
      lostAnchorIsMountRestoreRef.current = false;
      lostAnchorIntentVersionRef.current = null;
      anchorCorrectionRequiresIntentRef.current = false;
      onAnchorLostRef.current?.(candidate);
    });
  });

  useEffect(() => () => {
    if (clearAnchorFrameRef.current != null) cancelAnimationFrame(clearAnchorFrameRef.current);
    if (widthAnchorFrameRef.current != null) cancelAnimationFrame(widthAnchorFrameRef.current);
    if (lostAnchorFrameRef.current != null) cancelAnimationFrame(lostAnchorFrameRef.current);
    if (revealFrameRef.current != null) cancelAnimationFrame(revealFrameRef.current);
    pendingAnchorRef.current = null;
    anchorCorrectionRequiresIntentRef.current = false;
    clearAnchorFrameRef.current = null;
    widthAnchorFrameRef.current = null;
    widthAnchorRef.current = null;
    lostAnchorFrameRef.current = null;
    revealFrameRef.current = null;
    anchorCorrectionScrollTopRef.current = null;
    anchorCorrectionIntentVersionRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (preserveAnchor) return;
    if (clearAnchorFrameRef.current != null) cancelAnimationFrame(clearAnchorFrameRef.current);
    if (widthAnchorFrameRef.current != null) cancelAnimationFrame(widthAnchorFrameRef.current);
    if (lostAnchorFrameRef.current != null) cancelAnimationFrame(lostAnchorFrameRef.current);
    clearAnchorFrameRef.current = null;
    widthAnchorFrameRef.current = null;
    widthAnchorRef.current = null;
    lostAnchorFrameRef.current = null;
    pendingAnchorRef.current = null;
    anchorCorrectionRequiresIntentRef.current = false;
    lostAnchorRef.current = null;
    lostAnchorIsMountRestoreRef.current = false;
    lostAnchorIntentVersionRef.current = null;
    rekeyedAnchorRef.current = null;
    anchorCorrectionScrollTopRef.current = null;
    anchorCorrectionIntentVersionRef.current = null;
  }, [preserveAnchor]);

  const keyFromTarget = (target: EventTarget | null): string | null =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-virtual-key]")?.dataset.virtualKey ?? null
      : null;
  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => setFocusedKey(keyFromTarget(event.target));
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const next = keyFromTarget(event.relatedTarget);
    setFocusedKey(next && rootRef.current?.contains(event.relatedTarget as Node) ? next : null);
  };

  const totalHeight = virtualizer.getTotalSize();
  initialTotalHeightRef.current ??= totalHeight;
  const renderedTotalHeight = initialMeasurementsReady ? totalHeight : initialTotalHeightRef.current;
  const visibleRange = virtualizer.range;
  return (
    <div
      ref={rootRef}
      className={className}
      role={rootRole}
      aria-label={ariaLabel}
      aria-busy={initialMeasurementsReady ? undefined : true}
      data-virtual-kind={dataKind}
      data-virtual-total={items.length}
      data-virtual-measurements={initialMeasurementsReady ? "ready" : "pending"}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      onDragStartCapture={pinDraggedRow ? (event) => setDraggedKey(keyFromTarget(event.target)) : undefined}
      onDragEndCapture={pinDraggedRow ? () => setDraggedKey(null) : undefined}
      style={{
        height: renderedTotalHeight,
        opacity: initialMeasurementsReady ? undefined : 0,
        pointerEvents: initialMeasurementsReady ? undefined : "none",
        position: "relative",
        width: "100%",
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const item = items[virtualRow.index]!;
        const visible = initialMeasurementsReady && visibleRange != null &&
          virtualRow.index >= visibleRange.startIndex && virtualRow.index <= visibleRange.endIndex;
        const style: CSSProperties = {
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          paddingBottom: rowGap || undefined,
          transform: `translateY(${virtualRow.start - scrollMargin}px)`,
        };
        return (
          <div
            key={virtualRow.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-virtual-row=""
            data-virtual-key={getKey(item)}
            data-virtual-target={locationKey === getKey(item) ? "true" : undefined}
            aria-current={locationKey === getKey(item) ? "location" : undefined}
            tabIndex={locationKey === getKey(item) ? -1 : undefined}
            className={rowClassName}
            role={rowRole}
            {...(rowRole === "listitem" ? { "aria-posinset": virtualRow.index + 1, "aria-setsize": items.length } : {})}
            style={style}
          >
            {renderItem(item, {
              index: virtualRow.index,
              visible,
              settledVisible: visible && !virtualizer.isScrolling,
            })}
          </div>
        );
      })}
    </div>
  );
}
