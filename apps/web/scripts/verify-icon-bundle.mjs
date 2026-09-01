import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsPath = resolve(appRoot, "src/components/Icons.tsx");
const source = await readFile(iconsPath, "utf8");
const exports = [...source.matchAll(/export function (\w+Icon)\(/g)].map((match) => match[1]);
assert.ok(exports.length > 0, "the tree-shaking entry must find stable icon exports");
assert.equal(new Set(exports).size, exports.length, "stable icon export names must be unique");

const publicEntry = "virtual:wollipog-icon-contract";
const resolvedEntry = `\0${publicEntry}`;
const result = await build({
  root: appRoot,
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: true,
    target: ["chrome107", "edge107", "firefox104", "safari16"],
    rolldownOptions: { input: publicEntry },
  },
  plugins: [{
    name: "wollipog-icon-contract-entry",
    enforce: "pre",
    resolveId(id) {
      if (id === publicEntry) return resolvedEntry;
    },
    load(id) {
      if (id === resolvedEntry) {
        return [
          `import { ${exports.join(", ")} } from ${JSON.stringify(iconsPath)};`,
          `const icons = [${exports.join(", ")}];`,
          "globalThis.__WOLLIPOG_ICON_CONTRACT__ = icons.map((Icon) => Icon({ size: 16 }));",
        ].join("\n");
      }
    },
  }],
});

const outputs = Array.isArray(result) ? result : [result];
const chunks = outputs.flatMap((output) => output.output)
  .filter((item) => item.type === "chunk");
const code = chunks.map((chunk) => chunk.code).join("\n");
const bytes = Buffer.byteLength(code);

assert.ok(bytes > 10_000,
  `the icon contract emitted only ${bytes.toLocaleString()} bytes; its virtual entry was tree-shaken away`);
assert.ok(bytes < 125_000,
  `the complete icon entry is ${bytes.toLocaleString()} bytes; investigate a Lucide catalog or bundle regression`);
for (const unusedCatalogMarker of ["AArrowDown", "Accessibility", "AirVent", "AlarmClock"]) {
  assert.equal(code.includes(unusedCatalogMarker), false,
    `the icon bundle contains unused Lucide marker ${unusedCatalogMarker}; named-import tree shaking regressed`);
}

console.log(`Icon bundle contract passed: ${exports.length} exports in ${bytes.toLocaleString()} bytes.`);
