# Video Review Certification Runbook (#1321)

The exact procedure a Human owner or admin of the personal organization follows to certify the
Claude Code media-only video reviewer on the deployed Wollipog. Only that Human performs it.
Agents, including the Orchestrator and its children, never mint permits, record proofs or revoke
them; every route below refuses a Session credential.

**Dependency.** Every step needs PR C (#3401), PR D (Settings, preflight and this runbook) and PR E
(Human validation permits and runs) merged and deployed.

## Prerequisites

- The deployed control plane and runner include PR C, PR D and PR E.
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

3. **Attach the three captures as UI evidence.** Launch a Full Control campaign yourself, with UI
   Evidence Approval delegated and its root on the attested Claude Code agent at `claude-opus-5-5`, so
   that its evidence envelope names that reviewer under provider `claude-code`. A child Session
   attaches each `.webm` as a private Session artifact and requests one `ui_evidence_approval` gate
   per capture, with the exact `artifactId`, `video/webm` and `sha256` from `challenge.json`. While
   no proof exists, each video gate is Human-owned. Leave the gates pending and keep the child Session
   running until the runs finish, because a pending gate needs a live child.

4. **Mint one permit per run.** Every call below is made signed in as you; Session credentials are
   refused. For each gate, first preview the exact scope. The server derives the capture with its
   isolated decoder and refuses a capture that does not fit the profile:

   ```http
   POST /api/video-evidence/validation-permits/preview
   { "occurrenceId": "<gate occurrence>", "evidenceId": "<evidence id>", "profile": "candidate",
     "privateOracleCommitmentSha256": "<step 2 oracleCommitmentSha256>" }
   ```

   Check the returned `scope`:
   - `gate.authority` is `human` and its status is `pending`;
   - `source.sha256` is the capture's digest, and its frame count, size and duration match the
     profile;
   - `target` is the step 1 attestation;
   - `request` carries the $10 and 120 tool-call ceilings.

   Then mint with the returned digest and an expiry at most one hour ahead (epoch milliseconds):

   ```http
   POST /api/video-evidence/validation-permits
   { "identity": <identity>, "subject": <subject>, "expectedScopeSha256": "<scopeSha256>", "expiresAt": <ms> }
   ```

   Only the Human who established the campaign's Full Control boundary can mint. A changed scope,
   an expiry over an hour, or a second permit for the same gate, evidence and profile is refused.
   A permit is single-use. A later change to the source, policy revision or reviewer attestation
   stops it from starting.

5. **Run the three metered validations,** one at a time, in the order candidate, paced, maximum:

   ```http
   POST /api/video-evidence/validation-permits/<permitId>/run
   GET  /api/video-evidence/validation-permits/<permitId>
   ```

   Poll the second call until `status` is `complete`, `failed` or `withheld`. The run and your
   inspection must both finish before the permit's `expiresAt`. After that, media access ends and the
   observation is withheld. A run that stops early, reports `unknown`, or has unpriced usage counts
   as a failure (see below).

6. **Inspect each run yourself.** Only after a run is `complete`, open `oracle.json` and compare it
   with the returned `verdict`. Every transient's colour, geometry, frame order and exact source
   presentation time must match.

   The response's `run` already holds the server-verifiable fields. Fill each `null` from your own
   evidence:
   - `usageEvidenceSha256`, `actualInputTokens` and `actualOutputTokens`: the provider console's
     usage record for this run, and its sha256.
   - `pricingEvidenceSha256`: the sha256 of the current official pricing you checked.
   - `oracleIsolationEvidenceSha256`: the sha256 of the step 1 probe output.
   - Each boolean: `true` only if you verified it. `allSourceFramesDelivered` is checked against
     `receiptCount`, and `blindOracleMatched` against the oracle comparison.

7. **Record the proof.** Post the three completed `run` objects and their shared `target` to the
   Human-only ingress, signed in as the owner or admin who inspected them:

   ```http
   POST /api/video-evidence/live-validations
   { "target": <run.target>, "runs": [<candidate run>, <paced run>, <maximum run>] }
   ```

   The target's `capabilitiesSha256` and `reviewerNamespaceSha256` must equal the step 1
   `attestationSha256` and `namespacePolicySha256`, which are the runner's current attestation.
   Otherwise the route answers `attestation_mismatch`. Each run's `inspectedByUserId` must be your
   own user ID.

8. **Confirm.** Settings shows the machine as **Certified** with its dates. The proof expires 30
   days after recording. Re-certify before then with a fresh challenge (steps 1–7). A changed CLI,
   executable, namespace, key arrangement, model or effort changes the attestation, and the row
   returns to **Not Certified**.

## On Failure

- Do not record a proof. A mismatch, missing frame, early stop, unknown dispatch or unpriced usage
  leaves video evidence with you, which is the safe state.
- Revoke a permit you will not use: `POST /api/video-evidence/validation-permits/<permitId>/revoke`.
  It also ends a running reviewer's media access.
- Leave an `unknown` run's reservation alone; it reconciles from the runner's durable record and is
  never replayed. Resolve the gates yourself.
- Each gate's evidence admits one run ever, so a retry needs freshly attached captures and new gates.
- Revoke any proof you are no longer sure of: `POST /api/video-evidence/live-validations/<proofId>/revoke`.
  Revocation ends media access, verdicts and provenance for that reviewer at once.
- Discard the challenge and oracle directories, generate a new challenge and start again from step 1.
  Never retry with the same oracle.
