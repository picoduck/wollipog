export type RunnerEntryMode =
  | "--state-doctor"
  | "--policy-hook"
  | "--agent-control-mcp"
  | "--wollipog-cli"
  | "--managed-worktree-guard"
  | "daemon";

const INTERNAL_MODES = new Set<RunnerEntryMode>([
  "--state-doctor",
  "--policy-hook",
  "--agent-control-mcp",
  "--wollipog-cli",
  "--managed-worktree-guard",
]);

/** Node reserves argv[1] for the script path, including in a SEA binary, where it repeats the
 * executable path. Only argv[2] may select an internal mode; later user data cannot. */
export const RUNNER_APP_ARGUMENT_INDEX = 2;

export function resolveRunnerEntry(argv: readonly string[]): { mode: RunnerEntryMode; modeIndex: number } {
  const modeIndex = RUNNER_APP_ARGUMENT_INDEX;
  const first = argv[modeIndex] as RunnerEntryMode | undefined;
  if (first && INTERNAL_MODES.has(first)) return { mode: first, modeIndex };
  if (/(?:^|[\\/])wollipog(?:\.exe)?$/iu.test(argv[0] ?? "")) {
    return { mode: "--wollipog-cli", modeIndex };
  }
  return { mode: "daemon", modeIndex };
}
