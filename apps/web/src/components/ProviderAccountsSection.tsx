import React, { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  runnerSupportsProtocol, type ProviderAccountDefinition, type ProviderHomeLeaseInspection, type ProviderLoginView, type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { agentDisplayName } from "../agent-presentation.js";
import { accountLabelText } from "../personal-identifiers.js";
import { runnerDisplay } from "../runners.js";
import type { MachineAccountsIntent } from "../navigation.js";
import { providerHomeBlockingProcessCopy, providerHomeRecoveryCauseCopy } from "../provider-home-refusal.js";
import { statusMeta } from "../status-meta.js";
import { useFeedback } from "./FeedbackProvider.js";
import { activeSessionConflict } from "./active-session-conflict.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { Modal } from "./common.js";
import { AddProviderAccountDialog, providerLoginRunning, providerName } from "./AddProviderAccountDialog.js";
import { MoreHorizontalIcon, SignInIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { ProviderSignIn, providerSignInAlreadyOnMachine, providerSignInHiddenTitle } from "./ProviderLoginCard.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Coded adoption refusals whose runner message is technical, in words the person can act on. */
const ADOPTION_REFUSALS: Readonly<Record<string, string>> = {
  PROFILE_EXISTS: "This account's HOME already has a profile record that cannot accept this control plane. " +
    "It may be unreadable, belong to the other provider, or already list the maximum number of control planes.",
  HOME_IN_USE: "Another runner or control plane is using this account's HOME. Try again when it is no longer in use.",
  UNSUPPORTED_HOME: "This account's HOME cannot hold a provider profile. Windows Machines and WSL account homes are not supported.",
  PROVIDER_PROFILE_GRANT_REVOKED: "Access was revoked while the account was being adopted. Adopt it again to grant access.",
};

/** Windows Machines cannot verify a profile marker, so their accounts never become profiles. */
export const PROFILES_UNSUPPORTED_ON_WINDOWS =
  "Provider profiles aren't available on Windows Machines, so this account can't be adopted.";

const ADOPTION_FAILED_DEFAULT = "The provider profile could not be adopted.";

/** Why a stale lease cannot be recovered (#3241), as the disabled menu item's reason and the
 * refusal notice. */
export const LEASE_RECOVERY_REFUSALS: Readonly<Record<string, string>> = {
  TIP_CHANGED: "The account lock changed after it was checked. Reopen this machine to check it again.",
  NO_REBOOT_PROOF: "Wollipog can't safely unlock this account until this machine has restarted. Save your work, restart the machine, then recover the account in Connections.",
  HOME_IN_USE: "Another runner or a program it started is still using this account. Wait for its work to finish, then try again.",
  FOREIGN_HOST: "This account is locked by a runner on another machine. Use another account on this machine.",
  PROFILE_REFUSED: "This account's provider profile does not grant this control plane access.",
  UNSUPPORTED_HOME: "This account has no lock that can be recovered here.",
  UNVERIFIABLE: "Wollipog could not check whether this account is still in use. Choose another account and ask the person who manages this machine to check it.",
};

/** This response comes only from the Owner/Admin inspection route. */
export function providerHomeLeaseDescription(lease: ProviderHomeLeaseInspection): string | undefined {
  const guidance = lease.cause ? providerHomeRecoveryCauseCopy(lease.cause, "this account").body
    : lease.refusal ? LEASE_RECOVERY_REFUSALS[lease.refusal] ?? LEASE_RECOVERY_REFUSALS.UNVERIFIABLE : undefined;
  return guidance;
}

/** The sentence-case message for a failed Adopt as Profile, Revoke Access or Recover Account request. */
export function providerProfileErrorMessage(cause: unknown, action: "adopt" | "revoke" | "recover"): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : String(cause);
  if (action === "recover") {
    if (cause.status === 504) return "The machine did not confirm the recovery in time. Reopen this machine to check the lease before retrying.";
    if (cause.status === 409 && cause.message === "runner is offline") return "The machine is offline. Recovering a lease needs the machine to be online.";
    if (cause.status === 409 && cause.code && LEASE_RECOVERY_REFUSALS[cause.code]) return LEASE_RECOVERY_REFUSALS[cause.code]!;
    if (cause.status === 409 && cause.code === "PROVIDER_HOME_LEASE_RECOVERY_FAILED") {
      return "The machine could not confirm the recovery. Reopen this machine to check the lease before retrying.";
    }
    return cause.message;
  }
  if (action === "adopt" && cause.status === 504) {
    return "The Machine did not confirm the adoption in time. It completes when the Machine reports the account again.";
  }
  if (action === "adopt" && cause.status === 409 && cause.message === "runner is offline") {
    return "The Machine is offline. Adopting an account needs the Machine to be online.";
  }
  if (cause.status === 409 && cause.code && ADOPTION_REFUSALS[cause.code]) return ADOPTION_REFUSALS[cause.code]!;
  if (cause.status === 409 && cause.code === "PROVIDER_PROFILE_ADOPTION_FAILED") {
    // No code: the runner kept this authorization pending, so a retry reuses it.
    const detail = cause.message && cause.message !== ADOPTION_FAILED_DEFAULT ? ` ${cause.message}` : "";
    return `The Machine could not adopt this account. Adopt it again to retry.${detail}`;
  }
  // The capability refusal ("This machine needs a newer runner…") and the other refusals are
  // already sentence-case copy from the control plane.
  return cause.message;
}

const OFFLINE = "This machine is offline.";
const SIGN_IN_RUNNING = "A sign-in is running. Cancel it first.";

/** The runner refuses removal while an agent defaults to the account (`removalBlocker` in the runner). */
const AGENT_DEFAULT_REFUSAL = /^Agent '([^']+)' uses this account as its default/u;

/**
 * Why a removal was refused, as the notice's one sentence (#2995). The runner's two known refusals
 * are reworded, with the agent's display name instead of its id; anything else is the runner's own
 * first sentence, with the whole error behind Show Details.
 */
export function providerAccountRemovalRefusal(cause: unknown, agents: RunnerView["agents"]): { body: string; details?: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  const agentId = AGENT_DEFAULT_REFUSAL.exec(message)?.[1];
  if (agentId !== undefined) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    return {
      body: `${agent ? agentDisplayName(agent) : agentId} uses this account as its default in this machine's runner configuration. ` +
        "Change that setting, then remove the account.",
    };
  }
  if (message.startsWith("A sign-in is running for this account")) {
    return { body: "A sign-in is running for this account. Cancel it, then remove the account." };
  }
  if (cause instanceof ApiError && cause.status === 409 && message === "runner is offline") return { body: OFFLINE };
  const first = /^.*?[.!?](?=\s|$)/u.exec(message)?.[0] ?? message;
  const raw = cause instanceof ApiError ? `${message} (HTTP ${cause.status}${cause.code ? `, ${cause.code}` : ""})` : message;
  return first === raw ? { body: first } : { body: first, details: raw };
}

/**
 * The one sign-in an account's row shows: the newest running one, else the newest settled one. The
 * control plane keeps a failure until it is dismissed, so an earlier failure can sit beside a
 * running retry; the retry is the one to act on (#2996 builds the in-row steps on this choice).
 */
export function accountLogin(logins: readonly ProviderLoginView[], accountId: string): ProviderLoginView | undefined {
  const mine = logins.filter((login) => login.accountId === accountId);
  const newest = (candidates: readonly ProviderLoginView[]) =>
    candidates.reduce<ProviderLoginView | undefined>((best, login) => !best || login.startedAt >= best.startedAt ? login : best, undefined);
  return newest(mine.filter(providerLoginRunning)) ?? newest(mine);
}

type AccountStatus = "signed_in" | "sign_in_required" | "status_unknown" | "signing_in" | "not_added";

function accountStatus(account: ProviderAccountDefinition, signingIn: boolean): AccountStatus {
  if (signingIn) return "signing_in";
  return account.authStatus === "authenticated" ? "signed_in"
    : account.authStatus === "unauthenticated" ? "sign_in_required"
    : "status_unknown";
}

const PROFILE_ACCESS: Readonly<Record<NonNullable<ProviderAccountDefinition["profile"]>["access"], string>> = {
  granted: "Profile",
  pending: "Grant Pending",
  not_granted: "Not Granted",
};

type BusyAction = "sign_in" | "cancel" | "remove" | "adopt" | "revoke" | "recover" | "default";

interface RowMenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Why a disabled item is unavailable, as its second line (§9.1). */
  description?: string;
  /** `reopen` brings the menu back, as a confirmation's phone Back (§7.5). */
  onClick: (reopen: () => void) => void;
}

/**
 * A row's ⋯ (§5.2, §9.1): the account's label first, then the items, the destructive ones last
 * after a separator. No items, no ⋯. While the row's own action runs, only this ⋯ is busy.
 */
function AccountMenu({ name, heading, busy, items }: {
  /** The masked label, for the trigger's name and the menu's. */
  name: string;
  heading: ReactNode;
  busy: boolean;
  items: readonly RowMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "provider-account-menu");
  if (items.length === 0) return null;
  const ordered = [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)];
  const firstDanger = ordered.findIndex((item) => item.danger);
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn sm"
        disabled={busy}
        aria-busy={busy || undefined}
        title="More Actions"
        aria-label={`More Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        <MoreHorizontalIcon />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={name}
          align="end"
          sheetTitle="More Actions"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
          // A menu whose every item is unavailable takes focus itself, so Escape still closes it.
          tabIndex={-1}
        >
          <MenuLabel>{heading}</MenuLabel>
          {ordered.map((item, index) => (
            <Fragment key={item.label}>
              {index === firstDanger && index > 0 && <MenuSeparator />}
              <MenuItem
                danger={item.danger}
                disabled={item.disabled}
                description={item.disabled ? item.description : undefined}
                onClick={() => {
                  // Focus ⋯ before a confirmation opens, so Cancel and Escape return to it.
                  menu.close(false);
                  menu.triggerRef.current?.focus();
                  item.onClick(() => setOpen(true));
                }}
              >
                {item.label}
              </MenuItem>
            </Fragment>
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/**
 * One account (§5.2): a key icon, the label (masked under Hide Account Emails), the provider and its
 * profile access as line 2, the one status badge, then the row's actions. `children` is the row's
 * expansion under it: its sign-in's steps or ending (#2996). While a sign-in runs for a label that is
 * a hidden email, `hiddenTitle` ("Signing In to Codex") replaces the mask, with "Email hidden" as line 2.
 */
function ProviderAccountRow({ identity, label, hiddenTitle, provider, profile, lease, status, actions, children }: {
  identity: string;
  label: string;
  hiddenTitle?: string | null;
  provider: ProviderAccountDefinition["provider"];
  profile?: string;
  /** A stale HOME lease (#3241), with why it cannot be recovered now, if it cannot. */
  lease?: { label: string; title?: string };
  status: AccountStatus | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const meta = status ? statusMeta("provider_account", status) : null;
  return (
    <>
      <div className={`row row-2${hiddenTitle ? " provider-account-hidden-title" : ""}`} data-account-status={status ?? undefined}>
        <span className="row-icon" aria-hidden="true"><SignInIcon /></span>
        <span className="row-body">
          <span className="row-line">
            {hiddenTitle ? <span className="row-title provider-account-signing-title">{hiddenTitle}</span>
              : <AccountIdentifier identity={identity} className="row-title" value={label} label="Account Email" />}
            {meta && <StatusBadge meta={meta} inline={status === "signed_in"} />}
          </span>
          <span className="row-sub provider-account-sub">
            {hiddenTitle ? <span>Email hidden</span> : (
              <>
                <span>{providerName(provider)}</span>
                {profile && <span>{profile}</span>}
              </>
            )}
            {lease && <span className="provider-account-lease" title={lease.title}>{lease.label}</span>}
          </span>
        </span>
        {actions && <span className="provider-account-actions">{actions}</span>}
      </div>
      {children && <div className="provider-account-expansion">{children}</div>}
    </>
  );
}

type SectionNotice = { title: ReactNode; body: string; details?: string };

/**
 * Provider Accounts, a section of the machine detail (#2995, docs/design-system.md §4.5): its count
 * and Add Account…, then one surface of account rows, each with one status. Removal and the profile
 * actions live in each row's ⋯; a refusal is one compact notice between the title and the rows.
 */
export function ProviderAccountsSection({ runner, online, machineName, canManageProfiles = false, profileAccessKnown = true, intent }: {
  runner: RunnerView;
  online: boolean;
  /** The machine's display name, for Add Account and the removal confirmation. */
  machineName?: string;
  /** The viewer is an organization Owner or Admin. Profile routes are not member-scoped, so a member
   * with manage rights on this Machine does not get the profile actions. */
  canManageProfiles?: boolean;
  /** Whether `canManageProfiles` is final: the Machines view reads it from an identity that loads
   * on its own, and a recovery intent waits for it rather than being refused on the way. */
  profileAccessKnown?: boolean;
  /** Set Up Managed Profile or Recover Existing Profile from a refused session (#3240): each new
   * activation scrolls here and opens it once. */
  intent?: MachineAccountsIntent;
}) {
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const headingId = `provider-accounts-${useId().replace(/:/g, "")}`;
  const offlineId = `${headingId}-offline`;
  // The provider Add Account opens with, while it is open.
  const [adding, setAdding] = useState<ProviderAccountDefinition["provider"] | null>(null);
  // A sign-in this section started: once it records its account, Use for New Sessions is offered.
  const [started, setStarted] = useState<{ operationId: string; accountId: string; provider: ProviderAccountDefinition["provider"] } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [recoveryDetails, setRecoveryDetails] = useState<{ runnerId: string; accountId: string } | null>(null);
  const [busy, setBusy] = useState<Readonly<Record<string, BusyAction>>>({});
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const supported = runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const removalSupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountRemoval");
  const canManage = runner.canManage === true;
  const profileActions = canManageProfiles && runnerSupportsProtocol(runner.protocolVersion, "providerProfiles");
  const machine = machineName ?? runnerDisplay(runner, undefined).name;
  const accounts = runner.providerAccounts ?? [];
  const logins = (runner.providerLogins ?? []).filter((login) =>
    login.status !== "succeeded" && login.status !== "cancelled");
  const accountIds = new Set(accounts.map((account) => account.id));
  // Stale lease recovery (#3241): an Owner or Admin sees each account's lease on an online v229 machine.
  const leaseActions = canManageProfiles && canManage && online && runnerSupportsProtocol(runner.protocolVersion, "providerHomeLeaseRecovery");
  const [leases, setLeases] = useState<Readonly<Record<string, ProviderHomeLeaseInspection>>>({});
  const detailsAccount = recoveryDetails?.runnerId === runner.runnerId ? accounts.find(account => account.id === recoveryDetails.accountId) : undefined;
  const detailsLease = detailsAccount ? leases[detailsAccount.id] : undefined;
  const accountKey = accounts.map((account) => account.id).join("\n");
  const inspectLease = (accountId: string, isCurrent: () => boolean = () => true) =>
    api.inspectProviderHomeLease(runner.runnerId, accountId).then(
      (inspection) => { if (isCurrent()) setLeases((current) => ({ ...current, [accountId]: inspection })); },
      // A failed inspection shows nothing: Recover Account is offered only for a known stale lease.
      () => { if (isCurrent()) setLeases(({ [accountId]: _dropped, ...rest }) => rest); },
    );
  useEffect(() => {
    if (!leaseActions) return;
    let current = true;
    for (const account of accounts) void inspectLease(account.id, () => current);
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-inspect when the account list, runner or access changes
  }, [leaseActions, runner.runnerId, accountKey]);
  // A sign-in for a new account has no account row yet: it shows as a row of its own until it lands.
  const newLogins = [...new Set(logins.map((login) => login.accountId))]
    .filter((accountId) => !accountIds.has(accountId))
    .map((accountId) => accountLogin(logins, accountId)!);

  const masked = (label: string) => accountLabelText(label, undefined, privacy.hide);
  const identifier = (account: Pick<ProviderAccountDefinition, "id" | "label">) => (
    <AccountIdentifier identity={`${runner.runnerId}:${account.id}`} value={account.label} label="Account Email" />
  );
  const backToMenu = (reopen: () => void) => ({ label: "Back to More Actions", run: reopen });

  const track = async (accountId: string, action: BusyAction, run: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [accountId]: action }));
    try {
      await run();
    } finally {
      setBusy(({ [accountId]: _settled, ...rest }) => rest);
    }
  };

  const signIn = (account: ProviderAccountDefinition) => void track(account.id, "sign_in", async () => {
    setNotice(null);
    try {
      await api.startProviderLogin(runner.runnerId, { accountId: account.id });
    } catch (cause) {
      setNotice({ title: <>Couldn't Sign In to {identifier(account)}</>, body: (cause as Error).message });
    }
  });

  const cancel = (login: ProviderLoginView) => void track(login.accountId, "cancel", async () => {
    setNotice(null);
    try {
      await api.cancelProviderLogin(runner.runnerId, login.operationId);
    } catch (cause) {
      setNotice({ title: <>Couldn't Cancel Signing In to {identifier({ id: login.accountId, label: login.label })}</>, body: (cause as Error).message });
    }
  });

  const remove = async (account: ProviderAccountDefinition, reopen: () => void) => {
    const provider = providerName(account.provider);
    const sentence = (label: ReactNode) => (
      <>{label} ({provider}) is removed from {machine}, and the sign-in Wollipog stored for it stays on this machine. Sessions still
        using it keep working, and the {provider} account itself isn't affected.</>
    );
    const approved = await confirm({
      title: "Remove Account",
      message: `${masked(account.label)} (${provider}) is removed from ${machine}, and the sign-in Wollipog stored for it stays on this machine. ` +
        `Sessions still using it keep working, and the ${provider} account itself isn't affected.`,
      messageContent: sentence(identifier(account)),
      confirmLabel: "Remove Account",
      tone: "danger",
      back: backToMenu(reopen),
    });
    if (!approved) return;
    await track(account.id, "remove", async () => {
      setNotice(null);
      try {
        const result = await api.removeProviderAccount(runner.runnerId, account.id);
        showToast("Account removed.", {
          tone: "success",
          // Runners keep the stored sign-in on removal (#3157); a runner that doesn't report it gets no detail.
          ...(result.credentialsRetained ? { detail: "The sign-in Wollipog stored for it was kept on this machine." } : {}),
        });
      } catch (cause) {
        setNotice({ title: <>Couldn't Remove {identifier(account)}</>, ...providerAccountRemovalRefusal(cause, runner.agents) });
      }
    });
  };

  const runProfileAction = (account: ProviderAccountDefinition, action: "adopt" | "revoke" | "recover", run: () => Promise<void>) =>
    track(account.id, action, async () => {
      setNotice(null);
      try {
        await run();
      } catch (cause) {
        setNotice({
          title: action === "adopt" ? <>Couldn't Adopt {identifier(account)}</>
            : action === "revoke" ? <>Couldn't Revoke Access to {identifier(account)}</>
            : <>Couldn't Recover the Lease for {identifier(account)}</>,
          body: providerProfileErrorMessage(cause, action),
        });
      }
    });

  // The label stays a live identifier, so the preference changing while the dialog is open still
  // masks it, and a masked label can still be revealed.
  const accountRows = (account: ProviderAccountDefinition) => [{
    label: masked(account.label),
    labelContent: identifier(account),
    meta: providerName(account.provider),
  }];

  const adopt = async (account: ProviderAccountDefinition, reopen: () => void) => {
    const approved = await confirm({
      title: "Adopt as Profile",
      message: "After adoption, only control planes granted this profile can use this account's HOME, so other control planes " +
        "that share this Machine's account lose access to it. Existing sessions keep working as before; new sessions record the profile.",
      detailRows: accountRows(account),
      confirmLabel: "Adopt as Profile",
      back: backToMenu(reopen),
    });
    if (!approved) return;
    await runProfileAction(account, "adopt", async () => {
      await api.adoptProviderProfile(runner.runnerId, account.id);
      showToast("Account adopted as a profile.", { tone: "success" });
    });
  };

  const revoke = async (account: ProviderAccountDefinition, reopen: () => void) => {
    const approved = await confirm({
      title: "Revoke Access",
      message: "This control plane stops using this account's profile, and sessions that use it cannot restart until access is granted again. " +
        "Other control planes' access is not affected.",
      detailRows: accountRows(account),
      confirmLabel: "Revoke Access",
      tone: "danger",
      back: backToMenu(reopen),
    });
    if (!approved) return;
    await runProfileAction(account, "revoke", async () => {
      try {
        await api.revokeProviderProfileAccess(runner.runnerId, account.id, false);
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409 || cause.code !== "PROVIDER_PROFILE_HAS_ACTIVE_SESSIONS") throw cause;
        const conflict = activeSessionConflict(cause);
        const sessions = conflict.count == null ? "Active sessions use"
          : conflict.count === 1 ? "1 active session uses" : `${conflict.count} active sessions use`;
        const force = await confirm({
          title: "Revoke Access from Active Sessions",
          message: `${sessions} this account's profile. Revoking access stops them from restarting until access is granted again.`,
          detailRows: conflict.detailRows,
          detailRowsOverflow: conflict.detailRowsOverflow,
          confirmLabel: "Revoke Access",
          tone: "danger",
        });
        if (!force) return;
        await api.revokeProviderProfileAccess(runner.runnerId, account.id, true);
      }
      showToast("Access revoked.", { tone: "success" });
    });
  };

  const recover = async (account: ProviderAccountDefinition, lease: ProviderHomeLeaseInspection, reopen: () => void) => {
    const recorded = lease.createdAt ? new Date(lease.createdAt) : null;
    const when = recorded && !Number.isNaN(recorded.getTime()) ? `Locked since ${recorded.toLocaleString()}` : undefined;
    const approved = await confirm({
      title: "Recover Account",
      message: "An earlier Wollipog runner left this account locked. Wollipog will unlock it only after checking that no earlier session is still using it.",
      // The record's time is a row of its own, so neither it nor the account's label is truncated.
      detailRows: [...accountRows(account), ...(when ? [{ label: when }] : [])],
      confirmLabel: "Recover Account",
      tone: "danger",
      back: backToMenu(reopen),
    });
    if (!approved || !lease.tipHash) return;
    await runProfileAction(account, "recover", async () => {
      try {
        await api.recoverProviderHomeLease(runner.runnerId, account.id, lease.tipHash!);
        showToast("Account unlocked.", { tone: "success" });
      } finally {
        void inspectLease(account.id);
      }
    });
  };

  /**
   * Recover Existing Profile (#3240), opened from a refused session: one confirmation for what a
   * configured account needs before this control plane can use it again. Recover Account first when
   * an earlier runner left it locked (adoption takes the HOME's lease, so it cannot pass another
   * runner's stale lease), then Adopt as Profile when its profile isn't granted here. Recovery is
   * bound to the exact lock the confirmation showed; a lock the runner refuses to recover, or one it
   * can't inspect, is explained instead and nothing changes.
   */
  const recoverExistingProfile = async (account: ProviderAccountDefinition) => {
    const fail = (body: string) => setNotice({ title: <>Couldn't Recover {identifier(account)}</>, body });
    if (!canManageProfiles || !canManage) return fail("Only an Owner or Admin can recover an account's profile.");
    if (!online) return fail(OFFLINE);
    const adoptable = profileActions && runner.os !== "windows" && account.profile?.access !== "granted";
    let lease: ProviderHomeLeaseInspection | undefined;
    if (leaseActions) {
      try {
        lease = await api.inspectProviderHomeLease(runner.runnerId, account.id);
      } catch {
        return fail("Wollipog couldn't check whether this account is locked. Try again from the session.");
      }
      setLeases((current) => ({ ...current, [account.id]: lease! }));
      if (lease.state === "unverifiable") {
        return fail(providerHomeLeaseDescription(lease) ?? LEASE_RECOVERY_REFUSALS.UNVERIFIABLE!);
      }
    }
    const stale = lease?.state === "stale";
    // A lock the runner already refuses to recover can't be helped here, and adoption would need it.
    if (stale && (lease!.cause || lease!.refusal || !lease!.tipHash)) {
      return fail(providerHomeLeaseDescription(lease!) ?? LEASE_RECOVERY_REFUSALS.UNVERIFIABLE!);
    }
    if (!adoptable && !stale) {
      showToast("This account can already be used here.", { tone: "success" });
      return;
    }
    const recorded = stale && lease!.createdAt ? new Date(lease!.createdAt) : null;
    const when = recorded && !Number.isNaN(recorded.getTime()) ? `Locked since ${recorded.toLocaleString()}` : undefined;
    const approved = await confirm({
      title: "Recover Existing Profile",
      message: adoptable && stale
        ? "An earlier Wollipog runner left this account locked. Wollipog unlocks it only after checking that no earlier session " +
          "is still using it, then adopts it as this control plane's profile, so other control planes that share this Machine's account lose access to it."
        : adoptable
          ? "This control plane adopts the account as its profile, so other control planes that share this Machine's account " +
            "lose access to it. Existing sessions keep working as before; new sessions record the profile."
          : "An earlier Wollipog runner left this account locked. Wollipog will unlock it only after checking that no earlier session is still using it.",
      detailRows: [...accountRows(account), ...(when ? [{ label: when }] : [])],
      confirmLabel: "Recover Existing Profile",
      tone: stale ? "danger" : undefined,
    });
    if (!approved) return;
    if (stale) {
      // The confirmed lock's own hash: if it changed since, the runner refuses it as TIP_CHANGED.
      let unlocked = false;
      await runProfileAction(account, "recover", async () => {
        try {
          await api.recoverProviderHomeLease(runner.runnerId, account.id, lease!.tipHash!);
          unlocked = true;
        } finally {
          void inspectLease(account.id);
        }
      });
      if (!unlocked) return;
    }
    if (adoptable) {
      let adopted = false;
      await runProfileAction(account, "adopt", async () => {
        await api.adoptProviderProfile(runner.runnerId, account.id);
        adopted = true;
      });
      if (!adopted) {
        // The account was unlocked; only the adoption is left, which the notice explains.
        if (stale) showToast("Account unlocked.", { tone: "success" });
        return;
      }
    }
    showToast(adoptable && stale ? "Profile recovered." : adoptable ? "Account adopted as a profile." : "Account unlocked.", { tone: "success" });
  };

  // Set Up Managed Profile (#3240): once the sign-in this section started records its account, the
  // account is offered as the Machine's default for its provider. Saving a default is, like the
  // profile actions, an Owner/Admin route of the personal organization.
  const startedAccount = started ? accounts.find((account) => account.id === started.accountId) : undefined;
  const savedDefault = startedAccount
    ? runner.providerAccountDefaults?.find((entry) => entry.provider === startedAccount.provider)
    : undefined;
  const defaultOffer = startedAccount && canManageProfiles && canManage &&
    runnerSupportsProtocol(runner.protocolVersion, "providerAccounts") && savedDefault?.accountId !== startedAccount.id
    ? startedAccount : undefined;
  const useForNewSessions = (account: ProviderAccountDefinition) => track(account.id, "default", async () => {
    setNotice(null);
    try {
      await api.updateMachineProviderAccountDefault(runner.runnerId, account.provider, {
        accountId: account.id,
        expectedRevision: savedDefault?.revision ?? 0,
      });
      setStarted(null);
      showToast(`New ${providerName(account.provider)} sessions on this machine use this account.`, { tone: "success" });
    } catch (cause) {
      setNotice({ title: <>Couldn't Make {identifier(account)} the Default</>, body: (cause as Error).message });
    }
  });

  const menuItems = (account: ProviderAccountDefinition, signingIn: boolean): RowMenuItem[] => {
    if (!canManage) return [];
    const offline = online ? {} : { disabled: true, description: OFFLINE };
    const items: RowMenuItem[] = [];
    if (supported && account.authStatus !== "unauthenticated" && !signingIn) {
      items.push({ label: "Sign In Again…", ...offline, onClick: () => signIn(account) });
    }
    if (profileActions && account.profile?.access !== "granted") {
      // A Windows runner refuses every adoption as UNSUPPORTED_HOME (#3240): say so before asking.
      const unsupported = runner.os === "windows" ? { disabled: true, description: PROFILES_UNSUPPORTED_ON_WINDOWS } : offline;
      items.push({ label: "Adopt as Profile…", ...unsupported, onClick: (reopen) => void adopt(account, reopen) });
    }
    if (profileActions && (account.profile?.access === "granted" || account.profile?.access === "pending")) {
      items.push({ label: "Revoke Access…", danger: true, onClick: (reopen) => void revoke(account, reopen) });
    }
    const lease = leases[account.id];
    if (leaseActions && lease?.state === "stale") {
      if (lease.cause || lease.blockingProcess) items.push({
        label: "View Recovery Details…",
        onClick: () => setRecoveryDetails({ runnerId: runner.runnerId, accountId: account.id }),
      });
      const refusal = providerHomeLeaseDescription(lease);
      items.push({
        label: "Recover Account…",
        danger: true,
        ...(refusal ? { disabled: true, description: refusal } : {}),
        onClick: (reopen) => void recover(account, lease, reopen),
      });
    }
    if (removalSupported) {
      items.push({
        label: "Remove Account…",
        danger: true,
        ...(signingIn ? { disabled: true, description: SIGN_IN_RUNNING } : offline),
        onClick: (reopen) => void remove(account, reopen),
      });
    }
    return items;
  };

  const loginFor = (accountId: string) => accountLogin(logins, accountId);
  // The row's expansion: the sign-in's steps, or its ending, whose Try Again starts the same sign-in.
  const signInSteps = (login: ProviderLoginView | undefined, existing: boolean) => login && (
    <ProviderSignIn key={login.operationId} runnerId={runner.runnerId} login={login}
      {...(supported && canManage && online
        ? { restart: existing ? { accountId: login.accountId } : { provider: login.provider, label: login.label } } : {})} />
  );
  const cancelButton = (login: ProviderLoginView) => (
    <BusyButton className="btn sm ghost" busy={busy[login.accountId] === "cancel"} progress="Canceling the sign-in…"
      disabled={!online || (busy[login.accountId] !== undefined && busy[login.accountId] !== "cancel")}
      onClick={() => cancel(login)}>
      Cancel
    </BusyButton>
  );

  // Each new activation of an intent is handled once, when the account it names is listed.
  const handledIntent = useRef<number | undefined>(undefined);
  useEffect(() => {
    const activation = intent?.activationId;
    if (!intent || activation === undefined || handledIntent.current === activation) return;
    if (intent.kind === "recover_profile" &&
        (!profileAccessKnown || !accounts.some((account) => account.id === intent.accountId))) return;
    handledIntent.current = activation;
    sectionRef.current?.scrollIntoView?.({ block: "start" });
    if (intent.kind === "add_account") {
      // The section says why Add Account isn't available (offline, or no manage rights).
      if (supported && canManage && online) setAdding(intent.provider);
      return;
    }
    const account = accounts.find((candidate) => candidate.id === intent.accountId)!;
    void recoverExistingProfile(account);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handled once per activation, when its account is listed
  }, [intent?.activationId, accountKey, profileAccessKnown]);

  if (!supported && accounts.length === 0) return null;
  const canAdd = supported && canManage;
  const count = accounts.length + newLogins.length;
  return (
    <section ref={sectionRef} className="section" aria-labelledby={headingId}>
      <div className="section-head">
        <h3 id={headingId} className="section-title">
          Provider Accounts <span className="count">{accounts.length}</span>
        </h3>
        {canAdd && (
          <div className="actions">
            <button type="button" className="btn sm" disabled={!online} aria-describedby={online ? undefined : offlineId}
              onClick={() => setAdding("claude")}>
              Add Account…
            </button>
          </div>
        )}
      </div>
      {canAdd && !online && <p className="section-note" id={offlineId}>{OFFLINE}</p>}
      {supported && accounts.length === 0 && (
        <p className="section-note">Sign in to Claude or Codex on this machine without opening a shell.</p>
      )}
      {supported && !canManage && (
        <p className="section-note">Only this machine's owner or an organization admin can add or remove its accounts.</p>
      )}
      {notice && (
        <Notice compact tone="danger" role="alert" title={notice.title} details={notice.details}
          actions={<button type="button" className="btn sm" onClick={() => setNotice(null)}>Dismiss</button>}>
          {notice.body}
        </Notice>
      )}
      {defaultOffer && (
        <Notice compact tone="info" role="status" title={<>Use {identifier(defaultOffer)} for New Sessions?</>}
          ariaLabel="Use for New Sessions"
          actions={(
            <>
              <BusyButton className="btn primary sm" busy={busy[defaultOffer.id] === "default"} progress="Saving the default…"
                disabled={!online} onClick={() => void useForNewSessions(defaultOffer)}>
                Use for New Sessions
              </BusyButton>
              <button type="button" className="btn sm" onClick={() => setStarted(null)}>Not Now</button>
            </>
          )}>
          New {providerName(defaultOffer.provider)} sessions on this machine that don't choose an account will use it.
        </Notice>
      )}
      {count > 0 && (
        <div className="surface provider-accounts-list">
          {accounts.map((account) => {
            const login = loginFor(account.id);
            const signingIn = login !== undefined && providerLoginRunning(login);
            const status = accountStatus(account, signingIn);
            const action = busy[account.id];
            // An ending offers Try Again itself, so Sign In waits until it is dismissed.
            const showSignIn = supported && canManage && status === "sign_in_required" && login === undefined;
            return (
              <ProviderAccountRow
                key={account.id}
                identity={`${runner.runnerId}:${account.id}`}
                label={account.label}
                hiddenTitle={login && providerSignInHiddenTitle(login, privacy.hide)}
                provider={account.provider}
                profile={account.profile ? PROFILE_ACCESS[account.profile.access] : undefined}
                lease={leaseActions && leases[account.id]?.state === "stale" ? {
                  label: "Recovery Needed",
                  title: providerHomeLeaseDescription(leases[account.id]!) ?? "An earlier Wollipog runner left this account locked. Choose Recover Account in its menu to try unlocking it.",
                } : undefined}
                status={status}
                actions={canManage && (
                  <>
                    {signingIn && cancelButton(login)}
                    {showSignIn && (
                      <BusyButton className="btn sm" busy={action === "sign_in"} progress="Starting the sign-in…"
                        disabled={!online || (action !== undefined && action !== "sign_in")}
                        onClick={() => signIn(account)}>
                        Sign In
                      </BusyButton>
                    )}
                    <AccountMenu
                      name={masked(account.label)}
                      heading={identifier(account)}
                      busy={action !== undefined && action !== "sign_in"}
                      items={menuItems(account, signingIn)}
                    />
                  </>
                )}
              >
                {signInSteps(login, true)}
              </ProviderAccountRow>
            );
          })}
          {newLogins.map((login) => {
            const running = providerLoginRunning(login);
            return (
              <ProviderAccountRow
                key={login.operationId}
                identity={`${runner.runnerId}:${login.accountId}`}
                label={login.label}
                hiddenTitle={providerSignInHiddenTitle(login, privacy.hide)}
                provider={login.provider}
                status={running ? "signing_in" : providerSignInAlreadyOnMachine(login) ? "not_added" : null}
                actions={running && canManage ? cancelButton(login) : undefined}
              >
                {signInSteps(login, false)}
              </ProviderAccountRow>
            );
          })}
        </div>
      )}
      {leaseActions && detailsAccount && detailsLease && (
        <Modal title="Account Recovery Details" description={masked(detailsAccount.label)} size="sm"
          onClose={() => setRecoveryDetails(null)}
          footer={<button type="button" className="btn" onClick={() => setRecoveryDetails(null)}>Close</button>}>
          <p>{providerHomeLeaseDescription(detailsLease)}</p>
          <p className="muted">Technical information for the person who manages this machine:</p>
          <p>Recovery Code: <code>{detailsLease.cause ?? detailsLease.refusal ?? "unknown"}</code></p>
          {detailsLease.blockingProcess && <p>{providerHomeBlockingProcessCopy(detailsLease.blockingProcess)}</p>}
          <p>Keep the account's files and lease journal intact. Do not stop unrelated programs to bypass this check.</p>
        </Modal>
      )}
      {adding && (
        <AddProviderAccountDialog
          runnerId={runner.runnerId}
          machineName={machine}
          accounts={accounts}
          logins={logins}
          initialProvider={adding}
          onStarted={(login) => setStarted({ operationId: login.operationId, accountId: login.accountId, provider: login.provider })}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}
