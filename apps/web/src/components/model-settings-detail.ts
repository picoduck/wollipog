import { createContext, useContext } from "react";

/**
 * A selector or usage breakdown Model Settings opens in place of its overview.
 */
export type ModelSettingsDetail = "context-window" | "session-cost" | "reasoning-effort" | "speed";

/** The title row's name for each breakdown: the row label it was opened from. */
export const MODEL_SETTINGS_DETAIL_TITLES: Record<ModelSettingsDetail, string> = {
  "context-window": "Context Window",
  "session-cost": "Session Cost",
  "reasoning-effort": "Reasoning Effort",
  speed: "Speed",
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
