import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXTRA_PALETTE_DESTINATIONS, GLOBAL_VIEW_ITEMS, SETTINGS_SECTIONS, viewFromPath, viewPath, viewTitle } from "./navigation.js";

/**
 * Settings as a route.
 *
 * §11.3's argument was that a dialog cannot be linked to, cannot be opened in a second tab, and
 * loses its place on every breakpoint crossing. The last one was not theoretical: `App` had to
 * hoist the dialog's open state out of both responsive layouts and hand focus back by hand after a
 * crossing, because Modal's captured return-focus element was disconnected by then. A route needs
 * none of that, and the tests that matter here are about the ROUTE existing in both directions.
 */

const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");

test("every section round-trips through the URL", () => {
  for (const { id } of SETTINGS_SECTIONS) {
    const path = viewPath({ name: "settings", section: id });
    assert.equal(path, `/settings/${id}`);
    // The point of the route is that a link to a section lands on that section. A round trip that
    // silently falls back to Appearance would make "see Settings → Network" wrong.
    assert.deepEqual(viewFromPath(path), { name: "settings", section: id });
  }
});

test("/settings alone is a section, not a dead route", () => {
  assert.deepEqual(viewFromPath("/settings"), { name: "settings", section: "appearance" });
  assert.equal(viewPath({ name: "settings" }), "/settings/appearance");
});

test("an unknown section is not a settings route at all", () => {
  // Falling back to Appearance for /settings/nonsense would make a typo look like a working link.
  assert.notDeepEqual(viewFromPath("/settings/nonsense"), { name: "settings", section: "appearance" });
});

test("the dialog and the state that existed only to survive a breakpoint crossing are gone", () => {
  assert.doesNotMatch(app, /SettingsDialog/,
    "the dialog is replaced by the route, not kept alongside it");
  // `settingsOpen` was hoisted to the shell purely so an OPEN dialog could survive 760px. A route
  // survives it because it is the URL, so the state and its focus-restoration workaround go too.
  assert.doesNotMatch(app, /settingsOpen/,
    "the hoisted open-state exists only for a dialog");
});

test("the trigger navigates and marks itself current", () => {
  assert.match(app, /onOpen=\{\(\) => navigate\(\{ name: "settings" \}\)\}/,
    "the gear is a destination now, not a dialog opener");
  assert.match(app, /active=\{view\.name === "settings"\}/,
    "a destination that is current has to say so; the rail's other items already do");
  assert.doesNotMatch(app, /aria-haspopup="dialog"/,
    "aria-haspopup='dialog' promises a dialog and this opens a page");
});

test("the production shell routes both Settings-owned key paths through the shared handler", () => {
  assert.equal((app.match(/handleSettingsNavigationKey\(e, \{/g) ?? []).length, 2,
    "one non-Escape path and one post-backdrop Escape path must use the tested handler");
  const ladderStart = app.indexOf("const onKey = (e: KeyboardEvent)");
  const ladderEnd = app.indexOf('window.addEventListener("keydown", onKey)');
  assert.ok(ladderStart >= 0 && ladderEnd > ladderStart, "the production key ladder must be present");
  const escapeLadder = app.slice(ladderStart, ladderEnd);
  assert.ok(escapeLadder.indexOf("pickTopmost(backdrops") < escapeLadder.lastIndexOf("handleSettingsNavigationKey(e"),
    "the real Shell must dismiss its topmost backdrop before Settings handles Escape");
});

test("the shortcut reference is no longer a dialog inside a dialog", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // The dialog version had to CLOSE itself to open the reference, because a focus trap inside a
  // focus trap does not work. From a page it simply opens.
  assert.match(view, /onOpenShortcuts/);
  assert.doesNotMatch(view, /setOpen\(false\)/,
    "opening the reference should not require dismissing anything");
});

test("every view has a title of its own", () => {
  // The old chain named four views and fell through to "Run", so Settings — added later — put
  // `<h1>Run</h1>` above all six of its routes. An exhaustive switch cannot do that silently: the
  // failure moves from a wrong title at runtime to a type error at the switch.
  assert.equal(viewTitle({ name: "settings" }), "Settings");
  assert.equal(viewTitle({ name: "settings", section: "network" }), "Settings");
  assert.notEqual(viewTitle({ name: "settings" }), "Run");
  for (const item of GLOBAL_VIEW_ITEMS) {
    assert.equal(viewTitle({ name: item.name } as never), item.title,
      "the rail, the palette and the heading must read one list");
  }
  assert.doesNotMatch(app, /GLOBAL_VIEW_ITEMS\.find/,
    "the header must not re-derive the title chain it got wrong");
});

test("the palette can reach Settings", () => {
  // The palette derived its whole fixed list from GLOBAL_VIEW_ITEMS, which excludes Settings
  // because the rail renders a dedicated gear instead of a row — so Ctrl+K could not reach the one
  // destination a keyboard user is most likely to search for.
  const labels = EXTRA_PALETTE_DESTINATIONS.map((entry) => entry.label);
  assert.ok(labels.includes("Settings"), "the palette needs a plain Settings destination");
  for (const section of SETTINGS_SECTIONS) {
    assert.ok(labels.includes(`Settings — ${section.title}`), `${section.title} must be searchable`);
  }
  // And not by adding it to the rail's list, which would render a second Settings item beside the
  // gear.
  assert.ok(!GLOBAL_VIEW_ITEMS.some((item) => (item.name as string) === "settings"),
    "Settings is a gear, not a rail row");
});

test("a crash in one section does not follow the user to the next", () => {
  // The reset key was the view NAME, and every settings route shares it, so a panel that threw left
  // the fallback mounted over Appearance and About as well.
  assert.match(app, /resetKey=\{viewPath\(view\)\}/,
    "the boundary has to reset on the thing that changes when the user navigates");
});

test("focus is rescued when a layout swap drops it", () => {
  // Crossing 760px unmounts the breakpoint-specific gear. A keyboard user standing on it is left on
  // <body>, and the next Tab restarts at the top of the document.
  assert.match(app, /rescueFocusTo\(document\.getElementById\("page-title"\)\);\s*\}, \[isMobile\]\)/,
    "the crossing itself is the event; nothing else fires when the layout swaps");
  assert.match(app, /id="page-title" tabIndex=\{-1\}/,
    "the rescue target has to be focusable, and the heading is what names where the user now is");
  // Conditional, so it never steals focus from a live element — clicking a section link must leave
  // focus on the link.
  assert.match(app, /if \(active && active !== document\.body && \(active as HTMLElement\)\.isConnected\) return;/,
    "a rescue that fires unconditionally is a focus thief");
});

test("the shortcut reference always has somewhere to return focus", () => {
  // Opened from the Settings Keyboard row, then Back while it is still open: the row is gone and a
  // selector that only knew about the gear resolved to null, dropping focus on <body>.
  assert.match(app, /\.settings-view \.ui-row-nav/, "the Settings opener needs its own fallback");
  assert.match(app, /\(reresolved \?\? document\.getElementById\("page-title"\)\)\?\.focus\(\)/,
    "and a last resort that exists on every page");
});

test("the section panel takes focus only when the panel that had it is gone", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // Back/Forward swaps `panels[current.id]`; a focused control inside the outgoing panel is
  // detached by the swap.
  assert.match(view, /\}, \[section\]\)/, "the handoff runs on a section change, not on every render");
  assert.match(view, /ref=\{headingRef\} tabIndex=\{-1\}/, "the heading is the target");
  assert.match(view, /if \(active && active !== document\.body && \(active as HTMLElement\)\.isConnected\) return;/,
    "link-driven navigation must keep focus on the link");
});

test("the settings sections name the things the plan says stay discoverable", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // §11.3: never hide a setting that could exist. A missing section teaches a user it is not
  // possible; a disabled one with a sentence teaches them where it lives.
  for (const named of [
    "Default Models, Efforts, and Permissions",
    "Control-Plane Origin",
    "Manage Instances",
    "Updates",
    "Open-Source Licenses",
  ]) {
    // The exact title, not a substring of one: checking `includes("Updates")` passed against a row
    // renamed "Updates-REMOVED", which is the mutation that found this.
    assert.ok(view.includes(`title="${named}"`), `${named} is named in the plan and must appear as a setting`);
  }
  // Every one of them carries a reason, which is the half that makes a disabled row informative
  // rather than a dead end.
  const pending = view.match(/<PendingSetting[\s\S]*?\/>/g) ?? [];
  assert.ok(pending.length >= 8, "the named-but-unbuilt settings must all be rendered");
  for (const block of pending) {
    assert.match(block, /reason=/, "a disabled setting without a reason is worse than none");
  }
});

test("the Network panel does not report four situations as one", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // `status === null` covered loading, browser/PWA, absent Tailscale, and a failed read, and all
  // four rendered "Tailscale is not installed or not detected" — two of which are false statements
  // about the user's machine.
  assert.match(view, /tailnet\.loading/, "still reading is not the same as not installed");
  assert.match(view, /!tailnet\.desktop/, "a browser is not a machine without Tailscale");
  assert.match(view, /tailnet\.error/, "a failed read has to be shown, not swallowed");
});

test("the tailnet state is owned by the shell, not by the panel", () => {
  // Mounted inside the panel, the hook re-read on every visit: a toggle started before navigating
  // away completed against the discarded instance, and returning showed the pre-write value.
  assert.match(app, /const tailnet = useTailnetAccessSetting\(\);/);
  assert.match(app, /network: <NetworkPanel tailnet=\{tailnet\} \/>/,
    "the panel renders the shell's state rather than fetching its own");
});

test("the focus rescues fire on a transition, not on arrival", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // A fresh load leaves focus on <body> legitimately — nothing was dropped — and rescuing there put
  // the first Tab after the heading, skipping the whole rail and all six section links. A ref
  // seeded with the CURRENT value rather than a mount flag, because Strict Mode double-invokes
  // effects and a flag would be spent before the first real transition.
  assert.match(app, /const previousLayout = useRef\(isMobile\);[\s\S]{0,200}if \(previousLayout\.current === isMobile\) return;/,
    "only a breakpoint CROSSING drops focus; arriving at a page does not");
  assert.match(view, /const previousSection = useRef\(section\);[\s\S]{0,200}if \(previousSection\.current === section\) return;/,
    "only a section CHANGE replaces the panel that held focus");
});

test("Network keeps its other settings when the tailnet is unavailable", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // The early return took the whole group with it, so the discoverability rule this panel had just
  // been fixed to satisfy held only where Tailscale happened to be installed — never, in a browser.
  const panel = view.slice(view.indexOf("export function NetworkPanel"), view.indexOf("export function AboutPanel"));
  // ONE exit, so there is no second path that can omit a row. Pattern-matching the old early
  // return instead let a one-line `if (...) return <SettingsGroup>…` walk straight past the check —
  // the mutation that found this — because the pattern was a spelling and not the property.
  const code = panel.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
  assert.equal((code.match(/\breturn\b/g) ?? []).length, 1,
    "a second return is a second topology, and one of them will forget a row");
  assert.match(panel, /const tailnetRow = status\?\.available \? \(/,
    "the conditional belongs to the row that depends on the tailnet");
  for (const title of ["Control-Plane Origin", "Manage Instances"]) {
    assert.ok(panel.slice(panel.indexOf("return (")).includes(`title="${title}"`),
      `${title} must render on every path, not only the available one`);
  }
});

test("a tailnet write is announced as busy", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // Folding busy into `disabled` left the row generically unavailable while its own description
  // said the control plane was restarting. SwitchRow disables a busy control itself and keeps
  // showing the value the server last confirmed.
  assert.match(view, /busy=\{tailnet\.busy\}/, "a write in flight has to say so");
  assert.match(view, /disabled=\{!status\.managed\}/,
    "disabled means cannot be operated at all, which is a different fact from mid-write");
});

test("the browser case is decided before the loading case", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  // In a browser the answer is known synchronously, so a first paint claiming a check was running
  // described a check that runtime cannot perform.
  // Comments stripped first: the explanation above the row quotes the very sentence this slice
  // looks for, so `indexOf` found the comment and the region came out empty — and an empty region
  // makes every ordering assertion vacuously false, which is how this test first failed.
  const code = view.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*/g, " ");
  const reason = code.slice(code.indexOf("reason={!tailnet.desktop"), code.indexOf("reason={!tailnet.desktop") + 400);
  assert.ok(reason.includes("tailnet.loading"), "the loading branch must still exist");
  assert.ok(reason.indexOf("!tailnet.desktop") < reason.indexOf("tailnet.loading"),
    "a runtime that cannot check is not a runtime still checking");
});

test("both callers mount the same notifications panel", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  const fixture = readFileSync(fileURLToPath(new URL("./e2e/settings-rows-main.tsx", import.meta.url)), "utf8");
  // The fixture copied two SwitchRows that looked like these rows. A copy is a second description
  // of the topology, which is the drift the harness rebuild existed to remove — one level down.
  assert.match(view, /export function NotifyRow\(\{ notify \}: \{ notify: NotifySetting \}\)/,
    "the notifier singleton has to be injectable for the fixture to mount the real row");
  assert.match(fixture, /<NotificationsPanel/, "the fixture must mount the production panel");
  assert.doesNotMatch(fixture, /<SwitchRow/, "and must not hand-roll rows that look like its rows");
  assert.match(app, /<NotificationsPanel notify=\{notify\} push=\{push\} \/>/,
    "the shell supplies the live state to the same component");
});

test("a setting nobody can change is an explanation, not an off switch", () => {
  const view = readFileSync(fileURLToPath(new URL("./components/SettingsView.tsx", import.meta.url)), "utf8");
  const rows = readFileSync(fileURLToPath(new URL("./components/ui/SettingsRows.tsx", import.meta.url)), "utf8");
  // A disabled SwitchRow announces `aria-checked="false"`, which CLAIMS the setting is off. For the
  // tailnet that claim was made precisely when the value could not be read — a network-exposure
  // setting reported as off while its own text said the state was unknown.
  const pending = view.slice(view.indexOf("export function PendingSetting"));
  assert.doesNotMatch(pending.slice(0, 500), /SwitchRow/,
    "an unknown or unbuilt setting must not paint or announce a value it does not have");
  assert.match(pending.slice(0, 500), /<StaticRow/, "it states something instead");
  const staticRow = rows.slice(rows.indexOf("export function StaticRow"), rows.indexOf("export function NavRow"));
  assert.doesNotMatch(staticRow, /role=|aria-checked/,
    "there is nothing to operate, so there is no role to announce");
});

test("a view change rescues focus too", () => {
  // Back out of Settings unmounts the whole view with the focused control inside it. The section
  // effect cannot run — its component is gone — and `isMobile` has not changed, so neither of the
  // round-two rescues fires. A view transition is its own event.
  assert.match(app, /const path = viewPath\(view\);\s*const previousPath = useRef\(path\);/,
    "the canonical path is what changes when a view transition removes the focused element");
  assert.match(app, /if \(previousPath\.current === path\) return;[\s\S]{0,120}\}, \[path\]\)/,
    "and only a real change counts, for the same reason the other two rescues are gated");
});

test("a modal opened before a breakpoint crossing still returns focus somewhere", () => {
  const common = readFileSync(fileURLToPath(new URL("./components/common.tsx", import.meta.url)), "utf8");
  // Focus was live INSIDE the dialog the whole time, so the layout rescue correctly declined to
  // move it — and by the time the dialog closes, `isMobile` has settled and will not fire again.
  // The captured opener is gone with the layout that held it — or connected but unfocusable
  // (disabled by the action's busy state), which the restore must verify rather than assume
  // (regression coverage). Either way the page-title fallback keeps focus off <body>.
  assert.match(common, /target\.focus\(\);[\s\S]{0,220}if \(document\.activeElement === target\) return;/,
    "a restore to a connected target must be verified, not assumed");
  assert.match(common, /if \(modalLayerStack\.length === 0\) \{\s*document\.getElementById\("page-title"\)\?\.focus\(\);/,
    "a dialog that cannot restore to its opener must still leave focus on the page");
});
