import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { pacedVideoReviewWindowPlan, pacedVideoReviewWindowPlanBody, type MediaReviewDispatch, type PacedVideoTransportGrant,
  type RunnerToControlPlane, type StartSessionMessage } from "@wollipog/protocol";
import { claudeMediaReviewerAttestation, CLAUDE_MEDIA_REVIEWER_ENV, mediaReviewerAttestationSha256 } from "./claude-media-reviewer.js";
import { prepareEvidenceReviewNamespace } from "./evidence-review-namespace.js";
import { MediaReviewerDispatcher, type MediaReviewerInstalled } from "./media-reviewer-dispatcher.js";
import { openMediaReviewRelay } from "./media-review-relay.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fake = realpathSync(fileURLToPath(new URL("./drivers/fixtures/fake-claude-media-reviewer.mjs", import.meta.url)));
const KEY = "sk-ant-api03-" + "k".repeat(40);
const now = 1_800_000_000_000;

function grantFor(frameCount: number): { grant: PacedVideoTransportGrant; bytes: Buffer[] } {
  const bytes = Array.from({ length: frameCount }, (_, i) => Buffer.from(`synthetic frame ${i}`));
  return { bytes, grant: { reviewId: "review_1", reviewerSessionId: "reviewer", childSessionId: "child", occurrenceId: "occ",
    policyRevision: 3, sourceEvidenceId: "ev", sourceArtifactId: "art", sourceSha256: sha("source"), manifestSha256: sha("manifest"),
    bindingSha256: sha("binding"), criteriaSha256: sha("criteria"), expiresAt: now + 3_600_000,
    frames: bytes.map((b, index) => ({ index, ptsUs: index * 40_000, durationUs: 40_000, sha256: sha(b), sizeBytes: b.length })) } as PacedVideoTransportGrant };
}

/** In-memory media routes with the control plane's ordering rules: every earlier frame must be
 * acknowledged before a batch, batches stop at `end` and 20 frames, verdict needs every frame. */
function fakeControlPlane(grant: PacedVideoTransportGrant, bytes: Buffer[]) {
  let order = 0, receipt = 0;
  const acked = new Set<number>(), pending = new Map<string, number>(), requests: Array<{ action: string; body: any; auth: string }> = [];
  let verdict = false;
  const fetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const action = url.split("/").at(-1)!, body = JSON.parse(init.body);
    requests.push({ action, body, auth: init.headers.authorization ?? "" });
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (action === "frames") {
      const end = Math.min(body.end ?? grant.frames.length, grant.frames.length);
      if (Array.from({ length: body.index }, (_, i) => i).some((i) => !acked.has(i))) return reply(409, { error: "order" });
      const deliveries = [];
      for (let index = body.index; index < end && deliveries.length < 20; index++) {
        const frame = grant.frames[index]!, receiptId = `r${++receipt}`;
        pending.set(receiptId, index);
        deliveries.push({ receipt: { receiptId, occurrenceId: grant.occurrenceId, reviewerSessionId: grant.reviewerSessionId,
          childSessionId: grant.childSessionId, policyRevision: grant.policyRevision, evidenceId: grant.sourceEvidenceId,
          artifactId: `${grant.reviewId}:frame:${index}`, sha256: frame.sha256, deliveredAt: now, deliveryOrder: ++order,
          videoFrame: { sourceArtifactId: grant.sourceArtifactId, sourceSha256: grant.sourceSha256, manifestSha256: grant.manifestSha256,
            profile: "paced-silent-complete-frames-v1", index, ptsMs: frame.ptsUs / 1000, ptsUs: frame.ptsUs, durationUs: frame.durationUs },
          bindingSha256: grant.bindingSha256, criteriaSha256: grant.criteriaSha256 },
        mimeType: "image/png", sizeBytes: frame.sizeBytes, data: bytes[index]!.toString("base64") });
      }
      return reply(200, { deliveries, nextIndex: body.index + deliveries.length, frameCount: grant.frames.length });
    }
    if (action === "acknowledge-frames") {
      for (const r of body.receipts) acked.add(pending.get(r.receiptId)!);
      return reply(200, { acknowledged: true });
    }
    if (action === "verdict") {
      if (acked.size !== grant.frames.length) return reply(409, { error: "receipts" });
      verdict = true;
      return reply(200, { verdictId: "verdict_1", reviewId: grant.reviewId, reviewerSessionId: grant.reviewerSessionId,
        bindingSha256: grant.bindingSha256, outcome: body.report.outcome });
    }
    return reply(404, {});
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests, acked, verdict: () => verdict };
}

async function harness(t: TestContext, options: { mode?: string; frames?: number; driver?: string; tamper?: (d: MediaReviewDispatch) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "media-dispatch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessions = join(root, "sessions"), operator = join(root, "operator"), recordFile = join(root, "record.jsonl");
  mkdirSync(sessions, { mode: 0o700 }); mkdirSync(operator, { mode: 0o700 });
  writeFileSync(join(operator, "oracle.json"), "synthetic private oracle");
  // The stable policy digest does not depend on per-launch paths, so a probe namespace yields it.
  const probeState = mkdtempSync(join(root, "probe-"));
  const probeRelay = await openMediaReviewRelay({ transport: { grant: {} as PacedVideoTransportGrant, now: Date.now,
    request: async () => { throw new Error("probe"); } }, actualSessionId: "", current: () => false });
  const policy = prepareEvidenceReviewNamespace({ stateDirectory: probeState, providerExecutable: fake, forbiddenRoots: [operator],
    network: "inherit", relay: { directory: probeRelay.directory, nodeExecutable: process.execPath }, providerEnv: CLAUDE_MEDIA_REVIEWER_ENV }).namespaceSha256;
  await probeRelay.close();
  const install = { claude: fake, executableSha256: sha(readFileSync(fake)), cliVersion: "2.1.296" };
  const reviewer: MediaReviewerInstalled = { attestation: claudeMediaReviewerAttestation("claude", install, policy), install, credential: () => KEY };
  const { grant, bytes } = grantFor(options.frames ?? 90);
  const cp = fakeControlPlane(grant, bytes);
  const sent: RunnerToControlPlane[] = [], registered: string[] = [], spawned: Array<{ namespaceArgs: string[]; privateArgs: string[] }> = [];
  const admissions = new Set<string>();
  const dispatcher = new MediaReviewerDispatcher({
    db: new DatabaseSync(":memory:"), root: sessions, runnerId: () => "runner-1", controlPlaneHttpUrl: () => "http://cp.test",
    fetch: cp.fetch, send: (message) => sent.push(message), registerCredential: async (_session, hash) => { registered.push(hash); },
    reviewer: async () => reviewer, forbiddenRoots: () => [operator], nodeExecutable: process.execPath,
    reserve: (id) => { if (admissions.has(id)) return false; admissions.add(id); return true; }, release: (id) => { admissions.delete(id); },
    log: () => {}, now: () => now,
    // No bwrap in unit tests: run the fake provider directly with the exact provider argv, its
    // environment taken from the namespace's --setenv pairs, and the relay socket outside /relay.
    spawnProvider: (namespace, privateArgs) => {
      spawned.push({ namespaceArgs: [...namespace.args], privateArgs });
      const split = privateArgs.indexOf("--"), env: Record<string, string> = {};
      for (let i = 0; i < split; i++) if (privateArgs[i] === "--setenv") env[privateArgs[i + 1]!] = privateArgs[i + 2]!;
      const relayDir = namespace.args[namespace.args.indexOf("/relay") - 1]!;
      return spawn(process.execPath, [fake, ...privateArgs.slice(split + 2)], { detached: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...env, PATH: process.env.PATH ?? "", FAKE_MEDIA_SOCKET: join(relayDir, "media.sock"),
          FAKE_MEDIA_MODE: options.mode ?? "ok", FAKE_MEDIA_RECORD: recordFile } });
    },
  });
  const command = { type: "start_session", initialPrompt: "Pinned criterion transition: inspect every frame for transient defects.",
    spec: { sessionId: "reviewer", agentId: "claude", driver: options.driver ?? "claude-code", workspaceId: null, workspacePath: "/review",
      command: "claude", args: [], env: {}, config: { model: "claude-opus-5-5", effort: "high", costBudgetUsd: 5, maxToolCalls: 200 },
      campaignBudgetDispatch: { generation: "gen-1" },
      mediaReviewPurpose: { rootSessionId: "root", childSessionId: "child", admissionId: "adm", occurrenceId: "occ", evidenceId: "ev", generation: "gen-1" } },
  } as unknown as StartSessionMessage;
  const dispatch: MediaReviewDispatch = { command, grant,
    identity: { rootSessionId: "root", childSessionId: "child", sessionId: "reviewer", runnerId: "runner-1", generation: "gen-1",
      commandSha256: sha(JSON.stringify(command)), dispatchSha256: sha("dispatch") },
    deliveryPlanSha256: sha(pacedVideoReviewWindowPlanBody(pacedVideoReviewWindowPlan(grant.frames))),
    attestationSha256: mediaReviewerAttestationSha256(reviewer.attestation) };
  options.tamper?.(dispatch);
  const records = () => { try { return readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dispatcher, dispatch, sent, registered, spawned, cp, records, admissions, grant };
}
const finished = (sent: RunnerToControlPlane[]) => sent.filter((m) => m.type === "media_review_finished").map((m) => (m as { result: any }).result);

test("windowed reviewer delivers every frame inside its window, carries notes forward and confirms one verdict", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  const h = await harness(t);
  await h.dispatcher.dispatch(h.dispatch);
  const [result] = finished(h.sent);
  assert.equal(result.outcome, "completed", result.reason);
  assert.equal(result.windowsCompleted, 2);
  assert.equal(result.verdictConfirmed, true);
  assert.equal(result.priced, true);
  assert.ok(Math.abs(result.costUsd - 0.02) < 1e-9, "per-window cumulative totals are summed once each");
  assert.equal(h.cp.acked.size, 90);
  assert.equal(h.cp.verdict(), true);
  const frames = h.cp.requests.filter((r) => r.action === "frames");
  assert.deepEqual(frames.map((r) => [r.body.index, r.body.end]), [[0, 60], [20, 60], [40, 60], [59, 90], [79, 90]],
    "batches never cross a window and the overlap frame 59 is re-delivered to the second conversation");
  // The reviewer authenticates as its own Session with a runner-minted bearer registered by hash.
  assert.equal(h.registered.length, 1);
  assert.ok(h.cp.requests.every((r) => r.auth.startsWith("Bearer ") && sha(r.auth.slice(7)) === h.registered[0]));
  // The dedicated key reaches the provider only through the private argument pipe.
  assert.equal(h.spawned.length, 2);
  for (const launch of h.spawned) {
    assert.equal(launch.namespaceArgs.includes(KEY), false);
    assert.ok(launch.privateArgs.includes(KEY));
    const provider = launch.privateArgs.slice(launch.privateArgs.indexOf("--") + 1);
    assert.equal(provider.includes(KEY), false, "never in the provider argv");
    for (const flag of ["--bare", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) assert.ok(provider.includes(flag));
    assert.equal(provider[provider.indexOf("--tools") + 1], "", "every built-in tool is disabled");
  }
  const records = h.records();
  assert.ok(records.filter((r) => r.argv).every((r) => r.apiKey === "present" && r.maxMcp === "100000"));
  const prompts = records.filter((r) => r.prompt).map((r) => r.prompt as string);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0]!, /Do not submit a verdict in this window/u);
  assert.match(prompts[1]!, /This is the final window/u);
  assert.ok(prompts[1]!.includes('"window":{"firstIndex":0,"endIndex":60}'), "the final window carries the earlier window's validated notes");
  assert.deepEqual(h.sent.filter((m) => m.type === "media_review_dispatch_receipt").map((m) => (m as { receipt: any }).receipt.outcome), ["accepted"]);
  assert.equal(h.admissions.size, 0, "host admission is released after the reviewer exits");

  // Replay never relaunches: the durable result is read back.
  await h.dispatcher.dispatch(h.dispatch);
  assert.equal(h.spawned.length, 2);
  assert.deepEqual(finished(h.sent).at(-1), result);
});

test("startup tool or server surface wider than the two media tools refuses before any frame is delivered", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  for (const [mode, reason] of [["extra-tool", /startup tool list/u], ["extra-server", /startup MCP servers/u]] as const) {
    const h = await harness(t, { mode });
    await h.dispatcher.dispatch(h.dispatch);
    const [result] = finished(h.sent);
    assert.equal(result.outcome, "failed");
    assert.match(result.reason, reason);
    assert.equal(h.cp.requests.length, 0, `${mode}: no media route is reached`);
    assert.equal(result.priced, false, "an unpriced window never reports invented zero usage");
  }
});

test("a tool outside the media set, a skipped frame or invalid notes fail the window instead of truncating", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  for (const [mode, reason] of [["use-bash", /outside the scoped media set/u], ["skip-frame", /before every frame/u],
    ["bad-notes", /notes were missing or invalid/u]] as const) {
    const h = await harness(t, { mode });
    await h.dispatcher.dispatch(h.dispatch);
    const [result] = finished(h.sent);
    assert.equal(result.outcome, "failed", mode);
    assert.match(result.reason, reason, mode);
    assert.equal(result.verdictConfirmed, false);
    assert.equal(h.cp.verdict(), false);
  }
});

test("a later window must receive its own overlap frame; an earlier window's receipt does not count", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  const h = await harness(t, { mode: "skip-overlap" });
  await h.dispatcher.dispatch(h.dispatch);
  const [result] = finished(h.sent);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /before every frame/u);
  assert.equal(result.verdictConfirmed, false);
  assert.equal(h.cp.verdict(), false, "the verdict route is never reached without the fresh overlap acknowledgement");
  assert.deepEqual(h.records().filter((r) => r.verdict).map((r) => r.verdict), ["refused"]);
});

test("an unpriced turn keeps its window unpriced and buys no correction turn", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  const h = await harness(t, { mode: "unpriced-then-priced" });
  await h.dispatcher.dispatch(h.dispatch);
  const [result] = finished(h.sent);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /not priced/u);
  assert.equal(result.priced, false);
  assert.equal(result.costUsd, undefined);
  assert.equal(h.records().filter((r) => r.prompt).length, 1, "no correction is sent after unknown spend");
  assert.equal(h.spawned.length, 1, "no later window is launched");
});

test("one same-conversation correction repairs invalid notes or a missing verdict", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  for (const mode of ["bad-notes-once", "no-verdict-once"]) {
    const h = await harness(t, { mode });
    await h.dispatcher.dispatch(h.dispatch);
    const [result] = finished(h.sent);
    assert.equal(result.outcome, "completed", `${mode}: ${result.reason}`);
    assert.equal(h.spawned.length, 2, "the correction stays in the window's own conversation");
    assert.equal(h.cp.acked.size, 90);
  }
});

test("Codex, digest mismatches and changed attestations are never dispatched", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  const cases: Array<Parameters<typeof harness>[1]> = [
    { driver: "codex-app-server" },
    { tamper: (d) => { d.identity.commandSha256 = sha("other command"); } },
    { tamper: (d) => { d.deliveryPlanSha256 = sha("other plan"); } },
    { tamper: (d) => { d.attestationSha256 = sha("other attestation"); } },
    { tamper: (d) => { d.grant.childSessionId = "someone-else"; } },
  ];
  for (const options of cases) {
    const h = await harness(t, options);
    await h.dispatcher.dispatch(h.dispatch);
    assert.equal(h.spawned.length, 0);
    assert.equal(h.registered.length, 0, "no reviewer credential is minted for a refused dispatch");
    const never = h.sent.filter((m) => m.type === "media_review_never_dispatched");
    assert.equal(never.length, 1);
    assert.equal(h.sent.some((m) => m.type === "media_review_finished"), false);
    // A later dispatch of the same identity cannot launch after its never-dispatched fence.
    if (options?.tamper) {
      await h.dispatcher.dispatch(h.dispatch);
      assert.equal(h.spawned.length, 0);
    }
  }
});

test("the owning runner Stop acknowledges and ends the running reviewer without settling usage", async (t) => {
  if (process.platform !== "linux" || process.getuid?.() === 0) { t.skip("native non-root Linux namespace preparation required"); return; }
  const h = await harness(t, { mode: "slow" });
  const running = h.dispatcher.dispatch(h.dispatch);
  while (!h.sent.some((m) => m.type === "media_review_dispatch_receipt")) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const request = { ...h.dispatch.identity, operationId: "stop-1" };
  h.dispatcher.stop(request);
  const ack = h.sent.find((m) => m.type === "media_review_stop_acknowledged") as { receipt: any } | undefined;
  assert.equal(ack?.receipt.outcome, "stop_requested");
  await running;
  const [result] = finished(h.sent);
  assert.equal(result.outcome, "failed");
  assert.match(result.reason, /stop requested/u);
  assert.equal(result.priced, false, "a turn killed mid-flight has spent more than any reported total");
  // An unrelated identity is never signalled.
  h.dispatcher.stop({ ...request, sessionId: "other", operationId: "stop-2" });
  assert.equal(h.sent.filter((m) => m.type === "media_review_stop_acknowledged").length, 1);
});
