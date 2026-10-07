import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  runnerSupportsProtocol,
  type PendingApproval,
  type ProviderAuthenticationAccountOption,
  type RunnerView,
  type SessionView,
} from "@wollipog/protocol";
import { ApiError } from "../../api.js";
import { useApi } from "../../api-context.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../../personal-identifiers.js";
import { statusMeta, type StatusValue } from "../../status-meta.js";
import { AccountRows, AccountsHead, type AccountRowAccount } from "../AccountChoice.js";
import { useAccountIdentifierReveal } from "../AccountIdentifier.js";
import { UserXIcon } from "../Icons.js";
import { Modal } from "../Modal.js";
import { Notice } from "../Notice.js";
import { ProviderLoginCard } from "../ProviderLoginCard.js";
import { State } from "../State.js";
import { StatusBadge } from "../StatusBadge.js";
import { BusyButton } from "../ui/BusyButton.js";

/** The dialog's own words (§17): labels are Title Case, the rest are sentences. */
export const CHOOSE_ACCOUNT_COPY = {
  title: "Choose Another Account",
  useAccount: "Use Account",
  checkAndUse: "Check and Use",
  signIn: "Sign In",
  noOtherAccounts: "No Other Accounts",
  openConnections: "Open Connections",
  askOwner: "Ask a machine owner or organization admin to sign in to this account.",
  signInFirst: "This account is signed out. Sign in to it first, then use it.",
  ownerSignsInFirst: "This account is signed out. A machine owner or organization admin must sign in to it first.",
  cantSwitch: "This conversation can't continue under another account. Sign in again with the current account, " +
    "or start a new session.",
  accountChanged: "This session's account changed while you were choosing, so nothing was switched.",
  recoveryChanged: "This sign-in request changed while the account was checked. Review the card, then choose again.",
} as const;

/** How the dialog ended, for the card that opened it. */
export type ChooseAccountResult =
  /** Cancel. `refusal` is the last refused choice's sentence, which the card keeps as a notice. */
  | { kind: "cancelled"; refusal: string | null }
  | { kind: "selected" }
  /** `not_resumable`: no account can continue this conversation. */
  | { kind: "cant_switch" }
  /** `account_changed` or `recovery_changed`: the card re-renders from the new state. */
  | { kind: "card_changed"; notice: string };

type Loaded =
  | { key: string; state: "loading" }
  | { key: string; state: "loaded"; value: ProviderAuthenticationAccountOption[] }
  | { key: string; state: "failed" };

/** A refusal's sentence. The runner's own message names internal ids and states, so it is never shown. */
export function accountRefusalSentence(code: string | undefined): string {
  switch (code) {
    case "sign_in_required":
      return "This account is signed out. Sign in to it, then choose it again.";
    case "status_unknown":
      return "The provider couldn't confirm this account's sign-in. Sign in to it again, then choose it.";
    case "operation_in_progress":
      return "Another sign-in or check is running for this session. Try again in a moment.";
    case "account_unavailable":
      return "This account can't be used for this session. Choose another account.";
    default:
      return "This account couldn't be selected. Try again in a moment.";
  }
}

/** The removal sentence, with the account's masked title: no sentence carries an identifier (§11.8). */
export function removedAccountSentence(title: string, machine: string): string {
  return `${title} was removed from ${machine}, so it's no longer listed.`;
}

const STATUS: Record<Exclude<ProviderAuthenticationAccountOption["availability"], "current">, StatusValue<"provider_account">> = {
  available: "signed_in",
  sign_in_required: "sign_in_required",
  status_unknown: "status_unknown",
};

/**
 * Choose Another Account (#2208): continue a session stuck on its sign-in with another account on
 * its Machine. Opened by the sign-in card's Choose Another Account…; a sheet on phones (§7.5).
 *
 * The accounts are the shared account rows (#2149), each with its state as an inline status. A
 * refused choice is a field error in that row, worded from its code. The list reloads whenever the
 * Machine's inventory changes, and an account that disappears is named, masked, in one notice
 * rather than vanishing (#1773). A refusal that no account can fix (`not_resumable`), or one that
 * means the card is out of date, closes the dialog and is the card's to show.
 */
export function ChooseAccountDialog({
  session,
  approval,
  runner,
  runnerOnline,
  provider,
  machineName,
  onDone,
  onOpenConnections,
  returnFocusRef,
}: {
  session: SessionView;
  approval: PendingApproval;
  runner: RunnerView | undefined;
  runnerOnline: boolean;
  /** The provider's name: "Claude Code" or "Codex". */
  provider: string;
  machineName?: string;
  onDone: (result: ChooseAccountResult) => void;
  /** Opens Connections, where a machine's accounts are added. */
  onOpenConnections?: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const api = useApi();
  const machine = machineName || "this machine";
  const cardKey = `${approval.requestId}\u0000${session.providerAccountId ?? ""}`;
  const inventory = runner?.providerAccounts ?? [];
  const accountInventoryKey = inventory.map((account) => `${account.id}:${account.authStatus}`).join("|");
  const [refreshes, setRefreshes] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // The labels of the last list shown, so an account that disappears can still be named.
  const shownRef = useRef<Map<string, string> | null>(null);
  // Every account listed while the dialog is open, in the order first listed. Masked titles are
  // numbered among these, so a removal never renumbers the rows left, and its sentence names the
  // account by the title its row had.
  const [seen, setSeen] = useState<readonly { id: string; label: string }[]>([]);
  const [removed, setRemoved] = useState<{ id: string; label: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ accountId: string; message: string } | null>(null);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const refusalRef = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [startingSignIn, setStartingSignIn] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dismissRef = useRef<HTMLButtonElement | null>(null);
  const focusInsideRef = useRef(false);
  const rowsId = useId();
  const reasonId = useId();

  const markRemoved = useCallback((gone: readonly { id: string; label: string }[]) => {
    if (gone.length === 0) return;
    const ids = new Set(gone.map((account) => account.id));
    setRemoved((current) => [...current.filter((account) => !ids.has(account.id)), ...gone]);
    setSelectedId((current) => current !== null && ids.has(current) ? null : current);
    setRowError((current) => current && ids.has(current.accountId) ? null : current);
  }, []);

  const show = useCallback((accounts: readonly ProviderAuthenticationAccountOption[]) => {
    const others = accounts.filter((account) => account.availability !== "current");
    const previous = shownRef.current;
    const listed = new Set(others.map((account) => account.id));
    if (previous) {
      markRemoved([...previous].filter(([id]) => !listed.has(id)).map(([id, label]) => ({ id, label })));
    } else {
      // The first account that can take over is chosen; one that needs a check is the person's call.
      setSelectedId(others.find((account) => account.availability === "available")?.id ?? null);
    }
    // An account that comes back is listed again, and no longer called removed.
    setRemoved((current) => current.some((account) => listed.has(account.id))
      ? current.filter((account) => !listed.has(account.id)) : current);
    shownRef.current = new Map(others.map((account) => [account.id, account.label]));
    setSeen((current) => {
      const known = new Set(current.map((account) => account.id));
      const added = others.filter((account) => !known.has(account.id)).map(({ id, label }) => ({ id, label }));
      return added.length > 0 ? [...current, ...added] : current;
    });
    return others;
  }, [markRemoved]);

  useEffect(() => {
    if (!runnerOnline) return;
    let cancelled = false;
    setLoaded((current) => current?.key === cardKey && current.state === "loaded" ? current : { key: cardKey, state: "loading" });
    api.authenticationAccounts(session.id).then(
      (result) => {
        if (cancelled) return;
        show(result.accounts);
        setLoaded({ key: cardKey, state: "loaded", value: result.accounts });
      },
      () => { if (!cancelled) setLoaded({ key: cardKey, state: "failed" }); },
    );
    return () => { cancelled = true; };
  }, [api, runnerOnline, accountInventoryKey, cardKey, refreshes, session.id, show]);

  // Focus that was in the dialog and was lost with a row (an account removed while it was focused)
  // goes to Cancel, which every state renders. Focus that is still somewhere is never moved.
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
  useLayoutEffect(() => {
    if (focusRow !== null) {
      const input = [...bodyRef.current?.querySelectorAll<HTMLInputElement>("input[data-account-id]") ?? []]
        .find((candidate) => candidate.dataset.accountId === focusRow);
      setFocusRow(null);
      if (input) {
        input.focus();
        input.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
    const dismiss = dismissRef.current;
    const active = dismiss?.ownerDocument.activeElement;
    if (!dismiss || !focusInsideRef.current) return;
    if (active && active !== dismiss.ownerDocument.body && active.isConnected) return;
    (dismiss.disabled ? dismiss.closest<HTMLElement>('[role="dialog"]') : dismiss)?.focus();
  });

  const list = loaded?.key === cardKey ? loaded : null;
  const removedIds = new Set(removed.map((account) => account.id));
  const alternatives = list?.state === "loaded"
    ? list.value.filter((account) => account.availability !== "current" && !removedIds.has(account.id))
    : [];
  const selected = alternatives.find((account) => account.id === selectedId) ?? null;
  // The primary follows the chosen row: Use Account for a signed-in account, Check and Use for one
  // whose sign-in is unknown. A signed-out account is not offered: the runner would refuse it until
  // someone signs it in, so the primary waits, saying why, while Sign In (or the row) says how.
  const signedOutChoice = selected?.availability === "sign_in_required";
  const canStartSignIn = runner?.canManage === true && runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const accountLogins = (runner?.providerLogins ?? []).filter((login) =>
    !login.sessionId && login.status !== "succeeded" && login.status !== "cancelled" &&
    alternatives.some((account) => account.id === login.accountId));
  const seenTitles = maskedAccountTitles(seen.map((account) => account.label));
  const maskedTitles = new Map(seen.map((account, index) => [account.id, seenTitles[index]!]));
  const maskedTitle = (account: { id: string; label: string }) =>
    maskedTitles.get(account.id) ?? maskedAccountTitles([account.label])[0]!;
  const [revealed, toggleReveal] = useAccountIdentifierReveal(
    JSON.stringify([session.id, cardKey, alternatives.map((account) => [account.id, account.label])]),
  );

  const close = () => {
    if (!submittingRef.current) onDone({ kind: "cancelled", refusal: refusalRef.current });
  };

  /** A field error in the account's row, with focus moved to the row so it is announced. */
  const rowFails = (accountId: string, message: string) => {
    setRowError({ accountId, message });
    setFocusRow(accountId);
  };

  const submit = async () => {
    const account = selected;
    if (submittingRef.current || !account || signedOutChoice || !session.providerAccountId) return;
    submittingRef.current = true;
    setSubmitting(true);
    setRowError(null);
    try {
      await api.selectAuthenticationAccount(session.id, {
        requestId: approval.requestId,
        providerAccountId: account.id,
        expectedProviderAccountId: session.providerAccountId,
      });
      submittingRef.current = false;
      onDone({ kind: "selected" });
      return;
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : undefined;
      if (code === "not_resumable" || code === "account_changed" || code === "recovery_changed") {
        submittingRef.current = false;
        onDone(code === "not_resumable" ? { kind: "cant_switch" } : {
          kind: "card_changed",
          notice: code === "account_changed" ? CHOOSE_ACCOUNT_COPY.accountChanged : CHOOSE_ACCOUNT_COPY.recoveryChanged,
        });
        return;
      }
      if (code === "account_unavailable" && !await stillListed(account.id)) {
        // Removed from the Machine since the list loaded: the same sentence as a removal seen live.
        markRemoved([{ id: account.id, label: account.label }]);
        refusalRef.current = removedAccountSentence(maskedTitle(account), machine);
        setRefreshes((value) => value + 1);
      } else {
        refusalRef.current = accountRefusalSentence(code);
        rowFails(account.id, refusalRef.current);
        // A recheck may have changed what the provider reports for the account.
        if (code === "sign_in_required" || code === "status_unknown") setRefreshes((value) => value + 1);
      }
    }
    submittingRef.current = false;
    setSubmitting(false);
  };

  /** Whether the account is still on the Machine: the dashboard's inventory first, then the list. */
  const stillListed = async (accountId: string): Promise<boolean> => {
    if (runner?.providerAccounts && !runner.providerAccounts.some((account) => account.id === accountId)) return false;
    try {
      const fresh = await api.authenticationAccounts(session.id);
      return fresh.accounts.some((account) => account.id === accountId && account.availability !== "current");
    } catch {
      // Unknown: the refusal is worded as an unavailable account rather than a removal.
      return true;
    }
  };

  const signIn = async (accountId: string) => {
    setStartingSignIn(accountId);
    setRowError(null);
    try {
      await api.startProviderLogin(session.runnerId, { accountId });
    } catch {
      rowFails(accountId, "The sign-in couldn't start. Try again in a moment.");
    } finally {
      setStartingSignIn(null);
    }
  };

  const rows: AccountRowAccount[] = alternatives.map((account) => {
    const meta = statusMeta("provider_account", STATUS[account.availability as keyof typeof STATUS] ?? "status_unknown");
    const signedOut = account.availability === "sign_in_required";
    const signingIn = accountLogins.some((login) => login.accountId === account.id);
    return {
      id: account.id,
      label: account.label,
      buckets: account.buckets,
      status: <StatusBadge meta={meta} inline />,
      ...(signedOut && !canStartSignIn ? { note: CHOOSE_ACCOUNT_COPY.askOwner } : {}),
      ...(rowError?.accountId === account.id ? { error: rowError.message } : {}),
      ...(signedOut && canStartSignIn ? {
        action: (
          <BusyButton
            className="btn sm"
            busy={startingSignIn === account.id}
            progress="Starting the sign-in…"
            disabled={submitting || signingIn || (startingSignIn !== null && startingSignIn !== account.id)}
            aria-label={`${CHOOSE_ACCOUNT_COPY.signIn} to ${revealed ? account.label : maskedTitle(account)}`}
            onClick={() => void signIn(account.id)}
          >
            {CHOOSE_ACCOUNT_COPY.signIn}
          </BusyButton>
        ),
      } : {}),
    };
  });

  const noOthers = list?.state === "loaded" && alternatives.length === 0;
  const ready = runnerOnline && list?.state === "loaded";
  return (
    <Modal
      title={CHOOSE_ACCOUNT_COPY.title}
      description={`Continue this session with another ${provider} account on ${machine}.`}
      onClose={close}
      {...(returnFocusRef ? { returnFocusRef } : {})}
      footer={(
        <>
          {signedOutChoice && !noOthers && (
            <p className="choose-account-reason" id={reasonId}>
              {canStartSignIn ? CHOOSE_ACCOUNT_COPY.signInFirst : CHOOSE_ACCOUNT_COPY.ownerSignsInFirst}
            </p>
          )}
          <button ref={dismissRef} className="btn" type="button" onClick={close} disabled={submitting}>
            {noOthers ? "Done" : "Cancel"}
          </button>
          {!noOthers && (
            <BusyButton
              className="btn primary"
              busy={submitting}
              progress="Checking the account…"
              disabled={!ready || !selected || signedOutChoice || startingSignIn !== null}
              aria-describedby={signedOutChoice ? reasonId : undefined}
              onClick={() => void submit()}
            >
              {selected?.availability === "status_unknown" ? CHOOSE_ACCOUNT_COPY.checkAndUse : CHOOSE_ACCOUNT_COPY.useAccount}
            </BusyButton>
          )}
        </>
      )}
    >
      <div className="choose-account-body" ref={bodyRef}>
        {removed.length > 0 && (
          <Notice tone="neutral" compact icon={<UserXIcon />} role="status">
            {removed.map((account) => removedAccountSentence(maskedTitle(account), machine)).join(" ")}
          </Notice>
        )}
        {!runnerOnline ? (
          <State compact>The runner is offline. Accounts load when it reconnects.</State>
        ) : !list || list.state === "loading" ? (
          <State variant="loading" compact>Loading accounts…</State>
        ) : list.state === "failed" ? (
          <State variant="error" compact title="Accounts Unavailable">
            Wollipog couldn&apos;t load the accounts on {machine}. Try again in a moment.
          </State>
        ) : noOthers ? (
          <State
            compact
            title={CHOOSE_ACCOUNT_COPY.noOtherAccounts}
            actions={onOpenConnections && (
              <button className="btn" type="button" onClick={() => { close(); onOpenConnections(); }}>
                {CHOOSE_ACCOUNT_COPY.openConnections}
              </button>
            )}
          >
            A machine owner or organization admin can add one in the machine&apos;s Provider Accounts section.
          </State>
        ) : (
          <section className="choose-account-accounts" aria-labelledby={`${rowsId}-title`}>
            <AccountsHead
              titleId={`${rowsId}-title`}
              revealable={alternatives.some((account) => isPersonalIdentifier(account.label))}
              revealed={revealed}
              onToggleReveal={toggleReveal}
              controls={rowsId}
            />
            <AccountRows
              id={rowsId}
              current={null}
              accounts={rows}
              value={selected?.id ?? null}
              onChange={(id) => { setSelectedId(id); setRowError(null); }}
              revealed={revealed}
              maskedTitles={maskedTitles}
              disabled={submitting}
            />
          </section>
        )}
        {accountLogins.map((login) => (
          <ProviderLoginCard key={login.operationId} runnerId={session.runnerId} login={login} />
        ))}
      </div>
    </Modal>
  );
}
