import React, { useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { InstanceProfile } from "../desktop-instances.js";
import {
  checkRemoteInstancePairingCode,
  normalizeRemoteInstanceOrigin,
  parseRemoteInstanceAdvanced,
  parseRemoteInstancePairingLink,
} from "../instance-pairing.js";
import { useInstances } from "../instances-context.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, SegmentedControl } from "./ui/ChoiceControls.js";
import { useSecretInput } from "./ui/secret-input.js";
import {
  NAME_REQUIRED,
  editMismatchError,
  pairingFieldError,
  remoteInstanceFailure,
  repairMismatchError,
  type RemoteInstanceDialogMode,
  type RemoteInstanceFailure,
  type RemoteInstanceField,
} from "./remote-instance-copy.js";

type ConnectWith = "link" | "code";

const CONNECT_WITH_OPTIONS = [
  { value: "link", label: "Pairing Link" },
  { value: "code", label: "Address and Code" },
] as const;

export type RemoteInstanceDialogProps = {
  onClose: () => void;
  /** Where focus returns on close, when it is not the element focused as the dialog opened. */
  returnFocusRef?: { current: HTMLElement | null };
} & (
  | { mode: "add" }
  | { mode: "edit" | "repair"; profile: InstanceProfile }
);

const TITLES: Record<RemoteInstanceDialogMode, string> = {
  add: "Add Remote Instance",
  edit: "Edit Instance",
  repair: "Re-Pair Instance",
};

const SUBMIT: Record<RemoteInstanceDialogMode, { label: string; progress: string }> = {
  add: { label: "Add Instance", progress: "Adding the instance…" },
  edit: { label: "Save Changes", progress: "Saving the changes…" },
  repair: { label: "Re-Pair", progress: "Re-pairing the instance…" },
};

/** The order fields are focused in when a submit finds several invalid: the order they render. */
const FIELD_ORDER: Record<RemoteInstanceDialogMode, readonly RemoteInstanceField[]> = {
  add: ["label", "link", "origin", "token"],
  edit: ["label", "origin", "link"],
  repair: ["link", "token"],
};

/**
 * Add Remote Instance, Edit Instance and Re-Pair Instance (#3003; docs/design-system.md §7, §8):
 * the consuming end of pairing. Pair Device… on the other computer creates the link; this dialog
 * uses it, either as the whole link or as Manual Setup's address and code, chosen with Connect With.
 *
 * One dialog serves every entry point: `InstanceProvider` mounts it for `openInstanceDialog`, so it is
 * not rendered by the page that opens it.
 *
 * Errors belong to their field (§8.5): each is kept per field, shown under it in the helper's place
 * with `aria-invalid`, and cleared when that field changes or Connect With switches, so a link error
 * never shows under the address fields. A submit focuses the first invalid field. A failure after
 * submit is a titled danger Notice above the footer, with the desktop app's words behind Show
 * Details.
 *
 * Pairing links and codes are read on submit and never kept in state or the DOM (#3814). Parsing is
 * instance-pairing.ts's, unchanged: a changed address still needs a fresh link for that address, so
 * the saved credential is never sent to an unverified server. Re-Pair's Address and Code asks only
 * for the code: the address is the saved one, shown read-only.
 */
export function RemoteInstanceDialog(props: RemoteInstanceDialogProps) {
  const { mode } = props;
  const instances = useInstances();
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const profile = props.mode === "add" ? null : props.profile;
  const [label, setLabel] = useState(profile?.label ?? "");
  const [origin, setOrigin] = useState(mode === "edit" ? profile!.origin : "");
  const [connectWith, setConnectWith] = useState<ConnectWith>("link");
  const [switchAfterAdding, setSwitchAfterAdding] = useState(true);
  // Pairing secrets stay out of the DOM (#3814): read on submit, and cleared once accepted.
  const pairingLink = useSecretInput();
  const pairingCode = useSecretInput();
  const [errors, setErrors] = useState<Partial<Record<RemoteInstanceField, string>>>({});
  const [failure, setFailure] = useState<RemoteInstanceFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const fieldRefs = useRef<Partial<Record<RemoteInstanceField, HTMLElement | null>>>({});
  const fieldRef = (field: RemoteInstanceField, forward?: (node: HTMLInputElement | null) => void) =>
    (node: HTMLInputElement | null) => {
      fieldRefs.current[field] = node;
      forward?.(node);
    };

  const requestClose = () => {
    if (!busyRef.current) props.onClose();
  };
  /** A change to a field clears its own error and the last submit failure. */
  const changed = (...fields: RemoteInstanceField[]) => {
    setFailure(null);
    setErrors((previous) => {
      if (!fields.some((field) => previous[field])) return previous;
      const remaining = { ...previous };
      for (const field of fields) delete remaining[field];
      return remaining;
    });
  };

  const editOrigin = mode === "edit" ? normalizeRemoteInstanceOrigin(origin) : null;
  const editNeedsLink = Boolean(editOrigin?.ok && editOrigin.value.httpOrigin !== profile!.origin);

  /** Every field's error, and the request to make when there are none. */
  const validate = (): { found: Partial<Record<RemoteInstanceField, string>>; run?: () => Promise<void> } => {
    const found: Partial<Record<RemoteInstanceField, string>> = {};
    const cleanLabel = label.trim();
    if (mode !== "repair" && !cleanLabel) found.label = NAME_REQUIRED;

    if (props.mode === "edit") {
      const target = props.profile;
      const parsed = normalizeRemoteInstanceOrigin(origin);
      if (!parsed.ok) {
        found.origin = pairingFieldError(parsed.error);
        return { found };
      }
      let token: string | undefined;
      if (parsed.value.httpOrigin !== target.origin) {
        const link = parseRemoteInstancePairingLink(pairingLink.read());
        if (!link.ok) {
          found.link = link.error.code === "EMPTY_INPUT"
            ? "Paste a pairing link created for the new address."
            : pairingFieldError(link.error);
        } else if (link.value.endpoint.httpOrigin !== parsed.value.httpOrigin) {
          found.link = editMismatchError(parsed.value.httpOrigin);
        } else {
          token = link.value.token;
        }
      }
      if (Object.keys(found).length > 0) return { found };
      return {
        found,
        run: () => instances.editInstance({
          profileId: target.id,
          label: cleanLabel,
          origin: parsed.value.httpOrigin,
          ...(token ? { token } : {}),
        }),
      };
    }

    const target = props.mode === "repair" ? props.profile : null;
    let endpointOrigin: string | undefined;
    let token: string | undefined;
    if (connectWith === "link") {
      const parsed = parseRemoteInstancePairingLink(pairingLink.read());
      if (!parsed.ok) found.link = pairingFieldError(parsed.error);
      else if (target && parsed.value.endpoint.httpOrigin !== target.origin) found.link = repairMismatchError(target.label);
      else {
        token = parsed.value.token;
        endpointOrigin = parsed.value.endpoint.httpOrigin;
      }
    } else {
      // Re-Pair keeps the saved address, so only the code is entered.
      const parsed = parseRemoteInstanceAdvanced(target ? target.origin : origin, pairingCode.read());
      if (parsed.ok) {
        token = parsed.value.token;
        endpointOrigin = parsed.value.endpoint.httpOrigin;
      } else {
        found[parsed.error.field] = pairingFieldError(parsed.error);
        // The address is checked first; report the code at the same time.
        if (parsed.error.field === "origin") {
          const code = checkRemoteInstancePairingCode(pairingCode.read());
          if (!code.ok) found.token = pairingFieldError(code.error);
        }
      }
    }
    if (Object.keys(found).length > 0 || !token || !endpointOrigin) return { found };
    const accepted = { token, origin: endpointOrigin };
    if (target) return { found, run: () => instances.repairInstance(target.id, accepted.token) };
    return {
      found,
      run: () => instances.addInstance({
        label: cleanLabel,
        origin: accepted.origin,
        token: accepted.token,
        switchTo: switchAfterAdding,
      }),
    };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current) return;
    setFailure(null);
    const { found, run } = validate();
    setErrors(found);
    const first = FIELD_ORDER[mode].find((field) => found[field]);
    if (first || !run) {
      if (first) fieldRefs.current[first]?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await run();
      pairingLink.clear();
      pairingCode.clear();
      busyRef.current = false;
      props.onClose();
    } catch (cause) {
      busyRef.current = false;
      setBusy(false);
      setFailure(remoteInstanceFailure(cause, mode));
    }
  };

  const errorOrHelper = (field: RemoteInstanceField, helper?: ReactNode) => errors[field]
    ? <FieldError id={id(`${field}-error`)}>{errors[field]}</FieldError>
    : helper ? <p className="field-helper" id={id(`${field}-helper`)}>{helper}</p> : null;
  const describedBy = (field: RemoteInstanceField, helper: boolean) =>
    errors[field] ? id(`${field}-error`) : helper ? id(`${field}-helper`) : undefined;
  const invalid = (field: RemoteInstanceField) => (errors[field] ? true : undefined);

  const nameField = (
    <div className="field">
      <label className="field-label" htmlFor={id("label")}>Instance Name</label>
      <input
        id={id("label")}
        ref={fieldRef("label")}
        value={label}
        maxLength={100}
        disabled={busy}
        autoComplete="off"
        placeholder="e.g. Home Workstation"
        aria-invalid={invalid("label")}
        aria-describedby={describedBy("label", true)}
        onChange={(event) => {
          setLabel(event.target.value);
          changed("label");
        }}
      />
      {errorOrHelper("label", "Name the instance so you can find it in the switcher.")}
    </div>
  );

  const linkField = (labelText: string, helper: ReactNode, placeholder: string) => (
    <div className="field">
      <label className="field-label" htmlFor={id("link")}>{labelText}</label>
      <input
        id={id("link")}
        ref={fieldRef("link", pairingLink.ref)}
        type="password"
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={invalid("link")}
        aria-describedby={describedBy("link", true)}
        onChange={(event) => {
          pairingLink.remember(event);
          changed("link");
        }}
      />
      {errorOrHelper("link", helper)}
    </div>
  );

  const originInput = (
    <input
      id={id("origin")}
      ref={fieldRef("origin")}
      value={origin}
      disabled={busy}
      autoComplete="off"
      spellCheck={false}
      inputMode="url"
      placeholder="https://studio.example.com"
      aria-invalid={invalid("origin")}
      aria-describedby={describedBy("origin", false) ?? (mode === "add" ? id("code-helper") : undefined)}
      onChange={(event) => {
        setOrigin(event.target.value);
        // A changed address can hide the replacement link's field, so its error goes too.
        changed("origin", "link");
      }}
    />
  );

  const codeField = (
    <div className="field">
      <label className="field-label" htmlFor={id("token")}>Pairing Code</label>
      <input
        id={id("token")}
        ref={fieldRef("token", pairingCode.ref)}
        type="password"
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid("token")}
        aria-describedby={describedBy("token", false) ?? id("code-helper")}
        onChange={(event) => {
          pairingCode.remember(event);
          changed("token");
        }}
      />
      {errorOrHelper("token")}
    </div>
  );

  const connectWithField = (
    <div className="field">
      <span className="field-label" aria-hidden="true">Connect With</span>
      <SegmentedControl
        label="Connect With"
        options={CONNECT_WITH_OPTIONS}
        value={connectWith}
        onChange={(next) => {
          setConnectWith(next);
          // The other way of connecting has other fields; nothing it said stays on screen.
          changed("link", "origin", "token");
        }}
      />
    </div>
  );

  const name = profile?.label ?? "";
  const status = profile ? instances.statusByProfile[profile.id]?.availability : undefined;
  const pairingRequired = status === "authentication-required" || status === "missing-credential";
  const description = mode === "add" ? "Use Wollipog running on another computer from this app."
    : mode === "edit" ? "Change the name or the address this app uses."
      : pairingRequired ? `${name} no longer accepts this app's saved pairing.`
        : `Replace this app's saved pairing for ${name}.`;

  return (
    <Modal
      title={TITLES[mode]}
      description={description}
      onClose={requestClose}
      {...(props.returnFocusRef ? { returnFocusRef: props.returnFocusRef } : {})}
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={requestClose}>Cancel</button>
          <BusyButton type="submit" className="btn primary" form={id("form")} busy={busy} progress={SUBMIT[mode].progress}>
            {SUBMIT[mode].label}
          </BusyButton>
        </>
      )}
    >
      <form id={id("form")} className="form" noValidate onSubmit={(event) => void submit(event)}>
        {mode !== "repair" && nameField}
        {mode === "edit" && (
          <>
            <div className="field">
              <label className="field-label" htmlFor={id("origin")}>Server Address</label>
              {originInput}
              {errorOrHelper("origin")}
            </div>
            {editNeedsLink && linkField(
              "Pairing Link for the New Address",
              "A new address needs a fresh pairing link, so the saved credential is never sent to an unverified server.",
              "https://new-address/#pair=…",
            )}
          </>
        )}
        {mode === "repair" && (
          <div className="field">
            <label className="field-label" htmlFor={id("saved-origin")}>Server Address</label>
            <input
              id={id("saved-origin")}
              className="is-read-only remote-instance-address"
              readOnly
              value={profile!.origin}
              spellCheck={false}
            />
          </div>
        )}
        {mode !== "edit" && connectWithField}
        {mode !== "edit" && connectWith === "link" && linkField(
          "Pairing Link",
          mode === "add"
            ? "On the other computer, choose Pair Device… in Connections › People and Devices, then copy the link."
            : `On ${name}, choose Pair Device… in Connections › People and Devices, then paste the new link here.`,
          "https://studio.example.com/#pair=…",
        )}
        {mode === "add" && connectWith === "code" && (
          <div className="remote-instance-code">
            <div className="field-row">
              <div className="field">
                <label className="field-label" htmlFor={id("origin")}>Server Address</label>
                {originInput}
                {errorOrHelper("origin")}
              </div>
              {codeField}
            </div>
            <p className="field-helper" id={id("code-helper")}>
              Both come from Pair Device… › Manual Setup on the other computer.
            </p>
          </div>
        )}
        {mode === "repair" && connectWith === "code" && (
          <div className="remote-instance-code">
            {codeField}
            <p className="field-helper" id={id("code-helper")}>
              It comes from Pair Device… › Manual Setup on {name}.
            </p>
          </div>
        )}
        {mode === "add" && (
          <Checkbox
            label="Switch After Adding"
            checked={switchAfterAdding}
            disabled={busy}
            onChange={setSwitchAfterAdding}
          />
        )}
        {failure && (
          <Notice
            tone="danger"
            role="alert"
            title={failure.title}
            details={failure.detail ? <code>{failure.detail}</code> : undefined}
          >
            {failure.message}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
