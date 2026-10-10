import { Buffer } from "node:buffer";
import { gzipSync, brotliCompressSync } from "node:zlib";
import type { Plugin } from "vite";

// Raw JavaScript required before the inbox can render, including every static dependency.
// #2768 baseline at 44ae566: 2,912,440 bytes. Vendor splitting cannot evade this budget.
export const INBOX_ENTRY_BUDGET_BYTES = 1_250_000;

interface Chunk {
  type: "chunk";
  fileName: string;
  code: string;
  imports: string[];
  dynamicImports: string[];
  modules: Record<string, unknown>;
}
type Bundle = Record<string, Chunk | { type: "asset" }>;

export function entryChunks(bundle: Bundle, entry: string): Chunk[] {
  const visited = new Set<string>();
  const chunks: Chunk[] = [];
  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const chunk = bundle[file];
    if (!chunk || chunk.type !== "chunk") throw new Error(`Missing static entry chunk: ${file}`);
    chunks.push(chunk);
    for (const dependency of chunk.imports) visit(dependency);
  }
  visit(entry);
  return chunks;
}

export function assertEntryBudget(chunks: readonly Pick<Chunk, "code">[], budget = INBOX_ENTRY_BUDGET_BYTES): number {
  const bytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0);
  if (bytes > budget) {
    throw new Error(`Inbox entry requires ${bytes.toLocaleString()} raw JavaScript bytes; budget is ${budget.toLocaleString()}. Keep secondary surfaces lazy.`);
  }
  return bytes;
}

/** Runs in browser and packaged desktop builds; fixture-only builds have no application entry. */
export function inboxEntryBudget(): Plugin {
  return {
    name: "wollipog-inbox-entry-budget",
    apply: "build",
    // Vite's preload analysis rewrites chunk code during generateBundle. Measure its final bytes.
    generateBundle: { order: "post", handler(_options, bundle) {
      const entry = Object.values(bundle).find((item) => item.type === "chunk" &&
        item.isEntry && item.facadeModuleId?.replaceAll("\\", "/").endsWith("/index.html"));
      if (!entry || entry.type !== "chunk") return;
      const chunks = entryChunks(bundle, entry.fileName);
      const rawBytes = assertEntryBudget(chunks);
      const modules = chunks.flatMap((chunk) => Object.keys(chunk.modules).map((id) => id.replaceAll("\\", "/")));
      const deferred = ["/components/SessionDetail.tsx", "/components/ShellTerminal.tsx", "/components/RunnersView.tsx",
        "/components/SettingsView.tsx", "/components/NewSessionDialog.tsx", "/components/PeopleDevicesPanel.tsx"];
      for (const path of deferred) {
        if (modules.some((id) => id.endsWith(path))) this.error(`${path} is eagerly loaded by the inbox entry.`);
      }
      if (modules.some((id) => id.includes("/@xterm/"))) this.error("xterm is eagerly loaded by the inbox entry.");
      const metrics = chunks.map((chunk) => ({ file: chunk.fileName, rawBytes: Buffer.byteLength(chunk.code),
        gzipBytes: gzipSync(chunk.code, { level: 9 }).length, brotliBytes: brotliCompressSync(chunk.code).length }));
      this.emitFile({ type: "asset", fileName: "entry-bundle-report.json", source: JSON.stringify({
        budgetBytes: INBOX_ENTRY_BUDGET_BYTES, rawBytes, chunks: metrics,
      }, null, 2) + "\n" });
      this.info(`Inbox entry budget: ${rawBytes.toLocaleString()} / ${INBOX_ENTRY_BUDGET_BYTES.toLocaleString()} raw bytes (${chunks.length} static chunks).`);
    } },
  };
}
