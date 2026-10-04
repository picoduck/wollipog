import { createContext, useContext } from "react";

/**
 * A breakdown Model Settings shows in place of its choices (#2447): the Session Usage group's
 * Context Window or Session Cost, opened from its row while the composer bar has no room for the
 * triggers whose popovers hold them.
 */
export type ModelSettingsDetail = "context-window" | "session-cost";

/** The title row's name for each breakdown: the row label it was opened from. */
export const MODEL_SETTINGS_DETAIL_TITLES: Record<ModelSettingsDetail, string> = {
  "context-window": "Context Window",
  "session-cost": "Session Cost",
};

export interface ModelSettingsDetailController {
  /** The breakdown shown, or null while Model Settings shows its choices. */
  detail: ModelSettingsDetail | null;
  open: (detail: ModelSettingsDetail) => void;
  /** Back to the choices, with focus on the row the breakdown was opened from. */
  back: () => void;
}

export const ModelSettingsDetailContext = createContext<ModelSettingsDetailController | null>(null);

/** Null outside Model Settings, where nothing can be opened in its place. */
export function useModelSettingsDetail(): ModelSettingsDetailController | null {
  return useContext(ModelSettingsDetailContext);
}
