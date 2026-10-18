import type { ChildSessionDefaults, ProjectMemorySharing, ProjectView, UpdateProjectRequest } from "@wollipog/protocol";

/**
 * A project's settings as one draft, saved together by the detail's save bar (docs/design-system.md
 * §8.6, Editor): its name and its two child-session limits (#2962), and its Memory Sharing choice
 * (#2963). The switches beside them apply at once and are not part of it.
 *
 * The typed fields validate; Memory Sharing is a choice of two and cannot be invalid.
 */
export type ProjectSettingsField = "name" | "cost" | "tools";

/** The typed fields in the order they read, which is the order Save moves focus to the first invalid one. */
export const PROJECT_SETTINGS_FIELDS: readonly ProjectSettingsField[] = ["name", "cost", "tools"];

/**
 * What each field shows. The limits are text, so a field can be emptied while typing. Memory Sharing
 * is absent where the server has no memory policy (an older server), which leaves it out of the save.
 */
export type ProjectSettingsValues = Record<ProjectSettingsField, string> & { memorySharing?: ProjectMemorySharing };

/** Every part of the draft, in the order the detail shows them. */
const PROJECT_SETTINGS_KEYS = ["name", "memorySharing", "cost", "tools"] as const satisfies readonly (keyof ProjectSettingsValues)[];

/**
 * Only the fields the person has edited. A field that is not here follows the saved project, so a
 * change made elsewhere reaches every field nobody is typing in.
 */
export type ProjectSettingsDraft = Partial<ProjectSettingsValues>;

/** As long as a name New Project accepts. The server only requires one. */
export const PROJECT_NAME_MAX_LENGTH = 120;

export function savedProjectSettings(project: ProjectView): ProjectSettingsValues {
  const defaults = project.childSessionDefaults ?? null;
  return {
    name: project.name,
    cost: defaults ? String(defaults.costBudgetUsd) : "",
    tools: defaults ? String(defaults.maxToolCalls) : "",
    ...(project.memorySharing !== undefined ? { memorySharing: project.memorySharing } : {}),
  };
}

export function projectSettingsValues(project: ProjectView, draft: ProjectSettingsDraft): ProjectSettingsValues {
  return { ...savedProjectSettings(project), ...draft };
}

/**
 * Whether any field shows something other than what is saved. A Memory Sharing choice left in the
 * draft after the server stopped reporting the policy is not: it has nothing to be saved to.
 */
export function projectSettingsDirty(project: ProjectView, draft: ProjectSettingsDraft): boolean {
  const saved = savedProjectSettings(project);
  return PROJECT_SETTINGS_KEYS.some((key) => draft[key] !== undefined && draft[key] !== saved[key] &&
    (key !== "memorySharing" || project.memorySharing !== undefined));
}

function parseCost(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseTools(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * Each invalid field's one sentence (§8.5). The two limits are saved together, because the server
 * requires both: both empty is no limits, and one set beside an empty one is an error on the empty one.
 */
export function projectSettingsErrors(values: ProjectSettingsValues): Partial<Record<ProjectSettingsField, string>> {
  const errors: Partial<Record<ProjectSettingsField, string>> = {};
  const name = values.name.trim();
  if (!name) errors.name = "Enter a name for the project.";
  else if (name.length > PROJECT_NAME_MAX_LENGTH) errors.name = `Use ${PROJECT_NAME_MAX_LENGTH} characters or fewer.`;
  const cost = values.cost.trim();
  const tools = values.tools.trim();
  if (cost && parseCost(cost) === null) errors.cost = "Enter an amount above 0.";
  else if (!cost && tools) errors.cost = "Enter a cost limit too, or clear both for no limits.";
  if (tools && parseTools(tools) === null) errors.tools = "Enter a whole number above 0.";
  else if (!tools && cost) errors.tools = "Enter a tool-call limit too, or clear both for no limits.";
  return errors;
}

/** The limits the fields describe: null for none. Only meaningful for values without errors. */
export function childSessionDefaultsFrom(values: ProjectSettingsValues): ChildSessionDefaults | null {
  const costBudgetUsd = parseCost(values.cost);
  const maxToolCalls = parseTools(values.tools);
  return costBudgetUsd !== null && maxToolCalls !== null ? { costBudgetUsd, maxToolCalls } : null;
}

/**
 * The one update request for valid `values`, carrying only what differs from the saved project: a name
 * that differs once trimmed, the limits when either changed (null clears them), and the Memory Sharing
 * choice when it changed. Empty when nothing would change, such as a name that differs only by a
 * trailing space.
 */
export function projectSettingsChanges(project: ProjectView, values: ProjectSettingsValues): UpdateProjectRequest {
  const changes: UpdateProjectRequest = {};
  const name = values.name.trim();
  if (name !== project.name) changes.name = name;
  // An older server sends no limits at all, and its update parser predates them.
  if (project.childSessionDefaults !== undefined) {
    const saved = project.childSessionDefaults;
    const next = childSessionDefaultsFrom(values);
    if (saved?.costBudgetUsd !== next?.costBudgetUsd || saved?.maxToolCalls !== next?.maxToolCalls) {
      changes.childSessionDefaults = next;
    }
  }
  // Likewise a server with no memory policy, which reports none.
  if (project.memorySharing !== undefined && values.memorySharing !== undefined &&
      values.memorySharing !== project.memorySharing) {
    changes.memorySharing = values.memorySharing;
  }
  return changes;
}

/**
 * `values` with Memory Sharing at the saved choice: what a Save queued behind another request sends
 * when the choice changed after it was pressed. Sharing is only ever sent by a Save pressed while its
 * consent notice showed (#2963), so a later choice waits in the draft for a Save of its own.
 */
export function withSavedMemorySharing(project: ProjectView, values: ProjectSettingsValues): ProjectSettingsValues {
  const next: ProjectSettingsValues = { name: values.name, cost: values.cost, tools: values.tools };
  if (project.memorySharing !== undefined) next.memorySharing = project.memorySharing;
  return next;
}

/**
 * The draft after `sent` was saved: a field still showing what was sent is now saved, so it leaves
 * the draft; one typed into while the request ran keeps what was typed.
 */
export function draftAfterSave(draft: ProjectSettingsDraft, sent: ProjectSettingsValues): ProjectSettingsDraft {
  const next: ProjectSettingsDraft = {};
  for (const field of PROJECT_SETTINGS_FIELDS) {
    const value = draft[field];
    if (value !== undefined && value !== sent[field]) next[field] = value;
  }
  if (draft.memorySharing !== undefined && draft.memorySharing !== sent.memorySharing) next.memorySharing = draft.memorySharing;
  return next;
}

/**
 * The fields whose errors still show after a save settled into `draftAfter`: only those still in the
 * draft, typed into while the request ran. A field the save took out of the draft shows the saved
 * value again, and has nothing left to say.
 */
export function revealedAfterSave(
  revealed: ReadonlySet<ProjectSettingsField>,
  draftAfter: ProjectSettingsDraft,
): ReadonlySet<ProjectSettingsField> {
  return new Set([...revealed].filter((field) => draftAfter[field] !== undefined));
}
