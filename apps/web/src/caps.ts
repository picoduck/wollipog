import {
  mergeSessionCapabilities,
  type AgentCapabilities,
  type AgentDriverKind,
  type RunnerView,
  type SessionCapabilities,
  type SessionCapabilityOverlay,
  type SessionView,
} from "@wollipog/protocol";

function hasKnobs(c?: AgentCapabilities): boolean {
  return !!(c && ((c.models?.length ?? 0) || (c.permissionModes?.length ?? 0) ||
    (c.effortLevels?.length ?? 0) || (c.slashCommands?.length ?? 0)));
}

function nativeSessionOverlay(capabilities: SessionCapabilities | undefined): SessionCapabilityOverlay | undefined {
  if (!capabilities) return undefined;
  const overlay = {
    ...(Object.hasOwn(capabilities, "elicitation") ? { elicitation: capabilities.elicitation } : {}),
    ...(Object.hasOwn(capabilities, "slashCommands") ? { slashCommands: capabilities.slashCommands } : {}),
  };
  return Object.keys(overlay).length ? overlay as SessionCapabilityOverlay : undefined;
}

export type ElicitationAvailability = "available" | "unavailable" | "unknown";

/** Per-mode approval delivery is tri-state. A legacy/partial capability must never be
 * collapsed into an unsupported claim merely because it did not report the new field. */
export function elicitationAvailability(
  capabilities: AgentCapabilities | undefined,
  permissionMode: string | undefined,
): ElicitationAvailability {
  if (!permissionMode || !capabilities?.elicitation ||
      !Object.prototype.hasOwnProperty.call(capabilities.elicitation, permissionMode)) {
    return "unknown";
  }
  const transports = capabilities.elicitation[permissionMode];
  return transports?.some((transport) => transport !== "none") ? "available" : "unavailable";
}

/** Resolve the real mode used when the composer sends an empty permissionMode patch. ACP
 * provider defaults are dynamic, so they deliberately remain unknown.
 * KEEP IN SYNC with the runner fallbacks in drivers/claude-code.ts, drivers/codex.ts, and
 * drivers/codex-app-server.ts; these packages cannot share runner implementation constants. */
export function defaultPermissionMode(driver: AgentDriverKind): string | undefined {
  if (driver === "claude-code") return "acceptEdits";
  if (driver === "codex") return "workspace-write";
  if (driver === "codex-app-server") return "auto-review";
  return undefined;
}

const EFFORT_FALLBACK_ORDER = ["high", "medium", "low", "xhigh", "max", "minimal"] as const;

export function effectiveModelEffortForDisplay(
  capabilities: AgentCapabilities | undefined,
  driver: AgentDriverKind,
  modelId?: string | null,
  effortId?: string | null,
) {
  const models = capabilities?.models ?? [];
  const concrete = models.filter((model) => model.id !== "default");
  const visible = concrete.filter((model) => !model.hidden);
  const effortsFor = (model: AgentCapabilities["models"][number] | undefined) =>
    model ? ((model.efforts?.length ? model.efforts : capabilities?.effortLevels) ?? []) : [];
  const explicit = modelId && modelId !== "default" ? concrete.find((model) => model.id === modelId) : undefined;
  const advertised = visible.find((model) => model.default);
  const preferredPattern = driver === "claude-code" ? /(?:^|[-_])opus(?:$|[-_\[])/i : /gpt[-_.]?5\.6[-_.]?sol/i;
  const preferred = visible.find((model) => preferredPattern.test(model.id))
    ?? visible.find((model) => preferredPattern.test(model.displayName ?? ""));
  const compatible = [...visible].filter((model) => effortsFor(model).length)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const model = explicit ?? advertised ?? preferred ?? compatible[0];
  const efforts = effortsFor(model);
  const effort = effortId && efforts.includes(effortId) ? effortId
    : model?.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort
      : EFFORT_FALLBACK_ORDER.find((candidate) => efforts.includes(candidate))
        ?? [...efforts].sort()[0];
  return { model, efforts, effort };
}

/** Last-resort controls for adopted Claude sessions with no capability-bearing runner agent.
 * Version-neutral aliases remain usable; the authenticated runner catalog wins whenever present. */
const CLAUDE_DEFAULT_CAPS: AgentCapabilities = {
  models: [
    { id: "default", displayName: "Default", default: true },
    { id: "opus", displayName: "Opus" },
    { id: "fable", displayName: "Fable" },
    { id: "sonnet", displayName: "Sonnet" },
    { id: "haiku", displayName: "Haiku" },
  ],
  // `claude --effort <level>` — verified levels; unknown values are ignored by the CLI (safe).
  // KEEP IN SYNC with the runner catalog (apps/runner/src/catalog.ts claude-code effortLevels).
  effortLevels: ["low", "medium", "high", "xhigh", "max"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
  permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
};

/**
 * Capabilities to drive a session's model / effort / approval controls. Adopted or ACP sessions
 * frequently don't resolve to a capability-bearing agent (their `agentId` matches nothing, or an
 * ACP agent with no advertised caps), which is why their controls looked empty. Fall back to another
 * agent on the same runner sharing this session's driver, then to built-in claude defaults.
 */
export function resolveCaps(runner: RunnerView | undefined, session: SessionView): AgentCapabilities | undefined {
  const agents = runner?.agents ?? [];
  const sessionCapabilities = session.driver === "acp"
    ? session.agentCapabilities
    : nativeSessionOverlay(session.agentCapabilities);
  const exact = agents.find((a) => a.id === session.agentId)?.capabilities;
  if (hasKnobs(exact)) return mergeSessionCapabilities(exact, sessionCapabilities);
  const alt = agents.find((a) => (a.driver ?? "acp") === session.driver && hasKnobs(a.capabilities))?.capabilities;
  if (alt) return mergeSessionCapabilities(alt, sessionCapabilities);
  if (session.driver === "claude-code") {
    const selectedFallback = session.model && !CLAUDE_DEFAULT_CAPS.models.some((model) => model.id === session.model)
      ? [{
          id: session.model,
          displayName: session.model,
          contextWindow: /\[1m\]$/i.test(session.model) ? 1_000_000 : undefined,
          hidden: true,
        }]
      : [];
    return mergeSessionCapabilities({
      ...CLAUDE_DEFAULT_CAPS,
      models: [...selectedFallback, ...CLAUDE_DEFAULT_CAPS.models],
    }, sessionCapabilities);
  }
  return mergeSessionCapabilities(exact, sessionCapabilities);
}

/** Per-model modality wins; older runners without it fall back to the driver-level capability. */
export function modelSupportsImages(caps: AgentCapabilities | undefined, modelId?: string | null): boolean {
  // Older/ACP runners may omit capabilities entirely; preserve the existing permissive composer
  // until a model explicitly advertises a modality set.
  if (!caps) return true;
  const model = caps.models.find((candidate) => candidate.id === modelId)
    ?? caps.models.find((candidate) => candidate.default && !candidate.hidden)
    ?? caps.models.find((candidate) => !candidate.hidden);
  return model?.inputModalities ? model.inputModalities.includes("image") : caps.supportsImages;
}
