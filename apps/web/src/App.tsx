import { ExperimentGate } from "./components/ExperimentGate.js";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { pendingRequests, runnerSupportsProtocol } from "@wollipog/protocol";
import { sessionsEqualIgnoringStreaming, useStoreActions, useStoreSelector, type View } from "./store.js";
import { useApi } from "./api-context.js";
import { notifier } from "./notify.js";
import { CONTROL_PLANE_HTTP, CONTROL_PLANE_WS } from "./config.js";
import { useConnectionLost, useConnectionLostFor } from "./connection-lost.js";
import { DEVICE_TOKEN_CHANGED_EVENT, deviceToken } from "./device-token.js";
import { createBrowserInstanceRuntime } from "./instance-runtime.js";
import { InstanceRuntimeHost } from "./InstanceRuntimeHost.js";
import { InstanceProvider, desktopMultiInstanceAvailable } from "./InstanceProvider.js";
import { ActiveInstanceConnectionProvider, activeInstanceConnection, useInstances } from "./instances-context.js";
import { disablePush, enablePush, pushAvailable, reconcilePushSubscription, type PushSetting } from "./push.js";
import { pickTopmost } from "./layers.js";
import { useIsMobile } from "./components/useIsMobile.js";
import { ViewerIdentityProvider } from "./components/ViewerIdentityProvider.js";
import { GovernancePolicyNamesProvider } from "./components/GovernancePolicyNamesProvider.js";
import { SessionPanelToggles } from "./components/SessionPanelToggles.js";
import { parseStoredDockVisible } from "./dock.js";
import { isInboxBlocked } from "./inbox.js";
import { sessionVisibleForReminderMode } from "./session-reminders.js";
import { InboxView } from "./components/InboxView.js";
import { openGoToFile, openSideChat, useRightPanelState, type RightPanelState } from "./components/right-panel-state.js";
import { usePinnedSummaryState } from "./components/pinned-summary-state.js";
import { EditorSelect } from "./components/EditorSelect.js";
import { DesktopCloseGuard } from "./components/DesktopCloseGuard.js";
import { closeGuardLinks } from "./desktop-close-guard.js";
import { DesktopUpdateNotifier } from "./components/DesktopUpdateNotifier.js";
import { useDesktopUpdateSetting } from "./desktop-updates.js";
import { DesktopExternalLinkRouter } from "./components/DesktopExternalLinkRouter.js";
import { useWindowTitle, windowDragRegion } from "./desktop-window.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { LazyDialogBoundary } from "./components/LazyDialogBoundary.js";
import { LazyRouteFocusRecovery, LazyRouteLoading } from "./components/LazyRouteLoading.js";
import { useSearchShortcut } from "./use-search-shortcut.js";
import { SettingsTrigger } from "./components/SettingsTrigger.js";
import { useTheme } from "./components/ThemeProvider.js";
import {
  handleRovingChoiceKeyDown,
  rovingChoiceTabIndex,
} from "./components/interactions.js";
import { cycleFocusZone, escapeOwner, focusZone, indicateFocusZone, sessionReadingTarget, shortcutScopeForFocus } from "./focus-zones.js";
import { installTerminalExitBoundary } from "./terminal-focus.js";
import {
  bareDigitPressed,
  isEditableShortcutTarget,
  matchesShortcut,
  shortcutDisplay,
  shortcutLayerActive,
} from "./shortcuts.js";
import { COLOR_SCHEMES, DENSITY_OPTIONS, THEME_OPTIONS, type ThemePreference } from "./theme.js";
import {
  LOCAL_INSTANCE_SCOPE,
  loadBrowserStorageValue,
  removeBrowserStorageValue,
  saveBrowserStorageValue,
} from "./instance-storage.js";
import { FeedbackProvider } from "./components/FeedbackProvider.js";
import { OfflineBanner } from "./components/OfflineBanner.js";
import { PairingBanner } from "./components/PairingBanner.js";
import { ChevronLeftIcon, KeyboardIcon, LockIcon, PlusIcon } from "./components/Icons.js";
import { NavRow, SwitchRow } from "./components/ui/SettingsRows.js";
import { backLabel, viewPath, viewSubjectName, viewTitle } from "./navigation.js";
import { sessionDisplayTitle } from "./session-title.js";
import { routedSessionPlaceholder } from "./detail-placeholder.js";
import { useRoutedSessionLookup } from "./routed-session-lookup.js";
import { SearchPaletteContext } from "./components/search-palette-context.js";
import { useInstanceScope } from "./instance-scope.js";
import { sessionsDestination } from "./sessions-view-mode.js";
import { railViewForDigit, visibleRailViews } from "./rail-preferences.js";
import { machineAttention } from "./rail-attention.js";
import { useRailPreferences } from "./use-rail-preferences.js";
import { useSessionsViewModeMemory } from "./use-sessions-view-mode-memory.js";
import { recordRecentSession } from "./recent-sessions.js";
import { handleSettingsNavigationKey } from "./settings-navigation.js";
import { InstanceSelector } from "./components/InstanceSelector.js";
import { RemoteInstanceBanner } from "./components/RemoteInstanceBanner.js";
import { AppBarSearchProvider } from "./components/PageHeader.js";
import { Rail, RailDragStrip } from "./components/Rail.js";
import { InstancesPanel } from "./components/InstancesPanel.js";
import { useNewSessionShortcut } from "./useNewSessionShortcut.js";
import { useSessionsViewToggleKey } from "./useSessionsViewToggleKey.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { useExperiments } from "./use-experiments.js";
import {
  isTauriRuntime,
  readTailnetAccess,
  writeTailnetAccess,
  type TailnetAccessSetting,
  type TailnetAccessStatus,
} from "./tailnet-access.js";

import type { NewSessionPreset } from "./components/NewSessionDialog.js";
import { useNotifySetting } from "./use-notify-setting.js";
import { State } from "./components/State.js";

const ApprovalsPanel = lazy(() => import("./components/ApprovalsPanel.js").then((module) => ({ default: module.ApprovalsPanel })));
const RunnersView = lazy(() => import("./components/RunnersView.js").then((module) => ({ default: module.RunnersView })));
const RunsView = lazy(() => import("./components/RunsView.js").then((module) => ({ default: module.RunsView })));
const RunDetail = lazy(() => import("./components/RunsView.js").then((module) => ({ default: module.RunDetail })));
const ArchivedSessionsView = lazy(() => import("./components/ArchivedSessionsView.js").then((module) => ({ default: module.ArchivedSessionsView })));
const NewSessionDialog = lazy(() => import("./components/NewSessionDialog.js").then((module) => ({ default: module.NewSessionDialog })));
const NewRunDialog = lazy(() => import("./components/NewRunDialog.js").then((module) => ({ default: module.NewRunDialog })));
const NewPodDialog = lazy(() => import("./components/NewPodDialog.js").then((module) => ({ default: module.NewPodDialog })));
const PodDetail = lazy(() => import("./components/PodsView.js").then((module) => ({ default: module.PodDetail })));
const PodsView = lazy(() => import("./components/PodsView.js").then((module) => ({ default: module.PodsView })));
const AutomationsView = lazy(() => import("./components/AutomationsView.js").then((module) => ({ default: module.AutomationsView })));
const SkillsView = lazy(() => import("./components/SkillsView.js").then((module) => ({ default: module.SkillsView })));
const UsageView = lazy(() => import("./components/UsageView.js").then((module) => ({ default: module.UsageView })));
const ShellDock = lazy(() => import("./components/ShellDock.js").then((module) => ({ default: module.ShellDock })));
const ProjectsView = lazy(() => import("./components/ProjectsView.js").then((module) => ({ default: module.ProjectsView })));
const OrchestratorSettingsPanel = lazy(() => import("./components/OrchestratorSettingsPanel.js").then((module) => ({ default: module.OrchestratorSettingsPanel })));
const ShortcutReference = lazy(() => import("./components/ShortcutReference.js").then((module) => ({ default: module.ShortcutReference })));
const CommandPalette = lazy(() => import("./components/CommandPalette.js").then((module) => ({ default: module.CommandPalette })));
const AboutPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.AboutPanel })));
const AppearancePanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.AppearancePanel })));
const NavigationRailPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.NavigationRailPanel })));
const BehaviorPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.BehaviorPanel })));
const AgentHarnessDefaultsPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.AgentHarnessDefaultsPanel })));
const ExperimentalPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.ExperimentalPanel })));
const KeyboardPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.KeyboardPanel })));
const NetworkPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.NetworkPanel })));
const NotificationsPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.NotificationsPanel })));
const SettingsView = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.SettingsView })));
const SessionNamingPanel = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.SessionNamingPanel })));

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
        <ErrorBoundary scope="app">
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
      {/* #1646. Above the instance boundary for the same reason: its toast outlives a switch. */}
      <DesktopUpdateNotifier />
      <ErrorBoundary scope="app">
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
        <CloseGuardSessionSource />
        <Shell />
      </InstanceRuntimeHost>
    );
  }
  return <InstanceRecoveryShell />;
}

/**
 * Lets the desktop close confirmation name the working sessions it is asked about (#1965), from the
 * local instance's loaded sessions, and only while the local instance is the one open. Another
 * instance's sessions never stand in for local ones: the shell's ids are local ids.
 */
function CloseGuardSessionSource() {
  const scope = useInstanceScope();
  const sessions = useStoreSelector((s) => s.sessions);
  const latest = useRef(sessions);
  latest.current = sessions;
  useEffect(() => {
    if (scope !== LOCAL_INSTANCE_SCOPE) return undefined;
    return closeGuardLinks.provide({
      session: (id) => {
        const session = latest.current.get(id);
        if (!session) return null;
        const { title, status, pendingApproval, pendingRequestOwners, orchestratorCampaign, campaignRequests } = session;
        return { title, status, pendingApproval, pendingRequestOwners, orchestratorCampaign, campaignRequests };
      },
    });
  }, [scope]);
  return null;
}

function InstanceRecoveryShell() {
  const instances = useInstances();
  const loading = instances.phase === "loading" || instances.phase === "opening";
  useWindowTitle("Instances");
  return (
    <div className="app instance-recovery-app">
      <aside className="instance-recovery-nav" aria-label="Instance Navigation">
        <div className="brand">
          <img className="brand-mark" src="/icons/icon-192.png" alt="" aria-hidden="true" />
          <div className="brand-name">Wollipog</div>
        </div>
        <InstanceSelector labelled />
        <RailDragStrip />
      </aside>
      <main className="main">
        <header className="topbar" {...windowDragRegion()}><h1>Instances</h1></header>
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

export function Shell() {
  const instances = useInstances();
  const reportActiveStatus = instances.reportActiveStatus;
  const activeInstanceKind = instances.activeProfile.kind;
  const activeInstanceLabel = instances.activeProfile.label;
  const desktopMultiInstance = instances.desktopMultiInstance;
  const theme = useTheme();
  const { navigate, reconnectNow } = useStoreActions();
  const view = useStoreSelector((s) => s.view);
  // A loaded run or pod titles its page by name; the generic noun is only the loading fallback.
  const entityTitle = useStoreSelector((s) =>
    s.view.name === "run" ? s.runs.get(s.view.id)?.title
      : s.view.name === "pod" ? s.pods.get(s.view.id)?.title
        : undefined);
  const viewRef = useRef(view);
  viewRef.current = view;
  const settingsReturnView = useStoreSelector((s) => s.settingsReturnView);
  const settingsReturnViewRef = useRef(settingsReturnView);
  settingsReturnViewRef.current = settingsReturnView;
  const conn = useStoreSelector((s) => s.conn);
  const snapshotLoaded = useStoreSelector((s) => s.snapshotLoaded);
  const authRequired = useStoreSelector((s) => s.authRequired);
  const offlineHeld = useConnectionLostFor(conn, 2000);
  // The rail tile and the Instances card agree with the banners below: neither is Online while one
  // is shown (#1970, #2102).
  const connectionLost = useConnectionLost(conn);
  const instanceConnection = activeInstanceConnection({ conn, authRequired, connectionLost });
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
  // The shell shows no live counter or preview, so a streaming-only upsert does not render it (#2763).
  const sessions = useStoreSelector((s) => s.sessions, sessionsEqualIgnoringStreaming);
  const reminders = useStoreSelector((s) => s.reminders);
  const stalledSessionIds = useStoreSelector((s) => s.stalledSessionIds);
  const stalledRevision = useStoreSelector((s) => s.stalledRevision);
  const experiments = useExperiments();
  const openExperimentalSettings = () => navigate({ name: "settings", section: "experimental" });
  const activeSession = view.name === "session" ? sessions.get(view.id) : undefined;
  // The phone top bar titles a session that is not loaded with its page's placeholder (#2202).
  const routedSessionLookup = useRoutedSessionLookup(view.name === "session" ? view.id : "");
  // "<Page> – Wollipog" in the window, the taskbar and a browser tab; a Session by its own title.
  useWindowTitle(viewTitle(view, view.name === "session" ? sessionDisplayTitle(activeSession?.title ?? "") : entityTitle));
  const activeRunnerProtocol = activeSession ? runners.get(activeSession.runnerId)?.protocolVersion : undefined;
  const terminalSupported = runnerSupportsProtocol(activeRunnerProtocol, "sessionShells");
  const filesSupported = runnerSupportsProtocol(activeRunnerProtocol, "sessionFiles");
  const conversationSteeringSupported = runnerSupportsProtocol(activeRunnerProtocol, "conversationSteering");
  const turnInterruptionSupported = runnerSupportsProtocol(activeRunnerProtocol, "turnInterruptionAck");
  const [dialog, setDialog] = useState<null | { kind: "session"; preset?: NewSessionPreset } | { kind: "run" } | { kind: "pod" }>(null);
  const [shortcutReferenceOpen, setShortcutReferenceOpen] = useState(false);
  // What had focus when the reference opened: its focus zone picks the "Current Page" group.
  const [shortcutReferenceOpener, setShortcutReferenceOpener] = useState<HTMLElement | null>(null);
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
    shortcutReturnSelectorRef.current = target?.closest(".rail-settings")
      ? ".rail-settings .rail-item"
      : target?.closest(".settings-view")
      ? ".settings-view .ui-row-nav"
      : null;
    setShortcutReferenceOpener(target);
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
  // Same reason: an install started from Settings must still be reported after leaving About.
  const desktopUpdate = useDesktopUpdateSetting();
  const notify = useNotifySetting();
  // Keep panel preferences and drafts in the shell, but Agents visibility belongs to this visit.
  // Leaving a session (including via the Sessions list) resets it before the next surface paints.
  const rightPanel = useRightPanelState(view.name === "session" ? view.id : null,
    view.name === "session" && view.attention !== undefined);
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

  // Stable, because the identity chain runs all the way down: an inline arrow here rebuilds
  // InboxView's `expand`, which rebuilds `handleSelect`, which gives every mounted InboxRow unequal
  // props — so a session upsert anywhere re-renders every visible row despite the memo. Making the
  // callbacks stable in InboxList and InboxView was necessary and not sufficient.
  const isMobile = useIsMobile();
  const rightPanelOpen = rightPanel.open;
  const setRightPanelExpanded = rightPanel.setExpanded;
  const expandSession = useCallback((sessionId: string, focusComposer = false) => {
    setComposerFocusSessionId(focusComposer ? sessionId : null);
    // Reply lands in the composer, which an open expanded side panel hides (#2845). A closed panel
    // keeps its Expanded preference for its next open.
    if (focusComposer && rightPanelOpen && !isMobile) setRightPanelExpanded(false);
    navigate({ name: "session", id: sessionId });
  }, [isMobile, navigate, rightPanelOpen, setRightPanelExpanded]);
  // The Pinned Summary: docked beside the reader, a drawer, or a phone sheet (#2147). Only one
  // overlay is open at a time, and the right panel is an overlay only on a phone, so there opening
  // either closes the other.
  const pinnedSummary = usePinnedSummaryState(isMobile, {
    onOverlayOpen: () => { if (isMobile) rightPanel.close(); },
  });
  const pinnedSummaryRef = useRef(pinnedSummary);
  pinnedSummaryRef.current = pinnedSummary;
  // Expanded, the side panel fills the session body's place, the summary's drawer included (#2845).
  const sidePanelExpanded = rightPanel.open && rightPanel.expanded && !isMobile;
  useEffect(() => {
    if (sidePanelExpanded) pinnedSummaryRef.current.closeOverlay();
  }, [sidePanelExpanded]);
  const rightPanelWasOpen = useRef(rightPanel.open);
  useEffect(() => {
    const opened = rightPanel.open && !rightPanelWasOpen.current;
    rightPanelWasOpen.current = rightPanel.open;
    if (opened && isMobile) pinnedSummaryRef.current.closeOverlay();
  }, [rightPanel.open, isMobile]);
  // The drawer and the sheet belong to the session they were opened on.
  const pinnedSummarySessionId = view.name === "session" ? view.id : null;
  useEffect(() => pinnedSummaryRef.current.closeOverlay(), [pinnedSummarySessionId]);
  // The breakpoint-specific controls (the instance tile and gear) are unmounted by a
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
  const pendingRouteTitleFocus = useRef(false);
  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    pendingRouteTitleFocus.current = document.activeElement === document.body;
    rescueFocusTo(document.getElementById("page-title"));
  }, [path]);

  // And when the routed session loads or goes (deleted or hidden from another client): a missing
  // session has no panel toggles (#2202), so one that held focus unmounts with it.
  const sessionLoaded = view.name === "session" && activeSession !== undefined;
  const previousSessionLoaded = useRef(sessionLoaded);
  useEffect(() => {
    if (previousSessionLoaded.current === sessionLoaded) return;
    previousSessionLoaded.current = sessionLoaded;
    rescueFocusTo(document.getElementById("page-title"));
  }, [sessionLoaded]);
  const inboxNewSessionPresetRef = useRef<NewSessionPreset | undefined>(undefined);
  const openContextualNewSession = useCallback(() => {
    setDialog({ kind: "session", preset: inboxNewSessionPresetRef.current });
  }, []);
  const setInboxNewSessionPreset = useCallback((preset?: NewSessionPreset) => {
    inboxNewSessionPresetRef.current = preset;
  }, []);
  useNewSessionShortcut(!isMobile, openContextualNewSession);
  // The `b` list/board toggle, shared with the sessions-board e2e harness (see the hook's note).
  useSessionsViewToggleKey(!isMobile, view, navigate);

  const instanceScope = useInstanceScope();
  useSessionsViewModeMemory(view, instanceScope);
  // The palette's Recent section: the sessions opened on this device, newest first (#1978).
  const openedSessionId = view.name === "session" ? view.id : null;
  useEffect(() => {
    if (openedSessionId !== null) recordRecentSession(openedSessionId, instanceScope);
  }, [openedSessionId, instanceScope]);
  const railPreferences = useRailPreferences();
  const visibleRailNames = visibleRailViews(railPreferences, experiments.flags);
  const visibleRailNamesRef = useRef(visibleRailNames);
  visibleRailNamesRef.current = visibleRailNames;

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
      // Dialogs own Escape before the shell's underlying menus, regardless of
      // the order their window listeners were mounted.
      if (document.querySelector('[aria-modal="true"]')) return;
      const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".menu-backdrop"));
      if (backdrops.length) {
        e.preventDefault();
        pickTopmost(backdrops, (el) => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0)?.click();
        return;
      }
      // The summary drawer is the next layer down (§16.2); the phone sheet is a dialog.
      const summary = pinnedSummaryRef.current;
      if (viewRef.current.name === "session" && summary.presentation === "drawer" && summary.open) {
        e.preventDefault();
        summary.closeOverlay();
        summary.toggleRef.current?.focus();
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
        const main = document.querySelector(".main-body");
        if (main) sessionReadingTarget(main)?.focus();
      } else if (owner === "composer") {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        window.requestAnimationFrame(() => {
          const main = document.querySelector(".main-body");
          if (main) sessionReadingTarget(main)?.focus();
        });
      } else if (owner === "session-reading") {
        e.preventDefault();
        // Escaping a session returns to the Sessions mode it was opened from (list or board).
        navigate(sessionsDestination(instanceScope));
      } else if (owner === "inbox-preview") {
        e.preventDefault();
        focusZone(document, "list");
      } else if (owner === "inbox-filter") {
        e.preventDefault();
        window.dispatchEvent(new Event("wollipog:clear-inbox-query"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, instanceScope]);

  useEffect(() => {
    if (isMobile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutLayerActive(document, false, event) || xtermOwnsKey(event.target)) return;
      const digit = bareDigitPressed(event);
      if (digit !== null) {
        // Digits derive solely from the visible rail order (#385): a hidden or experiment-off
        // destination consumes no slot, and a digit past the visible list does nothing rather
        // than firing an unadvertised binding.
        const destination = railViewForDigit(visibleRailNamesRef.current, digit);
        if (destination !== null) {
          event.preventDefault();
          // The Sessions digit opens whichever mode the destination last used.
          navigate(destination === "inbox" ? sessionsDestination(instanceScope) : { name: destination });
          if (destination === "inbox") {
            // Cross-view navigation must mount the Sessions surface before focus can move, while
            // same-view activation still needs to reassert the list/board zone. The shared zone
            // resolver also supplies the accessible empty-state fallback when no cards exist.
            window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
              focusZone(document, "list");
            }));
          }
        }
        return;
      }
      if (matchesShortcut(event, "focus-inbox-search")) {
        event.preventDefault();
        navigate(sessionsDestination(instanceScope));
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>(".inbox-search input")?.focus();
        }));
      } else if (matchesShortcut(event, "focus-next-zone") || matchesShortcut(event, "focus-previous-zone")) {
        event.preventDefault();
        // F6 is the only caller that lights the entered zone (§16.1).
        const zone = cycleFocusZone(document, event.shiftKey ? "previous" : "next");
        if (zone !== null) indicateFocusZone(document, zone);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, navigate, instanceScope]);

  // The global search palette: the rail's Search, the phone app bars' Search icon, and Ctrl/Cmd+K.
  // Null while closed, else the query it opens with (Sessions' Search Transcripts passes one).
  const [palette, setPalette] = useState<string | null>(null);
  const openPalette = useCallback((query?: string) => setPalette(typeof query === "string" ? query : ""), []);
  const togglePalette = useCallback(() => setPalette((current) => current === null ? "" : null), []);
  useSearchShortcut(togglePalette);

  // `?` opens the discoverable reference without stealing punctuation from editors or xterm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(e, "shortcut-reference") || e.defaultPrevented || isEditableShortcutTarget(e.target)) return;
      if (shortcutLayerActive(document, false, e)) return;
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
      if (e.defaultPrevented || shortcutLayerActive(document, false, e) || xtermOwnsKey(e.target) || view.name !== "session") return;
      // Go to File: opens the panel on Files when needed and never closes it (#2852).
      if (matchesShortcut(e, "open-files")) {
        e.preventDefault();
        if (filesSupported) openGoToFile(rightPanel);
        else rightPanel.show("launcher");
      }
      if (matchesShortcut(e, "open-review")) {
        e.preventDefault();
        rightPanel.openMode("review");
      }
      // Side Chat: opens the panel on it with focus in its message field, never closes it (#2862).
      if (matchesShortcut(e, "open-side-chat")) {
        e.preventDefault();
        openSideChat(rightPanel);
      }
      if (matchesShortcut(e, "toggle-terminal")) {
        e.preventDefault();
        if (terminalSupported) setDockVisible((v) => !v);
        else rightPanel.show("launcher");
      }
      // The Side Panel toggle's chord: closing keeps the tool, so it reopens on the last one (#1260).
      // Opening lands on the tool switcher, so the arrow keys reach every other tool (#2843).
      if (matchesShortcut(e, "toggle-side-panel") && activeSession) {
        e.preventDefault();
        const opening = !rightPanel.open;
        rightPanel.toggle();
        if (opening) {
          window.requestAnimationFrame(() => {
            document.querySelector<HTMLElement>("#right-panel .rpanel-switcher")?.focus();
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Connections shows a dot only while a machine needs the user, never a count of online ones (#1967).
  const railMachines = useMemo(
    () => machineAttention(runners.values(), sessions.values()),
    [runners, sessions],
  );
  const activeSessions = useMemo(
    () => [...sessions.values()].filter((session) =>
      sessionVisibleForReminderMode(session, reminders.get(session.id), "ordinary")),
    [reminders, sessions],
  );
  const blockedSessions = useMemo(
    () => activeSessions.filter(isInboxBlocked).length,
    [activeSessions],
  );
  const stalledSessions = useMemo(
    () => activeSessions.filter((session) => stalledSessionIds.has(session.id)).length,
    [activeSessions, stalledRevision, stalledSessionIds],
  );

  // Codex-style session control cluster. Desktop includes the host-side Open destination picker
  // inside SessionDetail. Mobile keeps only panel toggles in the app topbar: launching an editor
  // or file manager on the runner host is intentionally not a phone action.
  // Only a loaded session has panels: a missing one's page is a placeholder (#2202).
  const sessionPanelControls = view.name === "session" && activeSession ? (
    <>
      {/* Keyed by session: transient state (open menu, in-flight launch)
          must not leak from one session's bar into the next. */}
      {!isMobile && (
        <>
          <EditorSelect key={view.id} sessionId={view.id} />
          <span className="detail-actions-divider" aria-hidden="true" />
        </>
      )}
      <SessionPanelToggles
        small={isMobile}
        pinnedSummaryOpen={pinnedSummary.open && !sidePanelExpanded}
        pinnedSummaryRef={pinnedSummary.toggleRef}
        onPinnedSummary={() => {
          // An expanded side panel hides the session body the summary lives in (#2845): the toggle
          // brings the body back with the summary in it. The hidden body keeps its docked width, so
          // the summary already docks or opens as a drawer as it will once restored.
          if (sidePanelExpanded) {
            rightPanel.setExpanded(false);
            if (!pinnedSummary.open) pinnedSummary.toggle();
            return;
          }
          pinnedSummary.toggle();
        }}
        terminalSupported={terminalSupported}
        terminalOpen={dockVisible}
        onTerminal={() => {
          if (terminalSupported) setDockVisible((v) => !v);
          else rightPanel.show("launcher");
        }}
        sidePanelOpen={rightPanel.open}
        onSidePanel={rightPanel.toggle}
      />
    </>
  ) : null;

  const dialogKey = dialog?.kind ?? (palette !== null ? "search" : shortcutReferenceOpen ? "shortcuts" : "closed");
  const dialogTitle = dialog?.kind === "session" ? "New Session"
    : dialog?.kind === "run" ? "New Run" : dialog?.kind === "pod" ? "New Pod"
    : palette !== null ? "Search" : "Keyboard Shortcuts";
  const shell = (
    <div className={`app${rightPanel.dragging ? " panel-dragging" : ""}`}>
      <Rail
        view={view}
        blockedCount={blockedSessions}
        stalledCount={stalledSessions}
        machines={railMachines}
        onNavigate={navigate}
        {...(isMobile ? {} : {
          // The desktop app's tile; the browser build keeps the brand (§4.1).
          instanceControl: desktopMultiInstance
            ? <InstanceSelector labelled={railPreferences.labels} />
            : undefined,
          settingsControl: <SettingsTrigger active={view.name === "settings"} onOpen={() => navigate({ name: "settings" })} />,
          onSearch: openPalette,
        })}
      />
      <main className="main">
        {/* Only the phone Session route keeps the app-level bar: destinations draw their own page
            header and entity pages their own detail bar (docs/design-system.md §4.2, §4.3), and
            the desktop Session bar lives in SessionDetail. While a phone's side panel is open it
            covers this bar with its own, which leads with Back to Session (#2843). */}
        {view.name === "session" && isMobile && !(rightPanel.open && activeSession) && (
          <Header
            view={view}
            sessionActions={sessionPanelControls}
            sessionTitle={activeSession
              ? sessionDisplayTitle(activeSession.title) || "Session"
              : routedSessionPlaceholder(view.id, routedSessionLookup, conn, snapshotLoaded).title}
            onSessionBack={() => navigate(sessionsDestination(instanceScope))}
          />
        )}
        {/* Once a 1008 latched authRequired, the pairing card stays mounted through the
            background retries' connecting/offline states so the draft is never wiped. */}
        {authRequired && conn !== "online" ? (
          instances.activeProfile.kind === "remote"
            ? <RemoteInstanceBanner authenticationRequired />
            : <PairingBanner connecting={conn === "connecting"} />
        ) : (
          offlineHeld && (
            instances.activeProfile.kind === "remote"
              ? <RemoteInstanceBanner />
              : <OfflineBanner connecting={conn === "connecting"} onRetryNow={reconnectNow} />
          )
        )}
        {/* Every route's page root is the `main` F6 zone; master-detail pages mark their own list
            and detail panes inside it (focus-zones.ts). */}
        <div
          className={`main-body${view.name === "inbox" || view.name === "session" || view.name === "board" ? " inbox-main-body" : ""}`}
          data-focus-zone="main"
          tabIndex={-1}
        >
          <ViewerIdentityProvider>
          <GovernancePolicyNamesProvider>
          <SearchPaletteContext.Provider value={openPalette}>
          <AppBarSearchProvider onSearch={isMobile ? openPalette : undefined}>
          <ErrorBoundary
            name={viewSubjectName(view)}
            resetKey={viewPath(view)}
            // The Session's own bar owns its title (the phone top bar sits outside this boundary).
            pageTitle={view.name === "session" ? undefined : viewTitle(view, entityTitle)}
          >
          <Suspense fallback={<LazyRouteLoading title={viewTitle(view, entityTitle)} pending={pendingRouteTitleFocus} />}>
          <LazyRouteFocusRecovery path={path} pending={pendingRouteTitleFocus} />
          {(view.name === "inbox" || view.name === "session" || view.name === "board") && (
            /* InboxView draws the Sessions page header, whose controls are its state (#2159). */
            <div className="page full fill">
            <InboxView
              viewMode={view.name === "board" ? "board" : "list"}
              routeSplit={view.name === "inbox" || view.name === "board" ? view.split : undefined}
              expandedSessionId={view.name === "session" ? view.id : null}
              sourceLocation={view.name === "session" ? view.location : undefined}
              attentionTarget={view.name === "session" ? view.attention : undefined}
              topbarControls={!isMobile ? sessionPanelControls : undefined}
              rightPanel={rightPanel}
              onOpenTerminal={() => {
                if (terminalSupported) setDockVisible(true);
              }}
              pinnedSummary={pinnedSummary}
              focusComposerSessionId={composerFocusSessionId}
              onComposerFocusConsumed={() => setComposerFocusSessionId(null)}
              onExpand={expandSession}
              onCollapse={() => navigate(sessionsDestination(instanceScope))}
              onNewSession={(preset) => setDialog({ kind: "session", preset })}
              onShortcutNewSessionPresetChange={setInboxNewSessionPreset}
              onOpenShortcuts={openShortcutReference}
            />
            </div>
          )}
          {view.name === "runners" && <RunnersView />}
          {/* A route into a feature this device has switched off keeps its page and says so:
              removing the branch entirely would make a bookmarked /runs a silent Inbox redirect. */}
          {(view.name === "runs" || view.name === "run") && (
            <ExperimentGate experiment="multiAgent" pageTitle={viewTitle(view, entityTitle)} onOpenSettings={openExperimentalSettings}>
              {view.name === "runs" ? <RunsView onNewRun={() => setDialog({ kind: "run" })} /> : <RunDetail runId={view.id} />}
            </ExperimentGate>
          )}
          {(view.name === "pods" || view.name === "pod") && (
            <ExperimentGate experiment="pods" pageTitle={viewTitle(view, entityTitle)} onOpenSettings={openExperimentalSettings}>
              {view.name === "pods" ? <PodsView onNewPod={() => setDialog({ kind: "pod" })} /> : <PodDetail podId={view.id} />}
            </ExperimentGate>
          )}
          {view.name === "automations" && <AutomationsView />}
          {view.name === "skills" && <SkillsView route={view} />}
          {view.name === "usage" && <UsageView />}
          {view.name === "archived" && <ArchivedSessionsView />}
          {view.name === "settings" && (
            <SettingsView
              section={view.section ?? "appearance"}
              onNavigate={navigate}
              onOpenShortcuts={openShortcutReference}
              panels={{
                appearance: (
                  <>
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
                  {/* The rail's visibility/order editor (#385) lives with the other chrome
                      preferences rather than as its own route: it is one compact group. */}
                  <NavigationRailPanel />
                  </>
                ),
                notifications: <NotificationsPanel notify={notify} push={push} />,
                keyboard: (
                  <KeyboardPanel
                    shortcutLabel={`Reference · ${shortcutDisplay("shortcut-reference")}`}
                    onOpenShortcuts={openShortcutReference}
                  />
                ),
                behavior: (
                  <BehaviorPanel
                    agentHarnessDefaults={<AgentHarnessDefaultsPanel discoveryRevision={runners} />}
                    sessionNaming={<SessionNamingPanel />}
                  />
                ),
                approvals: <ApprovalsPanel policyId={view.policyId} />,
                orchestrator: <OrchestratorSettingsPanel discoveryRevision={runners} />,
                network: <NetworkPanel tailnet={tailnet} />,
                experimental: (
                  <ExperimentalPanel
                    flags={experiments.flags}
                    onToggle={experiments.setFlag}
                  />
                ),
                about: <AboutPanel update={desktopUpdate} />,
              }}
            />
          )}
          {view.name === "projects" && (
            <ProjectsView
              selectedProjectId={view.id}
              onNewSession={(preset) => setDialog({ kind: "session", preset })}
            />
          )}
          </Suspense>
          </ErrorBoundary>
          </AppBarSearchProvider>
          </SearchPaletteContext.Provider>
          </GovernancePolicyNamesProvider>
          </ViewerIdentityProvider>
        </div>
        {/* Bottom shell dock: session-scoped terminals in the compact desktop layout. Mounted only
            while toggled on; keyed by session so tab selection never bleeds across navigations. */}
        {view.name === "session" && dockVisible && terminalSupported && (
          <ErrorBoundary name="Terminal" resetKey={view.id}>
          <Suspense fallback={<State variant="loading" compact>Loading terminal…</State>}>
          <ShellDock
            key={`dock-${view.id}`}
            sessionId={view.id}
            onClose={() => setDockVisible(false)}
            theme={theme.resolved}
            scheme={theme.scheme}
          />
          </Suspense>
          </ErrorBoundary>
        )}
      </main>

      {dialogKey !== "closed" && <LazyDialogBoundary key={dialogKey} title={dialogTitle}
        onClose={() => { setDialog(null); setPalette(null); if (shortcutReferenceOpen) closeShortcutReference(); }}>
      {dialog?.kind === "session" && (
        <NewSessionDialog
          onClose={() => setDialog(null)}
          onOpenTerminal={() => setDockVisible(true)}
          preset={dialog.preset}
        />
      )}
      {dialog?.kind === "run" && <NewRunDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "pod" && <NewPodDialog onClose={() => setDialog(null)} />}
      {palette !== null && <CommandPalette initialQuery={palette} onClose={() => setPalette(null)} />}
      {shortcutReferenceOpen && (
        <ShortcutReference
          onClose={closeShortcutReference}
          scope={shortcutScopeForFocus({
            viewName: view.name,
            activeElement: shortcutReferenceOpener,
            sessionReading: view.name === "session" && !isMobile,
          })}
          sessionOpen={view.name === "session"}
          terminalSupported={terminalSupported}
          filesSupported={filesSupported}
          conversationSteeringSupported={conversationSteeringSupported}
          turnInterruptionSupported={turnInterruptionSupported}
        />
      )}
      </LazyDialogBoundary>}
    </div>
  );
  // The rail tile and the Instances card read the banner's truth from here, so they never disagree.
  return <ActiveInstanceConnectionProvider value={instanceConnection}>{shell}</ActiveInstanceConnectionProvider>;
}

export function Header({
  view,
  sessionActions,
  sessionTitle,
  onSessionBack,
}: {
  view: View;
  /** Session panel-control cluster rendered here only on phone widths. Settings is not here: it is
   * a row in the rail's More sheet, and the phone layout has no instance switcher (#1970). */
  sessionActions?: React.ReactNode;
  sessionTitle?: string;
  onSessionBack?: () => void;
}) {
  const title = viewTitle(view);
  return (
    <header className="topbar">
      {/* Focusable only programmatically: the rescue below moves focus here when a layout swap
          drops it, so the next Tab continues from the page rather than from the document top. */}
      {view.name === "session" ? (
        <>
          <button
            type="button"
            className="icon-btn sm mobile-session-back"
            onClick={onSessionBack}
            title={backLabel("inbox")}
            aria-label={backLabel("inbox")}
          >
            <ChevronLeftIcon size={20} />
          </button>
          <h1 id="page-title" tabIndex={-1} title={sessionTitle}>{sessionTitle ?? title}</h1>
        </>
      ) : (
        <h1 id="page-title" tabIndex={-1}>{title}</h1>
      )}
      {view.name === "session" && sessionActions && (
        <div className="topbar-actions topbar-mobile-controls">{sessionActions}</div>
      )}
    </header>
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
