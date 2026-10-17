/**
 * Operator probe for the Claude Code media-only video reviewer (#1321).
 *
 *   node --import tsx apps/runner/scripts/claude-media-reviewer-probe.ts --agent-id claude --data-dir <runner data dir>
 *       Offline: proves the pinned CLI, the dedicated reviewer key file and an actual provider-less
 *       bwrap namespace, then prints the attestation the runner would advertise. No model call.
 *
 *   WOLLIPOG_MEDIA_PROBE_CONFIRM=paid node --import tsx apps/runner/scripts/claude-media-reviewer-probe.ts \
 *       --agent-id claude --data-dir <dir> --live --frames-dir <dir> --criteria-file <file> --out <evidence.json> \
 *       --forbidden <private-oracle-dir> \
 *       [--model claude-opus-5-5] [--effort high] [--budget-usd 10] [--frame-duration-us 33334]
 *       LIVE AND PAID: runs the real windowed reviewer, inside its real namespace, with the dedicated
 *       key, against a local stand-in for the control plane's media routes that serves exactly the
 *       PNG frames in --frames-dir (sorted by name). It prints the delivery plan and a cost estimate
 *       first, then per-window structured notes, the verdict, provider-reported usage and the policy
 *       digests, and writes them (never the key or any frame bytes) to --out.
 *
 * This is NOT part of `pnpm test` and never runs in CI. Agents must not run --live: it spends money
 * on a paid model. It registers no live-validation proof, advertises nothing and changes no hosting
 * state. A human inspects its output and records any certification through the Human-only ingress.
 *
 * Blind challenge requirement: generate each capture with a private oracle whose ONE-FRAME transient
 * sits in an EARLY delivery window (window 1 or 2 of the paced 360 and maximum 900 profiles), so the
 * final-window verdict can only report it through the carried structured notes. A transient in the
 * final window proves within-window recall only and does not certify cross-window delivery. Keep
 * the oracle outside every reviewer input; compare it with the verdict only after the run.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pacedVideoReviewWindowPlan, pacedVideoReviewWindowPlanBody, type MediaReviewDispatch, type PacedVideoTransportGrant,
  type RunnerToControlPlane, type StartSessionMessage } from "@wollipog/protocol";
import { inspectClaudeMediaReviewer, mediaReviewerAttestationSha256 } from "../src/claude-media-reviewer.js";
import { installedMediaReviewer, MediaReviewerDispatcher } from "../src/media-reviewer-dispatcher.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const argv = process.argv.slice(2);
const option = (name: string) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const required = (name: string) => { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; };

/** Local stand-in for the media routes, with the control plane's ordering, window and batch rules. */
function localMediaRoutes(grant: PacedVideoTransportGrant, bytes: Buffer[], log: (entry: unknown) => void): typeof fetch {
  let order = 0, receipts = 0;
  const acked = new Set<number>(), pending = new Map<string, number>();
  return (async (url: string, init: { body: string }) => {
    const action = String(url).split("/").at(-1)!, body = JSON.parse(init.body);
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (action === "frames") {
      if (Array.from({ length: body.index }, (_, i) => i).some((i) => !acked.has(i))) return reply(409, { error: "order" });
      const deliveries = [];
      for (let index = body.index; index < Math.min(body.end ?? grant.frames.length, grant.frames.length) && deliveries.length < 20; index++) {
        const frame = grant.frames[index]!, receiptId = `probe_receipt_${++receipts}`;
        pending.set(receiptId, index);
        deliveries.push({ receipt: { receiptId, occurrenceId: grant.occurrenceId, reviewerSessionId: grant.reviewerSessionId,
          childSessionId: grant.childSessionId, policyRevision: grant.policyRevision, evidenceId: grant.sourceEvidenceId,
          artifactId: `${grant.reviewId}:frame:${index}`, sha256: frame.sha256, deliveredAt: Date.now(), deliveryOrder: ++order,
          videoFrame: { sourceArtifactId: grant.sourceArtifactId, sourceSha256: grant.sourceSha256, manifestSha256: grant.manifestSha256,
            profile: "paced-silent-complete-frames-v1", index, ptsMs: frame.ptsUs / 1000, ptsUs: frame.ptsUs, durationUs: frame.durationUs },
          bindingSha256: grant.bindingSha256, criteriaSha256: grant.criteriaSha256 },
        mimeType: "image/png", sizeBytes: frame.sizeBytes, data: bytes[index]!.toString("base64") });
      }
      log({ delivered: deliveries.map((d) => d.receipt.videoFrame.index) });
      return reply(200, { deliveries, nextIndex: body.index + deliveries.length, frameCount: grant.frames.length });
    }
    if (action === "acknowledge-frames") {
      for (const r of body.receipts) acked.add(pending.get(r.receiptId)!);
      return reply(200, { acknowledged: true });
    }
    if (action === "verdict") {
      if (acked.size !== grant.frames.length) return reply(409, { error: "incomplete receipts" });
      log({ verdict: body.report });
      return reply(200, { verdictId: "probe_verdict", reviewId: grant.reviewId, reviewerSessionId: grant.reviewerSessionId,
        bindingSha256: grant.bindingSha256, outcome: body.report.outcome });
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  const agentId = required("--agent-id"), dataDir = resolve(required("--data-dir"));
  const command = option("--claude") ?? "claude";
  const root = join(dataDir, "media-review");
  mkdirSync(join(root, "probe-sessions"), { recursive: true, mode: 0o700 });
  // Operator-only roots (the private oracle, the frames' source directory) the namespace must not
  // contain. The namespace mounts none of them; this makes preparation refuse any overlap.
  const forbidden = [...argv.flatMap((arg, i) => arg === "--forbidden" ? [argv[i + 1]!] : []), option("--frames-dir")]
    .filter((path): path is string => Boolean(path)).map((path) => realpathSync(resolve(path)));
  if (!forbidden.length) forbidden.push(mkdtempSync(join(tmpdir(), "media-probe-forbidden-")));
  const installed = await installedMediaReviewer({ agentId, command, dataDir, root: join(root, "probe"),
    nodeExecutable: process.execPath, forbiddenRoots: forbidden });
  if ("refused" in installed) { console.log(JSON.stringify({ supported: false, reason: installed.refused })); process.exitCode = 1; return; }
  console.log(JSON.stringify({ supported: true, attestation: installed.attestation,
    attestationSha256: mediaReviewerAttestationSha256(installed.attestation) }, null, 2));
  if (!argv.includes("--live")) return;
  if (process.env.WOLLIPOG_MEDIA_PROBE_CONFIRM !== "paid") throw new Error("--live calls a paid model; set WOLLIPOG_MEDIA_PROBE_CONFIRM=paid to proceed");

  const framesDir = resolve(required("--frames-dir")), out = resolve(required("--out"));
  const criteria = readFileSync(resolve(required("--criteria-file")), "utf8");
  const durationUs = Number(option("--frame-duration-us") ?? "33334");
  const names = readdirSync(framesDir).filter((name) => name.endsWith(".png")).sort();
  const bytes = names.map((name) => readFileSync(join(framesDir, name)));
  const grant: PacedVideoTransportGrant = { reviewId: "probe_review", reviewerSessionId: "probe_reviewer", childSessionId: "probe_child",
    occurrenceId: "probe_occurrence", policyRevision: 1, sourceEvidenceId: "probe_evidence", sourceArtifactId: "probe_capture",
    sourceSha256: sha(Buffer.concat(bytes)), manifestSha256: sha(names.join("\n")), bindingSha256: sha("probe binding"),
    criteriaSha256: sha(criteria), expiresAt: Date.now() + 3_600_000,
    frames: bytes.map((b, index) => ({ index, ptsUs: index * durationUs, durationUs, sha256: sha(b), sizeBytes: b.length })) };
  const plan = pacedVideoReviewWindowPlan(grant.frames);
  const model = option("--model") ?? "claude-opus-5-5", effort = option("--effort") ?? "high";
  const budgetUsd = Number(option("--budget-usd") ?? "10");
  // Planning estimate only (1280x720 is 1196 image tokens; Opus 5.5 input list price $4/MTok); the
  // provider-reported usage printed at the end is the evidence.
  const imageTokens = plan.windows.reduce((sum, w) => sum + (w.endIndex - w.firstIndex) * 1196, 0);
  console.log(JSON.stringify({ frames: grant.frames.length, windows: plan.windows, estimatedImageTokens: imageTokens,
    estimatedImageInputUsdAtOpus55: Number((imageTokens * 4 / 1e6).toFixed(2)), budgetUsd }, null, 2));

  const log: unknown[] = [], windows: unknown[] = [];
  const sent: RunnerToControlPlane[] = [];
  const dispatcher = new MediaReviewerDispatcher({
    db: new DatabaseSync(":memory:"), root: join(root, "probe-sessions"), runnerId: () => "probe-runner",
    controlPlaneHttpUrl: () => "http://probe.invalid", fetch: localMediaRoutes(grant, bytes, (entry) => log.push(entry)),
    send: (message) => { sent.push(message); console.log(JSON.stringify(message)); }, registerCredential: async () => {},
    reviewer: async () => installed, forbiddenRoots: () => forbidden, nodeExecutable: process.execPath,
    reserve: () => true, release: () => {}, log: (message) => console.error(message),
    observe: (event) => { windows.push(event); console.log(JSON.stringify({ window: event })); },
  });
  const start = { type: "start_session", initialPrompt: criteria,
    spec: { sessionId: "probe_reviewer", agentId, driver: "claude-code", workspaceId: null, workspacePath: "/review", command, args: [], env: {},
      config: { model, effort, costBudgetUsd: budgetUsd, maxToolCalls: 1000 }, campaignBudgetDispatch: { generation: "probe-generation" },
      mediaReviewPurpose: { rootSessionId: "probe_root", childSessionId: "probe_child", admissionId: "probe_admission",
        occurrenceId: "probe_occurrence", evidenceId: "probe_evidence", generation: "probe-generation" } },
  } as unknown as StartSessionMessage;
  const dispatch: MediaReviewDispatch = { command: start, grant,
    identity: { rootSessionId: "probe_root", childSessionId: "probe_child", sessionId: "probe_reviewer", runnerId: "probe-runner",
      generation: "probe-generation", commandSha256: sha(JSON.stringify(start)), dispatchSha256: sha("probe dispatch") },
    deliveryPlanSha256: sha(pacedVideoReviewWindowPlanBody(plan)), attestationSha256: mediaReviewerAttestationSha256(installed.attestation) };
  const started = Date.now();
  await dispatcher.dispatch(dispatch);
  const install = await inspectClaudeMediaReviewer(command);
  writeFileSync(out, JSON.stringify({ attestation: installed.attestation, executableSha256: install.executableSha256,
    deliveryPlan: plan, deliveryPlanSha256: dispatch.deliveryPlanSha256, frameSha256: grant.frames.map((f) => f.sha256),
    windows, deliveryLog: log, messages: sent, latencyMs: Date.now() - started, model, effort }, null, 2) + "\n", { mode: 0o600 });
  console.log(`evidence written to ${out}`);
}

main().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
