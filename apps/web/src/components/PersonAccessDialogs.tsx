import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { OrganizationMembershipView, OrganizationRole, UserStatus } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { accountLabelText, isPersonalIdentifier } from "../personal-identifiers.js";
import { Modal } from "./common.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { UserXIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { PersonalIdentifierMask, PersonalIdentifierRevealButton } from "./PersonalIdentifier.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** The server's limit for a person's name (`PATCH /api/identity/users/:userId`). */
const NAME_MAX_LENGTH = 80;
const NAME_HELPER = "Enter the person's name.";
const NAME_REQUIRED = "Enter the person's name.";
const NAME_TOO_LONG = `Use ${NAME_MAX_LENGTH} characters or fewer.`;
const OWNER_REFUSED = "Only an owner can change owner access.";

/** In order of increasing access, so the default (Viewer) leads and Owner ends the list. */
const ACCESS_LEVELS: ReadonlyArray<{ value: OrganizationRole; title: string; description: string }> = [
  { value: "viewer", title: "Viewer", description: "Read-only access to shared work and connection status." },
  { value: "operator", title: "Operator", description: "Run and manage work, without changing who has access." },
  { value: "admin", title: "Admin", description: "Manage connections, people, teams and paired devices." },
  { value: "owner", title: "Owner", description: "Full control, including owners and admins." },
];

/**
 * Access Level as choice rows (docs/design-system.md §8.4), shared by Add Person and Manage Person
 * so every level shows what it means. Only an owner may grant Owner: for anyone else that row stays
 * reachable by the arrow keys and says why it can't be chosen.
 */
export function AccessLevelChoices({
  actorRole,
  value,
  onChange,
}: {
  actorRole: OrganizationRole;
  value: OrganizationRole;
  onChange: (role: OrganizationRole) => void;
}) {
  const labelId = useId();
  return (
    <div className="field">
      <span className="field-label" id={labelId}>Access Level</span>
      <ChoiceRows<OrganizationRole>
        label="Access Level"
        labelledBy={labelId}
        value={value}
        onChange={onChange}
        options={ACCESS_LEVELS.map((level) => level.value === "owner" && actorRole !== "owner"
          ? { ...level, disabled: true, disabledReason: "Only an owner can make someone an owner." }
          : level)}
      />
    </div>
  );
}

/** Why a draft is not a name the server accepts, or null when it is. */
function nameProblem(draft: string): string | null {
  const trimmed = draft.trim();
  if (!trimmed) return NAME_REQUIRED;
  if (trimmed.length > NAME_MAX_LENGTH) return NAME_TOO_LONG;
  return null;
}

/**
 * The Name field (§8.1, §8.5). An email-shaped stored name passes `masked`: hidden, the field is the
 * mask inside a box with the input's edge and height, and the value is not in the DOM until Show
 * Name in the field head reveals the input (§11.8).
 */
function PersonNameField({
  value,
  onChange,
  onBlur,
  error,
  inputRef,
  masked,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  masked?: { hidden: boolean; onToggle: () => void };
}) {
  const id = useId();
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const hidden = masked?.hidden ?? false;
  return (
    <div className="field">
      <div className={masked ? "field-head pid-field-head" : "field-head"}>
        {hidden ? <span>Name</span> : <label htmlFor={id}>Name</label>}
        {masked && (
          <PersonalIdentifierRevealButton
            label="Name"
            revealed={!hidden}
            onToggle={masked.onToggle}
            controls={hidden ? undefined : id}
            withText
          />
        )}
      </div>
      {hidden ? (
        <div className="pid-field-box" aria-describedby={helperId}><PersonalIdentifierMask /></div>
      ) : (
        <input
          ref={inputRef}
          id={id}
          value={value}
          maxLength={NAME_MAX_LENGTH}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : helperId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
        />
      )}
      {error && !hidden
        ? <FieldError id={errorId}>{error}</FieldError>
        : (
          <p className="field-helper" id={helperId}>
            {hidden ? "Hidden because it looks like an email address." : NAME_HELPER}
          </p>
        )}
    </div>
  );
}

/** A submit failure in the person's words (§8.5, §13.2): the server's own text only behind Show Details. */
interface SaveFailure {
  title: string;
  sentence: string;
  detail: string;
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The server refused the name's length (`displayName must be 1-80 characters`). */
function refusedName(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 400 && /displayName/u.test(cause.message);
}

/** The server's owner rule refused the change (`only an organization owner can …`). */
function refusedOwner(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 403 && /owner/iu.test(cause.message);
}

function saveFailure(cause: unknown, title: string, sentence: string): SaveFailure {
  return { title, sentence: refusedOwner(cause) ? OWNER_REFUSED : sentence, detail: failureDetail(cause) };
}

function SaveFailureNotice({ failure }: { failure: SaveFailure | null }) {
  if (!failure) return null;
  return (
    <Notice
      tone="danger"
      role="alert"
      title={failure.title}
      details={<div className="code-well"><code>{failure.detail}</code></div>}
    >
      {failure.sentence}
    </Notice>
  );
}

/**
 * Add Person (docs/design-system.md §7.1–§7.5, §8.5): a short form, so the primary stays enabled
 * and pressing it with an empty name shows the error under Name and moves focus there.
 */
export function AddPersonDialog({
  actorRole,
  onClose,
  onSaved,
}: {
  actorRole: OrganizationRole;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const formId = useId();
  const [name, setName] = useState("");
  const [edited, setEdited] = useState(false);
  const [role, setRole] = useState<OrganizationRole>("viewer");
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const close = () => {
    if (!busyRef.current) onClose();
  };
  const submit = async () => {
    if (busyRef.current) return;
    const problem = nameProblem(name);
    setNameError(problem);
    setEdited(true);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const displayName = name.trim();
    try {
      await api.createIdentityMember({ displayName, role });
    } catch (cause) {
      busyRef.current = false;
      setBusy(false);
      if (refusedName(cause)) {
        setNameError(nameProblem(name) ?? NAME_TOO_LONG);
        nameRef.current?.focus();
        return;
      }
      setFailure(saveFailure(
        cause,
        `Couldn't Add ${accountLabelText(displayName, "Person")}`,
        "Wollipog didn't save the change. Nothing was added; try again.",
      ));
      return;
    }
    await onSaved();
    busyRef.current = false;
    onClose();
  };

  return (
    <Modal
      title="Add Person"
      description="Next, pair a device so they can sign in."
      onClose={close}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={formId} busy={busy} progress="Adding the person…">
            Add Person
          </BusyButton>
        </>
      )}
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
        <PersonNameField
          value={name}
          inputRef={nameRef}
          error={nameError}
          onChange={(next) => {
            setName(next);
            setEdited(true);
            // An error showing clears as soon as the value is valid (§8.5).
            if (nameError) setNameError(nameProblem(next));
          }}
          onBlur={() => { if (edited && !busyRef.current) setNameError(nameProblem(name)); }}
        />
        <AccessLevelChoices actorRole={actorRole} value={role} onChange={setRole} />
        <SaveFailureNotice failure={failure} />
      </form>
    </Modal>
  );
}

/** "3 devices. They use this access level." for the Paired Devices line, counted from the loaded list. */
function pairedDevicesText(count: number): string {
  if (count === 0) return "None yet. Use Pair Device… to give them a sign-in link.";
  return count === 1
    ? "1 device. It uses this access level."
    : `${count} devices. They use this access level.`;
}

/**
 * Manage Person: the person's name and access level, saved together by Save Changes, and access
 * itself as a separate action. Suspend Access… is the footer's destructive tertiary and confirms
 * first (§7.3, §7.4), as Revoke Device and Delete Team do; a suspended person's dialog opens with a
 * notice whose Restore Access applies at once, since restoring is not destructive.
 */
export function ManagePersonDialog({
  actorRole,
  member,
  pairedDevices,
  onClose,
  onSaved,
}: {
  actorRole: OrganizationRole;
  member: OrganizationMembershipView;
  /** How many of the loaded paired devices belong to this person; omitted where devices are not shown. */
  pairedDevices?: number | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const formId = useId();
  const noticeId = useId();
  const devicesId = useId();
  // An email-shaped name stays out of the editable field until the admin deliberately shows it, and
  // out of the title and sentences altogether.
  const nameIsPersonal = isPersonalIdentifier(member.userName);
  const spokenName = nameIsPersonal ? null : member.userName;
  const [nameShown, setNameShown] = useState(!nameIsPersonal);
  const [displayName, setDisplayName] = useState(member.userName);
  const [edited, setEdited] = useState(false);
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState<UserStatus>(member.userStatus);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const workingRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const suspendRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  /** The action that just changed `status`, so focus can follow it to the control that replaced it. */
  const statusChangedRef = useRef(false);
  /** A hidden name that failed validation is revealed first, so focus waits for its input to mount. */
  const focusNameRef = useRef(false);
  const working = saving || restoring;

  useEffect(() => {
    if (!focusNameRef.current || !nameShown) return;
    focusNameRef.current = false;
    nameRef.current?.focus();
  }, [nameShown]);

  /** Show the name's error on its input, revealing a hidden name that still holds an edit. */
  const showNameError = (problem: string) => {
    setNameError(problem);
    if (nameShown) {
      nameRef.current?.focus();
    } else {
      focusNameRef.current = true;
      setNameShown(true);
    }
  };

  // Suspend Access… and the notice's Restore Access replace each other, so focus moves to whichever
  // took the place of the one just used. A confirmation closing in the same commit leaves focus that
  // already rests on a control where it is.
  useEffect(() => {
    if (!statusChangedRef.current) return;
    statusChangedRef.current = false;
    (status === "suspended" ? restoreRef : suspendRef).current?.focus();
  }, [status]);

  const close = () => {
    if (!workingRef.current) onClose();
  };

  const save = async () => {
    if (workingRef.current) return;
    // An edit made while the name was shown stays after Hide Name, so the draft is always checked.
    const problem = nameProblem(displayName);
    setEdited(true);
    if (problem) {
      showNameError(problem);
      return;
    }
    setNameError(null);
    const nextName = displayName.trim();
    if (nextName === member.userName && role === member.role) {
      onClose();
      return;
    }
    workingRef.current = true;
    setSaving(true);
    setFailure(null);
    try {
      // Status is its own confirmed action and never rides along with a save.
      await api.updateIdentityMember(member.userId, { displayName: nextName, role });
    } catch (cause) {
      workingRef.current = false;
      setSaving(false);
      if (refusedName(cause)) {
        showNameError(nameProblem(displayName) ?? NAME_TOO_LONG);
        return;
      }
      setFailure(saveFailure(cause, "Couldn't Save Changes", "Wollipog didn't save the change. Nothing changed; try again."));
      return;
    }
    await onSaved();
    workingRef.current = false;
    onClose();
  };

  const suspend = async () => {
    if (workingRef.current) return;
    setFailure(null);
    await confirm({
      title: "Suspend Access",
      message: `${spokenName ?? "This person"} is signed out everywhere and can't use Wollipog until you restore access. Their devices stay paired.`,
      confirmLabel: "Suspend Access",
      tone: "danger",
      progress: "Suspending access…",
      // The request cannot be withdrawn once sent, so the confirmation stays until it settles rather
      // than closing on a suspension that may still land.
      cancelWhileRunning: false,
      onConfirm: async () => {
        workingRef.current = true;
        try {
          await api.updateIdentityMember(member.userId, { status: "suspended" });
        } catch (cause) {
          throw new ConfirmationFailure(
            refusedOwner(cause) ? OWNER_REFUSED : "Wollipog didn't suspend access. Nothing changed; try again.",
            failureDetail(cause),
          );
        } finally {
          workingRef.current = false;
        }
        statusChangedRef.current = true;
        setStatus("suspended");
        void onSaved();
      },
    });
  };

  const restore = async () => {
    if (workingRef.current) return;
    workingRef.current = true;
    setRestoring(true);
    setFailure(null);
    try {
      await api.updateIdentityMember(member.userId, { status: "active" });
    } catch (cause) {
      setFailure(saveFailure(
        cause,
        "Couldn't Restore Access",
        `Wollipog didn't restore access. ${spokenName ?? "This person"} is still suspended; try again.`,
      ));
      return;
    } finally {
      workingRef.current = false;
      setRestoring(false);
    }
    statusChangedRef.current = true;
    setStatus("active");
    showToast(`Access restored for ${spokenName ?? "this person"}.`, { tone: "success" });
    void onSaved();
  };

  const suspended = status === "suspended";
  const describedBy = [suspended ? noticeId : null, pairedDevices != null ? devicesId : null].filter(Boolean).join(" ");
  return (
    <Modal
      title={`Manage ${accountLabelText(member.userName, "Person")}`}
      onClose={close}
      describedBy={describedBy || undefined}
      tertiary={suspended ? undefined : (
        <button ref={suspendRef} type="button" className="btn ghost danger" onClick={() => void suspend()} disabled={working}>
          <UserXIcon />
          <span>Suspend Access…</span>
        </button>
      )}
      footer={(
        <>
          <button type="button" className="btn" onClick={close} disabled={working}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={formId} busy={saving} progress="Saving the changes…">
            Save Changes
          </BusyButton>
        </>
      )}
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {suspended && (
          <Notice
            id={noticeId}
            tone="neutral"
            compact
            actions={(
              <BusyButton ref={restoreRef} className="btn sm" busy={restoring} progress="Restoring access…" onClick={() => void restore()}>
                Restore Access
              </BusyButton>
            )}
          >
            Access is suspended. {spokenName ?? "This person"} can't sign in and their devices can't connect.
          </Notice>
        )}
        <PersonNameField
          value={displayName}
          inputRef={nameRef}
          error={nameError}
          onChange={(next) => {
            setDisplayName(next);
            setEdited(true);
            if (nameError) setNameError(nameProblem(next));
          }}
          onBlur={() => { if (edited && !workingRef.current) setNameError(nameProblem(displayName)); }}
          masked={nameIsPersonal ? {
            hidden: !nameShown,
            // No focus move: a keyboard reveal keeps focus on the toggle so Enter can hide it again.
            onToggle: () => {
              setNameShown((shown) => !shown);
              setNameError(null);
            },
          } : undefined}
        />
        <AccessLevelChoices actorRole={actorRole} value={role} onChange={setRole} />
        {pairedDevices != null && (
          <dl className="facts">
            <dt>Paired Devices</dt>
            <dd id={devicesId}>{pairedDevicesText(pairedDevices)}</dd>
          </dl>
        )}
        <SaveFailureNotice failure={failure} />
      </form>
    </Modal>
  );
}
