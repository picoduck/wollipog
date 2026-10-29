// Assurance contract v2 (prototype, advisory only). This module has no dependencies on code in the
// tested revision: tested files are parsed as text, never imported or executed.
//
// v2 refines exactly one v1 outcome. Every v1 `full` and `fast` result is returned unchanged, so all
// v1 fallbacks (unknown/shared/config/lockfile/CI/test-config, empty/truncated/missing base,
// renamed/deleted, cross-package, security/persistence/runner/approval risk) still select the
// complete contract. Only v1 `affected` (one ordinary app package) narrows its coarse Node and
// development Chromium closure to files a conservative import graph connects to the change.
import { GROUPS, selectGroups } from "./ci-suite-policy.mjs";

export const SUITE_VERSION_V2 = "fast-required-v2";
export const POLICY_VERSION_V2 = 2;
// Groups v1 selects wholesale for `affected`; v2 may select a subset of their files.
export const NARROWED_GROUPS = ["node-web", "node-control-plane", "node-runner", "node-other", "browser-remaining"];
export const GRAPH_LIMITS = { files: 20_000, bytes: 96 * 1024 * 1024, fileBytes: 2 * 1024 * 1024 };

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Paths the selector reads as graph text. Everything else stays outside the graph.
export const graphPath = (path) => !path.split("/").includes("node_modules") &&
  (/^(?:apps|packages)\/.+\.(?:[cm]?[jt]sx?|html)$/.test(path) || /^scripts\/.+\.[cm]?[jt]sx?$/.test(path) || /^playwright[^/]*\.[cm]?ts$/.test(path));
// Any browser spec depends on the dev server and Playwright configuration that serve every page.
export const BROWSER_IMPLICIT = ["apps/web/vite.config.ts", "playwright.config.ts", "playwright.ci.config.ts", "playwright.shards.ts", "playwright.ports.ts"];
// Computed module loading: the file may reach anything, so whatever reaches it is opaque.
const DYNAMIC = /\bimport\s*\(\s*(?!["'][^"'`$]*["']\s*\))|\bimport\.meta\.glob|\brequire\s*\(\s*(?!["'][^"']*["']\s*\))|\bcreateRequire\b|\beval\s*\(|\bnew\s+Function\s*\(/;
// Test-side child processes and directory enumeration can load or read source the graph cannot see.
// Literal source paths (new URL("./x.ts", import.meta.url), join(dir, "x.ts")) are edges below.
const TEST_OPAQUE = /\bnode:(?:child_process|worker_threads|vm)\b|["'](?:child_process|worker_threads|vm)["']|\b(?:spawn|spawnSync|execFile|execFileSync|execSync|exec|fork)\s*\(|\bnew\s+Worker\s*\(|\b(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)\s*\(/;
// Test-side file reads through a computed path under a source directory (template interpolation or a
// directory prefix) cannot be resolved to files, so they are opaque too. Literal paths are edges.
const TEST_SOURCE_READ = /\b(?:readFile|readFileSync|createReadStream)\s*\(/;
const COMPUTED_SOURCE_PATH = /["'`][^"'`\n]*\bsrc\/[^"'`\n]*\$\{|["'`](?:[\w.-]+\/)*src(?:\/[\w.-]+)*\/?["'`]/;
const testSide = (path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:e2e|fixtures|test-support|test-utils|__tests__)\//.test(path) ||
  /(?:^|[/-])(?:fixtures?|test-helpers?|testing)\.[cm]?[jt]sx?$/.test(path) || path.startsWith("scripts/");

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Referenced specifiers, mapped to true for module syntax (import/export/require) and false for literals. */
function specifiers(text) {
  const found = new Map();
  const patterns = [/\bfrom\s*["']([^"'\n]+)["']/g, /\bimport\s*["']([^"'\n]+)["']/g, /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    // Any relative path literal: new URL("./x", import.meta.url), mock.module("./x"), spawn arguments.
    /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/g, /["'`](\/src\/[^"'`\s$?#]+)["'`]/g,
    // Bare basenames such as join(dir, "runner-entry.ts") resolve to same-package files below.
    /["'`]([\w.-]+\.(?:[cm]?[jt]sx?))["'`]/g, /["']@wollipog\/([\w-]+(?:\/[\w./-]*)?)["']/g, /["'`/]([\w-]+\.html)\b/g,
    // Package- or repository-relative paths such as join(WEB, "src/components/X.tsx").
    /["'`]((?:[\w@.-]+\/)+[\w.-]+\.(?:[cm]?[jt]sx?|html))["'`]/g];
  patterns.forEach((pattern, index) => {
    for (const match of text.matchAll(pattern)) {
      if (index === 9 && /^(?:\.{1,2}\/|\/|@wollipog\/)/.test(match[1])) continue;
      const spec = index === 7 ? `@wollipog/${match[1]}` : index === 8 ? `html:${match[1]}` : index === 9 ? `path:${match[1]}` : match[1];
      found.set(spec, found.get(spec) || index < 4);
    }
  });
  return found;
}

const normalize = (parts) => {
  const out = [];
  for (const part of parts) { if (part === "..") { if (!out.length) return null; out.pop(); } else if (part && part !== ".") out.push(part); }
  return out.join("/");
};
export const packageRoot = (path) => path.match(/^(?:apps|packages)\/[^/]+\//)?.[0] ?? (path.startsWith("scripts/") ? "scripts/" : "");

/**
 * Packages opaque code can reach: its own package plus every workspace package its text names by
 * directory, relative sibling path or package name. Root tooling (`scripts/`, root configs) is
 * unscoped (`*`): it may reach anything.
 */
function opaqueScope(path, text, roots) {
  const own = packageRoot(path);
  if (!own || own === "scripts/") return new Set(["*"]);
  const scope = new Set([own]);
  for (const root of roots) {
    const name = root.split("/")[1];
    if (text.includes(root.slice(0, -1)) || text.includes(`@wollipog/${name}`) || new RegExp(`\\.\\./${name.replace(/[-]/g, "\\-")}/`).test(text)) scope.add(root);
  }
  return scope;
}

/**
 * Build a conservative dependency graph from file text. `files` maps tested-tree paths to text
 * (`null` when unreadable or oversized). `packages` maps `@wollipog/<name>` to its directory and
 * export targets. Unresolvable local references never shrink a selection: they mark the importer
 * opaque, as does computed module loading.
 */
export function buildGraph(files, packages = {}) {
  // opaque: path -> package roots it may reach (`*` = any). Computed loading and test-side
  // processes/directory enumeration both make a file opaque.
  const paths = new Set(files.keys()), byBase = new Map(), edges = new Map(), opaque = new Map();
  const roots = [...new Set([...paths].map(packageRoot).filter((root) => root && root !== "scripts/"))].sort();
  for (const path of paths) {
    const key = `${packageRoot(path)}${path.split("/").at(-1)}`;
    byBase.set(key, [...(byBase.get(key) ?? []), path]);
  }
  const candidates = (target) => {
    const stem = target.replace(/\.(?:[cm]?js|jsx)$/, "");
    return [target, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"].flatMap((ext) => [stem + ext, `${target}${ext}`, `${target}/index${ext}`])];
  };
  for (const [path, text] of files) {
    const out = new Set();
    edges.set(path, out);
    if (typeof text !== "string") { opaque.set(path, new Set(["*"])); continue; }
    if (DYNAMIC.test(text) || (testSide(path) && (TEST_OPAQUE.test(text) || (TEST_SOURCE_READ.test(text) && COMPUTED_SOURCE_PATH.test(text)))))
      opaque.set(path, opaqueScope(path, text, roots));
    const dir = path.split("/").slice(0, -1);
    // Literal mentions of a test file (comments, messages) are not dependencies; imports are.
    const link = (target, module) => { if (module || !TEST_FILE.test(target)) out.add(target); };
    for (const [raw, module] of specifiers(text)) {
      const spec = raw.replace(/[?#].*$/, "");
      if (spec.startsWith("html:")) {
        // Page names are navigation only in browser-spec code; elsewhere they name built output.
        const page = `apps/web/${spec.slice(5)}`;
        if (path.startsWith("apps/web/e2e/") && paths.has(page)) out.add(page);
        continue;
      }
      if (spec.startsWith("path:")) {
        // Resolve against this directory and every ancestor up to the repository root.
        const rel = spec.slice(5);
        for (let depth = dir.length; depth >= 0; depth -= 1) {
          const target = normalize([...dir.slice(0, depth), ...rel.split("/")]);
          if (target !== null && paths.has(target)) link(target, false);
        }
        continue;
      }
      if (spec.startsWith("@wollipog/")) {
        const [, name, sub = ""] = spec.match(/^@wollipog\/([\w-]+)(?:\/(.*))?$/) ?? [];
        const pkg = packages[name];
        if (!pkg) continue;
        const target = sub ? pkg.exports[`./${sub}`] : pkg.exports["."];
        if (target && paths.has(target)) out.add(target);
        // Unknown subpath: depend on the whole package rather than nothing.
        else for (const file of paths) if (file.startsWith(pkg.dir)) link(file, false);
        continue;
      }
      if (spec.startsWith("/src/")) {
        const found = candidates(`apps/web${spec}`).find((file) => paths.has(file));
        if (found) link(found, module); else if (path.endsWith(".html")) opaque.set(path, new Set(["*"]));
        continue;
      }
      if (spec.startsWith(".")) {
        const base = normalize([...dir, ...spec.split("/")]);
        const found = base === null ? undefined : candidates(base).find((file) => paths.has(file));
        if (found) link(found, module);
        // A relative module reference that names no tested file is uncertain; data paths are not.
        else if (module && (SOURCE.test(spec) || !/\.[A-Za-z0-9]+$/.test(spec.split("/").at(-1)))) opaque.set(path, new Set(["*"]));
        continue;
      }
      if (SOURCE.test(spec)) for (const file of byBase.get(`${packageRoot(path)}${spec}`) ?? []) link(file, false);
    }
  }
  return { edges, opaque };
}

/** Files from which any `targets` member is reachable along dependency edges, including targets. */
export function dependents(graph, targets) {
  const reverse = new Map();
  for (const [from, list] of graph.edges) for (const to of list) reverse.set(to, [...(reverse.get(to) ?? []), from]);
  const seen = new Set(targets), queue = [...targets];
  while (queue.length) for (const from of reverse.get(queue.pop()) ?? []) if (!seen.has(from)) { seen.add(from); queue.push(from); }
  return seen;
}

/** Files reachable from `root` along dependency edges, including root. */
export function closure(graph, root) {
  const seen = new Set([root]), queue = [root];
  while (queue.length) for (const to of graph.edges.get(queue.pop()) ?? []) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  return seen;
}

/**
 * Select inventory rows. `inventory` rows carry `{ file, group }` as produced by v1's
 * `suiteInventory`. `graph` is null when the tested tree's graph is unavailable or over bounds.
 * No author, label or PR-prose input exists.
 */
export function selectFilesV2({ diff, inventory, graph }) {
  const v1 = selectGroups(diff);
  const all = (choice) => ({ ...choice, v1Mode: v1.mode, partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0,
    selectedFiles: inventory.filter((row) => choice.groups.includes(row.group)).map((row) => row.file) });
  if (v1.mode !== "affected") return all(v1);
  const changed = diff.entries.map((entry) => entry.path);
  const fallback = !graph ? "graph-unavailable" : changed.some((path) => !graph.edges.has(path)) ? "graph-missing-changed-file" : null;
  if (fallback) return all({ ...v1, mode: "full", reasons: [fallback], groups: Object.keys(GROUPS).sort() });
  const narrowed = narrow({ changed, inventory, graph, groups: v1.groups });
  return { ...v1, v1Mode: v1.mode, ...narrowed, partialGroups: NARROWED_GROUPS.filter((group) =>
    inventory.some((row) => row.group === group && !narrowed.selectedFiles.includes(row.file))) };
}

/**
 * The graph rule alone: of `groups`, keep non-narrowed groups whole and narrowed-group files that
 * reach a changed file or in-scope opaque code. Only `selectFilesV2` applies it as policy, after
 * every v1 fallback; offline evaluation also applies it counterfactually to measure graph recall.
 */
export function narrow({ changed, inventory, graph, groups }) {
  const reached = dependents(graph, changed.filter((path) => graph.edges.has(path)));
  const implicit = BROWSER_IMPLICIT.flatMap((path) => graph.edges.has(path) ? [...closure(graph, path)] : []);
  const changedRoots = new Set(changed.map(packageRoot));
  const selected = new Set(), reasons = new Map();
  let scopedOpaqueDeferred = 0;
  const mark = (file, reason) => { selected.add(file); reasons.set(reason, (reasons.get(reason) ?? 0) + 1); };
  for (const row of inventory) {
    if (!groups.includes(row.group)) continue;
    if (!NARROWED_GROUPS.includes(row.group)) { mark(row.file, "group-always"); continue; }
    const deps = [...closure(graph, row.file), ...(row.group === "browser-remaining" ? implicit : [])];
    const scopes = deps.flatMap((file) => graph.opaque.has(file) ? [graph.opaque.get(file)] : []);
    if (deps.some((file) => reached.has(file))) mark(row.file, "imports-change");
    // Opaque code may reach any package in its scope, so a change there selects it (v1's closure).
    else if (scopes.some((scope) => scope.has("*") || [...changedRoots].some((root) => scope.has(root)))) mark(row.file, "opaque-dependency");
    else if (row.group === "browser-remaining" && !deps.some((file) => file.endsWith(".html"))) mark(row.file, "unmapped-browser-page");
    // Sensitivity measure: deferred only because opacity is package-scoped rather than global.
    else if (scopes.length) scopedOpaqueDeferred += 1;
  }
  return { scopedOpaqueDeferred, selectionReasons: Object.fromEntries([...reasons].sort(([a], [b]) => a.localeCompare(b, "en"))),
    selectedFiles: inventory.filter((row) => selected.has(row.file)).map((row) => row.file) };
}
