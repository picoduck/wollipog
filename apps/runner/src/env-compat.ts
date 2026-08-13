export type Environment = Readonly<Record<string, unknown>>;
export type LegacyEnvironmentWarning = (message: string) => void;

/** Read the Wollipog name first and fall back to one legacy MAM name for the migration window. */
export function readCompatibleEnv(
  env: Environment,
  currentName: string,
  legacyName: string,
  warn?: LegacyEnvironmentWarning,
): string | undefined {
  const current = env[currentName];
  if (current !== undefined) return typeof current === "string" ? current : undefined;
  const legacy = env[legacyName];
  if (legacy !== undefined) {
    warn?.(`${legacyName} is deprecated; use ${currentName}`);
    return typeof legacy === "string" ? legacy : undefined;
  }
  return undefined;
}
