# Synthetic Browser Failure Artifacts

The Ubuntu CI browser shards retain diagnostics only for failed attempts in
`app-container.spec.ts` and `ci-failure-artifacts.spec.ts`. A successful test step
never runs the sanitizer or upload. Existing CI retries (two) and fail-on-flaky
rules remain unchanged, and a failed test step remains failed even when diagnostics
are missing or their upload fails. The required aggregator reads that job result.

The JSON reporter selects attachments from the exact failed shard. Only complete
trace/error-context pairs are retained, at most three attempts per shard, for
three days. Input reports are capped at 32 MiB; each input capture at 16 MiB;
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
One shard deliberately fails, exercises retries and publishes sanitized captures;
the browser job and required aggregate must fail. This is separate from final
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
