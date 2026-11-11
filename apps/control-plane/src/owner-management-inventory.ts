import type { FastifyInstance } from "fastify";

export type OwnerOperationCoverage =
  | {tools: string[]}
  | {exclusion: "human_authority" | "external_limitation" | "interactive_workspace_io"; reason: string; remedy: string};
export interface OwnerParityGap {route: string; reason: string}

/** Observe actual Fastify registration, including routes generated in loops and shared services.
 * Source-string snapshots miss those routes and cannot prove that the production composition
 * registered a tool. No resource identifiers, request data, credentials or callbacks are observed. */
export class OwnerManagementInventory {
  private readonly routes = new Set<string>();
  attach(app: FastifyInstance): void {
    app.addHook("onRoute", route => {
      if (!/^\/api\/(?:sessions|projects|runners|automations|skills|skill-[\w-]+|orphaned-skill-copies|assistant-connections)(?:\/|$)/.test(route.url)) return;
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        if (method !== "HEAD" && method !== "OPTIONS") this.routes.add(`${method} ${route.url}`);
      }
    });
  }
  list(): string[] { return [...this.routes].sort(); }
  gaps(coverage: Readonly<Record<string, OwnerOperationCoverage>>, registeredTools: ReadonlySet<string>): OwnerParityGap[] {
    const gaps: OwnerParityGap[] = [];
    for (const route of this.list()) {
      const entry = coverage[route];
      if (!entry) { gaps.push({route, reason: "No Assistant operation or documented exclusion."}); continue; }
      if ("tools" in entry) {
        if (!entry.tools.length) gaps.push({route, reason: "Coverage must name an actual registered tool."});
        for (const tool of entry.tools) if (!registeredTools.has(tool)) gaps.push({route, reason: `Assistant operation ${tool} is not registered.`});
      } else if (!entry.reason.trim() || !entry.remedy.trim() || !["human_authority", "external_limitation", "interactive_workspace_io"].includes(entry.exclusion)) {
        gaps.push({route, reason: "Exclusions require human authority, a real external limitation, or defensible interactive workspace I/O, with a reason and supported remedy."});
      }
    }
    return gaps;
  }
  assertComplete(coverage: Readonly<Record<string, OwnerOperationCoverage>>, registeredTools: ReadonlySet<string>): void {
    const gaps = this.gaps(coverage, registeredTools);
    if (gaps.length) throw new Error(`Owner/Assistant parity is incomplete:\n${gaps.map(g => `${g.route}: ${g.reason}`).join("\n")}`);
  }
}
