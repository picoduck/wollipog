/**
 * Parse the dashboard machine's ~/.ssh/config into a list of connectable hosts, so "Add a box" can
 * offer them for import. Read-only + best-effort: we surface concrete `Host` aliases (wildcard
 * patterns excluded) with their HostName / User / Port. `Match` blocks and `Include` directives are
 * ignored for now (noted in docs/product-gaps.md if we want to follow includes later).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SshConfigHost } from "@wollipog/protocol";

/** Pure parser (exported for tests). */
export function parseSshConfig(content: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: { aliases: string[]; hostName?: string; user?: string; port?: number } | null = null;

  const flush = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      if (/[*?!]/.test(alias)) continue; // skip wildcard/negated patterns — not a single host to add
      hosts.push({ host: alias, hostName: current.hostName, user: current.user, port: current.port });
    }
    current = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // SSH config is `Keyword value` or `Keyword=value`, keyword case-insensitive.
    const m = line.match(/^(\w+)[=\s]+(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "host") {
      flush();
      current = { aliases: value.split(/\s+/).filter(Boolean) };
    } else if (key === "match") {
      flush(); // Match has no static host to import
    } else if (current) {
      // First value wins (matches ssh's first-obtained-value semantics).
      if (key === "hostname" && current.hostName == null) current.hostName = value;
      else if (key === "user" && current.user == null) current.user = value;
      else if (key === "port" && current.port == null) {
        const p = Number.parseInt(value, 10);
        if (Number.isInteger(p) && p >= 1 && p <= 65535) current.port = p;
      }
    }
  }
  flush();

  // Dedup by alias (first occurrence wins).
  const seen = new Set<string>();
  return hosts.filter((h) => (seen.has(h.host) ? false : (seen.add(h.host), true)));
}

/** Read + parse ~/.ssh/config on this (dashboard) machine; [] if absent/unreadable. */
export function readSshConfigHosts(): SshConfigHost[] {
  try {
    return parseSshConfig(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
  } catch {
    return [];
  }
}
