# Inbox JavaScript Budget

The production inbox entry is limited to **1,250,000 raw JavaScript bytes**. Both browser and
desktop builds enforce this in `apps/web/src/entry-bundle-budget.ts`. The measurement includes
the entry and every transitive static JavaScript import, counting shared chunks once. Splitting
a vendor into a static chunk cannot hide its cost. Dynamic imports are excluded until their
surface is opened. The build also rejects eager SessionDetail, terminal, settings, pairing,
New Session, and Connections implementations.

Every application build writes `entry-bundle-report.json`, with final emitted raw, gzip, and
brotli bytes for each initial chunk. The packaging tests compare its raw total with files on
disk. Small chunks below the existing compression threshold have no compression sidecars;
the report's compressed sizes describe potential compression, regardless of sidecar presence.

The baseline for #2768 is commit `44ae56640cb558b9f804657b980f7c859276ec20`: its single initial
JavaScript file is 2,912,440 raw bytes. Preserve that revision's production `apps/web/dist` in
a separate directory before comparing builds. Build it in a disposable checkout with the
revision's lockfile and dependencies; keep the benchmark harness from the new revision.

```sh
pnpm --filter @wollipog/web build
pnpm benchmark:inbox --dist /absolute/baseline-dist --runs 7 --output /tmp/inbox-before.json
pnpm benchmark:inbox --dist apps/web/dist --runs 7 --output /tmp/inbox-after.json
```

Run both on the same idle host; repeat in alternating order when comparing small differences.
The harness uses Chromium, a fresh context for each load, disabled HTTP/browser caches,
4× CPU throttling, and a 390×844 viewport. It intercepts API and WebSocket traffic with twenty
deterministic synthetic sessions and one synthetic runner. No production data or control plane
is used. It asserts that the inbox renders without uncaught errors, records the longest traced
script/module evaluation and browser-observed long task, and reports medians and individual
samples. Total script duration and first contentful paint are also recorded. Browser throttling
is a reproducible comparison, rather than a claim about a particular physical phone.

Optional `--evidence /tmp/inbox-captures` saves a ready inbox screenshot. `--width 1440` exercises
the desktop preview: SessionDetail is requested when that visible preview mounts. At phone
width, it remains deferred until a session is opened. Opening a secondary view, dialog, QR
pairing, or the terminal likewise requests its content-hashed chunk on demand.

Lazy surfaces use the existing State, session placeholder, and preview skeleton components.
Loading dialogs retain their original opener across the loading/content transition. Import
failures are handled by the existing error boundaries with reload recovery. The service worker
continues to have no fetch handler, and desktop packaging still excludes PWA assets while
including all locally served lazy chunks. Production browser coverage lives in
`apps/web/e2e/inbox-lazy.spec.ts`.
