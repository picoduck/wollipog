import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { PROTOCOL_VERSION, REVIEW_JOBS_RETIRED_REASON, reviewRetirementPeerRefusal } from "@wollipog/protocol";
import { assertLegacyReviewsDrained, retiredReviewReceipt } from "./retired-review-jobs.js";

const campaignId = "review_12345678-1234-1234-1234-123456789abc";
const bridgeId = "srj_12345678";
const nonce = "original-nonce";

/** Execute the real frame handler in isolation: no runner startup or provider process. */
function frameHandler(globals: Record<string, unknown>): (message: unknown) => void {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("./index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let handler: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "handleCommand") handler = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(handler);
  const js = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = vm.createContext({ controlPlanePeerRefused: false, ...globals });
  vm.runInContext(`${js}\nglobalThis.receive = handleCommand;`, context);
  return context.receive;
}

test("a refused registration drops buffered commands before the socket close event", () => {
  const logs: string[] = [];
  let closed = 0, promoted = 0;
  const receive = frameHandler({ reviewRetirementPeerRefusal, log: (message: string) => logs.push(message),
    ws: { terminate: () => { closed++; } }, stagedRunnerCredential: { promote: () => { promoted++; } },
    sendUp: () => { throw Error("refused peer received a receipt"); },
    runCommandTask: () => { throw Error("refused peer resumed a command"); } });
  receive({ type: "registered", protocolVersion: PROTOCOL_VERSION - 1 });
  for (const type of ["session_review_job", "campaign_review_job", "prompt_session", "invoke_session_command"]) {
    assert.doesNotThrow(() => receive({ type, jobId: bridgeId, nonce }));
  }
  assert.equal(closed, 1);
  assert.equal(promoted, 0);
  assert.match(logs[0]!, /requires.*control plane.*review sessions?/iu);
});

test("actual legacy dispatch and cancel frames produce only retirement receipts, with no executor", () => {
  const root = mkdtempSync(join(tmpdir(), "retired-frames-"));
  try {
    const updates: unknown[] = [];
    const receive = frameHandler({ config: { dataDir: root }, retiredReviewReceipt,
      sendUp: (update: unknown) => updates.push(update), runCommandTask: () => { throw Error("legacy executor invoked"); } });
    for (const type of ["session_review_job", "cancel_session_review_job"]) receive({ type, jobId: bridgeId, nonce });
    for (const type of ["campaign_review_job", "cancel_campaign_review_job"]) receive({ type, jobId: campaignId, nonce });
    assert.equal(updates.length, 4);
    assert.ok(updates.every(update => (update as { reason: string }).reason === REVIEW_JOBS_RETIRED_REASON));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function fixture(kind: "bridge" | "campaign", content: unknown) {
  const root = mkdtempSync(join(tmpdir(), "retired-reviews-"));
  const path = kind === "bridge" ? join(root, "session-review-jobs", "jobs", `${bridgeId}.json`)
    : join(root, "campaign-review-jobs", campaignId, "state.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(content));
  return { root, path, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("old or unknown control planes are refused before a new runner can replay retired dispatch", () => {
  for (const peer of [undefined, null, 223, 243, PROTOCOL_VERSION - 1, String(PROTOCOL_VERSION), NaN, PROTOCOL_VERSION + 0.5]) {
    assert.match(reviewRetirementPeerRefusal(peer)!, /requires.*control plane.*review sessions?/iu);
  }
  assert.equal(reviewRetirementPeerRefusal(PROTOCOL_VERSION), null);
});

test("runner restart refuses prepared, launching, running and corrupt legacy work without changing it", () => {
  for (const kind of ["bridge", "campaign"] as const) for (const content of [
    { phase: "prepared" }, { phase: "launching" }, { phase: "running" }, {}, null,
    { phase: "finished", command: { jobId: campaignId, nonce }, update: { state: "accounting_unavailable" } },
  ]) {
    const f = fixture(kind, content);
    try {
      const before = readFileSync(f.path, "utf8");
      assert.throws(() => assertLegacyReviewsDrained(f.root), /legacy review|prior runner/u);
      assert.equal(readFileSync(f.path, "utf8"), before);
    } finally { f.close(); }
  }
});

test("drained terminal unpriced receipts permit upgrade and replay without inventing cost", () => {
  for (const costUsd of [undefined, 1.25]) {
    const receipt = { type: "campaign_review_job_update", jobId: campaignId, nonce, state: "accounting_unavailable",
      toolCalls: 3, ...(costUsd === undefined ? {} : { costUsd }), attemptConsumed: true, attemptValid: false,
      receiptSha256: "b".repeat(64), reason: REVIEW_JOBS_RETIRED_REASON };
    const f = fixture("campaign", { phase: "finished", command: { jobId: campaignId, nonce }, update: receipt });
    try {
      const before = readFileSync(f.path, "utf8");
      assert.doesNotThrow(() => assertLegacyReviewsDrained(f.root));
      assert.deepEqual(retiredReviewReceipt(f.root, "campaign", campaignId, nonce), receipt);
      assert.equal(readFileSync(f.path, "utf8"), before);
    } finally { f.close(); }
  }
});

test("terminal unpriced accounting cannot hide live or uninspectable recorded execution", () => {
  const receipt = { type: "campaign_review_job_update", jobId: campaignId, nonce, state: "accounting_unavailable",
    toolCalls: 1, receiptSha256: "a".repeat(64) };
  const f = fixture("campaign", { phase: "finished", command: { jobId: campaignId, nonce }, update: receipt,
    pid: 101, startIdentity: "old-controller", providerPid: 102, providerStartIdentity: "old-provider" });
  try {
    const dead = { startTime: () => null, groupAlive: () => false };
    assert.doesNotThrow(() => assertLegacyReviewsDrained(f.root, dead));
    assert.throws(() => assertLegacyReviewsDrained(f.root, { ...dead, startTime: pid => pid === 101 ? "old-controller" : null }), /live or unverified/u);
    assert.throws(() => assertLegacyReviewsDrained(f.root, { ...dead, groupAlive: () => true }), /live or unverified/u);
    assert.throws(() => assertLegacyReviewsDrained(f.root, { ...dead, startTime: pid => pid === 102 ? "old-provider" : null }), /live or unverified/u);
    assert.throws(() => assertLegacyReviewsDrained(f.root, { ...dead, startTime: () => { throw Error("unreadable"); } }), /live or unverified/u);
    assert.doesNotThrow(() => assertLegacyReviewsDrained(f.root, { startTime: () => "reused-pid", groupAlive: () => true }));
  } finally { f.close(); }
});

test("the real Linux probe recognizes the prior writers' procfs identity format", { skip: process.platform !== "linux" }, () => {
  // Both writers at 863246baffc11b2994c23e218420d614a4a8ad15 stored pid/startIdentity using
  // field 22 from /proc/<pid>/stat, with providerPid/providerStartIdentity (campaign) and
  // reviewerPid/reviewerIdentity (bridge). Use their literal extraction against a live PID.
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const startIdentity = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  assert.match(startIdentity, /^[1-9][0-9]*$/u);
  for (const kind of ["bridge", "campaign"] as const) {
    const jobId = kind === "bridge" ? bridgeId : campaignId;
    const update = kind === "bridge"
      ? { type: "session_review_job_update", jobId, nonce, state: "failed" }
      : { type: "campaign_review_job_update", jobId, nonce, state: "accounting_unavailable", toolCalls: 1, receiptSha256: "c".repeat(64) };
    const f = fixture(kind, { phase: "finished", command: { jobId, nonce }, pid: process.pid, startIdentity, update });
    try {
      assert.throws(() => assertLegacyReviewsDrained(f.root), /live or unverified/u);
      assert.throws(() => retiredReviewReceipt(f.root, kind, jobId, nonce), /live or unverified/u);
    } finally { f.close(); }
  }
});

test("settled historical usage is replayed verbatim on reconnect or cancellation, never refunded or relaunched", () => {
  const receipt = { type: "campaign_review_job_update", jobId: campaignId, nonce, state: "completed", costUsd: 2.25,
    toolCalls: 4, attemptConsumed: true, attemptValid: true, vote: "UPVOTE", receiptSha256: "a".repeat(64) };
  const f = fixture("campaign", { phase: "finished", command: { jobId: campaignId, nonce }, update: receipt });
  try {
    assert.doesNotThrow(() => assertLegacyReviewsDrained(f.root));
    assert.deepEqual(retiredReviewReceipt(f.root, "campaign", campaignId, nonce), receipt);
    assert.deepEqual(retiredReviewReceipt(f.root, "campaign", campaignId, nonce), receipt);
    assert.throws(() => retiredReviewReceipt(f.root, "campaign", campaignId, "another-nonce"), /identity mismatch/u);
  } finally { f.close(); }
});

test("missing legacy state refuses dispatch without manufacturing zero usage for an unknown paid attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "retired-reviews-"));
  try {
    assert.doesNotThrow(() => assertLegacyReviewsDrained(root));
    const campaign = retiredReviewReceipt(root, "campaign", campaignId, nonce);
    assert.equal(campaign.state, "accounting_unavailable");
    assert.equal("costUsd" in campaign, false);
    assert.equal(campaign.reason, REVIEW_JOBS_RETIRED_REASON);
    assert.equal(retiredReviewReceipt(root, "bridge", bridgeId, nonce).state, "failed");
    assert.throws(() => retiredReviewReceipt(root, "campaign", "../../other", nonce), /Invalid/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
