# Synthetic Browser Failure Artifacts

The Ubuntu CI browser shards retain diagnostics only for failed attempts in
`app-container.spec.ts` and `ci-failure-artifacts.spec.ts`. A successful test step
never runs the sanitizer or upload. Existing CI retries (two) and fail-on-flaky
rules remain unchanged, and a failed test step remains failed even when diagnostics
are missing or their upload fails. The required aggregator reads that job result.

The JSON reporter selects attachments from the exact failed shard. Only complete
trace/error-context pairs are retained from the first three failed attempts per
shard, for three days. Rejected/missing pairs count toward that attempt budget;
later candidates are not scanned for retention. A failed attempt that passes on
retry remains eligible when fail-on-flaky fails the test step. A successful step
still uploads nothing. Input reports are capped at 32 MiB; each input capture at 16 MiB;
ZIP archives at 128 entries and 32 MiB expanded; each projected trace at 8 MiB
expanded, with at most 20,000 records and 1 MiB per line. Error contexts retain at
most 2,000 structural lines. Each shard uploads
only the generated manifest and those trace/context pairs, never raw results,
reports, workspace files, screenshots, videos, or unrelated attachments.

The standard-library Python 3 sanitizer projects the pinned Playwright v9 trace
schema. It retains interaction classes/methods, times, pointer geometry, hashed
identities and DOM structure. It excludes free-form strings and keys, attributes,
network data, cookies, credentials, headers, prompts, transcripts, private URLs,
source code, attachments and images. Only four fixed synthetic fixture labels can
survive as DOM text. Error context retains accessibility roles and indentation
with fixed synthetic labels. Unknown trace versions and malformed captures fail
closed; missing either capture drops the entire pair. Diagnostic output includes
only fixed messages and counts, never raw exception text or input filenames.

This deliberately limits diagnosis: original pixel frames, styling, source code
and free-form text are unavailable. Trace Viewer still shows interaction timing,
structural before/after snapshots and pointer geometry. A manifest records run,
attempt, shard, source head, fixed output paths, byte sizes and SHA-256 digests.

To validate on CI, dispatch `ci.yml` on the reviewed issue branch with
`synthetic_failure_artifacts=true`. Only that manual event selects the isolated
mocked fixture; normal PR, main and merge-group events retain the full suite.
Each of the five shard projects deliberately fails, exercises retries and publishes
its own bounded sanitized captures. All five browser jobs and the required aggregate
must fail. This is separate from final
merge verification. Sanitizer and upload wiring must receive cross-model review
before that first upload is enabled. This does not authorize real hosting-session
captures or change manual Session Artifact Uploads preferences.

Download the run's `synthetic-browser-failure-<run>-<attempt>-shard-<shard>` artifact,
verify its manifest/digests and inspect the trace with the pinned viewer:

```sh
pnpm exec playwright show-trace /absolute/path/synthetic-failure-1/trace.zip
node scripts/inspect-sanitized-browser-trace.mjs /absolute/path/synthetic-failure-1/trace.zip
```

The inspection helper starts a temporary loopback viewer, confirms a Click action
and its synthetic DOM snapshot, and closes its browser/server. It never uploads.
Regression coverage uses synthetic secret/prompt/transcript/cookie/auth/personal/
private-URL/error sentinels in trace fields, DOM, resources, context and metadata.

## Verified CI Receipt

This historical receipt predates the duration-based shard projects in #3628.
Its single failing shard and single artifact describe that recorded run; current
synthetic dispatches select the probe on all five projects as described above.

The first bounded validation used reviewed source head
`7f8514d922a3d1c4a3d0fd19190f83ad25341696` in
[workflow-dispatch run 38229323685](https://github.com/picoduck/wollipog/actions/runs/38229323685),
attempt 1. [Browser shard 1, job 114744610756](https://github.com/picoduck/wollipog/actions/runs/38229323685/job/114744610756)
failed its actual browser test step; sanitizer and upload steps succeeded. Shards
2–5 passed and skipped both diagnostic steps. Unit/typecheck/bundle jobs passed.
The whole run and
[required aggregate, job 114757001139](https://github.com/picoduck/wollipog/actions/runs/38229323685/job/114757001139)
finished **failure**, preserving the deliberately failing test result.

The run published exactly one artifact: `11738877959`, named
`synthetic-browser-failure-38229323685-1-shard-1`, 11,394 bytes, digest
`sha256:a11a3859fdddcb93ef064c57235b13ffbac00f2b45d82782995ac3d5d4d1dad5`.
Its three-day expiry is 2026-10-15 09:47:06 UTC. Downloaded contents matched the
manifest's exact run/head/shard, three failed attempt pairs and zero rejections:

| Attempt | File | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| 1 | `trace.zip` | 3591 | `4c8dd4d1204aa3b13b28622c6c336cc19df309d85e634e79bacf0033f2c57520` |
| 2 | `trace.zip` | 3582 | `9276e9611a3631174188d43db2a1002c5ecf414001bb0a046cdeb63385ec4dd4` |
| 3 | `trace.zip` | 3587 | `9944a669989ef875ed11d84ede809779e1d35067ad461733610be049e0e1e46d` |
| 1–3 | `error-context.md` (each) | 227 | `f53f4762cf16f0c2afa38b29c3f69fe602011369303d8854e3adb24c1ee40c03` |

Independent child and parent download inspections verified every file size and
hash, all eight sensitive sentinels absent, empty network entries and no extra
resource/image/source files. Each downloaded trace has 90 records, respectively
16,422, 16,421 and 16,424 expanded bytes. The pinned viewer helper inspected all
three traces: Click, Before `Synthetic Ready`, After `Synthetic Complete`, zero
page errors. The parent independently checked attempt 1 in that viewer.

This intentionally failed dispatch is evidence of diagnostic retention and
failure preservation. Final normal PR and current merge-group verification use a
separate head and the full suite; this receipt does not substitute for either.
