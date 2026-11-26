import { useEffect, useRef, useState } from "react";
import {
  ASSISTANT_DECISION_CATEGORIES,
  ASSISTANT_DECISION_DEFAULT_DURATIONS,
  type AssistantDecisionCategory,
  type AssistantDecisionDefault,
  type AssistantThreadLaunchDefaults,
  type AssistantThreadLimits,
} from "@wollipog/protocol";
import { useAccountEmailPrivacy } from "../account-email-privacy.js";
import { useApi } from "../api-context.js";
import { ASSISTANT_DECISION_GROUPS, DEFAULT_DELEGATION_EXPIRY_OPTIONS, defaultDelegationExpiry } from "../assistant-decision-delegation.js";
import {
  assistantEffortChoices,
  assistantModelChoices,
  effortAfterModelChange,
  fromChoice,
  modelEffortProblem,
  reportsModels,
  toChoice,
} from "../assistant-thread-models.js";
import {
  assistantThreadHarnessLabel,
  assistantThreadsOwnerOnly,
  assistantThreadsUnavailable,
  type AssistantThreadDefaults,
  type AssistantThreadHarness,
} from "../assistant-threads.js";
import { parseCount, parseUsd } from "../guardrail-values.js";
import { useInstanceScope } from "../instance-scope.js";
import { useLeaveGuard } from "../leave-guard.js";
import { maskedAccountTitles } from "../personal-identifiers.js";
import { useOptionalStoreSelector } from "../store.js";
import { AssistantDecisionDelegationDialog } from "./AssistantDecisionDelegationDialog.js";
import { MACHINE_ACCOUNT_POLICY, assistantAccountOptions } from "./AssistantThreadAccountField.js";
import { useFeedback } from "./FeedbackProvider.js";
import { SaveBar } from "./SaveBar.js";
import { SkeletonRows } from "./QuestionPoliciesPanel.js";
import { ActionRow, NumberRow, SegmentedRow, SelectRow, SettingsGroup } from "./ui/SettingsRows.js";

type DelegationMode = "ask" | "all" | "choose";
type DefaultExpiry = keyof typeof ASSISTANT_DECISION_DEFAULT_DURATIONS;

interface Draft {
  harness: AssistantThreadHarness;
  /** An account reference, or Machine Policy. */
  account: string;
  model: string | null;
  effort: string | null;
  budget: string;
  launches: string;
  mode: DelegationMode;
  expiry: DefaultExpiry;
  categories: AssistantDecisionCategory[];
  projects: AssistantDecisionDefault["projects"];
  campaigns: AssistantDecisionDefault["campaigns"];
}

interface Saved {
  defaults: AssistantThreadDefaults | null;
  limits: AssistantThreadLimits | null;
}

const MODE_OPTIONS = [
  { value: "ask", label: "Ask Me", description: "New threads ask you before every decision." },
  { value: "all", label: "Delegate All", description: "New threads decide every category they can for you." },
  { value: "choose", label: "Choose Categories", description: "New threads decide only the categories set to Assistant below." },
];

const ALL_CATEGORIES = Object.keys(ASSISTANT_DECISION_CATEGORIES) as AssistantDecisionCategory[];

/** Categories in the order the delegation dialog groups them. */
const ORDERED_CATEGORIES: AssistantDecisionCategory[] = [
  ...ASSISTANT_DECISION_GROUPS.flatMap((group) => [...group.categories]),
  ...ALL_CATEGORIES.filter((category) => !ASSISTANT_DECISION_GROUPS.some((group) => (group.categories as readonly string[]).includes(category))),
];

function draftFrom({ defaults, limits }: Saved): Draft {
  const launch: AssistantThreadLaunchDefaults | undefined = defaults?.launchDefaults;
  const grant = defaults?.decisionDefault ?? null;
  return {
    harness: launch?.harness ?? defaults?.harness ?? "claude-code",
    account: launch?.providerAccount?.accountRef ?? MACHINE_ACCOUNT_POLICY,
    model: launch?.model ?? null,
    effort: launch?.effort ?? null,
    budget: limits?.costUsd?.toString() ?? "",
    launches: limits?.launchedSessions?.toString() ?? "",
    mode: grant ? grant.selectionMode ?? "choose" : "ask",
    expiry: grant ? defaultDelegationExpiry(grant.expiresAfterMs)?.value ?? "week" : "week",
    categories: grant?.categories ?? [],
    projects: grant?.projects ?? "all",
    campaigns: grant?.campaigns ?? "all",
  };
}

const launchPart = (draft: Draft) => [draft.harness, draft.account, draft.model, draft.effort];
/** By value, so "73.50" typed and 73.5 saved are the same budget; unreadable text stays as typed. */
const limitPart = (draft: Draft) => {
  const budget = budgetEntry(draft.budget);
  const launches = parseCount(draft.launches, Number.MAX_SAFE_INTEGER);
  return [budget.ok ? budget.value : draft.budget, launches.ok ? launches.value : draft.launches];
};
const delegationPart = (draft: Draft) => draft.mode === "ask" ? ["ask"]
  : [draft.mode, draft.expiry, draft.mode === "all" ? [] : [...draft.categories].sort(), draft.projects, draft.campaigns];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function budgetEntry(text: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const parsed = parseUsd(text);
  if (!parsed.ok) return parsed;
  if (parsed.value !== null &&
      (!Number.isSafeInteger(Math.round(parsed.value * 100)) || Number(parsed.value.toFixed(2)) !== parsed.value)) {
    return { ok: false, error: "Enter an amount in whole cents, such as 2.50." };
  }
  return parsed;
}

function scopeSentence(projects: Draft["projects"], campaigns: Draft["campaigns"]): string {
  const count = (scope: string[], one: string, many: string) => `${scope.length} ${scope.length === 1 ? one : many}`;
  if (projects === "all" && campaigns === "all") return "All projects and campaigns.";
  return `${projects === "all" ? "All projects" : count(projects, "project", "projects")} · ${
    campaigns === "all" ? "all campaigns" : count(campaigns, "campaign", "campaigns")}.`;
}

export function AssistantThreadDefaultsPanel() {
  return <AssistantThreadDefaultsForm key={useInstanceScope()} />;
}

/**
 * Settings → Assistant's defaults (§ the Orchestrator and Reviews pages): every value edited in
 * place and saved together with Save Defaults, instead of a dialog per value.
 */
function AssistantThreadDefaultsForm() {
  const api = useApi();
  const { confirm } = useFeedback();
  const privacy = useAccountEmailPrivacy();
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editingScope, setEditingScope] = useState(false);
  // Settings also renders without a live store (harnesses); unknown support stays unavailable.
  const ciRerunSupported = useOptionalStoreSelector((state) => state.assistantCiRerunDecisionsSupported) ?? false;
  const releaseSupported = useOptionalStoreSelector((state) => state.assistantReleaseDecisionsSupported) ?? false;

  useEffect(() => {
    let current = true;
    const quiet = (cause: unknown) => assistantThreadsUnavailable(cause) || assistantThreadsOwnerOnly(cause) !== null;
    void Promise.allSettled([api.assistantThreadDefaults(), api.assistantThreadLimitDefaults()]).then(([launch, limits]) => {
      if (!current) return;
      const failure = [launch, limits].find((result): result is PromiseRejectedResult => result.status === "rejected" && !quiet(result.reason));
      if (failure) {
        setLoadError(failure.reason instanceof Error ? failure.reason.message : String(failure.reason));
        return;
      }
      const next: Saved = {
        defaults: launch.status === "fulfilled" ? launch.value : null,
        limits: limits.status === "fulfilled" ? limits.value : null,
      };
      setSaved(next);
      setDraft(draftFrom(next));
    });
    return () => { current = false; };
  }, [api, attempt]);

  const baseline = saved ? draftFrom(saved) : null;
  const launchDirty = !!draft && !!baseline && !same(launchPart(draft), launchPart(baseline));
  const limitsDirty = !!draft && !!baseline && !same(limitPart(draft), limitPart(baseline));
  const delegationDirty = !!draft && !!baseline && !same(delegationPart(draft), delegationPart(baseline));
  const dirty = launchDirty || limitsDirty || delegationDirty;

  useLeaveGuard(dirty || busy, (leave) => {
    if (busy) return;
    void confirm({ title: "Discard Changes", message: "Your Assistant defaults have unsaved changes. Discarding them keeps the saved defaults.",
      confirmLabel: "Discard Changes", cancelLabel: "Keep Editing", tone: "danger" }).then((discard) => { if (discard && alive.current) leave(); });
  });

  if (loadError) {
    return <SettingsGroup title="Thread Defaults" scope="Your Account" failure={{
      message: "Couldn't load thread defaults.", detail: loadError,
      onRetry: () => { setLoadError(null); setAttempt((count) => count + 1); },
    }}>{null}</SettingsGroup>;
  }
  if (!saved || !draft) {
    return <SettingsGroup title="Thread Defaults" scope="Your Account"><SkeletonRows count={4} announce="Loading thread defaults…" /></SettingsGroup>;
  }
  const { defaults, limits } = saved;
  // A control plane without threads, or a person who can't have them, has nothing to set here.
  if (!defaults && !limits) return null;

  const change = (patch: Partial<Draft>) => setDraft((current) => current && { ...current, ...patch });
  const launchDefaults = defaults?.launchDefaults;
  const option = defaults?.harnesses.find((candidate) => candidate.id === draft.harness);
  const choices = option?.accountSelection;
  // Hidden emails are numbered ("Hidden Account 2") so two accounts stay distinguishable.
  const labels = choices?.accounts.map((account) => account.label) ?? [];
  const titles = privacy.hide ? maskedAccountTitles(labels) : labels;
  // Machine Policy stays choosable for the default, the way back from a stale saved account.
  const accountOptions = assistantAccountOptions(choices, titles, "default");
  const savedAccountGone = draft.account !== MACHINE_ACCOUNT_POLICY && !accountOptions.some((candidate) =>
    candidate.value === draft.account && !candidate.disabled);
  if (savedAccountGone && !accountOptions.some((candidate) => candidate.value === draft.account)) {
    accountOptions.push({ value: draft.account, label: "Saved Account (Unavailable)", disabled: true });
  }
  const modelsSaved = launchDefaults !== undefined && "model" in launchDefaults;
  const modelProblem = modelsSaved ? modelEffortProblem(option, draft.model, draft.effort) : null;
  const modelReason = option && !reportsModels(option) ? undefined
    : !option?.available ? `Connect a Machine with ${assistantThreadHarnessLabel(draft.harness, defaults?.harnesses ?? [])} to choose a model.` : undefined;
  const budget = budgetEntry(draft.budget);
  const launches = parseCount(draft.launches, Number.MAX_SAFE_INTEGER);
  const decisionDefault = defaults?.decisionDefault;
  const unavailable: Partial<Record<AssistantDecisionCategory, string>> = {
    ui_evidence_review: "Approving UI evidence needs the provider disclosure, which you accept in each thread's settings.",
  };
  if (!ciRerunSupported) unavailable.ci_rerun = "Update the control plane to delegate CI reruns.";
  if (!releaseSupported) {
    unavailable.release_tag = "Update the control plane to delegate release tags.";
    unavailable.release_publish = "Update the control plane to delegate release publication.";
  }
  const delegable = ALL_CATEGORIES.filter((category) => !unavailable[category]);
  const blockedReason = savedAccountGone && launchDirty ? "Choose an available account, or Machine Policy."
    : modelProblem && launchDirty ? modelProblem.message
      : limits && !budget.ok ? budget.error
        : limits && !launches.ok ? launches.error
          : draft.mode === "choose" && delegationDirty && !draft.categories.some((category) => delegable.includes(category))
            ? "Set at least one category to Assistant, or choose Ask Me." : null;

  const save = async () => {
    if (busy || blockedReason || !defaults && !limits) return;
    setBusy(true);
    setSaveError(null);
    let next = saved;
    const base = draftFrom(saved);
    // The parts the server now holds. Their fields are refreshed from its answer below, so a value
    // another tab saved never lingers here as an edit that the next save would write back.
    const settled = new Set<"launch" | "limits" | "delegation">();
    // Each write is recorded as it lands: a later one failing never hides an earlier one.
    const recordLaunch = (updated: AssistantThreadDefaults) => {
      next = { ...next, defaults: { ...updated, decisionDefault: next.defaults?.decisionDefault ?? updated.decisionDefault } };
    };
    // Control planes with decision defaults also take per-field PATCHes. Sending only what changed,
    // with the harness the owner saw, keeps another tab's newer edits of the other fields.
    const patchable = decisionDefault !== undefined;
    try {
      if (launchDirty && defaults) {
        const providerAccount = draft.account === MACHINE_ACCOUNT_POLICY || !choices ? null
          : { runnerId: choices.runnerId, accountRef: draft.account };
        if (patchable) {
          let current = base;
          if (draft.harness !== base.harness) {
            // The server resets the account, model and effort with the harness.
            recordLaunch(await api.patchAssistantThreadLaunchDefaults({ harness: draft.harness }));
            current = draftFrom(next);
          }
          if (draft.account !== current.account) {
            recordLaunch(await api.patchAssistantThreadLaunchDefaults({ expectedHarness: draft.harness, providerAccount }));
          }
          if (modelsSaved && (draft.model !== current.model || draft.effort !== current.effort)) {
            recordLaunch(await api.patchAssistantThreadLaunchDefaults({ expectedHarness: draft.harness, model: draft.model, effort: draft.effort }));
          }
        } else {
          // An older control plane takes whole writes only. As the earlier editor did, read what is
          // saved now, keep its account when only the harness is unchanged, and refuse an account
          // chosen for a harness another tab has since replaced.
          const fresh = await api.assistantThreadDefaults();
          const freshHarness = fresh.launchDefaults?.harness ?? fresh.harness;
          if (draft.harness === base.harness && freshHarness !== base.harness) {
            throw new Error("The default harness changed. Reopen Assistant Settings to choose its account.");
          }
          const accountChosen = draft.harness !== base.harness || draft.account !== base.account;
          recordLaunch(await api.setAssistantThreadLaunchDefaults({ harness: draft.harness,
            providerAccount: accountChosen ? providerAccount : fresh.launchDefaults?.providerAccount ?? null }));
        }
        settled.add("launch");
      }
      if (limitsDirty && limits && budget.ok && launches.ok) {
        const changed: Partial<AssistantThreadLimits> = {
          ...(budget.value !== limits.costUsd ? { costUsd: budget.value } : {}),
          ...(launches.value !== limits.launchedSessions ? { launchedSessions: launches.value } : {}),
        };
        if (patchable) {
          // The PATCH route takes one field per request.
          if ("costUsd" in changed) next = { ...next, limits: await api.patchAssistantThreadLimitDefaults({ costUsd: changed.costUsd! }) };
          if ("launchedSessions" in changed) {
            next = { ...next, limits: await api.patchAssistantThreadLimitDefaults({ launchedSessions: changed.launchedSessions! }) };
          }
        } else {
          // Whole writes only: overlay the changed fields on what is saved now.
          next = { ...next, limits: await api.setAssistantThreadLimitDefaults({ ...await api.assistantThreadLimitDefaults(), ...changed }) };
        }
        settled.add("limits");
      }
      if (delegationDirty && next.defaults && decisionDefault !== undefined) {
        // A saved Delegate All is the snapshot the owner granted: changing only its expiry or scope
        // never adds a category supported since. Choosing Delegate All anew takes today's set. A
        // saved category that is unavailable here stays as it was, as the delegation editor keeps it.
        const grant: AssistantDecisionDefault | null = draft.mode === "ask" ? null : {
          categories: draft.mode === "all"
            ? base.mode === "all" ? base.categories : delegable
            : draft.categories.filter((category) => delegable.includes(category) || base.categories.includes(category)),
          selectionMode: draft.mode, projects: draft.projects, campaigns: draft.campaigns,
          expiresAfterMs: ASSISTANT_DECISION_DEFAULT_DURATIONS[draft.expiry],
        };
        const result = await api.setAssistantThreadDecisionDefault(grant);
        next = { ...next, defaults: { ...next.defaults, decisionDefault: result.grant } };
        settled.add("delegation");
      }
    } catch (cause) {
      if (alive.current) setSaveError(cause instanceof Error ? cause.message : "Assistant defaults could not be saved.");
    } finally {
      if (alive.current) {
        // Whatever did save is the new baseline; a part that did not stays in the draft to try again.
        setSaved(next);
        const fresh = draftFrom(next);
        setDraft((current) => current && {
          ...current,
          ...(settled.has("launch") ? { harness: fresh.harness, account: fresh.account, model: fresh.model, effort: fresh.effort } : {}),
          ...(settled.has("limits") ? { budget: fresh.budget, launches: fresh.launches } : {}),
          ...(settled.has("delegation") ? { mode: fresh.mode, expiry: fresh.expiry, categories: fresh.categories,
            projects: fresh.projects, campaigns: fresh.campaigns } : {}),
        });
        setBusy(false);
      }
    }
  };

  const harnessOptions = (defaults?.harnesses ?? []).map((candidate) => ({
    value: candidate.id,
    label: assistantThreadHarnessLabel(candidate.id, defaults!.harnesses),
    ...(candidate.available ? {} : { description: candidate.reason ?? "Not available on your machines." }),
  }));
  const modeDescription = MODE_OPTIONS.find((candidate) => candidate.value === draft.mode)?.description;

  return <>
    {defaults && <SettingsGroup title="Thread Defaults" scope="Your Account"
      intro="New threads start with these. You can change any of them in New Thread.">
      <SelectRow title="Harness" description="The agent that runs each thread." options={harnessOptions} value={draft.harness}
        disabled={busy} onChange={(value) => {
          const harness = value as AssistantThreadHarness;
          if (harness === draft.harness) return;
          // Accounts and models belong to a harness, so another harness starts from its own defaults.
          change({ harness, account: MACHINE_ACCOUNT_POLICY, model: null, effort: null });
        }} />
      {modelsSaved && <>
        <SelectRow title="Model" description="Automatic uses the harness's own default model."
          options={assistantModelChoices(option, draft.model)} value={toChoice(draft.model)}
          disabled={busy || Boolean(modelReason) && draft.model === null} disabledReason={modelReason}
          error={modelProblem?.field === "model" ? modelProblem.message : null}
          onChange={(value) => {
            const model = fromChoice(value);
            change({ model, effort: effortAfterModelChange(option, model, draft.effort) });
          }} />
        <SelectRow title="Effort" description="Automatic uses the model's own default effort."
          options={assistantEffortChoices(option, draft.model, draft.effort)} value={toChoice(draft.effort)}
          disabled={busy || Boolean(modelReason) && draft.effort === null} disabledReason={modelReason}
          error={modelProblem?.field === "effort" ? modelProblem.message : null}
          onChange={(value) => change({ effort: fromChoice(value) })} />
      </>}
      {launchDefaults && <SelectRow title="Account"
        // A Machine that cannot choose an account says so, and Machine Policy stays choosable: the way
        // back from a saved account that is gone.
        description={choices?.unavailable ?? accountOptions.find((candidate) => candidate.value === draft.account)?.description
          ?? "The provider account new threads sign in with."}
        options={accountOptions} value={draft.account} disabled={busy}
        error={savedAccountGone ? "The saved account is unavailable. Choose another account, or Machine Policy." : null}
        onChange={(account) => change({ account })} />}
    </SettingsGroup>}

    {limits && <SettingsGroup title="Limits" scope="Your Account"
      intro="Each new thread gets these. Change one thread's limits in its Thread Settings.">
      <NumberRow title="Budget per Thread" unit="USD" textEntry step={0.01} value={draft.budget} placeholder="No Limit"
        description="Covers the thread and everything it launches. Empty means no limit." disabled={busy}
        error={budget.ok ? null : budget.error} onChange={(value) => change({ budget: value })} />
      <NumberRow title="Session Launches per Thread" textEntry step={1} value={draft.launches} placeholder="No Limit"
        description="0 pauses new launches. Empty means no limit." disabled={busy}
        error={launches.ok ? null : launches.error} onChange={(value) => change({ launches: value })} />
    </SettingsGroup>}

    {decisionDefault !== undefined && <SettingsGroup title="Decision Delegation" scope="Your Account"
      intro="What a new thread may decide without asking you. Each thread can change its own in Thread Settings.">
      <SelectRow title="New Threads" description={modeDescription} options={MODE_OPTIONS} value={draft.mode} disabled={busy}
        onChange={(value) => {
          const mode = value as DelegationMode;
          change({ mode, ...(mode === "choose" && draft.mode !== "choose" && !draft.categories.length ? { categories: delegable } : {}) });
        }} />
      {draft.mode !== "ask" && <>
        <SelectRow title="Expires" description="Counted from when each thread starts." disabled={busy}
          options={DEFAULT_DELEGATION_EXPIRY_OPTIONS.map(({ value, label }) => ({ value, label }))} value={draft.expiry}
          onChange={(value) => change({ expiry: value as DefaultExpiry })} />
        <ActionRow title="Projects and Campaigns" actionLabel="Edit…" hasPopup="dialog"
          description={delegationDirty ? "Save or discard your changes to edit where delegation applies." : scopeSentence(draft.projects, draft.campaigns)}
          disabled={busy || delegationDirty} onAction={() => setEditingScope(true)} />
      </>}
      {draft.mode === "choose" && <>
        <h4 className="assistant-gates-label">Who Decides in Each Category</h4>
        {ORDERED_CATEGORIES.map((category) => <SegmentedRow key={category} title={ASSISTANT_DECISION_CATEGORIES[category]}
          value={draft.categories.includes(category) ? "assistant" : "owner"} disabled={busy}
          disabledReason={unavailable[category]}
          options={[
            { value: "owner", label: "You" },
            { value: "assistant", label: "Assistant", disabled: Boolean(unavailable[category]), disabledReason: unavailable[category] },
          ]}
          onChange={(value) => change({ categories: value === "assistant"
            ? [...new Set([...draft.categories, category])] : draft.categories.filter((candidate) => candidate !== category) })} />)}
      </>}
      {editingScope && decisionDefault && <AssistantDecisionDelegationDialog defaultGrant={decisionDefault}
        onClose={() => setEditingScope(false)} onSaveDefault={async (grant) => {
          const result = await api.setAssistantThreadDecisionDefault(grant);
          const next = { ...saved, defaults: saved.defaults && { ...saved.defaults, decisionDefault: result.grant } };
          setSaved(next);
          setDraft((current) => current && { ...current, ...(({ mode, expiry, categories, projects, campaigns }) =>
            ({ mode, expiry, categories, projects, campaigns }))(draftFrom(next)) });
        }} />}
    </SettingsGroup>}

    <SaveBar dirty={dirty} busy={busy} error={saveError} blockedReason={blockedReason} saveLabel="Save Defaults"
      onDiscard={() => { setDraft(draftFrom(saved)); setSaveError(null); }} onSave={() => void save()} />
  </>;
}
