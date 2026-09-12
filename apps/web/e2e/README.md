# Browser End-to-End Specs

Playwright specs for the web client. They run in CI as the **Browser End-to-End Tests** job, which
takes over twenty minutes, so a spec that fails for the wrong reason is expensive to diagnose.

Run them from the repository root — the config and `baseURL` live there:

```bash
npx playwright test apps/web/e2e/<name>.spec.ts
```

## Geometry: Compare Measurements, Not Numbers

**A rendered size is not a layout constant.** An element's height is the sum of its line boxes, so
it follows the font stack of whatever machine rasterises it. The CI runner renders text about 3.5%
smaller than a typical developer machine: a Sessions list card that measures 86px locally measures
83px there.

#877 wrote this, having measured the card by hand:

```ts
expect(phone).toBeGreaterThanOrEqual(85);
expect(phone).toBeLessThanOrEqual(87);
```

It passed locally and failed in CI, reporting a layout regression that did not exist — 628 of 629
tests passed and the one failure was the assertion itself.

So assert geometry **relatively**. Every one of these holds on any renderer:

```ts
// One element against another.
expect(phone).toBeGreaterThan(desktop + 15);

// The same element before and after a change.
expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);

// A structural fact rather than a size.
expect(resolvedGridRows).toBe(2);

// Containment: nothing spills past the edge.
expect(badge.right - (card.right - padding)).toBeLessThanOrEqual(0.5);
```

### There is no automated check for this — yet

A static scanner was built for it and then withdrawn. It is worth knowing why, because the reason is
also the reason this convention needs writing down.

Four rounds of review found twenty-four ways to pin a measurement past a source-level scanner, and
the count per round did not fall: nine, six, nine, six. TypeScript has more ways to route a number
into a comparison than a scanner has branches — an imported constant, a destructured alias, a local
helper's return, a value normalised by a divisor, `toHaveProperty`, a poll callback's second return.
Closing each one was easy; the supply did not run out.

Worse, the last round found the scanner reporting CORRECT code as a pin: a count bounded to a narrow
range, two bounds in mutually exclusive `if`/`else` branches, a count destructured alongside a
measurement. A guard that flags good code is worse than one that misses bad code, because the only
remedy it offers is an allowlist entry certifying that the correct assertion is wrong — and an
allowlist full of those teaches reviewers to wave the next one through.

**What would work is a runtime check**, because the thing that distinguishes a safe bound from a
dangerous one is the margin between the bound and the value actually observed, and that exists only
while the browser is running. A helper that knows both numbers and fails when they sit too close
together catches every route above, including the two no source-level reading can reach:

- a relative assertion with no headroom — `expect(crowded.width).toBeGreaterThan(roomy.width * 0.4)`
  where the true ratio is 0.42. Statically identical to the same line with a ratio of 0.9. **This
  shape has broken CI here once already.**
- a tight one-sided bound, for the same reason.

Until that exists, this convention is enforced by review and by you. When you write any numeric bound
on something text-derived, satisfy yourself that it has room — nothing will do it for you.

## Other Conventions

- **Port 4174 is fixed and `--strictPort`.** Two checkouts cannot run the suite at once; wait rather
  than killing another run's server.
- **The list is virtualized.** A card only has a box while it is mounted, so a spec that measures
  every row needs a viewport tall enough to mount them all, and should assert the expected count
  first so a failure names the real cause.
