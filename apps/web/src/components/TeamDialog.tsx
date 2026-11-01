import React, { useId, useMemo, useRef, useState } from "react";
import type { IdentityAdministrationView, TeamView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { titleCaseLabel } from "../format.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { Modal } from "./common.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { DeleteIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { PersonalIdentifierRevealButton, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** The Teams section's own helper: Create Team says once what a team is for; Manage Team does not. */
export const TEAM_PURPOSE = "Use teams when machines and work need a shared ownership scope.";
const NAME_HELPER = "Up to 80 characters.";
const NAME_REQUIRED = "Enter a team name.";
const NAME_TAKEN = "Another team already has this name.";
const SUSPENDED_REASON = "Suspended. Restore their access to add them.";

interface SaveFailure {
  sentence: string;
  detail: string;
}

function errorCode(cause: unknown): string | undefined {
  return cause instanceof ApiError ? cause.code : undefined;
}

function rawMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a failed members request means to the person saving (§8.5): one sentence, raw text behind Show Details. */
function membersFailure(cause: unknown, renamed: boolean): SaveFailure {
  const sentence = errorCode(cause) === "team_member_containment"
    ? "Someone you removed still owns work shared with this team. Move that work first."
    : renamed ? "The new name was saved, but the members weren't. Try again." : "The team wasn't saved. Try again.";
  return { sentence, detail: rawMessage(cause) };
}

function deleteFailure(cause: unknown): ConfirmationFailure {
  const raw = rawMessage(cause);
  const sentence = /reassign resources owned by this team/.test(raw)
    ? "This team still owns work. Move that work to a person or another team first."
    : /retained usage/.test(raw)
      ? "This team's recent usage is still kept. Try again once it expires."
      : "The team wasn't deleted. Try again.";
  return new ConfirmationFailure(sentence, raw);
}

/** The Delete Team confirmation's sentence, from the members the team has now (not the unsaved draft). */
export function deleteTeamMessage(name: string, memberCount: number): string {
  const deleted = `“${name}” is deleted and can't be restored.`;
  if (memberCount === 0) return `${deleted} No one loses access to their own work.`;
  const members = memberCount === 1 ? "Its 1 member keeps their" : `Its ${memberCount} members keep their`;
  return `${deleted} ${members} own access; what was shared with the team is no longer shared.`;
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Create Team and Manage Team (#3000, docs/design-system.md §7, §8). One form in both modes: Team
 * Name, then everyone in the organization as member rows. Manage's Save Changes sends the rename
 * when the name changed and then the members when they changed, and closes without a request when
 * nothing did. A suspended person can't be added, and one already on the team stays checked, so
 * saving never removes them silently.
 */
export function TeamDialog({
  identity,
  team,
  onClose,
  onSaved,
}: {
  identity: IdentityAdministrationView;
  team?: TeamView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const ids = useId();
  const formId = `${ids}-form`;
  const nameIds = { input: `${ids}-name`, helper: `${ids}-name-helper`, error: `${ids}-name-error` };
  const membersIds = { label: `${ids}-members-label`, group: `${ids}-members` };
  const nameRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const [name, setName] = useState(team?.name ?? "");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // What the server holds now. A rename that succeeded while the members failed moves the saved
  // name, so trying again sends only the members.
  const [savedName, setSavedName] = useState(team?.name ?? "");
  const savedMemberIds = team?.memberUserIds ?? [];
  const [memberIds, setMemberIds] = useState<string[]>(savedMemberIds);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);

  const people = useMemo(
    () => [...identity.memberships].sort((a, b) => a.userName.localeCompare(b.userName)),
    [identity.memberships],
  );
  const names = people.map((person) => person.userName);
  const titles = maskedAccountTitles(names, "Hidden Name");
  const [namesRevealed, toggleNames] = usePersonalIdentifierReveal(names.join("\n"));

  const toggle = (userId: string) => {
    setMemberIds((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  };
  const refuseName = (message: string) => {
    setNameError(message);
    nameRef.current?.focus();
  };

  const submit = async () => {
    if (savingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      refuseName(NAME_REQUIRED);
      return;
    }
    const renaming = team ? trimmed !== savedName : false;
    const membersChanged = team ? !sameMembers(memberIds, savedMemberIds) : false;
    if (team && !renaming && !membersChanged) {
      onClose();
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setFailure(null);
    let renamed = false;
    try {
      if (!team) {
        await api.createIdentityTeam({ name: trimmed, memberUserIds: memberIds });
      } else {
        if (renaming) {
          await api.renameIdentityTeam(team.teamId, trimmed);
          renamed = true;
          setSavedName(trimmed);
        }
        if (membersChanged) await api.updateIdentityTeamMembers(team.teamId, memberIds);
      }
    } catch (cause) {
      savingRef.current = false;
      setBusy(false);
      if (errorCode(cause) === "team_name_taken") {
        refuseName(NAME_TAKEN);
      } else if (team && (renamed || !renaming)) {
        setFailure(membersFailure(cause, renamed));
        // The page behind shows the name that was saved.
        if (renamed) void onSaved();
      } else {
        setFailure({ sentence: team ? "The team wasn't saved. Try again." : "The team wasn't created. Try again.", detail: rawMessage(cause) });
      }
      return;
    }
    // The page's refresh reports its own failure; the team is saved either way.
    await onSaved();
    savingRef.current = false;
    setBusy(false);
    onClose();
  };

  // The deletion runs inside the confirmation, which keeps a failure in view (§7.4). On a phone the
  // confirmation replaces this sheet, with Back to Manage Team (§7.5).
  const remove = async () => {
    if (!team || savingRef.current) return;
    const deleted = await confirm({
      title: "Delete Team",
      message: deleteTeamMessage(savedName, savedMemberIds.length),
      confirmLabel: "Delete Team",
      tone: "danger",
      progress: "Deleting the team…",
      onConfirm: async () => {
        try {
          await api.deleteIdentityTeam(team.teamId);
        } catch (cause) {
          throw deleteFailure(cause);
        }
      },
      // A delete request can't be withdrawn once sent, so Cancel would only hide its outcome.
      cancelWhileRunning: false,
    });
    if (!deleted) return;
    await onSaved();
    onClose();
  };

  return (
    <Modal
      title={team ? "Manage Team" : "Create Team"}
      description={team ? undefined : TEAM_PURPOSE}
      onClose={onClose}
      tertiary={team && (
        <button type="button" className="btn ghost danger" onClick={() => void remove()} disabled={busy}>
          <DeleteIcon />
          <span>Delete Team…</span>
        </button>
      )}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <BusyButton
            className="btn primary"
            type="submit"
            form={formId}
            busy={busy}
            progress={team ? "Saving the team…" : "Creating the team…"}
          >
            {team ? "Save Changes" : "Create Team"}
          </BusyButton>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field">
          <div className="field-head"><label htmlFor={nameIds.input}>Team Name</label></div>
          <input
            ref={nameRef}
            id={nameIds.input}
            value={name}
            maxLength={80}
            autoComplete="off"
            readOnly={busy}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? nameIds.error : nameIds.helper}
            onChange={(event) => {
              setNameEdited(true);
              // A refused name clears as soon as it changes; an empty one once it has text again.
              if (nameError && (nameError === NAME_TAKEN || event.target.value.trim())) setNameError(null);
              setName(event.target.value);
            }}
            onBlur={() => {
              if (nameEdited && !name.trim()) setNameError(NAME_REQUIRED);
            }}
          />
          {nameError
            ? <FieldError id={nameIds.error}>{nameError}</FieldError>
            : <p className="field-helper" id={nameIds.helper}>{NAME_HELPER}</p>}
        </div>

        <div className="field">
          <div className="field-head">
            <span id={membersIds.label}>Members</span>
            {names.some((value) => isPersonalIdentifier(value)) && (
              <PersonalIdentifierRevealButton
                label="Names"
                revealed={namesRevealed}
                onToggle={toggleNames}
                controls={membersIds.group}
                withText
              />
            )}
          </div>
          <ChoiceRows<string>
            multiple
            id={membersIds.group}
            label="Members"
            labelledBy={membersIds.label}
            value={memberIds}
            onChange={toggle}
            options={people.map((person, index) => ({
              value: person.userId,
              title: namesRevealed ? person.userName : titles[index]!,
              meta: titleCaseLabel(person.role),
              ...(person.userStatus === "suspended" ? { disabled: true, disabledReason: SUSPENDED_REASON } : {}),
            }))}
          />
        </div>

        {failure && (
          <Notice tone="danger" role="alert" title="Couldn't Save the Team" details={<code>{failure.detail}</code>}>
            {failure.sentence}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
