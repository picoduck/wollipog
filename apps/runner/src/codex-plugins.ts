import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, symlinkSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify, type TomlTable, type TomlValue } from "smol-toml";
import type { AgentContext } from "@wollipog/protocol";
import type { SpawnIsolation } from "./spawn.js";

function table(value: TomlValue | undefined): TomlTable {
  return value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? value as TomlTable : {};
}

function config(home: string, scope: "default" | "account"): TomlTable {
  try {
    return parse(readFileSync(join(home, "config.toml"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // TOML errors include source lines, which may contain credentials.
    throw new Error(`Codex plugin inheritance could not read the ${scope} config.toml.`);
  }
}

function entries(path: string): string[] {
  try { return readdirSync(path).filter((name) => !name.startsWith(".")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Only plugin payloads are linked. Plugin data, remote catalog/auth caches, credentials, and
 * transcripts belong to the selected account. Existing account installations always win. */
function linkPlugins(sourceHome: string, accountHome: string, installed: Set<string>): void {
  const sourceCache = join(sourceHome, "plugins/cache");
  const accountCache = join(accountHome, "plugins/cache");
  // Never follow an operator-owned parent link while adding or removing individual links.
  for (const path of [join(accountHome, "plugins"), accountCache]) {
    const info = stat(path);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) return;
  }
  for (const marketplace of new Set([...entries(sourceCache), ...entries(accountCache)])) {
    const sourceMarket = join(sourceCache, marketplace);
    const accountMarket = join(accountCache, marketplace);
    const marketInfo = stat(accountMarket);
    if (marketInfo && (!marketInfo.isDirectory() || marketInfo.isSymbolicLink())) continue;
    for (const plugin of new Set([...entries(sourceMarket), ...entries(accountMarket)])) {
      const source = join(sourceMarket, plugin);
      const target = join(accountMarket, plugin);
      const info = stat(target);
      const inherited = info?.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === source;
      const configured = installed.has(`${plugin}@${marketplace}`);
      if (inherited && (!configured || !existsSync(source))) {
        unlinkSync(target);
      } else if (!info && configured && existsSync(source) && lstatSync(source).isDirectory()) {
        mkdirSync(accountMarket, { recursive: true, mode: 0o700 });
        try { symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    }
  }
}

function literal(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(literal).join(", ")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${literal(item)}`).join(", ")}}`;
  }
  return stringify({ value }).replace(/^value\s*=\s*/u, "").trim();
}

/** An explicitly configured account subtree suppresses inheritance for that subtree. */
function overrides(defaults: TomlTable, account: TomlTable, path: string[] = []): string[] {
  // Codex's CLI splits paths on dots; TOML quoting does not escape a path component. Use an
  // inline table when a component cannot be represented, retaining account-owned siblings.
  if (Object.keys(defaults).some((key) => /[.=]/u.test(key) && !Object.hasOwn(account, key))) {
    return [`${path.join(".")}=${literal({ ...defaults, ...account })}`];
  }
  const result: string[] = [];
  for (const [key, value] of Object.entries(defaults)) {
    if (Object.hasOwn(account, key)) continue;
    const next = [...path, key];
    const nested = table(value);
    if (Object.keys(nested).length) result.push(...overrides(nested, {}, next));
    else {
      result.push(`${next.join(".")}=${literal(value)}`);
    }
  }
  return result;
}

export interface CodexPluginLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  context: AgentContext;
  isolation?: SpawnIsolation;
  executionTarget?: { adapter: string };
}

/** Reconcile immediately before a native account launch, including resumed sessions. No user
 * config is rewritten, and explicit CLI overrides remain last so they retain precedence. */
export function inheritCodexPlugins(launch: CodexPluginLaunch): string[] {
  if (launch.context.kind !== "native" || launch.isolation?.backend === "container" ||
      launch.isolation?.backend === "cloud" ||
      (launch.executionTarget && launch.executionTarget.adapter !== "host")) return launch.args;
  const env = { ...process.env, ...launch.env };
  if (!env.CODEX_HOME || !isAbsolute(env.CODEX_HOME)) return launch.args;
  const sourceHome = resolve(env.HOME ?? env.USERPROFILE ?? homedir(), ".codex");
  const accountHome = resolve(env.CODEX_HOME);
  if (sourceHome === accountHome || (existsSync(sourceHome) && existsSync(accountHome) &&
      realpathSync(sourceHome) === realpathSync(accountHome))) return launch.args;
  const defaults = config(sourceHome, "default");
  const account = config(accountHome, "account");
  const inherited = [
    ...overrides(table(defaults.plugins), table(account.plugins), ["plugins"]),
    ...overrides(table(defaults.marketplaces), table(account.marketplaces), ["marketplaces"]),
    ...overrides(Object.fromEntries(Object.entries(table(defaults.features))
      .filter(([key]) => key === "plugins" || key === "remote_plugin")), table(account.features), ["features"]),
  ];
  try { linkPlugins(sourceHome, accountHome, new Set(Object.keys(table(defaults.plugins)))); }
  catch { throw new Error("Codex plugin inheritance could not reconcile the account plugin cache."); }
  // Node's bootstrap script must precede provider flags when the CLI is launched via node.
  const flags = inherited.flatMap((value) => ["-c", value]);
  let bootstrap = launch.args.length && /(?:^|[\\/])node(?:\.exe)?$/iu.test(launch.command) ? 1 : 0;
  // Package-manager flags belong to the launcher. Insert provider flags after the package name,
  // before the existing provider overrides, so npx does not interpret -c as its own --call flag.
  if (/(?:^|[\\/])(?:npx|npm|pnpm|bun)(?:\.cmd|\.exe)?$/iu.test(launch.command)) {
    const packageIndex = launch.args.findIndex((arg) => /^@openai\/codex(?:@[^/]+)?$/u.test(arg));
    if (packageIndex >= 0) bootstrap = packageIndex + 1;
  }
  return [...launch.args.slice(0, bootstrap), ...flags, ...launch.args.slice(bootstrap)];
}
