import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionStatus } from "@wollipog/protocol";
import { createCloseGuardLinks, WORK_IN_FLIGHT, WORK_IN_FLIGHT_STATUSES } from "./desktop-close-guard.js";
import { CLOSE_WOULD_STOP_WORK, QUIT_AFTER_CONFIRMATION } from "./components/DesktopCloseGuard.js";

/**
 * The two things §23.1 needs the dashboard and the shell to agree about.
 *
 * The shell decides at close time by asking the local control plane, so nothing here counts
 * anything. What is left is agreement: the same statuses on both sides, and the same event name.
 * Both are the kind of drift that makes a feature silently do nothing rather than fail loudly.
 */

const rust = readFileSync(
  fileURLToPath(new URL("../../desktop/src-tauri/src/lib.rs", import.meta.url)),
  "utf8",
);
const managedRoutes = readFileSync(
  fileURLToPath(new URL("../../control-plane/src/managed-desktop-routes.ts", import.meta.url)),
  "utf8",
);

test("every session status is classified, and the busy ones are the ones with a turn open", () => {
  // The map is total by construction — this checks the CLASSIFICATION, which types cannot.
  assert.deepEqual(
    [...WORK_IN_FLIGHT_STATUSES].sort(),
    ["input_required", "queued", "running", "starting"],
    "a status counted as busy when it is not teaches the user to dismiss the warning; the reverse loses work",
  );
});

test("the shell's busy statuses are exactly the ones the protocol says are busy", () => {
  // The shell holds this list in Rust and the protocol union lives in TypeScript, so nothing but a
  // check like this can stop them drifting. A status added to the protocol and not to the shell is
  // work the shell will let the user destroy without a word.
  const declared = /const WORK_IN_FLIGHT_STATUSES: \[&str; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1];
  assert.ok(declared, "the shell no longer declares its busy statuses where this test can find them");
  const shellStatuses = [...declared!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
  assert.deepEqual(shellStatuses, [...WORK_IN_FLIGHT_STATUSES].sort(),
    "the shell and the dashboard disagree about what counts as work in flight");

  // And the shell's list must only contain statuses that exist, or it is guarding a typo.
  const known = new Set(Object.keys(WORK_IN_FLIGHT) as SessionStatus[]);
  for (const status of shellStatuses) {
    assert.ok(known.has(status as SessionStatus), `${status} is not a SessionStatus`);
  }
});

test("the shell's two lists together cover every status the protocol has", () => {
  // The shell treats a status in NEITHER list as unknown, which warns. That is the right default,
  // and it also means a status added to the protocol and to neither list produces a warning on
  // every close until someone classifies it. This is where that gets noticed.
  const settled = /const SETTLED_STATUSES: \[&str; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1];
  const busy = /const WORK_IN_FLIGHT_STATUSES: \[&str; \d+\] = \[([^\]]*)\];/.exec(rust)?.[1];
  assert.ok(settled && busy, "the shell no longer declares both lists where this test can find them");
  const names = (block: string) => [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const covered = [...names(busy!), ...names(settled!)].sort();

  assert.deepEqual(covered, (Object.keys(WORK_IN_FLIGHT) as SessionStatus[]).sort(),
    "the shell's busy and settled lists do not add up to the protocol's SessionStatus union");
  assert.equal(new Set(covered).size, covered.length, "a status appears in both lists");
});

test("the dashboard and the shell name the same event", () => {
  // Two spellings of one event name is a feature that silently does nothing: the shell holds the
  // close, emits, and nothing is listening. The Rust side is the source of truth; this reads it.
  const declared = /const CLOSE_WOULD_STOP_WORK_EVENT: &str = "([^"]+)";/.exec(rust)?.[1];
  assert.ok(declared, "the shell no longer declares the event name where this test can find it");
  assert.equal(CLOSE_WOULD_STOP_WORK, declared,
    "the dashboard listens for a different event than the shell emits");
});

test("the Rust shell and TypeScript control plane agree on managed paths and headers", () => {
  const names = [
    "MANAGED_EXIT_RISK_PATH",
    "MANAGED_PROVISION_PATH",
    "MANAGED_LAUNCH_ID_HEADER",
    "MANAGED_CHALLENGE_HEADER",
    "MANAGED_REQUEST_MAC_HEADER",
    "MANAGED_RESPONSE_MAC_HEADER",
  ] as const;
  for (const name of names) {
    const rustValue = new RegExp(`const ${name}: &str = "([^"]+)";`, "u").exec(rust)?.[1];
    const typeScriptValue = new RegExp(`export const ${name} = "([^"]+)";`, "u")
      .exec(managedRoutes)?.[1];
    assert.ok(rustValue, `the Rust shell no longer declares ${name}`);
    assert.ok(typeScriptValue, `the TypeScript control plane no longer declares ${name}`);
    assert.equal(rustValue, typeScriptValue, `${name} drifted across the managed protocol`);
  }
});

test("the dashboard invokes the quit command the shell registers", () => {
  // #1965. Quit Anyway invokes a command by name; a misspelling is a button that does nothing. The
  // shell must both define it and register it with the invoke handler.
  assert.match(rust, new RegExp(`#\\[tauri::command\\]\\s*fn ${QUIT_AFTER_CONFIRMATION}\\(app: tauri::AppHandle\\)`),
    "the shell no longer defines the quit command as a no-argument command");
  const handlers = /generate_handler!\[([^\]]*)\]/.exec(rust)?.[1] ?? "";
  assert.ok(handlers.split(",").map((name) => name.trim()).includes(QUIT_AFTER_CONFIRMATION),
    "the shell defines the quit command but does not register it");
});

test("the guard's links merge what each part of the app provides, for as long as it provides it", () => {
  const links = createCloseGuardLinks();
  assert.deepEqual(links.current(), {});
  const showSessions = () => undefined;
  const stopShowing = links.provide({ showSessions });
  const first = () => ({ title: "First", status: "running" as const });
  const stopFirst = links.provide({ session: first });
  assert.equal(links.current().showSessions, showSessions);
  assert.equal(links.current().session, first);

  // A runtime replaced by the next one of the same instance can overlap it for a render.
  const second = () => null;
  const stopSecond = links.provide({ session: second });
  assert.equal(links.current().session, second, "the later provider wins while it lasts");
  stopFirst();
  assert.equal(links.current().session, second, "and an earlier one leaving does not take it away");
  stopSecond();
  assert.equal(links.current().session, undefined);
  assert.equal(links.current().showSessions, showSessions);
  stopShowing();
  stopShowing();
  assert.deepEqual(links.current(), {}, "withdrawing twice is harmless");
});
