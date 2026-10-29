// Shadow-only selection candidate v3 (#3787). Like v2 it has no dependency on code in the tested
// revision: tested files are read as text and never imported or executed.
//
// v3 relaxes exactly three low-risk v1 fallbacks and keeps every other one:
//   - Markdown, which becomes a graph node linked by literal path references;
//   - browser specs and e2e fixtures under apps/web/e2e/, which select themselves and their importers;
//   - data and asset files (JSON, text, images, fonts, HTML pages), which are graph nodes and must be
//     referenced by a literal path (or Playwright's snapshot convention), or the diff selects full.
// A relaxed path that matches a security/approval, persistence/migration or runner risk rule, a
// manifest, configuration, CI, selector or root-tooling input stays a v1 fallback. Deletions, renames,
// empty/incomplete diffs and missing bases still select full. Without a relaxed path, v3 is v2 exactly.
import { FAST_PROSE_FILES, GROUPS, pathRisk, selectGroups } from "./ci-suite-policy.mjs";
import { NARROWED_GROUPS, packageRoot, selectFilesV2, narrow } from "./ci-suite-policy-v2.mjs";

export const SUITE_VERSION_V3 = "fast-required-v3";
export const POLICY_VERSION_V3 = 3;
const DATA = /\.(?:json|txt|tsv|csv|png|jpe?g|gif|webp|svg|ico|webm|mp4|woff2?|ttf|webmanifest|html)$/;
// Inputs that configure tooling, CI, packaging or the selector itself are never relaxed.
const RETAINED = /^(?:\.github|\.agents|scripts|skills)\/|^apps\/desktop\/src-tauri\/|(?:^|\/)(?:package\.json|pnpm-[\w-]+\.ya?ml|tsconfig[^/]*\.json|[^/]*\.config\.[\w.]+|[^/]*rc(?:\.\w+)?|playwright[^/]*)$|^docs\/ci-node-profile/;
const DIFF_LEVEL = ["missing-base", "incomplete-diff", "empty-diff", "renamed-deleted-or-unsupported-status", "unknown-path"];

/** The low-risk class a changed path belongs to, or null when it keeps its v1 fallback. */
export function relaxedClass(path) {
  // v1's reviewed prose allowlist already selects `fast`; relaxing it would only widen that.
  if (typeof path !== "string" || FAST_PROSE_FILES.includes(path) || RETAINED.test(path) || pathRisk(path) !== "ordinary") return null;
  if (/\.mdx?$/.test(path)) return "markdown";
  if (path.startsWith("apps/web/e2e/")) return DATA.test(path) ? "data-or-asset" : "browser-spec-or-fixture";
  if (DATA.test(path) && path.includes("/")) return "data-or-asset";
  return null;
}

const normalize = (parts) => {
  const out = [];
  for (const part of parts) { if (part === "..") { if (!out.length) return null; out.pop(); } else if (part && part !== ".") out.push(part); }
  return out.join("/");
};

/**
 * Add data/asset/Markdown nodes and literal-reference edges to a v2 graph (copied, never mutated).
 * `texts` maps graph source paths to text; `dataPaths` lists tested-tree data and Markdown files.
 */
export function withDataEdges(graph, texts, dataPaths) {
  const edges = new Map([...graph.edges].map(([from, list]) => [from, new Set(list)]));
  const data = new Set(dataPaths), byBase = new Map();
  for (const path of data) {
    if (path.endsWith(".html")) continue;
    if (!edges.has(path)) edges.set(path, new Set());
    const key = `${packageRoot(path)}${path.split("/").at(-1)}`;
    byBase.set(key, [...(byBase.get(key) ?? []), path]);
  }
  // HTML pages are excluded: they are already v2 graph nodes with page-script edges, linked only from
  // browser-spec code. Every node added here is a leaf, so no new path through the graph can appear.
  const literal = /["'`]([^"'`\s$]*\.(?:mdx?|json|txt|tsv|csv|png|jpe?g|gif|webp|svg|ico|webm|mp4|woff2?|ttf|webmanifest))(?:[?#][^"'`]*)?["'`]/g;
  for (const [from, text] of texts) {
    if (typeof text !== "string") continue;
    const dir = from.split("/").slice(0, -1), out = edges.get(from) ?? new Set();
    edges.set(from, out);
    for (const [, ref] of text.matchAll(literal)) {
      const targets = new Set();
      if (ref.startsWith("./") || ref.startsWith("../")) targets.add(normalize([...dir, ...ref.split("/")]));
      else if (ref.startsWith("/")) for (const root of ["apps/web/public", "apps/web"]) targets.add(normalize([...root.split("/"), ...ref.split("/")]));
      else if (ref.includes("/")) for (let depth = dir.length; depth >= 0; depth -= 1) targets.add(normalize([...dir.slice(0, depth), ...ref.split("/")]));
      else for (const path of byBase.get(`${packageRoot(from)}${ref}`) ?? []) targets.add(path);
      for (const target of targets) if (target && data.has(target)) out.add(target);
    }
  }
  // Playwright stores a spec's screenshots under `<spec>-snapshots/`; the spec depends on all of them.
  for (const path of data) {
    const spec = path.match(/^(apps\/web\/e2e\/.+\.(?:spec|test)\.[cm]?[jt]sx?)-snapshots\//)?.[1];
    if (spec && edges.has(spec)) edges.get(spec).add(path);
  }
  // `base` keeps v2's own graph, so every outcome v3 inherits from v2 is v2's exactly.
  return { ...graph, edges, base: graph.base ?? graph };
}

const referenced = (graph, path) => [...graph.edges].some(([from, list]) => from !== path && list.has(path));

/**
 * Select inventory rows for v3. `graph` must already include data edges (`withDataEdges`).
 * Every result is a subset of v2's selection for the same inputs, and equals it when no changed
 * path is relaxed. No author, label or PR-prose input exists.
 */
export function selectFilesV3({ diff, inventory, graph }) {
  // v2 runs on its own graph: data nodes must not change any outcome v3 inherits from it.
  const v2 = selectFilesV2({ diff, inventory, graph: graph ? graph.base ?? graph : graph });
  const keep = (reason) => ({ ...v2, v2Mode: v2.mode, relaxed: [], relaxedClasses: {}, v3Reason: reason });
  const entries = Array.isArray(diff?.entries) ? diff.entries : [];
  const whole = selectGroups(diff);
  if (whole.reasons.some((reason) => DIFF_LEVEL.includes(reason))) return keep("diff-level-fallback");
  const relaxed = entries.filter((entry) => relaxedClass(entry.path)), other = entries.filter((entry) => !relaxedClass(entry.path));
  if (!relaxed.length) return keep("no-relaxed-path");
  const full = (reason) => ({ ...v2, mode: "full", reasons: [...new Set([...v2.reasons, reason])].sort(), v2Mode: v2.mode,
    groups: Object.keys(GROUPS).sort(), partialGroups: [], selectionReasons: {}, scopedOpaqueDeferred: 0, relaxed: [], relaxedClasses: {},
    v3Reason: reason, selectedFiles: inventory.map((row) => row.file) });
  if (!graph) return full("graph-unavailable");
  const classes = {};
  for (const { path } of relaxed) {
    const kind = relaxedClass(path);
    classes[kind] = (classes[kind] ?? 0) + 1;
    if (!graph.edges.has(path)) return full("graph-missing-changed-file");
    if (kind === "data-or-asset" && !referenced(graph, path)) return full("unreferenced-data-or-asset");
  }
  // Non-relaxed paths keep every v1 rule, including cross-package and all risk fallbacks.
  const rest = other.length ? selectGroups({ entries: other }) : selectGroups({ entries: [{ path: FAST_PROSE_FILES[0], status: "M" }] });
  if (rest.mode === "full") return keep("retained-fallback");
  if (other.some(({ path }) => !graph.edges.has(path))) return full("graph-missing-changed-file");
  const groups = [...new Set([...rest.groups, ...NARROWED_GROUPS,
    ...(relaxed.some(({ path }) => path.startsWith("apps/")) ? ["windows-baselines"] : [])])].sort();
  // A relaxed path outside any workspace package (docs/, root Markdown) may be read by a test that
  // enumerates directories from any package, so every opaque file is in scope for it.
  const anyScope = relaxed.some(({ path }) => !packageRoot(path)) ? [...new Set([...graph.edges.keys()].map(packageRoot).filter(Boolean))].map((root) => `${root}\0scope`) : [];
  const narrowed = narrow({ changed: [...entries.map((entry) => entry.path), ...anyScope], inventory, graph, groups });
  return { ...rest, mode: "affected", v1Mode: whole.mode, v2Mode: v2.mode, reasons: [], risks: whole.risks, groups,
    partialGroups: NARROWED_GROUPS.filter((group) => inventory.some((row) => row.group === group && !narrowed.selectedFiles.includes(row.file))),
    selectionReasons: narrowed.selectionReasons, scopedOpaqueDeferred: narrowed.scopedOpaqueDeferred,
    relaxed: relaxed.map((entry) => entry.path).sort(), relaxedClasses: classes, v3Reason: "relaxed-low-risk",
    selectedFiles: narrowed.selectedFiles };
}
