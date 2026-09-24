import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import {
  defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken,
} from "../../control-plane/src/local-device-credential.js";
import { seedDelegatedUiEvidence } from "./fixtures/delegated-ui-evidence-seed.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (
    error ? reject(error) : resolvePromise()
  )));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    delay(5_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("a browser sees delegated image review complete through live scoped routes and receipts", async ({ page }) => {
  test.setTimeout(120_000);
  const temp = mkdtempSync(join(tmpdir(), "wollipog-delegated-ui-evidence-"));
  const databasePath = join(temp, "control-plane.db");
  const workspacePath = join(temp, "workspace");
  mkdirSync(workspacePath);
  const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
  const seeded = seedDelegatedUiEvidence(databasePath, workspacePath);
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  let output = "";
  let controlPlane: ChildProcess | null = null;
  try {
    // Serve the exact source build in the browser, not a bundle left by another test run.
    const built = spawnSync("pnpm", ["--filter", "@wollipog/web", "build"], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 60_000,
    });
    if (built.status !== 0 || !existsSync(join(REPO_ROOT, "apps/web/dist/index.html"))) {
      throw new Error(`web build failed: ${built.stderr.slice(-2000)} ${built.stdout.slice(-2000)}`);
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(RUNNER_|CONTROL_PLANE_)/u.test(key)) delete env[key];
    controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    controlPlane.stdout?.on("data", (chunk) => { output = (output + String(chunk)).slice(-8_192); });
    controlPlane.stderr?.on("data", (chunk) => { output = (output + String(chunk)).slice(-8_192); });
    let ready = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (controlPlane.exitCode !== null) throw new Error(`control plane exited early: ${output}`);
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* still starting */ }
      if (ready) break;
      await delay(50);
    }
    if (!ready) throw new Error(`control plane did not become healthy: ${output}`);
    // Startup marks sessions with no connected runner stopped. Restore their fixture status after
    // recovery, so an exact live agent credential can exercise the real authorization routes.
    const db = ControlPlaneDb.open(databasePath);
    try {
      db.updateSessionStatus(seeded.parentId, "running", Date.now());
      db.updateSessionStatus(seeded.childId, "running", Date.now());
    } finally { db.close(); }

    await page.goto(`${base}/#pair=${ownerToken}`);
    await expect(page.getByText(/Orchestrator Action/u)).toBeVisible();
    const route = `${base}/api/sessions/${seeded.parentId}/descendant-requests`;
    const agentHeaders = { authorization: `Bearer ${seeded.parentToken}`,
      "x-wollipog-agent-session": seeded.parentId, "content-type": "application/json" };
    const resolveDecision = () => fetch(`${route}/resolve`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ sessionId: seeded.childId, occurrenceId: seeded.occurrenceId,
        resolution: { action: "resolve_workflow_decision", outcome: "approve", evidenceReviewed: ["capture"] } }),
    });
    expect((await resolveDecision()).status, "identifiers alone cannot authorize approval").toBe(409);
    const crossSession = await fetch(`${route}/review-ui-evidence`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ sessionId: seeded.parentId, occurrenceId: seeded.occurrenceId, evidenceId: "capture" }),
    });
    expect(crossSession.status, "the receipt route is scoped to the exact descendant").toBe(404);
    const review = await fetch(`${route}/review-ui-evidence`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ sessionId: seeded.childId, occurrenceId: seeded.occurrenceId, evidenceId: "capture" }),
    });
    expect(review.status).toBe(200);
    const delivered = await review.json() as { data: string; receipt: { receiptId: string; sha256: string } };
    expect(createHash("sha256").update(Buffer.from(delivered.data, "base64")).digest("hex"))
      .toBe(seeded.evidence.sha256);
    expect(delivered.receipt.sha256).toBe(seeded.evidence.sha256);
    expect((await resolveDecision()).status, "unacknowledged delivery cannot authorize approval").toBe(409);
    const acknowledge = (sha256: string) => fetch(`${route}/review-ui-evidence/acknowledge`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ receiptId: delivered.receipt.receiptId, sha256 }),
    });
    expect((await acknowledge("0".repeat(64))).status).toBe(409);
    expect((await acknowledge(seeded.evidence.sha256)).status).toBe(200);
    expect((await resolveDecision()).status).toBe(200);
    await expect(page.getByText(/Orchestrator Action/u)).toHaveCount(0);
    await expect(page.getByText("Evidence Child", { exact: true })).toBeVisible();
    const staleReview = await fetch(`${route}/review-ui-evidence`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ sessionId: seeded.childId, occurrenceId: seeded.occurrenceId, evidenceId: "capture" }),
    });
    expect(staleReview.status).toBe(409);

    const decisionResponse = await fetch(
      `${base}/api/sessions/${seeded.childId}/workflow-decisions/${seeded.occurrenceId}`,
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    expect(decisionResponse.status).toBe(200);
    expect((await decisionResponse.json()).status).toBe("approved");
    const audit = await fetch(`${base}/api/sessions/${seeded.childId}/governance-audit`,
      { headers: { authorization: `Bearer ${ownerToken}` } });
    expect(audit.status).toBe(200);
    const auditText = await audit.text();
    expect(auditText).toContain(seeded.evidence.sha256);
    expect(auditText).toContain(delivered.receipt.receiptId);
    expect(auditText).not.toContain(delivered.data);
    expect(auditText).not.toContain(seeded.parentToken);
    expect(output).not.toContain(delivered.data);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${output}`);
  } finally {
    if (controlPlane) await stopChild(controlPlane);
    rmSync(temp, { recursive: true, force: true });
  }
});
