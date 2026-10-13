import React from "react";
import { createRoot } from "react-dom/client";
import {
  AboutPanel,
  AppearancePanel,
  BehaviorPanel,
  ExperimentalPanel,
  NavigationRailPanel,
  NetworkPanel,
  NotificationsPanel,
  SettingsView,
} from "../components/SettingsView.js";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, type AgentHarnessDefaultConfig, type AgentHarnessDefaultsView } from "@wollipog/protocol";
import { AgentDefaultsPanel } from "../components/AgentDefaultsPanel.js";
import { OrchestratorSettingsPanel } from "../components/OrchestratorSettingsPanel.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { interceptLeave } from "../leave-guard.js";
import { SettingsGroup, StaticRow } from "../components/ui/SettingsRows.js";
import { RowKinds } from "./setting-row-kinds.js";
import { ApprovalsPanel } from "../components/ApprovalsPanel.js";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import type { DesktopUpdateSetting, DesktopUpdateStatus } from "../desktop-updates.js";
import { DEFAULT_EXPERIMENT_FLAGS } from "../experiments.js";
import {
  COLOR_SCHEMES,
  DENSITY_OPTIONS,
  THEME_OPTIONS,
  applySchemeToDocument,
  parseColorScheme,
  type ColorScheme,
} from "../theme.js";
import { SETTINGS_SECTIONS, viewFromPath, viewPath, type SettingsSection, type View } from "../navigation.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import type { TailnetAccessSetting } from "../tailnet-access.js";
import "../styles.css";

/**
 * Settings as App.tsx actually builds it, in a state chosen by the URL.
 *
 * Mounting the row primitives standalone was not enough: a rule scoped to a wrapper the fixture
 * omitted would break the affordance in production while never matching here, and the contrast
 * measurement was wrong for the same reason, sampling the body background rather than the surface
 * the controls actually sit on.
 *
 * Review then found the same class of hole one level down. It is not enough to reproduce the
 * ANCESTORS; sibling position matters too, because `:last-child` and `:only-child` are ordinary
 * selectors. An earlier fixture put its busy switch third of four and Keyboard Shortcuts first of
 * two, so `.ui-row-switch.is-busy:last-child .ui-switch { opacity: 0 }` and
 * `.ui-row-nav:only-child .ui-row-chevron { opacity: 0 }` each erased a real production affordance
 * while every assertion here stayed green.
 *
 * And then it found the hole this file itself was: the fixture went on rendering a `Modal`, a
 * `.settings-dialog`, a Done button and the old four-section topology for a whole round after
 * Settings became a ROUTE. It reproduced a screen that no longer existed, so any route-layout
 * regression could ship with the suite green.
 *
 * The fix is structural rather than another careful copy: the harness imports the SAME panel
 * components the shell renders, so there is no second description of the topology to drift out of
 * step. What stays fixture-specific is only what the shell holds state for — the push and tailnet
 * settings, which are props precisely so that both callers can supply them.
 */

const STATES = ["rest", "busy-on", "busy-off", "disabled"] as const;
type State = (typeof STATES)[number];

/**
 * Production's rows are conditional, so "the" topology is a set of them.
 *
 * `NotifyRow` returns null when notifications are unsupported, `PushRow` when push is unavailable
 * (which includes Tauri), and the Tailnet switch is replaced by a disabled explanation when
 * Tailscale is absent. A fixture that always renders both notification switches and always the live
 * Tailnet row still misses `.settings-options > .ui-row-switch:only-child .ui-switch
 * { opacity: 0 }`, which erases Desktop Alerts wherever push is unavailable.
 *
 * `minimal` is the permutation that makes those match: one notification row, and Network in its
 * unavailable form.
 */
const TOPOLOGIES = ["full", "minimal"] as const;
type Topology = (typeof TOPOLOGIES)[number];

/**
 * Settings › Network's Tailnet Access in each state the desktop shell can report (#3027), or
 * `browser`, where there is no desktop shell and so no Tailnet group. Without `tailnet`, the row
 * follows `state` and `topology` as every other row does.
 */
const TAILNET_STATES = [
  "browser", "off", "on", "restarting", "unavailable", "unmanaged", "checking", "read-failed", "write-failed",
] as const;
type TailnetState = (typeof TAILNET_STATES)[number];

function tailnetFixture(state: TailnetState): TailnetAccessSetting {
  const base: TailnetAccessSetting = {
    status: { available: true, enabled: false, managed: true },
    loading: false,
    desktop: true,
    busy: false,
    error: null,
    toggle: () => undefined,
    retry: () => undefined,
  };
  switch (state) {
    case "browser": return { ...base, status: null, desktop: false };
    case "off": return base;
    case "on": return { ...base, status: { available: true, enabled: true, managed: true } };
    case "restarting": return { ...base, busy: true };
    case "unavailable": return { ...base, status: { available: false, enabled: false, managed: true } };
    case "unmanaged": return { ...base, status: { available: true, enabled: false, managed: false } };
    case "checking": return { ...base, status: null, loading: true };
    case "read-failed": return { ...base, status: null, error: "The desktop shell did not answer." };
    case "write-failed": return {
      ...base,
      error: "Tailscale refused the change. Check that the Tailscale app is running, then try again.",
    };
  }
}

/** The desktop app connected to a saved remote server, with Connections › Instances available. */
const desktopInstances: InstanceManager = {
  ...browserInstanceManager,
  desktopMultiInstance: true,
  activeProfile: {
    id: "studio",
    serverInstanceId: "studio",
    kind: "remote",
    label: "Home Studio",
    origin: "https://studio.example.ts.net",
    createdAt: "",
  },
};

const harnessDefaultsView: AgentHarnessDefaultsView = {
  defaults: [
    {
      agentId: "codex",
      driver: "codex-app-server",
      context: { kind: "native" },
      name: "Codex App Server",
      installations: [{
        runnerId: "fixture-runner",
        machineName: "Build Machine",
        online: true,
        models: [
          { id: "luna", displayName: "Luna", efforts: ["low", "high"] },
          { id: "sol", displayName: "Sol", efforts: ["high", "xhigh"] },
        ],
        effortLevels: ["low", "high", "xhigh"],
        permissionModes: ["auto-review", "danger-full-access"],
      }],
      preference: { model: "luna", effort: "low", permissionMode: "auto-review" },
      compatibleInstallations: 1,
    },
    {
      agentId: "claude-code",
      driver: "claude-code",
      context: { kind: "native" },
      name: "Claude Code",
      installations: [{
        runnerId: "fixture-runner",
        machineName: "Build Machine",
        online: true,
        models: [{ id: "opus", displayName: "Opus", efforts: ["high"] }],
        effortLevels: ["high"],
        permissionModes: ["auto", "plan"],
      }],
      compatibleInstallations: 1,
    },
    {
      // Nothing to choose: the row says Not Configurable instead of offering Edit… (#3024).
      agentId: "fixture-acp",
      driver: "acp",
      context: { kind: "native" },
      name: "Fixture ACP Agent",
      installations: [{
        runnerId: "fixture-runner",
        machineName: "Build Machine",
        online: true,
        models: [],
        effortLevels: [],
        permissionModes: [],
      }],
      compatibleInstallations: 1,
    },
  ],
};

/** What a save or reset leaves on the server, for the page's life, so the row reads it back. */
let harnessDefaultsState = structuredClone(harnessDefaultsView);

const harnessDefaultsRepairedView = structuredClone(harnessDefaultsView);
harnessDefaultsRepairedView.defaults[0]!.installations[0]!.models = [
  { id: "luna", displayName: "Luna", efforts: ["low"] },
];
harnessDefaultsRepairedView.defaults[0]!.installations[0]!.effortLevels = ["low"];

/** Behavior › Evidence's preference, kept for the page's life so a saved change reads back. */
let artifactUploadPreference = "manual";
/** What a save in Settings › Orchestrator stored, for as long as the page is open. */
let orchestratorSaved: typeof DEFAULT_ORCHESTRATOR_DEFAULTS | null = null;

const harnessDefaultsTransport: ApiTransport = {
  instanceId: "settings-fixture",
  publicOrigin: window.location.origin,
  close() {},
  async request(path, init) {
    // Behavior › Evidence (#3023). Unstubbed, the read fell through to the agent defaults below and
    // every Behavior capture showed a load failure. `artifact=save-fails` makes a change fail the way
    // a dropped connection does, for the danger notice and its Retry.
    if (path === "/api/artifact-upload-settings") {
      if (init?.method === "PUT") {
        if (new URLSearchParams(window.location.search).get("artifact") === "save-fails") throw new TypeError("Failed to fetch");
        artifactUploadPreference = (JSON.parse(String(init.body)) as { preference: string }).preference;
      }
      return Response.json({ preference: artifactUploadPreference });
    }
    if (path === "/api/instance") {
      return new Response(JSON.stringify({
        service: "wollipog-control-plane",
        instanceId: "00000000-0000-4000-8000-000000000000",
        displayName: "Settings Fixture",
        apiVersion: 1,
        appVersion: "0.27.0",
        capabilities: ["remote-instance-v1"],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Settings › Approvals: one starter turned on and the built-in tool policy (#2158).
    if (path === "/api/governance/policies") {
      return Response.json({ policies: [
        {
          policyId: "questions:review:fixture-user", name: "Review Sharing and Retries", effect: "allow", priority: 0,
          enabled: true, ownerUserId: "fixture-user", scope: { organizationId: "fixture-org" },
          questionRule: { starterCategory: "review", questionPattern: "*?", answer: { text: "Yes." } }, createdAt: 1, updatedAt: 2,
        },
        {
          policyId: "builtin:session-spawn-human-gate", name: "Review Agent-Created Sessions", effect: "ask",
          priority: -1_000_000, enabled: true, builtin: true, scope: { toolName: "wollipog.create_session" }, createdAt: 0, updatedAt: 0,
        },
      ] });
    }
    if (path === "/api/identity") return Response.json({ context: { userId: "fixture-user", organizationId: "fixture-org" } });
    if (path === "/api/orchestrator-settings") {
      const params = new URLSearchParams(window.location.search);
      const drifted = params.get("defaults") === "agent-repair";
      // `orchestrator=unavailable`: no machine advertises child capabilities (#3026's warning);
      // `orchestrator=save-fails`: every save is refused, for the save bar's error state.
      const mode = params.get("orchestrator");
      if (init?.method === "PUT") {
        if (mode === "save-fails") {
          return new Response(JSON.stringify({ error: "Wollipog couldn't store your defaults. Try again in a moment." }),
            { status: 503, headers: { "content-type": "application/json" } });
        }
        orchestratorSaved = (JSON.parse(String(init.body)) as { defaults: typeof DEFAULT_ORCHESTRATOR_DEFAULTS }).defaults;
      }
      const defaults = orchestratorSaved ? structuredClone(orchestratorSaved) : structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
      if (drifted) defaults.behavior.childModel = "retired-model";
      if (mode === "unavailable") {
        return new Response(JSON.stringify({
          defaults,
          source: orchestratorSaved ? "user_default" : "system_default",
          capabilities: {
            harnesses: [], models: [], effortLevels: [], supportedPairs: [],
            installations: 0, compatibleInstallations: 0, status: "unavailable",
            reason: "No current Agent Harness installation advertises child model and effort capabilities. Connect or update a runner, then retry.",
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        defaults,
        source: orchestratorSaved || drifted ? "user_default" : "system_default",
        capabilities: {
          harnesses: [{
            agentId: "codex-app-server",
            driver: "codex-app-server",
            context: { kind: "native" },
            name: "Codex App Server",
            models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"] }],
            effortLevels: ["low", "high"],
            supportedPairs: [{ modelId: "gpt-5.6-sol", effortLevels: ["low", "high"] }],
            installations: 1,
          }],
          models: [{ id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", efforts: ["low", "high"] }],
          effortLevels: ["low", "high"],
          installations: 1,
          compatibleInstallations: drifted ? 0 : 1,
          status: drifted ? "unavailable" : "available",
          ...(drifted ? { reason: "The saved fixed Child Model is unavailable. Choose Automatic or update a runner." } : {}),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const mode = new URLSearchParams(window.location.search).get("defaults");
    if (mode === "agent-missing") {
      return new Response(JSON.stringify({ error: "Not Found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      });
    }
    // `agent-loading` never answers, for the skeleton rows; `agent-empty` has no agents.
    if (mode === "agent-loading") return new Promise<Response>(() => undefined);
    if (mode === "agent-empty") return Response.json({ defaults: [] });
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      // `agent-save-fails` refuses a save the way an overloaded server does.
      if (mode === "agent-save-fails") {
        return Response.json({ error: "agent harness default update failed: database is locked" }, { status: 503 });
      }
      const request = JSON.parse(String(init?.body ?? "{}")) as { agentId: string; config?: AgentHarnessDefaultConfig };
      harnessDefaultsState = structuredClone(harnessDefaultsState);
      for (const option of harnessDefaultsState.defaults) {
        if (option.agentId !== request.agentId) continue;
        if (method === "PUT" && request.config) option.preference = request.config;
        else delete option.preference;
      }
    }
    const body = mode === "agent-repair" && window.location.hash === "#repair"
      ? harnessDefaultsRepairedView
      : harnessDefaultsState;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
};
const harnessDefaultsApi = createApiClient(harnessDefaultsTransport);

/**
 * #1646's desktop update states, injected the way the shell's hook would report them. Absent, the
 * About panel renders as it does in a browser.
 */
const UPDATE_STATES = ["current", "available", "release-page", "disabled", "unchecked"] as const;
type UpdateState = (typeof UPDATE_STATES)[number];

function updateFixture(state: UpdateState | null): DesktopUpdateSetting | undefined {
  if (!state) return undefined;
  const available = {
    state: "available" as const,
    version: "0.28.0",
    releaseUrl: "https://github.com/picoduck/wollipog/releases/tag/v0.28.0",
    checkedAt: Date.UTC(2026, 8, 23, 16, 5),
  };
  const status: DesktopUpdateStatus = {
    currentVersion: "0.27.0",
    install: state === "release-page"
      ? { mode: "releasePage", reason: "This app was installed from a .deb package. Install the new package from the release page." }
      : { mode: "inPlace" },
    automaticChecks: state !== "disabled",
    prereleaseUpdates: false,
    checksAllowed: state !== "disabled",
    releasesUrl: "https://github.com/picoduck/wollipog/releases",
    lastCheck: state === "current"
      ? { state: "current", checkedAt: Date.UTC(2026, 8, 23, 16, 5) }
      : state === "unchecked" || state === "disabled" ? null : available,
  };
  return {
    desktop: true,
    status,
    loading: false,
    checking: false,
    installing: false,
    savingAutomatic: false,
    savingPrerelease: false,
    error: null,
    check: () => undefined,
    install: () => undefined,
    openRelease: () => undefined,
    toggleAutomatic: () => undefined,
    togglePrerelease: () => undefined,
  };
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  // Selected by query string rather than by a control on the page: a control would sit inside the
  // hierarchy under test, and a reload per variant guarantees a clean, settled paint.
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const requested = params.get("state") as State | null;
  const state: State = requested && STATES.includes(requested) ? requested : "rest";
  const askedFor = params.get("topology") as Topology | null;
  const topology: Topology = askedFor && TOPOLOGIES.includes(askedFor) ? askedFor : "full";
  const requestedSection = params.get("section") as SettingsSection | null;
  const showAgentDefaults = ["agent", "agent-missing", "agent-repair", "agent-loading", "agent-empty", "agent-save-fails"]
    .includes(params.get("defaults") ?? "");
  const requestedUpdates = params.get("updates") as UpdateState | null;
  const update = updateFixture(requestedUpdates && UPDATE_STATES.includes(requestedUpdates) ? requestedUpdates : null);
  // `route` drives the frame itself (#3018): parsed as the shell parses the address, with links and
  // Back pushing the next one, so a phone's index and its section pages are real routes. Without
  // it, `section` picks a section directly.
  const [route, setRoute] = React.useState(() => params.get("route"));
  React.useEffect(() => {
    const onPop = () => setRoute(new URLSearchParams(window.location.search).get("route"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const routed = route === null ? null : viewFromPath(route);
  const navigate = (view: View) => {
    // As the store's navigate does: an editor with unsaved changes asks first (#3026).
    if (interceptLeave(() => navigate(view))) return;
    const next = new URLSearchParams(window.location.search);
    next.set("route", viewPath(view));
    window.history.pushState(null, "", `?${next}`);
    setRoute(viewPath(view));
  };
  const section: SettingsSection | undefined = routed?.name === "settings"
    ? routed.section
    : SETTINGS_SECTIONS.some((entry) => entry.id === requestedSection) ? requestedSection! : "appearance";
  // Notifications where the browser refuses alerts, or where neither kind can work (#3022).
  const alerts = params.get("alerts");
  // A failed Tailnet change: the error takes the row description's place (Settings › Network).
  const tailnetError = params.get("tailnet-error") === "1"
    ? "Tailscale refused the change. Check that the Tailscale app is running, then try again."
    : null;
  const askedTailnet = params.get("tailnet") as TailnetState | null;
  const tailnetState = askedTailnet && TAILNET_STATES.includes(askedTailnet) ? askedTailnet : null;
  // `multi` is the desktop app with more than one instance allowed, where Manage Instances shows.
  const instances = params.get("instances") === "multi" ? desktopInstances : browserInstanceManager;
  const schemes = params.get("copy") === "long"
    ? COLOR_SCHEMES.map((option) => ({
      ...option,
      description: `${option.description} — localized preview copy`,
    }))
    : COLOR_SCHEMES;
  document.documentElement.setAttribute("data-theme", theme);
  const kinds = params.get("view") === "kinds";
  const groupWidth = Number(params.get("group-width")) || null;

  const disabled = state === "disabled";
  const busy = state === "busy-on" || state === "busy-off";
  // The confirmed value, which is what a busy row must keep showing. Both directions are rendered
  // because they fail differently: announcing ON early is a lie about a subscription that does not
  // exist yet, announcing OFF early is a lie about one that is still live.
  const pushChecked = state === "busy-on" ? true : state === "busy-off" ? false : true;

  /*
   * The palette, as the shell actually renders it: committed unless something is being browsed.
   *
   * `onSchemePreview` was a no-op here, which made the one thing about this control that can leave
   * the WHOLE PAGE wrong invisible to every browser test — a dismissal that forgot to withdraw its
   * preview looked identical to one that did, because nothing was ever applied. The same
   * `applySchemeToDocument` the provider calls, so a stale palette is a stale `data-scheme` a test
   * can read, and the commit path moves the same attribute. Storage is deliberately not touched:
   * this fixture is about what the document shows.
   */
  const [scheme, setScheme] = React.useState<ColorScheme>("wollipog");
  const [previewScheme, setPreviewScheme] = React.useState<ColorScheme | null>(null);
  const [experimentFlags, setExperimentFlags] = React.useState(DEFAULT_EXPERIMENT_FLAGS);
  React.useLayoutEffect(() => {
    applySchemeToDocument(document, previewScheme ?? scheme);
  }, [previewScheme, scheme]);

  // Production's structure above the view: `.app` > `main.main` > `.main-body`. A rule scoped to
  // `.app > .main .settings-view` would break the real page while never matching a fixture rooted
  // at #root, which is the class of miss every earlier round of this file was fixing. Settings draws
  // its own page header (#1801), so there is no app-level top bar above it.
  return (
    <InstancesContextProvider value={instances}>
    <div className="app">
      <main className="main">
        <div className="main-body">
          <SettingsView
            section={section}
            onNavigate={navigate}
            panels={kinds ? Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry.id, groupWidth
              ? <div className="settings-panel" style={{ width: groupWidth }}><RowKinds /></div>
              : <RowKinds />])) as Record<SettingsSection, React.ReactNode> : {
              appearance: (
                <>
                <AppearancePanel
                  options={THEME_OPTIONS}
                  value="system"
                  disabled={disabled}
                  // A reason, because the disabled state is rendered here to be MEASURED: a faded
                  // group with nothing to say for itself is the state §11.3 forbids, and a harness
                  // that never passes one cannot tell whether the plumbing reaches the group.
                  disabledReason="Managed by your workspace administrator."
                  onChange={() => undefined}
                  schemes={schemes}
                  scheme={scheme}
                  onSchemeChange={(value) => setScheme(parseColorScheme(value))}
                  onSchemePreview={(value) => setPreviewScheme(value === null ? null : parseColorScheme(value))}
                  resolvedTheme={theme}
                  densities={DENSITY_OPTIONS}
                  density="compact"
                  onDensityChange={() => undefined}
                />
                {/* With the rail editor after it, as the shell composes the section. */}
                <NavigationRailPanel />
                </>
              ),
              // The PRODUCTION panel, given injected state. The fixture used to copy two SwitchRows
              // that looked like its rows, and a copy is a second description of the topology —
              // the exact drift this file was rebuilt to remove, one level down.
              notifications: (
                <NotificationsPanel
                  notify={{
                    supported: alerts !== "unavailable",
                    on: false,
                    permission: alerts === "blocked" ? "denied" : "default",
                    toggle: () => undefined,
                    recheck: () => undefined,
                  }}
                  push={topology === "full" && alerts !== "unavailable"
                    ? { state: busy ? "busy" : "on", confirmed: pushChecked, toggle: async () => undefined }
                    : { state: "unavailable", confirmed: false, toggle: async () => undefined }}
                  disabled={disabled}
                />
              ),
              // Both slots are always filled, as the shell fills them; the fixture rows stand in for
              // panels that need a control plane.
              behavior: (
                <ApiProvider client={harnessDefaultsApi}>
                  <BehaviorPanel
                    agentHarnessDefaults={showAgentDefaults ? <AgentDefaultsPanel onOpenConnections={() => undefined} /> : (
                      <SettingsGroup title="Agent Defaults" scope="Your Account">
                        <StaticRow
                          title="Default Models, Efforts, and Permissions"
                          description="The visual fixture does not load agent defaults."
                        />
                      </SettingsGroup>
                    )}
                    sessionNaming={(
                      <StaticRow title="Session Naming" description="The visual fixture does not connect to a control plane." />
                    )}
                    onOpenShortcuts={() => undefined}
                  />
                </ApiProvider>
              ),
              approvals: (
                <ApiProvider client={harnessDefaultsApi}>
                  <ApprovalsPanel policyId={routed?.name === "settings" ? routed.policyId : undefined} />
                </ApiProvider>
              ),
              // With the confirmation provider its leave prompt opens in, as the shell has.
              orchestrator: (
                <FeedbackProvider>
                  <ApiProvider client={harnessDefaultsApi}><OrchestratorSettingsPanel /></ApiProvider>
                </FeedbackProvider>
              ),
              network: (
                <NetworkPanel
                  tailnet={tailnetState ? tailnetFixture(tailnetState) : {
                    // `managed: false` is how production reaches a DISABLED tailnet switch: another
                    // Wollipog server is using the port, so the row renders and cannot be operated.
                    // `minimal` is Tailscale missing, the other disabled form.
                    status: topology === "full"
                      ? { available: true, enabled: true, managed: !disabled }
                      : { available: false, enabled: false, managed: true },
                    loading: false,
                    desktop: true,
                    busy,
                    error: tailnetError,
                    toggle: () => undefined,
                    retry: () => undefined,
                  }}
                  onNavigate={navigate}
                />
              ),
              // The production panel with injected state, like Notifications above. Storage is
              // deliberately not touched.
              experimental: (
                <ExperimentalPanel
                  flags={experimentFlags}
                  onToggle={(id, enabled) => setExperimentFlags((current) => ({ ...current, [id]: enabled }))}
                />
              ),
              about: <ApiProvider client={harnessDefaultsApi}><AboutPanel update={update} /></ApiProvider>,
            }}
          />
        </div>
      </main>
    </div>
    </InstancesContextProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
