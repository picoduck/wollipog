// Full Node/platform coverage; reduce development Chromium only. Independent of historical cohorts.
export const PR_BROWSER_POLICY = "pr-browser-critical-v2";
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

// Browser infrastructure is deliberately outside the ordinary-source risk tradeoff.
const browserInfrastructure = (path) =>
  /(?:^|\/)(?:fixtures|helpers|harness|harnesses|test-support|test-utils)\//.test(path) ||
  /^playwright(?:[./-]|$)/.test(path) ||
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|devbox\.(?:json|lock)|tsconfig[^/]*\.json|\.nvmrc|\.node-version|\.npmrc)$/.test(path) ||
  /^\.github\//.test(path) ||
  /^scripts\/(?:ci-|workflow-|browser-shards|fast-gate-|restore-main-push-ci|main-rolling)/.test(path);

const ordinaryInput = (path) =>
  /^apps\/(?:web|control-plane|runner)\/src\//.test(path) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) ||
  /^(?:docs\/|apps\/web\/public\/)/.test(path) ||
  /\.(?:md|mdx|css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/.test(path);

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
    if (!entry || !["A", "M", "D"].includes(entry.status) || !safePath(entry.path)) return full("uncertain-change");
    const path = entry.path;
    if (browserInfrastructure(path)) return full("browser-infrastructure-or-toolchain");
    if (spec(path)) {
      if (entry.status === "D") return full("browser-spec-deleted-or-renamed");
      if (!inventory.includes(path)) return full("changed-spec-unavailable");
      selected.add(path);
      continue;
    }
    if (/(?:^|\/)e2e\//.test(path)) return full("browser-harness-or-support");
    // App auth/session/store/runner changes accept deferred browser-regression risk:
    // all Node tests still run, and complete browser coverage gates the merge group.
    if (!ordinaryInput(path)) return full("unknown-input");
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
