/** Content-bounded selectors shared by Claude's stdio and native-hook approval paths. */
export function approvalScopeContext(input: unknown): {
  path?: string;
  network?: string;
  branch?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const bounded = (value: unknown) => {
    if (typeof value !== "string" || !value) return undefined;
    return value.length <= 1024 ? value : `${value.slice(0, 1024)}…`;
  };
  const first = (keys: string[]) => {
    for (const key of keys) {
      const value = bounded(source[key]);
      if (value) return value;
    }
    return undefined;
  };
  const path = first(["file_path", "path", "notebook_path"]);
  const network = first(["url", "host", "hostname", "domain"]);
  const branch = first(["branch", "branch_name"]);
  return {
    ...(path ? { path } : {}),
    ...(network ? { network } : {}),
    ...(branch ? { branch } : {}),
  };
}
