import React, { Fragment, useId, useState, type ReactNode } from "react";
import { runnerSupportsProtocol, type ProviderAccountDefinition, type ProviderLoginView, type RunnerView } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { agentDisplayName } from "../agent-presentation.js";
import { accountLabelText } from "../personal-identifiers.js";
import { runnerDisplay } from "../runners.js";
import { statusMeta } from "../status-meta.js";
import { useFeedback } from "./FeedbackProvider.js";
import { activeSessionConflict } from "./active-session-conflict.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { AddProviderAccountDialog, providerLoginRunning, providerName } from "./AddProviderAccountDialog.js";
import { MoreHorizontalIcon, SignInIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { ProviderLoginCard } from "./ProviderLoginCard.js";
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

const ADOPTION_FAILED_DEFAULT = "The provider profile could not be adopted.";

/** The sentence-case message for a failed Adopt as Profile or Revoke Access request. */
export function providerProfileErrorMessage(cause: unknown, action: "adopt" | "revoke"): string {
  if (!(cause instanceof ApiError)) return cause instanceof Error ? cause.message : String(cause);
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

type AccountStatus = "signed_in" | "sign_in_required" | "status_unknown" | "signing_in";

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

type BusyAction = "sign_in" | "remove" | "adopt" | "revoke";

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
 * expansion under it, where its running sign-in shows (#2996 turns it into the in-row steps).
 */
function ProviderAccountRow({ identity, label, provider, profile, status, actions, children }: {
  identity: string;
  label: string;
  provider: ProviderAccountDefinition["provider"];
  profile?: string;
  status: AccountStatus | null;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const meta = status ? statusMeta("provider_account", status) : null;
  return (
    <>
      <div className="row row-2" data-account-status={status ?? undefined}>
        <span className="row-icon" aria-hidden="true"><SignInIcon /></span>
        <span className="row-body">
          <span className="row-line">
            <AccountIdentifier identity={identity} className="row-title" value={label} label="Account Email" />
            {meta && <StatusBadge meta={meta} inline={status === "signed_in"} />}
          </span>
          <span className="row-sub provider-account-sub">
            <span>{providerName(provider)}</span>
            {profile && <span>{profile}</span>}
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
export function ProviderAccountsSection({ runner, online, machineName, canManageProfiles = false }: {
  runner: RunnerView;
  online: boolean;
  /** The machine's display name, for Add Account and the removal confirmation. */
  machineName?: string;
  /** The viewer is an organization Owner or Admin. Profile routes are not member-scoped, so a member
   * with manage rights on this Machine does not get the profile actions. */
  canManageProfiles?: boolean;
}) {
  const privacy = useAccountEmailPrivacy();
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const headingId = `provider-accounts-${useId().replace(/:/g, "")}`;
  const offlineId = `${headingId}-offline`;
  const [adding, setAdding] = useState(false);
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
  // A sign-in for a new account has no account row yet: it shows as a row of its own until it lands.
  const newLogins = logins.filter((login) => !accountIds.has(login.accountId));

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

  const remove = async (account: ProviderAccountDefinition, reopen: () => void) => {
    const provider = providerName(account.provider);
    const sentence = (label: ReactNode) => (
      <>{label} ({provider}) is removed from {machine}, and the sign-in Wollipog stored for it is deleted. Sessions still using it
        keep working, and the {provider} account itself isn't affected.</>
    );
    const approved = await confirm({
      title: "Remove Account",
      message: `${masked(account.label)} (${provider}) is removed from ${machine}, and the sign-in Wollipog stored for it is deleted. ` +
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
          ...(result.credentialsRetained ? { detail: "Its credentials were kept because a session on this machine still uses them." } : {}),
        });
      } catch (cause) {
        setNotice({ title: <>Couldn't Remove {identifier(account)}</>, ...providerAccountRemovalRefusal(cause, runner.agents) });
      }
    });
  };

  const runProfileAction = (account: ProviderAccountDefinition, action: "adopt" | "revoke", run: () => Promise<void>) =>
    track(account.id, action, async () => {
      setNotice(null);
      try {
        await run();
      } catch (cause) {
        setNotice({
          title: action === "adopt" ? <>Couldn't Adopt {identifier(account)}</> : <>Couldn't Revoke Access to {identifier(account)}</>,
          body: providerProfileErrorMessage(cause, action),
        });
      }
    });

  const accountRows = (account: ProviderAccountDefinition) => [{ label: masked(account.label), meta: providerName(account.provider) }];

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

  const menuItems = (account: ProviderAccountDefinition, signingIn: boolean): RowMenuItem[] => {
    if (!canManage) return [];
    const offline = online ? {} : { disabled: true, description: OFFLINE };
    const items: RowMenuItem[] = [];
    if (supported && account.authStatus !== "unauthenticated" && !signingIn) {
      items.push({ label: "Sign In Again…", ...offline, onClick: () => signIn(account) });
    }
    if (profileActions && account.profile?.access !== "granted") {
      items.push({ label: "Adopt as Profile…", ...offline, onClick: (reopen) => void adopt(account, reopen) });
    }
    if (profileActions && (account.profile?.access === "granted" || account.profile?.access === "pending")) {
      items.push({ label: "Revoke Access…", danger: true, onClick: (reopen) => void revoke(account, reopen) });
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

  const loginFor = (accountId: string) => logins.find((login) => login.accountId === accountId);
  const loginCard = (login: ProviderLoginView | undefined) =>
    login && <ProviderLoginCard runnerId={runner.runnerId} login={login} />;

  if (!supported && accounts.length === 0) return null;
  const canAdd = supported && canManage;
  const count = accounts.length + newLogins.length;
  return (
    <section className="section" aria-labelledby={headingId}>
      <div className="section-head">
        <h3 id={headingId} className="section-title">
          Provider Accounts <span className="count">{accounts.length}</span>
        </h3>
        {canAdd && (
          <div className="actions">
            <button type="button" className="btn sm" disabled={!online} aria-describedby={online ? undefined : offlineId}
              onClick={() => setAdding(true)}>
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
      {count > 0 && (
        <div className="surface provider-accounts-list">
          {accounts.map((account) => {
            const login = loginFor(account.id);
            const signingIn = login !== undefined && providerLoginRunning(login);
            const status = accountStatus(account, signingIn);
            const action = busy[account.id];
            const showSignIn = supported && canManage && status === "sign_in_required";
            return (
              <ProviderAccountRow
                key={account.id}
                identity={`${runner.runnerId}:${account.id}`}
                label={account.label}
                provider={account.provider}
                profile={account.profile ? PROFILE_ACCESS[account.profile.access] : undefined}
                status={status}
                actions={canManage && (
                  <>
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
                {loginCard(login)}
              </ProviderAccountRow>
            );
          })}
          {newLogins.map((login) => (
            <ProviderAccountRow
              key={login.operationId}
              identity={`${runner.runnerId}:${login.accountId}`}
              label={login.label}
              provider={login.provider}
              status={providerLoginRunning(login) ? "signing_in" : null}
            >
              {loginCard(login)}
            </ProviderAccountRow>
          ))}
        </div>
      )}
      {adding && (
        <AddProviderAccountDialog
          runnerId={runner.runnerId}
          machineName={machine}
          accounts={accounts}
          logins={logins}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
