import React, { useId } from "react";
import { parseLocationSwitchOption, type LocationSwitchCandidate, type LocationSwitchPlace, type LocationSwitchSnapshot,
  type PermissionOption } from "@wollipog/protocol";
import { ChevronRightIcon } from "../Icons.js";
import { ChoiceRows } from "../ui/ChoiceControls.js";
import type { RequestCardActions } from "./request-meta.js";

export const LOCATION_SWITCH_COPY = {
  details: "Location Switch Details",
  currentLocation: "Current Location",
  proposedLocation: "Proposed Location",
  repository: "Repository",
  machine: "Machine",
  path: "Path",
  sameMachine: "This Machine",
  otherMachine: "Another Machine",
  taskHandoff: "Task Handoff",
  existingBranch: "Existing Branch",
  unavailableLocations: "Unavailable Locations",
  unknownRepository: "an unverified repository",
} as const;

/** The Locations a person can choose: those that offer at least one action, in Project order. */
export function locationSwitchChoices(snapshot: LocationSwitchSnapshot): LocationSwitchCandidate[] {
  return snapshot.candidates.filter((candidate) => candidate.actions.length > 0);
}

/** The card's options for one chosen Location: its actions and Stay Here, never another Location's.
 * The footer, A and D all act on this list, so no key can approve a Location the person did not choose. */
export function locationSwitchOptions(options: readonly PermissionOption[], locationId: string | null): PermissionOption[] {
  return options.filter((option) => {
    const parsed = parseLocationSwitchOption(option.optionId);
    return parsed ? parsed.locationId === locationId : option.kind === "reject_once" || option.kind === "reject_always";
  });
}

/** The footer for one chosen Location: Switch and Continue is the primary when the live session can
 * move there, Start a New Session otherwise; every other choice stays a visible button. */
export function locationSwitchCardActions(options: readonly PermissionOption[]): RequestCardActions {
  const action = (name: "switch" | "new_session") => options.find((option) => parseLocationSwitchOption(option.optionId)?.action === name) ?? null;
  const live = action("switch");
  const handoff = action("new_session");
  const stay = options.filter((option) => option.kind === "reject_once" || option.kind === "reject_always");
  return { tertiary: null, primary: live ?? handoff, secondary: [...stay, ...(live && handoff ? [handoff] : [])], menu: [] };
}

/** One Location's rows, headed by its role, inside the summary's single facts list so every label
 * lines up. */
function placeRows(label: string, place: LocationSwitchPlace) {
  return [
    <div key={`${label}-name`}><dt>{label}</dt><dd>{place.name}</dd></div>,
    <div key={`${label}-repository`}><dt>{LOCATION_SWITCH_COPY.repository}</dt><dd>{place.repository ?? "Not Verified"}</dd></div>,
    <div key={`${label}-machine`}><dt>{LOCATION_SWITCH_COPY.machine}</dt><dd>{place.machineName}</dd></div>,
    <div key={`${label}-path`}><dt>{LOCATION_SWITCH_COPY.path}</dt><dd><code>{place.path}</code></dd></div>,
  ];
}

/** What a Location switch decides (#4138): the repository the task belongs to, where the session is
 * now, where it could continue, and the handoff a new session would receive. With `onChoose`, the
 * person picks one of several matching Locations; otherwise the summary is read-only. */
export function LocationSwitchSummary({ snapshot, chosenLocationId, onChoose }: {
  snapshot: LocationSwitchSnapshot;
  chosenLocationId?: string | null;
  onChoose?: (locationId: string) => void;
}) {
  const proposedId = `${useId().replace(/:/gu, "")}-proposed`;
  const choices = locationSwitchChoices(snapshot);
  const chosen = choices.find((candidate) => candidate.locationId === chosenLocationId) ?? choices[0];
  const blocked = snapshot.candidates.filter((candidate) => candidate.actions.length === 0);
  const unavailable = [
    ...blocked.map((candidate) => ({ key: candidate.locationId, name: candidate.name, machineName: candidate.machineName,
      reason: candidate.unavailableReason ?? "" })),
    ...snapshot.unavailable.map((item) => ({ key: item.locationId, ...item })),
  ];
  return <section aria-label={LOCATION_SWITCH_COPY.details}>
    <p>
      This task belongs to repository <strong>{snapshot.repository}</strong>. This session is currently in repository{" "}
      <strong>{snapshot.current.repository ?? LOCATION_SWITCH_COPY.unknownRepository}</strong>.
      {" "}Continue in a Location of {snapshot.repository}?
    </p>
    <p>{snapshot.reason}</p>
    <dl className="facts">
      {placeRows(LOCATION_SWITCH_COPY.currentLocation, snapshot.current)}
      {chosen && !(onChoose && choices.length > 1) ? placeRows(LOCATION_SWITCH_COPY.proposedLocation, chosen) : null}
      {onChoose && choices.length > 1 ? (
        // The same visible term as a single proposal, which also names the choice for assistive technology.
        <div><dt id={proposedId}>{LOCATION_SWITCH_COPY.proposedLocation}</dt><dd>
          <ChoiceRows
            label={LOCATION_SWITCH_COPY.proposedLocation}
            labelledBy={proposedId}
            value={chosen?.locationId ?? null}
            onChange={onChoose}
            options={choices.map((candidate) => ({
              value: candidate.locationId,
              title: candidate.name,
              status: candidate.sameRunner ? LOCATION_SWITCH_COPY.sameMachine : LOCATION_SWITCH_COPY.otherMachine,
              description: <>{candidate.repository} · {candidate.machineName} · <code>{candidate.path}</code></>,
            }))}
          />
        </dd></div>
      ) : null}
    </dl>
    {snapshot.recoverBranch && chosen?.actions.includes("switch") && <dl className="facts">
      <div><dt>{LOCATION_SWITCH_COPY.existingBranch}</dt><dd><code>{snapshot.recoverBranch}</code></dd></div>
    </dl>}
    {chosen && <p>
      {chosen.actions.includes("switch")
        ? "Switch and Continue moves this session to that Location: it keeps its conversation and continues the task in a " +
          (snapshot.recoverBranch ? "worktree of the existing branch above" : "new worktree there") +
          ", under that repository's instructions and permissions. " +
          (snapshot.recoverBranch
            ? "If a worktree that no session uses already has that branch checked out, the session continues there as it " +
              "is, with any uncommitted changes in it. "
            : "") +
          "Start a New Session leaves this session here and starts another there with the handoff below."
        : chosen.sameRunner
        ? "Start a New Session continues this task in that Location with the handoff below. This session stays where it is."
        : "That Location is on another machine, so the task continues in a new session there with the handoff below. " +
          "This session stays where it is."}
    </p>}
    {unavailable.length > 0 && <dl className="facts" aria-label={LOCATION_SWITCH_COPY.unavailableLocations}>
      <div><dt>{LOCATION_SWITCH_COPY.unavailableLocations}</dt><dd>
        <ul>{unavailable.map((item) => <li key={item.key}>{item.name} on {item.machineName}: {item.reason}</li>)}</ul>
      </dd></div>
    </dl>}
    <details className="disclosure">
      <summary><ChevronRightIcon className="disclosure-chevron" />{LOCATION_SWITCH_COPY.taskHandoff}</summary>
      <div className="disclosure-body"><div className="code-well"><pre>{snapshot.handoff}</pre></div></div>
    </details>
    <p>Stay Here keeps this session in its current Location, with its repository and permissions unchanged.</p>
  </section>;
}
