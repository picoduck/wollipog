import { TimingSummary, TIMING_MARKER } from "./ci-timing.mjs";

export default class BrowserTimingReporter {
  summary = new TimingSummary("browser");
  onTestEnd(test, result) {
    this.summary.add({ file: test.location.file, name: JSON.stringify(test.titlePath()), durationMs: result.duration,
      state: result.status === "skipped" ? "skipped" : result.status === test.expectedStatus ? "passing" : "failing", retry: result.retry });
  }
  onEnd() { console.log(TIMING_MARKER + JSON.stringify(this.summary.result())); }
}
