import { createHash, randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CodexPluginLaunch } from "./codex-plugins.js";

type ObjectValue = Record<string, unknown>;
interface InstallRecord extends ObjectValue { scope: string; installPath: string; version?: string }
interface InheritedState {
  plugins: Record<string, InstallRecord>;
  enabledPlugins: ObjectValue;
  marketplaces: ObjectValue;
  extraKnownMarketplaces: ObjectValue;
}

function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function read(path: string): ObjectValue {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as ObjectValue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // JSON parse errors may quote source lines containing secrets.
    throw new Error("Claude plugin inheritance could not read plugin settings or installation records.");
  }
}

function write(path: string, value: ObjectValue, previous: ObjectValue): void {
  if (isDeepStrictEqual(value, previous)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function linked(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function records(registry: ObjectValue): Record<string, InstallRecord[]> {
  if (registry.version !== undefined && registry.version !== 2) {
    throw new Error("Claude plugin inheritance could not read this plugin registry version.");
  }
  const result: Record<string, InstallRecord[]> = {};
  for (const [id, value] of Object.entries(object(registry.plugins))) {
    if (!id.includes("@") || !Array.isArray(value) || value.some((record) => typeof record?.scope !== "string" ||
        typeof record?.installPath !== "string")) {
      throw new Error("Claude plugin inheritance could not read plugin installation records.");
    }
    Object.defineProperty(result, id, { value: value.slice(), enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Versioned cache copies keep source and account files independent. Installing a new version
 * leaves the previous version available; account-side uninstall never removes source files. */
function copyPlugin(sourceHome: string, accountHome: string, id: string, record: InstallRecord, marketplace = false,
  previouslyInherited?: unknown): InstallRecord | undefined {
  if (!isAbsolute(record.installPath) || !existsSync(record.installPath)) return undefined;
  const digest = createHash("sha256").update(JSON.stringify([sourceHome, id, record])).digest("hex");
  const parts = id.split("@");
  const version = record.version ?? "unknown";
  if (!marketplace && [...parts, version].some((part) => !part || part === "." || part === ".." || /[\\/]/u.test(part))) {
    throw new Error("invalid plugin cache path");
  }
  const cache = marketplace ? join(accountHome, "plugins/marketplaces/wollipog-inherited")
    : join(accountHome, "plugins/cache", parts[parts.length - 1]!, parts.slice(0, -1).join("@"));
  // The loader computes this conventional path rather than always trusting installPath.
  const target = join(cache, marketplace ? digest : version);
  if (!marketplace && (linked(dirname(cache)) || linked(cache))) throw new Error("linked plugin cache parent");
  if (linked(cache)) throw new Error("linked inherited cache");
  if (linked(target)) throw new Error("linked inherited plugin");
  const inherited = { ...record, installPath: target };
  if (!existsSync(target) || (previouslyInherited && !isDeepStrictEqual(previouslyInherited, inherited))) {
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const temporary = join(cache, `.${randomUUID()}.tmp`);
    try {
      cpSync(realpathSync(record.installPath), temporary, { recursive: true, verbatimSymlinks: true });
      if (existsSync(target)) {
        const orphan = join(cache, `.${randomUUID()}.old`);
        renameSync(target, orphan);
        try { renameSync(temporary, target); }
        catch (error) { renameSync(orphan, target); throw error; }
        rmSync(orphan, { recursive: true, force: true });
      } else {
        renameSync(temporary, target);
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return inherited;
}

/** Inherit user-scope marketplace plugins at user settings precedence. Account settings,
 * project/local installs, auth, synced claude.ai plugins, and unrelated settings stay separate. */
export function inheritClaudePlugins(launch: CodexPluginLaunch): string[] {
  if (launch.context.kind !== "native" || launch.isolation?.backend === "container" ||
      launch.isolation?.backend === "cloud" ||
      (launch.executionTarget && launch.executionTarget.adapter !== "host")) return launch.args;
  const env = { ...process.env, ...launch.env };
  if (!env.CLAUDE_CONFIG_DIR || !isAbsolute(env.CLAUDE_CONFIG_DIR)) return launch.args;
  const sourceHome = resolve(env.HOME ?? env.USERPROFILE ?? homedir(), ".claude");
  const accountHome = resolve(env.CLAUDE_CONFIG_DIR);
  if (sourceHome === accountHome || (existsSync(sourceHome) && existsSync(accountHome) &&
      realpathSync(sourceHome) === realpathSync(accountHome))) return launch.args;
  const settingsPath = join(accountHome, "settings.json");
  const registryPath = join(accountHome, "plugins/installed_plugins.json");
  const marketplacesPath = join(accountHome, "plugins/known_marketplaces.json");
  const statePath = join(accountHome, "plugins/.wollipog-inherited-plugins.json");
  try {
    // Operator-owned links may point at another account or the default home. Never write through
    // them or replace them while reconciling an individual account.
    if ([settingsPath, registryPath, marketplacesPath, statePath, join(accountHome, "plugins"),
      join(accountHome, "plugins/cache"), join(accountHome, "plugins/marketplaces")].some(linked)) return launch.args;
    const defaults = read(join(sourceHome, "settings.json"));
    const sourceRegistry = read(join(sourceHome, "plugins/installed_plugins.json"));
    const sourceMarketplaces = read(join(sourceHome, "plugins/known_marketplaces.json"));
    const settings = read(settingsPath);
    const registry = read(registryPath);
    const marketplaces = read(marketplacesPath);
    const state = read(statePath);
    const next: InheritedState = { plugins: {}, enabledPlugins: {}, marketplaces: {}, extraKnownMarketplaces: {} };
    const knownMarketplaces = { ...marketplaces };
    for (const [name, value] of Object.entries(object(state.marketplaces))) {
      if (isDeepStrictEqual(knownMarketplaces[name], value)) delete knownMarketplaces[name];
    }
    const plugins = records(registry);
    const previousPlugins = object(state.plugins);
    for (const [id, record] of Object.entries(previousPlugins)) {
      const kept = (plugins[id] ?? []).filter((item) => !isDeepStrictEqual(item, record));
      if (kept.length) plugins[id] = kept;
      else delete plugins[id];
    }
    const accountPluginIds = new Set(Object.keys(plugins));
    for (const [id, installs] of Object.entries(records(sourceRegistry))) {
      // @synced is authorized and fetched by the currently signed-in Claude account. The other
      // reserved origins do not describe user-scope marketplace installations either.
      if (/@(?:synced|inline|skills-dir)$/u.test(id) || (plugins[id] ?? []).some((item) => item.scope === "user")) continue;
      const source = installs.find((item) => item.scope === "user");
      if (!source) continue;
      const marketName = id.slice(id.lastIndexOf("@") + 1);
      const market = object(sourceMarketplaces[marketName]);
      if (Object.hasOwn(knownMarketplaces, marketName) && !Object.hasOwn(next.marketplaces, marketName) &&
          !isDeepStrictEqual(object(knownMarketplaces[marketName]).source, market.source)) continue;
      if (!Object.hasOwn(knownMarketplaces, marketName) && typeof market.installLocation === "string") {
        const copied = copyPlugin(sourceHome, accountHome, `marketplace:${marketName}`, {
          ...market, scope: "user", installPath: market.installLocation,
        }, true);
        if (copied) {
          const descriptor = object(market.source);
          const inheritedMarket = { ...market, installLocation: copied.installPath,
            source: descriptor.source === "directory" ? { ...descriptor, path: copied.installPath } : descriptor,
            autoUpdate: false };
          knownMarketplaces[marketName] = inheritedMarket;
          next.marketplaces[marketName] = inheritedMarket;
        }
      }
      const inherited = copyPlugin(sourceHome, accountHome, id, source, false, previousPlugins[id]);
      if (!inherited) continue;
      plugins[id] = [...(plugins[id] ?? []), inherited];
      next.plugins[id] = inherited;
    }
    // A plugin installed independently in the account may still use a marketplace originally
    // supplied by inheritance. Removing the default plugin must not break that account install.
    for (const id of accountPluginIds) {
      const name = id.slice(id.lastIndexOf("@") + 1);
      const previous = object(state.marketplaces)[name];
      if (!Object.hasOwn(knownMarketplaces, name) && previous) {
        knownMarketplaces[name] = previous;
        next.marketplaces[name] = previous;
      }
    }
    const enabled = { ...object(settings.enabledPlugins) };
    const extraMarketplaces = { ...object(settings.extraKnownMarketplaces) };
    for (const [id, value] of Object.entries(object(state.enabledPlugins))) {
      if (!accountPluginIds.has(id) && isDeepStrictEqual(enabled[id], value)) delete enabled[id];
    }
    for (const [id, value] of Object.entries(object(defaults.enabledPlugins))) {
      if (/@(?:synced|inline|skills-dir)$/u.test(id) || typeof value !== "boolean" || Object.hasOwn(enabled, id) || !next.plugins[id]) continue;
      enabled[id] = value;
      next.enabledPlugins[id] = value;
    }
    for (const [name, value] of Object.entries(object(state.extraKnownMarketplaces))) {
      if (isDeepStrictEqual(extraMarketplaces[name], value)) delete extraMarketplaces[name];
    }
    for (const [name, market] of Object.entries(next.marketplaces)) {
      if (Object.hasOwn(extraMarketplaces, name)) continue;
      const inherited = { source: object(market).source, autoUpdate: false };
      extraMarketplaces[name] = inherited;
      next.extraKnownMarketplaces[name] = inherited;
    }
    const nextSettings = { ...settings };
    if (Object.keys(enabled).length || Object.hasOwn(settings, "enabledPlugins")) nextSettings.enabledPlugins = enabled;
    if (Object.keys(extraMarketplaces).length || Object.hasOwn(settings, "extraKnownMarketplaces")) nextSettings.extraKnownMarketplaces = extraMarketplaces;
    write(settingsPath, nextSettings, settings);
    if (Object.keys(knownMarketplaces).length || Object.keys(marketplaces).length) {
      write(marketplacesPath, knownMarketplaces, marketplaces);
    }
    if (Object.keys(plugins).length || Object.hasOwn(registry, "plugins")) {
      write(registryPath, { ...registry, version: 2, plugins }, registry);
    }
    if (Object.keys(next.plugins).length || Object.keys(state).length) {
      write(statePath, { version: 1, sourceHome, ...next }, state);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Claude plugin inheritance could not ")) throw error;
    throw new Error("Claude plugin inheritance could not reconcile the account plugin cache.");
  }
  return launch.args;
}
