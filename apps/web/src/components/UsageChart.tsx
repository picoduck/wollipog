import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type { AgentDriverKind, UsageAggregationGranularity } from "@wollipog/protocol";
import {
  seriesClass,
  axisLabel,
  axisLabelIndexes,
  bucketLabel,
  formatMetric,
  niceScale,
  usageRestingSummary,
  type UsageColumn,
  type UsageMetric,
} from "../usage-view-model.js";

const DEFAULT_WIDTH = 960;
const VIEW_HEIGHT = 260;
const PLOT_TOP = 10;
const PLOT_BOTTOM = VIEW_HEIGHT - 28;
const PLOT_LEFT = 56;

/** The rendered width of the chart's box, so the viewBox matches it and text is never stretched. */
function useMeasuredWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observe = () => setWidth(Math.max(240, Math.round(element.getBoundingClientRect().width || DEFAULT_WIDTH)));
    observe();
    const observer = new ResizeObserver(observe);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
const MAX_COLUMN_WIDTH = 24;
/** The surface gap between stacked segments, and the least gap between neighbouring columns. */
const MARK_GAP = 2;
const CAP_RADIUS = 3;
/** A generous per-character width for the 12px axis labels, wide enough for CI's DejaVu Sans, and
 * the least space between two labels. Labels are spaced by estimate, never measured, so a narrow
 * chart thins them before they can touch. */
const AXIS_CHAR_WIDTH = 7.2;
const AXIS_LABEL_GAP = 12;
/** The narrowest band that still has room for its "Not Recorded" label. */
const UNRECORDED_LABEL_MIN_WIDTH = 96;
/** How long after a touch press a focus counts as that tap's, not the keyboard's. */
const TAP_FOCUS_MS = 1_000;

/**
 * A driver's 8px series swatch, for the driver list (the chart's only legend) and the readout. It
 * is an SVG fill like the chart's marks, not a CSS background: forced colors repaints backgrounds
 * but leaves SVG fills alone, so the legend keeps the colours that tell the bars apart.
 */
export function SeriesSwatch({ driver }: { driver: AgentDriverKind }) {
  return (
    <svg className={`usage-series-swatch ${seriesClass(driver)}`} viewBox="0 0 8 8" aria-hidden="true" focusable="false">
      <rect width="8" height="8" />
    </svg>
  );
}

/** A stacked segment: square at the baseline, and the topmost one carries the rounded data-end. */
function segmentPath(x: number, width: number, top: number, bottom: number, rounded: boolean): string {
  const height = Math.max(0, bottom - top);
  if (!rounded || height < CAP_RADIUS) return `M${x} ${top}h${width}v${height}h${-width}Z`;
  const r = Math.min(CAP_RADIUS, width / 2);
  return `M${x} ${bottom}v${-(height - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${width - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${height - r}Z`;
}

/**
 * The one column the readout describes, and what put it there. Only one input owns it at a time
 * and the latest wins: a fine pointer hovering, the keyboard focusing, or a touch tap selecting.
 * - `pointer`: entering a column takes it; leaving the chart hands it back to the focused column,
 *   if a column is focused, or clears it.
 * - `focus`: focusing a column takes it; blurring that column clears it.
 * - `tap`: tapping a column takes it; tapping the same column again, or anywhere outside the
 *   columns, clears it. A tap's own focus is not a keyboard focus and does not take it.
 * Escape clears it from any source.
 */
type ActiveColumn = { index: number; via: "pointer" | "focus" | "tap" } | null;

/** Consecutive runs of columns recorded before recording started, as [first, last] indexes. */
function unrecordedRuns(columns: readonly UsageColumn[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  columns.forEach((column, index) => {
    if (column.recorded) return;
    const run = runs.at(-1);
    if (run && run[1] === index - 1) run[1] = index;
    else runs.push([index, index]);
  });
  return runs;
}

/**
 * Driver-stacked columns for one usage window, one per bucket of the whole range. Every value here
 * is also in the period table beneath the chart, so the readout enhances and never gates. At rest
 * the readout gives the range's average and peak; a column's split replaces it in place while that
 * column is hovered, focused or tapped. The recorded columns are one roving-tabindex group: Tab
 * enters it once and the arrow keys, Home and End move within it, skipping the Not Recorded band.
 */
export function UsageChart({
  columns,
  metric,
  granularity,
  bounds,
  driverLabels,
  tableHint,
}: {
  columns: readonly UsageColumn[];
  metric: UsageMetric;
  granularity: UsageAggregationGranularity;
  bounds: { since: number; through: number };
  /** Each series' name on this page; ACP usage is named by its agent. */
  driverLabels: Readonly<Record<AgentDriverKind, string>>;
  /** Where the table twin is right now, for the accessible name: it moves with the breakdown. */
  tableHint: string;
}) {
  const [active, setActive] = useState<ActiveColumn>(null);
  const [rovingIndex, setRovingIndex] = useState<number | null>(null);
  const focusedIndex = useRef<number | null>(null);
  const lastTouchPress = useRef(Number.NEGATIVE_INFINITY);
  const hitTargets = useRef(new Map<number, SVGRectElement>());
  const labelId = useId();
  const [boxRef, viewWidth] = useMeasuredWidth<HTMLDivElement>();
  const PLOT_RIGHT = viewWidth - 8;
  const peak = Math.max(0, ...columns.map((column) => column.total));
  const scale = useMemo(() => niceScale(peak), [peak]);
  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const step = columns.length > 0 ? plotWidth / columns.length : plotWidth;
  // A slot too narrow for a 2px gap and a visible mark (a month of hours) gives the mark the whole
  // slot, so neighbouring hours read as one shape rather than hairlines.
  const columnWidth = step < 2 * MARK_GAP
    ? Math.max(1, step)
    : Math.max(1, Math.min(MAX_COLUMN_WIDTH, step * 0.7, step - MARK_GAP));
  const yFor = (value: number) => PLOT_BOTTOM - (value / scale.max) * plotHeight;
  const labelWidth = useMemo(
    () => AXIS_CHAR_WIDTH * Math.max(0, ...columns.map((column) => axisLabel(column.bucketTs, granularity).length)),
    [columns, granularity],
  );
  const labelIndexes = useMemo(() => {
    const limit = Math.max(2, Math.floor(plotWidth / (labelWidth + AXIS_LABEL_GAP)));
    // The last label ends at the plot's edge, so it reaches a whole label width left of it; the
    // previous label's centre must sit half a label and a gap further left again.
    const lastClearance = Math.ceil((1.5 * labelWidth + AXIS_LABEL_GAP) / step - 0.5);
    return new Set(axisLabelIndexes(columns.length, limit, lastClearance));
  }, [columns.length, labelWidth, plotWidth, step]);
  const recordedIndexes = useMemo(
    () => columns.flatMap((column, index) => (column.recorded ? [index] : [])),
    [columns],
  );
  const runs = useMemo(() => unrecordedRuns(columns), [columns]);
  const summary = useMemo(() => usageRestingSummary(columns, metric, granularity), [columns, metric, granularity]);
  const activeIndex = active !== null && columns[active.index]?.recorded ? active.index : null;
  const readout = activeIndex === null ? null : columns[activeIndex]!;
  const tabStop = rovingIndex !== null && columns[rovingIndex]?.recorded ? rovingIndex : recordedIndexes[0] ?? null;
  const metricLabel = metric === "cost" ? "cost" : "processed tokens";
  const periodLabel = granularity === "hour" ? "Hourly" : granularity === "week" ? "Weekly" : "Daily";
  const split = columns.some((column) => column.bands.length > 0);

  // A tap selection clears on a press anywhere outside the columns, including outside the chart.
  useEffect(() => {
    if (active?.via !== "tap") return;
    const clearOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && [...hitTargets.current.values()].some((hit) => hit === target)) return;
      setActive((current) => (current?.via === "tap" ? null : current));
    };
    document.addEventListener("pointerdown", clearOutside, true);
    return () => document.removeEventListener("pointerdown", clearOutside, true);
  }, [active?.via]);

  if (columns.length === 0) {
    return <div className="usage-chart usage-chart-empty" role="note">No usage was observed in this period.</div>;
  }

  const releasePointer = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    const focused = focusedIndex.current;
    setActive((current) => current?.via !== "pointer"
      ? current
      : focused === null ? null : { index: focused, via: "focus" });
  };
  const moveFocus = (event: ReactKeyboardEvent, index: number) => {
    const position = recordedIndexes.indexOf(index);
    const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? recordedIndexes[position + 1]
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? recordedIndexes[position - 1]
        : event.key === "Home" ? recordedIndexes[0]
          : event.key === "End" ? recordedIndexes.at(-1)
            : undefined;
    if (event.key === "Escape") {
      if (active === null) return;
      event.preventDefault();
      event.stopPropagation();
      setActive(null);
      return;
    }
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (next !== undefined) hitTargets.current.get(next)?.focus();
  };

  return (
    <div className="usage-chart" ref={boxRef} onPointerLeave={releasePointer}>
      <svg
        viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
        width={viewWidth}
        height={VIEW_HEIGHT}
        className={activeIndex === null ? "usage-chart-svg" : "usage-chart-svg has-active"}
        role="img"
        aria-labelledby={labelId}
      >
        <title id={labelId}>{`${periodLabel} ${metricLabel}${split ? " by driver" : ", not split by driver"}; ${tableHint}`}</title>
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="usage-chart-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={yFor(tick)} y2={yFor(tick)} />
            <text className="usage-chart-tick" x={PLOT_LEFT - 8} y={yFor(tick)} textAnchor="end" dominantBaseline="middle">
              {formatMetric(tick, metric)}
            </text>
          </g>
        ))}
        {/* Buckets from before recording started: one quiet band, never a run of zero columns. It
            covers the gridlines, which measure nothing there, so its label is never struck through. */}
        {runs.map(([first, last]) => {
          const x = PLOT_LEFT + first * step;
          const width = (last - first + 1) * step;
          return (
            <g key={`unrecorded-${columns[first]!.bucketTs}`} className="usage-chart-unrecorded">
              <rect x={x} y={PLOT_TOP} width={width} height={plotHeight} onPointerEnter={releasePointer} />
              {width >= UNRECORDED_LABEL_MIN_WIDTH && (
                <text x={x + width / 2} y={PLOT_TOP + plotHeight / 2} textAnchor="middle" dominantBaseline="middle">
                  Not Recorded
                </text>
              )}
            </g>
          );
        })}
        {columns.map((column, index) => {
          const x = PLOT_LEFT + index * step + (step - columnWidth) / 2;
          const painted = column.bands.filter((band) => band.value > 0);
          const topmost = painted.at(-1);
          const isLast = index === columns.length - 1;
          return (
            <g key={column.bucketTs} className={activeIndex === index ? "usage-chart-column is-hovered" : "usage-chart-column"}>
              {painted.map((band) => {
                // The 2px surface gap between stacked segments comes out of each segment's top,
                // and the base segment keeps its square foot on the baseline.
                const top = yFor(band.to) + (band === topmost ? 0 : MARK_GAP / 2);
                const bottom = yFor(band.from) - (band.from === 0 ? 0 : MARK_GAP / 2);
                return (
                  <path
                    key={band.driver}
                    className={`usage-chart-segment ${seriesClass(band.driver)}`}
                    d={segmentPath(x, columnWidth, top, bottom, band === topmost)}
                  />
                );
              })}
              {column.bands.length === 0 && column.total > 0 && (
                <path className="usage-chart-segment" d={segmentPath(x, columnWidth, yFor(column.total), PLOT_BOTTOM, true)} />
              )}
              {labelIndexes.has(index) && (
                // The last label ends at the plot's right edge instead of centring past it.
                <text
                  className="usage-chart-axis"
                  x={isLast ? PLOT_LEFT + columns.length * step : PLOT_LEFT + index * step + step / 2}
                  y={VIEW_HEIGHT - 8}
                  textAnchor={isLast ? "end" : "middle"}
                >
                  {axisLabel(column.bucketTs, granularity)}
                </text>
              )}
            </g>
          );
        })}
        <line className="usage-chart-baseline" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
        {/* Hit targets span the whole slot, not the painted pixels, so a thin column is still easy
            to land on. Only recorded columns have one, so neither pointer nor keyboard can land in
            the Not Recorded band. */}
        {columns.map((column, index) => column.recorded && (
          <rect
            key={`hit-${column.bucketTs}`}
            ref={(node) => {
              if (node) hitTargets.current.set(index, node);
              else hitTargets.current.delete(index);
            }}
            className="usage-chart-hit"
            x={PLOT_LEFT + index * step}
            y={PLOT_TOP}
            width={step}
            height={plotHeight}
            tabIndex={index === tabStop ? 0 : -1}
            aria-label={`${bucketLabel(column.bucketTs, granularity, bounds)}: ${formatMetric(column.total, metric)}`}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") setActive({ index, via: "pointer" });
            }}
            onPointerDown={(event) => {
              lastTouchPress.current = event.pointerType === "touch" ? event.timeStamp : Number.NEGATIVE_INFINITY;
            }}
            onClick={(event) => {
              const tapped = event.timeStamp - lastTouchPress.current < TAP_FOCUS_MS;
              lastTouchPress.current = Number.NEGATIVE_INFINITY;
              if (!tapped) return;
              if (active?.via === "tap" && active.index === index) {
                setActive(null);
                // The tap focused the column; drop that focus too, or its ring outlives the selection.
                event.currentTarget.blur();
              } else {
                setActive({ index, via: "tap" });
              }
            }}
            onFocus={(event) => {
              focusedIndex.current = index;
              setRovingIndex(index);
              if (event.timeStamp - lastTouchPress.current < TAP_FOCUS_MS) return;
              setActive({ index, via: "focus" });
            }}
            onBlur={() => {
              if (focusedIndex.current === index) focusedIndex.current = null;
              setActive((current) => (current?.via === "focus" && current.index === index ? null : current));
            }}
            onKeyDown={(event) => moveFocus(event, index)}
          />
        ))}
      </svg>
      <div className="usage-chart-readout" role="status" aria-live="polite">
        {readout ? (
          <>
            <span className="usage-chart-readout-period">{bucketLabel(readout.bucketTs, granularity, bounds)}</span>
            <dl>
              {readout.bands.length === 0 && <div><dt>By Driver</dt><dd>Not split by this control plane</dd></div>}
              {readout.bands.map((band) => (
                <div key={band.driver}>
                  <dt>
                    <SeriesSwatch driver={band.driver} />
                    {driverLabels[band.driver]}
                  </dt>
                  <dd>{formatMetric(band.value, metric)}</dd>
                </div>
              ))}
              <div className="usage-chart-readout-total"><dt>Total</dt><dd>{formatMetric(readout.total, metric)}</dd></div>
            </dl>
          </>
        ) : (
          <span className="usage-chart-readout-summary">
            {summary.average}
            {summary.peak && <> · {summary.peak}</>}
          </span>
        )}
      </div>
    </div>
  );
}
