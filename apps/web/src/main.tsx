import React from "react";
import { createRoot } from "react-dom/client";
import { installMobileViewportFallback } from "./mobile-viewport.js";
import { App } from "./App.js";
import { SharedTranscript } from "./components/SharedTranscript.js";
import { adoptPairingFragment } from "./device-token.js";
import { adoptManagedDesktopPairing } from "./desktop-local-pairing.js";
import { registerServiceWorker } from "./pwa.js";
import { adoptTranscriptShareFragment } from "./transcript-share-client.js";
import {
  adoptLegacyNavigationFragment,
  isolatedNotificationNavigationHandler,
  replaceIsolatedShareWithDashboard,
} from "./navigation.js";
import { ThemeProvider } from "./components/ThemeProvider.js";
import { DesktopExternalLinkRouter } from "./components/DesktopExternalLinkRouter.js";
import { FeedbackProvider } from "./components/FeedbackProvider.js";
import "./styles.css";

async function bootstrap(): Promise<void> {
  // Before anything renders or connects: a `#pair=<token>` link stores its device token and
  // scrubs it from the address bar, so the very first API/WS calls already authenticate.
  const shared = adoptTranscriptShareFragment();
  if (shared.requested && "serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", isolatedNotificationNavigationHandler((path) => {
      replaceIsolatedShareWithDashboard(window, path);
    }));
  }
  // Installability + (soon) push. Never affects how the app loads — sw.js has no fetch handler.
  if (!shared.requested) {
    // The Tauri shell owns its local sidecar and adopts that protected credential before any
    // component can create an API client or /ui socket. An explicit #pair= fragment still runs
    // afterward and wins, which keeps manual recovery deterministic.
    await adoptManagedDesktopPairing().catch((error) => {
      console.error("[desktop] local pairing adoption failed", error);
      return false;
    });
    adoptPairingFragment();
    adoptLegacyNavigationFragment();
    registerServiceWorker();
  }

  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root element");

  // Fallback for browsers that ignore interactive-widget=resizes-content; a no-op where the
  // layout viewport already tracks the keyboard. Installed for the app's lifetime.
  installMobileViewportFallback();

  createRoot(root).render(
    <React.StrictMode>
      <ThemeProvider>
        {shared.requested ? (
          <FeedbackProvider>
            <DesktopExternalLinkRouter />
            <SharedTranscript token={shared.token} />
          </FeedbackProvider>
        ) : <App />}
      </ThemeProvider>
    </React.StrictMode>,
  );
}

void bootstrap();
