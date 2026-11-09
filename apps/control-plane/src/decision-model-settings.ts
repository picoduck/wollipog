import type {
  AgentDefinition,
  AgentModel,
  ConfigureDecisionModelRequest,
  DecisionErrorClass,
  DecisionModelMachine,
  DecisionModelResolvedTarget,
  DecisionModelSettingsView,
  DecisionModelTarget,
} from "@wollipog/protocol";
import {
  claudeModelDependsOnPlanMode,
  DECISION_MODEL_AUTOMATIC_EFFORTS,
  DECISION_MODEL_AUTOMATIC_PREFERENCE,
  decisionAgentFailureClass,
  runnerSupportsProtocol,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { contextLabel, namingHarnesses, sameContext } from "./session-naming-settings.js";

/** A selectable choice is no longer available. Its messages are safe for clients. */
export class DecisionModelUnavailableError extends Error {
  override readonly name = "DecisionModelUnavailableError";
}

export class DecisionModelInputError extends Error {
  override readonly name = "DecisionModelInputError";
}

/** The campaign runner's own harness, which Automatic uses. */
export interface DecisionAutomaticHarness {
  runnerId: string;
  agentId: string;
  driver: string;
}

export type DecisionTargetResolution =
  | { ok: true; target: DecisionModelResolvedTarget }
  | { ok: false; errorClass: DecisionErrorClass; target?: DecisionModelResolvedTarget };

type Runner = NonNullable<ReturnType<ControlPlaneDb["getRunner"]>>;

function machineName(runner: Runner | undefined, runnerId: string): string {
  return runner?.displayName ?? runner?.hostname ?? runnerId;
}

function advertisedModels(agent: AgentDefinition): AgentModel[] {
  return (agent.capabilities?.models ?? []).filter((model) => !model.hidden && model.id !== "default" &&
    !claudeModelDependsOnPlanMode(agent.driver, model.id));
}

function modelEfforts(agent: AgentDefinition, model: AgentModel): string[] {
  return model.efforts?.length ? model.efforts : agent.capabilities?.effortLevels ?? [];
}

/** Automatic: the first model family in the fixed preference order that the harness advertises,
 * with the first preferred effort it supports. Null when it advertises none of them. */
export function automaticDecisionModel(agent: AgentDefinition): { model: AgentModel; effort: string } | null {
  const models = advertisedModels(agent).filter((model) => modelEfforts(agent, model).length > 0);
  for (const family of DECISION_MODEL_AUTOMATIC_PREFERENCE) {
    const model = models.find((candidate) =>
      candidate.id.toLowerCase().includes(family) || (candidate.displayName ?? "").toLowerCase().includes(family));
    if (!model) continue;
    const efforts = modelEfforts(agent, model);
    const effort = DECISION_MODEL_AUTOMATIC_EFFORTS.find((candidate) => efforts.includes(candidate)) ?? efforts[0]!;
    return { model, effort };
  }
  return null;
}

/** The organization's Decision Model setting, modelled on the session-naming harness target. */
export class DecisionModelSettings {
  constructor(private readonly db: ControlPlaneDb) {}

  private runnerInOrganization(runnerId: string, organizationId: string): Runner | undefined {
    const runner = this.db.getRunner(runnerId);
    return runner && this.db.runnerScope(runner.runnerId)?.organizationId === organizationId ? runner : undefined;
  }

  private capableRunner(runner: Runner | undefined): runner is Runner {
    return Boolean(runner && runner.status === "online" && runnerSupportsProtocol(runner.protocolVersion, "decisionModel"));
  }

  /** Current Machines and harnesses that can run tool-less Decision calls. */
  machines(organizationId: string): DecisionModelMachine[] {
    return this.db.listRunners().flatMap((runner) => {
      if (!this.capableRunner(runner) || this.db.runnerScope(runner.runnerId)?.organizationId !== organizationId) return [];
      const harnesses = namingHarnesses(runner.agents).filter((harness) => {
        const agent = runner.agents.find((candidate) => candidate.id === harness.agentId &&
          (candidate.driver ?? "acp") === harness.driver);
        return decisionAgentFailureClass(agent) === null;
      });
      return harnesses.length ? [{ runnerId: runner.runnerId, machineName: machineName(runner, runner.runnerId), harnesses }] : [];
    }).sort((left, right) => left.machineName.localeCompare(right.machineName));
  }

  private explicitTarget(organizationId: string): { view: DecisionModelTarget; errorClass?: DecisionErrorClass } | null {
    const saved = this.db.getDecisionModelTarget(organizationId);
    if (!saved) return null;
    const runner = this.runnerInOrganization(saved.runnerId, organizationId);
    const agent = runner?.agents.find((candidate) => candidate.id === saved.agentId &&
      (candidate.driver ?? "acp") === saved.driver);
    const harness = runner
      ? namingHarnesses(runner.agents).find((candidate) => candidate.agentId === saved.agentId && candidate.driver === saved.driver)
      : undefined;
    const model = agent ? advertisedModels(agent).find((candidate) => candidate.id === saved.model) : undefined;
    const agentFailure = decisionAgentFailureClass(agent);
    const failure: [DecisionErrorClass, string] | null = !runner
      ? ["runner_incapable", "The selected Machine is no longer available."]
      : runner.status !== "online"
        ? ["runner_incapable", "The selected Machine is offline."]
        : !runnerSupportsProtocol(runner.protocolVersion, "decisionModel")
          ? ["runner_incapable", "Update the selected Machine runner to run Decision calls."]
          : !agent
            ? ["harness_unavailable", "The selected Agent Harness is no longer advertised."]
            : agentFailure === "authentication"
              ? ["authentication", "The selected Agent Harness is no longer authenticated."]
              : agentFailure
                ? ["harness_unavailable", "The selected Agent Harness cannot run tool-less Decision calls."]
                : !harness || harness.provider !== saved.provider || harness.billingSource !== saved.billingSource
                  ? ["configuration", "The selected Agent Harness changed its provider or billing source. Review and save it to confirm the change."]
                  : !sameContext(saved.context, harness.context ?? { kind: "native" })
                    ? ["configuration", "The selected Agent Harness execution context changed. Review and save it to confirm the change."]
                    : !model
                      ? ["model_unavailable", "The selected model is no longer advertised."]
                      : !modelEfforts(agent, model).includes(saved.effort)
                        ? ["model_unavailable", "The selected reasoning effort is no longer supported by that model."]
                        : null;
    const canonical = saved.driver === "codex-app-server" ? "Codex App Server" : "Claude Code";
    return {
      view: {
        runnerId: saved.runnerId,
        machineName: machineName(runner, saved.runnerId),
        agentId: saved.agentId,
        harnessName: harness?.name ?? `${canonical} (${contextLabel(saved.context)}) · ${saved.agentId}`,
        driver: saved.driver,
        context: saved.context,
        provider: saved.provider,
        billingSource: saved.billingSource,
        model: saved.model,
        modelName: model?.displayName ?? saved.model,
        effort: saved.effort,
        available: failure === null,
        ...(failure ? { reason: failure[1] } : {}),
      },
      ...(failure ? { errorClass: failure[0] } : {}),
    };
  }

  view(organizationId: string, canManage: boolean): DecisionModelSettingsView {
    const explicit = this.explicitTarget(organizationId);
    return {
      source: explicit ? "organization" : "automatic",
      canManage,
      ...(explicit ? { target: explicit.view } : {}),
      machines: this.machines(organizationId),
      automaticPreference: [...DECISION_MODEL_AUTOMATIC_PREFERENCE],
    };
  }

  configure(organizationId: string, input: ConfigureDecisionModelRequest, now = Date.now()): DecisionModelSettingsView {
    if (!input || typeof input !== "object" || typeof input.runnerId !== "string" || typeof input.agentId !== "string" ||
        (input.driver !== "codex-app-server" && input.driver !== "claude-code") ||
        typeof input.model !== "string" || typeof input.effort !== "string" ||
        [input.runnerId, input.agentId, input.model, input.effort].some((value) => !value || value.length > 256)) {
      throw new DecisionModelInputError("a complete valid Decision Model target is required");
    }
    const machine = this.machines(organizationId).find((candidate) => candidate.runnerId === input.runnerId);
    const harness = machine?.harnesses.find((candidate) => candidate.agentId === input.agentId && candidate.driver === input.driver);
    const model = harness?.models.find((candidate) => candidate.id === input.model);
    if (!harness || !model || !model.efforts.includes(input.effort)) {
      throw new DecisionModelUnavailableError(
        "the selected Machine, Agent Harness, model, or reasoning effort cannot run Decision calls",
      );
    }
    const previous = this.db.getDecisionModelTarget(organizationId)?.updatedAt ?? 0;
    this.db.setDecisionModelTarget(organizationId, {
      runnerId: input.runnerId,
      agentId: input.agentId,
      driver: input.driver,
      context: harness.context ?? { kind: "native" },
      provider: harness.provider,
      billingSource: harness.billingSource,
      model: input.model,
      effort: input.effort,
    }, Math.max(now, previous + 1));
    return this.view(organizationId, true);
  }

  useAutomatic(organizationId: string): DecisionModelSettingsView {
    this.db.clearDecisionModelTarget(organizationId);
    return this.view(organizationId, true);
  }

  private automaticFor(runner: Runner, agent: AgentDefinition): DecisionTargetResolution {
    const failure = decisionAgentFailureClass(agent);
    if (failure) return { ok: false, errorClass: failure };
    const harness = namingHarnesses(runner.agents).find((candidate) =>
      candidate.agentId === agent.id && candidate.driver === (agent.driver ?? "acp"));
    const choice = automaticDecisionModel(agent);
    if (!harness) return { ok: false, errorClass: "harness_unavailable" };
    if (!choice) return { ok: false, errorClass: "model_unavailable" };
    return {
      ok: true,
      target: {
        source: "automatic",
        runnerId: runner.runnerId,
        machineName: machineName(runner, runner.runnerId),
        agentId: agent.id,
        harnessName: harness.name,
        driver: harness.driver,
        provider: harness.provider,
        model: choice.model.id,
        modelName: choice.model.displayName ?? choice.model.id,
        effort: choice.effort,
      },
    };
  }

  /** The target one Decision call runs on. An explicit setting always wins; it is never silently
   * replaced by Automatic when unavailable. Automatic uses only the campaign runner's own harness.
   * Without one (Test Decision Model) it uses the first capable harness that has an Automatic model. */
  resolve(organizationId: string, automaticHarness: DecisionAutomaticHarness | null): DecisionTargetResolution {
    const explicit = this.explicitTarget(organizationId);
    if (explicit) {
      const target: DecisionModelResolvedTarget = {
        source: "organization",
        runnerId: explicit.view.runnerId,
        machineName: explicit.view.machineName,
        agentId: explicit.view.agentId,
        harnessName: explicit.view.harnessName,
        driver: explicit.view.driver,
        provider: explicit.view.provider ?? (explicit.view.driver === "claude-code" ? "claude" : "codex"),
        model: explicit.view.model,
        modelName: explicit.view.modelName,
        effort: explicit.view.effort,
      };
      return explicit.errorClass ? { ok: false, errorClass: explicit.errorClass, target } : { ok: true, target };
    }
    if (automaticHarness) {
      const runner = this.runnerInOrganization(automaticHarness.runnerId, organizationId);
      if (!this.capableRunner(runner)) return { ok: false, errorClass: "runner_incapable" };
      const agent = runner.agents.find((candidate) => candidate.id === automaticHarness.agentId &&
        (candidate.driver ?? "acp") === automaticHarness.driver);
      if (!agent) return { ok: false, errorClass: "harness_unavailable" };
      return this.automaticFor(runner, agent);
    }
    for (const machine of this.machines(organizationId)) {
      const runner = this.db.getRunner(machine.runnerId)!;
      for (const harness of machine.harnesses) {
        const agent = runner.agents.find((candidate) => candidate.id === harness.agentId &&
          (candidate.driver ?? "acp") === harness.driver);
        if (!agent) continue;
        const resolved = this.automaticFor(runner, agent);
        if (resolved.ok) return resolved;
      }
    }
    return { ok: false, errorClass: "runner_incapable" };
  }
}
