import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, symlinkSync, unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
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

function isCodexPackage(arg: string): boolean {
  const match = /^@openai\/codex(?:@([^/\\:\s]+))?$/u.exec(arg);
  const spec = match?.[1];
  // npm also interprets dot-prefixed names and bare archive names as local payloads.
  return !!match && (!spec || (!spec.startsWith(".") && !/\.(?:tgz|tar(?:\.gz)?)$/iu.test(spec)));
}

/** Recognize an argv grammar, never search arbitrary wrapper arguments for a package name. */
function providerBoundary(command: string, args: string[], allowEnv = true): number | undefined {
  const name = command.split(/[\\/]/u).at(-1)!.replace(/\.(?:exe|cmd|bat)$/iu, "").toLowerCase();
  if (name === "codex") return 0;
  if (name === "node") {
    let i = 0;
    while (["--no-warnings", "--enable-source-maps"].includes(args[i] ?? "")) i++;
    if (args[i] === "--") i++;
    return args[i] && !args[i]!.startsWith("-") ? i + 1 : undefined;
  }
  if (name === "env" && allowEnv) {
    let i = 0;
    while (args[i] === "-u" || args[i] === "--unset") {
      const variable = args[++i];
      // Account identity must be resolved from the same environment Codex will receive.
      if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable) ||
          ["HOME", "USERPROFILE", "CODEX_HOME"].includes(variable)) return undefined;
      i++;
    }
    if (args[i] === "--") i++;
    if (!args[i] || args[i]!.startsWith("-") || args[i]!.includes("=")) return undefined;
    const nested = providerBoundary(args[i]!, args.slice(i + 1), false);
    return nested === undefined ? undefined : i + 1 + nested;
  }
  const options: Record<string, string[]> = {
    npx: ["-y", "--yes", "--no", "--no-install", "--offline", "--ignore-scripts"],
    npm: ["-y", "--yes", "--no", "--offline", "--ignore-scripts"],
    pnpm: ["-s", "--silent"], pnpx: ["-s", "--silent"],
    yarn: ["-q", "--quiet"],
    bun: ["--bun", "--no-install", "--verbose", "--silent"],
    bunx: ["--bun", "--no-install", "--verbose", "--silent"],
  };
  if (!Object.hasOwn(options, name)) return undefined;
  let i = 0;
  if (name === "npm") {
    if (args[i] !== "exec" && args[i] !== "x") return undefined;
    i++;
  } else if (["pnpm", "yarn", "bun"].includes(name)) {
    if (args[i++] !== (name === "bun" ? "x" : "dlx")) return undefined;
  }
  let explicitPackage = false;
  while (args[i]?.startsWith("-") && args[i] !== "--") {
    const arg = args[i++]!;
    if (options[name]!.includes(arg)) continue;
    // --package selects an installation, not the executable/provider boundary.
    let pkg: string | undefined;
    if (arg === "--package" || (arg === "-p" && ["npx", "yarn", "bun", "bunx"].includes(name))) pkg = args[i++];
    else if (arg.startsWith("--package=")) pkg = arg.slice("--package=".length);
    if (!pkg || !isCodexPackage(pkg)) return undefined;
    explicitPackage = true;
  }
  // npm exec continues parsing options after positional arguments without this separator.
  if (name === "npm" && args[i] !== "--") return undefined;
  if (args[i] === "--") i++;
  return (explicitPackage ? args[i] === "codex" : isCodexPackage(args[i] ?? ""))
    ? i + 1 : undefined;
}

/** Retain only the validated launcher prefix, dropping session-specific Codex arguments. */
export function codexLauncherBootstrap(command: string, args: string[]): string[] {
  const boundary = providerBoundary(command, args);
  if (boundary === undefined) {
    // Diagnostics must not disclose operator-owned paths, argv, or configuration content.
    throw new Error("Codex sign-in could not identify a supported launcher form. " +
      "Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.");
  }
  return args.slice(0, boundary);
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
  const sourceMarkets = table(defaults.marketplaces);
  const accountMarkets = table(account.marketplaces);
  // A marketplace alias can name different repositories in the default and account homes.
  // Keep payload provenance aligned with the account's explicit marketplace definition.
  const plugins = Object.fromEntries(Object.entries(table(defaults.plugins)).filter(([id]) => {
    const marketplace = id.slice(id.lastIndexOf("@") + 1);
    return !Object.hasOwn(accountMarkets, marketplace) ||
      isDeepStrictEqual(accountMarkets[marketplace], sourceMarkets[marketplace]);
  }));
  const inherited = [
    ...overrides(plugins, table(account.plugins), ["plugins"]),
    ...overrides(table(defaults.marketplaces), table(account.marketplaces), ["marketplaces"]),
    ...overrides(Object.fromEntries(Object.entries(table(defaults.features))
      .filter(([key]) => key === "plugins" || key === "remote_plugin")), table(account.features), ["features"]),
  ];
  const flags = inherited.flatMap((value) => ["-c", value]);
  const bootstrap = flags.length ? providerBoundary(launch.command, launch.args) : 0;
  if (bootstrap === undefined) {
    // Do not include command paths, argv, environment values, or config content in diagnostics.
    throw new Error("Codex plugin inheritance could not identify a supported launcher form. " +
      "Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.");
  }
  try { linkPlugins(sourceHome, accountHome, new Set(Object.keys(plugins))); }
  catch { throw new Error("Codex plugin inheritance could not reconcile the account plugin cache."); }
  return [...launch.args.slice(0, bootstrap), ...flags, ...launch.args.slice(bootstrap)];
}
