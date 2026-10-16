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

Use relative measurements as the starting point. Numeric bounds whose safety depends on headroom go
through `expectGeometry`, while exact structural facts stay ordinary assertions:

```ts
// One element against another.
expectGeometry(phone - desktop, "the phone card is at least one text line taller")
  .toBeGreaterThan(15);

// The same element before and after a change.
expectGeometry(Math.abs(after.height - before.height), "the change preserves card height")
  .toBeLessThanOrEqual(0.61);

// A structural fact rather than a size.
expect(resolvedGridRows).toBe(2);

// Containment: nothing spills past the edge.
expectGeometry(badge.right - (card.right - padding), "the badge stays inside the card")
  .toBeLessThanOrEqual(0.61);
```

The `0.61` bounds above allow the intended 0.5px of renderer tolerance while reserving slightly more
than the helper's minimum 0.1px of headroom. Use a value strictly above the mathematical sum because
decimal subtraction can round an exact boundary just below the required margin. The sections below
explain when a second font pass is also necessary and how the runtime margin is checked.

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

### Wrap and Sizing Tests: Cause the Wrap, Then Prove It

Some defects only appear when text wraps: a list sized from an estimated line count clips its last
option, or a row grows and pushes its neighbour. The test for one must make the text wrap, and
which text wraps depends on the face.

Not every harness page renders in the app font. `settings-rows-e2e.html`,
`skills-unavailable-e2e.html`, `project-notices-e2e.html` and `new-session-choices-e2e.html` pin Arial, so their screenshot
baselines and text-heavy measurements do not follow each machine's system UI font. Arial is narrow
and hides wraps the product shows.

- **Escape the face with `pinWidestFace(page, page.locator("body"))`,** not an ad hoc style tag. It
  overrides a page's pinned font, and the widest verified face wraps at least as early as the app
  font does on the CI runner. Pin `body` when the text under test mounts after the pin, such as an
  opened list: descendants added later inherit the pin.
- **Assert the wrap before the assertion it enables.** Count the text's line boxes (distinct `top`s
  of a `Range` over it). Without that precondition, a machine whose widest candidate is narrower, or
  a copy change that shortens the text, leaves a test that passes whether or not the defect is
  fixed.
- **When the widest face alone does not wrap at the width under test,** lengthen the text as a
  person would, for example with a 150% root font size (the browser's text-size setting), and fix
  the locale, time zone and clock for generated text such as dates.

`snooze-typeahead.spec.ts` ("grows to its wrapped dates instead of scrolling") and
`new-session-choices.spec.ts` ("a short Project list grows to its wrapped descriptions instead of
scrolling") follow this pattern.

### Check Numeric Bounds at Runtime

Use `expectGeometry` from `geometry-margins.ts` when a numeric bound is safe because the observed
measurement has room to spare:

```ts
expectGeometry(phone - desktop, "the phone card is at least one text line taller")
  .toBeGreaterThan(15);
```

The helper first runs the ordinary Playwright assertion, then separately requires the measured
margin to be at least 10% of the bound's magnitude (with a one-pixel scale floor for zero and
sub-pixel bounds). That floor is part of the caller's allowance: to tolerate an observation up to
0.5px, use an upper bound strictly greater than 0.6px, such as 0.61px, so floating-point rounding
cannot erase the required 0.1px margin. A narrow failure reports the reason, observed value, bound,
actual margin, and required margin. `expectGeometryPoll` applies the same check after a polled bound
settles.

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

## Pixel Baselines: Commit Every Platform's Set Together

`settings-rows.spec.ts` compares screenshots against committed baselines, which Playwright keeps per
platform: `settings-rows.spec.ts-snapshots/*-linux.png` and `*-win32.png`. Both sets are checked in
CI:

- The **Browser End-to-End Tests** job compares the linux set on every pull request.
- The **Settings-Rows win32 Baselines** job compares the win32 set on `windows-latest`. It runs
  only when the pull request or merge group changes the spec or its snapshots; otherwise it reports
  success without starting a Windows runner. The required check waits for it either way.

### The linux Set Comes From CI

Do not regenerate the linux set locally. Text-bearing clips such as `settings-rows-*` and
`colour-schemes-*` render 3–4% differently on an Ubuntu desktop and in the Playwright jammy image
than on CI's runner. That is above the comparisons' 2% budget, so an image rendered locally fails
CI's comparison.

Push the change instead and let the comparison fail. The browser shard that ran the spec re-runs it
with `--update-snapshots=changed`, uploads only the regenerated `*-linux.png` files as the
`settings-rows-linux-baselines` artifact, and its job summary gives the commands that put them in
place. `gh run download` refuses to overwrite an existing file, and a stale baseline always exists,
so they download into a temporary directory and copy it over the checkout:

```bash
dir="$(mktemp -d)"
gh run download <run-id> --repo <owner>/<repo> --name settings-rows-linux-baselines --dir "$dir"
cp -R "$dir"/. . && rm -rf "$dir"
git add apps/web/e2e/settings-rows.spec.ts-snapshots
```

Look at each image before committing it: it should show the change you meant to make. The job
still fails, and so does the required check, until the next run compares against the committed
images. If the comparison failed but nothing differed, the summary says so instead, and the failure
is not baseline drift.

### The win32 Set Follows the linux Set

When a change regenerates the linux set, expect the win32 comparison to fail on the same images.
The failed job re-runs with `--update-snapshots=changed`, uploads only the regenerated
`*-win32.png` files as the `settings-rows-win32-baselines` artifact, and its job summary gives the
same commands for that artifact:

```bash
dir="$(mktemp -d)"
gh run download <run-id> --repo <owner>/<repo> --name settings-rows-win32-baselines --dir "$dir"
cp -R "$dir"/. . && rm -rf "$dir"
git add apps/web/e2e/settings-rows.spec.ts-snapshots
```

Look at each image before committing it: it should show the same change as its linux pair. If the
linux set changes outside a pull request, run the **Settings-Rows win32 Baselines** workflow from
the Actions page for that ref to produce the same artifact.

## WebKit: Specs That Opt In

WebKit is the engine of Safari and iOS, of the macOS desktop app (WKWebView) and of the Linux
desktop app (WebKitGTK). The rest of the suite runs in Chromium only, and much of it encodes
Chromium-measured geometry, so WebKit runs just the specs listed in `WEBKIT_SPECS` in
`playwright.webkit.config.ts`:

- `number-fields.spec.ts`: the 96px number fields keep their values whole beside their units, with
  no spin buttons (#3185). WebKit draws its own spin buttons and keeps room for them, and with the
  `appearance: textfield` and spin-button rules removed, three of the five tests fail in WebKit.

CI runs them in the **WebKit End-to-End Tests** job, beside the Chromium shards rather than inside
one, so they add nothing to the browser job's budget. That job is part of the required check: a
WebKit result nobody has to read would let a Safari regression land on a green build.

To opt a spec in, add it to `WEBKIT_SPECS` and to the list above, and run it in WebKit first. Run
them locally from the repository root:

```bash
pnpm exec playwright install --with-deps webkit   # once; the system packages need sudo
pnpm test:e2e:webkit
```

WebKit needs system libraries (libevent, libavif, libjxl and others) that a desktop Ubuntu often
lacks. Without sudo, run the same command in Playwright's image, matching its tag to the pinned
`@playwright/test` version:

```bash
docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp/home \
  -e COREPACK_HOME=/tmp/corepack -e npm_config_store_dir=/tmp/pnpm-store -e CHOKIDAR_USEPOLLING=1 \
  -v "$PWD:$PWD" -w "$PWD" \
  mcr.microsoft.com/playwright:v<version>-jammy bash -c \
  'mkdir -p /tmp/home /tmp/bin && corepack enable --install-directory /tmp/bin &&
   PATH=/tmp/bin:$PATH pnpm exec playwright test --config playwright.webkit.config.ts'
```

The store directory keeps the container's pnpm from creating a `.pnpm-store` in the checkout.

The WebKit config reuses the development server's port, so it cannot run at the same time as
`pnpm test:e2e` in the same worktree.

### Check Safari by Hand

Playwright's Linux WebKit does not draw macOS native form controls or use macOS fonts. After a
change to the number fields' CSS, check them in macOS Safari or the macOS desktop app too. Run
`pnpm --dir apps/web exec vite`, open `settings-rows-e2e.html?view=numbers` (add `&theme=dark` for
the dark theme), and confirm that every value is whole beside its unit and that no field shows spin
buttons. Then focus a field, type `99999`, and confirm it stays whole while focused and hovered.

## Other Conventions

- **Each worktree serves the suite on its own port.** `playwright.ports.ts` chooses it. In a
  Wollipog-managed worktree, `playwright.config.ts` uses `WOLLIPOG_PORT_BLOCK_START` and
  `playwright.production.config.ts` the next port, so worktrees with their own port blocks run the
  suites at the same time. A malformed block, or one smaller than two ports, fails rather than
  falling back. Without a block, as in CI and plain checkouts, the ports are `127.0.0.1:4174` and
  `127.0.0.1:4175`, so two plain checkouts still cannot run the same suite at once. The server is
  started with `--strictPort` and never reused, so a port already in use fails the run. Wait for
  the other run rather than killing its server.
- **The list is virtualized.** A card only has a box while it is mounted, so a spec that measures
  every row needs a viewport tall enough to mount them all, and should assert the expected count
  first so a failure names the real cause.
