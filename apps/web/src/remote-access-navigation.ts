/** Preserve the selected route, never credentials, query strings, fragments, or a second origin. */
export function secureDashboardUrl(origin: string, current: Pick<Location, "pathname">): string | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    url.pathname = current.pathname;
    return url.href;
  } catch { return null; }
}
