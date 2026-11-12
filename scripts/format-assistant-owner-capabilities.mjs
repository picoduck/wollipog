import { readFileSync, writeFileSync } from "node:fs";

// One exact route per physical line keeps unrelated parity slices independent in Git.
// Formatting preserves every entry's classification and content; it never infers coverage.
if (process.argv.slice(2).some(arg => arg !== "--check")) {
  console.error("Usage: node scripts/format-assistant-owner-capabilities.mjs [--check]");
  process.exit(2);
}
const path = new URL("../docs/assistant-owner-capabilities.json", import.meta.url);
const before = readFileSync(path, "utf8"), entries = JSON.parse(before);
const after = "{\n" + Object.keys(entries).sort().map(route =>
  `  ${JSON.stringify(route)}: ${JSON.stringify(entries[route])}`).join(",\n") + "\n}\n";
if (process.argv.includes("--check")) {
  if (before !== after) {
    console.error("Owner capability audit formatting differs. Run node scripts/format-assistant-owner-capabilities.mjs.");
    process.exitCode = 1;
  }
} else if (before !== after) {
  writeFileSync(path, after);
}
