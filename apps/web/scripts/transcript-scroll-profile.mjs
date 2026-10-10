import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createRequire } from "node:module";

// Use the source-map reader already installed for the web's pinned PostCSS dependency.
const require = createRequire(import.meta.url);
const { SourceMapConsumer } = createRequire(require.resolve("postcss/package.json"))("source-map-js");
const directory = resolve(process.argv[2]);
const consumers = new Map();
const sourcePosition = (frame) => {
  if (!frame.url || frame.lineNumber < 0) return null;
  const name = basename(frame.url);
  if (!consumers.has(name)) {
    try { consumers.set(name, new SourceMapConsumer(JSON.parse(readFileSync(resolve(directory, "dist/assets", `${name}.map`), "utf8")))); }
    catch { consumers.set(name, null); }
  }
  return consumers.get(name)?.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber }) ?? null;
};
const results = [];
for (const name of readdirSync(directory).filter(name => name.endsWith(".cpuprofile")).sort()) {
  const profile = JSON.parse(readFileSync(resolve(directory, name), "utf8"));
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(child => [child, node.id])));
  const positions = new Map(profile.nodes.map(node => [node.id, sourcePosition(node.callFrame)]));
  const self = new Map();
  const inclusive = { parserPipeline: 0, table: 0, cache: 0 };
  let total = 0;
  let idle = 0;
  for (const [index, id] of (profile.samples ?? []).entries()) {
    const time = profile.timeDeltas[index];
    total += time;
    if (nodes.get(id)?.callFrame.functionName === "(idle)") idle += time;
    const position = positions.get(id);
    const source = position?.source;
    const normalized = source?.includes("/apps/web/") ? `apps/web/${source.split("/apps/web/").at(-1)}`
      : source?.includes("/node_modules/") ? `node_modules/${source.split("/node_modules/").at(-1)}` : source;
    const key = normalized ? `${normalized}:${position.line}` : nodes.get(id)?.callFrame.functionName;
    self.set(key, (self.get(key) ?? 0) + time);
    const categories = new Set();
    for (let ancestor = id; ancestor != null; ancestor = parents.get(ancestor)) {
      const original = positions.get(ancestor);
      const source = original?.source ?? "";
      if (/micromark|mdast-util|remark-|react-markdown|unified/.test(source)) categories.add("parserPipeline");
      if (/components\/Markdown\.tsx$/.test(source) && original.line >= 179 && original.line <= 219) categories.add("table");
      if (/markdown-content-cache/.test(source)) categories.add("cache");
    }
    for (const category of categories) inclusive[category] += time;
  }
  results.push({ profile: name, totalMs: total / 1000, idleMs: idle / 1000,
    inclusivePercentOfSampledTime: Object.fromEntries(Object.entries(inclusive).map(([key, time]) => [key, 100 * time / total])),
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([location, time]) => ({ location, ms: time / 1000, percent: 100 * time / total })) });
}
writeFileSync(resolve(directory, "profile-summary.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
