import React from "react";
import type { ConfigureSessionNamingHarnessRequest, SessionNamingSettingsView } from "@wollipog/protocol";
import { HarnessTargetDialog } from "./HarnessTargetDialog.js";

/**
 * Session titles from an agent (#3025): the shared Machine, Agent, Model and Reasoning Effort dialog
 * (`HarnessTargetDialog`) with the title wording.
 *
 * `null` saves the migrated "each session uses its own agent" preference, offered when no machine
 * advertises an agent to choose but the server still reports that mode usable.
 */
export function TitleAgentDialog({
  settings,
  onSave,
  onClose,
  returnFocusRef,
}: {
  settings: SessionNamingSettingsView;
  onSave: (target: ConfigureSessionNamingHarnessRequest | null) => Promise<void>;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const machines = settings.harnessMachines ?? [];
  return (
    <HarnessTargetDialog
      title="Agent for Titles"
      description="An agent on one of your machines writes each new session's title."
      machineHelper="Session text goes to this machine's agent to write the title."
      progress="Saving the title source…"
      failureSentence="Couldn't save the title source."
      machines={machines}
      {...(settings.harnessTarget ? { selection: settings.harnessTarget } : {})}
      followsSession={machines.length === 0 && settings.modes.session_agent_account.available}
      followsSessionText="Each session uses its own agent."
      onSave={onSave}
      onClose={onClose}
      {...(returnFocusRef ? { returnFocusRef } : {})}
    />
  );
}
