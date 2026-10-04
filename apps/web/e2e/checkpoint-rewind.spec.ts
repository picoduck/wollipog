import { expect, test, type Locator, type Page } from "@playwright/test";
import { dialogMotionSettled } from "./dialog-motion.js";
import { expectGeometry } from "./geometry-margins.js";

const YOUR_MESSAGE = ["Copy Message", "Edit as a New Turn", "Rewind Files to Before This Turn…"];
const THIS_TURN = ["Copy Response", "Copy Response as Markdown", "Fork After This Turn…", "Hand Off After This Turn…"];

/** The open menu's rows in order: section labels in brackets, then each item's name. */
async function menuRows(page: Page): Promise<string[]> {
  return page.getByRole("menu").locator(".menu-label, [role='menuitem']").evaluateAll((rows) => rows.map((row) =>
    row.getAttribute("role") === "menuitem" ? (row as HTMLElement).dataset.menuLabel ?? "" : `[${row.textContent}]`));
}

/** The box a pointer can hit: the element plus any absolutely positioned ::after that extends it. */
async function hitArea(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    const extends_ = after.content !== "none" && after.position === "absolute";
    const inset = (side: string) => extends_ ? Math.min(0, Number.parseFloat(after.getPropertyValue(side)) || 0) : 0;
    return {
      left: rect.left + inset("left"),
      top: rect.top + inset("top"),
      right: rect.right - inset("right"),
      bottom: rect.bottom - inset("bottom"),
    };
  });
}

test("rewind stays compact on its user turn across pointer interactions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html");
  // The turn's footer names it; its checkpoints draw no Start Turn or End Turn separator.
  await expect(page.locator(".tl-turn-footer .tl-turn-label")).toHaveText("Turn 4");
  await expect(page.getByRole("separator", { name: /^(Start|End) Turn/ })).toHaveCount(0);
  await expect(page.getByRole("separator", { name: "Files Rewound to Before Turn 4" })).toBeVisible();
  await expect(page.getByRole("separator", { name: "Forked from Turn 4" })).toBeVisible();
  const handoff = page.getByRole("separator", { name: "Handoff from Claude Code to Codex After Turn 4" });
  await expect(handoff).toBeVisible();
  const handoffDescriptionId = await handoff.getAttribute("aria-describedby");
  expect(handoffDescriptionId).toBeTruthy();
  await expect(page.locator(`[id="${handoffDescriptionId}"]`))
    .toHaveText("Fresh provider conversation. Tool output and reasoning were omitted.");
  await expect(page.locator(".tl-divider").filter({ hasText: "Rewind Files" })).toHaveCount(0);

  // More Turn Actions is visible at rest, quietly, and stays put while the footer is hovered.
  const more = page.getByRole("button", { name: "More Turn Actions" });
  await expect(more).toHaveCount(1);
  await expect(more).toBeVisible();
  await expect(more).toHaveCSS("opacity", "1");
  const before = await more.boundingBox();
  await page.locator(".tl-turn-footer").hover();
  expect(await more.boundingBox()).toEqual(before);

  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE, "[This Turn]", ...THIS_TURN]);
  await page.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" }).click();
  await expect(page.getByRole("status")).toHaveText("Rewind requested for turn 4.");
  await expect(more).toBeFocused();
});

test("on a fine pointer the hover clusters appear on hover or focus and take no height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html");
  const cluster = page.getByRole("group", { name: "Message Actions" });
  const bubble = page.locator(".tl-row.user .tl-bubble");
  const row = page.locator(".tl-row.user");
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "0");
  expect(await cluster.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))))
    .toEqual(["Copy Message", "Edit as a New Turn", "More Message Actions"]);
  // Absolutely placed beside the bubble: the row is exactly as tall as the bubble.
  const [rowBox, bubbleBox, clusterBox] = await Promise.all([row.boundingBox(), bubble.boundingBox(), cluster.boundingBox()]);
  expect(rowBox!.height).toBeCloseTo(bubbleBox!.height, 0);
  expect(clusterBox!.x + clusterBox!.width).toBeLessThanOrEqual(bubbleBox!.x);
  expect(clusterBox!.y + clusterBox!.height).toBeCloseTo(bubbleBox!.y + bubbleBox!.height, 0);

  await bubble.hover();
  await expect(cluster).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "0");
  await cluster.getByRole("button", { name: "Copy Message" }).focus();
  await expect(cluster).toHaveCSS("opacity", "1");

  // The footer's cluster: Copy Response and a usable Fork, before More Turn Actions.
  const footer = page.locator(".tl-turn-footer");
  const hoverActions = footer.locator(".tl-hover-action");
  await page.mouse.move(0, 0);
  await page.locator("body").focus();
  await expect(hoverActions).toHaveCount(2);
  for (const action of await hoverActions.all()) await expect(action).toHaveCSS("opacity", "0");
  await footer.hover();
  for (const action of await hoverActions.all()) await expect(action).toHaveCSS("opacity", "1");
  await footer.getByRole("button", { name: "Fork After This Turn" }).click();
  await expect(page.getByRole("status")).toHaveText("Fork requested after turn 4.");

  // An open menu keeps its cluster shown after the pointer leaves.
  await bubble.hover();
  await cluster.getByRole("button", { name: "More Message Actions" }).click();
  await page.mouse.move(0, 0);
  await expect(cluster).toHaveCSS("opacity", "1");
  expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE]);
});

test("an unavailable action is a disabled menu item whose visible reason describes it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/checkpoint-rewind-e2e.html?unavailable");
  await expect(page.getByRole("button", { name: "Fork After This Turn" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit as a New Turn" })).toHaveCount(0);
  await page.getByRole("button", { name: "More Turn Actions" }).click();
  const reasons: Record<string, string> = {
    "Edit as a New Turn": "Runner is offline.",
    "Rewind Files to Before This Turn…": "Reconnect the runner before restoring files.",
    "Fork After This Turn…": "Reconnect the runner before creating a fork.",
    "Hand Off After This Turn…": "Reconnect the runner before creating a handoff.",
  };
  for (const [name, reason] of Object.entries(reasons)) {
    const item = page.getByRole("menuitem", { name });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAccessibleDescription(reason);
    await expect(item.locator(".menu-desc")).toHaveText(reason);
    await expect(item.locator(".menu-desc")).toBeVisible();
  }
  await expect(page.getByRole("menuitem", { name: "Copy Response", exact: true })).toBeEnabled();
});

for (const width of [1440, 390]) {
  test(`More Turn Actions is visible at rest at ${width}px on a coarse pointer, with a 44px target and nothing overlapping`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true, isMobile: width < 760, viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto("/checkpoint-rewind-e2e.html");
    const more = page.getByRole("button", { name: "More Turn Actions" });
    await expect(more).toBeVisible();
    await expect(more).toHaveCSS("opacity", "1");
    // No hover cluster on a coarse pointer: More Turn Actions is the only action control.
    await expect(page.locator(".tl-user-actions, .tl-hover-action")).toHaveCount(0);
    await expect(page.locator(".tl-message-actions button")).toHaveCount(1);
    const area = await hitArea(more);
    expect(area.right - area.left).toBeGreaterThanOrEqual(44);
    expect(area.bottom - area.top).toBeGreaterThanOrEqual(44);
    // No other control's hit area reaches into it.
    for (const other of await page.locator(".timeline :is(button, a[href], summary)").all()) {
      if (await other.evaluate((element) => element.classList.contains("tl-more-actions"))) continue;
      const box = await hitArea(other);
      const overlaps = box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top;
      expect(overlaps, await other.evaluate((element) => element.outerHTML.slice(0, 120))).toBe(false);
    }

    await more.tap();
    const menu = page.getByRole("menu", { name: "More Turn Actions" });
    await expect(menu).toBeVisible();
    expect(await menuRows(page)).toEqual(["[Your Message]", ...YOUR_MESSAGE, "[This Turn]", ...THIS_TURN]);
    if (width < 760) {
      // A phone sheet: once it has slid in, docked to the bottom edge across the full width.
      await expect.poll(async () => {
        const box = (await menu.boundingBox())!;
        return [Math.round(box.x), Math.round(box.width), Math.round(box.y + box.height)];
      }).toEqual([0, width, 900]);
    }
    await page.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" }).tap();
    await expect(page.getByRole("status")).toHaveText("Rewind requested for turn 4.");
    await context.close();
  });
}

test("long-pressing a user bubble on a touch device selects text and opens no menu", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.goto("/checkpoint-rewind-e2e.html");
  const text = page.locator(".tl-row.user .bubble-text");
  await expect(text).toHaveCSS("user-select", /^(auto|text)$/);
  const box = (await text.boundingBox())!;
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(900);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A long press reaches the page as a context menu; nothing in the transcript claims it.
  const claimed = await text.evaluate((element) =>
    !element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(claimed).toBe(false);
  await expect(page.getByRole("menu")).toHaveCount(0);
  // The bubble's words can be selected as text.
  const selected = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toBe("Inspect the checkpoint controls.");
  await context.close();
});

// #2185: the whole-session surface, whose turn actions run their real composer flow and confirmations.
const SECOND_PROMPT = "Refactor the session notice slot so that every composer error becomes one entry, ranked after the session's own conditions.";

async function openSession(page: Page, query = "") {
  await page.goto(`/checkpoint-rewind-e2e.html?surface=session${query}`);
  await expect(page.locator(".tl-row.user")).toHaveCount(2);
}

/** Chooses `item` from the second message's More Message Actions menu. */
async function chooseMessageAction(page: Page, item: string) {
  const message = page.locator(".tl-row.user").nth(1);
  await message.hover();
  await message.getByRole("button", { name: "More Message Actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

function editingCopyNotice(page: Page) {
  return page.locator('.session-notice-slot[data-notice-key="editing-copy"] .notice');
}

test.describe("turn action flows on a whole session (#2185)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Edit as a New Turn loads an empty composer with no dialog, and sending the copy ends the edit", async ({ page }) => {
    await openSession(page);
    const composer = page.locator(".composer-input");
    await expect(composer).toHaveValue("");
    const message = page.locator(".tl-row.user").nth(1);
    await message.hover();
    await message.getByRole("button", { name: "Edit as a New Turn" }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer).toHaveValue(SECOND_PROMPT);
    await expect(composer).toBeFocused();
    await expect(page.locator(".composer .attach-thumb")).toHaveCount(1);
    const notice = editingCopyNotice(page);
    await expect(notice).toHaveClass(/\bcompact\b/);
    await expect(notice).toHaveClass(/\bt-info\b/);
    await expect(notice.locator(".notice-body")).toHaveText("Editing a copy of your Turn 2 message. Earlier turns stay as they are.");
    await expect(notice.getByRole("button", { name: "Discard Edit" })).toBeVisible();

    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("body")).toHaveAttribute("data-prompted", SECOND_PROMPT);
    await expect(editingCopyNotice(page)).toHaveCount(0);
    await expect(composer).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await expect(page.locator(".form-error")).toHaveCount(0);
  });

  test("over a draft, Replace Draft asks first and Discard Edit restores the draft", async ({ page }) => {
    const draft = "Check the phone layout too.";
    await openSession(page, `&draft=${encodeURIComponent(draft)}`);
    const composer = page.locator(".composer-input");
    await expect(composer).toHaveValue(draft);
    const message = page.locator(".tl-row.user").nth(1);
    await message.hover();
    await message.getByRole("button", { name: "Edit as a New Turn" }).click();

    const dialog = page.getByRole("dialog", { name: "Replace Draft" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".confirmation-message"))
      .toHaveText("Your current draft is replaced by this message. You can restore it with Discard Edit.");
    await expect(dialog.locator(".modal-foot > button")).toHaveText(["Cancel", "Replace Draft"]);
    await expect(composer).toHaveValue(draft);
    await dialog.getByRole("button", { name: "Replace Draft" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveValue(SECOND_PROMPT);
    await expect(composer).toBeFocused();

    await editingCopyNotice(page).getByRole("button", { name: "Discard Edit" }).click();
    await expect(composer).toHaveValue(draft);
    await expect(page.locator(".composer .attach-thumb")).toHaveCount(0);
    await expect(editingCopyNotice(page)).toHaveCount(0);
    await expect(composer).toBeFocused();
  });

  test("Edit in a Fork confirms, keeps its button busy while the fork is created, then opens the fork", async ({ page }) => {
    await openSession(page);
    await chooseMessageAction(page, "Edit in a Fork…");
    const dialog = page.getByRole("dialog", { name: "Edit in a Fork" });
    await expect(dialog.locator(".confirmation-message")).toHaveText(
      "A new session continues from before Turn 2 in its own worktree, and this message opens in its composer for you to edit. This session stays as it is.");
    await expect(dialog.locator("textarea")).toHaveCount(0);
    const confirm = dialog.getByRole("button", { name: "Edit in a Fork" });
    await confirm.click();
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(page.locator("body")).toHaveAttribute("data-navigated", "checkpoint-rewind-fork");
    await expect(page.locator("body")).toHaveAttribute("data-forked", "1");
    await expect(dialog).toHaveCount(0);
  });

  test("an ambiguous Edit in a Fork stays in its dialog as a danger notice", async ({ page }) => {
    await openSession(page, "&fork=ambiguous");
    await chooseMessageAction(page, "Edit in a Fork…");
    const dialog = page.getByRole("dialog", { name: "Edit in a Fork" });
    await dialog.getByRole("button", { name: "Edit in a Fork" }).click();
    const failure = dialog.locator(".notice.t-danger");
    await expect(failure).toContainText("The fork outcome is uncertain. Do not retry.");
    await expect(dialog).toBeVisible();
    // Above the footer, inside the dialog's body.
    const [failureBox, footBox] = await Promise.all([failure.boundingBox(), dialog.locator(".modal-foot").boundingBox()]);
    expect(failureBox!.y + failureBox!.height).toBeLessThanOrEqual(footBox!.y);
    expect(await page.locator("body").getAttribute("data-navigated")).toBeNull();
  });

  test("Rewind Files names the turn with a capital T and quotes its prompt", async ({ page }) => {
    await openSession(page);
    await chooseMessageAction(page, "Rewind Files to Before This Turn…");
    const dialog = page.getByRole("dialog", { name: "Rewind Files" });
    await expect(dialog.locator(".confirmation-message")).toHaveText(
      "Files go back to how they were before Turn 2, “Refactor the session notice slot so that every composer erro…”. The conversation isn't rewound, so the agent still remembers later turns.");
    await expect(dialog.locator(".modal-foot > button")).toHaveText(["Cancel", "Rewind Files"]);
    await expect(dialog.getByRole("button", { name: "Rewind Files" })).toHaveClass(/\bdanger\b/);
    await dialog.getByRole("button", { name: "Rewind Files" }).click();
    await expect(page.locator("body")).toHaveAttribute("data-rewound", "2");
  });

  test("a refused rewind is Rewind Failed in plain words, with the server's behind Show Details (#2511)", async ({ page }) => {
    await openSession(page, "&rewind=refused");
    await chooseMessageAction(page, "Rewind Files to Before This Turn…");
    await page.getByRole("dialog", { name: "Rewind Files" }).getByRole("button", { name: "Rewind Files" }).click();
    const notice = page.locator(".session-notice-slot").getByRole("alert", { name: "Rewind Failed" });
    await expect(notice.locator(".notice-title")).toHaveText("Rewind Failed");
    await expect(notice.locator(".notice-body")).toHaveText("Couldn't rewind the files to before this turn. Try again.");
    await expect(page.getByText("git checkout exited with 128")).toHaveCount(0);
    await notice.getByRole("button", { name: "Show Details" }).click();
    await expect(notice.locator(".notice-details-body code")).toHaveText("rewind failed: git checkout exited with 128");
  });

  test("Fork Conversation says what continues, and a Claude Code session notes its latest-turn limit in dim text", async ({ page }) => {
    await openSession(page, "&driver=claude-code");
    await page.getByRole("button", { name: "More Turn Actions" }).last().click();
    await page.getByRole("menuitem", { name: "Fork After This Turn…" }).click();
    const dialog = page.getByRole("dialog", { name: "Fork Conversation" });
    await expect(dialog.locator(".confirmation-message")).toHaveText(
      "A new session continues from after Turn 2 in its own worktree, with the same agent and conversation history. This session stays as it is.");
    const note = dialog.locator(".confirmation-note");
    await expect(note).toHaveText("Claude Code can only fork after the latest turn.");
    const colors = await note.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-dim)";
      document.body.append(probe);
      const dim = getComputedStyle(probe).color;
      probe.remove();
      return { note: getComputedStyle(element).color, dim };
    });
    expect(colors.note).toBe(colors.dim);
    await expect(dialog.locator(".modal-foot > button")).toHaveText(["Cancel", "Fork Conversation"]);
  });

  for (const [recovery, body] of [
    ["fork", "A new session continues from Turn 2, before the item the provider rejected, with the files from that turn. This session stays as it is so you can inspect it."],
    ["handoff", "A new session starts a fresh conversation from a summary of Turns 1 to 2, with the files from that turn. This session stays as it is so you can inspect it."],
  ] as const) {
    test(`Recover Session describes a ${recovery} recovery by its outcome`, async ({ page }) => {
      await openSession(page, `&quarantine=${recovery}`);
      await page.getByRole("button", { name: "Recover Session" }).click();
      const dialog = page.getByRole("dialog", { name: "Recover Session" });
      await expect(dialog.locator(".confirmation-message")).toHaveText(body);
      await expect(dialog.locator(".modal-foot > button")).toHaveText(["Cancel", "Recover Session"]);
    });
  }
});

test.describe("turn action confirmations on a phone (#2185)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const cases: Array<{ name: string; query?: string; open: (page: Page) => Promise<void>; buttons: string[] }> = [
    {
      name: "Replace Draft",
      query: "&draft=Check%20the%20phone%20layout%20too.",
      open: async (page) => {
        await page.getByRole("button", { name: "More Turn Actions" }).last().tap();
        await page.getByRole("menuitem", { name: "Edit as a New Turn" }).tap();
      },
      buttons: ["Cancel", "Replace Draft"],
    },
    {
      name: "Edit in a Fork",
      open: async (page) => {
        await page.getByRole("button", { name: "More Turn Actions" }).last().tap();
        await page.getByRole("menuitem", { name: "Edit in a Fork…" }).tap();
      },
      buttons: ["Cancel", "Edit in a Fork"],
    },
    {
      name: "Rewind Files",
      open: async (page) => {
        await page.getByRole("button", { name: "More Turn Actions" }).last().tap();
        await page.getByRole("menuitem", { name: "Rewind Files to Before This Turn…" }).tap();
      },
      buttons: ["Cancel", "Rewind Files"],
    },
    {
      name: "Fork Conversation",
      open: async (page) => {
        await page.getByRole("button", { name: "More Turn Actions" }).last().tap();
        await page.getByRole("menuitem", { name: "Fork After This Turn…" }).tap();
      },
      buttons: ["Cancel", "Fork Conversation"],
    },
    {
      name: "Recover Session",
      query: "&quarantine=fork",
      open: async (page) => { await page.getByRole("button", { name: "Recover Session" }).tap(); },
      buttons: ["Cancel", "Recover Session"],
    },
  ];
  for (const { name, query, open, buttons } of cases) {
    test(`${name} is a bottom sheet with two equal buttons`, async ({ page }) => {
      await openSession(page, query);
      await open(page);
      const dialog = page.getByRole("dialog", { name });
      await expect(dialog).toBeVisible();
      await dialogMotionSettled(page);
      const box = (await dialog.boundingBox())!;
      expect([Math.round(box.x), Math.round(box.width), Math.round(box.y + box.height)]).toEqual([0, 390, 844]);
      const foot = await dialog.locator(".modal-foot > button").evaluateAll((elements) => elements.map((element) => ({
        text: element.textContent, width: element.getBoundingClientRect().width,
      })));
      expect(foot.map(({ text }) => text)).toEqual(buttons);
      expectGeometry(Math.abs(foot[0]!.width - foot[1]!.width), "the two footer buttons are equal width").toBeLessThanOrEqual(0.61);
    });
  }
});
