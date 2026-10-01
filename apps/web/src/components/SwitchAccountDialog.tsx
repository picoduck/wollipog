import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  pendingRequests,
  type ProviderAccountDefinition,
  type SessionProviderAccountOption,
  type SessionProviderAccountUnavailable,
  type SessionView,
} from "@wollipog/protocol";
import { accountUnavailableReason, derivedAccountUnavailableReason } from "../account-unavailable-reasons.js";
import { useApi } from "../api-context.js";
import { isPersonalIdentifier } from "../personal-identifiers.js";
import { Modal } from "./common.js";
import { AccountRows, AccountsHead, type AccountRowAccount, type CurrentAccountRow } from "./AccountChoice.js";
import { Notice } from "./Notice.js";
import { usePersonalIdentifierReveal } from "./PersonalIdentifier.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Whether Switch Account… applies: the session is bound to an account of a provider that can
 * continue its conversation under another one. */
export function sessionAccountSwitchApplicable(session: Pick<SessionView, "providerAccountId" | "driver">): boolean {
  return Boolean(session.providerAccountId) &&
    (session.driver === "claude-code" || session.driver === "codex" || session.driver === "codex-app-server");
}

function accountProvider(driver: SessionView["driver"]): ProviderAccountDefinition["provider"] {
  return driver === "claude-code" ? "claude" : "codex";
}

function listedAccount(option: SessionProviderAccountOption): AccountRowAccount {
  return { id: option.id, label: option.label, buckets: option.buckets, stale: option.freshness === "stale" };
}

/**
 * Continue a session's provider conversation under another account on its Machine (#2149).
 *
 * The session's own account leads the list as a row that cannot be chosen, so the person compares
 * it with the others instead of reading it out of a sentence. When the account was removed from
 * the Machine (#1773) that row says so; the switch still works, because the session keeps its
 * sign-in until it moves. Every other account of the provider is listed: the ones the switch
 * endpoint offers can be chosen, and the rest are rows with the reason they cannot.
 */
export function SwitchAccountDialog({
  session,
  machineName,
  machineAccounts,
  onClose,
  onSwitched,
  onOpenConnections,
  returnFocusRef,
}: {
  session: Pick<SessionView, "id" | "driver" | "providerAccountId" | "providerAccountLabel" | "pendingApproval">;
  /** The Machine's name, for the description and the removed-account sentence. */
  machineName?: string;
  /** The Machine's provider accounts, as the dashboard last received them. Unknown when absent, so
   * the current account is then never called removed. */
  machineAccounts?: readonly ProviderAccountDefinition[];
  onClose: () => void;
  onSwitched: (scheduled: boolean) => void;
  /** Opens Connections, where another account is signed in. */
  onOpenConnections?: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const [options, setOptions] = useState<SessionProviderAccountOption[] | null>(null);
  // The accounts the endpoint will not offer, with its reasons; null from an older control plane.
  const [unavailableAccounts, setUnavailableAccounts] = useState<SessionProviderAccountUnavailable[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  // Whether focus was last inside this dialog. A commit that unmounts the focused control (rows
  // replaced by a reload) drops focus to <body> without a focusin, so this stays true across it.
  const focusInsideRef = useRef(false);
  const rowsId = useId();
  const reasonId = useId();

  const machine = machineName || "this machine";
  const provider = accountProvider(session.driver);
  const providerName = provider === "claude" ? "Claude" : "Codex";
  const currentId = session.providerAccountId ?? "";

  useEffect(() => {
    let cancelled = false;
    // A new current account is a new list: nothing chosen from the old one can be submitted, and
    // the old rows are not shown as if they were current.
    setOptions(null);
    setUnavailableAccounts(null);
    setSelectedId(null);
    setLoadError(null);
    void api.sessionProviderAccounts(session.id).then((response) => {
      if (cancelled) return;
      setLoadError(null);
      setOptions(response.accounts);
      setUnavailableAccounts(Array.isArray(response.unavailable) ? response.unavailable : null);
      // The first account that can take over; the session's own account only when it is the one
      // offered (a failed switch to it being retried).
      const others = response.accounts.filter((account) => account.id !== currentId);
      setSelectedId((others[0] ?? response.accounts[0])?.id ?? null);
    }).catch((cause) => {
      if (!cancelled) setLoadError((cause as Error).message);
    });
    return () => { cancelled = true; };
  }, [api, session.id, currentId]);

  useEffect(() => {
    const document = dismissRef.current?.ownerDocument;
    if (!document) return;
    const track = (event: FocusEvent) => {
      const dialog = dismissRef.current?.closest('[role="dialog"]');
      focusInsideRef.current = Boolean(dialog && event.target instanceof Node && dialog.contains(event.target));
    };
    document.addEventListener("focusin", track);
    return () => document.removeEventListener("focusin", track);
  }, []);
  // After every commit: focus that was in the dialog and is now lost goes to Cancel (or Done), which
  // every state renders, or to the dialog itself while a switch disables it. Focus that is still
  // somewhere is never moved.
  useLayoutEffect(() => {
    const dismiss = dismissRef.current;
    const active = dismiss?.ownerDocument.activeElement;
    if (!dismiss || !focusInsideRef.current) return;
    if (active && active !== dismiss.ownerDocument.body && active.isConnected) return;
    const target = dismiss.disabled ? dismiss.closest<HTMLElement>('[role="dialog"]') : dismiss;
    target?.focus();
  });

  const close = () => {
    if (!submittingRef.current) onClose();
  };

  const submit = async () => {
    if (submittingRef.current || !selectedId || options === null || loadError !== null) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.switchSessionProviderAccount(session.id, selectedId);
      onClose();
      onSwitched(result.scheduled);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // The endpoint's options are authoritative: an account it offers can always be chosen. Other
  // accounts of the provider on the Machine are listed after them, each with why it cannot: the
  // endpoint's own list and reasons when it sends them (#2276), otherwise the dashboard's Machine
  // inventory with reasons derived from what it knows.
  const machineAccount = machineAccounts?.find((account) => account.id === currentId);
  const currentOption = options?.find((account) => account.id === currentId);
  const offered = new Set(options?.map((account) => account.id) ?? []);
  const now = Date.now();
  const unavailableRows: AccountRowAccount[] = unavailableAccounts
    ? unavailableAccounts
      .filter((account) => account.id !== currentId && !offered.has(account.id))
      .map((account) => ({ id: account.id, label: account.label, disabledReason: accountUnavailableReason(account, machine, now) }))
    : (machineAccounts ?? [])
      .filter((account) => account.provider === provider && account.id !== currentId && !offered.has(account.id))
      .map((account) => ({ id: account.id, label: account.label, disabledReason: derivedAccountUnavailableReason(account, machine) }));
  const accounts: AccountRowAccount[] = options === null ? [] : [
    ...options.filter((account) => account.id !== currentId).map(listedAccount),
    ...unavailableRows,
  ];
  const current: CurrentAccountRow | null = currentId ? {
    id: currentId,
    // The session keeps the label it was bound with, even if the Machine's account was renamed.
    label: session.providerAccountLabel ?? machineAccount?.label ?? currentOption?.label ?? "Current Account",
    ...(machineAccounts && !machineAccount ? { removedFrom: machine } : {}),
    ...(currentOption ? { buckets: currentOption.buckets, stale: currentOption.freshness === "stale", selectable: true } : {}),
  } : null;
  const noOthers = options !== null && accounts.length === 0 && !currentOption;
  const canChoose = Boolean(currentOption) || accounts.some((account) => account.disabledReason === undefined);

  // One deliberate reveal for every row (rows are radios inside labels and cannot nest a control),
  // bound to this exact list so a changed list starts hidden again.
  const shownLabels = [...(current && !current.removedFrom ? [current.label] : []), ...accounts.map((account) => account.label)];
  const [revealed, toggleReveal] = usePersonalIdentifierReveal(shownLabels.join("\n"));

  // A message sent while the session waits for sign-in stays with that sign-in (#1668), so the body
  // promises the queue moves only when nothing is waiting for authentication.
  const authenticationBlocked = pendingRequests(session.pendingApproval)
    .some((request) => request.kind === "authentication");

  const unavailable = options !== null && !noOthers && !canChoose;
  const ready = options !== null && loadError === null;
  return (
    <Modal
      title="Switch Account"
      description={`Continue this conversation with another ${providerName} account on ${machine}.`}
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      // One structure for every state, so the dismiss button is the same element when a load turns
      // Cancel into Done and keeps the focus a person put on it.
      footer={(
        <>
          {unavailable && (
            <p className="switch-account-reason" id={reasonId}>None of these accounts can take over right now.</p>
          )}
          <button ref={dismissRef} className="btn" type="button" onClick={close} disabled={submitting}>
            {noOthers ? "Done" : "Cancel"}
          </button>
          {!noOthers && (
            <BusyButton
              className="btn primary"
              busy={submitting}
              progress="Switching the account…"
              disabled={!ready || !selectedId}
              aria-describedby={unavailable ? reasonId : undefined}
              onClick={() => void submit()}
            >
              Switch Account
            </BusyButton>
          )}
        </>
      )}
    >
      {noOthers ? (
        <State
          compact
          title="No Other Accounts"
          actions={onOpenConnections && (
            <button className="btn" type="button" onClick={() => { onClose(); onOpenConnections(); }}>
              Open Connections
            </button>
          )}
        >
          Sign in to another {providerName} account on {machine}, then switch here.
        </State>
      ) : (
        <>
          <p className="switch-account-rule">
            A turn that is running finishes on the current account.
            {!authenticationBlocked && " Queued messages go to the new one."}
          </p>
          {loadError ? (
            <State variant="error" compact title="Accounts Unavailable">{loadError}</State>
          ) : options === null ? (
            <State variant="loading" compact>Loading accounts…</State>
          ) : (
            <section className="switch-account-accounts" aria-labelledby={`${rowsId}-title`}>
              <AccountsHead
                titleId={`${rowsId}-title`}
                revealable={shownLabels.some(isPersonalIdentifier)}
                revealed={revealed}
                onToggleReveal={toggleReveal}
                controls={rowsId}
              />
              <AccountRows
                id={rowsId}
                current={current}
                accounts={accounts}
                value={selectedId}
                onChange={setSelectedId}
                revealed={revealed}
                disabled={submitting}
              />
            </section>
          )}
          {error && <Notice tone="danger" role="alert">{error}</Notice>}
        </>
      )}
    </Modal>
  );
}
