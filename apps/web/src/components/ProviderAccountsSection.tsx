import React, { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  PROVIDER_ACCOUNT_POLICY_NOT_FIXED, PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL, providerAccountPolicyMode, providerAccountPolicyFixedId,
  runnerSupportsProtocol, runnerSupportsProviderCredentialImport,
  providerForDriver, providerLoginInstallationMissing,
  type ProviderAccountDefinition, type ProviderHomeLeaseInspection, type ProviderLoginView, type RunnerView,
} from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { agentDisplayName } from "../agent-presentation.js";
import { accountLabelText, maskedAccountTitles } from "../personal-identifiers.js";
import { machineSettingsMutationError, runnerDisplay } from "../runners.js";
import type { MachineAccountsIntent } from "../navigation.js";
import { providerHomeBlockingProcessCopy, providerHomeRecoveryCauseCopy } from "../provider-home-refusal.js";
import { statusMeta } from "../status-meta.js";
import { providerReadinessSentence } from "../provider-readiness.js";
import { useFeedback } from "./FeedbackProvider.js";
import { activeSessionConflict } from "./active-session-conflict.js";
import { AccountIdentifier } from "./AccountIdentifier.js";
import { conflictCurrent, RunningSessionAccountSettings } from "./ProviderAccountSettings.js";
import { Modal } from "./common.js";
import { AddProviderAccountDialog, providerLoginRunning, providerName, type ProviderCredentialImportOffer } from "./AddProviderAccountDialog.js";
import { ArrowDownIcon, ArrowUpIcon, MoreHorizontalIcon, SignInIcon } from "./Icons.js";
import { SegmentedControl } from "./ui/ChoiceControls.js";
import { ExpectedProviderAccount, providerAccountGroupRefusalSentence, providerAccountSelectionRefreshKey, providerAccountSkipLabel, useProviderAccountSelection } from "./ProviderAccountSelection.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from "./Menu.js";
import { Notice } from "./Notice.js";
import { providerLoginStartFailure } from "../provider-login-start-failure.js";
import { ProviderLoginStartFailure } from "./ProviderLoginStartFailure.js";
import { ProviderSignIn, providerSignInAlreadyOnMachine, providerSignInHiddenTitle } from "./ProviderLoginCard.js";
import { StatusBadge } from "./StatusBadge.js";
import { ProviderAccountUsage, useMachineAccountUsage } from "./ProviderAccountUsage.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Coded adoption refusals whose runner message is technical, in words the person can act on. */
const ADOPTION_REFUSALS: Readonly<Record<string, string>> = {
  PROFILE_EXISTS: "This account's HOME already has a profile record that cannot accept this control plane. " +
    "It may be unreadable, belong to the other provider, or already list the maximum number of control planes.",
  HOME_IN_USE: "Another runner or control plane is using this account's HOME. Try again when it is no longer in use.",
  UNSUPPORTED_HOME: "This account's HOME cannot hold a provider profile. Windows Machines and WSL account homes are not supported.",
  PROVIDER_PROFILE_GRANT_REVOKED: "Access was revoked while this change was being made. Open Account Access and try again to grant access.",
};

/** Windows Machines cannot verify a profile marker, so their accounts never become profiles. */
export const PROFILES_UNSUPPORTED_ON_WINDOWS =
  "Limiting account access isn't available on Windows machines because this runner can't verify the access record.";

const ADOPTION_FAILED_DEFAULT = "The provider profile could not be adopted.";

/** Why an Owner or Admin can't copy an existing sign-in on this machine (#3719). */
export const IMPORT_UNAVAILABLE = {
  windows: "Copying an existing sign-in isn't available on Windows machines, which can't verify a copied sign-in. Sign in to create the profile.",
  update: "Update this machine's runner to copy an existing sign-in. Until then, sign in to create the profile.",
  context: "Copying an existing sign-in isn't available on this machine: its runner runs inside WSL or a container, where a copied sign-in can't be verified. Sign in to create the profile.",
  offline: "This machine is offline, so its sign-ins can't be copied now. Sign in once it's back, or try again later.",
} as const;

/** #3719: what Add Account offers an Owner or Admin besides a new sign-in. Only a Codex API-key
 * sign-in on a native Linux or macOS machine can be copied; the runner reports the capability. */
export function providerCredentialImportOffer(runner: RunnerView, online: boolean, accounts: readonly ProviderAccountDefinition[]): ProviderCredentialImportOffer {
  if (runner.os === "windows") return { available: false, reason: IMPORT_UNAVAILABLE.windows };
  if (!runnerSupportsProtocol(runner.protocolVersion, "providerCredentialImport")) return { available: false, reason: IMPORT_UNAVAILABLE.update };
  if (!runnerSupportsProviderCredentialImport(runner)) return { available: false, reason: IMPORT_UNAVAILABLE.context };
  if (!online) return { available: false, reason: IMPORT_UNAVAILABLE.offline };
  const codex = accounts.filter((account) => account.provider === "codex");
  // Hidden identifiers are numbered in list order, so two email labels stay distinct before reveal.
  const masked = maskedAccountTitles(codex.map((account) => account.label));
  return {
    available: true,
    sources: [
      { key: "default", source: { kind: "default_home" }, name: PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL,
        masked: PROVIDER_CREDENTIAL_IMPORT_DEFAULT_SOURCE_LABEL },
      ...codex.map((account, index) => ({
        key: `account:${account.id}`, source: { kind: "account" as const, accountId: account.id }, name: account.label, masked: masked[index]!,
      })),
    ],
  };
}

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
    return "The machine did not confirm the access change in time. It completes when the machine reports the account again.";
  }
  if (action === "adopt" && cause.status === 409 && cause.message === "runner is offline") {
    return "The machine is offline. Changing account access needs the machine to be online.";
  }
  if (cause.status === 409 && cause.code && ADOPTION_REFUSALS[cause.code]) return ADOPTION_REFUSALS[cause.code]!;
  if (cause.status === 409 && cause.code === "PROVIDER_PROFILE_ADOPTION_FAILED") {
    // No code: the runner kept this authorization pending, so a retry reuses it.
    const detail = cause.message && cause.message !== ADOPTION_FAILED_DEFAULT ? ` ${cause.message}` : "";
    return `The machine could not change access to this account. Open Account Access and try again.${detail}`;
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
  if (account.providerReadiness && ["in_use", "restricted", "unknown"].includes(account.providerReadiness.reason)) return "status_unknown";
  return account.authStatus === "authenticated" ? "signed_in"
    : account.authStatus === "unauthenticated" ? "sign_in_required"
    : "status_unknown";
}

const PROFILE_ACCESS: Readonly<Record<NonNullable<ProviderAccountDefinition["profile"]>["access"], string>> = {
  granted: "",
  pending: "Grant Pending",
  not_granted: "No Access Here",
};

type BusyAction = "sign_in" | "cancel" | "remove" | "adopt" | "revoke" | "recover" | "default";

type AccountProvider = ProviderAccountDefinition["provider"];
type AccountPolicy = NonNullable<RunnerView["providerAccountDefaults"]>[number];

/** The order Priority Order starts from: the saved default first, then the list as shown, without an
 * account this server may not use. */
export function initialPriorityOrder(accounts: readonly ProviderAccountDefinition[], fixedAccountId: string | null): string[] {
  const usable = accounts.filter((account) => account.profile?.access !== "not_granted").map((account) => account.id);
  return fixedAccountId && usable.includes(fixedAccountId) ? [fixedAccountId, ...usable.filter((id) => id !== fixedAccountId)] : usable;
}

/** Swap one entry with its neighbor. An edge entry stays put. */
export function movedPriorityOrder(order: readonly string[], accountId: string, direction: "up" | "down"): string[] {
  const from = order.indexOf(accountId);
  const to = from + (direction === "up" ? -1 : 1);
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

/** Keeps a moved row's control focused, and a reader told where it landed. A button that just reached
 * an edge hands focus to its other direction, so another press still does something. */
function MoveButton({ accountId, direction, name, edge, busy, onMove }: {
  accountId: string;
  direction: "up" | "down";
  name: string;
  edge: boolean;
  busy: boolean;
  onMove: () => void;
}) {
  const word = direction === "up" ? "Up" : "Down";
  return (
    <button type="button" className="icon-btn sm provider-account-move" data-move={`${accountId}:${direction}`}
      title={`Move ${word}`} aria-label={`Move ${name} ${word}`} aria-disabled={edge || busy || undefined} aria-busy={busy || undefined}
      onClick={() => { if (!edge && !busy) onMove(); }}>
      {direction === "up" ? <ArrowUpIcon /> : <ArrowDownIcon />}
    </button>
  );
}

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
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        title="More Actions"
        aria-label={`More Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={() => { if (!busy) menu.toggle(); }}
        onKeyDown={event => {
          if (busy) { if (event.key === "Enter" || event.key === " ") event.preventDefault(); return; }
          menu.onTriggerKeyDown(event);
        }}
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
 * One account (§5.2): a key icon, the label (masked under Hide Account Emails), its profile access as line 2, the one status badge, then the row's actions. `children` is the row's
 * expansion under it: its sign-in's steps or ending (#2996). While a sign-in runs for a label that is
 * a hidden email, `hiddenTitle` ("Signing In to Codex") replaces the mask, with "Email hidden" as line 2.
 */
function ProviderAccountRow({ identity, label, hiddenTitle, profile, lease, status, actions, children, marker, rank, skip, usage, readinessNote }: {
  /** "Default", or "Next Session" for the account Priority Order expects to use. */
  marker?: string;
  /** The account's place in the Priority Order, leading its name. */
  rank?: number;
  /** Why Priority Order passes over this account, as a sentence. */
  skip?: string;
  usage?: ReactNode;
  identity: string;
  label: string;
  hiddenTitle?: string | null;
  profile?: string;
  /** A stale HOME lease (#3241), with why it cannot be recovered now, if it cannot. */
  lease?: { label: string; title?: string };
  status: AccountStatus | null;
  actions?: ReactNode;
  children?: ReactNode;
  readinessNote?: string;
}) {
  const meta = status && status !== "signed_in" ? statusMeta("provider_account", status) : null;
  return (
    <>
      <div className={`row row-2${hiddenTitle ? " provider-account-hidden-title" : ""}`} data-account-status={status ?? undefined}>
        <span className="row-icon" aria-hidden="true"><SignInIcon /></span>
        <span className="row-body">
          <span className="row-line">
            {rank !== undefined && <span className="provider-account-rank"><span className="sr-only">Priority </span>{rank}</span>}
            {hiddenTitle ? <span className="row-title provider-account-signing-title">{hiddenTitle}</span>
              : <AccountIdentifier identity={identity} className="row-title" value={label} label="Account Email" />}
            {marker && <span className="provider-default-marker">{marker}</span>}
            {meta && <StatusBadge meta={meta} />}
          </span>
          {(hiddenTitle || profile || lease || skip) && <span className="row-sub provider-account-sub">
            {hiddenTitle ? <span>Email hidden</span> : (
              <>
                {profile && <span>{profile}</span>}
              </>
            )}
            {lease && <span className="provider-account-lease" title={lease.title}>{lease.label}</span>}
            {skip && <span className="provider-account-skip">{skip}</span>}
          </span>}
        </span>
        {usage}
        {actions && <span className="provider-account-actions">{actions}</span>}
      </div>
      {(children || readinessNote) && <div className="provider-account-expansion">{readinessNote && <p className="section-note">{readinessNote}</p>}{children}</div>}
    </>
  );
}

type SectionNotice = { title: ReactNode; body: ReactNode; details?: string };

/** What Priority Order expects to do now, and whether this Machine can do it. */
function PrioritySummary({ runner, preview }: {
  runner: RunnerView;
  preview: NonNullable<ReturnType<typeof useProviderAccountSelection>>;
}) {
  if (preview.enforcement === "runner_update_required") {
    return <Notice compact tone="warning" title="Priority Order Isn't Being Applied">
      This machine's runner can't enforce the saved order, so it can't be changed or checked here, and new sessions need an account chosen. Update the runner, or switch to Default Account.
    </Notice>;
  }
  if (preview.status === "choice_required") {
    return <Notice compact tone="warning" title="No Eligible Account">{providerAccountGroupRefusalSentence(preview, providerName(preview.provider))}</Notice>;
  }
  return <div className="provider-selection-summary">
    {preview.enforcement === "machine_offline" && <p className="section-note">This machine is offline. The order applies when it reconnects.</p>}
    <ExpectedProviderAccount runner={runner} preview={preview} />
  </div>;
}

/**
 * One provider's heading and policy: the mode, what the policy expects now, then its rows.
 * A component of its own so each provider reads its own preview.
 */
function ProviderAccountGroup({ runner, online, provider, policy, canEdit, saving, chooseMode, providerNotices, moveStatus, rows }: {
  runner: RunnerView;
  online: boolean;
  provider: AccountProvider;
  policy: AccountPolicy | undefined;
  canEdit: boolean;
  saving: boolean;
  chooseMode: (provider: AccountProvider, mode: "fixed" | "priority") => void;
  /** The fixed default's own notices, shown only under that mode. */
  providerNotices: ReactNode;
  /** Where the last moved row landed. Visible for sighted and touch users, and announced. */
  moveStatus: string;
  rows: (preview: ReturnType<typeof useProviderAccountSelection>) => ReactNode;
}) {
  const mode = providerAccountPolicyMode(policy);
  const accounts = (runner.providerAccounts ?? []).filter((account) => account.provider === provider);
  // The list can show a revision the Machine's stream hasn't delivered, such as a conflict's saved
  // order. Read again for it, and never pair an earlier revision's expectation with this order.
  const reading = useProviderAccountSelection(runner.runnerId, mode === "priority" ? { provider } : null,
    `${providerAccountSelectionRefreshKey(runner, online)}\0${policy?.revision ?? 0}`);
  const preview = reading?.policyRevision === (policy?.revision ?? 0) ? reading : null;
  const prioritySupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountSelectionPolicy");
  const anyUsable = accounts.some((account) => account.profile?.access !== "not_granted");
  // One account has nothing to rank, and an older runner can't enforce an order, so the choice appears
  // once there is one to make. A saved policy keeps its control, so it can always be replaced.
  const offerModes = canEdit && (mode !== "fixed" || (accounts.length > 1 && prioritySupported));
  const fixedId = providerAccountPolicyFixedId(policy);
  return <div className="provider-account-group">
    <div className="provider-settings-heading">
      <h4>{providerName(provider)}</h4>
      {offerModes ? (
        <SegmentedControl<"fixed" | "priority">
          className="sm"
          label={`${providerName(provider)} Account Selection`}
          value={mode === "unsupported" ? null : mode}
          onChange={(next) => { if (!saving && next !== mode) chooseMode(provider, next); }}
          options={[
            { value: "fixed", label: "Default Account" },
            { value: "priority", label: "Priority Order",
              ...(!anyUsable && mode !== "priority" ? { disabled: true, disabledReason: "This server needs access to an account first." } : {}) },
          ]}
        />
      ) : <span className="section-note">{mode === "priority" ? "Priority Order" : mode === "unsupported" ? "Newer Policy" : fixedId ? "Default Account" : "No Default"}</span>}
    </div>
    {canEdit && !prioritySupported && mode === "fixed" && accounts.length > 1 && <p className="section-note provider-selection-note">Update this machine's runner to use Priority Order.</p>}
    {mode === "unsupported" && <Notice compact tone="warning" title="Account Policy from a Newer Server">
      This server can't apply the saved policy, so new sessions need an account chosen. {canEdit ? "Choose a mode to replace it." : "Ask this machine's owner to replace it."}
    </Notice>}
    {mode === "priority" && preview && <PrioritySummary runner={runner} preview={preview} />}
    {/* Always rendered, so a screen reader is already listening when the text arrives. */}
    {mode === "priority" && <p className="provider-selection-status" role="status">{moveStatus}</p>}
    {mode === "fixed" && providerNotices}
    {/* An older runner evaluates nothing, so its rows must not read as if the order were checked. */}
    <div className="provider-accounts-list">{rows(preview?.enforcement === "runner_update_required" ? null : preview)}</div>
  </div>;
}

/**
 * Provider Accounts, a section of the machine detail (#2995, docs/design-system.md §4.5): its count
 * and Add Account…, then one surface of account rows, each with one status. Removal and the profile
 * actions live in each row's ⋯; a refusal is one compact notice between the title and the rows.
 */
export function ProviderAccountsSection({ runner, online, machineName, canManageProfiles = false, profileAccessKnown = true, intent, showMachineSettings = true }: {
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
  /** Embedded setup keeps unrelated running-session policy in Machine detail. */
  showMachineSettings?: boolean;
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
  const [accessAccountId, setAccessAccountId] = useState<string | null>(null);
  const [recoveryDetails, setRecoveryDetails] = useState<{ runnerId: string; accountId: string } | null>(null);
  const [busy, setBusy] = useState<Readonly<Record<string, BusyAction>>>({});
  const [notice, setNotice] = useState<SectionNotice | null>(null);
  const defaultWrites = useRef(new Set<ProviderAccountDefinition["provider"]>());
  const [savedDefaults, setSavedDefaults] = useState<NonNullable<RunnerView["providerAccountDefaults"]>>([]);
  // A control whose row just moved takes focus back once the list has redrawn, and a reader hears where.
  const [moved, setMoved] = useState<{ provider: AccountProvider; label: string; position: number; total: number; selector: string; fallback: string } | null>(null);
  const usage = useMachineAccountUsage(runner, online);
  const defaults = (["claude", "codex"] as const).flatMap(provider => {
    const live = runner.providerAccountDefaults?.find(value => value.provider === provider);
    const saved = savedDefaults.find(value => value.provider === provider);
    const value = saved && saved.revision >= (live?.revision ?? 0) ? saved : live;
    return value ? [value] : [];
  });
  const supported = runnerSupportsProtocol(runner.protocolVersion, "providerLogin");
  const removalSupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountRemoval");
  const canManage = runner.canManage === true;
  const canEditDefaults = canManageProfiles && canManage && runnerSupportsProtocol(runner.protocolVersion, "providerAccounts");
  // A runner that can't enforce an order refuses changes to it, so it offers none. Default Account stays.
  const prioritySupported = runnerSupportsProtocol(runner.protocolVersion, "providerAccountSelectionPolicy");
  const profileActions = canManageProfiles && runnerSupportsProtocol(runner.protocolVersion, "providerProfiles");
  const machine = machineName ?? runnerDisplay(runner, undefined).name;
  const accounts = runner.providerAccounts ?? [];
  const accessAccount = accounts.find(account => account.id === accessAccountId);
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
      setNotice({ title: <>Couldn't Sign In to {identifier(account)}</>, body: <ProviderLoginStartFailure failure={providerLoginStartFailure(cause)} /> });
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
          title: action === "adopt" ? <>Couldn't Change Access to {identifier(account)}</>
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
    const alreadyRestricted = !!account.profile;
    const approved = await confirm({
      title: alreadyRestricted ? "Give This Server Access" : "Limit Access to This Server",
      message: "This server gets access, and only Wollipog servers with access can use this account on this machine. " +
        "Existing access grants and running sessions are unchanged; new sessions record this access.",
      detailRows: accountRows(account),
      confirmLabel: alreadyRestricted ? "Give Access" : "Limit Access",
      back: { label: "Back to Account Access", run: reopen },
    });
    if (!approved) return;
    setAccessAccountId(null);
    await runProfileAction(account, "adopt", async () => {
      await api.adoptProviderProfile(runner.runnerId, account.id);
      showToast("Account access updated.", { tone: "success" });
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
      back: { label: "Back to Account Access", run: reopen },
    });
    if (!approved) return;
    setAccessAccountId(null);
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
    ? defaults.find((entry) => entry.provider === startedAccount.provider)
    : undefined;
  // Priority Order ranks a new account from its menu; a default wouldn't apply.
  const defaultOffer = startedAccount && canManageProfiles && canManage && providerAccountPolicyMode(savedDefault) === "fixed" &&
    runnerSupportsProtocol(runner.protocolVersion, "providerAccounts") && savedDefault?.accountId !== startedAccount.id
    ? startedAccount : undefined;
  const saveDefault = async (provider: ProviderAccountDefinition["provider"], account: ProviderAccountDefinition | null) => {
    if (!canEditDefaults || defaultWrites.current.has(provider) || account?.profile?.access === "not_granted") return;
    defaultWrites.current.add(provider);
    const key = account?.id ?? defaults.find(value => value.provider === provider)?.accountId ?? `default:${provider}`;
    await track(key, "default", async () => {
      setNotice(null);
      try {
        const { providerAccountDefault } = await api.updateMachineProviderAccountDefault(runner.runnerId, provider, {
          accountId: account?.id ?? null,
          expectedRevision: defaults.find(value => value.provider === provider)?.revision ?? 0,
        });
        if (account) setStarted(current => current?.accountId === account.id ? null : current);
        setSavedDefaults(current => [...current.filter(value => value.provider !== provider), providerAccountDefault]);
        showToast(account ? `Default ${providerName(provider)} account updated. Running sessions aren't affected.`
          : `Default ${providerName(provider)} account cleared. New sessions use the agent's configured account or the first available account.`, { tone: "success" });
      } catch (cause) {
        const current = conflictCurrent(cause);
        const valid = current?.provider === provider && (current.accountId === null || typeof current.accountId === "string");
        if (valid) setSavedDefaults(values => [...values.filter(value => value.provider !== provider), {
          provider, accountId: current.accountId as string | null, revision: current.revision as number,
        }]);
        const notFixed = cause instanceof ApiError && cause.code === PROVIDER_ACCOUNT_POLICY_NOT_FIXED;
        setNotice({ title: "Couldn't Update the Default", body: valid
          ? "The default changed in another client. Review the Default badge, then choose again."
          : notFixed ? "This provider's account selection changed in another client. Review it, then choose again."
          : machineSettingsMutationError(cause) });
      } finally { defaultWrites.current.delete(provider); }
    });
  };

  /** Write the whole policy against the revision on screen. A conflict shows what is saved now and
   * waits for another explicit action. Nothing is retried or overwritten. */
  const savePolicy = async (provider: AccountProvider, change: { mode: "fixed" | "priority"; priorityAccountIds?: string[] }, onSaved: () => void) => {
    if (!canEditDefaults || defaultWrites.current.has(provider)) return;
    defaultWrites.current.add(provider);
    setNotice(null);
    await track(`policy:${provider}`, "default", async () => {
      try {
        const { providerAccountPolicy } = await api.updateMachineProviderAccountPolicy(runner.runnerId, provider, {
          ...change, expectedRevision: defaults.find((value) => value.provider === provider)?.revision ?? 0,
        });
        setSavedDefaults((current) => [...current.filter((value) => value.provider !== provider), providerAccountPolicy]);
        onSaved();
      } catch (cause) {
        const current = conflictCurrent(cause);
        if (current?.provider === provider) setSavedDefaults((values) => [...values.filter((value) => value.provider !== provider), current as unknown as AccountPolicy]);
        setNotice({ title: `Couldn't Update ${providerName(provider)} Account Selection`, body: current?.provider === provider
          ? `${providerName(provider)} account selection changed in another client. The list now shows what's saved. Choose again to change it.`
          : machineSettingsMutationError(cause) });
      } finally { defaultWrites.current.delete(provider); }
    });
  };

  const chooseMode = (provider: AccountProvider, mode: "fixed" | "priority") => {
    const policy = defaults.find((value) => value.provider === provider);
    const saved = policy?.priorityAccountIds ?? [];
    const order = saved.length ? saved : initialPriorityOrder(accounts.filter((account) => account.provider === provider), providerAccountPolicyFixedId(policy));
    void savePolicy(provider, mode === "priority" ? { mode, priorityAccountIds: order } : { mode }, () => {
      showToast(`${mode === "priority" ? "Priority Order" : "Default Account"} now applies to new ${providerName(provider)} sessions. Running sessions aren't affected.`, { tone: "success" });
    });
  };

  const moveAccount = (provider: AccountProvider, accountId: string, direction: "up" | "down", label: string) => {
    const order = defaults.find((value) => value.provider === provider)?.priorityAccountIds ?? [];
    const next = movedPriorityOrder(order, accountId, direction);
    void savePolicy(provider, { mode: "priority", priorityAccountIds: next }, () => {
      const position = next.indexOf(accountId) + 1;
      const atEdge = direction === "up" ? position === 1 : position === next.length;
      const opposite = direction === "up" ? "down" : "up";
      // The label, not a finished sentence: Hide Account Emails can change while this is on screen.
      setMoved({
        provider,
        label,
        position,
        total: next.length,
        selector: `${accountId}:${atEdge ? opposite : direction}`,
        fallback: `${accountId}:${direction}`,
      });
    });
  };

  const rankAccount = (provider: AccountProvider, accountId: string, ranked: boolean) => {
    const order = defaults.find((value) => value.provider === provider)?.priorityAccountIds ?? [];
    void savePolicy(provider, { mode: "priority", priorityAccountIds: ranked ? [...order, accountId] : order.filter((id) => id !== accountId) }, () => {
      showToast(ranked ? "Account added to the Priority Order." : "Account removed from the Priority Order.", { tone: "success" });
    });
  };

  useEffect(() => {
    if (!moved) return;
    // Account ids hold only letters, digits and `._-`, so they are safe inside the quotes.
    const button = sectionRef.current?.querySelector<HTMLElement>(`[data-move="${moved.selector}"]`) ??
      sectionRef.current?.querySelector<HTMLElement>(`[data-move="${moved.fallback}"]`);
    button?.focus();
    const timer = window.setTimeout(() => setMoved(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [moved]);

  const menuItems = (account: ProviderAccountDefinition, signingIn: boolean): RowMenuItem[] => {
    if (!canManage) return [];
    const offline = online ? {} : { disabled: true, description: OFFLINE };
    const items: RowMenuItem[] = [];
    const policy = defaults.find(value => value.provider === account.provider);
    if (canEditDefaults && providerAccountPolicyMode(policy) === "priority" && prioritySupported) {
      const order = policy?.priorityAccountIds ?? [];
      const ranked = order.includes(account.id);
      const saving = defaultWrites.current.has(account.provider);
      items.push({ label: ranked ? "Remove from Priority Order" : "Add to Priority Order",
        ...(saving ? { disabled: true, description: "Saving the account selection…" }
          : ranked && order.length === 1 ? { disabled: true, description: "Priority Order needs at least one account." }
          : !ranked && account.profile?.access === "not_granted" ? { disabled: true, description: "This control plane needs access to the account first." } : {}),
        onClick: () => rankAccount(account.provider, account.id, !ranked),
      });
    } else if (canEditDefaults && providerAccountPolicyMode(policy) === "fixed") {
      const isDefault = policy?.accountId === account.id;
      const blocked = !isDefault && account.profile?.access === "not_granted";
      const saving = defaultWrites.current.has(account.provider);
      items.push({ label: isDefault ? "Clear Default" : "Set as Default",
        ...(saving ? { disabled: true, description: "Saving the default account…" }
          : blocked ? { disabled: true, description: "This control plane needs access to the account first." } : {}),
        onClick: () => void saveDefault(account.provider, isDefault ? null : account),
      });
    }
    if (supported && account.authStatus !== "unauthenticated" && !signingIn) {
      items.push({ label: "Sign In Again…", ...offline, onClick: () => signIn(account) });
    }
    if (profileActions) {
      items.push({ label: "Account Access…", onClick: () => setAccessAccountId(account.id) });
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
  const installationIssues: Partial<Record<ProviderAccountDefinition["provider"], string>> = {};
  for (const provider of ["claude", "codex"] as const) {
    const native = runner.agents.filter((agent) => providerForDriver(agent.driver ?? "acp") === provider &&
      agent.context?.kind !== "wsl" && !agent.harnessSelectionBlocked && agent.installation?.selection !== "other");
    if ((native.length > 0 && native.every(providerLoginInstallationMissing)) ||
        (native.length === 0 && runner.agentsRefreshed === true && runnerSupportsProtocol(runner.protocolVersion, "providerSetupReadiness"))) {
      installationIssues[provider] = `Install ${providerName(provider)} on this machine, then rediscover before starting sign-in.`;
    }
  }
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
              Add Separate Sign-In…
            </button>
          </div>
        )}
      </div>
      {canAdd && !online && <p className="section-note" id={offlineId}>{OFFLINE}</p>}
      {supported && accounts.length === 0 && (
        <p className="section-note">Wollipog uses this machine's existing sign-ins where access is permitted. A separate sign-in is optional. Credentials stay on the machine; the provider's billing and usage limits still apply.</p>
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
                disabled={defaultWrites.current.has(defaultOffer.provider)} onClick={() => void saveDefault(defaultOffer.provider, defaultOffer)}>
                Use for New Sessions
              </BusyButton>
              <button type="button" className="btn sm" onClick={() => setStarted(null)}>Not Now</button>
            </>
          )}>
          New {providerName(defaultOffer.provider)} sessions on this machine that don't choose an account will use it.
        </Notice>
      )}
      {count > 0 || defaults.some(value => value.accountId || value.priorityAccountIds?.length) ? <div className="surface provider-accounts-surface">
      {(["claude", "codex"] as const).filter(provider => accounts.some(account => account.provider === provider) ||
        newLogins.some(login => login.provider === provider) ||
        defaults.some(value => value.provider === provider && (value.accountId || value.priorityAccountIds?.length))).map(provider => {
        const choice = defaults.find(value => value.provider === provider);
        const selected = accounts.find(account => account.id === choice?.accountId && account.provider === provider);
        const unavailable = !!choice?.accountId && (!selected || selected.profile?.access === "not_granted");
        const priority = providerAccountPolicyMode(choice) === "priority";
        const order = priority ? choice?.priorityAccountIds ?? [] : [];
        const providerAccounts = accounts.filter(account => account.provider === provider);
        // Ranked accounts in their order, then the rest. A ranked account that left stays in its place,
        // as its id alone.
        const listed: Array<ProviderAccountDefinition | string> = priority
          ? [...order.map(id => providerAccounts.find(account => account.id === id) ?? id),
             ...providerAccounts.filter(account => !order.includes(account.id))]
          : providerAccounts;
        const savingPolicy = busy[`policy:${provider}`] !== undefined;
        return <ProviderAccountGroup key={provider} runner={runner} online={online} provider={provider} policy={choice}
          canEdit={canEditDefaults} saving={savingPolicy} chooseMode={chooseMode}
          moveStatus={moved?.provider === provider ? `Moved ${masked(moved.label)} to position ${moved.position} of ${moved.total}.` : ""}
          providerNotices={unavailable && <Notice compact tone="warning" title="Default Account Unavailable"
            actions={canEditDefaults && <button type="button" className="btn sm" disabled={defaultWrites.current.has(provider)}
              onClick={() => void saveDefault(provider, null)}>Clear {providerName(provider)} Default</button>}>
            {selected ? "The saved default needs access to this control plane. Grant access or choose another account from its menu."
              : "The saved default account is missing. Choose another account from its menu or clear the default."}
          </Notice>}
          rows={(preview) => <>
          {listed.map((account) => {
            if (typeof account === "string") {
              const position = order.indexOf(account);
              return <ProviderAccountRow key={account} identity={`${runner.runnerId}:${account}`} label="Missing Account" status={null}
                rank={position + 1} skip={preview ? providerAccountSkipLabel({ reason: "missing" }) : "No longer on this machine."}
                actions={canEditDefaults && prioritySupported && (
                  <button type="button" className="btn sm" disabled={savingPolicy || order.length === 1}
                    aria-label={`Remove Missing Account ${position + 1} from Priority Order`}
                    onClick={() => rankAccount(provider, account, false)}>Remove</button>
                )} />;
            }
            const position = order.indexOf(account.id);
            const candidate = preview?.candidates.find(value => value.accountId === account.id);
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
                profile={account.profile ? PROFILE_ACCESS[account.profile.access] : undefined}
                readinessNote={account.providerReadiness ? providerReadinessSentence(account.providerReadiness, online && runner.agentsRefreshed === true) : undefined}
                lease={leaseActions && leases[account.id]?.state === "stale" ? {
                  label: "Recovery Needed",
                  title: providerHomeLeaseDescription(leases[account.id]!) ?? "An earlier Wollipog runner left this account locked. Choose Recover Account in its menu to try unlocking it.",
                } : undefined}
                status={status}
                {...(priority ? {
                  ...(position >= 0 ? { rank: position + 1 } : {}),
                  marker: candidate?.selected ? "Next Session" : position < 0 ? "Not Ranked" : undefined,
                  skip: candidate ? providerAccountSkipLabel(candidate) : undefined,
                } : { marker: account.id === choice?.accountId ? "Default" : undefined })}
                usage={!signingIn && <ProviderAccountUsage account={account} runnerId={runner.runnerId} online={online} data={usage} />}
                actions={canManage && (
                  <>
                    {canEditDefaults && prioritySupported && priority && position >= 0 && order.length > 1 && <>
                      <MoveButton accountId={account.id} direction="up" name={masked(account.label)} edge={position === 0} busy={savingPolicy}
                        onMove={() => moveAccount(provider, account.id, "up", account.label)} />
                      <MoveButton accountId={account.id} direction="down" name={masked(account.label)} edge={position === order.length - 1} busy={savingPolicy}
                        onMove={() => moveAccount(provider, account.id, "down", account.label)} />
                    </>}
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
          {newLogins.filter(login => login.provider === provider).map((login) => {
            const running = providerLoginRunning(login);
            return (
              <ProviderAccountRow
                key={login.operationId}
                identity={`${runner.runnerId}:${login.accountId}`}
                label={login.label}
                hiddenTitle={providerSignInHiddenTitle(login, privacy.hide)}
                status={running ? "signing_in" : providerSignInAlreadyOnMachine(login) ? "not_added" : null}
                actions={running && canManage ? cancelButton(login) : undefined}
              >
                {signInSteps(login, false)}
              </ProviderAccountRow>
            );
          })}
          </>} />;
      })}
      </div> : null}
      {showMachineSettings && <RunningSessionAccountSettings key={runner.runnerId} runner={runner} online={online} canEdit={canManageProfiles && canManage} />}
      {accessAccount && profileActions && canManage && <Modal title="Account Access" description={identifier(accessAccount)} size="sm"
        onClose={() => setAccessAccountId(null)} footer={<button type="button" className="btn" onClick={() => setAccessAccountId(null)}>Close</button>}>
        <p>{accessAccount.profile?.access === "granted"
          ? "Only Wollipog servers with access can use this account. This server has access."
          : accessAccount.profile?.access === "not_granted"
            ? "Another Wollipog server limits this account, and this server doesn't have access."
            : accessAccount.profile?.access === "pending"
              ? "This server's access is still being confirmed with the machine."
              : "Any Wollipog server connected to this machine can use this account."}</p>
        <p className="field-helper">This controls which Wollipog servers may use the account. It doesn't change the default account for new sessions.</p>
        {accessAccount.profile?.access !== "granted" && <>
          <button type="button" className="btn" disabled={!online || runner.os === "windows" || busy[accessAccount.id] !== undefined}
            aria-describedby={!online || runner.os === "windows" ? `${headingId}-access-reason` : undefined}
            onClick={() => void adopt(accessAccount, () => setAccessAccountId(accessAccount.id))}>
            {accessAccount.profile?.access === "pending" ? "Retry Access…" : accessAccount.profile ? "Give This Server Access…" : "Limit Access to This Server…"}
          </button>
          {(!online || runner.os === "windows") && <p className="field-helper" id={`${headingId}-access-reason`}>
            {runner.os === "windows" ? PROFILES_UNSUPPORTED_ON_WINDOWS : OFFLINE}</p>}
        </>}
        {(accessAccount.profile?.access === "granted" || accessAccount.profile?.access === "pending") && <button type="button" className="btn danger ghost"
          disabled={busy[accessAccount.id] !== undefined} onClick={() => void revoke(accessAccount, () => setAccessAccountId(accessAccount.id))}>
          Remove This Server's Access…
        </button>}
      </Modal>}
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
          installationIssues={installationIssues}
          {...(canManageProfiles && canManage ? { importOffer: providerCredentialImportOffer(runner, online, accounts) } : {})}
          onStarted={(login) => setStarted({ operationId: login.operationId, accountId: login.accountId, provider: login.provider })}
          onImported={(account) => setStarted({ operationId: "", accountId: account.accountId, provider: account.provider })}
          onClose={() => setAdding(null)}
        />
      )}
    </section>
  );
}
