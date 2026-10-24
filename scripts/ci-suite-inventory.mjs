import { discoverNodeTests, profile } from "./node-test-plan.mjs";
import { browserFiles } from "../playwright.shards.ts";
import production from "../playwright.production.config.ts";
import { WEBKIT_SPECS } from "../playwright.webkit.config.ts";
import { GROUPS, CRITICAL_BROWSER_FILES, nodeGroup, selectGroups } from "./ci-suite-policy.mjs";

const fast = new Set(selectGroups({ entries: [{ path: "docs/example.md", status: "M" }] }).groups);
const rows = (await discoverNodeTests()).map((file) => ({ file, group: nodeGroup(file, profile.fastFiles) }));
for (const file of browserFiles()) rows.push({ file: `apps/web/e2e/${file}`, group: CRITICAL_BROWSER_FILES.includes(file) ? "browser-critical" : "browser-remaining" });
if (!Array.isArray(production.testMatch) || !production.testMatch.every((file) => typeof file === "string"))
  throw new Error("Unknown production inventory contract");
for (const file of production.testMatch) rows.push({ file: `apps/web/e2e/${file}`, group: "production" });
for (const file of WEBKIT_SPECS) rows.push({ file: `apps/web/e2e/${file}`, group: "webkit" });
console.log("file\tgroup\trisk\tfast\tfull\treason");
for (const { file, group } of rows.sort((a, b) => a.file.localeCompare(b.file, "en") || a.group.localeCompare(b.group, "en")))
  console.log([file, group, GROUPS[group].risk, fast.has(group) ? "selected" : "deferred", "included", GROUPS[group].reason].join("\t"));
