import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi } from "@wollipog/protocol";
import { SettingsTrigger } from "../components/SettingsTrigger.js";
import { ShortcutReference } from "../components/ShortcutReference.js";
import { Select } from "../components/ui/ChoiceControls.js";
import type { View, ViewNavigation } from "../navigation.js";
import { handleSettingsNavigationKey } from "../settings-navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

const PAGE = "/settings-navigation-e2e.html";
const THEME_OPTIONS = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
] as const;

function fixtureView(): View {
  const params = new URLSearchParams(window.location.search);
  const entry = params.get("entry");
  if (entry === "settings") {
    const section = params.get("section");
    if (section === "appearance" || section === "notifications" || section === "keyboard" ||
        section === "behavior" || section === "network" || section === "about") {
      return { name: "settings", section };
    }
    return { name: "settings", section: "keyboard" };
  }
  if (entry === "session") return { name: "session", id: params.get("id") || "session-alpha" };
  if (entry === "project") return { name: "projects", id: params.get("id") || "project-alpha" };
  if (entry === "usage") return { name: "usage" };
  return { name: "inbox" };
}

function fixtureUrl(view: View): string {
  if (view.name === "settings") return `${PAGE}?entry=settings&section=${view.section ?? "appearance"}`;
  if (view.name === "session") return `${PAGE}?entry=session&id=${encodeURIComponent(view.id)}`;
  if (view.name === "projects") return `${PAGE}?entry=project&id=${encodeURIComponent(view.id ?? "")}`;
  if (view.name === "usage") return `${PAGE}?entry=usage`;
  return PAGE;
}

const navigation: ViewNavigation = {
  current: fixtureView,
  push(view) {
    window.history.pushState(null, "", fixtureUrl(view));
  },
  listen(onView) {
    const listener = () => onView(fixtureView());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  },
};

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      this.onopen?.();
      const snapshot: ControlPlaneToUi = {
        type: "snapshot",
        runners: [],
        boxes: [],
        sessions: [],
        runs: [],
        pods: [],
      };
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "settings-navigation-e2e",
  runtimeKey: "settings-navigation-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

function viewLabel(view: View): string {
  if (view.name === "session") return `Session: ${view.id}`;
  if (view.name === "projects") return `Project: ${view.id ?? "All"}`;
  if (view.name === "settings") return `Settings: ${view.section ?? "appearance"}`;
  if (view.name === "usage") return "Usage";
  return view.name === "inbox" ? "Inbox" : view.name;
}

function Surface() {
  const { navigate } = useStoreActions();
  const view = useStoreSelector((state) => state.view);
  const settingsReturnView = useStoreSelector((state) => state.settingsReturnView);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [theme, setTheme] = useState<"system" | "dark">("system");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      handleSettingsNavigationKey(event, {
        document,
        viewName: view.name,
        settingsReturnView,
        navigate,
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, settingsReturnView, view.name]);

  return (
    <div className="app">
      <aside>
        <button type="button" onClick={() => navigate({ name: "inbox" })}>Open Inbox Origin</button>
        <button type="button" onClick={() => navigate({ name: "session", id: "session-alpha" })}>Open Session Origin</button>
        <button type="button" onClick={() => navigate({ name: "projects", id: "project-alpha" })}>Open Project Origin</button>
        <button type="button" onClick={() => navigate({ name: "usage" })}>Open Usage Origin</button>
        <SettingsTrigger active={view.name === "settings"} onOpen={() => navigate({ name: "settings" })} />
      </aside>
      <main>
        <h1 data-testid="view-label">{viewLabel(view)}</h1>
        {view.name === "settings" ? (
          <div className="settings-view">
            <label>
              Settings Search
              <input aria-label="Settings Search" />
            </label>
            <button type="button" onClick={() => navigate({ name: "settings", section: "network" })}>
              Open Network Section
            </button>
            <Select label="Theme" options={THEME_OPTIONS} value={theme} onChange={setTheme} />
            <button type="button" onClick={() => setShortcutsOpen(true)}>Open Keyboard Shortcuts</button>
          </div>
        ) : (
          <label>
            Origin Editor
            <input aria-label="Origin Editor" />
          </label>
        )}
      </main>
      {shortcutsOpen && (
        <ShortcutReference
          onClose={() => setShortcutsOpen(false)}
          sessionOpen={view.name === "session"}
          terminalSupported
          filesSupported
          conversationSteeringSupported
          turnInterruptionSupported
        />
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
  <React.StrictMode>
    <StoreProvider connection={connection} navigation={navigation}>
      <Surface />
    </StoreProvider>
  </React.StrictMode>,
);
