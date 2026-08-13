/**
 * Curated capability tables per driver. Used to advertise model/effort/permission
 * options before runtime discovery. Claude's optional flags are intentionally empty here:
 * discovery projects only what the resolved installation verifies through its own help output.
 */

import type { AgentCapabilities, AgentDriverKind } from "@wollipog/protocol";
import { claudeModels } from "./discovery/models.js";

export const CAPABILITY_CATALOG: Partial<Record<AgentDriverKind, AgentCapabilities>> = {
  "claude-code": {
    // Single source of truth with discovery enrichment — a second hardcoded list here is how
    // the Fable alias went missing from the picker while the CLI had long offered it.
    models: claudeModels(),
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: false,
    supportsConversationFork: false,
    permissionModes: [],
  },
  codex: {
    models: [
      { id: "default", displayName: "Default", default: true },
      { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max" },
    ],
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: false,
    supportsConversationFork: false,
    // codex exec gates via the sandbox policy (no interactive approval).
    permissionModes: ["read-only", "workspace-write", "danger-full-access"],
    elicitation: {
      "read-only": ["none"],
      "workspace-write": ["none"],
      "danger-full-access": ["none"],
    },
  },
  "codex-app-server": {
    models: [
      { id: "default", displayName: "Default", default: true },
      { id: "gpt-5-codex", displayName: "GPT-5 Codex" },
      { id: "gpt-5.1-codex-max", displayName: "GPT-5.1 Codex Max" },
    ],
    effortLevels: ["minimal", "low", "medium", "high", "xhigh"],
    slashCommands: [],
    supportsImages: true,
    supportsApprovals: true,
    supportsConversationFork: true,
    // These mirror Codex CLI/Desktop: read-only and standard workspace access can escalate
    // boundary crossings, auto-review sends those escalations to Guardian, and full access
    // removes the sandbox. An unset mode defaults to auto-review.
    permissionModes: ["read-only", "on-request", "auto-review", "danger-full-access"],
    elicitation: {
      "read-only": ["app-server"],
      "on-request": ["app-server"],
      "auto-review": ["app-server"],
      "danger-full-access": ["none"],
    },
  },
};

export function capabilitiesFor(driver: AgentDriverKind): AgentCapabilities | undefined {
  return CAPABILITY_CATALOG[driver];
}
