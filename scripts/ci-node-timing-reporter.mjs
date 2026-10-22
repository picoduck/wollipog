import { TimingSummary, TIMING_MARKER } from "./ci-timing.mjs";

export default async function* reporter(events) {
  const summary = new TimingSummary("node");
  for await (const { type, data } of events) {
    if (!["test:pass", "test:fail"].includes(type) || !data.file) continue;
    summary.add({ file: data.file, name: `${data.line}:${data.column}:${data.name}`,
      durationMs: data.details?.duration_ms, state: data.skip || data.todo ? "skipped" : type === "test:pass" ? "passing" : "failing",
      accumulateFile: (data.nesting ?? 0) === 0, includeTest: data.details?.type !== "suite" });
  }
  yield `${TIMING_MARKER}${JSON.stringify(summary.result())}\n`;
}
