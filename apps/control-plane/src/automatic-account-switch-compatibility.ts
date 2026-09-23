import {
  runnerSupportsProtocol,
  type HarnessInstallationChoice,
  type RunnerAutomaticAccountSwitchConfiguration,
} from "@wollipog/protocol";

/** An older runner can switch accounts using usage from an unselected installation. Keep the
 * saved preference untouched, but send a later effective revision that disables switching. */
export function automaticAccountSwitchForRunner(
  configuration: RunnerAutomaticAccountSwitchConfiguration | null,
  runnerProtocolVersion: number | null | undefined,
  selections: readonly Pick<HarnessInstallationChoice, "family">[] | undefined,
): RunnerAutomaticAccountSwitchConfiguration | undefined {
  if (!runnerSupportsProtocol(runnerProtocolVersion, "automaticProviderAccountSwitch")) return undefined;
  if (selections?.some((choice) => choice.family === "codex" || choice.family === "claude") &&
      !runnerSupportsProtocol(runnerProtocolVersion, "automaticAccountSwitchHarnessSelection")) {
    return { enabled: false, revision: (configuration?.revision ?? 0) + 1 };
  }
  return configuration ?? undefined;
}
