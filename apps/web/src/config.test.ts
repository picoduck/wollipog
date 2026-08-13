import assert from "node:assert/strict";
import { test } from "node:test";
import { hasSameOriginMarker, resolveDashboardOrigin } from "./config.js";

test("same-origin serving accepts renamed and legacy bundle markers during the compatibility window", () => {
  assert.equal(hasSameOriginMarker({ __WOLLIPOG_SAME_ORIGIN__: 1 }), true);
  assert.equal(hasSameOriginMarker({ __MAM_SAME_ORIGIN__: 1 }), true);
  assert.equal(hasSameOriginMarker({ __WOLLIPOG_SAME_ORIGIN__: 0, __MAM_SAME_ORIGIN__: 0 }), false);
  assert.equal(hasSameOriginMarker(undefined), false);
});

test("browser-hosted dashboards use their reachable page origin", () => {
  assert.equal(resolveDashboardOrigin({
    pageOrigin: "https://manager.tailnet.test:4317/path", pageHostname: "manager.tailnet.test", sameOriginServed: true,
  }), "https://manager.tailnet.test:4317");
  assert.equal(resolveDashboardOrigin({
    pageOrigin: "http://localhost:5173", pageHostname: "localhost", sameOriginServed: false,
  }), "http://localhost:5173");
});

test("Tauri requires an explicit external dashboard origin", () => {
  const base = { pageOrigin: "http://tauri.localhost", pageHostname: "tauri.localhost", sameOriginServed: false };
  assert.equal(resolveDashboardOrigin(base), null);
  assert.equal(resolveDashboardOrigin({ ...base, configured: "https://manager.example.test/ui?ignored=1" }),
    "https://manager.example.test");
  assert.equal(resolveDashboardOrigin({ ...base, configured: "ftp://manager.example.test" }), null);
  assert.equal(resolveDashboardOrigin({ ...base, configured: ["https://user:", "secret@manager.example.test"].join("") }), null);
  assert.equal(resolveDashboardOrigin({
    pageOrigin: "file://local/dashboard", pageHostname: "", sameOriginServed: false,
  }), null);
});
