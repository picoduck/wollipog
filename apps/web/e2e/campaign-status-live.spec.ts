import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  defaultLocalDeviceTokenPath, loadOrCreateLocalDeviceToken,
} from "../../control-plane/src/local-device-credential.js";
import { viewPath } from "../src/navigation.js";
import { restoreCampaignStatuses, seedCampaignStatus } from "./fixtures/campaign-status-seed.js";

/**
 * Campaign Status (#2417) in the real app against a real control plane and its Read API: the merged
 * panel must read the server's summary, pages and details without a shape mismatch.
 *
 * Set CAMPAIGN_STATUS_EVIDENCE_DIR to also save the summary, list, details and member view at
 * 1440x900 and 390px in light and dark.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EVIDENCE_DIR = process.env.CAMPAIGN_STATUS_EVIDENCE_DIR;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("failed to reserve a loopback port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
  return address.port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())), delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function openCampaignStatus(page: Page, base: string, sessionId: string) {
  await page.goto(`${base}${viewPath({ name: "session", id: sessionId })}`);
  const toggle = page.getByRole("button", { name: "Side Panel" }).first();
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  const row = page.locator(".rp-launcher .rp-row", { hasText: "Campaign Status" });
  // A remembered mode opens straight into Campaign Status; otherwise pick it from the launcher.
  if (await row.isVisible().catch(() => false)) {
    await expect(row).not.toHaveAttribute("aria-disabled", "true");
    await row.click();
  }
  await expect(page.locator(".campaign-status-summary")).toBeVisible();
}

test("Campaign Status reads the live Read API for a campaign, its items and a member", async ({ page }) => {
  test.setTimeout(240_000);
  let temp: string | null = null;
  let controlPlane: ChildProcess | null = null;
  let output = "";
  const apiFailures: string[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/campaign/") && response.status() >= 400) {
      apiFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  try {
    temp = mkdtempSync(join(tmpdir(), "wollipog-campaign-status-"));
    const databasePath = join(temp, "control-plane.db");
    const workspacePath = join(temp, "workspace");
    const webDist = join(temp, "web-dist");
    mkdirSync(workspacePath);
    const ownerToken = loadOrCreateLocalDeviceToken(defaultLocalDeviceTokenPath(databasePath));
    const seeded = seedCampaignStatus(databasePath, workspacePath);
    const built = spawnSync("pnpm", ["--dir", "apps/web", "exec", "vite", "build", "--outDir", webDist], {
      cwd: REPO_ROOT, encoding: "utf8", timeout: 90_000, shell: process.platform === "win32",
    });
    if (built.status !== 0 || !existsSync(join(webDist, "index.html"))) {
      throw new Error(`web build failed: ${(built.stderr ?? "").slice(-2000)} ${(built.stdout ?? "").slice(-2000)}`);
    }
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(RUNNER_|CONTROL_PLANE_|WOLLIPOG_)/u.test(key)) delete env[key];
    controlPlane = spawn(process.execPath, ["--import", "tsx", "apps/control-plane/src/index.ts"], {
      cwd: REPO_ROOT,
      env: { ...env, CONTROL_PLANE_HOST: "127.0.0.1", CONTROL_PLANE_PORT: String(port),
        CONTROL_PLANE_DB: databasePath, CONTROL_PLANE_USAGE_PRICING_URL: "off", WOLLIPOG_WEB_DIST: webDist },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk: unknown) => { output = (output + String(chunk)).slice(-8_192); };
    controlPlane.stdout?.on("data", capture);
    controlPlane.stderr?.on("data", capture);
    let ready = false;
    for (let attempt = 0; attempt < 400 && !ready; attempt += 1) {
      if (controlPlane.exitCode !== null) throw new Error("control plane exited early");
      try { ready = (await fetch(`${base}/healthz`)).ok; } catch { /* still starting */ }
      if (!ready) await delay(50);
    }
    if (!ready) throw new Error("control plane did not become healthy");
    restoreCampaignStatuses(databasePath, seeded);

    // The browser endpoints answer for the root and for any member, with the documented shapes.
    const headers = { authorization: `Bearer ${ownerToken}` };
    const summary = await (await fetch(`${base}/api/sessions/${seeded.panelId}/campaign/summary`, { headers })).json() as {
      campaignSessionId: string; summary: { planState: string; counts: { committed: number; delivered: number } };
    };
    expect(summary.campaignSessionId).toBe(seeded.rootId);
    expect([summary.summary.planState, summary.summary.counts.committed, summary.summary.counts.delivered]).toEqual(["recorded", 7, 1]);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/#pair=${ownerToken}`);
    await expect(page.getByText("#2417 Campaign Orchestrator").first()).toBeVisible({ timeout: 30_000 });

    // Campaign: summary from the live projection, the unfinished list from the paginated route.
    await openCampaignStatus(page, base, seeded.rootId);
    const panel = page.locator(".campaign-status");
    const summaryBox = page.locator(".campaign-status-summary");
    await expect(summaryBox).toContainText("1 of 7 Delivered");
    await expect(summaryBox).toContainText("1 rejected, 0 deferred, 1 duplicate");
    await expect(summaryBox).not.toContainText("$0.00");
    const rows = page.locator(".campaign-work-row");
    // Unfinished by default: running, blocked (recorded and by dependency), waiting, planned.
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText("Campaign Status Panel");
    await expect(rows.filter({ hasText: "Ledger Read API" })).toHaveAttribute("data-state", "blocked");
    await expect(rows.filter({ hasText: "Observed Forge Status" })).toHaveAttribute("data-state", "blocked");
    await expect(rows.filter({ hasText: "Time and Cost Attribution" })).toHaveAttribute("data-state", "waiting");

    // Details: reported stage and observed facts are separate, with their freshness.
    await rows.filter({ hasText: "Ledger Read API" }).click();
    await expect(page.locator("h3.campaign-detail-title")).toHaveText("Ledger Read API");
    await expect(panel).toContainText("Waiting for a merge decision on the storage pull request.");
    await expect(panel).toContainText("Rebase onto main once storage merges.");
    await expect(panel.locator("dd", { hasText: /Observed|Stale, observed/u }).first()).toBeVisible();
    await page.getByRole("button", { name: "Back to Work Items" }).click();

    // The delivered, archived item keeps its history behind the finished filter.
    await page.getByRole("button", { name: /^State:/ }).click();
    await page.getByRole("option", { name: "All States" }).click();
    await expect(rows).toHaveCount(8);
    await rows.filter({ hasText: "Campaign Work Ledger Contract" }).click();
    await expect(panel).toContainText("Verified Delivered");
    await expect(panel).toContainText("archived");
    await page.getByRole("button", { name: "Back to Work Items" }).click();

    // Member: the child's own assignment is highlighted from its membership.
    await openCampaignStatus(page, base, seeded.panelId);
    const assignment = page.locator(".campaign-work-row.is-assignment");
    await expect(assignment).toContainText("Campaign Status Panel");
    await expect(page.locator(".campaign-status-context")).toContainText("#2417 Campaign Orchestrator");
    expect(apiFailures).toEqual([]);

    if (EVIDENCE_DIR) {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      for (const scheme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.evaluate((theme) => localStorage.setItem("wollipog.theme", theme), scheme);
        for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "phone", width: 390, height: 844 }]) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          const shot = (view: string) => page.screenshot({ path: join(EVIDENCE_DIR, `${view}-${viewport.name}-${scheme}.png`) });
          await openCampaignStatus(page, base, seeded.rootId);
          await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
          await expect(rows.first()).toBeVisible();
          await shot("summary-list");
          await rows.filter({ hasText: "Ledger Read API" }).click();
          await expect(page.locator("h3.campaign-detail-title")).toHaveText("Ledger Read API");
          await shot("details");
          await panel.getByRole("heading", { name: "Delivery", exact: true })
            .evaluate((element) => element.scrollIntoView({ block: "start" }));
          await shot("details-observed");
          await openCampaignStatus(page, base, seeded.panelId);
          await expect(assignment).toBeVisible();
          await shot("member");
        }
      }
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${output}`);
  } finally {
    if (controlPlane) await stopChild(controlPlane);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});
