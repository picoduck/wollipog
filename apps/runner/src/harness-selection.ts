import {
  agentContextKey,
  type AgentContext,
  type AgentDefinition,
  type AgentDriverKind,
  type HarnessInstallationChoice,
} from "@wollipog/protocol";

export function harnessFamily(driver: AgentDriverKind | undefined): HarnessInstallationChoice["family"] | null {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  if (driver === "pi") return "pi";
  return null;
}

export function harnessChoiceFor(
  choices: readonly HarnessInstallationChoice[],
  family: HarnessInstallationChoice["family"],
  context: AgentContext | undefined,
): HarnessInstallationChoice | undefined {
  const key = agentContextKey(context);
  return choices.find((choice) => choice.family === family && agentContextKey(choice.context) === key);
}

/** A saved choice always selects an exact discovered identity; absence never authorizes a fallback. */
export function selectedHarnessAgent(
  agents: readonly AgentDefinition[],
  driver: AgentDriverKind,
  context: AgentContext,
  choices: readonly HarnessInstallationChoice[],
): AgentDefinition | undefined {
  const family = harnessFamily(driver);
  const choice = family && harnessChoiceFor(choices, family, context);
  const key = agentContextKey(context);
  return agents.find((agent) =>
    (agent.driver ?? "acp") === driver &&
    agentContextKey(agent.context) === key &&
    (!choice || agent.installation?.id === choice.installationId));
}
