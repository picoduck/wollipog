import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CUTOVER_MARKER = "  # Rolling main-push cutover; restore with scripts/restore-main-push-ci.mjs.\n";

/** Restore only the old trigger, retaining subsequent PR/queue/job edits. */
export function restoreMainPushCi(source) {
  if (!source.startsWith("name: CI\n") || !source.includes("\non:\n") ||
      source.split(CUTOVER_MARKER).length !== 2 || /^  push:/m.test(source)) {
    throw new Error("Expected exactly one rolling cutover marker and no existing push trigger");
  }
  return source.replace(CUTOVER_MARKER, "  push:\n    branches: [main]\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));
  writeFileSync(path, restoreMainPushCi(readFileSync(path, "utf8")));
  console.log("Restored main-push CI. Review, test, and merge this change before disabling the rolling controller.");
}
