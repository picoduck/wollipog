import { expect, test } from "@playwright/test";

test("workspace paths and exact diff lines become inspectable prompt attachments", async ({ page }) => {
  await page.goto("/workspace-references-e2e.html?state=after&theme=dark");
  await expect(page.getByRole("listbox", { name: "Workspace Paths" })).toBeVisible();
  await page.getByRole("option", { name: /src\/session\.ts/ }).click();
  await expect(page.getByRole("button", { name: /Inspect Workspace Reference src\/session\.ts$/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Worktree Line 19 for Prompt" }).check();
  await page.getByRole("checkbox", { name: "Select Worktree Line 20 for Prompt" }).check();
  await page.getByRole("button", { name: "Attach Selected (2)" }).click();
  await expect(page.getByRole("button", { name: /Inspect Workspace Reference src\/session\.ts:19-20 · Worktree/ })).toBeVisible();
});

test("@ rows show an icon, the name before its folder, and the match underlined, without emoji", async ({ page }) => {
  await page.goto("/workspace-references-e2e.html?state=after&theme=dark");
  const listbox = page.getByRole("listbox", { name: "Workspace Paths" });
  await expect(listbox).toBeVisible();
  await expect(listbox).not.toContainText(/📁|📄/u);

  const nested = page.getByRole("option", { name: "apps/web/src/components/session/index.ts" });
  await expect(nested.locator("svg")).toHaveCount(1);
  await expect(nested.locator(".picker-name")).toHaveText("index.ts");
  await expect(nested.locator(".picker-path")).toHaveText("apps/web/src/components/session");
  await expect(nested.locator(".picker-path mark")).toHaveText("session");
  const [name, folder] = await Promise.all([nested.locator(".picker-name").boundingBox(), nested.locator(".picker-path").boundingBox()]);
  expect(name!.x).toBeLessThan(folder!.x);

  // A long folder keeps its end and loses its start.
  await page.setViewportSize({ width: 600, height: 900 });
  const long = page.getByRole("option", { name: /session-index\.ts$/ });
  const path = long.locator(".picker-path");
  await expect(path).toHaveCSS("direction", "rtl");
  await expect(path).toHaveCSS("text-overflow", "ellipsis");
  // The text overflows its box on the left, and its end lines up with the box's right edge.
  const [box, text] = await Promise.all([path.boundingBox(), path.locator("bdi").boundingBox()]);
  expect(text!.x).toBeLessThan(box!.x);
  expect(Math.abs(text!.x + text!.width - (box!.x + box!.width))).toBeLessThanOrEqual(1);
  await expect(long.locator(".picker-name mark")).toHaveText("session");
});

test("the @ picker's states each say one plain thing", async ({ page }) => {
  const open = async (state: string) => {
    await page.goto(`/workspace-references-e2e.html?state=after&theme=dark&picker=${state}`);
    await expect(page.locator(".picker")).toBeVisible();
  };

  await open("noquery");
  await expect(page.locator(".picker-empty")).toHaveText("Type a file or folder name.Searches wollipog on Studio Mac.");
  await expect(page.getByRole("option")).toHaveCount(0);

  await open("busy");
  await expect(page.getByRole("status")).toHaveText("Searching the workspace…");

  await open("offline");
  const offline = page.getByRole("alert");
  await expect(offline).toHaveText("Studio Mac is offline. Try again when it reconnects.");
  await expect(offline.locator("svg")).toHaveCount(1);

  await open("error");
  await expect(page.getByRole("alert")).toHaveText("Couldn't search the workspace. Try again.");
  await expect(page.locator(".picker")).not.toContainText("ECONNRESET");

  await open("none");
  await expect(page.getByRole("status")).toHaveText("No files or folders match “zzzz”.");

  await open("truncated");
  await expect(page.locator(".picker-foot .picker-note")).toHaveText("More matches exist. Keep typing to narrow them.");
  await expect(page.getByRole("option")).toHaveCount(4);
});
