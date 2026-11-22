import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { InstanceScopeProvider } from "../instance-scope.js";
import { AssistantConnectionsGroup } from "../components/AssistantConnectionsGroup.js";
import { AssistantConnectionsPages } from "../components/AssistantConnectionsPages.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { viewFromPath, viewPath, type View } from "../navigation.js";
import "../styles.css";

// Playwright provides ephemeral synthetic owner auth in memory; never real account credentials.
const setup = (window as unknown as {assistantTest: {origin: string; ownerCredential: string}}).assistantTest;
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
const readRoute = () => viewFromPath(new URLSearchParams(location.search).get("route") ?? "/settings/assistant");

function Harness() {
  const [active, setActive] = useState(setup);
  const [view, setView] = useState(readRoute);
  const navigate = (next: View, options?: { replace?: boolean }) => {
    const url = new URL(location.href);
    url.searchParams.set("route", viewPath(next));
    if (options?.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setView(next);
  };
  useEffect(() => {
    const change = (event: Event) => setActive((event as CustomEvent<typeof setup>).detail);
    const pop = () => setView(readRoute());
    window.addEventListener("assistant-test-switch", change);
    window.addEventListener("popstate", pop);
    return () => {
      window.removeEventListener("assistant-test-switch", change);
      window.removeEventListener("popstate", pop);
    };
  }, []);
  const client = useMemo(() => createApiClient({instanceId: active.origin, publicOrigin: active.origin, close() {}, request: (path, init) => fetch(new URL(path, active.origin), {...init, headers: {...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${active.ownerCredential}`}})}), [active]);
  const route = view?.name === "settings" ? view.assistantConnections : undefined;
  return (
    <InstanceScopeProvider instanceScope={active.origin}>
      <ApiProvider client={client}>
        <FeedbackProvider key={active.origin}>
          <div className="app"><main className="main"><div className="main-body">
            {route ? <AssistantConnectionsPages route={route} onNavigate={navigate} /> : (
              <section className="page settings-panel">
                <h1>Assistant</h1>
                <AssistantConnectionsGroup onNavigate={navigate} />
              </section>
            )}
          </div></main></div>
        </FeedbackProvider>
      </ApiProvider>
    </InstanceScopeProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
