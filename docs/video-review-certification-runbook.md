# Video Review Certification Runbook (#1321)

The exact procedure a Human owner or admin of the personal organization follows to certify the
Claude Code media-only video reviewer on the deployed Wollipog. Only that Human performs it.
Agents, including the Orchestrator and its children, never mint permits, record proofs or revoke
them; every route below refuses a Session credential.

**Dependency.** Steps 1–3 and 7–8 work with PR C (#3401) and this PR. Steps 4–6 need **PR E of the
#1321 PR D slice** (Human validation permits and validation runs), stacked on this PR: it adds the
Human-only permit mint route, the trusted scope adapter and the validation dispatch and inspection
path. Until PR E is merged and deployed, no permit can be minted, and the metered runs in step 5
cannot be started.

## Prerequisites

- The deployed control plane and runner include PR C, this PR and PR E.
- The reviewer machine is a non-root Linux runner with unprivileged user namespaces and a Node
  runtime (not a single-executable runner).
- It has a native Claude Code agent on CLI `2.1.296` offering `claude-opus-5-5` at `high` effort.
- A dedicated Anthropic API key is at `<runner data dir>/media-reviewer/<agentId>/anthropic-api-key`
  as a regular, runner-owned file with mode `0600`. Never use your own Claude login. After
  provisioning, restart the runner.
- **Settings › Orchestrator › Video Evidence Review** lists the machine as **Not Certified**. Any
  other reason on that row must be fixed first.
- You have set a provider spending limit on that key that covers three runs. Each run's own ceiling
  is $10 and 120 tool calls.

## Procedure

1. **Probe the namespace (offline, no model call).** Create an operator-only directory, mode
   `0700`, outside every workspace, runner data directory and provider HOME. The oracle will be
   created inside it. On the reviewer machine, run:

   ```sh
   pnpm probe:claude-media-reviewer --agent-id <agentId> --data-dir <runner data dir> \
     --forbidden <operator-only dir>
   ```

   It must print `"supported": true` with the attestation and `attestationSha256`, and it must refuse
   any overlap between the reviewer namespace and the forbidden directory. Record
   `attestationSha256` and `attestation.namespacePolicySha256`. Any refusal stops here.

2. **Generate the blind challenge, only after the probe.** Use a new capture directory and a new
   oracle directory inside the step 1 operator-only directory. Both paths must be absolute, neither
   inside the other, with real (non-symlinked) parents:

   ```sh
   node --import tsx apps/control-plane/scripts/prepare-video-live-challenge.ts \
     --capture-dir <new capture dir> --private-oracle-dir <operator-only dir>/<new oracle dir>
   ```

   It writes `candidate.webm` (16 frames, 640x360, 4 s), `paced.webm` (360 frames, 1280x720, 12 s),
   `maximum.webm` (900 frames, 1280x720, 30 s) and `challenge.json`, plus `oracle.json` in the oracle
   directory. Paced and maximum each place a transient in delivery window 1 or 2. Record the printed
   `oracleCommitmentSha256`. Do not open, paste or attach `oracle.json` anywhere an agent can read it
   until step 6. Never reuse a challenge, a fixture recipe or an earlier oracle.

3. **Attach the three captures as UI evidence.** In a campaign whose UI Evidence Approval stays with
   you, a child Session attaches each `.webm` file as a private Session artifact and requests one
   `ui_evidence_approval` gate per capture. Each gate must be Human-owned and pending, with the exact
   `artifactId`, `video/webm` and `sha256`. Leave all three gates pending.

4. **Mint one permit per run (PR E).** For each gate, mint a validation permit for its profile
   (`candidate`, `paced` or `maximum`) with the exact scope digest that the PR E route shows you,
   including the step 2 oracle commitment. A permit expires within one hour, is single-use and cannot
   be replayed. A changed source, criteria, policy revision or reviewer attestation invalidates it.

5. **Run the three metered validations (PR E).** Start each run from its permit, in the order
   candidate, paced, maximum. Each run must deliver every source frame in order and finish with a
   verdict tool call. A run that stops early, reports `unknown`, or has unpriced usage counts as a
   failure (see below).

6. **Inspect each run yourself.** Only after a run finishes, open `oracle.json` and compare it with
   the verdict. Every transient's colour, geometry, frame order and exact source presentation time
   must match. Using PR E's inspection view, also confirm:

   - the complete ordered receipt set and the model-visible delivery evidence;
   - provider-reported usage, latency and cost at current official pricing;
   - that the source and artifacts still match their digests;
   - that the step 1 probe still holds for the attestation the run used.

7. **Record the proof.** Post the exact reviewer target and the three inspected runs to the
   Human-only ingress, signed in as the owner or admin who inspected them:

   ```http
   POST /api/video-evidence/live-validations
   { "target": { ..., "providerId": "claude-code", "modelId": "claude-opus-5-5", "effort": "high" }, "runs": [candidate, paced, maximum] }
   ```

   The target's `capabilitiesSha256` and `reviewerNamespaceSha256` must equal the step 1
   `attestationSha256` and `namespacePolicySha256`, which are the runner's current attestation.
   Otherwise the route answers `attestation_mismatch`. Each run's
   `inspectedByUserId` must be your own user ID.

8. **Confirm.** Settings shows the machine as **Certified** with its dates. The proof expires 30
   days after recording. Re-certify before then with a fresh challenge (steps 1–7). A changed CLI,
   executable, namespace, key arrangement, model or effort changes the attestation, and the row
   returns to **Not Certified**.

## On Failure

- Do not record a proof. A mismatch, missing frame, early stop, unknown dispatch or unpriced usage
  leaves video evidence with you, which is the safe state.
- Leave an `unknown` run's reservation alone; it reconciles from the runner's durable record and is
  never replayed. Resolve the three gates yourself.
- Revoke any proof you are no longer sure of: `POST /api/video-evidence/live-validations/<proofId>/revoke`.
  Revocation ends media access, verdicts and provenance for that reviewer at once.
- Discard the challenge and oracle directories, generate a new challenge and start again from step 1.
  Never retry with the same oracle.
