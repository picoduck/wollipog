import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, pacedVideoReviewWindowPlan, type MediaReviewDispatch, type SessionSnapshot } from "@wollipog/protocol";
import { defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken } from "../../control-plane/src/local-device-credential.js";
import { viewPath } from "../src/navigation.js";
import { delegatedVideoRunner, seedDelegatedVideoEvidence } from "./fixtures/delegated-video-evidence-seed.js";
import { withLiveDb } from "./fixtures/live-database.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

/** The owning runner's side of the media protocol, over the real authenticated runner WebSocket. A
 * synthetic runner: no provider, model or namespace runs, and its digests mirror the dispatcher's. */
async function connectRunner(base: string, token: string, workspacePath: string, liveSessions: string[]) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/runner`);
  const inbox: Array<Record<string, unknown>> = [];
  socket.addEventListener("message", (event) => { inbox.push(JSON.parse(String(event.data)) as Record<string, unknown>); });
  await new Promise<void>((done, reject) => { socket.addEventListener("open", () => done()); socket.addEventListener("error", () => reject(new Error("runner socket failed"))); });
  // The inventory a live runner reports for the sessions it hosts; anything missing would be ended.
  const sessionSnapshots = liveSessions.map((id): SessionSnapshot => ({ id, workspaceId: "video-workspace", agentId: "claude",
    status: "running", title: id === "video-orchestrator" ? "Video Orchestrator" : "Video Evidence Child", driver: "claude-code",
    config: id === "video-orchestrator" ? { model: "claude-opus-5-5", permissionMode: "orchestrator" }
      : { model: "claude-opus-5-5", costBudgetUsd: 2, maxToolCalls: 10 }, costUsd: 0, tokensIn: 0, tokensOut: 0, useWorktree: false, worktreePath: null, preview: null,
    pendingApproval: null, seq: 0, historyEpoch: 0, createdAt: 1, updatedAt: 2 }));
  socket.send(JSON.stringify({ type: "register", token, runner: delegatedVideoRunner(workspacePath), protocolVersion: PROTOCOL_VERSION,
    liveSessions, sessionSnapshots }));
  const waitFor = async (predicate: (message: Record<string, unknown>) => boolean) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = inbox.find(predicate);
      if (found) return found;
      await delay(50);
    }
    throw new Error("runner message never arrived: " + JSON.stringify(inbox.map((message) => message.type)));
  };
  expect((await waitFor((message) => message.type === "registered" || message.type === "register_rejected")).type).toBe("registered");
  const fence = (dispatch: MediaReviewDispatch) => { const { childSessionId: _child, ...rest } = dispatch.identity; return rest; };
  return {
    socket, waitFor,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    accepted: (dispatch: MediaReviewDispatch) => {
      const body = { ...fence(dispatch), outcome: "accepted", deliveryPlanSha256: dispatch.deliveryPlanSha256,
        namespaceLaunchSha256: sha("synthetic actual launch") };
      return { type: "media_review_dispatch_receipt", receipt: { ...body, receiptSha256: sha(JSON.stringify(body)) } };
    },
    finished: (dispatch: MediaReviewDispatch) => {
      const body = { ...fence(dispatch), deliveryPlanSha256: dispatch.deliveryPlanSha256, outcome: "completed",
        windowsCompleted: pacedVideoReviewWindowPlan(dispatch.grant.frames).windows.length, verdictConfirmed: true,
        toolCalls: 9, costUsd: 0.75, priced: true };
      return { type: "media_review_finished", result: { ...body, receiptSha256: sha(JSON.stringify(body)) } };
    },
  };
}

test("an Orchestrator's video evidence is reviewed by a separate media reviewer and approved with its provenance", async ({ page }) => {
  test.setTimeout(150_000);
  let temp: string | null = null;
  let output = "";
  let frameLogged = false;
  let controlPlane: ChildProcess | null = null;
  let runner: Awaited<ReturnType<typeof connectRunner>> | null = null;
  try {
    temp = mkdtempSync(join(tmpdir(), "wollipog-delegated-video-evidence-"));
    const databasePath = join(temp, "control-plane.db");
    const workspacePath = join(temp, "workspace");
    const webDist = join(temp, "web-dist");
    mkdirSync(workspacePath);
    const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
    const seeded = await seedDelegatedVideoEvidence(databasePath, workspacePath);
    const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", webDist], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32",
    });
    if (built.status !== 0 || !existsSync(join(webDist, "index.html"))) {
      throw new Error(`web build failed: ${built.error?.message ?? ""} ${(built.stderr ?? "").slice(-2000)}`);
    }
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_)/u.test(key)) delete env[key];
    // Campaign accounting needs a priced model. Serve a fixture rate table from the pricing cache
    // for an unroutable source, so the control plane never fetches real pricing.
    const pricingUrl = "http://127.0.0.1:9/fixture-model-rates.json";
    writeFileSync(join(temp, "usage-model-rates.json"), JSON.stringify({ version: 1, source: pricingUrl, fetchedAt: Date.now(),
      document: { "claude-opus-5-5": { input_cost_per_token: 0.000004, output_cost_per_token: 0.00002 } } }));
    controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT, env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath, CONTROL_PLANE_USAGE_PRICING_URL: pricingUrl, WOLLIPOG_WEB_DIST: webDist },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: unknown) => {
      const text = String(chunk);
      if (text.includes(seeded.frameMarker)) frameLogged = true;
      output = (output + text).slice(-8_192);
    };
    controlPlane.stdout?.on("data", capture);
    controlPlane.stderr?.on("data", capture);
    let ready = false;
    for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
      if (controlPlane.exitCode !== null) throw new Error("control plane exited early");
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* still starting */ }
      if (!ready) await delay(50);
    }
    if (!ready) throw new Error("control plane did not become healthy");
    // The runner hosts the controller and child, so registration keeps them, and their decision, live.
    runner = await connectRunner(base, seeded.runnerToken, workspacePath, [seeded.parentId, seeded.childId]);
    // Startup stopped every seeded Session while no runner was connected. Restore the fixture's
    // live controller and child so their exact credentials reach the real routes. The server is
    // already writing (runner registration), so this second connection can meet its lock (#3801).
    await withLiveDb(databasePath, (db) => {
      db.updateSessionStatus(seeded.parentId, "running", Date.now());
      db.updateSessionStatus(seeded.childId, "running", Date.now());
      // The seed dispatched the reviewer before this process started, so startup stopped its
      // never-hosted Session; restore the unsent state the dispatch receipt below moves to running.
      db.updateSessionStatus(seeded.dispatch.grant.reviewerSessionId, "queued", Date.now());
    });

    await page.goto(`${base}/#pair=${ownerToken}`);
    await page.goto(`${base}${viewPath({ name: "session", id: seeded.parentId })}`);
    const toggle = page.getByRole("button", { name: "Side Panel" }).first();
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
    await page.locator('.session-tools [data-tool="requests"]').click();
    const handling = page.locator(".request-panel-group", { hasText: "Orchestrator Is Handling" });
    await expect(handling.locator(".request-panel-row")).toHaveCount(1, { timeout: 30_000 });
    await expect(handling.locator(".request-panel-row")).toContainText("Video Evidence Child");

    const dispatch = seeded.dispatch;
    const reviewerId = dispatch.grant.reviewerSessionId;
    const owner = { authorization: `Bearer ${seeded.parentToken}`, "x-wollipog-agent-session": seeded.parentId, "content-type": "application/json" };
    const provenance = async () => {
      const response = await fetch(`${base}/api/sessions/${seeded.parentId}/video-evidence-review/provenance`, {
        method: "POST", headers: owner, body: JSON.stringify({ reviewId: dispatch.grant.reviewId }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect((await provenance()).body.status).toBe("pending");

    runner.send(runner.accepted(dispatch));
    const reviewerToken = "delegated-video-reviewer-token";
    runner.send({ type: "agent_control_credential", sessionId: reviewerId, tokenHash: sha(reviewerToken) });
    expect((await runner.waitFor((message) => message.type === "agent_control_credential_registered" &&
      message.sessionId === reviewerId)).accepted).toBe(true);
    const reviewer = { authorization: `Bearer ${reviewerToken}`, "x-wollipog-agent-session": reviewerId, "content-type": "application/json" };
    const media = (action: string, body: unknown) => fetch(`${base}/api/sessions/${reviewerId}/video-evidence-review/${action}`,
      { method: "POST", headers: reviewer, body: JSON.stringify(body) });
    // Delivery stays window-bound: the reviewer cannot start the next window early or name none.
    expect((await media("frames", { reviewId: dispatch.grant.reviewId, index: 0 })).status).toBe(409);
    const windows = pacedVideoReviewWindowPlan(dispatch.grant.frames).windows;
    expect((await media("frames", { reviewId: dispatch.grant.reviewId, index: windows[1]!.firstIndex, end: windows[1]!.endIndex })).status).toBe(409);
    let receipts = 0;
    for (const window of windows) {
      for (let cursor = window.firstIndex; cursor < window.endIndex;) {
        const response = await media("frames", { reviewId: dispatch.grant.reviewId, index: cursor, end: window.endIndex });
        expect(response.status).toBe(200);
        const batch = await response.json() as { nextIndex: number;
          deliveries: Array<{ data: string; receipt: { receiptId: string; sha256: string; windowIndex: number } }> };
        for (const delivery of batch.deliveries) {
          expect(sha(Buffer.from(delivery.data, "base64"))).toBe(delivery.receipt.sha256);
          expect(delivery.receipt.windowIndex).toBe(window.index);
        }
        expect((await media("acknowledge-frames", { reviewId: dispatch.grant.reviewId,
          receipts: batch.deliveries.map((d) => ({ receiptId: d.receipt.receiptId, sha256: d.receipt.sha256 })) })).status).toBe(200);
        receipts += batch.deliveries.length;
        cursor = batch.nextIndex;
      }
    }
    expect(receipts, "each overlap frame is receipted once per window").toBe(dispatch.grant.frames.length + windows.length - 1);
    const verdictResponse = await media("verdict", { reviewId: dispatch.grant.reviewId, report: { outcome: "accept",
      rationale: "Synthetic end-to-end contract test; no model reviewed these frames.",
      criteria: [{ criterionId: "visual_defects", outcome: "pass", observedFrameIndices: [64], observation: "Disclosed synthetic observation." },
        { criterionId: "coherent_flow", outcome: "pass", observedFrameIndices: [65], observation: "Disclosed synthetic observation." }] } });
    expect(verdictResponse.status).toBe(200);
    const verdict = await verdictResponse.json() as { verdictId: string };
    // The reviewer credential reaches only the media methods, and the owner never reads media.
    expect((await fetch(`${base}/api/sessions/${reviewerId}/video-evidence-review/provenance`,
      { method: "POST", headers: reviewer, body: JSON.stringify({ reviewId: dispatch.grant.reviewId }) })).status).toBe(401);
    expect((await fetch(`${base}/api/sessions/${seeded.parentId}/video-evidence-review/frames`, { method: "POST", headers: owner,
      body: JSON.stringify({ reviewId: dispatch.grant.reviewId, index: 0, end: windows[0]!.endIndex }) })).status).toBe(401);
    expect((await provenance()).body.status, "a verdict without settled final usage stays pending").toBe("pending");

    runner.send(runner.finished(dispatch));
    let complete: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt += 1) {
      complete = (await provenance()).body;
      if (complete.status === "complete") break;
      await delay(50);
    }
    expect(complete.status).toBe("complete");
    expect(complete.typedDecisionResolved).toBe(false);
    expect(complete.reviewer).toEqual({ sessionId: reviewerId, driver: "claude-code", model: "claude-opus-5-5", effort: "high" });
    const reference = { evidenceId: seeded.evidenceId, reviewId: dispatch.grant.reviewId, verdictId: verdict.verdictId, reviewerSessionId: reviewerId };
    expect(complete.resolveWith).toEqual(reference);

    const resolved = await fetch(`${base}/api/sessions/${seeded.parentId}/descendant-requests/resolve`, { method: "POST", headers: owner,
      body: JSON.stringify({ sessionId: seeded.childId, occurrenceId: seeded.occurrenceId, resolution: {
        action: "resolve_workflow_decision", outcome: "approve", evidenceReviewed: [], delegatedVideoEvidence: [reference] } }) });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    await expect(page.locator(".request-panel .state-title")).toHaveText("Nothing Waiting", { timeout: 30_000 });
    const decision = await fetch(`${base}/api/sessions/${seeded.childId}/workflow-decisions/${seeded.occurrenceId}`,
      { headers: { authorization: `Bearer ${ownerToken}` } });
    expect((await decision.json()).delegatedVideoEvidence).toEqual([reference]);
    // The reviewer is an ordinary visible Session the owner can audit, completed with its own usage.
    await page.goto(`${base}${viewPath({ name: "session", id: reviewerId })}`);
    await expect(page.getByText("Video Evidence Review", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(frameLogged, "control-plane logs must not contain delivered frames").toBe(false);
  } catch (error) {
    const safeOutput = output.replace(/[A-Za-z0-9+/]{120,}={0,2}/gu, "[redacted media]");
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${safeOutput}`);
  } finally {
    runner?.socket.close();
    if (controlPlane) await stopChild(controlPlane);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});
