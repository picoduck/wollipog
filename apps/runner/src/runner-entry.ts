export type RunnerEntryMode =
  | "--state-doctor"
  | "--policy-hook"
  | "--conductor-mcp"
  | "--agent-control-mcp"
  | "--wollipog-cli"
  | "daemon";

const INTERNAL_MODES = new Set<RunnerEntryMode>([
  "--state-doctor",
  "--policy-hook",
  "--conductor-mcp",
  "--agent-control-mcp",
  "--wollipog-cli",
]);

/** Resolve only the first application argument. Provider/user data later in argv must never
 * switch the runner into an internal sidecar mode. SEA argv starts at index 1; Node/tsx argv
 * retains the script path at index 1 and starts application arguments at index 2. */
export function resolveRunnerEntry(
  argv: readonly string[],
  isSea: boolean,
): { mode: RunnerEntryMode; modeIndex: number } {
  const modeIndex = isSea ? 1 : 2;
  const first = argv[modeIndex] as RunnerEntryMode | undefined;
  if (first && INTERNAL_MODES.has(first)) return { mode: first, modeIndex };
  if (/(?:^|[\\/])wollipog(?:\.exe)?$/iu.test(argv[0] ?? "")) {
    return { mode: "--wollipog-cli", modeIndex };
  }
  return { mode: "daemon", modeIndex };
}
