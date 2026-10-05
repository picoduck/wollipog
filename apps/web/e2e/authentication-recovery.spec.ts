import { expect, test, type Locator, type Page } from "@playwright/test";

// These cases exercise the explicitly enabled privacy mode. Default-off behavior has separate coverage.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("wollipog.hide-account-emails", "true"));
});

/** The sign-in Request Card (#1649, #2198) in a real SessionDetail. Captures of every state are
 * authentication-recovery-evidence.spec.ts. */
const EMAIL = "morgan.lee@example.com";

async function open(page: Page, query: string, title = "Authentication Required — Claude Code") {
  await page.goto(`/authentication-recovery-e2e.html?${query}`);
  // The session's own request is answered on the Request Card docked above the composer (#2179).
  const card = page.locator(".request-dock").getByRole("region", { name: title });
  await expect(card).toBeVisible();
  return card;
}

/** The footer as a person reads it: each control's name, in order, and which is the primary. */
async function footer(card: Locator): Promise<string[]> {
  return card.locator(".request-card-foot > button").evaluateAll((buttons) => buttons
    .filter((button) => button.checkVisibility()).map((button) =>
    `${button.getAttribute("aria-label") ?? button.textContent?.replace(/\s*[AD]$/, "")}` +
    `${button.classList.contains("primary") ? " (primary)" : ""}`));
}

/** Choose Another Account…: a footer button on a desktop, an item of the card's ⋯ on a phone. */
async function chooseAnotherAccount(page: Page, scope: Locator | Page = page): Promise<void> {
  const button = scope.getByRole("button", { name: "Choose Another Account…" });
  if (await button.isVisible()) {
    await button.click();
    return;
  }
  await scope.getByRole("button", { name: "More Choices" }).click();
  await page.getByRole("menuitem", { name: "Choose Another Account…" }).click();
}

function fact(card: Locator, label: string): Locator {
  return card.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
}

for (const theme of ["dark", "light"] as const) {
  test(`${theme}: the facts keep the current email masked until Show Email, apart from the session's account`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const card = await open(page, `theme=${theme}`);
    await expect(fact(card, "This Session Uses")).toContainText("Work Subscription");
    await expect(fact(card, "This Session Uses")).toContainText("A name chosen on this machine; the provider has not confirmed it.");
    await expect(fact(card, "Signed In Now")).toContainText("Email Hidden");
    await expect(fact(card, "Last Checked")).toContainText("2m ago");
    expect(await card.innerHTML()).not.toContain(EMAIL);
    expect(await card.locator("button[title]").count()).toBe(0);

    await card.getByRole("button", { name: "Show Email" }).click();
    await expect(fact(card, "Signed In Now")).toContainText(EMAIL);
    await card.getByRole("button", { name: "Hide Email" }).click();
    expect(await card.innerHTML()).not.toContain(EMAIL);
  });
}

test("each state shows one primary for what the session needs, with Dismiss Recovery at the far left", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const cases: Array<[string, string, string[]]> = [
    ["email", "Authentication Required — Claude Code",
      ["Dismiss Recovery", "Choose Another Account…", "Use Current Account (primary)"]],
    ["signed-out", "Authentication Required — Claude Code",
      ["Dismiss Recovery", "Choose Another Account…", "Start Sign-In (primary)"]],
    ["readonly", "Authentication Required — Claude Code",
      ["Dismiss Recovery", "Choose Another Account…", "Recheck Authentication (primary)"]],
    ["methods", "Sign in to OpenCode", ["Cancel Sign-In", "Start Sign-In (primary)"]],
    ["signing-in", "Signing In — Claude Code", ["Cancel Sign-In"]],
  ];
  for (const [scenario, title, expected] of cases) {
    const card = await open(page, `scenario=${scenario}`, title);
    expect(await footer(card), scenario).toEqual(expected);
    await expect(card.locator(".primary")).toHaveCount(expected.some((name) => name.endsWith("(primary)")) ? 1 : 0);
    await expect(card.getByRole("button", { name: "Check Again" }))
      .toHaveCount(scenario === "email" || scenario === "signed-out" ? 1 : 0);
  }
});

test("Check Again on the Last Checked fact runs the runner's recheck", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=email");
  await fact(card, "Last Checked").getByRole("button", { name: "Check Again" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.decisions()))
    .toEqual([{ requestId: "provider-auth:recovery-e2e", optionId: "auth:revalidate" }]);
});

test("a viewer who cannot manage the machine reads why Start Sign-In is off", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=not-manager");
  const start = card.getByRole("button", { name: "Start Sign-In" });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAccessibleDescription("Only a machine owner or organization admin can sign in on this machine.");
  await expect(card.getByText("Only a machine owner or organization admin can sign in on this machine.")).toBeVisible();
});

test("an agent's sign-in methods show their descriptions and start the chosen one", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=methods", "Sign in to OpenCode");
  const methods = card.getByRole("radiogroup", { name: "Sign-In Methods" });
  await expect(methods.getByRole("radio")).toHaveCount(3);
  await expect(methods).toContainText("API Key");
  await expect(methods.getByText("Use a GitHub Copilot subscription through a device code.")).toBeVisible();
  await methods.getByRole("radio", { name: "GitHub Copilot" }).check();
  await card.getByRole("button", { name: "Start Sign-In" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.decisions()))
    .toEqual([{ requestId: "auth_1", optionId: "auth_1_method_2" }]);
});

test("Choose Another Account… lists the other accounts, and choosing one names this exact card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=email");
  await chooseAnotherAccount(page, card);
  const accounts = card.getByRole("region", { name: "Other Accounts" });
  await expect(accounts.locator(".auth-recovery-account")).toHaveCount(3);
  await expect(accounts).toContainText("Personal Max");
  await expect(accounts).toContainText("Sign-In Required");
  await expect(accounts).toContainText("Status Unknown");
  await expect(accounts).not.toContainText("Work Subscription", { useInnerText: true });
  await expect(card.locator(".primary")).toHaveCount(1);

  await accounts.getByRole("button", { name: "Use Personal Max" }).click();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.selections())).toEqual([{
    requestId: "provider-auth:recovery-e2e",
    providerAccountId: "claude-personal",
    expectedProviderAccountId: "claude-work",
  }]);
});

test("a refused selection keeps the card open and explains the next action", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=refused");
  await chooseAnotherAccount(page, card);
  await card.getByRole("button", { name: "Check and Use Team Pilot" }).click();
  const row = card.locator('[data-availability="sign_in_required"]');
  const refusal = row.getByRole("alert");
  await expect(refusal).toContainText("signed out. Sign in to it, then choose it again.");
  // The refusal appears beside the chosen account and is scrolled into view, not below the fold.
  await expect(refusal).toBeInViewport();
  await expect(row.getByRole("button", { name: "Sign In" })).toBeInViewport();
});

test("a provider without an email says so instead of guessing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=no-email");
  await expect(fact(card, "Signed In Now")).toHaveText("Claude Code didn't supply an account email.");
  await expect(card.getByRole("button", { name: "Show Email" })).toHaveCount(0);
});

test("an older runner keeps the card's actions with update guidance and no identity request", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=older");
  await expect(fact(card, "Signed In Now"))
    .toContainText("This machine's runner can't report the signed-in account. Update and restart the runner to see it.");
  // The runner flagged a mismatch, but the card cannot show the account, so it does not claim one.
  await expect(card.locator(".sign-in-sentence")).toHaveText("This machine's runner can't tell which account " +
    "Claude Code uses. Use Current Account continues this session with whatever account Claude Code is signed in to.");
  expect(await footer(card)).toEqual(["Dismiss Recovery", "Use Current Account (primary)"]);
  await expect(fact(card, "Last Checked").getByRole("button", { name: "Check Again" })).toBeVisible();
  expect(await page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.identityRequests())).toBe(0);
});

/** Whether an element is wholly inside the card body's visible part, without scrolling it. */
async function visibleInBody(card: Locator, target: Locator): Promise<boolean> {
  const handle = await target.elementHandle();
  return card.evaluate((element, node) => {
    const body = element.querySelector<HTMLElement>(".request-card-body")!.getBoundingClientRect();
    const rect = (node as HTMLElement).getBoundingClientRect();
    return rect.height > 0 && rect.top >= body.top - 0.5 && rect.bottom <= body.bottom + 0.5;
  }, handle);
}

test("while a sign-in runs, what the person must do is in view without scrolling", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    const card = await open(page, `scenario=signing-in&width=${width}&height=${height}`, "Signing In — Claude Code");
    await expect(card.locator(".provider-login-head")).toHaveCount(0);
    await expect(card.locator(".sign-in-sentence"))
      .toHaveText("Sign in to Claude Code with Open Provider Sign-In, then paste the authorization code here.");
    const link = card.getByRole("link", { name: "Open Provider Sign-In" });
    const field = card.getByLabel("Authorization Code");
    const submit = card.getByRole("button", { name: "Submit Code" });
    expect(await visibleInBody(card, link), `${width}: Open Provider Sign-In`).toBe(true);
    if (width === 1440) {
      expect(await visibleInBody(card, field), "1440: the code field").toBe(true);
      expect(await visibleInBody(card, submit), "1440: Submit Code").toBe(true);
    }
  }
});

test("a body cut by the dock's cap fades its lower edge, so a cut line never reads as a stray mark", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scenario of ["email", "older", "readonly", "methods"] as const) {
    const card = await open(page, `scenario=${scenario}`, scenario === "methods" ? "Sign in to OpenCode" : undefined);
    const state = await card.locator(".request-card-body").evaluate((body) => ({
      overflows: body.scrollTop + body.clientHeight < body.scrollHeight - 1,
      marked: body.hasAttribute("data-more-below"),
      masked: getComputedStyle(body).maskImage !== "none",
    }));
    expect(state.marked, scenario).toBe(state.overflows);
    expect(state.masked, scenario).toBe(state.overflows);
  }
});

test.describe("touch phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the footer stays one row, with Dismiss Recovery and Choose Another Account… in ⋯, so the body keeps its room", async ({ page }) => {
    for (const scenario of ["email", "signed-out", "readonly"] as const) {
      const card = await open(page, `scenario=${scenario}&width=390&height=844`);
      const tops = await card.locator(".request-card-foot > button").evaluateAll((buttons) => buttons
        .filter((button) => button.checkVisibility()).map((button) => Math.round(button.getBoundingClientRect().top)));
      expect(new Set(tops).size, `${scenario}: one footer row`).toBe(1);
      expect(await footer(card), scenario).toEqual(["More Choices", expect.stringMatching(/\(primary\)$/)]);
      const body = await card.locator(".request-card-body").evaluate((element) => element.getBoundingClientRect().height);
      expect(body, `${scenario}: the body keeps room for a 44px target and more`).toBeGreaterThanOrEqual(100);
      await card.getByRole("button", { name: "More Choices" }).click();
      await expect(page.getByRole("menuitem")).toHaveText(["Choose Another Account…", /^Dismiss Recovery/]);
      await page.keyboard.press("Escape");
    }
  });
});

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`at ${width}×${height} nothing is clipped, the primary keeps its whole label, and the card body scrolls`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const [scenario, title] of [
      ["email", "Authentication Required — Claude Code"],
      ["methods", "Sign in to OpenCode"],
      ["signing-in", "Signing In — Claude Code"],
    ] as const) {
      const card = await open(page, `scenario=${scenario}&width=${width}&height=${height}`, title);
      const layout = await card.evaluate((element) => {
        const right = Math.max(...[element, ...element.querySelectorAll<HTMLElement>("*")]
          .map((child) => child.getBoundingClientRect().right));
        const primary = element.querySelector<HTMLElement>(".request-card-foot .primary");
        const body = element.querySelector<HTMLElement>(".request-card-body")!;
        return {
          right,
          viewport: window.innerWidth,
          primaryClipped: primary ? primary.scrollWidth > primary.clientWidth + 0.5 : false,
          bodyScrolls: getComputedStyle(body).overflowY === "auto",
        };
      });
      expect(layout.right, scenario).toBeLessThanOrEqual(layout.viewport + 0.5);
      expect(layout.primaryClipped, scenario).toBe(false);
      expect(layout.bodyScrolls, scenario).toBe(true);
    }
    // With the other accounts open the body grows past the dock's cap, and the body, not an inner
    // region, scrolls to the last account.
    const card = await open(page, `scenario=email&width=${width}&height=${height}`);
    await chooseAnotherAccount(page, card);
    const last = card.getByRole("button", { name: "Check and Use Lab Sandbox" });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(card.getByRole("button", { name: "Use Current Account" })).toBeInViewport();
  });
}
