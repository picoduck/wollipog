import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { DEVICE_TOKEN_CHANGED_EVENT, parsePairingInput, storeDeviceToken } from "../device-token.js";
import type { ConnState } from "../store.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { CodeWell } from "./RunnerSetupParts.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useSecretInput } from "./ui/secret-input.js";

export const PAIRING_INPUT_EMPTY = "Paste the pairing link from the computer running Wollipog.";
export const PAIRING_INPUT_INVALID = "This isn't a pairing link or code. Copy the whole link, including #pair=.";

/** What a stored link's connection attempt ended in, when it did not open. */
type Failure = "refused" | "unreachable";

const FAILURES: Record<Failure, { title: string; message: string }> = {
  refused: {
    title: "Wollipog Didn't Accept This Link",
    message: "It may have been used already or revoked. Create a new one with Pair Device… and paste it here.",
  },
  unreachable: {
    title: "Couldn't Reach Wollipog",
    message: "Wollipog didn't answer, so the link wasn't checked. Try again in a moment.",
  },
};

export interface PairThisDeviceDialogProps {
  /** The connection's state, from the store: it says whether the stored link was accepted. */
  conn: ConnState;
  onClose: () => void;
}

/**
 * Pair This Device (#3005; docs/design-system.md §7, §8, §12.5): the paste-a-link way in for a
 * browser or installed app that is not paired, opened from the pairing banner, which holds no form.
 *
 * Parsing, storage and the in-process reconnect are the banner's as they were: `parsePairingInput`,
 * `storeDeviceToken` and `DEVICE_TOKEN_CHANGED_EVENT`, never a reload, which would drop the in-memory
 * copy that is the only one when storage is blocked. The pasted value is read on submit and never
 * kept in state or the DOM (#3814).
 *
 * A paste that does not parse is the field's error (§8.5). One that parses is stored, and the
 * dialog waits on the connection it reopens: an accepted one ends the pairing state, which closes
 * the dialog with the banner; another policy close (1008) is the titled danger Notice above the
 * footer. Closing the dialog while it waits leaves that attempt running.
 */
export function PairThisDeviceDialog({ conn, onClose }: PairThisDeviceDialogProps) {
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const link = useSecretInput();
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const keepLink = link.ref;
  const attachField = useCallback((node: HTMLInputElement | null) => {
    fieldRef.current = node;
    keepLink(node);
  }, [keepLink]);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  // "sent": the link is stored and the reconnect requested; "opening": that connection is opening.
  const [attempt, setAttempt] = useState<"sent" | "opening" | null>(null);

  useEffect(() => {
    if (attempt === "sent" && conn === "connecting") setAttempt("opening");
    if (attempt !== "opening" || conn === "connecting") return;
    setAttempt(null);
    if (conn === "online") onClose();
    else setFailure(conn === "unauthorized" ? "refused" : "unreachable");
  }, [attempt, conn, onClose]);

  const busy = attempt !== null;
  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    const value = link.read();
    const parsed = parsePairingInput(value);
    if (!parsed) {
      setError(value.trim() ? PAIRING_INPUT_INVALID : PAIRING_INPUT_EMPTY);
      fieldRef.current?.focus();
      return;
    }
    setError(null);
    storeDeviceToken(parsed);
    link.clear();
    setAttempt("sent");
    window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
  };

  return (
    <Modal
      title="Pair This Device"
      description="Paste the pairing link from the computer running Wollipog."
      onClose={onClose}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <BusyButton type="submit" className="btn primary" form={id("form")} busy={busy} progress="Pairing this device…">
            Pair This Device
          </BusyButton>
        </>
      )}
    >
      <form id={id("form")} className="form" noValidate onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor={id("link")}>Pairing Link or Code</label>
          <input
            id={id("link")}
            ref={attachField}
            type="password"
            maxLength={2048}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? id("error") : id("helper")}
            onChange={(event) => {
              link.remember(event);
              setError(null);
              setFailure(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit(event);
            }}
          />
          {error
            ? <FieldError id={id("error")}>{error}</FieldError>
            : <p className="field-helper" id={id("helper")}>The link opens this page on its own; pasting it here works too.</p>}
        </div>
        <details className="disclosure">
          <summary><ChevronRightIcon size={14} className="disclosure-chevron" />Where Do I Find the Link?</summary>
          <div className="disclosure-body">
            <p>
              On the computer running Wollipog, choose Pair Device… in Connections › People and Devices.
              If you can't open Wollipog there, run this in its terminal:
            </p>
            <CodeWell value="wollipog pair url" name="Pairing Command" />
            <p>or start Wollipog with <code>--print-pair-url</code>.</p>
          </div>
        </details>
        {failure && (
          <Notice tone="danger" role="alert" title={FAILURES[failure].title}>
            {FAILURES[failure].message}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
