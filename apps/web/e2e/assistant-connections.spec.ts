import { test, expect, type Locator, type Page } from "@playwright/test";
import { assistantUiServer } from "../../control-plane/test-support/assistant-ui-server.js";
import { expectFullyInViewport, expectNoHorizontalOverflow, expectPageNoHorizontalOverflow } from "./layout-invariants.js";

type Server = Awaited<ReturnType<typeof assistantUiServer>>;
const nameField = (page: Page) => page.getByLabel("Connection Name", { exact: true });
const credentialField = (page: Page) => page.getByLabel("Assistant Credential", { exact: true });
const openList = (page: Page) => page.getByRole("button", { name: /^All Connections/ }).click();
const newConnection = (page: Page) => page.getByRole("button", { name: "New Connection", exact: true }).click();
const createConnection = (page: Page) => page.getByRole("button", { name: "Create Connection", exact: true });
const openRotate = (page: Page) => page.getByRole("button", { name: "Rotate Credential…", exact: true }).click();
const confirmation = (page: Page, title: string) => page.getByRole("dialog", { name: title, exact: true });
const done = (page: Page) => page.getByRole("button", { name: "Done", exact: true }).click();

async function visit(page: Page, server: Server, theme = "dark", route = "") {
  await page.addInitScript(setup => {
    (window as unknown as { assistantTest: unknown }).assistantTest = setup;
  }, { origin: server.origin, ownerCredential: server.ownerCredential });
  await page.goto("/assistant-connections-e2e.html?theme=" + theme + "&route=" + encodeURIComponent(route || "/settings/assistant"));
}

function ownerFor(server: Server) {
  const local = server.db.localIdentityContext();
  return server.db.operatingHumanPrincipal(local.userId, local.organizationId)!;
}

async function capture(page: Page, theme: string, state: string, focus?: Locator, measurement = "") {
  if (focus) {
    await focus.scrollIntoViewIfNeeded();
    await expect(focus).toBeInViewport();
  }
  await expectPageNoHorizontalOverflow(page);
  await expectNoHorizontalOverflow(page.locator(".main-body"));
  await checkLegibility(page);
  const directory = process.env.ASSISTANT_EVIDENCE_DIR;
  const { width, height } = page.viewportSize()!;
  const only = process.env.ASSISTANT_EVIDENCE_STATES?.split(",");
  if (directory && (!only || only.includes(width + ":" + state))) {
    const id = ["assistant-connections", width + "x" + height, theme, state, measurement].filter(Boolean).join("-");
    await page.screenshot({ path: directory + "/" + id + ".png", animations: "disabled" });
  }
}

async function checkLegibility(page: Page) {
  const failures = await page.evaluate(() => {
    const root = document.querySelector('.modal-panel[aria-modal="true"]:not([hidden])')
      ?? document.querySelector('.menu[role="menu"]')
      ?? document.querySelector(".assistant-connections-page, .settings-panel");
    if (!root) throw new Error("The evidence surface did not render.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const luminance = (pixels: Uint8ClampedArray) => {
      const [r, g, b] = Array.from(pixels.slice(0, 3), value => {
        const srgb = value / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const paint = (color: string) => {
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
    };
    const visibleText = Array.from(root.querySelectorAll<HTMLElement>([
      ".setting-row-title", ".setting-row-desc", ".settings-group-title", ".settings-group-scope",
      ".settings-group-desc", ".choice-row-title", ".choice-row-desc", ".field > span", ".status",
      ".modal-title", ".modal-desc", ".menu-text", ".btn", ".seg-option", ".ui-select-trigger",
      "th", "td", "input:not([type=checkbox])",
    ].join(", ")));
    return visibleText.flatMap(element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight ||
        style.visibility === "hidden" || element.closest('[aria-hidden="true"]')) return [];
      const label = element.textContent?.trim().slice(0, 70) || element.tagName;
      const errors: string[] = [];
      if (Number.parseFloat(style.fontSize) < 12) errors.push(label + " is below 12 CSS px");
      const control = element.closest('button, input, [role="menuitem"], .choice-row');
      if (!control || control.matches(':disabled, [aria-disabled="true"], .is-disabled')) return errors;
      const backgrounds = [];
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        backgrounds.unshift(getComputedStyle(node).backgroundColor);
      }
      paint("white");
      backgrounds.forEach(paint);
      const ground = luminance(context.getImageData(0, 0, 1, 1).data);
      paint(style.color);
      const ink = luminance(context.getImageData(0, 0, 1, 1).data);
      const contrast = (Math.max(ink, ground) + 0.05) / (Math.min(ink, ground) + 0.05);
      if (contrast < 4.5) errors.push(label + " contrast is " + contrast.toFixed(2) + ":1");
      return errors;
    });
  });
  expect(failures).toEqual([]);
}

async function targetSize(target: Locator, minimum: number) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const hit = await target.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const extension = getComputedStyle(element, "::after");
    if (extension.content === "none" || extension.position !== "absolute") {
      return { width: bounds.width, height: bounds.height };
    }
    // Shared coarse-pointer targets extend from the padding edge of the painted box.
    const outside = (inset: string, border: string) =>
      Math.max(0, -(Number.parseFloat(inset) + Number.parseFloat(border))) || 0;
    return {
      width: bounds.width + outside(extension.left, style.borderLeftWidth) + outside(extension.right, style.borderRightWidth),
      height: bounds.height + outside(extension.top, style.borderTopWidth) + outside(extension.bottom, style.borderBottomWidth),
    };
  });
  expect(hit.width).toBeGreaterThanOrEqual(minimum);
  expect(hit.height).toBeGreaterThanOrEqual(minimum);
  return box!;
}

for (const width of [1440, 390]) {
  test.describe(width === 390 ? "touch phone" : "desktop", () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, isMobile: width === 390 });
    for (const theme of ["light", "dark"] as const) {
      test(`connection Settings pages at ${width}px in ${theme}`, async ({ page, context }) => {
        test.setTimeout(60_000);
        const server = await assistantUiServer();
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"]);
          const minimum = width === 390 ? 44 : 24;
          const owner = ownerFor(server);
          const longName = "Desktop connection with a long workspace name and extended descriptive suffix";
          const issued = server.db.assistantConnections.create(owner, "Studio Assistant", { operations: "all", projects: "all" });
          const fixtures = Array.from({ length: 8 }, (_, index) => server.db.assistantConnections.create(
            owner, (index + 1) + " " + longName, { operations: ["assistant_discover"], projects: [server.project.id] },
          ));
          const target = { kind: "assistant_connection", id: fixtures[0]!.connection.id };
          server.db.assistantConnections.record(issued.connection, "assistant_discover", target, "succeeded");
          server.db.assistantConnections.record(issued.connection, "installation_rename", { kind: "control_plane", id: server.db.instanceId() }, "refused");
          server.db.assistantConnections.revoke(fixtures[7]!.connection.id);

          await page.emulateMedia({ colorScheme: theme });
          await page.goto("/assistants-e2e.html?limits=stress&path=" + encodeURIComponent("/settings/assistant"));
          const panel = page.locator(".settings-panel");
          await expect(panel.getByRole("heading", { name: "Thread Defaults" })).toBeVisible();
          const group = panel.getByRole("region", { name: "Assistant Connections", exact: true });
          const all = group.getByRole("button", { name: /^All Connections/ });
          await expect(all).toContainText("9");
          await expect(group.locator(".assistant-connection-row")).toHaveCount(3);
          await targetSize(group.getByRole("button", { name: "New Connection", exact: true }), minimum);
          await targetSize(all, minimum);
          if (width === 390) {
            const previews = await group.getByRole("button").all();
            const boxes = await Promise.all(previews.slice(1).map(preview => preview.boundingBox()));
            const gap = boxes.slice(1).map((box, index) => box!.y - boxes[index]!.y - boxes[index]!.height);
            expect(Math.min(...gap)).toBeGreaterThanOrEqual(8);
          }
          await group.getByRole("heading").scrollIntoViewIfNeeded();
          await capture(page, theme, "settings-entry", all);
          await visit(page, server, theme);
          await openList(page);
          await expect(page).toHaveURL(/settings%2Fassistant%2Fconnections/);
          await expect(page.getByRole("heading", { name: "Assistant Connections", exact: true })).toBeVisible();
          const rows = page.locator(".assistant-connection-row");
          await expect(rows).toHaveCount(9);
          await expect(rows.first()).toContainText(/Full Access · All Projects · Last used/);
          await expect(rows.last()).toContainText("Revoked");
          await expect(rows.last()).toContainText("Configured Access · 1 Selected Project · Never Used");
          const rowGap = await rows.evaluateAll(elements => elements.slice(1).map((row, i) => {
            return row.getBoundingClientRect().top - elements[i]!.getBoundingClientRect().bottom;
          }));
          if (width === 390) {
            expect(Math.min(...rowGap)).toBeGreaterThanOrEqual(8);
            await expect(rows.nth(1).locator(".setting-row-title")).toHaveCSS("-webkit-line-clamp", "2");
            const wraps = await rows.nth(1).locator(".setting-row-title").evaluate(title => {
              const line = Number.parseFloat(getComputedStyle(title).lineHeight);
              return title.clientHeight === Math.round(line * 2) && title.scrollHeight > title.clientHeight;
            });
            expect(wraps).toBe(true);
          }
          const newButton = page.getByRole("button", { name: "New Connection", exact: true });
          await targetSize(newButton, minimum);
          await expectFullyInViewport(newButton, "New Connection");
          await targetSize(rows.first(), minimum);
          await capture(page, theme, "list-stress", undefined, width === 390 ? "target44csspx-gap8csspx" : "target24csspx");
          await rows.last().scrollIntoViewIfNeeded();
          await expectFullyInViewport(newButton, "New Connection after scrolling");
          if (width === 390) {
            await expectFullyInViewport(rows.last(), "Revoked connection");
            await capture(page, theme, "list-stress-scrolled");
          }

          const copyId = page.getByRole("button", { name: "Copy Installation ID", exact: true });
          const rename = page.getByRole("button", { name: "Rename…", exact: true });
          const copyBox = await targetSize(copyId, minimum);
          const renameBox = await targetSize(rename, minimum);
          if (width === 390) expect(renameBox.x - copyBox.x - copyBox.width).toBeGreaterThanOrEqual(8);
          await copyId.click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(server.db.instanceId());
          await rename.click();
          const renameDialog = confirmation(page, "Rename Installation");
          await renameDialog.getByLabel("Installation Display Name").fill("Workbench");
          await renameDialog.getByRole("button", { name: "Save", exact: true }).click();
          await expect(page.getByText("Installation name saved.")).toBeVisible();
          await expect(page.getByText("Workbench", { exact: true })).toBeVisible();

          await rows.first().click();
          await expect(page.getByRole("heading", { name: issued.connection.name, exact: true })).toBeVisible();
          const switchControl = page.getByRole("switch", { name: "Ask Before Destructive Actions" });
          const fullAccess = page.getByRole("radio", { name: "Full Access", exact: true });
          const configured = page.getByRole("radio", { name: "Configured", exact: true });
          await expect(fullAccess).toHaveAttribute("aria-checked", "true");
          await expect(switchControl).toHaveAttribute("aria-checked", "false");
          const fullBox = await targetSize(fullAccess, minimum);
          const configuredBox = await targetSize(configured, minimum);
          await targetSize(switchControl, minimum);
          if (width === 390) expect(configuredBox.x - fullBox.x - fullBox.width).toBeGreaterThanOrEqual(8);
          await capture(page, theme, "detail-full-access");
          await switchControl.click();
          await expect(switchControl).toHaveAttribute("aria-checked", "true");
          await configured.click();
          const track = await page.getByRole("radiogroup", { name: "Management Access" }).boundingBox();
          const knob = await configured.boundingBox();
          expect(knob!.x).toBeGreaterThan(track!.x);
          expect(knob!.y).toBeGreaterThan(track!.y);
          expect(knob!.x + knob!.width).toBeLessThan(track!.x + track!.width);
          expect(knob!.y + knob!.height).toBeLessThan(track!.y + track!.height);
          const allowedOperations = page.getByRole("region", { name: "Allowed Operations" });
          await expect(allowedOperations.locator(".choice-row-title")).toHaveText([
            "Assistant Discover", "Connection List", "Connection Activity", "Project List",
          ]);
          await expect(allowedOperations.locator(".choice-row-desc code").first()).toBeVisible();
          const descriptions = await allowedOperations.locator(".choice-row-desc").evaluateAll(elements => elements.map(element => {
            const description = element.cloneNode(true) as HTMLElement;
            description.querySelector("code")?.remove();
            return description.textContent;
          }));
          expect(descriptions.join(" ")).not.toMatch(/assistant_discover|connection_list|connection_activity|project_list/);
          await targetSize(allowedOperations.locator(".choice-row").first(), minimum);
          await capture(page, theme, "detail-configured", allowedOperations.locator(".choice-row").first());

          const discoverRow = allowedOperations.locator(".choice-row").filter({ has: page.getByText("assistant_discover", { exact: true }) });
          await expect(discoverRow.locator(".choice-row-title")).toHaveText("Assistant Discover");
          await expect(discoverRow.locator("code")).toHaveText("assistant_discover");
          await discoverRow.getByRole("checkbox").check();
          await page.getByRole("button", { name: /^Projects:/ }).click();
          await page.getByRole("option", { name: "Selected Projects", exact: true }).click();
          await page.getByRole("checkbox", { name: "Assistant Sandbox" }).check();
          await page.getByRole("button", { name: "Save Connection", exact: true }).click();
          await expect(page.getByText("Connection saved.")).toBeVisible();
          const grant = server.db.assistantConnections.get(issued.connection.id)!.grant;
          expect(grant).toEqual({ operations: ["assistant_discover"], projects: [server.project.id], destructiveConfirmation: "confirm" });

          // Return to Full Access so the Activity table can be reached from the compact detail.
          await fullAccess.click();
          await page.getByRole("button", { name: "Save Connection", exact: true }).click();
          const stressProject = server.db.createProject({
            name: "International Workspace for Long-Running Assistant Work Across Multiple Local and Remote Machines",
            scope: { organizationId: owner.organizationId, owner: { kind: "user", userId: owner.userId } },
          });
          for (let index = 0; index < 24; index++) {
            server.db.assistantConnections.record(issued.connection, "assistant_discover",
              index % 3 === 0 ? target : { kind: "project", id: stressProject.id },
              index % 2 === 0 ? "refused" : "succeeded");
          }
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          const activity = page.getByRole("table", { name: "Connection Activity" });
          const activityScroll = page.getByRole("region", { name: "Recent Actions" });
          await expect(activity.getByRole("columnheader")).toHaveText(["Operation", "Target", "Outcome", "When"]);
          await expect(activity.locator("tbody tr")).toHaveCount(26);
          const longTarget = activity.getByRole("cell", { name: "Assistant Connection · " + fixtures[0]!.connection.name, exact: true }).first();
          await expect(longTarget).toBeVisible();
          await expect(activity.locator("code").getByText("assistant_discover", { exact: true }).first()).toBeVisible();
          await expect(activity.getByText("Succeeded", { exact: true }).first()).toBeVisible();
          await expect(activity.getByText("Refused", { exact: true }).first()).toBeVisible();
          await expectNoHorizontalOverflow(activityScroll);
          expect(await activityScroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
          if (width === 390) {
            expect(await activity.locator("tbody code").evaluateAll(identifiers => identifiers.every(identifier => {
              const range = document.createRange();
              range.selectNodeContents(identifier);
              return range.getClientRects().length === 1 && identifier.scrollWidth <= identifier.clientWidth;
            }))).toBe(true);
            const stressTarget = activity.getByRole("cell", { name: "Project · " + stressProject.name, exact: true }).first();
            expect(await stressTarget.locator(".assistant-activity-target").evaluate(element => {
              const style = getComputedStyle(element);
              return style.webkitLineClamp === "2" && element.scrollHeight > element.clientHeight
                && element.clientHeight <= Math.ceil(Number.parseFloat(style.lineHeight) * 2);
            })).toBe(true);
          }
          await capture(page, theme, "detail-activity", activityScroll);
          const copyConnectionId = page.getByRole("button", { name: "Copy Connection ID", exact: true });
          await targetSize(copyConnectionId, minimum);
          await copyConnectionId.click();
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(issued.connection.id);

          await openRotate(page);
          const rotation = confirmation(page, "Rotate Credential");
          const rotate = rotation.getByRole("button", { name: "Rotate Credential", exact: true });
          await targetSize(rotate, minimum);
          await capture(page, theme, "rotate-confirm", rotation);
          await rotation.getByRole("button", { name: "Cancel", exact: true }).click();
          expect(server.db.assistantConnections.authenticate(issued.token)).not.toBeNull();
          await openRotate(page);
          await rotate.click();
          await expect(credentialField(page)).toHaveAttribute("type", "password");
          await expect(credentialField(page)).toBeVisible();
          const rotatedToken = await credentialField(page).inputValue();
          expect(server.db.assistantConnections.authenticate(issued.token)).toBeNull();
          expect(server.db.assistantConnections.authenticate(rotatedToken)).not.toBeNull();
          await capture(page, theme, "credential-masked", confirmation(page, "Save Your Credential"));
          await page.getByRole("button", { name: "Show Credential", exact: true }).click();
          if (width === 390) {
            const field = credentialField(page);
            await expect(field).toHaveValue(rotatedToken);
            expect(await field.evaluate(element => element.tagName === "TEXTAREA"
              && element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
              && element.textContent === "")).toBe(true);
          } else {
            await expect(credentialField(page)).toHaveAttribute("type", "text");
          }
          await capture(page, theme, "credential-shown", confirmation(page, "Save Your Credential"));
          await done(page);
          await expect(credentialField(page)).toHaveCount(0);

          await page.getByRole("button", { name: "More Actions", exact: true }).click();
          const revokeItem = page.getByRole("menuitem", { name: "Revoke Connection…", exact: true });
          await targetSize(revokeItem, minimum);
          await capture(page, theme, "revoke-menu", revokeItem);
          await revokeItem.click();
          const revocation = confirmation(page, "Revoke Connection");
          const revoke = revocation.getByRole("button", { name: "Revoke Connection", exact: true });
          await targetSize(revoke, minimum);
          await capture(page, theme, "revoke-confirm", revocation);
          await revoke.click();
          await expect(page.getByText("Connection revoked.")).toBeVisible();
          await expect(page.getByRole("button", { name: "Save Connection" })).toBeDisabled();
          expect(server.db.assistantConnections.authenticate(rotatedToken)).toBeNull();

          await page.getByRole("button", { name: "Back to Assistant Connections", exact: true }).click();
          await expect(rows).toHaveCount(9);
          await expect(rows.first()).toContainText("Revoked");
          await newConnection(page);
          await expect(page.getByRole("heading", { name: "New Connection", exact: true })).toBeVisible();
          await expect(nameField(page)).toBeVisible();
          await expect(page.getByRole("radiogroup", { name: "Management Access", exact: true })).toBeVisible();
          await expect(page.getByText("Loading connections…", { exact: true })).toHaveCount(0);
          await capture(page, theme, "new-connection");
        } finally {
          await server.close();
        }
      });
    }
  });
}

test("the one-time credential is discarded on close and browser navigation", async ({ page }) => {
  const server = await assistantUiServer();
  try {
    await visit(page, server);
    await openList(page);
    await newConnection(page);
    await nameField(page).fill("OpenClaw Desktop");
    await createConnection(page).evaluate(button => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    const secret = credentialField(page);
    await expect(secret).toHaveAttribute("type", "password");
    const token = await secret.inputValue();
    expect(await secret.getAttribute("value")).toBeNull();
    expect(await page.locator("html").evaluate((element, value) => element.innerHTML.includes(value), token)).toBe(false);
    expect(await page.evaluate(value => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(value), token)).toBe(false);
    expect(server.db.assistantConnections.authenticate(token)).not.toBeNull();
    expect(server.db.assistantConnections.list(ownerFor(server))).toHaveLength(1);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true, value: { writeText: async () => { throw new Error("fixture denied"); } },
      });
      document.execCommand = () => false;
    });
    await page.getByRole("button", { name: "Copy Credential", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Choose Show Credential");
    await done(page);
    await expect(secret).toHaveCount(0);
    await expect(nameField(page)).toHaveValue("OpenClaw Desktop");

    await openRotate(page);
    await confirmation(page, "Rotate Credential").getByRole("button", { name: "Rotate Credential", exact: true }).click();
    await expect(secret).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show Credential", exact: true }).click();
    await expect(secret).toHaveAttribute("type", "text");
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Assistant Connections", exact: true })).toBeVisible();
    await expect(secret).toHaveCount(0);
    await page.goForward();
    await expect(nameField(page)).toHaveValue("OpenClaw Desktop");
    await expect(secret).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("switching control planes clears the shown credential", async ({ page }) => {
  const first = await assistantUiServer();
  const second = await assistantUiServer();
  const switchTo = (server: Server) => page.evaluate(detail => window.dispatchEvent(new CustomEvent("assistant-test-switch", { detail })),
    { origin: server.origin, ownerCredential: server.ownerCredential });
  try {
    await visit(page, first);
    await openList(page);
    await newConnection(page);
    await nameField(page).fill("First Connection");
    await createConnection(page).click();
    const secret = credentialField(page);
    await page.getByRole("button", { name: "Show Credential", exact: true }).click();
    await expect(secret).toHaveAttribute("type", "text");
    const token = await secret.inputValue();
    await switchTo(second);
    await expect(secret).toHaveCount(0);
    await expect(nameField(page)).toBeEmpty();
    await page.getByRole("button", { name: "Back to Assistant Connections", exact: true }).click();
    await expect(page.getByText("No Connections", { exact: true })).toBeVisible();
    expect(first.db.assistantConnections.authenticate(token)).not.toBeNull();
    expect(second.db.assistantConnections.authenticate(token)).toBeNull();
    await switchTo(first);
    await page.getByRole("button", { name: /^First Connection/ }).click();
    await expect(nameField(page)).toHaveValue("First Connection");
    await expect(secret).toHaveCount(0);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a forbidden owner read hides the Settings group and direct pages offer no grant controls", async ({ page }) => {
  const server = await assistantUiServer();
  try {
    await page.route("**/api/assistant-connections", route => route.fulfill({
      status: 403, json: { error: "Only an organization owner can manage Assistant Connections." },
    }));
    const response = page.waitForResponse(candidate => new URL(candidate.url()).pathname === "/api/assistant-connections");
    await visit(page, server);
    expect((await response).status()).toBe(403);
    await expect(page.getByRole("region", { name: "Assistant Connections" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^All Connections/ })).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await visit(page, server, "dark", "/settings/assistant/connections");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "New Connection", exact: true })).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("Settings connection rows and the group action open their dedicated pages", async ({ page }) => {
  const server = await assistantUiServer();
  try {
    server.db.assistantConnections.create(ownerFor(server), "Studio Assistant", { operations: "all", projects: "all" });
    await visit(page, server);
    const group = page.getByRole("region", { name: "Assistant Connections", exact: true });
    await group.getByRole("button", { name: /^Studio Assistant/ }).click();
    await expect(page.getByRole("heading", { name: "Studio Assistant", exact: true })).toBeVisible();
    await page.goBack();
    await group.getByRole("button", { name: "New Connection", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New Connection", exact: true })).toBeVisible();
    await expect(nameField(page)).toBeEmpty();
  } finally {
    await server.close();
  }
});

test("a failed or stale editor write leaves current grants intact", async ({ page }) => {
  const server = await assistantUiServer();
  try {
    const { connection } = server.db.assistantConnections.create(ownerFor(server), "Concurrent Owner", { operations: "all", projects: "all" });
    await visit(page, server);
    await openList(page);
    await page.getByRole("button", { name: /^Concurrent Owner/ }).click();
    const save = page.getByRole("button", { name: "Save Connection", exact: true });
    const configure = /\/api\/assistant-connections\/[^/]+\/configure$/;
    await page.route(configure, route => route.abort("connectionfailed"));
    await nameField(page).fill("Unsaved Draft");
    await save.click();
    await expect(page.getByRole("alert")).toContainText("refresh and inspect");
    expect(server.db.assistantConnections.get(connection.id)!.name).toBe("Concurrent Owner");
    await page.unroute(configure);
    server.db.assistantConnections.configure(connection.id, { operations: ["assistant_discover"], projects: [server.project.id] });
    await save.click();
    await expect(page.getByRole("alert")).toContainText("changed in another window");
    expect(server.db.assistantConnections.get(connection.id)!.name).toBe("Concurrent Owner");
    await page.getByRole("button", { name: "Back to Assistant Connections", exact: true }).click();
    await page.getByRole("button", { name: /^Concurrent Owner/ }).click();
    await expect(page.getByRole("button", { name: /^Projects:/ })).toContainText("Selected Projects");
  } finally {
    await server.close();
  }
});
