import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentDriverKind } from "@wollipog/protocol";
import { bucketLabel } from "./UsageView.js";
import {
  DRIVER_PRESENTATION,
  seriesClass,
  axisLabel,
  axisLabelIndexes,
  formatMetric,
  niceScale,
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
const SEGMENT_GAP = 2;
const CAP_RADIUS = 4;

/** A stacked segment: square at the baseline, and the topmost one carries the rounded data-end. */
function segmentPath(x: number, width: number, top: number, bottom: number, rounded: boolean): string {
  const height = Math.max(0, bottom - top);
  if (!rounded || height < CAP_RADIUS) return `M${x} ${top}h${width}v${height}h${-width}Z`;
  const r = Math.min(CAP_RADIUS, width / 2);
  return `M${x} ${bottom}v${-(height - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${width - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${height - r}Z`;
}

/**
 * Driver-stacked columns for one usage window. Every value here is also in the Day table beneath
 * the chart, so the hover and focus readout enhances and never gates. Columns are keyboard
 * reachable: each column's hit area is a focusable target that shows the same readout as hover.
 */
export function UsageChart({
  columns,
  drivers,
  metric,
  granularity,
  tableHint,
}: {
  columns: readonly UsageColumn[];
  drivers: readonly AgentDriverKind[];
  metric: UsageMetric;
  granularity: "hour" | "day";
  /** Where the table twin is right now, for the accessible name: it moves with the breakdown. */
  tableHint: string;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const labelId = useId();
  const [boxRef, viewWidth] = useMeasuredWidth<HTMLDivElement>();
  const PLOT_RIGHT = viewWidth - 8;
  const peak = Math.max(0, ...columns.map((column) => column.total));
  const scale = useMemo(() => niceScale(peak), [peak]);
  const plotWidth = PLOT_RIGHT - PLOT_LEFT;
  const plotHeight = PLOT_BOTTOM - PLOT_TOP;
  const step = columns.length > 0 ? plotWidth / columns.length : plotWidth;
  const columnWidth = Math.max(2, Math.min(MAX_COLUMN_WIDTH, step * 0.7));
  const yFor = (value: number) => PLOT_BOTTOM - (value / scale.max) * plotHeight;
  const labelIndexes = useMemo(() => new Set(axisLabelIndexes(columns.length)), [columns.length]);
  const readout = hovered === null ? null : columns[hovered] ?? null;
  const metricLabel = metric === "cost" ? "cost" : "processed tokens";
  const periodLabel = granularity === "hour" ? "Hourly" : "Daily";

  if (columns.length === 0) {
    return <div className="usage-chart usage-chart-empty" role="note">No usage was observed in this period.</div>;
  }

  return (
    <div className="usage-chart" ref={boxRef} onPointerLeave={() => setHovered(null)}>
      <svg
        viewBox={`0 0 ${viewWidth} ${VIEW_HEIGHT}`}
        width={viewWidth}
        height={VIEW_HEIGHT}
        className="usage-chart-svg"
        role="img"
        aria-labelledby={labelId}
      >
        <title id={labelId}>{`${periodLabel} ${metricLabel} by driver; ${tableHint}`}</title>
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line className="usage-chart-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={yFor(tick)} y2={yFor(tick)} />
            <text className="usage-chart-tick" x={PLOT_LEFT - 8} y={yFor(tick)} textAnchor="end" dominantBaseline="middle">
              {formatMetric(tick, metric)}
            </text>
          </g>
        ))}
        {columns.map((column, index) => {
          const x = PLOT_LEFT + index * step + (step - columnWidth) / 2;
          const painted = column.bands.filter((band) => band.value > 0);
          const topmost = painted.at(-1);
          return (
            <g key={column.bucketTs} className={hovered === index ? "usage-chart-column is-hovered" : "usage-chart-column"}>
              {painted.map((band) => {
                // The 2px surface gap between stacked segments comes out of each segment's top,
                // and the base segment keeps its square foot on the baseline.
                const top = yFor(band.to) + (band === topmost ? 0 : SEGMENT_GAP / 2);
                const bottom = yFor(band.from) - (band.from === 0 ? 0 : SEGMENT_GAP / 2);
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
                <text className="usage-chart-axis" x={PLOT_LEFT + index * step + step / 2} y={VIEW_HEIGHT - 8} textAnchor="middle">
                  {axisLabel(column.bucketTs, granularity)}
                </text>
              )}
            </g>
          );
        })}
        <line className="usage-chart-baseline" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
        {/* Hit targets span the whole slot, not the painted pixels, so a thin column is still easy
            to land on. They are focusable so the keyboard gets the same readout as the pointer. */}
        {columns.map((column, index) => (
          <rect
            key={`hit-${column.bucketTs}`}
            className="usage-chart-hit"
            x={PLOT_LEFT + index * step}
            y={PLOT_TOP}
            width={step}
            height={plotHeight}
            tabIndex={0}
            aria-label={`${bucketLabel(column.bucketTs, granularity)}: ${formatMetric(column.total, metric)}`}
            onPointerEnter={() => setHovered(index)}
            onFocus={() => setHovered(index)}
            onBlur={() => setHovered((current) => (current === index ? null : current))}
          />
        ))}
      </svg>
      <div className="usage-chart-readout" role="status" aria-live="polite">
        {readout ? (
          <>
            <span className="usage-chart-readout-period">{bucketLabel(readout.bucketTs, granularity)}</span>
            <dl>
              {readout.bands.length === 0 && <div><dt>By Driver</dt><dd>Not split by this control plane</dd></div>}
              {readout.bands.map((band) => (
                <div key={band.driver}>
                  <dt>
                    <span className={`usage-series-key ${seriesClass(band.driver)}`} aria-hidden="true" />
                    {DRIVER_PRESENTATION[band.driver].label}
                  </dt>
                  <dd>{formatMetric(band.value, metric)}</dd>
                </div>
              ))}
              <div className="usage-chart-readout-total"><dt>Total</dt><dd>{formatMetric(readout.total, metric)}</dd></div>
            </dl>
          </>
        ) : (
          <span className="usage-chart-readout-hint">Hover or focus a column for its breakdown.</span>
        )}
      </div>
      {drivers.length >= 2 && (
        <ul className="usage-legend" aria-label="Drivers">
          {drivers.map((driver) => (
            <li key={driver}>
              <span className={`usage-series-swatch ${seriesClass(driver)}`} aria-hidden="true" />
              {DRIVER_PRESENTATION[driver].label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
