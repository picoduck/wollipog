import type {
  AgentCapabilities,
  AgentDefinition,
  AgentHarnessDefaultConfig,
  AgentHarnessDefaultInstallation,
  AgentHarnessDefaultOption,
  AgentHarnessDefaultsView,
  AgentHarnessIdentity,
  AgentModel,
  UpdateAgentHarnessDefaultRequest,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

const DRIVERS = new Set(["acp", "codex", "codex-app-server", "claude-code"]);

function boundedIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\0-\x1f\x7f]/.test(value);
}

export function parseAgentHarnessIdentity(value: unknown): AgentHarnessIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Partial<AgentHarnessIdentity>;
  if (!boundedIdentifier(input.agentId) || typeof input.driver !== "string" || !DRIVERS.has(input.driver)) return null;
  if (!input.context || typeof input.context !== "object" || Array.isArray(input.context)) return null;
  if (input.context.kind === "native") return { agentId: input.agentId, driver: input.driver, context: { kind: "native" } };
  if (input.context.kind === "wsl" && boundedIdentifier(input.context.distro)) {
    return { agentId: input.agentId, driver: input.driver, context: { kind: "wsl", distro: input.context.distro } };
  }
  return null;
}

export function parseAgentHarnessDefaultConfig(value: unknown): AgentHarnessDefaultConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["model", "effort", "permissionMode"].includes(key))) return null;
  const config: AgentHarnessDefaultConfig = {};
  if (input.model !== undefined) {
    if (!boundedIdentifier(input.model)) return null;
    config.model = input.model;
  }
  if (input.effort !== undefined) {
    if (!boundedIdentifier(input.effort, 64)) return null;
    config.effort = input.effort;
  }
  if (input.permissionMode !== undefined) {
    if (!boundedIdentifier(input.permissionMode, 64)) return null;
    config.permissionMode = input.permissionMode;
  }
  return Object.keys(config).length > 0 ? config : null;
}

export function agentHarnessIdentityFor(agent: Pick<AgentDefinition, "id" | "driver" | "context">): AgentHarnessIdentity {
  return {
    agentId: agent.id,
    driver: agent.driver ?? "acp",
    context: agent.context?.kind === "wsl"
      ? { kind: "wsl", distro: agent.context.distro }
      : { kind: "native" },
  };
}

export function agentHarnessIdentityKey(identity: AgentHarnessIdentity): string {
  return JSON.stringify([
    identity.agentId,
    identity.driver,
    identity.context.kind,
    identity.context.kind === "wsl" ? identity.context.distro : "",
  ]);
}

function visibleModels(capabilities: AgentCapabilities | undefined): AgentModel[] {
  return (capabilities?.models ?? []).filter((model) => model.id !== "default" && !model.hidden);
}

export function installationSupportsDefault(
  installation: Pick<AgentHarnessDefaultInstallation, "models" | "effortLevels" | "permissionModes">,
  config: AgentHarnessDefaultConfig,
): boolean {
  const model = config.model ? installation.models.find((candidate) => candidate.id === config.model) : undefined;
  if (config.model && !model) return false;
  const efforts = model?.efforts?.length ? model.efforts : installation.effortLevels;
  if (config.effort && !efforts.includes(config.effort)) return false;
  if (config.permissionMode && !installation.permissionModes.includes(config.permissionMode)) return false;
  return Object.keys(config).length > 0;
}

export class AgentHarnessDefaultsSettings {
  constructor(private readonly db: ControlPlaneDb) {}

  view(principal: HumanPrincipal): AgentHarnessDefaultsView {
    const saved = new Map(this.db.listAgentHarnessDefaults(principal.userId)
      .map((preference) => [agentHarnessIdentityKey(preference), preference]));
    const options = new Map<string, AgentHarnessDefaultOption>();
    for (const runner of this.db.listRunnersForPrincipal(principal)) {
      for (const agent of runner.agents) {
        if (agent.id === "conductor" || agent.available === false) continue;
        const identity = agentHarnessIdentityFor(agent);
        const key = agentHarnessIdentityKey(identity);
        const installation: AgentHarnessDefaultInstallation = {
          runnerId: runner.runnerId,
          machineName: runner.displayName || runner.hostname || runner.runnerId,
          online: runner.status === "online",
          models: visibleModels(agent.capabilities),
          effortLevels: [...(agent.capabilities?.effortLevels ?? [])],
          permissionModes: [...(agent.capabilities?.permissionModes ?? [])],
        };
        const current = options.get(key);
        if (current) {
          current.installations.push(installation);
          if (agent.name.localeCompare(current.name) < 0) current.name = agent.name;
        } else {
          const preference = saved.get(key)?.config;
          options.set(key, {
            ...identity,
            name: agent.name,
            installations: [installation],
            ...(preference ? { preference } : {}),
            compatibleInstallations: 0,
          });
        }
        saved.delete(key);
      }
    }
    // Capability drift must not make a saved row disappear: users still need to see and reset it.
    for (const preference of saved.values()) {
      options.set(agentHarnessIdentityKey(preference), {
        agentId: preference.agentId,
        driver: preference.driver,
        context: preference.context,
        name: preference.agentId,
        installations: [],
        preference: preference.config,
        compatibleInstallations: 0,
      });
    }
    const defaults = [...options.values()];
    for (const option of defaults) {
      option.installations.sort((left, right) =>
        left.machineName.localeCompare(right.machineName) || left.runnerId.localeCompare(right.runnerId));
      option.compatibleInstallations = option.preference
        ? option.installations.filter((installation) => installationSupportsDefault(installation, option.preference!)).length
        : option.installations.length;
    }
    defaults.sort((left, right) =>
      left.name.localeCompare(right.name) || agentHarnessIdentityKey(left).localeCompare(agentHarnessIdentityKey(right)));
    return { defaults };
  }

  update(principal: HumanPrincipal, request: unknown, now = Date.now()): AgentHarnessDefaultsView {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new AgentHarnessDefaultInputError("an Agent Harness default is required");
    }
    const raw = request as Partial<UpdateAgentHarnessDefaultRequest>;
    const identity = parseAgentHarnessIdentity(raw);
    const config = parseAgentHarnessDefaultConfig(raw.config);
    if (!identity || !config) throw new AgentHarnessDefaultInputError("a complete valid Agent Harness default is required");
    const option = this.view(principal).defaults.find((candidate) =>
      agentHarnessIdentityKey(candidate) === agentHarnessIdentityKey(identity));
    if (!option?.installations.some((installation) => installationSupportsDefault(installation, config))) {
      throw new AgentHarnessDefaultUnavailableError(
        "That model, effort, and permission combination is not supported by a current Agent Harness installation.",
      );
    }
    this.db.setAgentHarnessDefault(principal.userId, identity, config, now);
    return this.view(principal);
  }

  delete(principal: HumanPrincipal, request: unknown): AgentHarnessDefaultsView {
    const identity = parseAgentHarnessIdentity(request);
    if (!identity) throw new AgentHarnessDefaultInputError("a valid Agent Harness identity is required");
    this.db.deleteAgentHarnessDefault(principal.userId, identity);
    return this.view(principal);
  }
}

export class AgentHarnessDefaultInputError extends Error {}
export class AgentHarnessDefaultUnavailableError extends Error {}
