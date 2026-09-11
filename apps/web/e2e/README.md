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

### What the guardrail enforces

`apps/web/src/e2e-geometry-guardrails.test.ts` runs with the unit tests — in the fast CI job, not in
the twenty-minute browser job it protects — and fails on the two shapes that cannot survive a
renderer change:

1. **Equality against a number**: `toBe(86)`, `toBeCloseTo(24)`. An equality has no headroom.
2. **A narrow two-sided range** over one subject inside one test: `>= 85` with `<= 87`. That window
   is 2.3% wide, and the drift between machines is larger.

Values below 1 are treated as tolerances rather than sizes, so `toBeLessThanOrEqual(0.5)` and
`toBe(0)` are left alone: they mean the same thing everywhere. Counts are left alone too — five
badges are five badges whatever the font.

### What it does not enforce, and what that asks of you

**A one-sided bound is not checked**, because a scanner cannot tell a generous bound from a tight one
without running the browser. `expect(branch.width).toBeGreaterThan(40)` against a real 340px is
safe; `toBeGreaterThan(300)` against the same 340px has about 10% of headroom and is one font change
away from failing.

When you write a one-sided bound on something text-derived, **leave it room** — aim for at least a
quarter of the measured value, and prefer a relative comparison where one is available.

**Which direction is risky depends on which way the drift goes.** CI renders text *smaller*, so a
lower bound is the one that fails there: `expect(label.width).toBeGreaterThan(300)` against a local
341px has about 12% of headroom and roughly 3.5% of it is spent before the assertion even runs. An
upper bound like `toBeLessThanOrEqual(45)` is comfortable on CI for the same reason — and is the one
that will fail on a machine whose fonts render larger than yours. Neither direction is safe by
default; both want room.

### What it cannot see, and why you still have to think

Two reviewers attacked this guard across several rounds and between them walked through it fifteen
ways. Thirteen are closed and pinned by tests — including three that had LIVE instances in this
suite the scanner could not see: a block-bodied `expect.poll` callback, an array of coordinate
objects, and a measured local wrapped in `Math.round`. Two are not closable statically, and it is
better to know that than to trust the green tick:

- **A relative assertion with no headroom.** `expect(crowded.width).toBeGreaterThan(roomy.width * 0.4)`
  where the true ratio is 0.42. Both sides are measurements, so it is relative by this guard's rule —
  and it still failed on CI. It is statically identical to the same line with a true ratio of 0.9;
  the only difference is the measured value, which exists at runtime. **This shape has broken CI
  here once already.**
- **A tight one-sided bound**, for the same reason.

Both share a discriminator the scanner cannot reach: the margin between the asserted bound and the
value actually observed. Closing them means checking at runtime — a helper that knows both numbers
and fails when they sit too close together — which would catch everything above as a side effect.
That is worth doing and is not what this file is.

Until then: when you write any numeric bound on something text-derived, satisfy yourself that it has
room, because nothing here will do it for you.

### Legitimate exceptions

Some numbers really are fixed: a viewport width the test itself set, an SVG icon's box, a button
sized by CSS, the gap between two elements. Those live in `apps/web/src/e2e-geometry-debt.json`, each
with the reason it holds everywhere.

Adding an entry is meant to be a deliberate, reviewable act. Regenerate the list with:

```bash
node scripts/regenerate-e2e-geometry-debt.mjs
```

It preserves the reasons already written and gives any new entry a placeholder that the guardrail
itself rejects, so regenerating cannot quietly launder an unexplained exception into the tree.
Replace the placeholder with why that particular number is stable — or make the assertion relative
and delete the entry.

## Other Conventions

- **Port 4174 is fixed and `--strictPort`.** Two checkouts cannot run the suite at once; wait rather
  than killing another run's server.
- **The list is virtualized.** A card only has a box while it is mounted, so a spec that measures
  every row needs a viewport tall enough to mount them all, and should assert the expected count
  first so a failure names the real cause.
