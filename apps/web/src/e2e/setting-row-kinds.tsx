import React from "react";
import {
  ActionRow,
  LinkRow,
  NumberRow,
  SegmentedRow,
  SelectRow,
  SettingsGroup,
  StaticRow,
  SwitchRow,
  ValueRow,
} from "../components/ui/SettingsRows.js";
import { COLOR_SCHEMES, DENSITY_OPTIONS, THEME_OPTIONS } from "../theme.js";

/*
 * The settings-rows harness's `?view=kinds` (#2947), kept apart from settings-rows-main.tsx: that
 * file mounts the production Settings panels and must never hand-roll rows that look like theirs.
 * These rows are not a copy of any screen; they are the row kinds themselves, one of each in every
 * state, for the grid's own measurements and its evidence.
 */

const noop = () => undefined;

const ANSWER_IN = [
  { value: "interactive", label: "Form", description: "Answer in a form under the question." },
  { value: "composer", label: "Composer", description: "Answer in the composer, like a message." },
];

const HARNESS_OPTIONS = [
  { value: "auto", label: "Automatic", description: "Any compatible Agent Harness." },
  { value: "codex", label: "Codex App Server", description: "Native execution context." },
  { value: "claude", label: "Claude Code", description: "Native execution context." },
];

/**
 * Every row kind of the §8.2 grid (#2947) in every state, in groups, inside the real Settings page.
 *
 * `?view=kinds` replaces the section's panel with these groups, so the rows sit in the same
 * `.settings-panel` the production sections use. `group-width` narrows the groups' container to that
 * many pixels without narrowing the viewport, which is the claim the grid makes: its narrow layout
 * answers to the group's surface, never to the window.
 */
export function RowKinds() {
  return (
    <>
      <SettingsGroup
        title="Row Kinds"
        scope="This Device"
        intro="One of each row kind, on one grid."
        foot="Every title shares one left edge, and every control ends at one right edge."
      >
        <SwitchRow title="Desktop Alerts" description="Approvals and finished turns, while Wollipog is open" checked={false} onClick={noop} />
        <SegmentedRow title="Theme" options={THEME_OPTIONS} value="system" onChange={noop} />
        <SelectRow title="Color Scheme" description="Applies to both the light and the dark theme." options={COLOR_SCHEMES} value="wollipog" onChange={noop} />
        <NumberRow title="Idle Timeout" description="How long an idle session waits before it sleeps." value="30" unit="min" min={0} onChange={noop} />
        <ValueRow title="Server Address" description="The server this window uses." value="https://studio.tail1234.ts.net:4417" mono copy />
        <LinkRow title="Tool Policies" description="Shared guardrails for tool calls." trailing="3 Policies" onClick={noop} />
        <ActionRow title="Claude Code" description="Opus, high effort, Auto permissions." actionLabel="Edit…" hasPopup="dialog" onAction={noop} />
        <StaticRow title="Effective Boundary" description="Provider approval controls and repository governance still apply." />
      </SettingsGroup>
      <SettingsGroup title="Disabled" intro="Only a disabled row dims, and only its title.">
        <SwitchRow title="Enable Tailnet Access" description="Another control plane owns this port." checked disabled onClick={noop} />
        <SegmentedRow
          title="Density"
          options={DENSITY_OPTIONS}
          value="compact"
          disabled
          disabledReason="Managed by your workspace administrator."
          onChange={noop}
        />
        <SelectRow
          title="Child Harness"
          description="Automatic or a fixed stable Agent Harness identity."
          options={HARNESS_OPTIONS}
          value="auto"
          disabled
          disabledReason="Update Wollipog to choose a fixed Child Harness."
          onChange={noop}
        />
        <NumberRow title="Maximum Concurrent Children" value="4" disabled onChange={noop} />
        <LinkRow title="Manage Instances" description="Instances are managed in the desktop app." disabled onClick={noop} />
        <ActionRow title="Codex" description="No installation is online." actionLabel="Edit…" disabled onAction={noop} />
      </SettingsGroup>
      <SettingsGroup title="Busy" intro="A busy row keeps its confirmed value and says it is saving.">
        <SwitchRow title="Push Notifications" description="Push-to-wake — works with the app closed" checked busy onClick={noop} />
        <SelectRow title="Child Harness" description="Automatic or a fixed stable Agent Harness identity." options={HARNESS_OPTIONS} value="codex" busy onChange={noop} />
        <SegmentedRow title="Answer Questions In" options={ANSWER_IN} value="interactive" busy busyLabel="Saving on this device…" onChange={noop} />
        <NumberRow title="Retention" value="7" unit="d" busy onChange={noop} />
      </SettingsGroup>
      <SettingsGroup title="Saved" intro="A confirmed change shows Saved for two seconds.">
        <SwitchRow title="Automatic Updates" description="Check the source for new commits and apply them." checked saved onClick={noop} />
        <SelectRow title="Color Scheme" options={COLOR_SCHEMES} value="github" saved onChange={noop} />
        <SegmentedRow title="Density" options={DENSITY_OPTIONS} value="comfortable" saved onChange={noop} />
        <NumberRow title="Idle Timeout" value="45" unit="min" saved onChange={noop} />
      </SettingsGroup>
      <SettingsGroup
        title="Errors"
        intro="A switch fails in place; any other instant save fails above the group."
        failure={{ message: "Couldn't save Color Scheme. Check your connection, then try again.", detail: "HTTP 503", onRetry: noop }}
      >
        <SwitchRow
          title="Release Notes"
          description="Answer release-note questions automatically."
          checked={false}
          failure={{ message: "Couldn't save this change.", detail: "HTTP 503", onRetry: noop }}
          onClick={noop}
        />
        <NumberRow
          title="Maximum Concurrent Children"
          description="Choose 0 to pause child admission."
          value="-1"
          error="Enter a whole number from 0 to 64."
          onChange={noop}
        />
        <SelectRow title="Color Scheme" options={COLOR_SCHEMES} value="dracula" onChange={noop} />
      </SettingsGroup>
      <SettingsGroup title="Long Copy" intro="Titles and descriptions wrap; a value truncates and keeps its full text in its tooltip.">
        <SwitchRow
          title="Include Pre-Release Updates From the Early Access Channel on This Machine"
          description="Include early versions that may be less reliable. Turning this off waits for a newer stable release; it does not downgrade Wollipog."
          checked={false}
          onClick={noop}
        />
        <SelectRow
          title="Integration Isolation for New Orchestrator Campaigns"
          description="Launch with Wollipog's management tools as the only integration, so hooks, plugins, extensions and configured servers do not load."
          options={HARNESS_OPTIONS}
          value="claude"
          onChange={noop}
        />
        <ValueRow
          title="Control-Plane Address"
          value="https://a-very-long-machine-name.tail-network-1234.ts.net:4417/workspaces/primary"
          mono
          copy
        />
        <LinkRow
          title="Review Agent-Created Sessions Before They Start"
          description="Applies to sessions created through the agent tools, including sessions an Orchestrator starts for a campaign."
          trailing="Built In"
          onClick={noop}
        />
      </SettingsGroup>
    </>
  );
}
