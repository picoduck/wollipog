import React, { useState, type ReactNode } from "react";
import type { AgentCapabilities, AgentDriverKind, SessionConfig, SessionView } from "@wollipog/protocol";
import {
  permissionModeDescription,
  permissionModeEmptyLabel,
  permissionModeForDisplay,
  permissionModeLabel,
} from "../format.js";
import {
  defaultPermissionMode,
  elicitationAvailability,
  resolveCaps,
  type ElicitationAvailability,
} from "../caps.js";
import { useStoreSelector } from "../store.js";
import { useAccessibleMenu } from "./interactions.js";
import { ShieldIcon } from "./Icons.js";

type Apply = (patch: Partial<SessionConfig>) => void;

/** Prettify a raw effort token for display (xhigh → "Extra High"), Codex-style. */
function prettyEffort(e: string): string {
  const map: Record<string, string> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High" };
  return map[e] ?? e.charAt(0).toUpperCase() + e.slice(1);
}

/** Caps-derived session config (model / effort / approvals) for the composer-bar controls. Model/effort
 * appear only when the agent advertises them; approvals excludes `plan` (that lives in the + menu). */
function useSessionConfig(session: SessionView) {
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const caps = resolveCaps(runner, session);
  const models = (caps?.models ?? []).filter((model) => !model.hidden || model.id === session.model);
  const permModes = (caps?.permissionModes ?? []).filter((p) => p !== "plan");

  const modelVal = models.some((m) => m.id === session.model)
    ? session.model!
    : models.find((m) => m.default)?.id ?? models[0]?.id ?? "";
  const selectedModel = models.find((m) => m.id === modelVal);
  const modelEfforts = (selectedModel?.efforts?.length ? selectedModel.efforts : caps?.effortLevels) ?? [];
  const effortVal = session.effort && modelEfforts.includes(session.effort) ? session.effort : "";
  const permVal = permissionModeForDisplay(session.permissionMode, permModes, session.driver);
  return {
    caps,
    models,
    modelSource: caps?.modelSource,
    permModes,
    modelVal,
    selectedModel,
    modelEfforts,
    effortVal,
    permVal,
  };
}

/** Shared popover shell for the composer-bar dropdowns (bottom-anchored, click-away backdrop). */
function BarMenu({ align = "left", label, title, permissionMode = false, children }: {
  align?: "left" | "right";
  label: ReactNode;
  title?: string;
  permissionMode?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "composer-control-menu");
  return (
    <div className={`cbar-menu ${align}`}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="cbar-trigger"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <>
          <div className="plus-backdrop" onClick={() => menu.close(true)} />
          <div className={`cbar-pop${permissionMode ? " permission-mode-pop" : ""}`} role="menu" id={menu.menuId} ref={menu.menuRef} onKeyDown={menu.onMenuKeyDown}>
            {children(() => menu.close(true))}
          </div>
        </>
      )}
    </div>
  );
}

interface MenuModelChoice {
  id: string;
  displayName?: string;
  description?: string;
  defaultEffort?: string;
}

/** Pure leaf so the two independent menu-radio groups retain an executable semantic contract. */
export function ModelEffortMenuChoices({
  models,
  modelSource,
  modelVal,
  selectedModel,
  modelEfforts,
  effortVal,
  apply,
}: {
  models: MenuModelChoice[];
  modelSource?: string;
  modelVal: string;
  selectedModel?: MenuModelChoice;
  modelEfforts: string[];
  effortVal: string;
  apply: Apply;
}) {
  return (
    <>
      {models.length > 0 && (
        <div role="group" aria-label="Model">
          <div className="plus-section" role="presentation">Model{modelSource === "cached" ? " (cached)" : ""}</div>
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="menuitemradio"
              aria-checked={model.id === modelVal}
              className={`cbar-opt${model.id === modelVal ? " on" : ""}`}
              title={model.description}
              onClick={() => apply({ model: model.id, effort: "" })}
            >
              {model.displayName ?? model.id}
            </button>
          ))}
        </div>
      )}
      {modelEfforts.length > 0 && (
        <div role="group" aria-label="Reasoning Effort">
          <div className="plus-section" role="presentation">Effort</div>
          <button type="button" role="menuitemradio" aria-checked={!effortVal} className={`cbar-opt${!effortVal ? " on" : ""}`} onClick={() => apply({ effort: "" })}>
            {selectedModel?.defaultEffort ? `Default (${selectedModel.defaultEffort})` : "Default"}
          </button>
          {modelEfforts.map((effort) => (
            <button key={effort} type="button" role="menuitemradio" aria-checked={effort === effortVal} className={`cbar-opt${effort === effortVal ? " on" : ""}`} onClick={() => apply({ effort })}>
              {prettyEffort(effort)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** "gpt-5.5 · high" — model + per-model effort in one Codex-style popover. */
export function modelEffortControlLabel(selectedModel: MenuModelChoice | undefined, modelVal: string): string {
  return selectedModel?.displayName || modelVal || "Model";
}

export function ModelEffortControl({ session, apply }: { session: SessionView; apply: Apply }) {
  const { models, modelSource, modelVal, selectedModel, modelEfforts, effortVal } = useSessionConfig(session);
  if (models.length === 0 && modelEfforts.length === 0) return null;
  const label = (
    <>
      <span className="cbar-model">{modelEffortControlLabel(selectedModel, modelVal)}</span>
      {effortVal && <span className="cbar-effort">{prettyEffort(effortVal)}</span>}
    </>
  );
  return (
    <BarMenu
      align="right"
      label={label}
      title={modelSource === "cached" ? "Model metadata is cached; Rediscover to refresh" : "Model & reasoning effort (applies next turn)"}
    >
      {() => <ModelEffortMenuChoices
        models={models}
        modelSource={modelSource}
        modelVal={modelVal}
        selectedModel={selectedModel}
        modelEfforts={modelEfforts}
        effortVal={effortVal}
        apply={apply}
      />}
    </BarMenu>
  );
}

/** "Approve for me" — approval-mode picker in the composer bar. */
export function permissionModeOutcome(
  permissionMode: string | undefined,
  status: ElicitationAvailability,
): { label: string; description: string; warning: boolean } {
  if (status === "available") {
    return { label: "Approvals Available", description: "Approval requests raised through this mode reach you in Wollipog.", warning: false };
  }
  if (permissionMode === "bypassPermissions" || permissionMode === "danger-full-access" || permissionMode === "plan") {
    return { label: "No Approvals Needed", description: "This policy does not use approval prompts.", warning: false };
  }
  if (status === "unknown") {
    return { label: "Approval Support Unknown", description: "Wollipog has not verified approval delivery for this mode.", warning: true };
  }
  return { label: "Blocked Instead of Asking", description: "Wollipog will not prompt in this mode.", warning: false };
}

export function defaultPermissionModeDisplayLabel(driver: AgentDriverKind): string {
  const resolved = defaultPermissionMode(driver);
  return driver === "claude-code" && resolved
    ? `Default (${permissionModeLabel(resolved, driver)})`
    : "Default";
}

function approvalOptionTitle(
  description: string | undefined,
  outcome: ReturnType<typeof permissionModeOutcome>,
): string | undefined {
  return [description, outcome.description].filter(Boolean).join(" ") || undefined;
}

export function permissionModeOptionDescription(
  permissionMode: string | undefined,
  driver: AgentDriverKind,
  status: ElicitationAvailability,
  outcome: ReturnType<typeof permissionModeOutcome>,
): string | undefined {
  if (status === "available") {
    if (permissionMode === "acceptEdits") {
      return "File edits and common file commands run without asking. Matching governance policies can ask you before other actions; otherwise those actions are blocked.";
    }
    if (permissionMode === "dontAsk") {
      return "Matching governance policies can ask you before an action; otherwise actions requiring approval are blocked.";
    }
    if (permissionMode === "bypassPermissions" || permissionMode === "danger-full-access") {
      return "Matching governance policies can ask you before a tool runs; otherwise everything runs with no checks. Use only in isolated environments.";
    }
    if (permissionMode === "plan") {
      return "The agent remains read-only. Matching governance policies can still ask you before a tool runs.";
    }
  }
  return approvalOptionTitle(permissionModeDescription(permissionMode ?? "", driver), outcome);
}

export function approvalControlLabel(
  driver: AgentDriverKind,
  permissionMode: string,
  _status: ElicitationAvailability,
): string {
  if (permissionMode) return permissionModeLabel(permissionMode, driver);
  if (driver === "claude-code") return defaultPermissionModeDisplayLabel(driver);
  return permissionModeEmptyLabel(driver);
}

function PermissionModeOutcome({ outcome }: { outcome: ReturnType<typeof permissionModeOutcome> }) {
  return <span className={`cbar-elicitation-state${outcome.warning ? " unknown" : ""}`}>{outcome.label}</span>;
}

export function ApprovalsMenuChoices({
  capabilities,
  driver,
  permModes,
  permVal,
  apply,
  close,
}: {
  capabilities: AgentCapabilities | undefined;
  driver: AgentDriverKind;
  permModes: string[];
  permVal: string;
  apply: Apply;
  close: () => void;
}) {
  const defaultStatus = elicitationAvailability(capabilities, defaultPermissionMode(driver));
  const defaultMode = defaultPermissionMode(driver);
  const defaultOutcome = permissionModeOutcome(defaultMode, defaultStatus);
  const defaultDescription = permissionModeOptionDescription(defaultMode, driver, defaultStatus, defaultOutcome);
  const unlistedMode = permVal && !permModes.includes(permVal) ? permVal : undefined;
  const displayedModes = unlistedMode ? [unlistedMode, ...permModes] : permModes;

  return (
    <>
      <div className="plus-section" role="presentation">Permission Mode</div>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!permVal}
        className={`cbar-opt permission-mode${!permVal ? " on" : ""}`}
        onClick={() => {
          apply({ permissionMode: "" });
          close();
        }}
      >
        <span className="cbar-permission-copy">
          <span>{defaultPermissionModeDisplayLabel(driver)}</span>
          <span className="cbar-permission-description">{defaultDescription}</span>
        </span>
        <PermissionModeOutcome outcome={defaultOutcome} />
      </button>
      {displayedModes.map((p) => {
        const status = elicitationAvailability(capabilities, p);
        const outcome = permissionModeOutcome(p, status);
        const description = permissionModeOptionDescription(p, driver, status, outcome);
        const isUnlisted = p === unlistedMode;
        return (
          <button
            key={p}
            type="button"
            role="menuitemradio"
            aria-checked={p === permVal}
            className={`cbar-opt permission-mode${p === permVal ? " on" : ""}`}
            onClick={() => {
              if (!isUnlisted) apply({ permissionMode: p });
              close();
            }}
          >
            <span className="cbar-permission-copy">
              <span>{permissionModeLabel(p, driver)}</span>
              <span className="cbar-permission-description">{description}</span>
            </span>
            <PermissionModeOutcome outcome={outcome} />
          </button>
        );
      })}
    </>
  );
}

export function ApprovalsControl({ session, apply }: { session: SessionView; apply: Apply }) {
  const { caps, permModes, permVal } = useSessionConfig(session);
  if (permModes.length === 0) return null;
  const currentStatus = elicitationAvailability(caps, permVal || defaultPermissionMode(session.driver));
  const currentOutcome = permissionModeOutcome(permVal || defaultPermissionMode(session.driver), currentStatus);
  return (
    <BarMenu
      permissionMode
      label={
        <span className="cbar-approvals">
          <ShieldIcon size={14} />
          {approvalControlLabel(session.driver, permVal, currentStatus)}
        </span>
      }
      title={approvalOptionTitle("Permission mode (applies next turn).", currentOutcome)}
    >
      {(close) => (
        <ApprovalsMenuChoices
          capabilities={caps}
          driver={session.driver}
          permModes={permModes}
          permVal={permVal}
          apply={apply}
          close={close}
        />
      )}
    </BarMenu>
  );
}
