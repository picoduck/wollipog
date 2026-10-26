import { resolve, join } from "node:path";
import { ReviewWriterRegistry } from "./review-writers.js";

export interface ReviewWriterDoctorArgs {
  command: "inspect" | "retire-legacy";
  dataDir: string;
  recordId?: string;
  sha256?: string;
}

export function parseReviewWriterDoctorArgs(argv: readonly string[]): ReviewWriterDoctorArgs {
  const [command, ...rest] = argv;
  if (command !== "inspect" && command !== "retire-legacy") throw new Error("Review writer doctor requires inspect or retire-legacy.");
  const allowed = new Set(["--data-dir", "--record-id", "--sha256"]);
  const args = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!, value = rest[i + 1];
    if (!allowed.has(key) || args.has(key) || !value || value.startsWith("--") || value.includes("\0")) {
      throw new Error("Invalid or duplicate review writer doctor argument.");
    }
    args.set(key, value);
  }
  const data = args.get("--data-dir"), recordId = args.get("--record-id"), sha256 = args.get("--sha256");
  if (!data || (command === "inspect" && (recordId || sha256)) ||
      (command === "retire-legacy" && (!recordId || !/^[A-Za-z0-9_-]{1,128}$/u.test(recordId) || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)))) {
    throw new Error("Use --data-dir <path>; retire-legacy also requires the exact --record-id <id> and --sha256 <digest> from inspect.");
  }
  return { command, dataDir: resolve(data), recordId, sha256 };
}

/** Called only under state-doctor's exclusive offline maintenance lease. Never an agent RPC. */
export function runReviewWriterDoctor(
  args: ReviewWriterDoctorArgs,
  output: (text: string) => unknown,
  registry = new ReviewWriterRegistry(join(args.dataDir, "unprotected-agent-writers"), undefined, { reconcile: false }),
): void {
  if (args.command === "inspect") { output(`${JSON.stringify({ writers: registry.inspect() })}\n`); return; }
  const result = registry.retireLegacy(args.recordId!, args.sha256!);
  output(`${JSON.stringify({ ...result, ...(!result.retired ? {
    guidance: "Stop the runner first so its bwrap providers exit. End the listed live processes or restore inspection access, then retry with the unchanged record digest. A later SSH login can block proof. No process is killed by this command; missing start times or command names mean identity was unreadable or changed during inspection.",
  } : {}) })}\n`);
  if (!result.retired) throw new Error(`Review writer retirement refused: ${result.reason}. Preserve the record and inspect again.`);
}
