import type { ProviderAccountDefinition } from "@wollipog/protocol";
import { inheritClaudePlugins } from "./claude-plugins.js";
import { inheritCodexPlugins, type CodexPluginLaunch } from "./codex-plugins.js";

type Provider = ProviderAccountDefinition["provider"];
export type ProviderPluginLaunch = CodexPluginLaunch & { driver?: string };

// Exhaustive over registered account types: adding a provider requires choosing its plugin policy.
const inheritors: Record<Provider, (launch: ProviderPluginLaunch) => string[]> = {
  claude: inheritClaudePlugins,
  codex: inheritCodexPlugins,
};

export function pluginProviderForDriver(driver: string | undefined): Provider | undefined {
  if (driver === "claude-code") return "claude";
  if (driver === "codex" || driver === "codex-app-server") return "codex";
  return undefined;
}

export function inheritProviderPlugins(launch: ProviderPluginLaunch, provider = pluginProviderForDriver(launch.driver)): string[] {
  return provider ? inheritors[provider](launch) : launch.args;
}
