import { expect, test } from "@playwright/test";

test("request diff is distinct from local Branch and safely read-only", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?request=1&theme=dark&partial=1");
  await page.getByText("Request Diff", { exact: true }).click();
  await expect(page.getByText("authoritative request head", { exact: true })).toBeVisible();
  const diff = page.locator("details").filter({ has: page.getByRole("button", { name: "Reload Request Diff" }) });
  await expect(diff).toContainText("release");
  await expect(diff).toContainText("a".repeat(40));
  await expect(diff).toContainText("This diff is incomplete.");
  await expect(diff.getByRole("button", { name: /Stage|Discard|Add Finding/ })).toHaveCount(0);
  await expect(diff.getByRole("link", { name: "Open Request on Forge" })).toHaveAttribute("href", "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19");
  if (process.env.CAPTURE_1270) {
    await diff.getByRole("link", { name: "Open Request on Forge" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/1270-request-dark.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/forge-review-e2e.html?request=1&theme=light");
    await page.getByText("Request Diff", { exact: true }).click();
    await expect(page.getByText("authoritative request head", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open Request on Forge" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/1270-request-mobile-light.png", fullPage: true });
  }
});

test("unsupported, wrong-request and stale reads never display local changes as the request", async ({ page }) => {
  for (const variant of ["oldDiff", "wrong", "stale", "authError"]) {
    await page.goto(`/forge-review-e2e.html?request=1&${variant}=1`);
    await page.getByText("Request Diff", { exact: true }).click();
    await expect(page.getByText(variant === "oldDiff" ? /does not support request diffs/ : variant === "wrong" ? /did not return a diff/ : variant === "authError" ? /Authenticated GitLab integration is unavailable/ : /revisions changed while loading/)).toBeVisible();
    await expect(page.getByText("authoritative request head", { exact: true })).toHaveCount(0);
  }
});

test("MR context and named checks stay beside the existing thread bundle pipeline (#1270)", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?request=1&theme=dark");
  const request = page.getByRole("group", { name: "Merge Request", exact: true });
  await expect(request).toContainText("Base");
  await expect(request).toContainText("release");
  await expect(request).toContainText("feature/gitlab");
  await expect(request.locator("summary")).toHaveText("Checks (Pipeline Failing)");
  await request.locator("summary").click();
  await expect(request.getByRole("link", { name: "unit", exact: true })).toHaveAttribute("href", /\/jobs\/11$/);
  await expect(request).toContainText("unit — Failing");
  await expect(request).toContainText("typecheck — Passing");
  if (process.env.CAPTURE_1270) await page.screenshot({ path: "/tmp/1270-desktop-dark.png", fullPage: true });
  await page.getByRole("checkbox", { name: "Select Finding on src/gitlab.ts Line 42" }).check();
  await page.getByRole("button", { name: "Send to Agent", exact: true }).click();
  await expect(page.getByText("Sent 1 finding to Codex App Server.", { exact: true })).toBeVisible();
  if (process.env.CAPTURE_1270) {
    await page.screenshot({ path: "/tmp/1270-bundled-dark.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/forge-review-e2e.html?request=1&theme=light");
    await page.getByRole("group", { name: "Merge Request", exact: true }).locator("summary").click();
    await page.screenshot({ path: "/tmp/1270-mobile-light.png", fullPage: true });
  }
});

test("GitLab review surfaces use merge-request terminology and provenance", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?theme=dark");
  const commitBar = page.getByRole("region", { name: "Commit" });
  await expect(commitBar.getByRole("button", { name: "Open Merge Request…" })).toBeVisible();
  await commitBar.getByRole("button", { name: "Open Merge Request…" }).click();
  const dialog = page.getByRole("dialog", { name: "Open Merge Request" });
  await expect(dialog.getByRole("button", { name: "Open Merge Request" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Sync GitLab" })).toBeVisible();
  // Provenance in words (#2850): the forge login and its forge, never a scope or a diff side.
  const findings = page.getByRole("region", { name: "Findings" });
  await expect(findings.locator(".review-finding-meta").first()).toHaveText("reviewer on GitLab · 1h ago");
  await expect(findings).not.toContainText("All Branch");
  await expect(findings).not.toContainText("Right");
  await expect(findings.getByText("Merge request discussion", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Remote Discussion" })).toBeVisible();
  await expect(findings.getByRole("link", { name: "Resolve on GitLab" }).first()).toHaveAttribute(
    "href",
    "https://gitlab.example.test/team/sub/wollipog/-/merge_requests/19#note_119",
  );
  await expect(findings).not.toContainText("Remote-Owned");
});

test("a pre-v106 runner retains the legacy generic-Git action surface", async ({ page }) => {
  await page.goto("/forge-review-e2e.html?legacy=1");
  await expect(page.getByRole("region", { name: "Commit" }).getByRole("button", { name: "Open Pull Request…" })).toBeVisible();
  // That runner reports no forge, and a self-hosted remote is plain Git to it: nothing to sync (#2850).
  await expect(page.getByRole("region", { name: "Findings" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Sync / })).toHaveCount(0);
});
