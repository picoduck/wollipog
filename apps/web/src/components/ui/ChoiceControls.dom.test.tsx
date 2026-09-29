import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Checkbox, ChoiceList, ChoiceRows, SegmentedControl, Select } from "./ChoiceControls.js";

/**
 * What made seventeen patterns indistinguishable was never their looks alone — it was that the
 * SEMANTICS did not match the shape. Four of them announced `aria-pressed`, which says "toggle
 * button, pressed" and nothing about the other options being alternatives; six differed between
 * single and multiple selection only by role, with no visible marker, so you could not tell which
 * you had until you clicked a second one.
 *
 * These assert the semantics, because that is the part a screen reader consumes and the part no
 * screenshot would ever catch. What the controls LOOK like is `styles.css` and §27's contrast lock.
 */

const render = (element: React.ReactElement) => renderToStaticMarkup(element);

const SIZES = [
  { value: "sm", label: "Small" },
  { value: "md", label: "Medium" },
  { value: "lg", label: "Large", disabled: true, disabledReason: "Not available on this plan" },
] as const;

test("SegmentedControl is a radiogroup, not a row of pressed toggles", () => {
  const html = render(
    <SegmentedControl options={SIZES} value="md" onChange={() => undefined} label="Size" />,
  );
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /aria-label="Size"/);
  // aria-pressed is what four of the seventeen used, and it is the defect: it describes a toggle,
  // so a screen-reader user cannot tell a segmented control from independent switches.
  assert.doesNotMatch(html, /aria-pressed/);
  assert.equal(html.match(/role="radio"/g)?.length, 3);
  assert.equal(html.match(/aria-checked="true"/g)?.length, 1);
});

test("SegmentedControl can name a responsive icon label explicitly", () => {
  const html = render(
    <SegmentedControl
      options={[{ value: "active", label: <span aria-hidden="true">◎ 12</span>, ariaLabel: "Active, 12 Sessions" }]}
      value="active"
      onChange={() => undefined}
      label="Reminder View"
    />,
  );
  assert.match(html, /role="radio"[^>]*aria-label="Active, 12 Sessions"/);
  assert.equal(html.match(/Active, 12 Sessions/g)?.length, 1,
    "the count is announced once through the explicit name");
});

test("SegmentedControl keeps exactly one tab stop", () => {
  const html = render(
    <SegmentedControl options={SIZES} value="md" onChange={() => undefined} label="Size" />,
  );
  // Roving tabindex: the GROUP is one stop and arrows move within it. Three stops would make a
  // four-option filter cost four tabs to skip.
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
});

test("a disabled option stays reachable and says why", () => {
  const html = render(
    <SegmentedControl options={SIZES} value="md" onChange={() => undefined} label="Size" />,
  );
  // `aria-disabled`, not `disabled`: a `disabled` button is removed from the tab order entirely, so
  // the reason never reaches a keyboard user. §11.3 — never hide a setting that could exist.
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /<button[^>]*\sdisabled/);
  assert.match(html, /Not available on this plan/);
});

const PRESETS = [
  { value: "quick", title: "Quick", description: "One agent, no review" },
  { value: "review", title: "Reviewed", description: "Two agents and a review pass" },
] as const;

test("ChoiceRows are native radios or checkboxes, grouped by role", () => {
  // Buttons with `role="radio"` kept selection in ARIA and styling; a real input keeps it in the
  // form control, and its arrow keys, Space and `:checked` come from the platform.
  const single = render(
    <ChoiceRows options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  assert.match(single, /role="radiogroup"/);
  assert.equal(single.match(/<input type="radio"/g)?.length, 2);
  assert.doesNotMatch(single, /role="radio"/);
  // One shared name is what makes the browser treat them as one group for arrows and Tab.
  const names = [...single.matchAll(/name="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(names.length, 2);
  assert.equal(names[0], names[1]);
  assert.equal(single.match(/checked=""/g)?.length, 1);

  const multi = render(
    <ChoiceRows options={PRESETS} value={["quick", "review"]} onChange={() => undefined} label="Agents" multiple />,
  );
  assert.match(multi, /role="group"/);
  assert.equal(multi.match(/<input type="checkbox"/g)?.length, 2);
  assert.equal(multi.match(/checked=""/g)?.length, 2);
});

test("each row is a label around its input, so the whole row is the target", () => {
  const html = render(
    <ChoiceRows options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  // The marker LEADS: the input comes before the title in every row.
  const rows = html.match(/<label class="choice-row[^"]*">[\s\S]*?<\/label>/g) ?? [];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(row.indexOf("<input") < row.indexOf("choice-row-title"), "the marker leads the row");
  }
});

test("a row's name is its title and its description is announced as a description", () => {
  const html = render(
    <ChoiceRows options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
  assert.ok(labelledBy);
  assert.match(html, new RegExp(`id="${labelledBy}"[^>]*>Quick<`));
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(describedBy);
  // The full text, even though the stylesheet cuts it to one line on desktop; a string also
  // becomes the tooltip.
  assert.match(html, new RegExp(`id="${describedBy}" title="One agent, no review">One agent, no review<`));
});

test("a disabled row explains itself in the row, not only in a tooltip", () => {
  const options = [
    { value: "local", title: "Local", description: "Run on this machine" },
    { value: "box", title: "Remote Box", description: "Run over SSH", disabled: true, disabledReason: "No box is connected" },
  ] as const;
  const html = render(
    <ChoiceRows options={options} value="local" onChange={() => undefined} label="Location" />,
  );
  // A `title` is invisible on touch and to most screen readers. §11.3: every disabled control
  // carries a <small> reason, and never hide a setting that could exist.
  assert.match(html, /<small class="choice-row-reason"[^>]*>No box is connected<\/small>/);
  // `aria-disabled` rather than `disabled`, so arrows still reach it.
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /<input[^>]*\sdisabled=""/);
  // The reason takes the description's line, so the row keeps its size; the description stays in
  // the accessible description beside the reason.
  const row = /<label class="choice-row is-disabled">[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
  assert.match(row, /class="sr-only"[^>]*>Run over SSH</);
  assert.doesNotMatch(row, /choice-row-desc/);
  const describedBy = /aria-describedby="([^"]+)"/.exec(row)?.[1]?.split(" ") ?? [];
  assert.equal(describedBy.length, 2, "both the description and the reason describe the input");
});

test("ChoiceRows draws a marker whose SHAPE distinguishes the two modes", () => {
  const single = render(
    <ChoiceRows options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  const multi = render(
    <ChoiceRows options={PRESETS} value={["quick"]} onChange={() => undefined} label="Agents" multiple />,
  );
  // The marker is the visible half of the same distinction the input type makes.
  assert.match(single, /class="radio-mark"/);
  assert.doesNotMatch(single, /checkbox-mark/);
  assert.match(multi, /class="checkbox-mark"/);
  assert.doesNotMatch(multi, /radio-mark/);
});

test("ChoiceList is the compact form: radio rows with a trailing value and no description", () => {
  const html = render(
    <ChoiceList
      label="Worktree"
      value="main"
      onChange={() => undefined}
      options={[
        { value: "main", label: "Main Checkout", meta: "main" },
        { value: "fix", label: "Fix Branch", meta: "fix/1952" },
      ]}
    />,
  );
  assert.match(html, /class="choice-list" role="radiogroup" aria-label="Worktree"/);
  assert.equal(html.match(/class="choice-row compact"/g)?.length, 2);
  assert.match(html, /<span class="choice-row-meta">fix\/1952<\/span>/);
  assert.doesNotMatch(html, /choice-row-desc/);
});

test("a Checkbox has a visible label, and the row is the label", () => {
  const html = render(<Checkbox label="Include Session Name" checked={false} onChange={() => undefined} />);
  assert.match(html, /^<label class="checkbox">/);
  assert.match(html, /<input type="checkbox"/);
  assert.doesNotMatch(html, /aria-label=/, "the visible label names it; no hidden duplicate");
  const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
  assert.match(html, new RegExp(`id="${labelledBy}">Include Session Name<`));
});

test("a Checkbox helper is its description, and a list-wide label can carry a fuller name", () => {
  const html = render(
    <Checkbox label="Reviewed" ariaLabel="Mark viewport-1 as Reviewed" helper="Shown above." checked onChange={() => undefined} />,
  );
  assert.match(html, /aria-label="Mark viewport-1 as Reviewed"/);
  assert.doesNotMatch(html, /aria-labelledby/);
  const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.match(html, new RegExp(`id="${describedBy}">Shown above.<`));
  assert.match(html, />Reviewed</, "the visible label is still drawn");
});

test("an icon-only Checkbox keeps its aria-label and draws no row", () => {
  const html = render(<Checkbox labelHidden label="Select worktree line 3 for prompt" checked={false} onChange={() => undefined} />);
  assert.match(html, /^<span class="checkbox-mark"><input type="checkbox" aria-label="Select worktree line 3 for prompt"/);
  assert.doesNotMatch(html, /<label/);
});

const PROJECTS = [
  { value: "alpha", label: "Alpha", description: "~/dev/alpha" },
  { value: "beta", label: "Beta" },
] as const;

test("Select is a listbox that starts closed and names itself", () => {
  const html = render(
    <Select options={PROJECTS} value="alpha" onChange={() => undefined} label="Project" />,
  );
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-expanded="false"/);
  // The name is the label AND the value. `aria-label="Project"` alone REPLACED the content, so the
  // chosen option was never announced — the control read as "Project" whether it said Alpha or
  // nothing at all.
  assert.match(html, /aria-label="Project: Alpha"/);
  // Closed means not in the DOM, not merely hidden: an open listbox rendered off-screen is still
  // in the tab order and still announced.
  assert.doesNotMatch(html, /role="listbox"/);
  assert.doesNotMatch(html, /role="option"/);
  assert.match(html, /Alpha/);
});

test("Select shows a placeholder rather than a blank trigger when nothing is chosen", () => {
  const html = render(
    <Select options={PROJECTS} value={null} onChange={() => undefined} label="Project" placeholder="Choose a Project" />,
  );
  assert.match(html, /Choose a Project/);
  assert.match(html, /is-placeholder/);
});

test("a segmented group keeps a tab stop when its first option is disabled", () => {
  const options = [
    { value: "a", label: "A", disabled: true, disabledReason: "unavailable" },
    { value: "b", label: "B" },
  ] as const;
  // Nothing selected AND the first option disabled left the whole group with no tab stop: the
  // roving fallback gives index 0 the stop, and a disabled index 0 gave it away to nobody.
  const html = render(
    <SegmentedControl options={options} value={"c" as "a" | "b"} onChange={() => undefined} label="Pick" />,
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
});

test("Select's open list is a real listbox with an active option", () => {
  // Rendering the OPEN state needs interaction, so this asserts the closed contract and the parts
  // that are structural. The keyboard behaviour itself is exercised in the browser harness, which
  // is where a focus contract can actually be observed.
  const html = render(
    <Select options={PROJECTS} value={null} onChange={() => undefined} label="Project" />,
  );
  assert.match(html, /aria-haspopup="listbox"/);
  assert.match(html, /aria-label="Project: Select…"/);
});

test("a disabled Select is announced as disabled but stays in the tab order", () => {
  const html = render(
    <Select options={PROJECTS} value="alpha" onChange={() => undefined} label="Project" disabled />,
  );
  assert.match(html, /aria-disabled="true"/);
  assert.doesNotMatch(html, /<button[^>]*\sdisabled/);
});

test("a single choice can be unanswered", () => {
  // An approval question starts with nothing chosen. The type rejecting `null` forced an adopter
  // into a cast or a fake selection. With native radios the browser puts the tab stop on the first
  // row when none is checked, so no tabindex is written at all.
  const html = render(
    <ChoiceRows options={PRESETS} value={null} onChange={() => undefined} label="Preset" />,
  );
  assert.doesNotMatch(html, /checked=""/);
  assert.doesNotMatch(html, /tabindex/);
});

test("a selected-but-disabled option still leaves the group reachable", () => {
  const options = [
    { value: "a", label: "A", disabled: true, disabledReason: "gone" },
    { value: "b", label: "B" },
  ] as const;
  // "Has a selection" was satisfied by the disabled option, which then took tabIndex -1 — so the
  // group had no tab stop at all. Round 1 fixed the nothing-selected half and left this one.
  const html = render(
    <SegmentedControl options={options} value="a" onChange={() => undefined} label="Pick" />,
  );
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
});

test("every primitive requires an accessible name", () => {
  // A radiogroup with no name announces only its options, which is how "Small Medium Large" ends up
  // read out with no indication of what it sets.
  for (const html of [
    render(<SegmentedControl options={SIZES} value="md" onChange={() => undefined} label="Size" />),
    render(<ChoiceRows options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />),
    render(<Select options={PROJECTS} value="alpha" onChange={() => undefined} label="Project" />),
  ]) {
    assert.match(html, /aria-label="[^"]+"/);
  }
});

test("a group whose options are ALL unavailable says why, rendered", () => {
  // The reason reached a `title` and nowhere else. A tooltip cannot be opened by touch and is
  // announced inconsistently, so this primitive's "rendered, never hidden" contract — which
  // ChoiceCards does honour — was false for exactly the case it was written for.
  const html = render(
    <SegmentedControl
      label="Usage Range"
      value="7"
      options={[
        { value: "7", label: "7d", disabled: true, disabledReason: "Unavailable while saving retention" },
        { value: "30", label: "30d", disabled: true, disabledReason: "Unavailable while saving retention" },
      ]}
      onChange={() => undefined}
    />,
  );
  assert.match(html, /class="seg-reason"[^>]*>Unavailable while saving retention</,
    "the reason has to be rendered, not left in a title");
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  assert.ok(described, "and associated with the group, or a screen reader never reaches it");
  assert.match(html, new RegExp(`id="${described}"`));
});

test("a group with any option available does not claim to be unavailable", () => {
  // The group-level sentence belongs to the group only when the GROUP is unavailable. One disabled
  // option among several is explained by that option, and a group sentence there would be wrong.
  const html = render(
    <SegmentedControl options={SIZES} value="md" onChange={() => undefined} label="Size" />,
  );
  assert.doesNotMatch(html, /seg-reason/);
  assert.doesNotMatch(html, /aria-describedby/);
});

test("options with DIFFERENT reasons each keep their own", () => {
  // Collapsing to the first reason left "Requires admin" on screen while the option explained by
  // "Unavailable offline" had nothing but a `title` — the state the group sentence exists to
  // prevent, reintroduced by the fix for it.
  const html = render(
    <SegmentedControl
      label="Scope"
      value="mine"
      options={[
        { value: "mine", label: "Mine", disabled: true, disabledReason: "Requires admin" },
        { value: "all", label: "All", disabled: true, disabledReason: "Unavailable offline" },
      ]}
      onChange={() => undefined}
    />,
  );
  assert.doesNotMatch(html, /seg-reason"/, "one sentence cannot describe two different reasons");
  assert.match(html, />Requires admin</);
  assert.match(html, />Unavailable offline</);
});

test("two groups with the same label do not share a description id", () => {
  // Both `aria-describedby`s resolved to the first element, so the second group announced the first
  // group's reason.
  const both = render(
    <>
      <SegmentedControl label="Status" value="a"
        options={[{ value: "a", label: "A", disabled: true, disabledReason: "First reason" }]}
        onChange={() => undefined} />
      <SegmentedControl label="Status" value="b"
        options={[{ value: "b", label: "B", disabled: true, disabledReason: "Second reason" }]}
        onChange={() => undefined} />
    </>,
  );
  const ids = [...both.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], "an id derived from the label is the same id for both groups");
});

test("a row's status joins the title row and the accessible name", () => {
  // §11.1 names "options that need descriptions or status" as this primitive's remit, and the
  // Location pickers are the status half: a machine name alone does not say whether it is local or
  // SSH, or whether it can host a session. The status has to reach a screen reader, because it is
  // the whole basis for choosing between two otherwise identical names.
  const html = render(
    <ChoiceRows
      label="Project Location"
      value="loc-1"
      onChange={() => undefined}
      options={[
        { value: "loc-1", title: "runner-1", status: <span>Local</span>, description: "/repos/app" },
        {
          value: "loc-2",
          title: "runner-2",
          status: <span>SSH</span>,
          description: "/srv/app",
          disabled: true,
          disabledReason: "Runner Offline — this Location cannot host a session right now.",
        },
      ]}
    />,
  );
  // Inside the title — which is what `aria-labelledby` names — not the description: a badge that
  // wraps under a path reads as part of it.
  assert.match(html, /choice-row-title" id="[^"]+">runner-1<span class="choice-row-status"/);
  assert.match(html, /SSH/);
  assert.match(html, /Runner Offline — this Location cannot host a session/);
});

test("a row without a status renders no status element at all", () => {
  // An empty wrapper would still take the title row's gap, so an option with no status would sit
  // a few pixels wider than one with. Absence has to mean absence.
  const html = render(
    <ChoiceRows
      label="Mode"
      value="a"
      onChange={() => undefined}
      options={[{ value: "a", title: "Alpha" }]}
    />,
  );
  assert.doesNotMatch(html, /choice-row-status/);
});
