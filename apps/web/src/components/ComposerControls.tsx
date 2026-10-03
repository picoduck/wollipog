import React, {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  AgentCapabilities,
  AgentDriverKind,
  ElicitationTransport,
  SessionConfig,
  SessionView,
} from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
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
import { AgentIcon } from "./AgentIcon.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuLabel, MenuNote, MenuSurface } from "./Menu.js";
import {
  ChevronDownIcon,
  CloseIcon,
  ServiceTierIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "./Icons.js";

type Apply = (patch: Partial<SessionConfig>) => void;

/** The §3.1 variant a composer control wears; `plain` draws no button recipe at all (the phone
 * capsule's draft preview). */
export type ComposerButtonVariant = "ghost" | "primary" | "secondary" | "plain";

/**
 * Every composer bar control (docs/design-system.md §16.2, #2174). The composer holds focus while
 * the person types, so each control calls `preventDefault` on `pointerdown`: a tap that blurred the
 * textarea first would close the phone keyboard and bring the rail back, moving the control out
 * from under the finger before the click lands (#1797, #1903). The rule lives here so a new control
 * cannot forget it; callers have no `onPointerDown` of their own, and `onPress` runs after it.
 */
export function ComposerButton({
  variant = "ghost",
  square = false,
  className,
  onPress,
  ref,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onPointerDown"> & {
  variant?: ComposerButtonVariant;
  /** Icon only: as wide as it is tall. */
  square?: boolean;
  onPress?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={[
        variant === "plain" ? ""
          : variant === "primary" ? "btn primary composer-btn"
          : variant === "secondary" ? "btn composer-btn"
          : "btn ghost composer-btn",
        square ? "square" : "",
        className ?? "",
      ].filter(Boolean).join(" ") || undefined}
      data-composer-button=""
      onPointerDown={(event) => {
        event.preventDefault();
        onPress?.(event);
      }}
    />
  );
}

/** Caps-derived session config (model / effort / approvals) for the composer-bar controls. Model/effort
 * appear only when the agent advertises them; approvals excludes `plan` (that lives in the + menu). */
function useSessionConfig(session: SessionView) {
  const runner = useStoreSelector((s) => s.runners.get(session.runnerId));
  const caps = resolveCaps(runner, session);
  const effectiveCaps = resolveEffectiveCaps(runner, session);
  const listedModels = (caps?.models ?? []).filter((model) => !model.hidden || model.id === session.model);
  const { permModes, permVal, showDefaultPermissionMode } = sessionPermissionModeControls(session, caps);

  const effective = effectiveModelEffortForDisplay(effectiveCaps, session.driver, session.model, session.effort, caps);
  const modelVal = effective.model?.id ?? "";
  const selectedModel = effective.model;
  const modelEfforts = effective.efforts;
  const effortVal = effective.effort ?? "";
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
    showDefaultPermissionMode,
  };
}

/** Target-aware permission choices. Pi's approval bridge exists only for host sessions; a stored
 * safe mode remains visible after capability loss so Full Access can recover the session. */
export function sessionPermissionModeControls(
  session: Pick<SessionView, "driver" | "executionTarget" | "permissionMode">,
  capabilities: AgentCapabilities | undefined,
): { permModes: string[]; permVal: string; showDefaultPermissionMode: boolean } {
  // The orchestration tool boundary is established at process creation and cannot safely be
  // entered or escaped by changing a live provider permission mode.
  if (session.permissionMode === "orchestrator") {
    return { permModes: ["orchestrator"], permVal: "orchestrator", showDefaultPermissionMode: true };
  }
  const advertised = (capabilities?.permissionModes ?? [])
    .filter((mode) => mode !== "plan" && mode !== "orchestrator");
  const piWithoutHostBridge = session.driver === "pi" && session.executionTarget !== undefined &&
    session.executionTarget.adapter !== "host";
  let permModes = piWithoutHostBridge ? ["bypassPermissions"] : advertised;
  const configuredMode = session.permissionMode ?? "";
  const unavailablePiMode = session.driver === "pi" && !piWithoutHostBridge && !!configuredMode &&
    configuredMode !== "bypassPermissions" && !advertised.includes(configuredMode);
  if (unavailablePiMode && !permModes.includes("bypassPermissions")) {
    permModes = [...permModes, "bypassPermissions"];
  }
  const displayedMode = permissionModeForDisplay(configuredMode, permModes, session.driver);
  return {
    permModes,
    permVal: piWithoutHostBridge
      ? configuredMode || "bypassPermissions"
      : unavailablePiMode ? configuredMode : displayedMode,
    showDefaultPermissionMode: !piWithoutHostBridge,
  };
}

/** Shared popover shell for the composer-bar dropdowns (bottom-anchored, click-away backdrop). */
export function BarMenu({
  align = "left",
  label,
  title,
  ariaLabel,
  permissionMode = false,
  modelSettings = false,
  showCaret = true,
  menuTitle,
  menuLabel,
  disabledReason = null,
  children,
}: {
  align?: "left" | "right";
  label: ReactNode;
  title?: string;
  ariaLabel?: string;
  permissionMode?: boolean;
  modelSettings?: boolean;
  showCaret?: boolean;
  menuTitle?: string;
  /** The menu's accessible name and phone sheet title when it has no visible title. */
  menuLabel?: string;
  /** Why the signed-in person may not change this setting (#1857). The trigger is then disabled,
   * says why, and never opens its menu. */
  disabledReason?: string | null;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "composer-control-menu");
  const disabledReasonId = `${menu.menuId}-disabled-reason`;
  const disabled = disabledReason !== null;
  return (
    <div className={`cbar-menu ${align}${permissionMode ? " permission-mode-menu" : ""}${modelSettings ? " model-settings-menu" : ""}`}>
      <ComposerButton
        ref={menu.triggerRef}
        square={permissionMode}
        className={`cbar-trigger${modelSettings ? " model-chip" : ""}`}
        title={disabledReason ?? title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        aria-controls={menu.menuId}
        aria-describedby={disabled ? disabledReasonId : undefined}
        disabled={disabled}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        {label}
        {showCaret && <ChevronDownIcon size={14} className="cbar-caret" />}
      </ComposerButton>
      {disabled && <span className="sr-only" id={disabledReasonId}>{disabledReason}</span>}
      {open && !disabled && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={menuTitle ?? menuLabel ?? ariaLabel ?? "Options"}
          align={align === "right" ? "end" : "start"}
          // Composer menus stay inside the composer's column, which can be a narrow side panel.
          boundary=".composer-box"
          head={menuTitle ? (
            <div className="menu-head persistent" role="presentation">
              <span className="menu-head-title">{menuTitle}</span>
              {modelSettings && (
                <button
                  type="button"
                  role="menuitem"
                  className="icon-btn"
                  aria-label={`Close ${menuTitle}`}
                  data-menu-label={`Close ${menuTitle}`}
                  title={`Close ${menuTitle}`}
                  onClick={() => menu.close(true)}
                >
                  <CloseIcon size={16} />
                </button>
              )}
            </div>
          ) : undefined}
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {children(() => menu.close(true))}
        </MenuSurface>
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

/** One menu-radio option shared by the Model, Context Window, Effort and Service Tier groups. */
function MenuRadioOption({ checked, title, ariaLabel, description, icon, onSelect, children }: {
  checked: boolean;
  title?: string;
  ariaLabel?: string;
  description?: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <MenuItem
      role="menuitemradio"
      checked={checked}
      aria-label={ariaLabel}
      data-menu-label={ariaLabel}
      description={description}
      icon={icon}
      title={title}
      onClick={onSelect}
    >
      {children}
    </MenuItem>
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
  agentEffortLevels,
  effortVal,
  pendingEffort,
  serviceTierState,
  close,
  apply,
}: {
  models: MenuModelChoice[];
  modelSource?: string;
  modelVal: string;
  selectedModel?: MenuModelChoice;
  /** Present only when the provider lists two windows for the selected model's base. */
  contextChoice?: ContextWindowChoice | null;
  modelEfforts: string[];
  /** The agent's own effort levels, which a variant advertising none of its own inherits. */
  agentEffortLevels?: readonly string[];
  effortVal: string;
  /** Reads the effort staged for the next prompt, at click time. `effortVal` comes from the session
   * and only catches up after `setConfig` round-trips, so a selection made moments ago is not in it
   * yet; undefined means nothing is staged. */
  pendingEffort?: () => string | undefined;
  serviceTierState?: NonNullable<ReturnType<typeof serviceTierChoices>> | null;
  close?: () => void;
  apply: Apply;
}) {
  return (
    <>
      {models.length > 0 && (
        <div role="group" aria-label="Model">
          <MenuLabel>Model{modelSource === "cached" ? " (Cached)" : ""}</MenuLabel>
          {models.map((model) => (
            <MenuRadioOption
              key={model.id}
              checked={model.id === modelVal}
              title={model.description}
              ariaLabel={model.displayName ?? model.id}
              description={model.description}
              onSelect={() => apply({ model: model.id, effort: "", serviceTier: "" })}
            >
              {model.displayName ?? model.id}
            </MenuRadioOption>
          ))}
        </div>
      )}
      {contextChoice && (
        <div role="group" aria-label="Context Window">
          <MenuLabel>Context Window</MenuLabel>
          {contextChoice.options.map((option) => (
            <MenuRadioOption
              key={option.id}
              checked={option.id === contextChoice.selectedId}
              title={`${option.contextWindow.toLocaleString()} tokens; applies to the next turn`}
              // A window switch keeps the effort: variants of one base share their effort levels.
              // Always send the key. The control plane reads an omitted effort on a model patch as
              // "no effort chosen" and resolves back to the model's default, and an omitted key
              // also cannot clear an effort already staged in the composer's pending config, which
              // would then ride along with the next prompt. `""` is the established reset (the
              // Model group above uses it), so an effort the target variant would reject as
              // unsupported becomes that variant's own default instead of a 409.
              // Read the staged effort at click time: an effort chosen moments ago is not in
              // `effortVal` until `setConfig` round-trips, and it must not be reset by this switch.
              onSelect={() => {
                const staged = pendingEffort?.();
                const effort = staged ?? effortVal;
                apply({
                  model: option.id,
                  effort: contextWindowOptionAcceptsEffort(option, effort, agentEffortLevels) ? effort : "",
                  serviceTier: "",
                });
              }}
            >
              {option.label}
            </MenuRadioOption>
          ))}
        </div>
      )}
      {modelEfforts.length > 0 && (
        <div role="group" aria-label="Reasoning Effort">
          <MenuLabel>Reasoning Effort</MenuLabel>
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
      {serviceTierState && (
        <ServiceTierMenuChoices state={serviceTierState} apply={apply} close={close ?? (() => undefined)} />
      )}
    </>
  );
}

/** "gpt-5.5 · high" — model + per-model effort in one Codex-style popover. */
export function modelEffortControlLabel(selectedModel: MenuModelChoice | undefined, modelVal: string): string {
  return selectedModel?.displayName || modelVal || "Model";
}

/** Everything Model Settings offers for this session, and whether it has anything to offer. */
function useModelSettings(
  session: SessionView,
  pendingModel?: () => string | undefined,
  pendingServiceTier?: () => string | undefined,
) {
  const runner = useStoreSelector((state) => state.runners.get(session.runnerId));
  const capabilities = resolveEffectiveCaps(runner, session);
  const config = useSessionConfig(session);
  const serviceTierState = session.driver === "codex-app-server" && runnerSupportsProtocol(runner?.protocolVersion, "codexServiceTiers")
    ? serviceTierChoices(
        capabilities,
        pendingModel?.() ?? session.model,
        pendingServiceTier?.() ?? session.serviceTier,
      )
    : null;
  const available = config.models.length > 0 || config.modelEfforts.length > 0 || serviceTierState !== null;
  return { ...config, serviceTierState, available };
}

/** Whether the composer bar shows a Model Settings trigger for this session at all. */
export function useModelSettingsAvailable(
  session: SessionView,
  pendingModel?: () => string | undefined,
  pendingServiceTier?: () => string | undefined,
): boolean {
  return useModelSettings(session, pendingModel, pendingServiceTier).available;
}

export function ModelEffortControl(
  {
    session,
    apply,
    pendingModel,
    pendingEffort,
    pendingServiceTier,
    disabledReason = null,
    sessionUsage = null,
  }: {
    session: SessionView;
    apply: Apply;
    /** Why the signed-in person may not change the model or effort (#1857). */
    disabledReason?: string | null;
    pendingModel?: () => string | undefined;
    pendingEffort?: () => string | undefined;
    pendingServiceTier?: () => string | undefined;
    /** The read-only Session Usage group, while the composer bar has no room for its triggers (#2166). */
    sessionUsage?: ReactNode;
  },
) {
  const {
    caps, models, contextChoice, modelSource, modelVal, selectedModel, modelEfforts, effortVal, serviceTierState, available,
  } = useModelSettings(session, pendingModel, pendingServiceTier);
  if (!available) return null;
  const pickerModel = models.find((model) => model.id === modelVal) ?? selectedModel;
  const selectedWindow = contextChoice?.options.find((option) => option.id === contextChoice.selectedId);
  const modelLabel = modelEffortControlLabel(pickerModel, modelVal);
  const effortSuffix = effortVal ? effortLabel(effortVal) : "";
  const tooltip = `${modelLabel}${effortSuffix ? ` · ${effortSuffix}` : ""}. Opens Model Settings for model${contextChoice ? ", context window" : ""}, reasoning effort${serviceTierState ? ", and service tier" : ""}.`;
  // The model name is the chip's only truncating label. A phone hides the context size, and with
  // Plan on also the mark and the effort, so the accessible name is what keeps all of them (#2174).
  const label = (
    <span className="cbar-model-label">
      <AgentIcon driver={session.driver} agentName={session.agentName} size={14} />
      <span className="cbar-model">{modelLabel}</span>
      {selectedWindow && <span className="cbar-context">{selectedWindow.label}</span>}
      {effortSuffix && <span className="cbar-effort">{effortSuffix}</span>}
    </span>
  );
  const accessibleFacts = [modelLabel, selectedWindow?.label, effortSuffix].filter(Boolean).join(", ");
  return (
    <BarMenu
      align="left"
      modelSettings
      menuTitle="Model Settings"
      label={label}
      title={modelSource === "cached" ? `${tooltip} Model metadata is cached; Rediscover to refresh.` : tooltip}
      ariaLabel={`Model Settings: ${accessibleFacts}`}
      disabledReason={disabledReason}
    >
      {(close) => <>{sessionUsage}<ModelEffortMenuChoices
        models={models}
        modelSource={modelSource}
        modelVal={modelVal}
        selectedModel={selectedModel}
        contextChoice={contextChoice}
        modelEfforts={modelEfforts}
        agentEffortLevels={caps?.effortLevels}
        effortVal={effortVal}
        pendingEffort={pendingEffort}
        serviceTierState={serviceTierState}
        close={close}
        apply={apply}
      /></>}
    </BarMenu>
  );
}

interface ServiceTierChoice {
  id: string;
  name: string;
  description: string;
}

export function serviceTierChoices(
  capabilities: AgentCapabilities | undefined,
  modelId: string | null | undefined,
  selectedTier: string | null | undefined,
): { choices: ServiceTierChoice[]; selected: ServiceTierChoice } | null {
  const exactModel = modelId && modelId !== "default"
    ? capabilities?.models.find((candidate) => candidate.id === modelId)
    : undefined;
  const model = modelId && modelId !== "default"
    ? exactModel
    : capabilities?.models.find((candidate) => candidate.default && !candidate.hidden)
      ?? capabilities?.models.find((candidate) => !candidate.hidden);
  if (!model?.serviceTiers?.length) return null;
  const choices: ServiceTierChoice[] = [
    { id: "default", name: "Standard", description: "Standard response speed. Applies to the next turn." },
    ...model.serviceTiers
      .filter((tier) => tier.id !== "default")
      .map((tier) => ({
        id: tier.id,
        name: tier.name,
        description: `${tier.description ? `${tier.description} ` : ""}Applies to the next turn.`,
      })),
  ];
  const preferred = selectedTier || model.defaultServiceTier || "default";
  return { choices, selected: choices.find((choice) => choice.id === preferred) ?? choices[0]! };
}

export function ServiceTierMenuChoices({ state, apply, close }: {
  state: NonNullable<ReturnType<typeof serviceTierChoices>>;
  apply: Apply;
  close: () => void;
}) {
  return (
    <div role="group" aria-label="Service Tier">
      <MenuLabel>Service Tier</MenuLabel>
      {state.choices.map((choice) => (
        <MenuRadioOption
          key={choice.id}
          checked={choice.id === state.selected.id}
          title={choice.description}
          icon={choice.id.toLowerCase() === "fast" ? <ServiceTierIcon size={16} /> : null}
          description={choice.description}
          onSelect={() => {
            apply({ serviceTier: choice.id });
            close();
          }}
        >
          {choice.name}
        </MenuRadioOption>
      ))}
    </div>
  );
}

/** A mode that runs every action without command approvals: the shield's amber risk warning. */
function skipsApprovals(permissionMode: string | undefined): boolean {
  return permissionMode === "bypassPermissions" || permissionMode === "danger-full-access";
}

/**
 * Whether Wollipog has not confirmed that this mode's approval prompts reach the person. A mode that
 * skips approvals raises none and Plan stays read-only, so only a mode that asks or blocks can be
 * unverified. The menu names every such mode in one note instead of warning on each row.
 */
export function approvalDeliveryUnverified(
  permissionMode: string | undefined,
  status: ElicitationAvailability,
): boolean {
  return status === "unknown" && !skipsApprovals(permissionMode) &&
    permissionMode !== "plan" && permissionMode !== "orchestrator";
}

/** The menu's one note for the modes whose approval prompts may not reach the person. */
export function unverifiedDeliveryNote(labels: readonly string[]): string {
  const modes = new Intl.ListFormat("en-US", { type: "conjunction" }).format(labels);
  return `Wollipog hasn't confirmed that approval prompts from ${modes} reach you here.`;
}

export function defaultPermissionModeDisplayLabel(driver: AgentDriverKind): string {
  const resolved = defaultPermissionMode(driver);
  return driver === "claude-code" && resolved
    ? `Default (${permissionModeLabel(resolved, driver)})`
    : "Default";
}

/** Who can still reach the person in a mode that skips approvals, by delivery channel. */
function stillReachesYou(transports: readonly ElicitationTransport[] | undefined): string {
  const questions = transports?.includes("app-server");
  const governance = transports?.includes("hook");
  if (questions && governance) return "questions and matching governance policies can still reach you";
  if (questions) return "questions can still reach you";
  if (governance) return "matching governance policies can still ask you before a tool runs";
  return "questions or matching governance policies can still reach you";
}

/**
 * A permission mode's meaning, shown as its menu row's second line. It says what runs and, when
 * Wollipog knows, what happens to an action that needs approval. Unknown delivery is left to the
 * menu's note.
 */
export function permissionModeOptionDescription(
  permissionMode: string | undefined,
  driver: AgentDriverKind,
  status: ElicitationAvailability,
  transports?: readonly ElicitationTransport[],
): string | undefined {
  const base = permissionModeDescription(permissionMode ?? "", driver);
  if (skipsApprovals(permissionMode)) {
    if (status !== "available") return base;
    const runs = permissionMode === "danger-full-access"
      ? "Everything runs with no sandbox and no command approvals"
      : "Everything runs with no command approvals";
    return `${runs}, but ${stillReachesYou(transports)}. Use only in isolated environments.`;
  }
  if (status === "available") {
    if (permissionMode === "acceptEdits") {
      return "File edits and common file commands run without asking. Matching governance policies can ask you before other actions; otherwise those actions are blocked.";
    }
    if (permissionMode === "dontAsk") {
      return "Matching governance policies can ask you before an action; otherwise actions that need approval are blocked.";
    }
    if (permissionMode === "plan") {
      return "The agent stays read-only. Matching governance policies can still ask you before a tool runs.";
    }
    return base;
  }
  // Don't Ask and exec Codex's sandbox policies block by definition, and their meaning says so.
  if (status === "unavailable" && permissionMode !== "dontAsk" && driver !== "codex") {
    return [base, "Actions that need approval are blocked instead of asking you."].filter(Boolean).join(" ");
  }
  return base;
}

export function approvalControlLabel(
  driver: AgentDriverKind,
  permissionMode: string,
  _status: ElicitationAvailability,
): string {
  if (permissionMode) return permissionModeLabel(permissionMode, driver);
  if (driver === "pi") return permissionModeLabel("default", driver);
  if (driver === "claude-code") return defaultPermissionModeDisplayLabel(driver);
  return permissionModeEmptyLabel(driver);
}

interface PermissionModeRow {
  key: string;
  label: string;
  /** The mode the row runs: the driver's resolved default for the Default row. */
  mode: string | undefined;
  checked: boolean;
  select: () => void;
}

/**
 * The permission menu (docs/design-system.md §9.1). Each mode is one two-line `menuitemradio`: its
 * label, its meaning, and the check when selected. A mode that skips approvals carries the amber
 * shield in its icon slot, and every mode whose approval prompts are unverified is named in one note
 * at the bottom.
 */
export function ApprovalsMenuChoices({
  capabilities,
  driver,
  permModes,
  permVal,
  apply,
  close,
  showDefault = true,
}: {
  capabilities: AgentCapabilities | undefined;
  driver: AgentDriverKind;
  permModes: string[];
  permVal: string;
  apply: Apply;
  close: () => void;
  showDefault?: boolean;
}) {
  const noteId = `${useId().replace(/:/g, "")}-unverified`;
  const defaultMode = defaultPermissionMode(driver);
  // Pi's named `default` mode is also Wollipog's empty-selection fallback. Present that semantic
  // choice once; clearing the explicit value still launches the same ask-before-tool behavior.
  const collapsedDefault = driver === "pi" && showDefault ? defaultMode : undefined;
  const selectableModes = collapsedDefault
    ? permModes.filter((mode) => mode !== collapsedDefault)
    : permModes;
  const unlistedMode = permVal && permVal !== collapsedDefault && !selectableModes.includes(permVal)
    ? permVal
    : undefined;
  const displayedModes = unlistedMode ? [unlistedMode, ...selectableModes] : selectableModes;

  const rows: PermissionModeRow[] = [
    ...(showDefault ? [{
      key: "default-row",
      label: defaultPermissionModeDisplayLabel(driver),
      mode: defaultMode,
      checked: !permVal || permVal === collapsedDefault,
      select: () => apply({ permissionMode: "" }),
    }] : []),
    ...displayedModes.map((mode) => ({
      key: `mode-${mode}`,
      label: permissionModeLabel(mode, driver),
      mode,
      checked: mode === permVal,
      select: () => {
        if (mode !== unlistedMode) apply({ permissionMode: mode });
      },
    })),
  ];
  const described = rows.map((row) => {
    const status = elicitationAvailability(capabilities, row.mode);
    const description = permissionModeOptionDescription(
      row.mode,
      driver,
      status,
      row.mode ? capabilities?.elicitation?.[row.mode] : undefined,
    );
    return {
      ...row,
      // A default Wollipog cannot resolve (an ACP provider's), or a mode it has no words for, still
      // has a second line, so the row reads like the others and its label can wrap.
      description: description ?? (row.key === "default-row"
        ? "Uses the agent's own default mode."
        : "Wollipog doesn't know what this mode permits."),
      unverified: approvalDeliveryUnverified(row.mode, status),
    };
  });
  const unverified = described.filter((row) => row.unverified).map((row) => row.label);

  return (
    <>
      {/* The menu's name: shown on a desktop, where the menu has no title row. */}
      <MenuLabel className="repeats-title">Permission Mode</MenuLabel>
      {described.map((row) => (
        <MenuItem
          key={row.key}
          role="menuitemradio"
          checked={row.checked}
          data-menu-label={row.label}
          // A mode that skips approvals is a risk warning: amber on the icon only (§21 item 5).
          icon={skipsApprovals(row.mode)
            ? <span className="permission-mode-risk"><ShieldAlertIcon size={16} /></span>
            : undefined}
          description={row.description}
          aria-describedby={row.unverified ? noteId : undefined}
          onClick={() => {
            row.select();
            close();
          }}
        >
          {row.label}
        </MenuItem>
      ))}
      {unverified.length > 0 && <MenuNote id={noteId}>{unverifiedDeliveryNote(unverified)}</MenuNote>}
    </>
  );
}

export function ApprovalsControl({ session, apply, disabledReason = null }: {
  session: SessionView;
  apply: Apply;
  /** Why the signed-in person may not change approvals mode (#1857). */
  disabledReason?: string | null;
}) {
  const { caps, permModes, permVal, showDefaultPermissionMode } = useSessionConfig(session);
  if (permModes.length === 0) return null;
  const currentMode = permVal || defaultPermissionMode(session.driver);
  const currentStatus = elicitationAvailability(caps, currentMode);
  const currentLabel = approvalControlLabel(session.driver, permVal, currentStatus);
  const unrestricted = skipsApprovals(currentMode);
  const accessibleLabel = `Permission Mode: ${currentLabel}`;
  if (permModes.length === 1 && permModes[0] === "orchestrator") {
    // A mark, not a control: its name says why nobody changes it here.
    const fixed = `${accessibleLabel}. Fixed for Orchestrator sessions.`;
    return (
      <span className="cbar-permission-badge" role="img" aria-label={fixed} title={fixed}>
        <ShieldCheckIcon size={16} />
      </span>
    );
  }
  return (
    <BarMenu
      permissionMode
      menuLabel="Permission Mode"
      showCaret={false}
      label={
        // A mode that skips approvals is a risk warning, not a request: amber on the icon only,
        // never a pill (docs/design-system.md §21 item 5).
        <span className={`cbar-approvals${unrestricted ? " unrestricted" : ""}`}>
          {unrestricted ? <ShieldAlertIcon size={16} /> : <ShieldIcon size={16} />}
        </span>
      }
      ariaLabel={accessibleLabel}
      title={`${accessibleLabel}. Applies to the next turn.`}
      disabledReason={disabledReason}
    >
      {(close) => (
        <ApprovalsMenuChoices
          capabilities={caps}
          driver={session.driver}
          permModes={permModes}
          permVal={permVal}
          apply={apply}
          close={close}
          showDefault={showDefaultPermissionMode}
        />
      )}
    </BarMenu>
  );
}
