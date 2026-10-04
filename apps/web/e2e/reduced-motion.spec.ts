import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The global reduced-motion guard (#2574). It collapses every transition and animation the app
 * declares to 1ms, so their end events still fire, and it must not turn every other property change
 * into a transition. With `transition-property` defaulting to `all`, a guard that raised every
 * element's duration to 1ms did exactly that: a change to an element that declares no transition
 * painted a frame late, and geometry written in step with a scroll correction jumped for that frame
 * (#2426).
 */

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/reduced-motion-e2e.html");
  await expect(page.getByTestId("undeclared")).toBeVisible();
  await page.evaluate(() => {
    const host = window as typeof window & { __endEvents?: string[] };
    host.__endEvents = [];
    for (const type of ["transitionend", "animationend"] as const) {
      document.addEventListener(type, (event) => {
        const name = event instanceof AnimationEvent ? event.animationName : (event as TransitionEvent).propertyName;
        host.__endEvents!.push(`${type}:${name}@${(event.target as Element).classList[0] ?? ""}`);
      }, true);
    }
  });
});

function endEvents(page: Page) {
  return page.evaluate(() => (window as typeof window & { __endEvents?: string[] }).__endEvents ?? []);
}

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`an element that declares no transition takes a new value in the same frame (${reducedMotion} motion)`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    const changes = { paddingTop: "37px", height: "120px", transform: "matrix(1, 0, 0, 1, 0, 24)" };
    const result = await page.getByTestId("undeclared").evaluate((element, wanted) => {
      const computed = getComputedStyle(element);
      // The before-change style a transition would start from.
      const before = { paddingTop: computed.paddingTop, height: computed.height, transform: computed.transform };
      element.style.paddingTop = wanted.paddingTop;
      element.style.height = wanted.height;
      element.style.transform = "translateY(24px)";
      return {
        before,
        after: { paddingTop: computed.paddingTop, height: computed.height, transform: computed.transform },
        animations: element.getAnimations().map((animation) =>
          animation instanceof CSSTransition ? `transition:${animation.transitionProperty}` : animation.constructor.name),
      };
    }, changes);
    expect(result.before).not.toEqual(changes);
    expect(result.animations).toEqual([]);
    expect(result.after).toEqual(changes);
  });
}

test("a declared transition still runs, for 1ms, and fires transitionend", async ({ page }) => {
  const declared = page.getByTestId("declared");
  const running = await declared.evaluate((element) => {
    getComputedStyle(element).backgroundColor;
    element.style.backgroundColor = "rgb(1, 2, 3)";
    return element.getAnimations().flatMap((animation) => animation instanceof CSSTransition
      ? [{ property: animation.transitionProperty, duration: animation.effect?.getComputedTiming().duration }]
      : []);
  });
  expect(running).toEqual([{ property: "background-color", duration: 1 }]);
  await expect.poll(() => endEvents(page)).toContain("transitionend:background-color@dir-entry");
  await expect(declared).toHaveCSS("background-color", "rgb(1, 2, 3)");
});

test("a transition declared with a long duration, even inline, still collapses to 1ms", async ({ page }) => {
  // The guard stays global: no element keeps long motion by declaring its own.
  const running = await page.getByTestId("undeclared").evaluate((element) => {
    element.style.transition = "opacity 5s linear";
    getComputedStyle(element).opacity;
    element.style.opacity = "0.5";
    return element.getAnimations().flatMap((animation) => animation instanceof CSSTransition
      ? [{ property: animation.transitionProperty, duration: animation.effect?.getComputedTiming().duration }]
      : []);
  });
  expect(running).toEqual([{ property: "opacity", duration: 1 }]);
  await expect.poll(() => endEvents(page)).toContain("transitionend:opacity@tl-bubble");
});

test("a declared animation still runs, for 1ms, and fires animationend", async ({ page }) => {
  await page.getByRole("button", { name: "Open Menu" }).click();
  const menu = page.getByRole("menu", { name: "Actions" });
  await expect(menu).toBeVisible();
  await expect.poll(() => endEvents(page)).toContain("animationend:modal-fade-in@menu");
  // Collapsed, not removed: a 1ms run is the only kind whose end the menu can hear.
  expect(await menu.evaluate((element) => getComputedStyle(element).animationDuration)).toBe("0.001s");
});

/**
 * A trigger that an animation moves, the way a phone sheet carries its triggers in as it slides up
 * (§7.5). Nothing resizes and nothing scrolls, so only the `animationend` listener can place the
 * list again. `static` moves the trigger the same distance with no animation: the negative control
 * that proves nothing else moved the list.
 */
async function moveTrigger(page: Page, trigger: Locator, how: "animated" | "static") {
  await page.addStyleTag({
    content: `@keyframes trigger-shift { to { translate: 0 40px; } }
      .trigger-shift-animated { animation: trigger-shift var(--dur-slow) var(--ease-out) forwards; }
      .trigger-shift-static { translate: 0 40px; }`,
  });
  await trigger.evaluate((element, className) => element.classList.add(className), `trigger-shift-${how}`);
  if (how === "animated") {
    await expect.poll(async () => (await endEvents(page)).some((event) => event.startsWith("animationend:trigger-shift@")))
      .toBe(true);
  }
  // Long enough for anything a frame or two late to have placed the list again.
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 6;
    const next = () => (--frames <= 0 ? resolve() : requestAnimationFrame(next));
    requestAnimationFrame(next);
  }));
}

async function top(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!.y;
}

for (const how of ["animated", "static"] as const) {
  test(`a menu follows its trigger when an animation that moved it ends (${how} move)`, async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Open Menu" });
    await trigger.click();
    const menu = page.getByRole("menu", { name: "Actions" });
    await expect.poll(() => endEvents(page)).toContain("animationend:modal-fade-in@menu");
    const before = await top(menu);
    await moveTrigger(page, trigger, how);
    expect(await top(menu) - before).toBeCloseTo(how === "animated" ? 40 : 0, 0);
  });

  test(`a combobox list follows its field when an animation that moved it ends (${how} move)`, async ({ page }) => {
    const field = page.getByRole("combobox", { name: "Fruit" });
    await field.focus();
    const list = page.getByRole("listbox", { name: "Fruit" });
    await expect(list).toBeVisible();
    const before = await top(list);
    await moveTrigger(page, field, how);
    expect(await top(list) - before).toBeCloseTo(how === "animated" ? 40 : 0, 0);
  });
}
