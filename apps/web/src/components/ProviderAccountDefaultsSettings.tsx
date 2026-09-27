import React, { useEffect, useState } from "react";
import { runnerSupportsProtocol, type RunnerProviderAccountDefault, type RunnerView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { isPersonalIdentifier, maskedAccountTitles } from "../personal-identifiers.js";
import { PersonalIdentifierRevealButton, usePersonalIdentifierReveal } from "./PersonalIdentifier.js";
import { Select } from "./ui/ChoiceControls.js";

const PROVIDERS = ["claude", "codex"] as const;

export function ProviderAccountDefaultsSettings({ runner }: { runner: RunnerView }) {
  const api = useApi();
  const [choices, setChoices] = useState(runner.providerAccountDefaults ?? []);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = runner.providerAccounts ?? [];
  const [revealed, toggleReveal] = usePersonalIdentifierReveal(
    `${runner.runnerId}\0${accounts.map((account) => `${account.id}:${account.label}`).join("\0")}`,
  );
  const titles = maskedAccountTitles(accounts.map((account) => account.label));
  useEffect(() => { setChoices(runner.providerAccountDefaults ?? []); }, [runner.providerAccountDefaults]);

  if (!runnerSupportsProtocol(runner.protocolVersion, "providerAccounts") ||
      (!accounts.length && !choices.length)) return null;

  const save = async (provider: RunnerProviderAccountDefault["provider"], accountId: string) => {
    if (saving || runner.canManage !== true) return;
    const current = choices.find((choice) => choice.provider === provider);
    setSaving(provider);
    setError(null);
    try {
      const result = await api.updateMachineProviderAccountDefault(runner.runnerId, provider, {
        accountId: accountId || null,
        expectedRevision: current?.revision ?? 0,
      });
      setChoices((previous) => [...previous.filter((choice) => choice.provider !== provider), result.providerAccountDefault]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="machine-settings-section">
      <h3>Default Provider Accounts</h3>
      <p>Choose the account used for new native host sessions when no account is specified. Existing sessions keep their accounts.</p>
      {accounts.some((account) => isPersonalIdentifier(account.label)) && (
        <PersonalIdentifierRevealButton
          label="Account Emails"
          revealed={revealed}
          onToggle={toggleReveal}
          withText
        />
      )}
      {PROVIDERS.filter((provider) => accounts.some((account) => account.provider === provider) ||
        choices.some((choice) => choice.provider === provider)).map((provider) => {
        const choice = choices.find((candidate) => candidate.provider === provider);
        const candidates = accounts.filter((account) => account.provider === provider);
        const missing = !!choice?.accountId && !candidates.some((account) => account.id === choice.accountId);
        const agents = runner.agents.filter((agent) => (agent.context?.kind ?? "native") === "native" &&
          (provider === "claude" ? agent.driver === "claude-code" :
            agent.driver === "codex" || agent.driver === "codex-app-server"));
        const fallbackIds = new Set(agents.map((agent) => agent.defaultProviderAccountId ?? candidates[0]?.id));
        const varied = !choice?.accountId && fallbackIds.size > 1;
        const effectiveId = choice?.accountId ?? (varied ? undefined : agents[0]?.defaultProviderAccountId ?? candidates[0]?.id);
        const effectiveAccount = candidates.find((account) => account.id === effectiveId);
        const effectiveTitle = effectiveAccount
          ? revealed ? effectiveAccount.label : titles[accounts.indexOf(effectiveAccount)]!
          : "Unavailable Account";
        const label = `Default ${provider === "claude" ? "Claude" : "Codex"} Account`;
        return (
          <div className="field" key={provider}>
            <label className="new-session-field-label">{label}</label>
            <Select<string>
              label={label}
              value={choice?.accountId ?? ""}
              disabled={runner.canManage !== true || saving !== null}
              onChange={(accountId) => void save(provider, accountId)}
              options={[
                { value: "", label: "Use Existing Behavior", description: "Use the agent's configured default or the first available account." },
                ...(missing ? [{ value: choice.accountId!, label: "Unavailable Account", description: "Choose a replacement before creating another session." }] : []),
                ...candidates.map((account) => ({
                  value: account.id,
                  label: revealed ? account.label : titles[accounts.indexOf(account)]!,
                  description: account.authStatus === "authenticated" ? "Logged In" :
                    account.authStatus === "unauthenticated" ? "Login Required" : "Login Unknown",
                })),
              ]}
            />
            <p className="hint">{varied ? "The current default varies by agent configuration." :
              effectiveId ? `Current default: ${effectiveTitle}.` : "No account is currently available."}</p>
            {missing && <p className="hint" role="alert">The saved account is no longer on this Machine. Choose another account or use existing behavior.</p>}
          </div>
        );
      })}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
