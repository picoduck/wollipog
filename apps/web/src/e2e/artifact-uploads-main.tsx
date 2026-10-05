import React from "react";
import { createRoot } from "react-dom/client";
import type { SessionView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import type { View, ViewNavigation } from "../navigation.js";
import type { UiConnectionRuntime } from "../ui-transport.js";
import { BrowserPanel } from "../components/BrowserPanel.js";
import { BehaviorPanel, SettingsView } from "../components/SettingsView.js";
import "../styles.css";

const PAGE = "/artifact-uploads-e2e.html";
function current(): View {
  return new URLSearchParams(location.search).get("entry") === "settings"
    ? { name: "settings", section: "behavior" } : { name: "session", id: "synthetic-artifacts" };
}
const navigation: ViewNavigation = {
  current,
  push(view) { history.pushState(null, "", `${PAGE}?entry=${view.name === "settings" ? "settings" : "session"}`); },
  listen(onView) {
    const listener = () => onView(current()); window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  },
};
const connection: UiConnectionRuntime = {
  instanceId: "synthetic-artifacts", runtimeKey: "synthetic-artifacts:1", close() {},
  createSocket() {
    const socket = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
    return socket;
  },
};
const client = createApiClient({
  instanceId: "synthetic-artifacts", publicOrigin: location.origin, close() {},
  async request(path, init) {
    if (path === "/api/artifact-upload-settings") {
      if (new URLSearchParams(location.search).has("unsupported")) return new Response("{}", { status: 404 });
      if (init?.method === "PUT") localStorage.setItem("synthetic-artifact-upload-preference", JSON.parse(String(init.body)).preference);
      return Response.json({ preference: localStorage.getItem("synthetic-artifact-upload-preference") ?? "manual" });
    }
    if (path.includes("/artifacts")) return Response.json({ artifacts: [] });
    return Response.json({ error: "Not supported in synthetic fixture" }, { status: 404 });
  },
});
function Surface() {
  const { navigate } = useStoreActions();
  const view = useStoreSelector((state) => state.view);
  return <div className="app" style={{ height: "100dvh", display: "block" }}><main className="main-body" style={{ height: "100%" }}>
    {view.name === "settings" ? <SettingsView section="behavior" onNavigate={navigate} onOpenShortcuts={() => undefined} panels={{
      appearance: null, notifications: null, keyboard: null, behavior: <BehaviorPanel />, approvals: null,
      orchestrator: null, network: null, experimental: null, about: null,
    }} /> : <section style={{ padding: 16, maxWidth: 420 }}><h1>Session Artifacts</h1><BrowserPanel session={{ id: "synthetic-artifacts" } as SessionView} /></section>}
  </main></div>;
}
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark";
createRoot(document.getElementById("root")!).render(<React.StrictMode><InstanceScopeProvider instanceScope="synthetic-artifacts"><ApiProvider client={client}><StoreProvider connection={connection} navigation={navigation}><Surface /></StoreProvider></ApiProvider></InstanceScopeProvider></React.StrictMode>);
