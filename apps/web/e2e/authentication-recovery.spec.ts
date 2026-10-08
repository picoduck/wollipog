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

/** Whether an element is wholly inside the card body's visible part, without scrolling it. */
async function visibleInBody(card: Locator, target: Locator): Promise<boolean> {
  const handle = await target.elementHandle();
  return card.evaluate((element, node) => {
    const body = element.querySelector<HTMLElement>(".request-card-body")!.getBoundingClientRect();
    const rect = (node as HTMLElement).getBoundingClientRect();
    return rect.height > 0 && rect.top >= body.top - 0.5 && rect.bottom <= body.bottom + 0.5;
  }, handle);
}

/** Choose Another Account, opened from the card. */
async function openChooser(page: Page, card: Locator): Promise<Locator> {
  await chooseAnotherAccount(page, card);
  const dialog = page.getByRole("dialog", { name: "Choose Another Account" });
  await expect(dialog).toBeVisible();
  return dialog;
}

function accountRow(dialog: Locator, name: string): Locator {
  return dialog.locator(".choice-row").filter({ has: dialog.page().getByRole("radio", { name: new RegExp(`^${name}`) }) });
}

test("Choose Another Account… opens a dialog of radio rows, and Use Account names this exact card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=email");
  const dialog = await openChooser(page, card);
  await expect(dialog).toContainText("Continue this session with another Claude Code account on runner-1.");
  const rows = dialog.getByRole("radiogroup", { name: "Accounts" });
  await expect(rows.getByRole("radio")).toHaveCount(3);
  await expect(accountRow(dialog, "Personal Max")).toContainText("Signed In");
  await expect(accountRow(dialog, "Team Pilot")).toContainText("Sign-In Required");
  await expect(accountRow(dialog, "Lab Sandbox")).toContainText("Status Unknown");
  await expect(rows).not.toContainText("Work Subscription", { useInnerText: true });
  await expect(accountRow(dialog, "Team Pilot").getByRole("button", { name: "Sign In to Team Pilot" })).toBeVisible();
  await expect(card.locator(".auth-recovery-accounts")).toHaveCount(0);
  await expect(dialog.locator(".primary")).toHaveCount(1);

  await expect(dialog.getByRole("radio", { name: /^Personal Max/ })).toBeChecked();
  await dialog.getByRole("button", { name: "Use Account" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.selections())).toEqual([{
    requestId: "provider-auth:recovery-e2e",
    providerAccountId: "claude-personal",
    expectedProviderAccountId: "claude-work",
  }]);
});

test("email labels stay masked in the dialog until Show Emails", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=email&emailLabels=1");
  const dialog = await openChooser(page, card);
  await expect(dialog.getByRole("radio", { name: /^Hidden Account 1/ })).toBeVisible();
  expect(await dialog.innerHTML()).not.toContain("jordan.personal@example.net");
  await dialog.getByRole("button", { name: "Show Emails" }).click();
  await expect(dialog.getByRole("radio", { name: /^jordan\.personal@example\.net/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Hide Emails" }).click();
  expect(await dialog.innerHTML()).not.toContain("jordan.personal@example.net");
});

test("a refused choice is a field error in that row, which takes focus, and stays on the card after Cancel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=refused");
  const dialog = await openChooser(page, card);
  await dialog.getByRole("button", { name: "Use Account" }).click();
  const row = accountRow(dialog, "Personal Max");
  await expect(row.locator(".field-error")).toHaveText("This account is signed out. Sign in to it, then choose it again.");
  // The Machine now reports it signed out: the row says so and offers Sign In, and Use Account waits.
  await expect(row).toContainText("Sign-In Required");
  await expect(row.getByRole("button", { name: "Sign In to Personal Max" })).toBeVisible();
  const use = dialog.getByRole("button", { name: "Use Account" });
  await expect(use).toBeDisabled();
  await expect(use).toHaveAccessibleDescription("This account is signed out. Sign in to it first, then use it.");
  await expect(dialog.getByRole("button", { name: "Check and Use" })).toHaveCount(0);
  // The row was rebuilt around its new Sign In and kept the focus a refusal gives it.
  const radio = dialog.getByRole("radio", { name: /^Personal Max/ });
  await expect(radio).toBeFocused();
  await expect(radio).toHaveAttribute("aria-invalid", "true");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(card.locator(".notice")).toHaveText("This account is signed out. Sign in to it, then choose it again.");
});

test("an account removed while the dialog is open leaves the list with a masked notice and clears the choice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=email&emailLabels=1");
  const dialog = await openChooser(page, card);
  await expect(dialog.getByRole("radio", { name: /^Hidden Account 1/ })).toBeChecked();
  await page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.removeAccount("claude-personal"));
  await expect(dialog.locator(".notice")).toHaveText("Hidden Account 1 was removed from runner-1, so it's no longer listed.");
  await expect(dialog.getByRole("radio")).toHaveCount(2);
  // The row left keeps its number, so the sentence cannot be read as naming it.
  await expect(dialog.getByRole("radio", { name: /^Hidden Account 2/ })).toBeVisible();
  await expect(dialog.getByRole("radio", { checked: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Use Account" })).toBeDisabled();
  expect(await dialog.innerHTML()).not.toContain("jordan.personal@example.net");
});

test("an account_unavailable refusal for an account just removed reads as its removal, never 'is not configured'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=removed");
  const dialog = await openChooser(page, card);
  await dialog.getByRole("button", { name: "Use Account" }).click();
  await expect(dialog.locator(".notice")).toHaveText("Personal Max was removed from runner-1, so it's no longer listed.");
  await expect(dialog.getByRole("radio", { name: /^Personal Max/ })).toHaveCount(0);
  await expect(page.getByText(/not configured/)).toHaveCount(0);
});

test("a conversation that can't switch closes the dialog, says so on the card, and drops Choose Another Account…", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=not-resumable&width=1440&height=900");
  const dialog = await openChooser(page, card);
  await dialog.getByRole("button", { name: "Use Account" }).click();
  await expect(dialog).toBeHidden();
  const notice = card.locator(".notice");
  await expect(notice).toHaveText("This conversation can't continue under another account. Sign in again " +
    "with the current account, or start a new session.");
  expect(await footer(card)).toEqual(["Dismiss Recovery", "Use Current Account (primary)"]);
  // The notice heads the body that scrolls, and the facts keep their room under it.
  await expect(card.locator(".request-card-body > .notice")).toHaveCount(1);
  expect(await visibleInBody(card, notice), "the notice").toBe(true);
  // A fact row has no box of its own (its term and value sit in the list's grid), so both are measured.
  for (const label of ["This Session Uses", "Signed In Now", "Last Checked"]) {
    expect(await visibleInBody(card, card.locator("dt", { hasText: label })), label).toBe(true);
    expect(await visibleInBody(card, fact(card, label)), `${label}: its value`).toBe(true);
  }
});

test("with no other account the dialog says who can add one and offers Open Connections", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const card = await open(page, "scenario=none");
  const dialog = await openChooser(page, card);
  await expect(dialog.getByText("No Other Accounts")).toBeVisible();
  await expect(dialog).toContainText("A machine owner or organization admin can add one in the machine's Provider Accounts section.");
  await expect(dialog.getByRole("button", { name: "Open Connections" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Use Account" })).toHaveCount(0);
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

test("a body cut by the dock's cap draws a hairline at its lower edge, never a fade, so a cut line never reads as a stray mark (#2715)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scenario of ["email", "older", "readonly", "methods"] as const) {
    const card = await open(page, `scenario=${scenario}`, scenario === "methods" ? "Sign in to OpenCode" : undefined);
    const state = await card.locator(".request-card-body").evaluate((body) => ({
      overflows: body.scrollTop + body.clientHeight < body.scrollHeight - 1,
      marked: body.hasAttribute("data-clip-end"),
      line: getComputedStyle(body, "::after").borderTopStyle === "solid",
      masked: getComputedStyle(body).maskImage !== "none",
    }));
    expect(state.marked, scenario).toBe(state.overflows);
    expect(state.line, scenario).toBe(state.overflows);
    expect(state.masked, scenario).toBe(false);
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

  test("Show Email and Check Again each keep their own 44px touch target (#2730)", async ({ page }) => {
    const card = await open(page, "scenario=email&width=390&height=844");
    for (const [label, name, selector] of [
      ["Signed In Now", "Show Email", ".pid-toggle"],
      ["Last Checked", "Check Again", "button.btn"],
    ] as const) {
      const control = fact(card, label).getByRole("button", { name });
      // The card's body scrolls on a phone (#2179): centre the control, away from the body's clipping
      // edge, where any target would be cut.
      await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
      const box = (await control.boundingBox())!;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // 21px from the centre on every side is inside a 44px target: each lands on this control, never
      // on the other fact's.
      const hits = await page.evaluate(([x, y, own, text]) => [[x, y - 21], [x, y + 21], [x - 21, y], [x + 21, y]]
        .map(([px, py]) => {
          const hit = document.elementFromPoint(px!, py!)?.closest<HTMLElement>(own!);
          return hit?.textContent?.trim().startsWith(text!) || hit?.getAttribute("aria-label") === text;
        }), [cx, cy, selector, name] as const);
      expect(hits, name).toEqual([true, true, true, true]);
    }
  });
});

test("with a fine pointer at 1440×900 the facts keep their 4px rows: only touch spaces them out (#2730)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const scenario of ["email", "signed-out"] as const) {
    const card = await open(page, `scenario=${scenario}`);
    await expect(card.locator(".sign-in-facts"), scenario).toHaveCSS("row-gap", "4px");
  }
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
    // Choose Another Account opens over the card, a sheet on a phone, with every row and its footer
    // in view and nothing past the viewport's edge.
    const card = await open(page, `scenario=email&width=${width}&height=${height}`);
    const dialog = await openChooser(page, card);
    await expect(dialog.getByRole("radio", { name: /^Lab Sandbox/ })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "Use Account" })).toBeInViewport();
    const right = await dialog.evaluate((element) => Math.max(...[element, ...element.querySelectorAll<HTMLElement>("*")]
      .map((child) => child.getBoundingClientRect().right)));
    expect(right).toBeLessThanOrEqual(width + 0.5);
  });
}

test.describe("touch phone, typing then tapping the card (#2675)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Submit Code tapped right after typing the Authorization Code takes the tap, with the typed code", async ({ page }) => {
    const card = await open(page, "scenario=signing-in&width=390&height=844", "Signing In — Claude Code");
    const field = card.getByLabel("Authorization Code");
    // The focused field reads as "the software keyboard is up": the dock caps at 40% and the tab bar
    // hides. A tap that moved focus off the field would regrow the dock under the finger (#2205).
    await field.fill("auth-code-2675");
    await expect(field).toBeFocused();
    await card.getByRole("button", { name: "Submit Code" }).tap();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.codes())).toEqual(["auth-code-2675"]);
  });

  test("a docked card's primary tapped right after typing in the composer takes the tap", async ({ page }) => {
    const card = await open(page, "scenario=email&width=390&height=844");
    const composer = page.getByRole("combobox", { name: /^Messages you send now wait/ });
    await composer.tap();
    await composer.fill("Checking the account first.");
    await expect(composer).toBeFocused();
    await card.getByRole("button", { name: "Use Current Account" }).tap();
    await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_AUTH_RECOVERY_E2E__.decisions()))
      .toEqual([{ requestId: "provider-auth:recovery-e2e", optionId: "auth:accept-current" }]);
  });
});
