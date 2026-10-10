# Session List and Dashboard Snapshot Performance

Run `pnpm benchmark:session-list` in the repository worktree with dependencies installed. It creates
and removes a disposable SQLite database containing 2,000 synthetic sessions; it does not use a
running Wollipog stack or user data. Seeding uses normal SQLite durability, then restores the
production full durability setting before measurement.

The benchmark uses the production database projection and Hub through a local Fastify injection.
After five warm-up requests it measures 50 cache-hit requests and 20 requests invalidated by a write.
Ten connection runs each attach four authenticated dashboards with asynchronous socket callbacks;
each run invalidates the cache first. A continuous `setImmediate` heartbeat measures the largest
event-loop gap through query, hydration, encoding, and frame delivery. Run without competing builds
or test suites for comparable timing results. Fastify injection excludes network latency.

The script asserts both REST p95 measurements are below 50 ms, every dashboard-run heartbeat gap is
below 50 ms, and each snapshot frame fits the 8 MiB per-client buffer. It prints the measured timing,
REST/snapshot bytes, largest frame, and buffer cap as JSON. Query-count regressions are tested in
`session-list.test.ts`: seven SQL reads for the plain inventory, plus one bounded bulk read when
pending requests need structured child-owner observations and one when holds have owed decision
resumes, plus one authorized aggregate read for campaign child-request counts when a root is listed.
Reminders use one authorized bulk query. Query count is independent of session
count, with audience predicates applied in SQL.

The same 2,000-session inventory includes one campaign root and a child request. After connect
measurements, four distinct authorized principals receive 20 root broadcasts, each immediately
after a database write. The benchmark asserts both the synchronous broadcast and its continuously
measured event-loop gap stay below 50 ms. It then archives the inventory and measures one archived
root's request facts. Those facts use two indexed, root-scoped SQL reads (bounded ancestry and
authorized descendant/controller requests), never the serialized live/archive list cache. Tests
pin the two-query count with 2,000 unrelated archived rows and preserve audience/token/64-row
ancestry semantics. List and detail aggregate the same request classifications and identities.

REST caches the serialized authorized list for the exact principal and archived filter. Both local
writes and other SQLite connections invalidate it. Dashboard connects share an in-flight and
serialized snapshot for the same exact principal and protocol; hydration yields every 128 rows and
encoding yields every approximately 128 KiB page. Caches retain at most four entries and 32 MiB of
serialized bytes each. These byte limits measure retained wire data rather than JavaScript heap.

Protocol v212 dashboards receive a metadata header followed by session pages, draining one frame at
a time before live deltas. Access revisions trigger one bulk recheck of captured session/reminder
ids; loss of audience access interrupts pending pages. Ordinary writes do not interrupt loading.
Older dashboards keep the complete single-frame contract; an oversized inventory closes before any
snapshot is sent. A metadata header or individual summary exceeding the hard cap also closes rather
than retaining an oversized frame. Runner, project, and global administrator inventories are not
paged by this change.

The lightweight `projection: "summary"` keeps list identity, status, attention/acknowledgment,
ownership verdicts, cost counters, and actionable recovery metadata. Request bodies, provider
capabilities, full worktree inventories, queues, and campaign inventories remain on the authorized
session detail endpoint. One compact active-worktree identity retains the list's branch/base/PR
metadata. Web previews, visible Board request cards and Session pages hydrate detail before rendering controls;
runner tools use the existing `get_session` surface for full metadata. Native clients use the same
web store and API contract. No history query or history recovery algorithm is changed here.

Summary snapshots include the Hub's compact live queue hold and active-turn coordinates; prompt
bodies remain detail-only. The authorized lookup overlays the live queue after authorization.
Hydration fences late responses against newer live rows, removal, and snapshot generations, and
preserves same-epoch live state from older lookup endpoints. Full-snapshot peers retain their
existing refresh behavior; mounted detail revalidation runs once per summary snapshot generation.
