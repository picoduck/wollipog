import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { AssistantConnectionsPanel } from "../components/AssistantConnectionsPanel.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import "../styles.css";

// Playwright provides ephemeral synthetic owner auth in memory; never real account credentials.
const setup = (window as unknown as {assistantTest: {origin: string; ownerCredential: string}}).assistantTest;
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
function Harness() {
  const [active, setActive] = useState(setup);
  useEffect(() => {
    const change = (event: Event) => setActive((event as CustomEvent<typeof setup>).detail);
    window.addEventListener("assistant-test-switch", change);
    return () => window.removeEventListener("assistant-test-switch", change);
  }, []);
  const client = useMemo(() => createApiClient({instanceId: active.origin, publicOrigin: active.origin, close() {}, request: (path, init) => fetch(new URL(path, active.origin), {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${active.ownerCredential}`}})}), [active]);
  return <InstanceScopeProvider instanceScope={active.origin}><ApiProvider client={client}><FeedbackProvider><div className="app"><main className="main"><div className="main-body"><section className="settings-panel"><h1>Network</h1><AssistantConnectionsPanel /></section></div></main></div></FeedbackProvider></ApiProvider></InstanceScopeProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
