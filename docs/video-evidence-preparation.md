# Video Evidence Preparation

Issue #1321's image delivery, artifact-only decisions, browser coverage, provider-retention
disclosure, video artifacts, human fallback, and dormant short-video candidate are already merged.
The candidate remains operator-only and default-off. It accepts at most four seconds, sixteen
frames, 640×360, and silent WebM/VP9. Real model-visible delivery and token/latency/cost measurements
remain unproven. Neither deterministic tests nor image capability establishes temporal review.

## Independent Preparation Profile

`paced-silent-video-preparation-v1` is an **offline preparation profile**, not an advertised model
capability or an enabled review profile. It prepares ordinary paced recordings for an isolated
validation exercise without changing the running control plane, runner, campaign, or provider.

| Bound | Value |
| --- | --- |
| Source | One silent VP8, VP9, or H.264 video stream in WebM or MP4, at most 32 MiB |
| Duration | At most 30 seconds, starting at timestamp zero |
| Native Resolution | 960×540 through 1280×720; no resizing |
| Capture Rate | Up to 30 fps; minimum observed interval 33 ms allows millisecond container rounding |
| Coverage | Every source presentation frame, at most 900 frames |
| Output | Native PNG, at most 2 MiB per frame and 128 MiB total |
| Segments | Contiguous partitions, at most 120 frames and four seconds each |
| Decoder | Linux bubblewrap, network isolated, read-only input, empty environment |
| Resource Limits | Two active jobs, two queued, two-second queue deadline; 1 GiB address space, 15 CPU seconds and 20 seconds wall time per subprocess |

Record at normal playback speed. Wait for asserted UI readiness first, hold the opening state for
2–3 seconds, pause 1–2 seconds before an action, hold the settled result for 2–4 seconds, and end
with a 3–5 second readable hold. Use visible focus/pointer and capture-only shortcut annotations.
Split longer scenarios into focused recordings. Put pacing in an opt-in capture script, not product
code or ordinary regression tests. Human readability still needs review at 1×; pixel dimensions do
not prove that text is legible or that every acceptance criterion was captured.

Every frame's original presentation timestamp and display duration is retained in microseconds.
Display duration is the interval to the next source frame; the last frame requires an explicit
positive source duration. Duplicate visual frames are retained. A one-frame defect therefore
remains present even when adjacent frames look identical. Splitting partitions the ordered frame
sequence and retains absolute source timestamps; it does not transcode, seek, or sample the source.
A hold longer than four seconds is refused rather than represented as a segment exceeding its bound.

PNG conversion preserves decoded pixels at native dimensions. No frame-rate filter, speed change,
audio stripping, lossy re-encoding, or incomplete sequence is accepted. Audio/extra streams,
missing/ambiguous timing, varying dimensions, or insufficient resolution require recapture.
Excess duration/frame count requires smaller original clips; excess derived bytes or decoder work
requires splitting or recapture. Busy work queues rather than immediately asking a human. The CLI
retries only busy admission, at most twice with bounded delay. Unsupported isolation retains human
review. Failures never yield a partial manifest.

## Local Preparation

Use a synthetic sanitized recording and a new private output directory:

```sh
node --import tsx apps/control-plane/scripts/prepare-video-evidence.ts \
  --source /absolute/path/scenario.webm \
  --output /absolute/path/new-private-package \
  --media-type video/webm
```

The command reads a bounded stable regular file, refuses source symlinks and existing output
directories, creates private PNG files and `manifest.json`, and prints only hashes/counts. It makes
no network request, uploads nothing, calls no model, and creates no workflow decision or receipt.
Output filenames derive from source frame index. SHA-256 of the exact UTF-8 `manifest.json` bytes
is the reported manifest digest. The manifest binds source bytes/type/size, native dimensions,
every image digest/size, order, timestamp, duration, profile version, and contiguous segments.
Local hashes detect changes, but a caller-authored manifest is never trusted derivation or approval.
Future runtime integration must independently derive it from the immutable Session artifact.

To verify an existing package, use the same source with `--verify-directory` in place of `--output`.
Verification independently decodes the source again and compares the exact manifest, file list,
and every frame's bytes. Changed timing, reordered/missing frames, extra files, source substitution,
and symlinked frame inputs fail verification. It reports `localDerivationVerified`, which proves
current local integrity only. It still reports `deliveryValidated: false` and `productionEnabled: false`;
it grants no capability, receipt, decision authority, or quality approval.

## Isolated Live Validation Handoff

Preparation alone cannot satisfy live delivery. An operator must authorize a dedicated isolated
validation service and exact reviewing Session; campaign agents must not set the operator-only
validation environment variable or restart/reconfigure the hosting stack. The existing dormant
candidate's four-second limit remains in place. Longer prepared sequences cannot be submitted as
ordinary image evidence to bypass its video boundary.

Before a live exercise, record an exact declaration: source and manifest digests, profile, model,
harness/client versions, every required frame, provider retention disclosure, authorized audience,
maximum input/output tokens, maximum elapsed time, maximum cost, and who may perform the effect.
Use the existing sixteen-frame candidate first to prove its real transport and maximum-profile
cost. A separate explicitly authorized normal-profile exercise is required afterward. Keep a
synthetic one-frame challenge's expected content in a private oracle outside the review packet;
do not name or describe the transient to the model in advance. Require ordered model-visible
delivery of **every** source frame, exact timestamp/duration bindings, and independently observed
transient recognition. Record actual provider usage and elapsed time, and calculate actual cost
from the selected provider's verified pricing. Unknown usage, pricing, missing frames, or a budget
overrun leaves validation incomplete. Do not invent successful receipts from local preparation.

Delivery and quality are separate records. A future server-verifiable delivery receipt must bind
the reviewer, source artifact/digest, derivation/profile/manifest digest, every frame's digest/order/
timing, child, controlling Session, decision occurrence, policy revision, and campaign audience.
The reviewer verdict must separately list acceptance criteria, observed defects, approve/deny and
rationale. A transport acknowledgement is never a quality verdict. The authorized typed decision
owner resolves only after validating reviewer provenance and complete current receipts.

## Remaining Integration Dependencies

- #2934 supplies the server-owned campaign `control` contract and versioned human boundary. This
  preparation slice introduces no campaign mode, authority field, or competing evidence toggle.
- #2936 supplies the limits/allowance contract. A human-authorized compatible reviewer worker must
  inherit or narrow scope, audience, evidence access and allowance. The implementer cannot approve
  its own work; worker messages are not approvals.
- Live delivery/cost validation must precede production enablement. The production service must
  gate all source/derived integrity, occurrence, policy, audience, capability, ownership and grant
  revocation using the existing artifact/typed-decision contract; old/mixed peers fail closed.
- Full Control's disclosed destination/provider authorization and bounded recovery belong to those
  contracts. Custom mode keeps human fallback. Attach the same exact relevant capture at recording
  time for external evidence; never fetch arbitrary child URLs from a privileged service.

These are remaining criteria of #1321, not new issue recommendations. This preparation path does
not claim Full Control reviewer routing, production video approval, or completed live validation.
