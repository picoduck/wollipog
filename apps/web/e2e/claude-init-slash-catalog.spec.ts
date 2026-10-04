import { expect, test, type Page } from "@playwright/test";

/** Claude Code's session catalog once the runner forwards its `system/init` list (#1224). */
const CLAUDE_SESSION_CATALOG = {
  slashCommands: [
    { name: "compact", source: "builtin", description: "Summarize the conversation to free up context.", argumentHint: "[instructions]" },
    { name: "context", source: "builtin", description: "Show what is using the context window." },
    { name: "usage", source: "builtin", description: "Show plan usage and limits." },
    { name: "code-review:code-review", source: "plugin", description: "Review a pull request with agents." },
    { name: "release", source: "project", description: "Cut a release.", argumentHint: "<version>" },
    { name: "brainstorming", source: "skill", description: "Explore an idea before building it." },
    { name: "mcp__docs__summarize", source: "mcp" },
  ],
  unsupportedSlashCommands: [
    { name: "doctor", reason: "Claude Code's /doctor needs its own terminal, so Wollipog doesn't send it." },
  ],
};

async function openClaudeSession(page: Page) {
  await page.goto("/command-inbox-projects-e2e.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: /Alpha Session/ }).click();
  const expand = page.getByRole("button", { name: "Expand Session" });
  if (await expand.isVisible()) await expand.click();
  await expect(page.locator(".composer-input")).toBeEnabled();
  await page.evaluate((catalog) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
    driver: "claude-code",
    agentName: "Claude Code",
    agentCapabilities: catalog,
  }), CLAUDE_SESSION_CATALOG);
  const idle = page.locator(".composer-idle-preview");
  if (await idle.isVisible()) await idle.click();
}

test.beforeEach(async ({ page }) => {
  await openClaudeSession(page);
});

test("built-in commands, skills and MCP prompts appear under groups that name their source", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash Commands" });
  await expect(listbox).toBeVisible();

  const claude = listbox.getByRole("group", { name: "Claude Code" });
  await expect(claude.getByRole("option", { name: "/compact" })).toBeVisible();
  await expect(claude.getByRole("option", { name: "/compact" }).locator(".picker-desc"))
    .toHaveText("Summarize the conversation to free up context.");
  await expect(claude.getByRole("option", { name: "/context" })).toBeVisible();
  await expect(claude.getByRole("option", { name: "/code-review:code-review" })).toBeVisible();
  await expect(claude.getByRole("option", { name: "/release" })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Skills" }).getByRole("option", { name: "/brainstorming" })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "MCP Prompts" }).getByRole("option", { name: "/mcp__docs__summarize" }))
    .toBeVisible();
  // A terminal-only command is never offered.
  await expect(listbox.getByRole("option", { name: /\/doctor/ })).toHaveCount(0);
});

test("a command named with `@` or in another script is listed and sent as a command turn (#2602)", async ({ page }) => {
  await page.evaluate((catalog) => window.__WOLLIPOG_PROJECT_INBOX_E2E__.replaceSessionSnapshot("session-alpha", {
    agentCapabilities: {
      ...catalog,
      slashCommands: [
        ...catalog.slashCommands,
        { name: "mcp__docs__summarize@latest", source: "mcp" },
        { name: "résumé", source: "project", description: "Summarize the branch." },
      ],
    },
  }), CLAUDE_SESSION_CATALOG);
  const composer = page.locator(".composer-input");
  await composer.fill("/");
  const listbox = page.getByRole("listbox", { name: "Slash Commands" });
  await expect(listbox.getByRole("group", { name: "MCP Prompts" })
    .getByRole("option", { name: "/mcp__docs__summarize@latest", exact: true })).toBeVisible();
  await expect(listbox.getByRole("group", { name: "Claude Code" }).getByRole("option", { name: "/résumé", exact: true }))
    .toBeVisible();

  await composer.fill("/mcp__docs__summarize@");
  await page.getByRole("option", { name: "/mcp__docs__summarize@latest", exact: true }).click();
  await expect(composer).toHaveValue("/mcp__docs__summarize@latest ");
  await composer.pressSequentially("this page");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "this page",
    images: [],
    slashCommand: "mcp__docs__summarize@latest",
  }]);
});

test("typing a terminal-only command in full shows why it isn't sent", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/doc");
  await expect(page.getByRole("option", { name: /\/doctor/ })).toHaveCount(0);
  await composer.fill("/doctor");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await expect(page.locator(".session-notice-slot .notice[role='alert'] .notice-body"))
    .toContainText("Claude Code's /doctor needs its own terminal, so Wollipog doesn't send it.");
  await expect(composer).toHaveValue("/doctor");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests().length)).toBe(0);
});

test("a $ stays ordinary text in a Claude Code session, which runs skills as /name", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("$brain");
  await expect(page.getByRole("listbox", { name: "Slash Commands" })).toHaveCount(0);
  await composer.fill("/brain");
  await expect(page.getByRole("option", { name: "/brainstorming" })).toBeVisible();
});

test("selecting /compact sends it as a command turn and the transcript shows the compaction", async ({ page }) => {
  const composer = page.locator(".composer-input");
  await composer.fill("/comp");
  await page.getByRole("option", { name: "/compact" }).click();
  await expect(composer).toHaveValue("/compact ");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.promptRequests())).toEqual([{
    sessionId: "session-alpha",
    text: "",
    images: [],
    slashCommand: "compact",
  }]);

  await page.evaluate(() => window.__WOLLIPOG_PROJECT_INBOX_E2E__.emitSessionEvent("session-alpha", {
    kind: "context_compacted",
    trigger: "manual",
    preTokens: 48213,
  }));
  const divider = page.getByRole("separator", { name: "Conversation Compacted" });
  await expect(divider).toBeVisible();
  await expect(divider).toHaveAttribute("title", "Earlier messages were summarized to free context (48,213 tokens before).");
});
