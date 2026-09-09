import React, { useRef, useState, type ReactNode } from "react";
import type {
  AgentCapabilities,
  AgentDriverKind,
  ElicitationTransport,
  SessionConfig,
  SessionView,
} from "@wollipog/protocol";
import {
  permissionModeDescription,
  permissionModeEmptyLabel,
  permissionModeForDisplay,
  permissionModeLabel,
  effortLabel,
} from "../format.js";
import {
  defaultPermissionMode,
  effectiveModelEffortForDisplay,
  elicitationAvailability,
  resolveCaps,
  resolveEffectiveCaps,
  type ElicitationAvailability,
} from "../caps.js";
import {
  collapseContextWindowVariants,
  contextWindowChoice,
  contextWindowOptionAcceptsEffort,
  type ContextWindowChoice,
} from "../context-window-options.js";
import { useStoreSelector } from "../store.js";
import { useAccessibleMenu } from "./interactions.js";
import { Modal } from "./common.js";
import { InfoIcon, ShieldIcon } from "./Icons.js";

type Apply = (patch: Partial<SessionConfig>) => void;

/** Caps-derived session config (model / effort / approvals) for the composer-bar controls. Model/effort
 * appear only when the agent advertises them; approvals excludes `plan` (that lives in the + menu). */
function useSessionConfig(session: SessionView) {
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const caps = resolveCaps(runner, session);
  const effectiveCaps = resolveEffectiveCaps(runner, session);
  const listedModels = (caps?.models ?? []).filter((model) => !model.hidden || model.id === session.model);
  // The orchestration tool boundary is established at process creation and cannot
  // safely be entered or escaped by changing a live provider permission mode.
  const permModes = session.permissionMode === "orchestrator" ? ["orchestrator"]
    : (caps?.permissionModes ?? []).filter((p) => p !== "plan" && p !== "orchestrator");

  const effective = effectiveModelEffortForDisplay(effectiveCaps, session.driver, session.model, session.effort, caps);
  const modelVal = effective.model?.id ?? "";
  const selectedModel = effective.model;
  const modelEfforts = effective.efforts;
  const effortVal = effective.effort ?? "";
  const permVal = permissionModeForDisplay(session.permissionMode, permModes, session.driver);
  // Context-window variants of one base (`opus` / `opus[1m]`) are one Model entry plus a Context
  // Window group; both come only from provider-stated windows, so most catalogs collapse nothing.
  const models = collapseContextWindowVariants(listedModels, modelVal || session.model);
  const contextChoice = contextWindowChoice(listedModels, modelVal || session.model);
  return {
    caps,
    models,
    contextChoice,
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
    <div className={`cbar-menu ${align}${permissionMode ? " permission-mode-menu" : ""}`}>
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

/** One menu-radio option shared by the Model, Context Window, and Effort groups. */
function MenuRadioOption({ checked, title, onSelect, children }: {
  checked: boolean;
  title?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`cbar-opt${checked ? " on" : ""}`}
      title={title}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

/** Pure leaf so the independent menu-radio groups retain an executable semantic contract. */
export function ModelEffortMenuChoices({
  models,
  modelSource,
  modelVal,
  selectedModel,
  contextChoice,
  modelEfforts,
  effortVal,
  apply,
}: {
  models: MenuModelChoice[];
  modelSource?: string;
  modelVal: string;
  selectedModel?: MenuModelChoice;
  /** Present only when the provider lists two windows for the selected model's base. */
  contextChoice?: ContextWindowChoice | null;
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
            <MenuRadioOption
              key={model.id}
              checked={model.id === modelVal}
              title={model.description}
              onSelect={() => apply({ model: model.id, effort: "" })}
            >
              {model.displayName ?? model.id}
            </MenuRadioOption>
          ))}
        </div>
      )}
      {contextChoice && (
        <div role="group" aria-label="Context Window">
          <div className="plus-section" role="presentation">Context Window</div>
          {contextChoice.options.map((option) => (
            <MenuRadioOption
              key={option.id}
              checked={option.id === contextChoice.selectedId}
              title={`${option.contextWindow.toLocaleString()} tokens; applies to the next turn`}
              // A window switch keeps the effort: variants of one base share their effort levels.
              // The effort has to ride along explicitly — the control plane reads a model-only
              // patch as "no effort chosen" and resolves back to the model's default effort. A
              // variant that does not advertise the current effort is the exception: sending it
              // would be rejected as unsupported, so let that one fall back to its own default.
              onSelect={() => apply(contextWindowOptionAcceptsEffort(option, effortVal)
                ? { model: option.id, effort: effortVal }
                : { model: option.id })}
            >
              {option.label}
            </MenuRadioOption>
          ))}
        </div>
      )}
      {modelEfforts.length > 0 && (
        <div role="group" aria-label="Reasoning Effort">
          <div className="plus-section" role="presentation">Effort</div>
          <MenuRadioOption checked={!effortVal} onSelect={() => apply({ effort: "" })}>
            {selectedModel?.defaultEffort ? `Default (${selectedModel.defaultEffort})` : "Default"}
          </MenuRadioOption>
          {modelEfforts.map((effort) => (
            <MenuRadioOption key={effort} checked={effort === effortVal} onSelect={() => apply({ effort })}>
              {effortLabel(effort)}
            </MenuRadioOption>
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
  const { models, contextChoice, modelSource, modelVal, selectedModel, modelEfforts, effortVal } = useSessionConfig(session);
  if (models.length === 0 && modelEfforts.length === 0) return null;
  const pickerModel = models.find((model) => model.id === modelVal) ?? selectedModel;
  const selectedWindow = contextChoice?.options.find((option) => option.id === contextChoice.selectedId);
  const label = (
    <>
      <span className="cbar-model">{modelEffortControlLabel(pickerModel, modelVal)}</span>
      {selectedWindow && <span className="cbar-context">{selectedWindow.label}</span>}
      {effortVal && <span className="cbar-effort">{effortLabel(effortVal)}</span>}
    </>
  );
  return (
    <BarMenu
      align="right"
      label={label}
      title={modelSource === "cached"
        ? "Model metadata is cached; Rediscover to refresh"
        : contextChoice
          ? "Model, context window & reasoning effort (applies next turn)"
          : "Model & reasoning effort (applies next turn)"}
    >
      {() => <ModelEffortMenuChoices
        models={models}
        modelSource={modelSource}
        modelVal={modelVal}
        selectedModel={selectedModel}
        contextChoice={contextChoice}
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
  // A question or MCP elicitation channel can stay live while these policies deliberately disable
  // command/file approval checks. Mode semantics win over transport availability: calling that
  // combination "Approvals Available" implies a safety boundary that does not exist.
  if (permissionMode === "bypassPermissions" || permissionMode === "danger-full-access") {
    return {
      label: "No Command Approvals",
      description: status === "available"
        ? "Questions or matching governance policies can still reach you, but actions otherwise run without sandbox or approval checks."
        : "Actions run without sandbox or approval checks.",
      warning: false,
    };
  }
  if (permissionMode === "plan") {
    return { label: "Read-Only", description: "The agent researches and plans without editing files.", warning: false };
  }
  if (status === "available") {
    return { label: "Approvals Available", description: "Approval requests raised through this mode reach you in Wollipog.", warning: false };
  }
  if (status === "unknown") {
    return { label: "Support Unknown", description: "Wollipog has not verified approval delivery for this mode.", warning: true };
  }
  return { label: "Blocks Requests", description: "Actions requiring approval are blocked instead of prompting you.", warning: false };
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
  transports?: readonly ElicitationTransport[],
): string | undefined {
  if (permissionMode === "bypassPermissions" || permissionMode === "danger-full-access") {
    const base = permissionModeDescription(permissionMode, driver);
    if (status === "available") {
      const questions = transports?.includes("app-server");
      const governance = transports?.includes("hook");
      const available = questions && governance
        ? "Questions, MCP elicitations, and matching governance policies can still reach you."
        : questions
          ? "Questions and MCP elicitations can still reach you."
          : governance
            ? "Matching governance policies can still ask you before a tool runs."
            : "Questions or matching governance policies can still reach you.";
      return `${available} Actions otherwise run without sandbox or approval checks. Use only in isolated environments.`;
    }
    if (status === "unknown") {
      return `${base ?? "Actions run without sandbox or approval checks."} Wollipog has not verified whether questions or governance prompts can reach you.`;
    }
    return base;
  }
  if (status === "available") {
    if (permissionMode === "acceptEdits") {
      return "File edits and common file commands run without asking. Matching governance policies can ask you before other actions; otherwise those actions are blocked.";
    }
    if (permissionMode === "dontAsk") {
      return "Matching governance policies can ask you before an action; otherwise actions requiring approval are blocked.";
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

export interface PermissionModeDetails {
  label: string;
  description: string;
  outcome: ReturnType<typeof permissionModeOutcome>;
}

export function PermissionModeDetailsDialog({ details, onClose, returnFocusRef }: {
  details: PermissionModeDetails;
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  return (
    <Modal title={`${details.label} Details`} onClose={onClose} returnFocusRef={returnFocusRef} className="permission-mode-details-dialog">
      <div className="permission-mode-details-copy">
        <PermissionModeOutcome outcome={details.outcome} />
        <p>{details.description}</p>
      </div>
    </Modal>
  );
}

function PermissionModeChoice({
  label,
  description,
  outcome,
  checked,
  onSelect,
  onDetails,
}: PermissionModeDetails & {
  checked: boolean;
  onSelect: () => void;
  onDetails: (details: PermissionModeDetails, trigger: HTMLButtonElement) => void;
}) {
  const details = { label, description, outcome };
  return (
    <div className="cbar-permission-row" role="none">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className={`cbar-opt permission-mode${checked ? " on" : ""}`}
        data-menu-label={label}
        onClick={onSelect}
      >
        <span className="cbar-permission-label">{label}</span>
        <PermissionModeOutcome outcome={outcome} />
      </button>
      <button
        type="button"
        role="menuitem"
        className="icon-btn cbar-permission-details-trigger"
        aria-label={`${label} Details`}
        data-menu-label={`${label} Details`}
        title={`${label} Details`}
        onClick={(event) => onDetails(details, event.currentTarget)}
      >
        <InfoIcon size={15} />
      </button>
    </div>
  );
}

export function ApprovalsMenuChoices({
  capabilities,
  driver,
  permModes,
  permVal,
  apply,
  close,
  onDetails,
}: {
  capabilities: AgentCapabilities | undefined;
  driver: AgentDriverKind;
  permModes: string[];
  permVal: string;
  apply: Apply;
  close: () => void;
  onDetails: (details: PermissionModeDetails, trigger: HTMLButtonElement) => void;
}) {
  const defaultStatus = elicitationAvailability(capabilities, defaultPermissionMode(driver));
  const defaultMode = defaultPermissionMode(driver);
  const defaultOutcome = permissionModeOutcome(defaultMode, defaultStatus);
  const defaultDescription = permissionModeOptionDescription(
    defaultMode,
    driver,
    defaultStatus,
    defaultOutcome,
    defaultMode ? capabilities?.elicitation?.[defaultMode] : undefined,
  ) ?? defaultOutcome.description;
  const unlistedMode = permVal && !permModes.includes(permVal) ? permVal : undefined;
  const displayedModes = unlistedMode ? [unlistedMode, ...permModes] : permModes;

  return (
    <>
      <div className="plus-section" role="presentation">Permission Mode</div>
      <PermissionModeChoice
        label={defaultPermissionModeDisplayLabel(driver)}
        description={defaultDescription}
        outcome={defaultOutcome}
        checked={!permVal}
        onSelect={() => {
          apply({ permissionMode: "" });
          close();
        }}
        onDetails={onDetails}
      />
      {displayedModes.map((p) => {
        const status = elicitationAvailability(capabilities, p);
        const outcome = permissionModeOutcome(p, status);
        const description = permissionModeOptionDescription(
          p,
          driver,
          status,
          outcome,
          capabilities?.elicitation?.[p],
        ) ?? outcome.description;
        const isUnlisted = p === unlistedMode;
        return (
          <PermissionModeChoice
            key={p}
            label={permissionModeLabel(p, driver)}
            description={description}
            outcome={outcome}
            checked={p === permVal}
            onSelect={() => {
              if (!isUnlisted) apply({ permissionMode: p });
              close();
            }}
            onDetails={onDetails}
          />
        );
      })}
    </>
  );
}

export function ApprovalsControl({ session, apply }: { session: SessionView; apply: Apply }) {
  const [details, setDetails] = useState<PermissionModeDetails | null>(null);
  const detailsReturnFocusRef = useRef<HTMLElement | null>(null);
  const { caps, permModes, permVal } = useSessionConfig(session);
  if (permModes.length === 0) return null;
  const currentStatus = elicitationAvailability(caps, permVal || defaultPermissionMode(session.driver));
  const currentOutcome = permissionModeOutcome(permVal || defaultPermissionMode(session.driver), currentStatus);
  return (
    <>
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
            onDetails={(nextDetails, trigger) => {
              detailsReturnFocusRef.current = trigger;
              setDetails(nextDetails);
            }}
          />
        )}
      </BarMenu>
      {details && (
        <PermissionModeDetailsDialog
          details={details}
          onClose={() => setDetails(null)}
          returnFocusRef={detailsReturnFocusRef}
        />
      )}
    </>
  );
}
