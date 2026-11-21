import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectNoHorizontalOverflow } from "./layout-invariants.js";

/** Reviewable captures of Google Antigravity sessions (#4779) at 1440x900 and 390x844, with the
 * layout measurements antigravity-setup-evidence.spec.ts takes: target sizes (and, on the touch
 * phone, the coarse-pointer hit area), gaps, text and control-boundary contrast, and horizontal
 * overflow (plus which pair is closest or overlaps, and skipping aria-hidden inputs). Runs only with WOLLIPOG_EVIDENCE_DIR set; WOLLIPOG_EVIDENCE_PREFIX names the set and
 * `${prefix}-measurements.json` holds the numbers. Files are named by evidence ID:
 * `antigravity-session-<state>-<W>x<H>.png`.
 *
 * What this PR changes: New Session's Google Antigravity row and its Needs Setup reasons
 * (new-session-choices-e2e.html `?antigravity=`; one runner advertises one Antigravity row, so each
 * reason — sign-in, check failed, network denied — is its own capture), and the Connections setup
 * row's "Available in New Session" (machine-management-e2e.html `?antigravity=ready&antigravityAgent`).
 * Session states (transcript-states-e2e.html `?scenario=antigravity&agState=`) are the generic ACP
 * session UI showing what agy 1.5.14 reports, except the Permission Mode menu in agy's own words
 * (no Wollipog Plan Mode in Attach and Settings) and the launch-failure notices. The transcript pane
 * and the open model picker are also checked for horizontal overflow. Behaviour is asserted in
 * unit and DOM tests. */
const evidenceDir = process.env.WOLLIPOG_EVIDENCE_DIR;
const prefix = process.env.WOLLIPOG_EVIDENCE_PREFIX ?? "after";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }] as const;
const FIXED_NOW = new Date("2026-11-21T15:30:00Z");
/** New Session's Needs Setup reasons for Google Antigravity, by `?antigravity=` fixture. */
const NEEDS_SETUP = [
  { state: "signin", id: "needs-setup-signin", reason: "Sign in before the session can start." },
  { state: "check-failed", id: "needs-setup-check-failed", reason: "Wollipog couldn't check it on runner-1. Check it again in Connections." },
  { state: "network-denied", id: "needs-setup-network-denied", reason: "It needs network access, which execution isolation on runner-1 denies." },
] as const;
const measurements: Record<string, unknown> = {};

test.skip(!evidenceDir, "set WOLLIPOG_EVIDENCE_DIR to capture evidence");
test.use({ timezoneId: "UTC", locale: "en-US" });
test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(FIXED_NOW); });
test.afterAll(() => {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, `${prefix}-measurements.json`), `${JSON.stringify(measurements, null, 2)}\n`);
});

/** Layout boxes of every visible interactive target in `scope`, the smallest gap between adjacent
 * targets, the lowest text and control-boundary contrast, and whether the page scrolls sideways. */
async function measure(page: Page, scope: string): Promise<unknown> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector) ?? document.body;
    const parse = (value: string): [number, number, number, number] | null => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (!match) return null;
      const parts = match[1]!.split(/[ ,/]+/u).filter(Boolean).map(Number);
      return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
    };
    const luminance = ([r, g, b]: number[]) => {
      const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const background = (element: Element | null): number[] => {
      for (let node = element; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color[3] > 0.5) return color;
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
    };
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const targets = [...root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, summary, [role=button]")]
      // Not the composer's clipped, aria-hidden file input (tabindex -1): nothing points at it.
      .filter((element) => visible(element) && !(element as HTMLButtonElement).disabled && element.getAttribute("aria-hidden") !== "true");
    // The pointer target: the layout box, grown by an absolutely positioned pseudo-element that the
    // shared hit-area block adds on coarse pointers (design-system §2.8). Insets are from the padding edge.
    const hitBox = (element: HTMLElement, rect: DOMRect) => {
      let [x0, y0, x1, y1] = [rect.x, rect.y, rect.right, rect.bottom];
      const style = getComputedStyle(element);
      const [bl, bt, br, bb] = [style.borderLeftWidth, style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth].map(Number.parseFloat);
      for (const pseudo of ["::before", "::after"]) {
        const own = getComputedStyle(element, pseudo);
        if (own.content === "none" || own.position !== "absolute") continue;
        const [top, right, bottom, left] = [own.top, own.right, own.bottom, own.left].map(Number.parseFloat);
        if ([top, right, bottom, left].some(Number.isNaN)) continue;
        x0 = Math.min(x0, rect.x + bl! + left!);
        y0 = Math.min(y0, rect.y + bt! + top!);
        x1 = Math.max(x1, rect.right - br! - right!);
        y1 = Math.max(y1, rect.bottom - bb! - bottom!);
      }
      return { hitWidth: x1 - x0, hitHeight: y1 - y0, hit: { x: x0, y: y0, right: x1, bottom: y1 } };
    };
    const boxes = targets.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: (element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 40),
        x: rect.x, y: rect.y, width: rect.width, height: rect.height, ...hitBox(element, rect) };
    });
    // Whether any two hit areas overlap (a nested copy button inside a row excepted).
    let hitOverlap = false;
    let hitOverlapSample = "";
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const nested = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
          Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
        if (!nested && Math.min(a.hit.right, b.hit.right) > Math.max(a.hit.x, b.hit.x) &&
            Math.min(a.hit.bottom, b.hit.bottom) > Math.max(a.hit.y, b.hit.y)) {
          if (!hitOverlap) hitOverlapSample = `${a.label} / ${b.label}`;
          hitOverlap = true;
        }
      }
    }
    let minGap = Infinity;
    let minGapSample = "";
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!, b = boxes[j]!;
        const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
        const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
        // Adjacent: overlapping on one axis, so the gap on the other is the space between them.
        const overlapX = Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);
        if (overlapX && overlapY) continue; // nested (a copy button inside a row), not adjacent
        const gap = overlapY ? dx : overlapX ? dy : Infinity;
        if (gap < minGap) {
          minGap = gap;
          minGapSample = `${a.label} / ${b.label}`;
        }
      }
    }
    let minText = Infinity;
    let minTextMargin = Infinity;
    let minTextSample = "";
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      if (!visible(element) || (element as HTMLButtonElement).disabled || element.closest("[disabled]")) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join("").trim();
      if (!text) continue;
      const color = parse(getComputedStyle(element).color);
      if (!color) continue;
      const value = ratio(color, background(element));
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      const weight = Number(getComputedStyle(element).fontWeight);
      const required = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
      // The worst text relative to its own threshold (large text needs 3:1, other text 4.5:1).
      if (value / required < minTextMargin) {
        minTextMargin = value / required;
        minText = value;
        minTextSample = `${text.slice(0, 40)} (needs ${required}:1)`;
      }
    }
    // Boundaries that identify a control (WCAG 1.4.11, design-system `--control-outline`): a field's
    // edge, and an icon-only button's glyph. A labelled button is identified by its label, whose
    // contrast is the text measure above.
    let minBoundary = Infinity;
    let minBoundarySample = "";
    for (const element of targets) {
      const style = getComputedStyle(element);
      const outside = background(element.parentElement);
      let value: number | null = null;
      if (/^(INPUT|SELECT|TEXTAREA)$/u.test(element.tagName)) {
        const border = parse(style.borderTopColor);
        value = border ? ratio(border, outside) : null;
      } else if (!(element.textContent ?? "").trim() && element.querySelector("svg")) {
        const glyph = parse(getComputedStyle(element.querySelector("svg")!).color);
        value = glyph ? ratio(glyph, background(element)) : null;
      }
      if (value !== null && value < minBoundary) {
        minBoundary = value;
        minBoundarySample = (element.getAttribute("aria-label") ?? element.tagName).slice(0, 40);
      }
    }
    return {
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      targetCount: boxes.length,
      minTargetWidth: Math.min(...boxes.map((box) => box.width)),
      minTargetHeight: Math.min(...boxes.map((box) => box.height)),
      minHitWidth: Math.min(...boxes.map((box) => box.hitWidth)),
      minHitHeight: Math.min(...boxes.map((box) => box.hitHeight)),
      hitOverlap,
      hitOverlapSample,
      smallestTargets: [...boxes].sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height)).slice(0, 3)
        .map(({ hit: _hit, ...box }) => box),
      minAdjacentGap: Number.isFinite(minGap) ? minGap : null,
      minAdjacentGapSample: minGapSample,
      minTextContrast: Number.isFinite(minText) ? Math.round(minText * 100) / 100 : null,
      minTextContrastSample: minTextSample,
      minControlBoundaryContrast: Number.isFinite(minBoundary) ? Math.round(minBoundary * 100) / 100 : null,
      minControlBoundarySample: minBoundarySample,
    };
  }, scope);
}

async function capture(page: Page, state: string, size: string, scope: string): Promise<void> {
  await page.waitForTimeout(400);
  const name = `antigravity-session-${state}-${size}`;
  const measured = await measure(page, scope) as { horizontalOverflow: boolean };
  measurements[name] = measured;
  expect(measured.horizontalOverflow, `${name} scrolls sideways`).toBe(false);
  await page.screenshot({ path: join(evidenceDir!, `${name}.png`), animations: "disabled" });
}

/** New Session open on the fixture runner, its Agent list closed. */
async function openNewSession(page: Page, query: string, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/new-session-choices-e2e.html${query}`);
  await expect(page.getByRole("heading", { name: "New Session" })).toBeVisible();
  await dialogMotionSettled(page);
}

/** New Session with its Agent list open, the place Google Antigravity's row appears. */
async function openNewSessionAgents(page: Page, query: string, viewport: { width: number; height: number }): Promise<Locator> {
  await openNewSession(page, query, viewport);
  if (viewport.width < 760) await page.getByRole("button", { name: /^Agent:/ }).click();
  else await page.getByRole("combobox", { name: "Agent" }).click();
  // The phone's sheet is named Agent; the desktop combobox's list, Agent Options.
  const list = page.getByRole("listbox", { name: /^Agent( Options)?$/ });
  await expect(list).toBeVisible();
  return list;
}

/** What New Session draws for the chosen agent: its visible text, line by line, and the names of its
 * controls. Recorded so the rows for Google Antigravity and Claude Code can be compared. */
async function newSessionRows(page: Page): Promise<{ text: string[]; controls: string[] }> {
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New Session" }) });
  return dialog.evaluate((root) => {
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const text = (root as HTMLElement).innerText.split("\n").map((line) => line.trim()).filter(Boolean);
    const controls = [...root.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, [role=combobox], [role=radio], [role=tab]")]
      .filter(visible).map((element) => `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim()}`);
    return { text, controls };
  });
}

async function openSession(page: Page, state: string, viewport: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(`/transcript-states-e2e.html?scenario=antigravity&agState=${state}`);
  await expect(page.locator(".session-bar")).toBeVisible();
  await expect(page.locator(".composer-box")).toBeVisible();
}

/** The composer bar's pickers; the phone's idle composer is a capsule that a tap opens. */
async function openComposerBar(page: Page, viewport: { width: number }): Promise<void> {
  if (viewport.width < 760) await page.locator(".composer-box").click();
}

async function openModelSettings(page: Page, viewport: { width: number }): Promise<Locator> {
  await openComposerBar(page, viewport);
  await page.getByRole("button", { name: /^Model Settings:/ }).click();
  const picker = page.getByRole("dialog", { name: "Model Settings" });
  await expect(picker).toBeVisible();
  await expectNoHorizontalOverflow(picker, "The open model picker");
  return picker;
}

/** agy's four modes, as the runner forwards them (`agentPermissionModes`), and how Wollipog attributes them. */
const AGY_MODES = [
  ["Default", "Ask before edits and commands, per your permission settings"],
  ["Accept Edits", "Approve file edits in the workspace without asking"],
  ["Auto", "Approve edits and safe commands; ask before irreversible actions"],
  ["Plan", "Plan carefully before executing a task"],
] as const;
const attributed = (description: string) =>
  `The agent describes this mode as “${description}.” You're asked only about actions the agent sends for approval.`;

/** Launch failures (#4779): each has its own notice; none offers Retry Turn. */
const LAUNCH_FAILURES = {
  "install-failed": { title: "Google Antigravity Couldn't Start", connections: true, detail: "Google Antigravity could not be started on this machine. Check its setup in Connections." },
  "signin-failed": { title: "Sign-In Required", connections: true, detail: "Google Antigravity needs sign-in on this machine. Sign in from Connections, then try again." },
  "resume-failed": { title: "Conversation Can't Resume", connections: false, detail: "Google Antigravity could not resume this conversation, so its history here is read-only. Start a new session to continue." },
} as const;

/** Session captures: evidence ID, `?agState=` fixture, and the widths it is captured at. */
const SESSION_CAPTURES: Array<{ id: string; state: string; phoneOnly?: boolean }> = [
  { id: "pickers", state: "pickers" },
  { id: "pickers-stress40", state: "pickers-stress40" },
  // agy's nine models leave Reasoning Effort on the phone sheet's first screen (`pickers`); with forty
  // the sheet must scroll to it.
  { id: "pickers-effort", state: "pickers-stress40", phoneOnly: true },
  { id: "modes", state: "modes" },
  { id: "attach-menu", state: "attach-menu" },
  { id: "streaming", state: "streaming" },
  { id: "approval", state: "approval" },
  { id: "denied", state: "denied" },
  { id: "stopped", state: "stopped" },
  { id: "install-failed", state: "install-failed" },
  { id: "signin-failed", state: "signin-failed" },
  { id: "resume-failed", state: "resume-failed" },
  { id: "turn-failed", state: "turn-failed" },
];

for (const viewport of VIEWPORTS) test.describe(`${viewport.width}x${viewport.height}`, () => {
  const size = `${viewport.width}x${viewport.height}`;
  const phone = viewport.width < 760;
  // The phone width is a touch phone: coarse-pointer sizing (44px targets) applies there.
  if (phone) test.use({ hasTouch: true, isMobile: true });

  test(`New Session before: no Google Antigravity row, ${size}`, async ({ page }) => {
    await openNewSessionAgents(page, "", viewport);
    await expect(page.getByRole("option", { name: /Google Antigravity/ })).toHaveCount(0);
    await capture(page, "new-session-before", size, "body");
  });

  test(`New Session: Google Antigravity is ready, ${size}`, async ({ page }) => {
    await openNewSessionAgents(page, "?antigravity=ready&savedAgent=google-antigravity", viewport);
    const row = page.getByRole("option", { name: /Google Antigravity/ });
    await expect(row).toHaveCount(1);
    await row.scrollIntoViewIfNeeded();
    await capture(page, "new-session-available", size, "body");
  });

  test(`New Session: Google Antigravity chosen, list closed, ${size}`, async ({ page }) => {
    await openNewSession(page, "?antigravity=ready", viewport);
    // The same dialog with Claude Code, the runner's first agent, for the row comparison.
    measurements[`new-session-rows-claude-code-${size}`] = await newSessionRows(page);
    await openNewSession(page, "?antigravity=ready&savedAgent=google-antigravity", viewport);
    const agent = phone ? page.getByRole("button", { name: /^Agent:/ }) : page.getByRole("combobox", { name: "Agent" });
    await expect(agent).toHaveAccessibleName(phone ? "Agent: Google Antigravity" : "Agent");
    if (!phone) await expect(agent).toHaveValue("Google Antigravity");
    measurements[`new-session-rows-google-antigravity-${size}`] = await newSessionRows(page);
    await expect(page.getByRole("button", { name: "Cancel" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Create Session" })).toBeInViewport();
    await capture(page, "new-session-available-closed", size, "body");
  });

  for (const { state, id, reason } of NEEDS_SETUP) {
    test(`New Session: Google Antigravity needs setup (${state}), ${size}`, async ({ page }) => {
      await openNewSessionAgents(page, `?antigravity=${state}`, viewport);
      const needsSetup = page.getByRole("group", { name: "Needs Setup" });
      const row = needsSetup.getByRole("option", { name: /Google Antigravity/ });
      await expect(row).toContainText(reason);
      await row.scrollIntoViewIfNeeded();
      await capture(page, `new-session-${id}`, size, "body");
    });
  }

  if (phone) test(`New Session: the open list scrolls to Account Setup…, ${size}`, async ({ page }) => {
    const list = await openNewSessionAgents(page, "?antigravity=signin", viewport);
    const footer = list.getByRole("option", { name: "Account Setup…" });
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeInViewport({ ratio: 1 });
    await expect(list.getByRole("option", { name: /Google Antigravity/ })).toContainText("Sign in before the session can start.");
    await capture(page, "new-session-needs-setup-signin-scrolled", size, "body");
  });

  test(`New Session: several agents need setup, ${size}`, async ({ page }) => {
    // Antigravity needs sign-in beside the fixture's Gemini (not installed) and OpenCode (signed out).
    // One runner advertises one Antigravity row, so its network-denied reason is not repeated here.
    await openNewSessionAgents(page, "?antigravity=signin&agentSetup=1", viewport);
    const rows = page.getByRole("group", { name: "Needs Setup" }).getByRole("option");
    await expect(rows).toHaveText([
      /^Gemini.*Not installed on Studio Workstation\.$/,
      /^Google Antigravity.*Sign in before the session can start\.$/,
      /^OpenCode.*Sign in before the session can start\.$/,
    ]);
    await rows.last().scrollIntoViewIfNeeded();
    await capture(page, "new-session-needs-setup-many", size, "body");
  });

  test(`Connections: Google Antigravity is available in New Session, ${size}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/machine-management-e2e.html?machine=native-t14s&antigravity=ready&antigravityAgent=1");
    await expect(page.locator("article.machine-detail")).toBeVisible();
    const row = page.locator('ul[aria-label="Agent Setup"] button.row');
    await expect(row).toContainText("Available in New Session");
    await row.click();
    const dialog = page.getByRole("dialog", { name: "Google Antigravity" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Available in New Session.")).toBeVisible();
    await capture(page, "connections-available", size, '[role="dialog"]');
  });

  for (const { id, state, phoneOnly } of SESSION_CAPTURES) {
    if (phoneOnly && !phone) continue;
    test(`Google Antigravity session, ${id}, ${size}`, async ({ page }) => {
      await openSession(page, state, viewport);
      await expectNoHorizontalOverflow(page.locator(".detail-reader"), "The transcript pane");
      if (id === "pickers" || id === "pickers-stress40") {
        const picker = await openModelSettings(page, viewport);
        if (id === "pickers") {
          for (const name of ["Gemini 4 Neon", "Gemini 4 Argon", "Orchestrator (Neon)", "Gemini 3.8 Flash", "GPT-OSS 120B (Medium)"]) {
            await expect(picker.getByText(name, { exact: true }).first()).toBeAttached();
          }
        }
      }
      if (id === "pickers-effort") {
        const picker = await openModelSettings(page, viewport);
        const effort = picker.getByText("Reasoning Effort", { exact: true });
        await expect(effort).not.toBeInViewport();
        await picker.getByText("Extra High", { exact: true }).scrollIntoViewIfNeeded();
        await expect(effort).toBeInViewport();
        await expect(picker.getByText("Extra High", { exact: true })).toBeInViewport();
      }
      if (id === "modes") {
        await openComposerBar(page, viewport);
        await page.getByRole("button", { name: /^Permission Mode/ }).click();
        const menu = page.getByRole("menu", { name: "Permission Mode" });
        await expect(menu).toBeVisible();
        // agy's own modes in its own words, Plan included, and no separate generic Default.
        await expect(menu.getByText("Default", { exact: true })).toHaveCount(1);
        for (const [name, description] of AGY_MODES) {
          await expect(menu.getByText(name, { exact: true })).toBeVisible();
          await expect(menu.getByText(attributed(description), { exact: true })).toBeVisible();
        }
        for (const text of [/AI-Reviewed/, /Ask Every Time/, /accept-edits/, /Uses the agent's own default mode/]) {
          await expect(menu.getByText(text)).toHaveCount(0);
        }
      }
      if (id === "attach-menu") {
        await page.getByRole("button", { name: "Attach and Settings" }).click();
        await expect(page.getByText("Attach Image…", { exact: true })).toBeVisible();
        await expect(page.getByText("Plan Mode", { exact: true })).toHaveCount(0);
      }
      if (id === "streaming") {
        // Open the turn's work and the command, so its long output shows.
        await page.getByRole("button", { name: /^Worked/ }).click();
        await page.getByText("ls -la src/notes", { exact: true }).first().click();
        await expect(page.getByText(/module-48-with-a-longer-file-name/).first()).toBeAttached();
        await expectNoHorizontalOverflow(page.locator(".detail-reader"), "The transcript pane with the output open");
      }
      if (id in LAUNCH_FAILURES) {
        const failure = LAUNCH_FAILURES[id as keyof typeof LAUNCH_FAILURES];
        await expect(page.getByText(failure.title, { exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Open Connections" })).toHaveCount(failure.connections ? 1 : 0);
        await expect(page.getByRole("button", { name: "Retry Turn" })).toHaveCount(0);
        // The runner's sentence, behind Show Details, without the generic launch prefix.
        await page.getByRole("button", { name: "Show Details" }).click();
        await expect(page.getByText(failure.detail, { exact: true })).toBeVisible();
        await expect(page.getByText(/agent init failed/)).toHaveCount(0);
      }
      if (id === "turn-failed") {
        await page.getByRole("button", { name: "Show Details" }).click();
        await expect(page.getByText(/could not complete this turn: .*…$/).first()).toBeVisible();
      }
      if (id === "approval") await expect(page.getByText("touch notes.txt").first()).toBeVisible();
      if (id === "denied") await expect(page.getByText("The command was denied, so nothing ran.")).toBeVisible();
      await capture(page, id, size, "body");
    });
  }

  // Fixture only (not agy's modes): ten long-named modes, five with 200+ character descriptions, one
  // with none, the fifth checked. The menu must fit or scroll, never sideways, and reach every row.
  test(`Google Antigravity session, modes-stress, ${size}`, async ({ page }) => {
    await openSession(page, "modes-stress", viewport);
    await openComposerBar(page, viewport);
    await page.getByRole("button", { name: /^Permission Mode/ }).click();
    const menu = page.getByRole("menu", { name: "Permission Mode" });
    await expect(menu).toBeVisible();
    const rows = menu.locator('[role^="menuitem"], [role="radio"]');
    await expect(rows).toHaveCount(10);
    await expect(rows.nth(4)).toHaveAttribute("aria-checked", "true");
    await expect(rows.nth(6)).toContainText("Wollipog doesn't know what this mode permits.");
    await expectNoHorizontalOverflow(menu, "The open Permission Mode menu");
    // Whether the menu (or the sheet around it) scrolls: a scrolling box in it, or holding it, that is taller than it shows.
    const scrolls = await menu.evaluate((root) => {
      const candidates = [...root.querySelectorAll("*"), root];
      for (let node = root.parentElement; node && node !== document.body; node = node.parentElement) candidates.push(node);
      return candidates.some((element) => ["auto", "scroll"].includes(getComputedStyle(element).overflowY) &&
        element.scrollHeight > element.clientHeight + 1);
    });
    measurements[`antigravity-session-modes-stress-${size}-scrolls`] = scrolls;
    // As it first appears.
    await capture(page, "modes-stress", size, "body");
    const last = rows.last();
    // Title Case keeps the short preposition "with" lowercase.
    await expect(last).toContainText("Fixture Mode Ten with a Long Name for Layout");
    await last.scrollIntoViewIfNeeded();
    await expect(last, "the last mode is reachable").toBeInViewport({ ratio: 1 });
    await expectNoHorizontalOverflow(menu, "The scrolled Permission Mode menu");
    if (scrolls) await capture(page, "modes-stress-scrolled", size, "body");
  });
});
