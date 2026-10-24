// Assurance contract v1. This module has no dependencies on code in the tested revision.
export const SUITE_VERSION = "fast-required-v1";
export const POLICY_VERSION = 1;
export const FAST_API_FILES = ["apps/control-plane/src/auth.test.ts", "apps/control-plane/src/authentication-recovery-routes.test.ts",
  "apps/control-plane/src/runner-channel.integration.test.ts"];
export const CRITICAL_BROWSER_FILES = [
  "authentication-recovery.spec.ts", "new-session-choices.spec.ts",
  "request-surfaces.spec.ts", "issue-closure.spec.ts", "conversation-handoff.spec.ts",
];

export const ALWAYS = ["typecheck", "web-build", "runner-bundle", "control-plane-bundle", "production", "webkit"];
export const GROUPS = {
  "node-fast": { risk: "contract", reason: "Reviewed protocol partition plus authentication and real-server runner-channel API contracts are always selected." },
  "node-web": { risk: "presentation-and-approval", reason: "All app source changes select every Node partition because tests cross app boundaries; deferred only by the fixed fast candidate." },
  "node-control-plane": { risk: "security-and-persistence", reason: "Control-plane tests import web state and runner execution; app source changes select the entire Node closure." },
  "node-runner": { risk: "execution-and-enforcement", reason: "Runner tests import control-plane services and web identity; app source changes select the entire Node closure." },
  "node-other": { risk: "shared-contract", reason: "Protocol, test support, root tooling and desktop contracts require full fallback when affected." },
  "browser-critical": { risk: "critical-journey", reason: "Authentication recovery, session creation, decisions, issue closure and handoff always run." },
  "browser-remaining": { risk: "cross-component", reason: "All Chromium journeys for any app-package source change; deferred only for documentation." },
  typecheck: { risk: "shared-contract", reason: "Every package typecheck remains mandatory." },
  "web-build": { risk: "production", reason: "Production web compilation remains mandatory." },
  "runner-bundle": { risk: "execution", reason: "Runner bundle validation remains mandatory." },
  "control-plane-bundle": { risk: "security", reason: "Control-plane sidecar bundle validation remains mandatory." },
  production: { risk: "production", reason: "Every configured production browser smoke remains mandatory." },
  webkit: { risk: "engine-compatibility", reason: "Every configured WebKit contract remains mandatory." },
  "linux-containment": { risk: "sandbox", reason: "Delegated Linux system/user-manager containment requires CI privileges; full fallback for execution/security changes." },
  "engine-boundaries": { risk: "runtime-compatibility", reason: "Minimum/excluded/recommended Node/pnpm checks need CI's provisioned runtimes; full fallback for configuration changes." },
  "windows-baselines": { risk: "platform-compatibility", reason: "Existing Windows baseline workflow retains its own conservative routing; full fallback for app/config changes." },
};

export function nodeGroup(file, fastFiles) {
  if (fastFiles.includes(file) || FAST_API_FILES.includes(file)) return "node-fast";
  if (file.startsWith("apps/web/")) return "node-web";
  if (file.startsWith("apps/control-plane/")) return "node-control-plane";
  if (file.startsWith("apps/runner/")) return "node-runner";
  return "node-other";
}

export function pathRisk(path) {
  if (/(?:auth|approv|permission|workflow|campaign|sandbox|containment|cgroup|security|secret|credential|provider-home|provider-account|identity|principal|token|encrypt|crypto|policy|lease|governance|agent-control|(?:^|\/)(?:hub|sessions|devices)\.)/i.test(path)) return "security-and-approval";
  if (/(?:persist|migration|database|(?:^|\/)db[./-]|store|sqlite|retention)/i.test(path)) return "persistence-and-migration";
  if (path.startsWith("apps/runner/")) return "runner-execution";
  return "ordinary";
}

/** Only complete Git name-status entries qualify for reduced coverage. No author/label input. */
export function selectGroups({ entries, complete = true, baseKnown = true } = {}) {
  const reasons = new Set(), risks = new Set(), packages = new Set();
  if (!baseKnown) reasons.add("missing-base");
  if (!complete) reasons.add("incomplete-diff");
  if (!Array.isArray(entries) || !entries.length) reasons.add("empty-diff");
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !["A", "M"].includes(entry.status)) { reasons.add("renamed-deleted-or-unsupported-status"); continue; }
    const path = entry.path;
    if (typeof path !== "string" || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
      reasons.add("unknown-path"); continue;
    }
    // Only prose Markdown is eligible. Profiles, inventories and policy under docs are inputs.
    if ((path.startsWith("docs/") && path.endsWith(".md")) || ["README.md", "CONTRIBUTING.md"].includes(path)) continue;
    const pkg = path.match(/^apps\/(web|control-plane|runner)\/src\/.+\.[cm]?[jt]sx?$/)?.[1];
    if (/(?:^|\/)(?:shared|fixtures|test-support|test-utils)\//.test(path) ||
        /^apps\/[^/]+\/src\/(?:index|main|App)\.[cm]?[jt]sx?$/.test(path)) reasons.add("shared-config-test-or-unknown-input");
    const risk = pathRisk(path);
    risks.add(risk);
    if (risk !== "ordinary") reasons.add(risk);
    if (pkg) packages.add(pkg);
    else reasons.add("shared-config-test-or-unknown-input");
  }
  if (packages.size > 1) reasons.add("cross-package-diff");
  const fallback = reasons.size > 0;
  const groups = new Set([...ALWAYS, "node-fast", "browser-critical"]);
  if (fallback) Object.keys(GROUPS).forEach((group) => groups.add(group));
  else if (packages.size) {
    // Existing tests cross app boundaries (runner -> web identity, control-plane -> web store,
    // runner <-> control-plane). Until a narrower graph is verified, take their full closure.
    for (const group of ["node-web", "node-control-plane", "node-runner", "node-other", "browser-remaining", "windows-baselines"]) groups.add(group);
  }
  return { mode: fallback ? "full" : packages.size ? "affected" : "fast",
    reasons: [...reasons].sort(), risks: [...risks].sort(), groups: [...groups].sort() };
}
