// Full Node/platform coverage; reduce development Chromium only. Independent of historical cohorts.
export const PR_BROWSER_POLICY = "pr-browser-critical-v1";
export const CRITICAL_BROWSER_FILES = [
  // Authentication, creation, approval/issue decisions and conversation continuity.
  "authentication-recovery.spec.ts", "new-session-choices.spec.ts", "request-surfaces.spec.ts",
  "issue-closure.spec.ts", "conversation-handoff.spec.ts",
  // Recorded regressions #3617 (UTC trigger boundary) and #3517 (Composer Escape).
  "automation-triggers.spec.ts", "command-inbox-projects.spec.ts",
];
const spec = (path) => /^apps\/web\/e2e\/[A-Za-z0-9_/-]+\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path);
const safePath = (path) => typeof path === "string" && /^[A-Za-z0-9_./-]+$/.test(path) &&
  !path.split("/").some((part) => !part || part === "." || part === "..");

/** Unknown inputs and infrastructure changes retain the complete browser inventory. */
export function browserSelection({ entries, inventory, complete = true, baseKnown = true } = {}) {
  const full = (reason) => ({ policy: PR_BROWSER_POLICY, mode: "full", reason, files: [] });
  if (!complete || !baseKnown || !Array.isArray(entries) || !entries.length || entries.length > 5000)
    return full("diff-unavailable");
  if (!Array.isArray(inventory) || !inventory.length || inventory.length > 5000 ||
      inventory.some((path) => !safePath(path) || !spec(path)) || new Set(inventory).size !== inventory.length)
    return full("inventory-unavailable");
  const required = CRITICAL_BROWSER_FILES.map((file) => `apps/web/e2e/${file}`);
  if (required.some((file) => !inventory.includes(file))) return full("critical-inventory-unavailable");
  const selected = new Set(required);
  for (const entry of entries) {
    if (!entry || !["A", "M"].includes(entry.status) || !safePath(entry.path)) return full("uncertain-change");
    const path = entry.path;
    if (/(?:^|\/)(?:shared|fixtures|helpers|harness|test-support|test-utils)\//.test(path))
      return full("shared-high-risk-or-unknown-input");
    if (spec(path)) {
      if (!inventory.includes(path)) return full("changed-spec-unavailable");
      selected.add(path);
      continue;
    }
    // Only ordinary application implementation files qualify. Fixtures, harnesses, scripts,
    // docs, manifests, assets, shared packages and configuration remain full.
    if (!/^apps\/(?:web|control-plane|runner)\/src\/.+\.[cm]?[jt]sx?$/.test(path) ||
        /(?:^|\/)(?:shared|fixtures|test-support|test-utils|e2e)\//.test(path) ||
        /(?:\.test\.|(?:^|\/)(?:index|main|App)\.)/.test(path) ||
        /(?:auth|approv|permission|workflow|campaign|sandbox|containment|cgroup|security|secret|credential|provider-home|provider-account|identity|principal|token|encrypt|crypto|policy|lease|governance|persist|migration|database|(?:^|\/)db[./-]|store|sqlite|retention)/i.test(path))
      return full("shared-high-risk-or-unknown-input");
  }
  return { policy: PR_BROWSER_POLICY, mode: "fast", reason: "critical-and-changed-browser-files", files: [...selected].sort() };
}

/** Execution config validation: plan strings are data, never executable command arguments. */
export function validateBrowserFiles(value, inventory) {
  let files;
  try { files = JSON.parse(value); } catch { throw new Error("Invalid PR browser selection"); }
  if (!Array.isArray(files) || !files.length || files.length > 5000 || new Set(files).size !== files.length ||
      files.some((file) => !safePath(file) || !spec(file) || !inventory.includes(file)) ||
      CRITICAL_BROWSER_FILES.some((file) => !files.includes(`apps/web/e2e/${file}`)))
    throw new Error("Incomplete PR browser selection");
  return files;
}
