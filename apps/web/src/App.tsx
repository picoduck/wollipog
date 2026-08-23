import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { runnerCapabilityRequirement, runnerSupportsProtocol } from "@wollipog/protocol";
import { useStoreActions, useStoreSelector, type View } from "./store.js";
import { useApi } from "./api-context.js";
import { notifier } from "./notify.js";
import { CONTROL_PLANE_HTTP, CONTROL_PLANE_WS } from "./config.js";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken, parsePairingInput, storeDeviceToken } from "./device-token.js";
import {
  adoptManagedDesktopPairing,
  desktopLocalPairingFailure,
} from "./desktop-local-pairing.js";
import { createBrowserInstanceRuntime } from "./instance-runtime.js";
import { InstanceRuntimeHost } from "./InstanceRuntimeHost.js";
import { InstanceProvider, desktopMultiInstanceAvailable } from "./InstanceProvider.js";
import { useInstances } from "./instances-context.js";
import { disablePush, enablePush, pushAvailable, reconcilePushSubscription, type PushSetting } from "./push.js";
import { pickTopmost } from "./layers.js";
import { useIsMobile } from "./components/useIsMobile.js";
import { parseStoredDockVisible } from "./dock.js";
import { isInboxBlocked } from "./inbox.js";
import { Board } from "./components/Board.js";
import { RunnersView } from "./components/RunnersView.js";
import { RunsView, RunDetail } from "./components/RunsView.js";
import { InboxView } from "./components/InboxView.js";
import { ArchivedSessionsView } from "./components/ArchivedSessionsView.js";
import { NewSessionDialog, type NewSessionPreset } from "./components/NewSessionDialog.js";
import { NewRunDialog } from "./components/NewRunDialog.js";
import { NewPodDialog } from "./components/NewPodDialog.js";
import { PodDetail, PodsView } from "./components/PodsView.js";
import { AutomationsView } from "./components/AutomationsView.js";
import { UsageView } from "./components/UsageView.js";
import { ShellDock } from "./components/ShellDock.js";
import { useRightPanelState, type RightPanelState } from "./components/RightPanel.js";
import { EditorSelect } from "./components/EditorSelect.js";
import { DesktopCloseGuard } from "./components/DesktopCloseGuard.js";
import { DesktopExternalLinkRouter } from "./components/DesktopExternalLinkRouter.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ShortcutReference } from "./components/ShortcutReference.js";
import { SettingsTrigger } from "./components/SettingsTrigger.js";
import { useTheme } from "./components/ThemeProvider.js";
import {
  handleRovingChoiceKeyDown,
  rovingChoiceTabIndex,
} from "./components/interactions.js";
import { cycleFocusZone, escapeOwner } from "./focus-zones.js";
import { installTerminalExitBoundary } from "./terminal-focus.js";
import {
  isEditableShortcutTarget,
  matchesShortcut,
  shortcutDisplay,
  shortcutLayerActive,
} from "./shortcuts.js";
import { COLOR_SCHEMES, DENSITY_OPTIONS, THEME_OPTIONS, type ThemePreference } from "./theme.js";
import {
  loadBrowserStorageValue,
  removeBrowserStorageValue,
  saveBrowserStorageValue,
} from "./instance-storage.js";
import { FeedbackProvider } from "./components/FeedbackProvider.js";
import { Empty, Modal } from "./components/common.js";
import { DockBottomIcon, KeyboardIcon, LockIcon, PanelRightIcon, PinnedPanelIcon, PlusIcon, WarningTriangleIcon } from "./components/Icons.js";
import { NavRow, SwitchRow } from "./components/ui/SettingsRows.js";
import { viewPath, viewTitle } from "./navigation.js";
import { handleSettingsNavigationKey } from "./settings-navigation.js";
import { ProjectsView } from "./components/ProjectsView.js";
import { InstanceSelector } from "./components/InstanceSelector.js";
import { Rail } from "./components/Rail.js";
import { InstancesPanel } from "./components/InstancesPanel.js";
import { useNewSessionShortcut } from "./useNewSessionShortcut.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import {
  AboutPanel,
  AppearancePanel,
  BehaviorPanel,
  ExperimentalPanel,
  KeyboardPanel,
  NetworkPanel,
  NotificationsPanel,
  SettingsView,
  useNotifySetting,
} from "./components/SettingsView.js";
import { EXPERIMENT_TITLES, experimentForViewName, type ExperimentId } from "./experiments.js";
import { useExperiments } from "./use-experiments.js";
import { conductorAgentId } from "./workflow-presets.js";
import {
  isTauriRuntime,
  readTailnetAccess,
  writeTailnetAccess,
  type TailnetAccessSetting,
  type TailnetAccessStatus,
} from "./tailnet-access.js";

/**
 * Move focus somewhere sensible when a layout change has dropped it on <body>.
 *
 * Deliberately conditional: it never takes focus away from a live element, so clicking a section
 * link still leaves focus on the link. It only acts when focus has already been LOST — which is
 * exactly the state a breakpoint crossing or a history navigation leaves it in.
 */
function rescueFocusTo(target: HTMLElement | null) {
  const active = document.activeElement;
  if (active && active !== document.body && (active as HTMLElement).isConnected) return;
  target?.focus();
}

export function App() {
  return desktopMultiInstanceAvailable() ? <DesktopApp /> : <BrowserApp />;
}

function BrowserApp() {
  const [runtime] = useState(() => createBrowserInstanceRuntime({
    instanceId: "local",
    runtimeKey: "local:0",
    httpOrigin: CONTROL_PLANE_HTTP,
    websocketOrigin: CONTROL_PLANE_WS,
    token: deviceToken,
    onCredentialChange(listener) {
      window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
      return () => window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, listener);
    },
  }));
  return (
    <FeedbackProvider>
      <DesktopExternalLinkRouter />
      <InstanceRuntimeHost runtime={runtime} disposeOnUnmount>
        <ErrorBoundary label="App">
          <Shell />
        </ErrorBoundary>
      </InstanceRuntimeHost>
    </FeedbackProvider>
  );
}

function DesktopApp() {
  return (
    <FeedbackProvider>
      <DesktopExternalLinkRouter />
      {/* Renders nothing, and sits ABOVE everything that can be swapped out. §23.1's warning is
          emitted by the shell at close time, and it has to land somewhere: inside `Shell` this
          unmounted whenever the instance was opening, failed or missing — or whenever the error
          boundary tripped — so the shell held the close and warned into nothing, and the user's
          second click killed the work in silence. */}
      <DesktopCloseGuard />
      <ErrorBoundary label="App">
        <InstanceProvider>
          <DesktopInstanceBoundary />
        </InstanceProvider>
      </ErrorBoundary>
    </FeedbackProvider>
  );
}

function DesktopInstanceBoundary() {
  const instances = useInstances();
  if (instances.phase === "ready" && instances.runtime) {
    return (
      <InstanceRuntimeHost
        key={instances.runtime.ui.runtimeKey}
        runtime={instances.runtime}
        navigation={instances.navigation}
      >
        <Shell />
      </InstanceRuntimeHost>
    );
  }
  return <InstanceRecoveryShell />;
}

function InstanceRecoveryShell() {
  const instances = useInstances();
  const loading = instances.phase === "loading" || instances.phase === "opening";
  return (
    <div className="app instance-recovery-app">
      <aside className="instance-recovery-nav" aria-label="Instance Navigation">
        <div className="brand">
          <img className="brand-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
          <div className="brand-name">Wollipog</div>
        </div>
        <InstanceSelector />
      </aside>
      <main className="main">
        <header className="topbar"><h1>Instances</h1></header>
        <div className="main-body instance-recovery-body">
          {loading ? (
            <div className="instance-recovery-state" role="status" aria-live="polite">
              <h2>{instances.phase === "loading" ? "Loading Instances" : `Connecting to ${instances.activeProfile.label}`}</h2>
              <p>{instances.phase === "loading" ? "Loading saved Wollipog instances…" : "Opening a secure connection…"}</p>
            </div>
          ) : (
            <>
              <div className="instance-recovery-state" role={instances.phase === "missing" ? "alert" : "status"}>
                <h2>{instances.phase === "missing" ? "Instance Not Found" : `${instances.activeProfile.label} Is Unavailable`}</h2>
                <p>
                  {instances.phase === "missing"
                    ? "This saved instance no longer exists. Choose another instance before opening this resource."
                    : instances.error ?? "Wollipog could not open this instance."}
                </p>
                <div className="toolbar-actions">
                  {instances.phase !== "missing" && (
                    <button type="button" className="btn primary" onClick={() => void instances.retryActive()}>Retry</button>
                  )}
                  {(instances.phase === "missing" || instances.activeProfile.id !== "local") && (
                    <button type="button" className="btn" onClick={() => void instances.goToThisMachine()}>Go to This Machine</button>
                  )}
                </div>
              </div>
              <InstancesPanel />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function xtermOwnsKey(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(".xterm"));
}

function Shell() {
  const instances = useInstances();
  const reportActiveStatus = instances.reportActiveStatus;
  const activeInstanceKind = instances.activeProfile.kind;
  const activeInstanceLabel = instances.activeProfile.label;
  const desktopMultiInstance = instances.desktopMultiInstance;
  const theme = useTheme();
  const { navigate } = useStoreActions();
  const view = useStoreSelector((s) => s.view);
  const viewRef = useRef(view);
  viewRef.current = view;
  const settingsReturnView = useStoreSelector((s) => s.settingsReturnView);
  const settingsReturnViewRef = useRef(settingsReturnView);
  settingsReturnViewRef.current = settingsReturnView;
  const conn = useStoreSelector((s) => s.conn);
  const authRequired = useStoreSelector((s) => s.authRequired);
  useEffect(() => {
    if (!desktopMultiInstance || activeInstanceKind !== "remote") return;
    if (authRequired) {
      reportActiveStatus({
        availability: "authentication-required",
        message: "This instance requires a new pairing credential.",
      });
    } else if (conn === "online") {
      reportActiveStatus({ availability: "online" });
    } else if (conn === "offline") {
      reportActiveStatus({
        availability: "offline",
        message: `Can't reach ${activeInstanceLabel}.`,
      });
    }
  }, [activeInstanceKind, activeInstanceLabel, authRequired, conn, desktopMultiInstance, reportActiveStatus]);
  const runners = useStoreSelector((s) => s.runners);
  const sessions = useStoreSelector((s) => s.sessions);
  const stalledSessions = useStoreSelector((s) => s.stalledCount);
  const experiments = useExperiments();
  // The Conductor switch needs to say when the runner side is missing. ONLINE runners only:
  // the store keeps a disconnected runner's advertised agents, and a row calling the conductor
  // available on the strength of a runner that cannot start anything would be a false claim.
  const conductorAvailable = useMemo(
    () => [...runners.values()].some((runner) =>
      runner.status === "online" && conductorAgentId(runner.agents ?? []) !== undefined),
    [runners],
  );
  // A route into a feature this device has switched off renders the explanation instead of the
  // feature: removing the branch entirely would make a bookmarked /runs a silent Inbox redirect.
  const disabledExperimentView = (() => {
    const experiment = experimentForViewName(view.name);
    return experiment !== null && !experiments.flags[experiment] ? experiment : null;
  })();
  const activeSession = view.name === "session" ? sessions.get(view.id) : undefined;
  const activeRunnerProtocol = activeSession ? runners.get(activeSession.runnerId)?.protocolVersion : undefined;
  const terminalSupported = runnerSupportsProtocol(activeRunnerProtocol, "sessionShells");
  const filesSupported = runnerSupportsProtocol(activeRunnerProtocol, "sessionFiles");
  const conversationSteeringSupported = runnerSupportsProtocol(activeRunnerProtocol, "conversationSteering");
  const turnInterruptionSupported = runnerSupportsProtocol(activeRunnerProtocol, "turnInterruptionAck");
  const terminalHint = runnerCapabilityRequirement(activeRunnerProtocol, "sessionShells", "Session terminal access");
  const [dialog, setDialog] = useState<null | { kind: "session"; preset?: NewSessionPreset } | { kind: "run" } | { kind: "pod" }>(null);
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false);
  const [composerFocusSessionId, setComposerFocusSessionId] = useState<string | null>(null);
  const shortcutReturnFocusRef = useRef<HTMLElement | null>(null);
  // Remembered as a SELECTOR alongside the element. Settings → Keyboard Shortcuts → cross 760px →
  // close left both saved targets disconnected: the element was the desktop Settings trigger, which
  // that crossing removes. A selector re-resolves against whichever layout is mounted now.
  const shortcutReturnSelectorRef = useRef<string | null>(null);
  const openShortcutReference = useCallback((returnFocus?: HTMLElement | null) => {
    const target = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    shortcutReturnFocusRef.current = target;
    // A CHAIN, because the opener can disappear in more than one way. Opened from the Settings
    // Keyboard row, then Back while the reference is still open: the row is gone, and a selector
    // that only knew about the gear resolved to null. The page heading is the last resort and
    // always exists, so closing the reference can never drop focus on <body>.
    shortcutReturnSelectorRef.current = target?.closest(".settings-control")
      ? ".settings-trigger"
      : target?.closest(".settings-view")
      ? ".settings-view .ui-row-nav"
      : null;
    setShortcutReferenceOpen(true);
  }, []);
  const closeShortcutReference = useCallback(() => {
    setShortcutReferenceOpen(false);
    const target = shortcutReturnFocusRef.current;
    const selector = shortcutReturnSelectorRef.current;
    shortcutReturnFocusRef.current = null;
    shortcutReturnSelectorRef.current = null;
    window.setTimeout(() => {
      if (target?.isConnected) {
        target.focus();
        return;
      }
      // The saved element is gone — a breakpoint crossing removed the layout that held it, or a
      // history navigation replaced the page it was on.
      const reresolved = selector ? document.querySelector<HTMLElement>(selector) : null;
      (reresolved ?? document.getElementById("page-title"))?.focus();
    }, 0);
  }, []);
  // Push-to-wake lifecycle lives HERE (always mounted), not in the settings dialog: the
  // boot/token-change reconcile must run even if Settings is never opened.
  const push = usePushSetting();
  // Hoisted to the shell for the same reason push is: mounted inside the Network panel, the hook
  // re-read on every visit and a toggle started before leaving completed against the discarded
  // instance — so returning to Network showed the value it had before the write.
  const tailnet = useTailnetAccessSetting();
  const notify = useNotifySetting();
  // Right side panel (Review/Terminal/Browser/Files/Side chat). State lives here — not in the
  // per-session-keyed SessionDetail — so open/mode/width survive navigating between sessions.
  const rightPanel = useRightPanelState();
  const sourceLocationKey = view.name === "session" && view.location
    ? `${view.id}\0${view.location.path}\0${view.location.line ?? ""}\0${view.location.column ?? ""}\0${view.location.symbol ?? ""}`
    : null;
  useEffect(() => {
    if (sourceLocationKey) rightPanel.show("files");
    // The scalar route key is the trigger; panel callbacks are intentionally app-state methods.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLocationKey]);

  // Bottom terminal dock visibility (Codex layout: toggled, never an always-visible bar).
  // Migrates the legacy wollipog.shelldock.collapsed pref on first run.
  const [dockVisible, setDockVisible] = useState(() => {
    try {
      return parseStoredDockVisible(
        loadBrowserStorageValue("wollipog.shelldock.visible"),
        loadBrowserStorageValue("wollipog.shelldock.collapsed"),
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      if (saveBrowserStorageValue("wollipog.shelldock.visible", dockVisible ? "1" : "0")) {
        removeBrowserStorageValue("wollipog.shelldock.collapsed"); // legacy key, migrated above
      }
    } catch {
      /* best-effort */
    }
  }, [dockVisible]);

  // Pinned summary (the Codex-style floating environment card). Open by default.
  const [pinnedOpen, setPinnedOpen] = useState(() => {
    try {
      return loadBrowserStorageValue("wollipog.pinned.open") !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      saveBrowserStorageValue("wollipog.pinned.open", pinnedOpen ? "1" : "0");
    } catch {
      /* best-effort */
    }
  }, [pinnedOpen]);

  // Stable, because the identity chain runs all the way down: an inline arrow here rebuilds
  // InboxView's `expand`, which rebuilds `handleSelect`, which gives every mounted InboxRow unequal
  // props — so a session upsert anywhere re-renders every visible row despite the memo. Making the
  // callbacks stable in InboxList and InboxView was necessary and not sufficient.
  const expandSession = useCallback((sessionId: string, focusComposer = false) => {
    setComposerFocusSessionId(focusComposer ? sessionId : null);
    navigate({ name: "session", id: sessionId });
  }, [navigate]);
  const isMobile = useIsMobile();
  // The breakpoint-specific controls (the instance selector and gear) are unmounted by a
  // crossing, and a keyboard user standing on one is left on <body>. Accessibility zoom crosses
  // 760px too, so this is not only a window-drag case.
  //
  // Only on a real CROSSING. On a fresh load focus is legitimately on <body> and nothing has been
  // dropped, so the first version moved it to the heading and the first Tab then started after the
  // whole rail — the rescue skipped every primary destination. The ref is seeded with the current
  // value rather than a mount flag, because Strict Mode double-invokes effects and a flag would be
  // spent before the first real transition.
  const previousLayout = useRef(isMobile);
  useEffect(() => {
    if (previousLayout.current === isMobile) return;
    previousLayout.current = isMobile;
    rescueFocusTo(document.getElementById("page-title"));
  }, [isMobile]);

  // And on a VIEW change, which is a different event. Back out of Settings unmounts the whole view
  // with the focused control inside it: the section effect cannot run, because its component is
  // gone, and `isMobile` has not changed. Keyed on the canonical path so a section move counts too —
  // SettingsView's own effect runs first (child effects precede the parent's) and takes the
  // heading, after which this one sees a live element and declines.
  const path = viewPath(view);
  const previousPath = useRef(path);
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    rescueFocusTo(document.getElementById("page-title"));
  }, [path]);
  const inboxNewSessionPresetRef = useRef<NewSessionPreset | undefined>(undefined);
  const openContextualNewSession = useCallback(() => {
    setDialog({ kind: "session", preset: inboxNewSessionPresetRef.current });
  }, []);
  const setInboxNewSessionPreset = useCallback((preset?: NewSessionPreset) => {
    inboxNewSessionPresetRef.current = preset;
  }, []);
  useNewSessionShortcut(!isMobile, openContextualNewSession);

  // ONE Escape handler for the shell ladder (mounted always; the palette and dialogs manage
  // their own). Escape peels exactly ONE layer, topmost first:
  //  - Any open popover claims the press. Popovers don't all have Escape handlers (the ⋯
  //    menus close only via backdrop), so close by CLICKING the backdrop — the one close
  //    affordance every popover implements. "Topmost" = highest computed z-index, later
  //    in document on ties — never just the first match in document order, which would
  //    close an UNDERLYING menu while a later popover sat above it.
  useEffect(() => installTerminalExitBoundary(window, document), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        handleSettingsNavigationKey(e, {
          document,
          viewName: viewRef.current.name,
          settingsReturnView: settingsReturnViewRef.current,
          navigate,
        });
        return;
      }
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".plus-backdrop, .menu-backdrop"));
      if (backdrops.length) {
        e.preventDefault();
        pickTopmost(backdrops, (el) => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0)?.click();
        return;
      }
      if (handleSettingsNavigationKey(e, {
        document,
        viewName: viewRef.current.name,
        settingsReturnView: settingsReturnViewRef.current,
        navigate,
      })) return;
      const search = document.querySelector<HTMLInputElement>(".inbox-search input");
      const owner = escapeOwner(e, {
        document,
        viewName: viewRef.current.name,
        inboxFilterActive: Boolean(search?.value),
      });
      if (owner === "terminal") return;
      if (owner === "terminal-exit") {
        e.preventDefault();
        document.querySelector<HTMLElement>(".main-body .detail-scroll")?.focus();
      } else if (owner === "composer") {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        window.requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(".main-body .detail-scroll")?.focus();
        });
      } else if (owner === "session-reading") {
        e.preventDefault();
        navigate({ name: "inbox" });
      } else if (owner === "inbox-filter") {
        e.preventDefault();
        window.dispatchEvent(new Event("wollipog:clear-inbox-query"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    if (isMobile) return;
    const destinations = [
      ["navigate-inbox", { name: "inbox" }],
      ["navigate-projects", { name: "projects" }],
      ["navigate-board", { name: "board" }],
      ["navigate-runs", { name: "runs" }],
      ["navigate-pods", { name: "pods" }],
      ["navigate-automations", { name: "automations" }],
      ["navigate-usage", { name: "usage" }],
      ["navigate-connections", { name: "runners" }],
      ["navigate-archived", { name: "archived" }],
    ] as const;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document) || xtermOwnsKey(event.target)) return;
      for (const [shortcutId, destination] of destinations) {
        if (!matchesShortcut(event, shortcutId)) continue;
        // A number for a switched-off experiment does nothing rather than opening the
        // explanation page: the rail hides the destination, so the binding is unadvertised.
        const experiment = experimentForViewName(destination.name);
        if (experiment !== null && !experiments.flags[experiment]) return;
        event.preventDefault();
        navigate(destination);
        return;
      }
      if (matchesShortcut(event, "focus-inbox-search")) {
        event.preventDefault();
        navigate({ name: "inbox" });
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".inbox-search input")?.focus();
        }));
      } else if (matchesShortcut(event, "focus-next-zone")) {
        event.preventDefault();
        cycleFocusZone(document, "next");
      } else if (matchesShortcut(event, "focus-previous-zone")) {
        event.preventDefault();
        cycleFocusZone(document, "previous");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, navigate, experiments.flags]);

  // Ctrl+K / Cmd+K opens the global search palette (sessions + transcripts + views).
  // Deliberately ALSO from inputs/textareas (the Slack/Linear convention — jumping mid-typing
  // is the point) but NOT from a terminal: Ctrl+K is a real control sequence inside xterm.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || shortcutLayerActive(document, true)) return;
      if (matchesShortcut(e, "search")) {
        if (xtermOwnsKey(e.target)) return;
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // `?` opens the discoverable reference without stealing punctuation from editors or xterm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, "shortcut-reference") || e.defaultPrevented || isEditableShortcutTarget(e.target)) return;
      if (shortcutLayerActive(document)) return;
      e.preventDefault();
      openShortcutReference();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openShortcutReference]);

  // Session-view panel shortcuts (Codex bindings). Registered without deps on purpose: the
  // handler closes over this render's view/rightPanel, and re-registering per render keeps the
  // mode toggle's "same mode → close" check reading fresh state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || shortcutLayerActive(document) || xtermOwnsKey(e.target) || view.name !== "session") return;
      if (matchesShortcut(e, "open-files")) {
        e.preventDefault();
        if (filesSupported) rightPanel.openMode("files");
        else rightPanel.show("launcher");
      }
      if (matchesShortcut(e, "open-review")) {
        e.preventDefault();
        rightPanel.openMode("review");
      }
      if (matchesShortcut(e, "toggle-terminal")) {
        e.preventDefault();
        if (terminalSupported) setDockVisible((v) => !v);
        else rightPanel.show("launcher");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onlineRunners = useMemo(
    () => [...runners.values()].filter((r) => r.status === "online").length,
    [runners],
  );
  const blockedSessions = useMemo(
    () => [...sessions.values()].filter((session) => !session.archived && isInboxBlocked(session)).length,
    [sessions],
  );

  // Codex-style session panel-control cluster. On desktop it renders inside the unified session
  // bar (via InboxView → SessionDetail); on phone widths it stays in the topbar, which the phone
  // layout keeps for the instance/new/settings controls anyway.
  const sessionPanelControls = view.name === "session" ? (
    <>
      {/* Keyed by session: transient state (open menu, in-flight launch, error note)
          must not leak from one session's bar into the next. */}
      <EditorSelect key={view.id} sessionId={view.id} />
      <button
        type="button"
        className={`icon-btn${pinnedOpen ? " is-on" : ""}`}
        onClick={() => setPinnedOpen((v) => !v)}
        title="Toggle Pinned Summary"
        aria-label="Toggle Pinned Summary"
        aria-pressed={pinnedOpen}
      >
        <PinnedPanelIcon size={15} />
      </button>
      <button
        type="button"
        className={`icon-btn${terminalSupported && dockVisible ? " is-on" : ""}`}
        onClick={() => {
          if (terminalSupported) setDockVisible((v) => !v);
          else rightPanel.show("launcher");
        }}
        title={terminalSupported ? `${dockVisible ? "Hide" : "Show"} terminal (${shortcutDisplay("toggle-terminal")})` : terminalHint}
        aria-label={
          terminalSupported ? (dockVisible ? "Hide terminal" : "Show terminal") : "Terminal unavailable: update runner"
        }
        aria-pressed={terminalSupported && dockVisible}
      >
        <DockBottomIcon size={15} />
      </button>
      <button
        type="button"
        className={`icon-btn${rightPanel.open ? " is-on" : ""}`}
        onClick={rightPanel.toggle}
        title={rightPanel.open ? "Hide side panel" : "Show side panel"}
        aria-label={rightPanel.open ? "Hide side panel" : "Show side panel"}
        aria-pressed={rightPanel.open}
      >
        <PanelRightIcon size={15} />
      </button>
    </>
  ) : null;

  return (
    <div className={`app${rightPanel.dragging ? " panel-dragging" : ""}`}>
      <Rail
        view={view}
        blockedCount={blockedSessions}
        stalledCount={stalledSessions}
        onlineConnections={onlineRunners}
        onNavigate={navigate}
        {...(isMobile ? {} : {
          instanceControl: <InstanceSelector compact />,
          settingsControl: <SettingsTrigger active={view.name === "settings"} onOpen={() => navigate({ name: "settings" })} />,
        })}
      />
      <main className="main">
        {!(view.name === "session" && !isMobile) && (
          <Header
            view={view}
            mobileInstanceControl={isMobile ? (
              /* The phone rail has room for five destinations and nothing else, so these live here.
                 The topbar is fixed and uncontested — unlike the bottom band, which an open shell
                 dock and the toast stack both occupy. */
              <InstanceSelector compact />
            ) : null}
            mobileSettingsControl={isMobile ? (
              <SettingsTrigger active={view.name === "settings"} onOpen={() => navigate({ name: "settings" })} />
            ) : null}
            onNewRun={() => setDialog({ kind: "run" })}
            onNewPod={() => setDialog({ kind: "pod" })}
            sessionActions={isMobile ? sessionPanelControls : null}
          />
        )}
        {/* Once a 1008 latched authRequired, the pairing card stays mounted through the
            background retries' connecting/offline states so the draft is never wiped. */}
        {authRequired && conn !== "online" ? (
          instances.activeProfile.kind === "remote"
            ? <RemoteInstanceBanner authenticationRequired />
            : <PairingBanner connecting={conn === "connecting"} />
        ) : (
          conn === "offline" && (
            instances.activeProfile.kind === "remote"
              ? <RemoteInstanceBanner />
              : <OfflineBanner />
          )
        )}
        <div className={`main-body${view.name === "inbox" || view.name === "session" ? " inbox-main-body" : ""}`}>
          <ErrorBoundary
            label="View"
            resetKey={viewPath(view)}
          >
          {view.name === "board" && (
            <Board
              onNewSession={openContextualNewSession}
              onOpenReview={(sessionId) => {
              navigate({ name: "session", id: sessionId });
              rightPanel.show("review");
            }} />
          )}
          {(view.name === "inbox" || view.name === "session") && (
            <InboxView
              expandedSessionId={view.name === "session" ? view.id : null}
              sourceLocation={view.name === "session" ? view.location : undefined}
              topbarControls={!isMobile ? sessionPanelControls : undefined}
              rightPanel={rightPanel}
              onOpenTerminal={() => {
                if (terminalSupported) setDockVisible(true);
              }}
              pinnedOpen={pinnedOpen}
              focusComposerSessionId={composerFocusSessionId}
              onComposerFocusConsumed={() => setComposerFocusSessionId(null)}
              onExpand={expandSession}
              onCollapse={() => navigate({ name: "inbox" })}
              onNewSession={(preset) => setDialog({ kind: "session", preset })}
              onShortcutNewSessionPresetChange={setInboxNewSessionPreset}
            />
          )}
          {view.name === "runners" && <RunnersView />}
          {disabledExperimentView && (
            <ExperimentDisabledNotice
              experiment={disabledExperimentView}
              onOpenSettings={() => navigate({ name: "settings", section: "experimental" })}
            />
          )}
          {view.name === "runs" && !disabledExperimentView && <RunsView onNewRun={() => setDialog({ kind: "run" })} />}
          {view.name === "pods" && !disabledExperimentView && <PodsView onNewPod={() => setDialog({ kind: "pod" })} />}
          {view.name === "automations" && <AutomationsView />}
          {view.name === "usage" && <UsageView />}
          {view.name === "archived" && <ArchivedSessionsView />}
          {view.name === "settings" && (
            <SettingsView
              section={view.section ?? "appearance"}
              onNavigate={navigate}
              onOpenShortcuts={openShortcutReference}
              panels={{
                appearance: (
                  <AppearancePanel
                    options={THEME_OPTIONS}
                    value={theme.preference}
                    onChange={(value: string) => theme.setPreference(value as typeof theme.preference)}
                    schemes={COLOR_SCHEMES}
                    scheme={theme.scheme}
                    onSchemeChange={(value: string) => theme.setScheme(value as typeof theme.scheme)}
                    // Rendered, not chosen. The provider owns `data-scheme`, so browsing the list
                    // repaints the whole app and Escape puts the committed palette back.
                    onSchemePreview={(value: string | null) =>
                      theme.setPreviewScheme(value as typeof theme.scheme | null)}
                    resolvedTheme={theme.resolved}
                    densities={DENSITY_OPTIONS}
                    density={theme.density}
                    onDensityChange={(value: string) => theme.setDensity(value as typeof theme.density)}
                  />
                ),
                notifications: <NotificationsPanel notify={notify} push={push} />,
                keyboard: (
                  <KeyboardPanel
                    shortcutLabel={`Reference · ${shortcutDisplay("shortcut-reference")}`}
                    onOpenShortcuts={openShortcutReference}
                  />
                ),
                behavior: <BehaviorPanel />,
                network: <NetworkPanel tailnet={tailnet} />,
                experimental: (
                  <ExperimentalPanel
                    flags={experiments.flags}
                    onToggle={experiments.setFlag}
                    conductorAvailable={conductorAvailable}
                  />
                ),
                about: <AboutPanel />,
              }}
            />
          )}
          {view.name === "projects" && (
            <ProjectsView
              selectedProjectId={view.id}
              onNewSession={(preset) => setDialog({ kind: "session", preset })}
            />
          )}
          {view.name === "run" && !disabledExperimentView && <RunDetail runId={view.id} />}
          {view.name === "pod" && !disabledExperimentView && <PodDetail podId={view.id} />}
          </ErrorBoundary>
        </div>
        {/* Bottom shell dock: session-scoped terminals in the compact desktop layout. Mounted only
            while toggled on; keyed by session so tab selection never bleeds across navigations. */}
        {view.name === "session" && dockVisible && terminalSupported && (
          <ShellDock
            key={`dock-${view.id}`}
            sessionId={view.id}
            onClose={() => setDockVisible(false)}
            theme={theme.resolved}
            scheme={theme.scheme}
          />
        )}
      </main>

      {dialog?.kind === "session" && (
        <NewSessionDialog
          onClose={() => setDialog(null)}
          onOpenTerminal={() => setDockVisible(true)}
          preset={dialog.preset}
        />
      )}
      {dialog?.kind === "run" && <NewRunDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "pod" && <NewPodDialog onClose={() => setDialog(null)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {shortcutReferenceOpen && (
        <ShortcutReference
          onClose={closeShortcutReference}
          sessionOpen={view.name === "session"}
          terminalSupported={terminalSupported}
          filesSupported={filesSupported}
          conversationSteeringSupported={conversationSteeringSupported}
          turnInterruptionSupported={turnInterruptionSupported}
        />
      )}
    </div>
  );
}

function RemoteInstanceBanner({ authenticationRequired = false }: { authenticationRequired?: boolean }) {
  const instances = useInstances();
  return (
    <div className="offline-banner pairing-banner" role="status">
      <BannerStatusIcon kind={authenticationRequired ? "lock" : "warning"} />
      <span>
        {authenticationRequired
          ? `${instances.activeProfile.label} requires a new pairing credential.`
          : `Can't reach ${instances.activeProfile.label} at ${instances.activeProfile.origin}.`}
      </span>
      <span className="pairing-controls">
        {!authenticationRequired && (
          <button type="button" className="btn primary sm" onClick={() => void instances.retryActive()}>Retry</button>
        )}
        <button type="button" className="btn sm" onClick={instances.manageInstances}>
          {authenticationRequired ? "Re-Pair in Instances" : "Manage Instances"}
        </button>
      </span>
    </div>
  );
}

function BannerStatusIcon({ kind }: { kind: "lock" | "warning" }) {
  const Icon = kind === "lock" ? LockIcon : WarningTriangleIcon;
  return <Icon className="offline-icon" />;
}

function Header({
  view,
  mobileInstanceControl,
  mobileSettingsControl,
  onNewRun,
  onNewPod,
  sessionActions,
}: {
  view: View;
  /** Global controls moved out of the rail on phone widths. */
  mobileInstanceControl?: React.ReactNode;
  mobileSettingsControl?: React.ReactNode;
  onNewRun: () => void;
  onNewPod: () => void;
  /** Session panel-control cluster; rendered here only on phone widths, where the unified
   * session bar has no room for it (Shell owns the desktop placement inside SessionDetail). */
  sessionActions?: React.ReactNode;
}) {
  const title = viewTitle(view);
  const { flags } = useExperiments();
  return (
    <header className="topbar">
      {/* Focusable only programmatically: the rescue below moves focus here when a layout swap
          drops it, so the next Tab continues from the page rather than from the document top. */}
      <h1 id="page-title" tabIndex={-1}>{title}</h1>
      {mobileInstanceControl && mobileSettingsControl && (
        <div className="topbar-actions topbar-mobile-controls">
          {mobileInstanceControl}
          {view.name === "runs" && flags.multiAgent && (
            <button type="button" className="btn primary sm topbar-create" onClick={onNewRun}>New Multi-Agent Run</button>
          )}
          {view.name === "pods" && flags.pods && (
            <NewPodHeaderButton onClick={onNewPod} />
          )}
          {view.name === "session" && sessionActions}
          {mobileSettingsControl}
        </div>
      )}
      {!mobileInstanceControl && view.name === "runs" && flags.multiAgent && (
        <button type="button" className="btn primary sm topbar-create" onClick={onNewRun}>New Multi-Agent Run</button>
      )}
      {!mobileInstanceControl && view.name === "pods" && flags.pods && (
        <NewPodHeaderButton onClick={onNewPod} />
      )}
      {!mobileInstanceControl && view.name === "session" && sessionActions && (
        <div className="topbar-actions">{sessionActions}</div>
      )}
    </header>
  );
}

function NewPodHeaderButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn topbar-create"
      onClick={onClick}
      title="New Collaboration Pod"
      aria-label="New Collaboration Pod"
    >
      <PlusIcon size={16} />
    </button>
  );
}

/**
 * What a direct route into a switched-off experiment renders.
 *
 * The route still parses — a bookmark must not silently become the Inbox — but the feature's
 * views stay unmounted, and the page says which switch governs it and where that switch lives.
 */
function ExperimentDisabledNotice({
  experiment,
  onOpenSettings,
}: {
  experiment: ExperimentId;
  onOpenSettings: () => void;
}) {
  return (
    <Empty
      headingLevel={2}
      title={`${EXPERIMENT_TITLES[experiment]} Is Turned Off`}
      hint="This experimental feature is hidden on this device."
      action={
        <button type="button" className="btn sm" onClick={onOpenSettings}>
          Open Experimental Settings
        </button>
      }
    />
  );
}

function OfflineBanner() {
  return (
    <div className="offline-banner" role="status">
      <BannerStatusIcon kind="warning" />
      <span>
        Can't reach the control plane at <code>{CONTROL_PLANE_HTTP}</code>. Start it (for the local stack, run{" "}
        <code>pnpm dev</code>) — the UI reconnects automatically.
      </span>
    </div>
  );
}

/**
 * Shown when the /ui socket was policy-closed (1008): this device isn't paired (or was
 * revoked). Matters most for the INSTALLED iOS PWA — its storage is partitioned from Safari,
 * so a token adopted in the browser never carries over, and a standalone app has no address
 * bar to open a fresh `#pair=` link in. Pasting the token (or the whole link) here is the way in.
 */
function PairingBanner({ connecting }: { connecting: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const nativePairingFailure = desktopLocalPairingFailure();
  const submit = () => {
    const token = parsePairingInput(value);
    if (!token) {
      setError("that doesn't look like a pairing token or link");
      return;
    }
    storeDeviceToken(token);
    setSubmitted(true);
    // Reconnect IN-PROCESS (no reload): when localStorage is blocked the token lives only in
    // this page's memory — a reload would drop it and loop straight back to this card.
    window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
  };
  const retryDesktopPairing = async () => {
    setRetrying(true);
    setError(null);
    try {
      const adopted = await adoptManagedDesktopPairing();
      if (!adopted) {
        throw new Error("Another control-plane process owns the local port; pair with that process explicitly.");
      }
      window.dispatchEvent(new Event(DEVICE_TOKEN_CHANGED_EVENT));
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : "the desktop could not retry local pairing");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <div className="offline-banner pairing-banner" role="status">
      <BannerStatusIcon kind="lock" />
      {nativePairingFailure ? (
        <span>
          The desktop could not read its managed local pairing credential. Retry pairing, or paste
          a pairing link or token from the control-plane owner:
        </span>
      ) : (
        <span>
          This device isn't paired with the control plane. Open its startup pairing URL, or print it
          again on the control-plane machine with <code>--print-pair-url</code>, then paste the link or token here:
        </span>
      )}
      <span className="pairing-controls">
        {nativePairingFailure && (
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => void retryDesktopPairing()}
            disabled={retrying || connecting}
          >
            {retrying ? "Retryingâ€¦" : "Retry Pairing"}
          </button>
        )}
        <input
          type="password"
          value={value}
          maxLength={2048}
          placeholder="#pair=… link or token"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setSubmitted(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-label="Pairing Token"
        />
        <button type="button" className="btn primary sm" onClick={submit} disabled={!value.trim() || connecting}>
          {connecting ? "Pairing…" : "Pair"}
        </button>
      </span>
      {error && <span className="pairing-error">{error}</span>}
      {submitted && !error && !connecting && (
        <span className="pairing-error">still not accepted — check the token or pair a fresh one</span>
      )}
    </div>
  );
}

/**
 * Web Push lifecycle — mounted at the SHELL, not inside the settings dialog: the
 * boot/token-change reconciliation is what re-registers a revoked-then-re-paired device's
 * subscription (or heals a reset control-plane database), and it must run even if the
 * user never opens Settings. The dialog row is only a view of this state.
 */
/*
 * Coordination (review-shaped): every operation — reconciles AND user toggles — runs on ONE
 * promise chain, so a reconcile's server re-register can never interleave with a toggle's
 * subscribe/unsubscribe. A generation counter (bumped by toggles) additionally gates state
 * writes, so a reconcile enqueued BEFORE a toggle can't overwrite the toggle's outcome
 * after it lands. No async work starts inside a setState updater (React purity).
 */
function usePushSetting(): PushSetting {
  const api = useApi();
  const [state, setState] = useState<PushSetting["state"]>("unavailable");
  const stateRef = useRef(state);
  stateRef.current = state;
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const genRef = useRef(0);
  const disposedRef = useRef(false);
  const enqueue = useCallback((op: () => Promise<void>) => {
    chainRef.current = chainRef.current.then(op).catch(() => {
      /* per-op errors are handled inside the op; the chain must never wedge */
    });
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    // Reconcile (not just read): the local subscription is idempotently re-registered so
    // "on" means the server actually holds a deliverable row. Re-run on token changes.
    const sync = () => {
      const gen = genRef.current; // a toggle bumping this invalidates the writes below
      enqueue(async () => {
        if (gen !== genRef.current) return; // superseded before it even started
        if (!(await pushAvailable())) return; // no registration → the row stays hidden
        const { sub, registered } = await reconcilePushSubscription(api);
        if (!disposedRef.current && gen === genRef.current) {
          setState(sub && registered ? "on" : "off");
        }
      });
    };
    sync();
    const onToken = () => sync();
    window.addEventListener(DEVICE_TOKEN_CHANGED_EVENT, onToken);
    return () => {
      disposedRef.current = true;
      window.removeEventListener(DEVICE_TOKEN_CHANGED_EVENT, onToken);
    };
  }, [api, enqueue]);

  const toggle = useCallback(async () => {
    const was = stateRef.current;
    if (was === "busy" || was === "unavailable") return;
    genRef.current++; // any in-flight/queued reconcile may no longer write state
    setState("busy");
    const gen = genRef.current;
    enqueue(async () => {
      const write = (s: PushSetting["state"]) => {
        if (!disposedRef.current && gen === genRef.current) setState(s);
      };
      try {
        if (was === "on") {
          await disablePush(api);
          write("off");
        } else {
          write((await enablePush(api)) ? "on" : "off");
        }
      } catch {
        write(was); // server rejected / permission denied — reflect reality, no crash
      }
    });
  }, [api, enqueue]);
  // "busy" is a transition, not a value; hold the last confirmed one through it.
  const confirmedRef = useRef(false);
  if (state === "on" || state === "off") confirmedRef.current = state === "on";

  return { state, confirmed: confirmedRef.current, toggle };
}

/**
 * Sections §11.3 asked for and the dialog never had.
 *
 * Each renders the settings that belong here, with the ones that do not yet exist shown disabled
 * and explained rather than absent — a missing setting teaches a user it is impossible, a disabled
 * one with a sentence teaches them where it lives.
 */



/**
 * Settings is a routed destination shared by both responsive layouts.
 *
 * The dialog it used to open had to be hoisted out of both responsive layouts, because crossing
 * 760px replaced the whole thing — Modal, its captured return-focus element, the Tailnet hook,
 * NotifyRow's state — so an open dialog vanished, focus fell to <body> because the captured trigger
 * was disconnected, and an in-flight Tailnet write completed against the discarded instance while
 * the visible row showed a stale value. A route has none of those problems: it is the URL, and the
 * URL does not care which layout is mounted.
 */
/**
 * Keep Settings data hooks independent from the responsive layouts so crossing the
 * breakpoint does not discard in-flight state.
 */

function useTailnetAccessSetting(): TailnetAccessSetting {
  const [status, setStatus] = useState<TailnetAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read once, not per panel visit. Computed rather than stored: it cannot change without a reload.
  const desktop = useMemo(() => isTauriRuntime(), []);

  useEffect(() => {
    let disposed = false;
    readTailnetAccess()
      .then((next) => {
        if (!disposed) setStatus(next);
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const toggle = useCallback(() => {
    if (!status || busy || !status.managed) return;
    setBusy(true);
    setError(null);
    writeTailnetAccess(!status.enabled)
      .then(setStatus)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }, [busy, status]);

  return { status, loading, desktop, busy, error, toggle };
}
