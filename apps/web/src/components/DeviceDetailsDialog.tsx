import React from "react";
import type { DeviceView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { relativeTime, titleCaseLabel } from "../format.js";
import { isPersonalIdentifier } from "../personal-identifiers.js";
import { Modal } from "./common.js";
import { ConfirmationFailure, useFeedback } from "./FeedbackProvider.js";
import { DeleteIcon } from "./Icons.js";
import { PersonalIdentifier } from "./PersonalIdentifier.js";
import { revokeDeviceMessage } from "./people-device-rows.js";

const pairedDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** When a device was paired, relative, with the exact date in its tooltip (§5.4). */
export function PairedTime({ at }: { at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()} title={pairedDateFormat.format(date)}>{relativeTime(at)}</time>;
}

/**
 * The one Revoke Device confirmation, opened from a desktop row's Revoke… and from Device Details'
 * Revoke Device… (#2997). It names the device and whose it is, with an email-shaped name masked and
 * revealable in the sentence. The revocation runs inside the confirmation, so a failure stays in view
 * there (§7.4); opened from Device Details on a phone, it replaces that sheet with Back (§7.5).
 * Resolves true once the device is revoked and `onRevoked` has run.
 */
export function useRevokeDevice(onRevoked: () => Promise<void>): (device: DeviceView) => Promise<boolean> {
  const api = useApi();
  const { confirm } = useFeedback();
  return async (device) => {
    const masked = isPersonalIdentifier(device.userName);
    const revoked = await confirm({
      title: "Revoke Device",
      message: revokeDeviceMessage(device.name, masked ? "this person" : device.userName),
      messageContent: masked
        ? <>“{device.name}” stops working for <PersonalIdentifier value={device.userName} label="Person Name" /> right away. To use it again, pair it again.</>
        : undefined,
      confirmLabel: "Revoke Device",
      tone: "danger",
      progress: "Revoking the device…",
      onConfirm: async () => {
        try {
          await api.revokeDevice(device.deviceId);
        } catch (cause) {
          throw new ConfirmationFailure("Wollipog didn't revoke the device. Try again.", (cause as Error).message);
        }
      },
      // A revocation can't be withdrawn once sent, so Cancel would only hide its outcome.
      cancelWhileRunning: false,
    });
    if (revoked) await onRevoked();
    return revoked;
  };
}

/**
 * Device Details (#2997): the device's facts and, where this dashboard can revoke, Revoke Device… as
 * the footer's destructive tertiary. Done only closes (§7.3). A paired dashboard cannot revoke, so it
 * says where to do that instead.
 */
export function DeviceDetailsDialog({
  device,
  canRevoke,
  onRevoke,
  onClose,
}: {
  device: DeviceView;
  canRevoke: boolean;
  onRevoke: (device: DeviceView) => Promise<boolean>;
  onClose: () => void;
}) {
  const revoke = async () => {
    if (await onRevoke(device)) onClose();
  };
  return (
    <Modal
      title={device.name}
      size="sm"
      onClose={onClose}
      tertiary={canRevoke && (
        <button type="button" className="btn ghost danger" aria-haspopup="dialog" onClick={() => void revoke()}>
          <DeleteIcon />
          <span>Revoke Device…</span>
        </button>
      )}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <dl className="facts">
        <div>
          <dt>Person</dt>
          <dd><PersonalIdentifier value={device.userName} label="Person Name" /></dd>
        </div>
        <div>
          <dt>Access Level</dt>
          <dd>{titleCaseLabel(device.role)}</dd>
        </div>
        <div>
          <dt>Paired</dt>
          <dd><PairedTime at={device.createdAt} /></dd>
        </div>
        <div>
          <dt>Last Used</dt>
          <dd>{device.lastSeenAt == null ? "Never" : relativeTime(device.lastSeenAt)}</dd>
        </div>
      </dl>
      {!canRevoke && <p className="facts-note">Revoke devices from the computer running Wollipog.</p>}
    </Modal>
  );
}
