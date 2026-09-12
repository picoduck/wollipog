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

### Relative Is Necessary, Not Sufficient

Comparing two measurements removes the machine-specific constant. It does not make the comparison
machine-independent, because **the two sides can scale differently**.

#947 asserted that an agent's first word is not clipped by its label's box — a `Range` over those
characters against that box. Two measurements, no constant, exactly the rule above. It passed on a
developer machine and failed on CI by 6.328125px, consistently across all three retries. The word's
advance width comes from the text; the box it has to fit inside is whatever the pills beside it left
over. Only one of those follows the font.

The app asks for `"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`. A
developer box here resolves that to Noto Sans and the CI runner to DejaVu Sans, about 8% wider —
enough to move the outcome. `fc-match "Segoe UI"` tells you what a given machine will use.

So when an assertion's **margin** depends on text advance width, measure it twice: once in the
ambient face, once with a wide face pinned — having first proved that face actually resolved, because
an absent family falls through to the ambient one and the second pass silently re-measures the first.
Use `pinWidestFace(page, scope)` from `font-geometry.ts` for that second pass. It verifies that a
candidate face actually resolves, pins the widest verified candidate on the supplied subtree, and
returns its name for the assertion message. If no candidate resolves, it names the font packages to
install rather than silently repeating the ambient measurement.

An assertion that compares two text measurements which scale together, or that reads a structural
fact such as a resolved track count, needs only the ambient pass.

For example, `status-badge-parity.spec.ts` needs no pinned pass: its badge comparisons use the same
font and scale together, while its responsive status-row assertions derive which badges fit from
the current face instead of expecting a particular wrap.

### Check Numeric Bounds at Runtime

Use `expectGeometry` from `geometry-margins.ts` when a numeric bound is safe because the observed
measurement has room to spare:

```ts
expectGeometry(phone - desktop, "the phone card is at least one text line taller")
  .toBeGreaterThan(15);
```

The helper first runs the ordinary Playwright assertion, then separately requires the measured
margin to be at least 10% of the bound's magnitude (with a one-pixel scale floor for zero and
sub-pixel bounds). A narrow failure reports the reason, observed value, bound, actual margin, and
required margin. `expectGeometryPoll` applies the same check after a polled upper bound settles.

Ten percent comes from the measured distribution, not a guessed renderer allowance. The #931
regression observed 42 against a bound of 40: 5% headroom. The 53 margin-bearing assertion sites in
`inbox-row-layout.spec.ts`, the suite's densest geometry spec, were run with
`GEOMETRY_MARGIN_REPORT=1`; the smallest healthy size or spacing margin was 40%, and the smallest
half-pixel agreement margin was 50%. Ten percent is therefore twice the known failure and one
quarter of the tightest healthy margin. The helper's own spec pins both sides of that decision: 42
against 40 fails and the audited bounds pass.

Set `GEOMETRY_MARGIN_REPORT=1` to print a JSON record for every checked observation while auditing a
spec. This is how a bound's current margin is recorded from the browser rather than inferred from
source.

Not every geometry assertion has a safety margin. Keep ordinary `expect` for these audited classes:

- exact structural or monotonic invariants where equality is the valid outcome, such as “pressure
  never grows the sender” when both measured widths are equal;
- values fixed by the test or stylesheet rather than rendered text, including viewport dimensions,
  CSS-sized touch targets and icon boxes, SVG coordinates, and spacing tokens;
- counts, DOM order, resolved CSS structure, booleans computed from containment, and geometry used
  only to choose an interaction coordinate.

The current suite audit found 34 specs that read a bounding rectangle. The margin-bearing assertions
in the densest one use the runtime helper; its three equality-valid structural comparisons are
called out beside their bare assertions. The remaining readings fall into the classes above. This
classification is a review record, not a source scanner: the withdrawn scanner produced both
bypasses and false positives, while only the running browser can say how much margin a bound
actually has. New numeric bounds whose safety depends on room to spare must use the helper and state
why the bound is safe.

## Other Conventions

- **Port 4174 is fixed and `--strictPort`.** Two checkouts cannot run the suite at once; wait rather
  than killing another run's server.
- **The list is virtualized.** A card only has a box while it is mounted, so a spec that measures
  every row needs a viewport tall enough to mount them all, and should assert the expected count
  first so a failure names the real cause.
