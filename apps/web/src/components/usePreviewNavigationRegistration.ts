import { useLayoutEffect } from "react";

export interface PreviewNavigationControls {
  beginProgrammaticScroll: (direction: "next" | "previous") => void;
  follow: () => void;
}

export function usePreviewNavigationRegistration(
  mode: "preview" | "expanded",
  register: ((controls: PreviewNavigationControls | null) => void) | undefined,
  controls: PreviewNavigationControls,
): void {
  useLayoutEffect(() => {
    if (mode !== "preview" || !register) return;
    register(controls);
    return () => register(null);
  }, [controls, mode, register]);
}
