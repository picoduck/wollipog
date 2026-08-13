import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarationsOf } from "./css-rules.js";

/**
 * Phase 8's hierarchy half — §F8's "nothing is clearly primary".
 *
 * Two of §F8's four findings are shape rather than colour: the page title was smaller than body
 * labels elsewhere, and the empty state was a dashed box with no way out of it. Both are the same
 * defect seen twice — the app not distinguishing what matters from what surrounds it.
 */

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const common = readFileSync(fileURLToPath(new URL("./components/common.tsx", import.meta.url)), "utf8");

/** The type scale, in px, so a rule can be compared against the ramp rather than against a number. */
const SCALE: Record<string, number> = {
  "--text-2xs": 10, "--text-xs": 11, "--text-sm": 12, "--text-base": 13,
  "--text-md": 14, "--text-lg": 17, "--text-xl": 20, "--text-2xl": 24,
};

function sizeOf(selector: string): number | null {
  for (const { selector: found, value } of declarationsOf(css, "font-size")) {
    if (found.replace(/\s+/g, " ").trim() !== selector) continue;
    const token = /var\((--text-[\w-]+)\)/.exec(value)?.[1];
    if (token) return SCALE[token] ?? null;
    const px = /^([\d.]+)px$/.exec(value.trim());
    if (px) return Number(px[1]);
  }
  return null;
}

test("the page title is larger than the labels inside the page", () => {
  const title = sizeOf(".topbar h1");
  assert.ok(title, "the page title must declare a size");
  // §F8 measured it at 15px against body labels of 14px and a de-facto default of 12.5px — the
  // hierarchy inverted at its top, where it matters most. Compared against the RAMP rather than a
  // literal, so promoting it again does not mean editing a number here too.
  assert.ok(title >= SCALE["--text-lg"]!,
    `the page title is ${title}px; it has to sit above the body ramp, not inside it`);
  assert.ok(title > SCALE["--text-md"]!, "and strictly above the body size");
});

/**
 * Every `<Empty` call site in the app, with the props it actually passes.
 *
 * Scanned at brace depth ZERO rather than with a lazy `/>` match. Once the icons landed, every call
 * site contained `icon={<RunsIcon size={28} />}` — and a lazy match stops at THAT `/>`, truncating
 * the props before `action=` and reporting every caller as actionless. The test failed rather than
 * passing, which is the only reason this was a two-minute fix instead of a wrong green.
 */
function emptyCallSites(): { file: string; props: string }[] {
  const dir = fileURLToPath(new URL("./components/", import.meta.url));
  const sites: { file: string; props: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    let index = source.indexOf("<Empty");
    while (index !== -1) {
      let depth = 0;
      let cursor = index + "<Empty".length;
      const from = cursor;
      while (cursor < source.length) {
        const character = source[cursor]!;
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (depth === 0 && character === "/" && source[cursor + 1] === ">") break;
        cursor += 1;
      }
      sites.push({ file: entry, props: source.slice(from, cursor) });
      index = source.indexOf("<Empty", cursor);
    }
  }
  return sites;
}

test("the empty states a user actually sees have an icon", () => {
  // The first version of this checked that the PROPS EXIST on the component. They did, and not one
  // of the nine callers passed either — so the §F8 requirement was unmet in everything a user sees
  // while the test reported it done. Testing an API instead of its callers is the same shape as
  // every other finding on this campaign.
  const sites = emptyCallSites();
  assert.ok(sites.length >= 8, `expected the app to render several empty states, found ${sites.length}`);
  // TERMINAL states only. A loading, waiting or unavailable placeholder is a transient message
  // rather than an empty screen, and decorating it would be claiming the app has nothing when it
  // simply does not know yet. Those are recognised by their content, not exempted by file: they
  // render a `detailPlaceholder` result or a connection-dependent message.
  const transient = (props: string) => /placeholder\.|Unavailable|Waiting|Pair to load/.test(props);
  const terminal = sites.filter((site) => !transient(site.props));
  assert.ok(terminal.length >= 4, `expected several terminal empty states, found ${terminal.length}`);
  const withoutIcon = terminal.filter((site) => !/icon=/.test(site.props)).map((site) => site.file);
  assert.deepEqual([...new Set(withoutIcon)], [],
    "an empty screen with no icon is the 2015 pattern §F8 asked to replace");
});

test("the empty states a user actually sees offer the action that ends them", () => {
  // §F8 asks for "icon + title + hint + primary action", and round one shipped the SLOT for an
  // action with no caller passing one. An empty screen is the one moment the app knows exactly what
  // the user should do next; a screen that names the absence and then makes you find the button
  // elsewhere has described the problem and kept the solution.
  //
  // Board, Runs and Pods open their dialogs from the shell, so each takes one callback rather than
  // reaching for it — that plumbing is the reason this was a separate commit from the icons.
  const terminal = emptyCallSites().filter((site) =>
    !/placeholder\.|Unavailable|Waiting|Pair to load/.test(site.props));
  const withoutAction = terminal.filter((site) => !/action=/.test(site.props)).map((site) => site.file);
  assert.deepEqual([...new Set(withoutAction)], [],
    "a terminal empty state has to offer the thing that ends it");
});

test("no screen hand-rolls an empty state", () => {
  // AutomationsView rendered a bare `.empty-state` div with an h3 and a p, so it inherited none of
  // this and could not be fixed by changing `Empty`.
  const dir = fileURLToPath(new URL("./components/", import.meta.url));
  const offenders = readdirSync(dir)
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .filter((entry) => /className="empty-state"/.test(readFileSync(join(dir, entry), "utf8")));
  assert.deepEqual(offenders, [], "an empty state that bypasses Empty cannot be improved by Empty");
});

test("the empty state offers a way out of itself", () => {
  // §F8 called it a 2015 pattern: a dashed border, 54px of padding, no icon and no action. An empty
  // screen is the one moment the app knows exactly what the user should do next.
  assert.match(common, /icon\?: ReactNode;/, "an empty state needs somewhere to put an icon");
  assert.match(common, /action\?: ReactNode;/, "and somewhere to put the action that ends it");
  assert.match(common, /className="empty-action"/);
  // Both optional, deliberately: every existing caller passes neither, so this is additive rather
  // than a demand that eight screens invent an action inside a styling change.
  assert.match(common, /icon\?:/, "the slots must be optional or this is not additive");

  const border = declarationsOf(css, "border").find(({ selector }) => selector.includes(".empty"));
  assert.ok(border, "the empty state must declare a border");
  assert.doesNotMatch(border!.value, /dashed/,
    "a dashed box reads as a placeholder waiting to be filled rather than as part of the app");
});
