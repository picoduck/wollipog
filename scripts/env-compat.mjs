/** Read the Wollipog name first and fall back to one legacy MAM name for the migration window. */
export function readCompatibleEnv(env, currentName, legacyName, warn) {
  const current = env[currentName];
  if (current !== undefined) return current;
  const legacy = env[legacyName];
  if (legacy !== undefined) {
    warn?.(`${legacyName} is deprecated; use ${currentName}`);
    return legacy;
  }
  return undefined;
}
