import { parse } from "shell-quote";
import { basename, isAbsolute } from "node:path";

/** Recognize only a standalone injected CLI invocation with literal JSON arguments. Never
 * interpret shell syntax, read a payload file, or use an agent's description as admission proof. */
export function codexCliAdmission(script: string, output: string, threadId: string, turnId: string): {
  occurrenceId: string; command: string; approved: boolean;
} | null {
  const match = /^(?:"\$WOLLIPOG_CLI"|wollipog) decision consume ([A-Za-z0-9_-]{1,512}) --snapshot '([^'\n]+)' --action '([^'\n]+)' --json$/u.exec(script);
  if (!match) return null;
  try {
    const snapshot = JSON.parse(match[2]!);
    const action = JSON.parse(match[3]!);
    if (snapshot?.category !== "pr_merge" || action?.kind !== "pr_merge_enqueue" ||
        typeof action.command !== "string" || !action.command || action.command.length > 2000) return null;
    // Node warnings precede the CLI's one JSON response in aggregated_output. Only complete
    // JSON lines count, and multiple responses are ambiguous. No substring extraction.
    const responses = output.length > 100_000 ? [] : output.split("\n").flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const decision = responses.length === 1 ? responses[0]?.decision : undefined;
    const admission = decision?.actionAdmission;
    return {
      occurrenceId: match[1]!, command: action.command,
      approved: decision?.occurrenceId === match[1] && decision?.status === "approved" &&
        admission?.kind === "pr_merge_enqueue" && admission?.command === action.command &&
        admission?.providerThreadId === threadId && admission?.providerTurnId === turnId,
    };
  } catch { return null; }
}
/** Decode a provider-rendered shell argv for admission only. The enqueue command identity uses
 * its existing stricter decoder. No variable expansion, operators, or extra arguments qualify. */
export function codexCliAdmissionScript(input: string): string {
  try {
    const argv = parse(input, () => { throw new Error("expansion is not an argv identity"); });
    if (argv.length === 3 && argv.every((entry) => typeof entry === "string") &&
        isAbsolute(argv[0] as string) && ["ash", "bash", "dash", "ksh", "sh", "zsh"].includes(basename(argv[0] as string)) &&
        (argv[1] === "-c" || argv[1] === "-lc")) return argv[2] as string;
  } catch { /* The original script remains subject to the exact CLI grammar. */ }
  return input;
}

