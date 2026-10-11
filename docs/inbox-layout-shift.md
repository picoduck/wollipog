# Phone Inbox Cold-Load Layout Shift

The phone Sessions notice is a sibling below the list, Board, or state scroll area. Its late
arrival reduces the bottom of the available area instead of moving the already rendered top
rows. It remains one mounted `SessionsListNotices`, with the existing ranking, menu, dismissal,
offline hiding, and focus rules. At most half of the phone pane is used by the notice; longer
notices scroll. Desktop/tablet notices retain their placement above the content, and stacked
list geometry measures the combined notice and status-line heights.
When focus enters the phone notice or its viewport shrinks, only that notice's scroll position
adjusts to keep the complete focused control and its outline visible.

Reproduce the cold measurement with a production build:

```sh
pnpm --filter @wollipog/web build
node --import tsx apps/web/scripts/inbox-layout-shift-benchmark.ts \
  --runs 7 --output /tmp/inbox-cls.json --assert-max-cls 0.1
```

The benchmark starts its own control plane with a separate database and loopback port. It
seeds twenty fixed-timestamp synthetic sessions, each containing one synthetic prompt, and
one synthetic runner. HTTP and WebSocket traffic use that control plane's actual routes;
there is no API interception, preview visit, session visit, or warmup navigation. The saved
database and isolated control-plane log remain in the scratch directory named in the report.
It never connects to or signals the hosting control plane or runner.

Each sample uses a fresh Chromium context at 390×844, 4× CPU throttling, disabled HTTP cache,
blocked service workers, and 40 Mbps download/upload with 40 ms latency. A performance observer
records every non-input layout shift and its source rectangles, alongside the first animation
frame containing an Inbox row. The report includes standard maximum-session-window CLS both
through that frame and after a further one-second settling window. Every completed sample is
retained before the strict threshold assertion is checked. Failed samples are retained too.
Resource timings, browser/Node versions, source HEAD/status, measurement time, lockfile and
harness digests, and emitted HTML/JavaScript/CSS digests are recorded for provenance.

For comparisons, save each revision's production dist separately and pass `--dist`; alternate
before/after batches on the same host. Optional `--evidence <directory>` saves the settled
first trial's screenshot. `--width` supports other viewports. Optional `--probe-dismissal`
records a separate warm Dismiss All focus probe after the first sample's measurement window;
it is not part of that sample's cold CLS.

On the merged lazy-loading baseline `2c8242eb02a06a7065fb89f330c58f89c4a76b23`, seven trials
each measured **0.2763302711080164** CLS. Chromium attributed the shift to `.inbox-skeleton`,
whose top moved from y=48 to y=314 when Recommended Skills arrived. A delayed-response browser
regression independently observed the first rendered session row move from y=56 to y=322.
With the footer placement, the same seven-trial production-control-plane setup measured
**0** CLS in every trial, through the first row and during settling. These are synthetic
emulation results, not measurements of a physical phone or production customer data.

Production regression coverage in `inbox-layout-shift.spec.ts` also checks light/dark late
recommendations, empty/error library responses at phone/tablet/desktop widths, deliberate
focus movement during dismissal, and short list/Board/state viewports. The existing Sessions
notice and split suites verify priority/menu/offline behavior and whole desktop/tablet rows.

A warm keyboard Dismiss All probe left focus on `body` on both the baseline and corrected
build. That pre-existing behavior is outside this layout fix: the button disables while the
request runs, before the notice disappears. Cold measurements end before this probe starts.
