import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import type { IdentityAdministrationView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { pairingLinks, sameComputerPairingLink, type PairingBlocker, type PairingReach } from "../device-token.js";
import { titleCaseLabel } from "../format.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { viewPath } from "../navigation.js";
import { useOptionalNavigate } from "../store.js";
import { CopyButton, Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import {
  ADDRESS_HELPER,
  DEVICE_NAME_HELPER,
  DEVICE_NAME_REQUIRED,
  MANUAL_SETUP_NOTE,
  PAIR_STEP_DEVICE,
  PAIR_STEP_PERSON,
  pairingBlockedCopy,
  SAME_COMPUTER,
  SCAN_OR_COPY,
  SHOWN_ONCE,
  SUSPENDED_REASON,
} from "./pair-device-copy.js";
import { PersonalIdentifier, PersonalIdentifierRevealButton, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows, Select } from "./ui/ChoiceControls.js";
import { useIsMobile } from "./useIsMobile.js";

const QRCodeSVG = lazy(() => import("qrcode.react").then((module) => ({ default: module.QRCodeSVG })));

/** The device's credential, shown once: kept only in this dialog's state, never re-fetched. */
interface PairingResult {
  token: string;
  links: string[];
  blocked: PairingBlocker | null;
  /** The remote-access setup's own message, for Show Details. */
  remoteAccessMessage?: string;
  /** As created, so a list refresh that renames or suspends the person never rewrites the result. */
  deviceName: string;
  personName: string;
}

/** A failure in the person's words (§8.5, §13.2): the server's own text only behind Show Details. */
interface Failure {
  title: string;
  sentence: string;
  detail: string;
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Pair Device (docs/design-system.md §7.1–§7.5, #2999): one title over two steps and the result,
 * each named by the description line, in one dialog anchored near the top so its top edge never
 * moves between them. Pair Device… creates the pairing link; Add Remote Instance… and Pair This
 * Device… on the other device use it.
 */
export function PairDeviceDialog({
  identity,
  onClose,
  onSaved,
}: {
  identity: IdentityAdministrationView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const api = useApi();
  const navigate = useOptionalNavigate();
  const phone = useIsMobile();
  const ids = useId();
  const formId = `${ids}-form`;
  const resultId = `${ids}-result`;
  const personLabelId = `${ids}-person`;
  const personGroupId = `${ids}-people`;
  const nameInputId = `${ids}-name`;
  const nameHelperId = `${ids}-name-helper`;
  const nameErrorId = `${ids}-name-error`;

  // Every member, in the page's order (#2997). A suspended person is listed with the reason they
  // can't be chosen instead of silently disappearing.
  const people = useMemo(
    () => [...identity.memberships].sort((a, b) => a.userName.localeCompare(b.userName)),
    [identity.memberships],
  );
  const names = people.map((member) => member.userName);
  const titles = maskedAccountTitles(names, "Hidden Name");
  const [namesRevealed, toggleNames] = usePersonalIdentifierReveal(names.join("\n"));

  const [step, setStep] = useState<"person" | "device" | "result">("person");
  const [userId, setUserId] = useState(() => {
    const active = people.filter((member) => member.userStatus === "active");
    return active.some((member) => member.userId === identity.context.userId)
      ? identity.context.userId
      : active[0]?.userId ?? "";
  });
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const [result, setResult] = useState<PairingResult | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const person = people.find((member) => member.userId === userId && member.userStatus === "active");

  // A step change replaces the footer button that had focus, so focus moves into the new step: the
  // chosen person, the device name (with a fine pointer only, so a phone's keyboard does not cover
  // a sheet the person has not read yet, as Modal does on open), or Copy Pairing Link.
  const shownStepRef = useRef(step);
  useEffect(() => {
    if (shownStepRef.current === step) return;
    shownStepRef.current = step;
    const fine = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
    const body = document.getElementById(step === "person" ? personGroupId : step === "device" ? formId : resultId);
    const target = step === "person" ? body?.querySelector<HTMLElement>("input:checked")
      : step === "device" ? (fine ? nameRef.current : null)
        : body?.querySelector<HTMLElement>("button");
    (target ?? body?.closest<HTMLElement>('[role="dialog"]'))?.focus();
  }, [step, personGroupId, formId, resultId]);

  const requestClose = () => {
    if (!busyRef.current) onClose();
  };
  const backToPerson = () => {
    if (busyRef.current) return;
    setFailure(null);
    setStep("person");
  };
  const openNetworkSettings = () => {
    const network = { name: "settings", section: "network" } as const;
    // Where no app store is mounted (a harness), the address still leads there.
    if (navigate) navigate(network);
    else window.location.assign(viewPath(network));
    onClose();
  };

  const submit = async () => {
    if (busyRef.current || !person) return;
    const deviceName = name.trim();
    if (!deviceName) {
      setNameError(DEVICE_NAME_REQUIRED);
      setNameEdited(true);
      nameRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    let response: Awaited<ReturnType<typeof api.pairDevice>>;
    try {
      response = await api.pairDevice(deviceName, person.userId);
    } catch (cause) {
      busyRef.current = false;
      setBusy(false);
      setFailure({
        title: "Couldn't Create the Pairing Link",
        sentence: "Nothing was created. Try again.",
        detail: failureDetail(cause),
      });
      return;
    }

    // The credential is returned exactly once. Reveal it as soon as creation succeeds; refreshing
    // the surrounding lists is useful but must never make the only plaintext copy inaccessible.
    const reach: PairingReach = response.pairing;
    setResult({
      token: response.token,
      ...pairingLinks(response.token, reach),
      remoteAccessMessage: reach.remoteAccess?.message,
      deviceName,
      personName: person.userName,
    });
    setStep("result");
    busyRef.current = false;
    setBusy(false);
    try {
      await onSaved();
    } catch (cause) {
      if (mountedRef.current) setRefreshFailure(failureDetail(cause));
    }
  };

  const shown = step === "result" && result ? result : null;
  return (
    <Modal
      title="Pair Device"
      description={shown
        ? <>{shown.deviceName} is ready to pair for <PersonalIdentifier value={shown.personName} label="Person Name" />.</>
        : step === "person" ? PAIR_STEP_PERSON : PAIR_STEP_DEVICE}
      onClose={requestClose}
      grows
      // A phone sheet's header Back returns a step (§7.5); desktop keeps Close.
      back={phone && step === "device" ? { label: "Back", onBack: backToPerson } : undefined}
      footer={shown
        // Close-only (§7.3): one secondary Done.
        ? <button type="button" className="btn" onClick={onClose}>Done</button>
        : step === "person"
          ? (
            <>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => setStep("device")} disabled={!person}>Continue</button>
            </>
          )
          : (
            <>
              <button type="button" className="btn" onClick={backToPerson} disabled={busy}>Back</button>
              <BusyButton className="btn primary" type="submit" form={formId} busy={busy} progress="Creating the pairing link…">
                Create Pairing Link
              </BusyButton>
            </>
          )}
    >
      {shown ? (
        <PairingResultBody
          id={resultId}
          result={shown}
          refreshFailure={refreshFailure}
          onOpenNetworkSettings={openNetworkSettings}
        />
      ) : step === "person" ? (
        <div className="field">
          <div className="field-head pid-field-head">
            <span id={personLabelId}>Person</span>
            {names.some((value) => isPersonalIdentifier(value)) && (
              <PersonalIdentifierRevealButton
                label="Names"
                revealed={namesRevealed}
                onToggle={toggleNames}
                controls={personGroupId}
                withText
              />
            )}
          </div>
          <ChoiceRows<string>
            id={personGroupId}
            label="Person"
            labelledBy={personLabelId}
            value={userId || null}
            onChange={setUserId}
            options={people.map((member, index) => ({
              value: member.userId,
              title: namesRevealed ? member.userName : titles[index]!,
              meta: titleCaseLabel(member.role),
              ...(member.userStatus === "active" ? {} : { disabled: true, disabledReason: SUSPENDED_REASON }),
            }))}
          />
        </div>
      ) : (
        <form
          id={formId}
          className="form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {person && (
            <p className="for-line">
              <span>
                For <PersonalIdentifier value={person.userName} label="Person Name" /> ({titleCaseLabel(person.role)})
              </span>
              <button type="button" className="link" onClick={backToPerson} disabled={busy}>Change</button>
            </p>
          )}
          <div className="field">
            <div className="field-head"><label htmlFor={nameInputId}>Device Name</label></div>
            <input
              ref={nameRef}
              id={nameInputId}
              value={name}
              autoComplete="off"
              readOnly={busy}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? nameErrorId : nameHelperId}
              onChange={(event) => {
                setNameEdited(true);
                setName(event.target.value);
                // An error showing clears as soon as the value is valid (§8.5).
                if (nameError && event.target.value.trim()) setNameError(null);
              }}
              onBlur={() => {
                if (nameEdited && !busyRef.current && !name.trim()) setNameError(DEVICE_NAME_REQUIRED);
              }}
            />
            {nameError
              ? <FieldError id={nameErrorId}>{nameError}</FieldError>
              : <p className="field-helper" id={nameHelperId}>{DEVICE_NAME_HELPER}</p>}
          </div>
          {failure && (
            <Notice
              tone="danger"
              role="alert"
              title={failure.title}
              details={<div className="code-well"><code>{failure.detail}</code></div>}
            >
              {failure.sentence}
            </Notice>
          )}
        </form>
      )}
    </Modal>
  );
}

/**
 * The result: the one-time warning, then either the QR beside its address and Copy Pairing Link,
 * or why no other device can reach this computer, then Manual Setup. Manual Setup's values reach
 * the DOM only while it is open, and an address option's value is its index, never the link.
 */
function PairingResultBody({
  id,
  result,
  refreshFailure,
  onOpenNetworkSettings,
}: {
  id: string;
  result: PairingResult;
  refreshFailure: string | null;
  onOpenNetworkSettings: () => void;
}) {
  const ids = useId();
  const addressHelperId = `${ids}-address-helper`;
  const sameComputerId = `${ids}-same-computer`;
  const [linkIndex, setLinkIndex] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const fragment = `#pair=${result.token}`;
  const link = result.links[linkIndex] ?? result.links[0] ?? null;
  const localLink = link ? null : sameComputerPairingLink(result.token, window.location.origin);
  const blocked = result.blocked ? pairingBlockedCopy(result.blocked, result.remoteAccessMessage) : null;

  return (
    <>
      <Notice tone="warning" compact>{SHOWN_ONCE}</Notice>
      {link ? (
        <div className="pair-result">
          <div className="pair-qr">
            <Suspense fallback={<State variant="loading" compact>Loading the code…</State>}>
              <QRCodeSVG value={link} title={`Pair ${result.deviceName} with Wollipog`} size={176} level="M" marginSize={4} />
            </Suspense>
          </div>
          <div className="pair-result-side">
            {result.links.length > 1 && (
              <div className="field">
                <span className="field-label">Network Address</span>
                <Select<string>
                  label="Network Address"
                  describedBy={addressHelperId}
                  value={String(linkIndex)}
                  onChange={(value) => setLinkIndex(Number(value))}
                  options={result.links.map((each, index) => ({ value: String(index), label: new URL(each).host }))}
                />
                <p className="field-helper" id={addressHelperId}>{ADDRESS_HELPER}</p>
              </div>
            )}
            <p className="pair-note">{SCAN_OR_COPY}</p>
            <div className="pair-copy" id={id}>
              <CopyButton text={link} label="Copy Pairing Link" className="btn" />
            </div>
          </div>
        </div>
      ) : blocked && (
        <>
          <Notice
            tone="warning"
            title={blocked.title}
            actions={blocked.networkSettings && (
              <button type="button" className="btn sm" onClick={onOpenNetworkSettings}>Open Network Settings</button>
            )}
            details={blocked.details && (
              <>
                <p className="pair-note">{blocked.details.sentence}</p>
                {blocked.details.command && <div className="code-well"><code>{blocked.details.command}</code></div>}
              </>
            )}
          >
            {blocked.sentence}
          </Notice>
          <div className="pair-copy" id={id}>
            <CopyButton
              text={localLink ?? fragment}
              label="Copy Pairing Link"
              className="btn"
              describedBy={localLink ? sameComputerId : undefined}
            />
            {localLink && <p className="field-helper" id={sameComputerId}>{SAME_COMPUTER}</p>}
          </div>
        </>
      )}
      {refreshFailure && (
        <Notice
          tone="warning"
          title="Couldn't Refresh Paired Devices"
          details={<div className="code-well"><code>{refreshFailure}</code></div>}
        >
          The device was created. Reload the page to see it in the list.
        </Notice>
      )}
      <details className="disclosure" open={manualOpen} onToggle={(event) => setManualOpen(event.currentTarget.open)}>
        <summary><ChevronRightIcon className="disclosure-chevron" />Manual Setup</summary>
        {manualOpen && (
          <div className="disclosure-body pair-manual">
            <p className="pair-note">{MANUAL_SETUP_NOTE}</p>
            <div className="field">
              <span className="field-label">Pairing Fragment</span>
              <OneLineCodeWell value={fragment} name="Pairing Fragment" />
            </div>
            <div className="field">
              <span className="field-label">Pairing Code</span>
              <OneLineCodeWell value={result.token} name="Pairing Code" />
            </div>
          </div>
        )}
      </details>
    </>
  );
}
