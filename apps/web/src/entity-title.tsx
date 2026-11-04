import React, { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { viewPath, type View } from "./navigation.js";

/**
 * The title an entity page reports for its route: the name of an entity the store does not hold,
 * which only the page itself loads (an Automation, #2968). Keyed by the route's path, so a title
 * reported for one route never names another while the next one loads.
 */
export interface ReportedEntityTitle {
  path: string;
  title: string;
}

type ReportEntityTitle = (path: string, title: string | null) => void;

const EntityTitleContext = createContext<ReportEntityTitle | null>(null);

/**
 * Holds the one reported title. The shell reads it for the window title, the route's loading
 * fallback and its error boundary, which all title an entity page by its entity (`viewTitle`).
 */
export function useEntityTitleState(): [ReportedEntityTitle | null, ReportEntityTitle] {
  const [reported, setReported] = useState<ReportedEntityTitle | null>(null);
  const report = useCallback<ReportEntityTitle>((path, title) => {
    setReported((current) => {
      // A page that leaves clears only its own title: the next route may already have reported.
      if (title === null) return current?.path === path ? null : current;
      return current?.path === path && current.title === title ? current : { path, title };
    });
  }, []);
  return [reported, report];
}

export function EntityTitleProvider({ report, children }: { report: ReportEntityTitle; children: ReactNode }) {
  return <EntityTitleContext.Provider value={report}>{children}</EntityTitleContext.Provider>;
}

/** The reported title when it belongs to `view`'s route. */
export function reportedTitleFor(reported: ReportedEntityTitle | null, view: View): string | undefined {
  return reported?.path === viewPath(view) ? reported.title : undefined;
}

/**
 * Reports `title` as the title of `view`'s route while the calling page is mounted, and takes it
 * back when the page leaves or the title goes. Outside a provider (a page under test) it does
 * nothing.
 */
export function useReportEntityTitle(view: View, title: string | null | undefined): void {
  const report = useContext(EntityTitleContext);
  const path = viewPath(view);
  useEffect(() => {
    if (!report || !title) return;
    report(path, title);
    return () => report(path, null);
  }, [report, path, title]);
}
