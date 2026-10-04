import { expect, type Locator, type Page } from "@playwright/test";

/** Moves every transition on `tooltip` to `ms` into its timeline and returns their properties and delays. */
function seek(tooltip: Locator, ms: number) {
  return tooltip.evaluate((element, at) => element.getAnimations()
    .filter((animation): animation is CSSTransition => animation instanceof CSSTransition)
    .map((transition) => {
      transition.currentTime = at;
      return { property: transition.transitionProperty, delay: transition.effect?.getTiming().delay };
    }), ms);
}

/**
 * Asserts that hovering `anchor` shows `tooltip` only after §9.3's delay (`--delay-tooltip`), that
 * leaving earlier shows nothing, and that leaving hides it at once (#2433).
 *
 * The tooltip waits in CSS, which `page.clock` does not control, so this freezes the page's
 * animation timeline instead and seeks each transition to the moment it asserts.
 */
export async function expectDelayedTooltip(page: Page, anchor: Locator, tooltip: Locator): Promise<void> {
  const delay = await page.evaluate(() => Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue("--delay-tooltip"), 10));
  expect(delay, "§9.3: a tooltip waits 500ms").toBe(500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
  try {
    await expect(tooltip).toBeHidden();

    await anchor.hover();
    expect(await seek(tooltip, delay - 1), "both the fade and the visibility wait").toEqual(expect.arrayContaining([
      { property: "opacity", delay },
      { property: "visibility", delay },
    ]));
    await expect(tooltip, "1ms short of the delay, nothing shows").toBeHidden();
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    expect(await seek(tooltip, 0), "leaving early cancels the reveal").toEqual([]);

    await anchor.hover();
    await seek(tooltip, delay + 1);
    await expect(tooltip, "once the delay has passed, it shows").toBeVisible();
    await seek(tooltip, delay + 1000);
    await expect(tooltip, "and fades fully in").toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await expect(tooltip, "leaving hides it without waiting").toBeHidden();
    expect((await seek(tooltip, 0)).filter((transition) => transition.delay !== 0)).toEqual([]);
  } finally {
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    await cdp.detach();
  }
}
