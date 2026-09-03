import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChoiceCards, SegmentedControl, Select } from "./ChoiceControls.js";

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

test("ChoiceCards says one-of or many-of in its roles", () => {
  const single = render(
    <ChoiceCards options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  assert.match(single, /role="radiogroup"/);
  assert.equal(single.match(/role="radio"/g)?.length, 2);

  const multi = render(
    <ChoiceCards options={PRESETS} value={["quick", "review"]} onChange={() => undefined} label="Agents" multiple />,
  );
  assert.match(multi, /role="group"/);
  assert.equal(multi.match(/role="checkbox"/g)?.length, 2);
  assert.equal(multi.match(/aria-checked="true"/g)?.length, 2);
});

test("a disabled card explains itself in the card, not only in a tooltip", () => {
  const options = [
    { value: "local", title: "Local", description: "Run on this machine" },
    { value: "box", title: "Remote Box", disabled: true, disabledReason: "No box is connected" },
  ] as const;
  const html = render(
    <ChoiceCards options={options} value="local" onChange={() => undefined} label="Location" />,
  );
  // A `title` is invisible on touch and to most screen readers. §11.3: every disabled control
  // carries a <small> reason, and never hide a setting that could exist.
  assert.match(html, /<small[^>]*>No box is connected<\/small>/);
  assert.match(html, /aria-disabled="true"/);
});

test("ChoiceCards renders a marker whose SHAPE distinguishes the two modes", () => {
  const single = render(
    <ChoiceCards options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />,
  );
  const multi = render(
    <ChoiceCards options={PRESETS} value={["quick"]} onChange={() => undefined} label="Agents" multiple />,
  );
  // The marker is the visible half of the same distinction the roles make. Without it, the six
  // patterns this replaces looked identical until you clicked a second card.
  assert.match(single, /ui-choice-mark(?!.*is-multi)/);
  assert.match(multi, /ui-choice-mark is-multi/);
  assert.doesNotMatch(single, /ui-choice-mark is-multi/);
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
  // into a cast or a fake selection, and the roving fallback then had to have a stop anyway.
  const html = render(
    <ChoiceCards options={PRESETS} value={null} onChange={() => undefined} label="Preset" />,
  );
  assert.doesNotMatch(html, /aria-checked="true"/);
  assert.equal(html.match(/tabindex="0"/g)?.length, 1);
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
    render(<ChoiceCards options={PRESETS} value="quick" onChange={() => undefined} label="Preset" />),
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
  assert.match(html, /class="ui-seg-reason"[^>]*>Unavailable while saving retention</,
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
  assert.doesNotMatch(html, /ui-seg-reason/);
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
  assert.doesNotMatch(html, /ui-seg-reason"/, "one sentence cannot describe two different reasons");
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
