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
const stateSource = readFileSync(fileURLToPath(new URL("./components/State.tsx", import.meta.url)), "utf8");

/** The type scale, in px, so a rule can be compared against the ramp rather than against a number. */
const SCALE: Record<string, number> = {
  "--text-xs": 11, "--text-sm": 12, "--text-base": 13,
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

test("the page header's title is the page's one largest heading", () => {
  // #1801: destinations draw their title in the page header, at --type-page-title (20/28, 600), and
  // the detail bar's entity title at --type-title (16/24). §2.3's hierarchy check: on any screen the
  // page title is the largest text.
  const font = (selector: string) => declarationsOf(css, "font")
    .find(({ selector: found }) => found.replace(/\s+/g, " ").trim() === selector)?.value.trim();
  assert.equal(font(".page-title"), "var(--type-page-title)");
  assert.equal(font(".detail-bar-title"), "var(--type-title)");
  assert.match(css, /--type-page-title: 600 var\(--text-xl\)\/28px var\(--font-ui\);/);
  const largestBody = Math.max(...["--text-lg", "--text-md", "--text-base"].map((token) => SCALE[token]!));
  assert.ok(SCALE["--text-xl"]! > largestBody, "the page title sits above every body and title size");
});

test("the page title is larger than the labels inside the page", () => {
  // The top bar's title remains on the phone Session route and the instance recovery screen.
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
 * Every `<State` call site in the app, with the props and children it actually passes.
 *
 * Scanned at brace depth ZERO rather than with a lazy `/>` match: an `icon={<RunsIcon />}` prop
 * contains its own `/>`, and a lazy match stops there, truncating the props before `actions=`. A
 * state with children runs to its `</State>`, so a hint written as children counts as content.
 */
function stateCallSites(): { file: string; props: string }[] {
  const dir = fileURLToPath(new URL("./components/", import.meta.url));
  const sites: { file: string; props: string }[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".tsx") || entry.endsWith(".test.tsx")) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    let index = source.search(/<State[\s>]/);
    while (index !== -1) {
      let depth = 0;
      let cursor = index + "<State".length;
      const from = cursor;
      let selfClosing = false;
      while (cursor < source.length) {
        const character = source[cursor]!;
        if (character === "{") depth += 1;
        else if (character === "}") depth -= 1;
        else if (depth === 0 && character === "/" && source[cursor + 1] === ">") { selfClosing = true; break; }
        else if (depth === 0 && character === ">") break;
        cursor += 1;
      }
      const end = selfClosing ? cursor : source.indexOf("</State>", cursor);
      sites.push({ file: entry, props: source.slice(from, end) });
      const next = source.slice(end).search(/<State[\s>]/);
      index = next === -1 ? -1 : end + next;
    }
  }
  return sites;
}

/**
 * TERMINAL states only. A loading, offline, error or no-results state is a transient answer rather
 * than an empty screen, and decorating it would be claiming the app has nothing when it simply does
 * not know yet. `State` names those with its `variant`, and a variant computed from a placeholder is
 * transient too.
 */
const transient = (props: string) => /variant=/.test(props);

test("the empty states a user actually sees have an icon", () => {
  // The first version of this checked that the PROPS EXIST on the component. They did, and not one
  // of the nine callers passed either — so the §F8 requirement was unmet in everything a user sees
  // while the test reported it done. Testing an API instead of its callers is the same shape as
  // every other finding on this campaign.
  const sites = stateCallSites();
  assert.ok(sites.length >= 8, `expected the app to render several states, found ${sites.length}`);
  const terminal = sites.filter((site) => !transient(site.props));
  assert.ok(terminal.length >= 4, `expected several terminal empty states, found ${terminal.length}`);
  // Panel states (compact, §21.4) are one line inside a card and carry no icon tile.
  const withoutIcon = terminal.filter((site) => !/\bcompact\b/.test(site.props) && !/icon=/.test(site.props))
    .map((site) => site.file);
  assert.deepEqual([...new Set(withoutIcon)], [],
    "an empty screen with no icon is the 2015 pattern §F8 asked to replace");
});

test("the session activity placeholder names the unpaired state in Title Case", () => {
  const activity = stateCallSites().filter((site) => site.file === "SessionDetail.tsx" && /Activity Unavailable/.test(site.props));
  assert.equal(activity.length, 1);
  assert.match(activity[0]!.props, /"Pair to Load Activity"/);
});

test("the empty states a user actually sees offer the action that ends them", () => {
  // §F8 asks for "icon + title + hint + primary action", and round one shipped the SLOT for an
  // action with no caller passing one. An empty screen is the one moment the app knows exactly what
  // the user should do next; a screen that names the absence and then makes you find the button
  // elsewhere has described the problem and kept the solution.
  const terminal = stateCallSites().filter((site) => !transient(site.props) && !/\bcompact\b/.test(site.props));
  const withoutAction = terminal.filter((site) => !/actions=/.test(site.props)).map((site) => site.file);
  assert.deepEqual([...new Set(withoutAction)], [],
    "a terminal empty state has to offer the thing that ends it");
});

test("no screen hand-rolls an empty state", () => {
  // AutomationsView rendered a bare `.empty-state` div with an h3 and a p, so it inherited none of
  // this and could not be fixed by changing the shared component.
  const dir = fileURLToPath(new URL("./components/", import.meta.url));
  const offenders = readdirSync(dir)
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .filter((entry) => /className="(empty|empty-state)"/.test(readFileSync(join(dir, entry), "utf8")));
  assert.deepEqual(offenders, [], "an empty state that bypasses State cannot be improved by State");
});

test("the empty state offers a way out of itself", () => {
  // §F8 called it a 2015 pattern: a dashed border, 54px of padding, no icon and no action. An empty
  // screen is the one moment the app knows exactly what the user should do next.
  assert.match(stateSource, /icon\?: ReactNode;/, "an empty state needs somewhere to put an icon");
  assert.match(stateSource, /actions\?: ReactNode;/, "and somewhere to put the action that ends it");
  assert.match(stateSource, /className="actions"/);
  // docs/design-system.md §12: top-aligned with the content's edge and no bordered card at all.
  const border = declarationsOf(css, "border").find(({ selector }) => /(^|[\s,])\.state(\s|,|$)/.test(selector));
  assert.equal(border, undefined, "a state is not a bordered card");
});
