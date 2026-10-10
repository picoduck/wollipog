# Long-Transcript Scrolling

Related to #2771. The production reader avoids synchronous table layout at mount, reuses parsed
Markdown after row remounts, and reuses timestamp formatters instead of rebuilding Intl instances
for each row. The timestamp extension was approved after profiling identified its remaining cost.
Current-turn opening and anchoring from #474/#2224/#2770 are unchanged.

## Implementation and Bounds

- Tables register their observer from a passive effect. The observer's initial delivery measures
  overflow after layout; subsequent deliveries observe both the wrapper and its table. Scroll
  events preserve the trailing fade and keyboard focusability. Identical measurements invoke no
  state setter. Without ResizeObserver, a deferred task and window resize listener provide the
  existing overflow behavior without a mount layout effect.
- Markdown caches canonical HAST by exact content and parser profile. Cold misses use the same
  GFM/breaks/inline parser pipeline. Hits supply a cloned canonical tree to react-markdown, which
  still applies its original raw-HTML/URL policy and creates fresh React elements. Cached values
  contain no React owner, mounted state, DOM node or caller callback. Context still controls media,
  highlighting, compact URLs and per-mount code controls. The final pass never mutates the stored
  canonical tree.
- The LRU holds at most 256 entries and 524,288 source-key characters; keys longer than 65,536
  characters bypass admission. These are input/entry bounds, not a claim about exact heap bytes.
  Evicted and oversized content still renders normally and can parse again. Streaming tails bypass
  admission; stable earlier blocks and settled documents can be reused.
- A separate 32-entry LRU stores Intl.DateTimeFormat instances keyed by locale, time zone and
  style, without storing timestamp values. Explicit environments retain exact output, including
  DST. Implicit defaults are resolved and checked when language hints/current UTC offset change,
  or after one second of active formatting. A default-zone/locale change without a changed hint
  can therefore take up to one second to invalidate cached defaults; it is not frozen for the
  lifetime of a tab. Invalid dates, locale errors and invalid-zone errors retain their behavior.

## Reproduction

Install the repository's pinned dependencies and Playwright Chromium, then run from the repository
root. Each invocation builds and serves only the synthetic fixture, independently of any hosting
Wollipog stack:

```sh
pnpm exec tsx apps/web/scripts/transcript-scroll-benchmark.ts /tmp/scroll-after 5
node apps/web/scripts/transcript-scroll-profile.mjs /tmp/scroll-after
```

To reproduce the baseline, extract the baseline commit into a separate scratch directory and overlay
only the benchmark files from this change. The fixture detects the absence of a baseline cache:

```sh
SCROLL_BASELINE=$(mktemp -d /tmp/scroll-baseline-source-XXXXXX)
git archive 158e4e9b577ec519795444767fc0bd72c2c675b3 | tar -x -C "$SCROLL_BASELINE"
git archive HEAD apps/web/scripts/transcript-scroll-benchmark.ts \
  apps/web/scripts/transcript-scroll-profile.mjs apps/web/transcript-scroll-e2e.html \
  apps/web/src/e2e/transcript-scroll-main.tsx apps/web/src/e2e/transcript-scroll-fixture.ts \
  | tar -x -C "$SCROLL_BASELINE"
pnpm --dir "$SCROLL_BASELINE" install --frozen-lockfile
cd "$SCROLL_BASELINE"
pnpm exec tsx apps/web/scripts/transcript-scroll-benchmark.ts /tmp/scroll-before 5
node apps/web/scripts/transcript-scroll-profile.mjs /tmp/scroll-before
```

Optional settings:

- `SCROLL_BENCHMARK_CPU_RATE=1` measures the unthrottled control; default is 4.
- `SCROLL_BENCHMARK_REUSE_DIST=1` repeats against an existing immutable output bundle. The report
  records that fact and hashes its JavaScript assets; it does not claim the current checkout built it.
- `SCROLL_BENCHMARK_EVIDENCE=1` captures desktop/phone, dark/light and horizontal-table-end states
  after sampling finishes.
- `SCROLL_BENCHMARK_RECORD_VIDEO=1` records a separate paced scroll with a visible capture-only
  pointer. Recording pauses never enter the timed benchmark or regression tests.

## Data and Sampling

The deterministic fixture has 500 completed turns × 21 events plus a three-event current turn:
10,503 events. Each completed turn contains three tool calls with five updates each, a prompt, a
Markdown reply with a six-row GFM table and TypeScript fence, and a conversation checkpoint.
No real transcript, prompt, identity or path is used. The serialized event JSON SHA-256 is
`8931fefcab10d0bafb79e2e4aae126bee7264283f2f506addcfbbf7087240b5f`.

Each trial opens a fresh page, applies CDP 4× CPU throttling, waits for virtual measurements, moves
to the newest activity, and settles for 30 frames. It then traverses to the top in 400-CSS-pixel
increments per requestAnimationFrame. Frame intervals are successive rAF timestamp differences;
quantiles use nearest rank (`ceil(n × p) - 1`). A CDP CPU profile uses a requested 1 ms sampling
interval over the same traversal. Raw frame arrays, profiles, event JSON, asset hashes and reports
are retained by the command. Measurements include 1,440 frames per trial and at most 23 mounted
virtual rows; changes in estimated row heights explain why the initial estimated scroll height is
not the sum of traversal steps.

Profiles are mapped through the emitted source maps. Parser-pipeline attribution is inclusive of
micromark/mdast/remark/unified/react-markdown stacks. Table attribution covers MarkdownTable's
render/measurement code. These categories can overlap and are percentages of all sampled time,
including idle/native work; they are not independent causal estimates or browser paint timings.

## Measurements

Linux x64, AMD Ryzen 9 7900X3D, Node 24.18.1, Playwright-pinned Chromium 153.0.8010.12,
1280 × 900 viewport. Five baseline trials ran sequentially against the preserved production
baseline bundle, followed by five final trials. No other tests from this task ran during these
controlled measurements. Both datasets have the SHA-256 above.

| Trial | Baseline p95 (ms) | Final p95 (ms) | Baseline Traversal (s) | Final Traversal (s) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 50.0 | 16.8 | 36.111 | 24.235 |
| 2 | 50.0 | 16.8 | 35.167 | 24.369 |
| 3 | 50.0 | 16.8 | 35.588 | 24.250 |
| 4 | 50.0 | 16.8 | 36.319 | 24.215 |
| 5 | 50.0 | 16.8 | 38.025 | 24.986 |

At display precision, p95 has zero between-trial spread. Mean traversal time was 36.242 s
(sample SD 1.094 s) before and 24.411 s (sample SD 0.327 s) after. Of 7,200 sampled frames,
914 baseline frames exceeded 34 ms and 763 were at least 50 ms; final frames exceeded neither
threshold. Baseline maximums ranged 66.7–233.4 ms; final maximums ranged 33.4–33.5 ms.

The baseline parser pipeline occupied 18.0–18.4% of sampled time, versus 12.2–12.4% after;
table code fell from 6.46–6.77% to 0.079–0.146%. Timestamp formatting fell from about 24%
self time to about 2%. The parser still does cold work; lower total traversal time changes these
percentages, so they should be read alongside raw profiles and wall-clock durations.

All exploratory runs are reported separately: the first baseline series had p95
83.2/66.6/66.7/66.7/66.6 ms, and Markdown/table-only changes had
50.0/33.4/50.0/66.6/50.0 ms. Those series overlapped with test/typecheck activity and motivated
the controlled rerun and formatter extension; they are not the controlled comparison.

## Verification and Limits

Regression coverage checks cache reuse after actual virtual-row remount, entry/source limits,
LRU recency, streaming admission, profile isolation, HTML/URL safety, fresh mounted code/media
state, table measurement timing, keyboard scrolling, edge fades and viewport resizing. Timestamp
tests compare original Intl output across locales, zones and DST boundaries and verify bounded
instance reuse and default-environment refresh. Existing Markdown/blockwise, timeline reflow and
real production #2770 opening tests pass, including 1×/4× CPU and viewport/theme anchoring checks.

This is a synthetic transcript, not the private transcript in the original report. CPU throttling
on a desktop is a proxy for slower hardware, not a real phone measurement. rAF intervals are
frame-scheduling observations, not presentation timestamps. The profiler adds overhead; the
algorithm scrolls per sampled frame, not at a fixed wall-clock velocity. Shared host load, JIT and
browser scheduling remain uncontrolled; no statistical significance or universal frame-time
guarantee is claimed. The strict p95-under-50-ms acceptance criterion is met in every final trial.
