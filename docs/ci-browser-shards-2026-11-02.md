# Browser Shard Natural-Run Measurement: November 2, 2026

Refs #3628. This expanded report supersedes the original 19-first-attempt checkpoint
and its provisional 2080s/69-minute proposal. No workflows were generated, rerun,
cancelled or reconfigured for measurement. Source is ordinary traffic created in
**[2026-10-23T21:02:55Z, 2026-11-02T15:00:00Z)**, collected November 2.
The cutoff precedes this measurement PR's own traffic. Day-sized API slices and
cached responses bound shared reads. All source windows and pagination flags are
in the [safe export](ci-browser-shards-2026-11-02.json).

## Workflow Transitions and Comparability

No changes to playwright.ci.config.ts, playwright.shards.ts, playwright.config.ts
or playwright.production.config.ts landed after #3644 through the inspected main
snapshot. The five duration-aware intact-file projects remain in place. Browser
workloads still evolve: e2e spec files grow from 281 at #3644 to 306 at the
November 2 inspection snapshot (including opt-in specs, not a discovery count).
New/deleted files and changed tests prevent treating arbitrary suites as identical.

The following exact landed commits partition creation time. PR and merge-group
candidates can contain a change **before** it lands: these temporal eras are not
proof of a candidate workflow's revision. Actual five-shard successful execution
is required for the complete observations below; a fast or skipped route cannot
enter that comparison. The #3650 candidate in era A already has the cache.

| Era | Start UTC (Inclusive) | Commit | Change |
| --- | --- | --- | --- |
| A | 2026-10-23T21:02:55Z | `98accc6be15171f931a90a2f9de602b0048cf330` | Duration Redistribution |
| B | 2026-10-24T02:50:17Z | `f6865fdf83db979eef6c7598e0112c04fd32deba` | Package Cache |
| C | 2026-10-24T15:10:55Z | `11de60a49e1fb14462cdeff25a8053303b6469de` | Advisory Selection |
| D | 2026-10-24T16:29:27Z | `074da66e914728cc51490b0b21928bd1246e6153` | Inactive PR Routing |
| E | 2026-10-25T20:12:13Z | `b0b1313e420df3f537c4abf5a080ff978f6b65f6` | Retire Main Push |
| F | 2026-10-26T15:24:35Z | `5f6743109ea487503f08a701c10714c7b702b937` | Advisory Admission |
| G | 2026-10-28T11:19:16Z | `1928fa43ae106535c0329125fa432773372d10e8` | Disabled Group Gate |
| H | 2026-10-29T04:43:00Z | `32b0b9728cea5ce8ad5d48096b11764e747edc75` | Pipeline Sibling |
| I | 2026-10-31T03:13:56Z | `7ec02432e4819da7436bf065b75f8c35452828bf` | Node Sharding |
| J | 2026-11-02T07:36:49Z | `e8f167b674e4b9a39e1fddfe65334dfdc9142628` | Packaged Runner Checks |

Each era ends at the next start; J ends at 2026-11-02T15:00:00Z. #3650
introduced apt package cache phases and 68/29-minute Chromium/WebKit limits.
#3656 and #3746 added conditional routing, disabled by default; recorded five-job
full passes remain distinguishable from any reduced inventory. #3652 adds an
advisory sibling; #3677 adds disabled advisory admission. #3668 retires main pushes,
#3745 adds a required pipeline sibling, #3866 adds Node shard demand, and #3996
changes runner packaging in the checks job. Those affect demand or dependencies;
they do not make later browser data unusable. There is no reason to stop at October 24.
Post-cutover main health must use rolling workers, whose target SHA differs from
the dispatch SHA. No claim about current main health is made from old pushes here.

## Outcomes and Retry Rates

First-attempt workflow states remain separate. A failing workflow need not have a
browser failure; cancellation is not a product failure. Reruns are separate attempts,
and their copied successful jobs do not contribute consumption, waits or latency.
Retry-only means a distinct run with a failing first attempt and a later passing
attempt at the same head, not a proven flaky test. Divide failing by First for an
all-first-attempt failure fraction, or by Passing+Failing for a terminal admitted
fraction. Neither denominator quietly drops cancelled or skipped observations.

| Era / Event | First | Passing | Failing | Cancelled | Skipped | Unfinished | Unmeasured | Rerun Attempts | Retry-Only Runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALL / PR | 668 | 307 | 48 | 229 | 84 | 0 | 0 | 42 | 25 |
| ALL / Group | 330 | 246 | 33 | 51 | 0 | 0 | 0 | 2 | 0 |
| ALL / Historical Main Push | 14 | 8 | 3 | 3 | 0 | 0 | 0 | 0 | 0 |
| A / PR | 6 | 0 | 2 | 1 | 3 | 0 | 0 | 2 | 2 |
| A / Group | 4 | 2 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| A / Historical Main Push | 2 | 0 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| B / PR | 10 | 2 | 2 | 0 | 6 | 0 | 0 | 2 | 2 |
| B / Group | 3 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| B / Historical Main Push | 3 | 2 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| C / PR | 3 | 1 | 0 | 0 | 2 | 0 | 0 | 0 | 0 |
| C / Group | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| C / Historical Main Push | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| D / PR | 29 | 12 | 1 | 7 | 9 | 0 | 0 | 1 | 1 |
| D / Group | 9 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| D / Historical Main Push | 8 | 5 | 1 | 2 | 0 | 0 | 0 | 0 | 0 |
| E / PR | 60 | 27 | 7 | 11 | 15 | 0 | 0 | 4 | 4 |
| E / Group | 15 | 10 | 2 | 3 | 0 | 0 | 0 | 0 | 0 |
| F / PR | 102 | 45 | 8 | 37 | 12 | 0 | 0 | 7 | 5 |
| F / Group | 67 | 44 | 8 | 15 | 0 | 0 | 0 | 0 | 0 |
| G / PR | 71 | 30 | 4 | 17 | 20 | 0 | 0 | 4 | 3 |
| G / Group | 33 | 22 | 4 | 7 | 0 | 0 | 0 | 0 | 0 |
| H / PR | 150 | 72 | 11 | 57 | 10 | 0 | 0 | 7 | 3 |
| H / Group | 89 | 62 | 8 | 19 | 0 | 0 | 0 | 0 | 0 |
| I / PR | 204 | 96 | 10 | 92 | 6 | 0 | 0 | 12 | 4 |
| I / Group | 86 | 76 | 6 | 4 | 0 | 0 | 0 | 2 | 0 |
| J / PR | 33 | 22 | 3 | 7 | 1 | 0 | 0 | 3 | 1 |
| J / Group | 23 | 18 | 2 | 3 | 0 | 0 | 0 | 0 | 0 |

## Complete Browser Performance

Only passing first-attempt **workflows** with all five passing Chromium
shards and coherent job/step timing enter the primary distributions. Historical main pushes are included separately,
correcting the first review's omission. Browser-complete sets inside failing or
cancelled workflows remain sizing evidence, not successful workflow observations.
Quantiles use the existing collector's nearest-rank convention. Ratios are computed
within each run before quantiling. Times and sums are elapsed minutes, not billed usage.

Max Active is the longest complete Chromium job, including setup, development,
shard-1 production build/smoke, post-job steps and gaps. Complete Path is run
creation to the last Chromium/WebKit completion, so it includes upstream delay and
runner wait. Wait is the maximum Chromium job creation-to-allocation wait within
each run; upstream dependency time is not mislabelled as runner wait. Chromium Sum
counts five jobs; +WebKit includes the independent WebKit job. Production is already
included once. Windows execution is separately accounted below.

All distribution cells show p50 / p90. N gives reported complete sets / sets
with coherent timing. The raw reported view follows; no source rows are removed.

| Era / Event | N | Longest/Median | Longest/Shortest | Max Active | Complete Path | Chromium Sum | +WebKit Sum | Runner Wait |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ALL / PR | 300 / 290 | 1.09 / 1.28 | 1.40 / 1.59 | 35.92 / 38.43 | 38.03 / 100.65 | 158.83 / 172.65 | 160.38 / 174.25 | 0.32 / 69.48 |
| ALL / Group | 244 / 242 | 1.08 / 1.30 | 1.42 / 1.58 | 35.98 / 38.02 | 36.77 / 51.18 | 159.68 / 172.05 | 161.30 / 173.63 | 0.05 / 18.27 |
| ALL / Historical Main Push | 8 / 8 | 1.04 / 1.21 | 1.47 / 1.59 | 33.50 / 33.97 | 33.77 / 34.68 | 151.85 / 160.13 | 152.87 / 161.33 | 0.03 / 0.07 |
| A / PR | 0 / 0 | — / — | — / — | — / — | — / — | — / — | — / — | — / — |
| A / Group | 2 / 2 | 1.05 / 1.14 | 1.22 / 1.63 | 33.10 / 37.85 | 33.13 / 37.90 | 152.50 / 160.83 | 153.48 / 161.80 | 0.03 / 0.03 |
| A / Historical Main Push | 0 / 0 | — / — | — / — | — / — | — / — | — / — | — / — | — / — |
| B / PR | 2 / 2 | 1.01 / 1.05 | 1.18 / 1.26 | 28.25 / 32.20 | 28.28 / 32.23 | 129.82 / 152.05 | 130.90 / 153.32 | 0.03 / 0.03 |
| B / Group | 3 / 3 | 1.03 / 1.24 | 1.49 / 1.57 | 33.20 / 33.58 | 33.23 / 33.62 | 147.87 / 153.77 | 148.85 / 155.12 | 0.03 / 0.03 |
| B / Historical Main Push | 2 / 2 | 1.02 / 1.02 | 1.48 / 1.59 | 33.60 / 33.73 | 33.63 / 33.77 | 152.70 / 154.17 | 153.72 / 155.83 | 0.03 / 0.03 |
| C / PR | 1 / 1 | 1.23 / 1.23 | 1.48 / 1.48 | 33.28 / 33.28 | 33.33 / 33.33 | 137.45 / 137.45 | 138.38 / 138.38 | 0.18 / 0.18 |
| C / Group | 1 / 1 | 1.18 / 1.18 | 1.49 / 1.49 | 33.55 / 33.55 | 33.58 / 33.58 | 145.98 / 145.98 | 146.95 / 146.95 | 0.05 / 0.05 |
| C / Historical Main Push | 1 / 1 | 1.21 / 1.21 | 1.48 / 1.48 | 33.27 / 33.27 | 34.68 / 34.68 | 139.38 / 139.38 | 140.28 / 140.28 | 0.03 / 0.03 |
| D / PR | 12 / 12 | 1.05 / 1.22 | 1.42 / 1.52 | 33.70 / 34.15 | 34.68 / 51.50 | 147.30 / 159.92 | 148.50 / 161.07 | 0.68 / 21.78 |
| D / Group | 8 / 8 | 1.05 / 1.17 | 1.23 / 1.59 | 34.02 / 34.28 | 34.10 / 44.07 | 150.85 / 161.28 | 151.80 / 162.65 | 0.03 / 10.03 |
| D / Historical Main Push | 5 / 5 | 1.04 / 1.10 | 1.44 / 1.53 | 33.50 / 33.97 | 33.78 / 34.02 | 151.85 / 160.13 | 152.87 / 161.33 | 0.03 / 0.07 |
| E / PR | 27 / 27 | 1.13 / 1.33 | 1.42 / 1.66 | 34.38 / 35.52 | 77.73 / 158.50 | 148.92 / 163.43 | 150.13 / 164.47 | 43.93 / 128.22 |
| E / Group | 10 / 10 | 1.11 / 1.32 | 1.42 / 1.66 | 34.72 / 35.65 | 37.35 / 65.22 | 150.03 / 163.35 | 151.03 / 164.40 | 1.87 / 43.05 |
| F / PR | 45 / 45 | 1.11 / 1.33 | 1.50 / 1.66 | 35.02 / 36.27 | 67.50 / 187.53 | 149.02 / 161.55 | 150.35 / 162.72 | 35.93 / 155.43 |
| F / Group | 44 / 44 | 1.12 / 1.38 | 1.40 / 1.60 | 34.68 / 35.95 | 36.25 / 65.22 | 152.50 / 164.40 | 153.88 / 165.73 | 1.82 / 30.03 |
| G / PR | 30 / 30 | 1.09 / 1.28 | 1.37 / 1.52 | 35.53 / 36.37 | 84.87 / 126.08 | 160.18 / 170.50 | 162.23 / 172.22 | 49.88 / 91.23 |
| G / Group | 22 / 22 | 1.05 / 1.35 | 1.45 / 1.53 | 35.83 / 36.62 | 44.47 / 92.40 | 156.50 / 168.62 | 158.48 / 170.15 | 12.58 / 59.97 |
| H / PR | 72 / 72 | 1.08 / 1.21 | 1.38 / 1.52 | 36.05 / 37.03 | 36.30 / 54.22 | 159.22 / 173.00 | 160.67 / 174.53 | 0.03 / 18.65 |
| H / Group | 62 / 62 | 1.08 / 1.27 | 1.42 / 1.57 | 35.93 / 37.00 | 36.05 / 37.53 | 159.82 / 168.38 | 161.43 / 169.85 | 0.03 / 2.23 |
| I / PR | 89 / 79 | 1.09 / 1.29 | 1.41 / 1.59 | 37.22 / 39.12 | 37.57 / 43.82 | 162.85 / 175.27 | 163.98 / 176.93 | 0.03 / 8.90 |
| I / Group | 74 / 72 | 1.06 / 1.19 | 1.41 / 1.53 | 37.00 / 38.37 | 37.03 / 38.63 | 165.17 / 176.75 | 166.50 / 178.48 | 0.03 / 0.15 |
| J / PR | 22 / 22 | 1.11 / 1.23 | 1.40 / 1.56 | 38.72 / 40.07 | 39.33 / 61.72 | 169.20 / 178.18 | 170.55 / 179.88 | 0.15 / 27.38 |
| J / Group | 18 / 18 | 1.11 / 1.30 | 1.36 / 1.57 | 38.77 / 40.18 | 38.80 / 40.23 | 169.80 / 176.08 | 171.10 / 177.75 | 0.12 / 0.28 |

Raw reported complete-passing values, including timing anomalies (p50 / p90 / max):

| Event | N | Longest/Median | Longest/Shortest | Max Active | Complete Path | Chromium Sum |
| --- | --- | --- | --- | --- | --- | --- |
| PR | 300 | 1.09 / 1.28 / 1.47 | 1.40 / 1.58 / 1.72 | 36.00 / 38.57 / 98.25 | 38.32 / 102.12 / 265.10 | 159.12 / 173.00 / 478.63 |
| Group | 244 | 1.08 / 1.30 / 1.53 | 1.42 / 1.58 / 4.26 | 36.00 / 38.10 / 97.52 | 36.77 / 54.38 / 104.62 | 159.72 / 173.15 / 458.22 |
| Historical Main Push | 8 | 1.04 / 1.21 / 1.21 | 1.47 / 1.59 / 1.59 | 33.50 / 33.97 / 33.97 | 33.77 / 34.68 / 34.68 | 151.85 / 160.13 / 160.13 |

All-outcome first-attempt measured Chromium consumption, including partial failed
and cancelled work, is a lower bound; missing execution and copied rerun work are
not zero. This is distinct from the complete-passing sum distributions above.

| Event | Coherent Chromium Jobs | Coherent Runner-Minutes (Lower Bound) | Jobs With Uncertain Allocation | All Reported Chromium Minutes | Complete Browser Sets, All Workflow Outcomes |
| --- | --- | --- | --- | --- | --- |
| PR | 2635 | 66343.62 | 85 | 69979.67 | 343 |
| Group | 1615 | 49285.80 | 10 | 50080.57 | 287 |
| Historical Main Push | 70 | 1955.60 | 0 | 1955.60 | 10 |

## Measured Phase Envelope

Every passing first-attempt shard with executed suite and coherent phase timings is
eligible for sizing, even if a sibling later fails or cancels the workflow. Failed,
cancelled or unfinished shards cannot lower the required envelope. Queue wait is
excluded. Non-install is active minus executed first/retry install phases; it includes
other setup, suite, production and residual cleanup/gaps. Package-cache phases stay
inside this observed remainder; additionally reserving their full configured bounds
is deliberately conservative. The raw selected phase steps and source IDs remain in
the export, as do all outcomes. Unexplained terminal gaps over the model's 180s
reserve or executed steps outside a job interval mark allocation unmeasured and
cannot size the phase envelope. They remain in the raw reported latency/resource
view, not silently subtracted. Historical five-job sizing remains in the fixture.

| Run / Job | Event / Workflow State | Shard | Active | Install / Retry | Setup | Suite | Production | Cleanup | Non-Install |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [41452903152 / 125302223524](https://github.com/picoduck/wollipog/actions/runs/41452903152/job/125302223524) | Group / passing | 4 | 2459 | 6 / 0 | 37 | 2410 | 0 | 6 | 2453 |
| [41402864759 / 125138299192](https://github.com/picoduck/wollipog/actions/runs/41402864759/job/125138299192) | PR / passing | 4 | 2435 | 5 / 0 | 37 | 2389 | 0 | 4 | 2430 |
| [41460599954 / 125328333990](https://github.com/picoduck/wollipog/actions/runs/41460599954/job/125328333990) | PR / passing | 4 | 2429 | 5 / 0 | 31 | 2390 | 0 | 3 | 2424 |
| [41425751440 / 125211821546](https://github.com/picoduck/wollipog/actions/runs/41425751440/job/125211821546) | Group / passing | 4 | 2411 | 6 / 0 | 31 | 2371 | 0 | 3 | 2405 |
| [41452336906 / 125300343696](https://github.com/picoduck/wollipog/actions/runs/41452336906/job/125300343696) | PR / passing | 4 | 2410 | 8 / 0 | 49 | 2349 | 0 | 4 | 2402 |
| [41443010743 / 125269246564](https://github.com/picoduck/wollipog/actions/runs/41443010743/job/125269246564) | PR / passing | 4 | 2404 | 5 / 0 | 30 | 2366 | 0 | 3 | 2399 |
| [41425995908 / 125212621733](https://github.com/picoduck/wollipog/actions/runs/41425995908/job/125212621733) | Group / passing | 4 | 2402 | 6 / 0 | 31 | 2363 | 0 | 2 | 2396 |
| [41443044283 / 125269363299](https://github.com/picoduck/wollipog/actions/runs/41443044283/job/125269363299) | PR / passing | 4 | 2399 | 6 / 0 | 47 | 2343 | 0 | 3 | 2393 |
| [41397737745 / 125122630398](https://github.com/picoduck/wollipog/actions/runs/41397737745/job/125122630398) | PR / passing | 4 | 2395 | 6 / 0 | 32 | 2355 | 0 | 2 | 2389 |
| [41284066573 / 124781671550](https://github.com/picoduck/wollipog/actions/runs/41284066573/job/124781671550) | PR / passing | 4 | 2390 | 6 / 0 | 37 | 2343 | 0 | 4 | 2384 |

Per-shard non-install seconds on complete passing workflows, p50 / p90. This
phase-only table requires coherent timing for the individual Chromium job;
the complete-path table above requires no flagged job anywhere in the workflow.
Thus ALL/PR has 292 phase samples per shard versus 290 coherent whole-workflow
sets, and I/PR has 81 versus 79. Runs 41290984788 and 41290718119 have coherent
Chromium phases but flagged non-browser jobs. They remain valid phase evidence
without certifying the workflow's complete timing. Other displayed counts agree.

| Era / Event | Shard | N | Non-Install | Development Suite |
| --- | --- | --- | --- | --- |
| ALL / PR | 1 | 292 | 2006.00 / 2178.00 | 1873.00 / 2040.00 |
| ALL / PR | 2 | 292 | 1903.00 / 2121.00 | 1858.00 / 2088.00 |
| ALL / PR | 3 | 292 | 1989.00 / 2175.00 | 1941.00 / 2136.00 |
| ALL / PR | 4 | 292 | 2093.00 / 2294.00 | 2053.00 / 2263.00 |
| ALL / PR | 5 | 292 | 1904.00 / 2118.00 | 1862.00 / 2079.00 |
| ALL / Group | 1 | 242 | 2009.00 / 2182.00 | 1872.00 / 2047.00 |
| ALL / Group | 2 | 242 | 1922.00 / 2121.00 | 1883.00 / 2085.00 |
| ALL / Group | 3 | 242 | 2013.00 / 2175.00 | 1966.00 / 2138.00 |
| ALL / Group | 4 | 242 | 2097.00 / 2276.00 | 2060.00 / 2238.00 |
| ALL / Group | 5 | 242 | 1951.00 / 2112.00 | 1912.00 / 2074.00 |
| I / PR | 1 | 81 | 2021.00 / 2205.00 | 1895.00 / 2068.00 |
| I / PR | 2 | 81 | 2049.00 / 2153.00 | 2014.00 / 2114.00 |
| I / PR | 3 | 81 | 2015.00 / 2213.00 | 1979.00 / 2171.00 |
| I / PR | 4 | 81 | 2214.00 / 2337.00 | 2179.00 / 2293.00 |
| I / PR | 5 | 81 | 2000.00 / 2137.00 | 1962.00 / 2101.00 |
| I / Group | 1 | 72 | 2118.00 / 2213.00 | 1988.00 / 2075.00 |
| I / Group | 2 | 72 | 2066.00 / 2146.00 | 2032.00 / 2114.00 |
| I / Group | 3 | 72 | 2124.00 / 2203.00 | 2089.00 / 2168.00 |
| I / Group | 4 | 72 | 2196.00 / 2297.00 | 2163.00 / 2264.00 |
| I / Group | 5 | 72 | 2014.00 / 2121.00 | 1981.00 / 2086.00 |
| J / PR | 1 | 22 | 1911.00 / 2220.00 | 1781.00 / 2070.00 |
| J / PR | 2 | 22 | 2121.00 / 2204.00 | 2089.00 / 2164.00 |
| J / PR | 3 | 22 | 2151.00 / 2201.00 | 2116.00 / 2160.00 |
| J / PR | 4 | 22 | 2153.00 / 2399.00 | 2118.00 / 2349.00 |
| J / PR | 5 | 22 | 2134.00 / 2187.00 | 2099.00 / 2151.00 |
| J / Group | 1 | 18 | 1846.00 / 2228.00 | 1728.00 / 2080.00 |
| J / Group | 2 | 18 | 2046.00 / 2177.00 | 2013.00 / 2139.00 |
| J / Group | 3 | 18 | 2032.00 / 2171.00 | 1999.00 / 2138.00 |
| J / Group | 4 | 18 | 2320.00 / 2405.00 | 2290.00 / 2371.00 |
| J / Group | 5 | 18 | 2030.00 / 2178.00 | 1994.00 / 2138.00 |

## Timestamp Conflicts and Missing Measurements

The source timestamps are preserved. On November 1, job 124786960842 in PR run
41285878818 reports 07:43:45–09:22:00 UTC (98.25 minutes), while its final
`Complete job` step finishes at 08:21:58. Its API and check-run completion times
agree on 09:22:00; rereading both confirmed the discrepancy. The same run's
aggregator 124795175899 reports starting at 09:24:05, but its executed final step
finishes at 08:24:06, **before the job start**. Group 41286408849 has the same
pattern. These are unresolved timestamp-domain conflicts, not established cache
hangs, extra test execution or a proved daylight-saving-time cause.

The audit flags 320 job records across 36 first attempts.
Job `timingQuality` retains the reason, terminal gap and out-of-interval step count.
An unexplained gap beyond the model's 180s reserve or a step outside its job
interval makes allocation unmeasured. This does not change the forge outcome,
remove a source record, skip tests or subtract a guessed hour. Primary performance
uses coherent records; the raw view above retains reported 97–98 minute tails.
Actual allocation for flagged jobs is unknown, so their reported elapsed minutes
are separate from the coherent consumption lower bound. A timestamp-source
reconciliation would be needed to include them in an execution sizing envelope.

| Event | Non-Skipped Chromium Records With Missing Elapsed Timing | Complete Passing Sets / Coherent Sets |
| --- | --- | --- |
| pull_request | 200 | 300 / 290 |
| merge_group | 25 | 244 / 242 |
| push | 0 | 8 / 8 |

Seven GitHub-passing PR workflows and two passing groups lack a complete measured
five-shard set; their passing statuses do not fill missing timing with zero. The
missing values include backwards job intervals. Cancelled jobs without executed
step evidence also remain unmeasured, not allocated runner time. All observed
workflow states are terminal at collection; unfinished remains a distinct state
in the export schema rather than an implicit success.

## Setup, Auxiliary Coverage and Test Retries

Successful, coherent first-attempt Chromium jobs only; this install cohort omits
failed pre-test jobs and therefore cannot estimate the population install failure
rate. Presence of the package-resolution step identifies configured cache phases,
not an exact hit or zero network transfer. Browser binary and apt caches differ.

| Package Cache Phases Configured | Jobs | Jobs With Executed Install Retry | Install+Retry Seconds p50 / p90 / Max |
| --- | --- | --- | --- |
| False | 47 | 6 | 17 / 383 / 603 |
| True | 3309 | 2 | 6 / 8 / 399 |

The conditional Windows comparison has 928 first-attempt job records:
0 passing, 0 failing, 5 cancelled,
923 skipped, 0 unfinished, 0 unmeasured
outcomes. Detection jobs are not counted as comparisons. A skipped comparison
is not a fast successful execution. WebKit and production remain independent
routes in the inventory contract; production runs sequentially on shard 1 and
is included in every complete Chromium job and path above. No faster Windows
claim is made.

Selected bounded reporter projections:

| Run | Complete Development Projections | Development Attempts / Skips | Production Attempts | Failed / Retry-Only |
| --- | --- | --- | --- | --- |
| [40069935046](https://github.com/picoduck/wollipog/actions/runs/40069935046) | 5/5 | 3675 / 129 | 55 | 0 / 0 |
| [40058408892](https://github.com/picoduck/wollipog/actions/runs/40058408892) | 5/5 | 3675 / 129 | 55 | 0 / 0 |
| [41464742872](https://github.com/picoduck/wollipog/actions/runs/41464742872) | 5/5 | 3942 / 151 | 57 | 0 / 0 |
| [41465192009](https://github.com/picoduck/wollipog/actions/runs/41465192009) | 5/5 | 3949 / 151 | 57 | 0 / 0 |

These counts describe selected identified runs, not a population zero-flake rate.
Other jobs' within-test retry rates remain unmeasured. The maximum coherent
phase job also has a matching safe projection with 761 development attempts,
five skips and zero failed/retry-only attempts. The anomalous job's 723 attempts,
six skips and zero failed/retry-only attempts do not explain its reported extra
hour. No raw log bodies, test titles, session data or runner identities are saved.

## Baseline Comparison and Budget Decision

The October 22 baseline has 175 PR first attempts (8 failing), 75 groups (6
failing), seven PR reruns and six retry-only PR recoveries. Here the corresponding
counts are 668/48, 330/33, 42 PR reruns and 25 retry-only PR runs; two group reruns
yield no retry-only recoveries. The all-first failure fractions are 7.19% PR and
10.00% group, versus 4.57% and 8.00%. Cancellation/admission mix, evolving tests,
cache incidents and competing CI demand differ. These do not establish a causal
reliability regression or improvement from scheduling.

Coherent passing groups have longest/shortest p50/p90 **1.418/1.578**, below the
old 1.54/1.81; longest/median is **1.080/1.297**. However maximum-active p50/p90
is **35.98/38.02 minutes**, compared with the old shard-5 median/p90 35.1/38.2.
The expanded sample therefore does **not demonstrate a sustained reduction in
the longest browser execution path**. Complete path p50/p90 is 36.77/51.18m;
its creation-to-result scope differs from the baseline required-result 40.2/64.1m.
The compact baseline lacks browser job detail to reconstruct browser-only sums,
longest/median or this exact complete path. Missing baseline measurements stay
unavailable; all-job baseline runner-minutes 173.0/185.3 cannot stand in for five
browser jobs. No causal queue or resource improvement is claimed.

The profile forecast of 1665.186s max, ratio 1.0013 and 8305s development-plus-
production sum excludes setup and is not a natural passing full-run sample.
The pre-merge PR 40007510456 measured 33.65m maximum, ratio 1.0197 and 162.533
Chromium runner-minutes. Expanded coherent passing groups have 35.98m maximum
at p50, ratio 1.080 and 159.68 Chromium minutes at p50. The change in workload
and setup means these are descriptive observations, not matched causal tests.

Later shard 4 is heavier: era J group non-install medians (1–5) are
1846 / 2046 / 2032 / 2320 / 2030 seconds. This supports fresh whole-file calibration
within #3628 rather than claiming the old weights are optimal. This measurement
change retains weights: changing them without a refreshed representative profile
and subsequent natural validation would not prove a smaller measured envelope.
The smallest immediate reconciliation is a phase allowance update. Performance
validation remains open in the existing issue; no duplicate issue is proposed.

The largest coherent observed remainder is **2453s**, job
125302223524 in natural group 41452903152; all five jobs of
the latest passing group 41465192009 are added to the phase fixture as well.
The former 2078s merge-group observation and all five of its jobs remain recorded.
Round 2453s to **2460s**. With unchanged configured bounds:
`720 + 2460 + 480 + 180 + 480 + 180 = 4500s`.
The smallest whole-minute cap is **75m (4500s)**, leaving
180s residual reserve. The 68m cap is 420s short of
that model. Five jobs, full discovery, serial fixtures, failOnFlakyTests,
ports, server ownership and sanitization remain unchanged; WebKit stays 29m.
This adds seven minutes of possible Chromium hang occupancy relative to 68m,
not ordinary runtime improvement. It does not cover or explain the inconsistent
timestamp records: using their raw 5889s remainder to invent a 133-minute cap
would mistake unknown allocation for measured workload. Future coherent workloads
or setup changes require remeasurement; the equation is not a hosted guarantee.

## Reproduction and Acceptance

Collection uses `collectEvents` from `scripts/merge-queue-wait-report.mjs`, wrapped
with `cachedApi` from `scripts/ci-runner-occupancy.mjs` (1500-call floor, response
cache), and explicit nonoverlapping day windows plus the #3650 boundary. First
attempts and reruns use their own snapshots. A rate-limit refusal interrupted
collection; the refused response's reset was honored and the cache resumed.
One later transport timeout also resumed from cache. Every day completed, no
run/attempt/job/history pagination was truncated (ten pages of 100; ten attempts).
The source quota endpoint disagreed with a refusal, so no zero/missing day was
substituted. The separately recorded one-hour occupancy observation in the earlier
checkpoint is not extrapolated to this larger period.

From this revision, replay the standard tools offline:

```sh
node scripts/merge-queue-wait-report.mjs --input docs/ci-browser-shards-2026-11-02.json
node scripts/ci-reliability-report.mjs --input docs/ci-browser-shards-2026-11-02.json
```

For live collection, supply `--repo picoduck/wollipog --all-events --since <UTC>
--until <UTC> --json` to the same collector; slice at the boundaries above and
daily UTC midnights to stay below the search cap. `readTimingLog` uses the
`ci-timing.mjs` safe projection; only 22 identified job projections were selected,
not all logs. Matching run/attempt context is required.

`browserMeasurement` retains per-run reported ratios, max, complete path, sums,
wait and phase records. Reproduce the main performance table by filtering first attempts,
event, `epoch`, state `passing`, a complete `browserMeasurement` and no job
`timingQuality`. Sort each metric and select element `ceil(n*p)-1` for p50/p90.
The per-shard phase table instead applies `timingQuality` only to that shard's
job, retaining coherent phases when a non-browser job is flagged. Raw performance
tables omit the `timingQuality` filter. Derive non-install seconds from
job elapsed minus executed install/retry steps; setup is job start to suite start
minus those installs; cleanup is the residual after setup, suite and production.
Skipped steps explicitly retain state and null duration. Unrelated step detail is
omitted from the compact export; original run metrics remain unchanged.

Acceptance disposition:

1. **Met previously:** #3644's recorded profile and serial/shared-resource constraints.
2. **Measurement met; reduction not met:** expanded identified natural runs and all
   requested comparisons are recorded. Sustained longest-path reduction is not
   demonstrated; representative whole-file calibration and new natural validation
   are needed in #3628. Baseline and timestamp limitations are explicit.
3. **Preserved:** five-project inventory, new-file discovery, matrix agreement,
   production, independent WebKit and conditional Windows routes. Runtime skips
   are distinguished from inventory proof.
4. **Preserved:** workers, serial fixtures, ports, ownership, flaky handling and
   diagnostic sanitization have no behavioral changes.
5. **Reconciled for coherent measured phases in draft:** 2460s floor and
   derived 75m cap. Unknown allocation records cannot certify an
   all-observation bound; timestamp reconciliation is still needed. Review,
   exact-head CI, ready-slot and actual merge remain delivery gates. The separate
   #2700 margin streak and #3649 cache-path acceptance are not claimed complete.
