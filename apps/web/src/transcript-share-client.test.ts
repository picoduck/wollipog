import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptTranscriptShareFragment,
  parseTranscriptShareFragment,
  reachableTranscriptShareOrigin,
  transcriptShareRequest,
  transcriptShareUrl,
} from "./transcript-share-client.js";

const TOKEN = "a".repeat(20) + "-B_" + "c".repeat(20);
const NEWER_TOKEN = "z".repeat(43);

function shareWindow(hash: string, state: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const replacements: Array<{ state: unknown; url?: string | URL | null }> = [];
  const history = {
    state,
    replaceState(next: unknown, _unused: string, url?: string | URL | null) {
      history.state = next;
      replacements.push({ state: next, ...(url === undefined ? {} : { url }) });
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { hash, pathname: "/shared/transcript", search: "?theme=dark" },
      history,
    },
  });
  return {
    history,
    replacements,
    restore() {
      if (original) Object.defineProperty(globalThis, "window", original);
      else delete (globalThis as { window?: unknown }).window;
    },
  };
}

test("share fragments are exact, bounded, and distinct from pairing", () => {
  assert.equal(TOKEN.length, 43);
  assert.deepEqual(parseTranscriptShareFragment(`#share=${TOKEN}`), { requested: true, token: TOKEN });
  assert.deepEqual(parseTranscriptShareFragment(`share=${TOKEN}`), { requested: true, token: TOKEN });
  assert.deepEqual(parseTranscriptShareFragment(""), { requested: false, token: null });
  assert.deepEqual(parseTranscriptShareFragment(`#pair=${TOKEN}`), { requested: false, token: null });
  assert.deepEqual(parseTranscriptShareFragment("#share=short"), { requested: true, token: null });
  assert.deepEqual(parseTranscriptShareFragment(`#share=${TOKEN}&extra=1`), { requested: true, token: null });
  assert.deepEqual(parseTranscriptShareFragment(`#share=${TOKEN}#extra`), { requested: true, token: null });
  assert.deepEqual(parseTranscriptShareFragment(`#share=${"a".repeat(300)}`), { requested: true, token: null });
});

test("legacy history capabilities copy forward under only the Wollipog key", () => {
  const harness = shareWindow("", { mamTranscriptShareToken: TOKEN, routeState: "preserved" });
  try {
    assert.deepEqual(adoptTranscriptShareFragment(), { requested: true, token: TOKEN });
    assert.deepEqual(harness.history.state, {
      routeState: "preserved",
      wollipogTranscriptShareToken: TOKEN,
    });
    assert.equal(harness.replacements.length, 1);
  } finally {
    harness.restore();
  }
});

test("a current Wollipog history capability remains readable and new-only", () => {
  const harness = shareWindow("", {
    wollipogTranscriptShareToken: NEWER_TOKEN,
    routeState: "preserved",
  });
  try {
    assert.deepEqual(adoptTranscriptShareFragment(), { requested: true, token: NEWER_TOKEN });
    assert.deepEqual(harness.history.state, {
      routeState: "preserved",
      wollipogTranscriptShareToken: NEWER_TOKEN,
    });
    assert.equal("mamTranscriptShareToken" in (harness.history.state as object), false);
  } finally {
    harness.restore();
  }
});

test("the Wollipog history capability wins a conflict and scrubs the legacy key", () => {
  const harness = shareWindow("", {
    wollipogTranscriptShareToken: NEWER_TOKEN,
    mamTranscriptShareToken: TOKEN,
    routeState: "preserved",
  });
  try {
    assert.deepEqual(adoptTranscriptShareFragment(), { requested: true, token: NEWER_TOKEN });
    assert.deepEqual(harness.history.state, {
      routeState: "preserved",
      wollipogTranscriptShareToken: NEWER_TOKEN,
    });
  } finally {
    harness.restore();
  }
});

test("an invalid share fragment clears both history keys and leaves no address-bar capability", () => {
  const harness = shareWindow("#share=short", {
    wollipogTranscriptShareToken: NEWER_TOKEN,
    mamTranscriptShareToken: TOKEN,
    routeState: "preserved",
  });
  try {
    assert.deepEqual(adoptTranscriptShareFragment(), { requested: true, token: null });
    assert.deepEqual(harness.history.state, { routeState: "preserved" });
    assert.deepEqual(harness.replacements, [{
      state: { routeState: "preserved" },
      url: "/shared/transcript?theme=dark",
    }]);
  } finally {
    harness.restore();
  }
});

test("a fragment writes only the Wollipog key before removing the capability from the address bar", () => {
  const harness = shareWindow(`#share=${NEWER_TOKEN}`, {
    mamTranscriptShareToken: TOKEN,
    routeState: "preserved",
  });
  try {
    assert.deepEqual(adoptTranscriptShareFragment(), { requested: true, token: NEWER_TOKEN });
    assert.deepEqual(harness.history.state, {
      routeState: "preserved",
      wollipogTranscriptShareToken: NEWER_TOKEN,
    });
    const replacement = harness.replacements[0]!;
    assert.equal(String(replacement.url).includes(NEWER_TOKEN), false);
    assert.equal(String(replacement.url).includes("#share="), false);
    assert.equal("mamTranscriptShareToken" in (replacement.state as object), false);
  } finally {
    harness.restore();
  }
});

test("public requests keep the capability out of URLs and use the independent scheme", () => {
  const request = transcriptShareRequest("https://wollipog.example", TOKEN);
  assert.equal(request.url, "https://wollipog.example/api/public/transcript-share");
  assert.equal(request.url.includes(TOKEN), false);
  assert.deepEqual(request.init.headers, { authorization: `Wollipog-Share ${TOKEN}`, accept: "application/json" });
  assert.equal(JSON.stringify(request.init.headers).includes("MAM-Share"), false);
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.cache, "no-store");
});

test("share links are browser-origin fragments, never query credentials", () => {
  const url = transcriptShareUrl("https://wollipog.example/", TOKEN);
  assert.equal(url, `https://wollipog.example/#share=${TOKEN}`);
  assert.equal(new URL(url).search, "");
  assert.equal(new URL(url).hash, `#share=${TOKEN}`);
});

test("share origin selection refuses loopback, wildcard, Tauri, and malformed destinations", () => {
  assert.equal(reachableTranscriptShareOrigin("https://wollipog.example", "http://127.0.0.1:4317", true), "https://wollipog.example");
  assert.equal(reachableTranscriptShareOrigin("http://localhost:5173", "http://10.0.0.8:4317", false), "http://10.0.0.8:4317");
  for (const origin of [
    "http://127.0.0.1:4317", "http://127.8.9.10:4317", "http://localhost:4317",
    "http://localhost.:4317", "https://wollipog.localhost", "https://tauri.localhost",
    "http://[::1]:4317", "http://[::ffff:127.0.0.1]:4317", "http://[::ffff:0.0.0.0]:4317",
    "http://0.0.0.0:4317", "tauri://localhost", "not a url",
  ]) {
    assert.equal(reachableTranscriptShareOrigin("https://tauri.localhost", origin, false), null, origin);
  }
});
