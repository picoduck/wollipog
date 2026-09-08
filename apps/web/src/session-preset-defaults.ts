import { installationSupportsDefault, type AgentDefinition, type AgentHarnessDefaultsView } from "@wollipog/protocol";

/** Match the server's exact harness identity and whole-preference capability check. */
export function savedSessionPermissionMode(
  view: AgentHarnessDefaultsView | null,
  agent: AgentDefinition | undefined,
): string | undefined {
  if (!agent?.capabilities) return undefined;
  const context = agent.context ?? { kind: "native" };
  const preference = view?.defaults.find((option) =>
    option.agentId === agent.id && option.driver === (agent.driver ?? "acp") &&
    option.context.kind === context.kind &&
    (context.kind !== "wsl" || (option.context.kind === "wsl" && option.context.distro === context.distro))
  )?.preference;
  if (!preference || !installationSupportsDefault({
    models: agent.capabilities.models.filter((model) => model.id !== "default" && !model.hidden),
    effortLevels: agent.capabilities.effortLevels ?? [],
    permissionModes: agent.capabilities.permissionModes ?? [],
  }, preference)) return undefined;
  return preference.permissionMode;
}
