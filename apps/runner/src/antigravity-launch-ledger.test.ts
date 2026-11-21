import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { AntigravityLaunchLedger } from "./antigravity-launch-ledger.js";
import { antigravitySignOutSuperseded } from "./antigravity-session.js";

// Every ordering of the five events that decide what an Antigravity session launches and whether a
// session's sign-out report is cleared (#4779), on the ledger the setup supervisor drives and the
// predicate the runner applies. The managed store is modelled exactly as `AntigravityManagedStore`
// behaves: an update swaps `current` to its candidate (the old one becomes `previous`) behind a
// pending record, and only a commit prunes, keeping `current` and `previous`.
//
// The access check observes whichever generation is `current` when its probe runs; the ready check
// that carries it settles later. Orderings the supervisor itself never produces (an access probe
// before the update whose candidate check settles after it) are included anyway, so the ledger is
// shown safe without relying on the supervisor's serialization.

type Step = "update activates" | "access check completes" | "ready check completes" | "launch starts" | "sign-out detected";
const STEPS: Step[] = ["update activates", "access check completes", "ready check completes", "launch starts", "sign-out detected"];
type Outcome = "ready" | "sign_in_required";
type InstallEnd = "committed" | "rolled back" | "rollback failed";

const GENERATIONS = join("/runner", "antigravity-managed", "generations");
const G1 = join(GENERATIONS, "g1");
const G2 = join(GENERATIONS, "g2");
const executable = (generation: string) => join(generation, "agy");

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

const ORDERINGS = permutations(STEPS).filter((order) =>
  order.indexOf("access check completes") < order.indexOf("ready check completes"));

test("every ordering of update, access check, ready check, launch and sign-out launches a kept, committed executable", () => {
  assert.equal(ORDERINGS.length, 60, "5! orderings, half with the access probe before its check settles");
  let cases = 0;
  for (const outcome of ["ready", "sign_in_required"] as const satisfies readonly Outcome[]) {
    for (const order of ORDERINGS) {
      for (const end of ["committed", "rolled back", "rollback failed"] as const satisfies readonly InstallEnd[]) {
        const label = `${outcome}: ${order.join(" → ")} → install ${end}`;
        const ledger = new AntigravityLaunchLedger();
        // A runner whose managed 1.5.14 (g1) passed a ready check at t=0.
        ledger.settle({ command: executable(G1), managed: true, accessObservedAt: 0 }, null);
        let current = G1;
        let previous: string | undefined;
        let uncommitted: string | null = null;
        let observed: { command: string; at: number } | undefined;
        let settled: Outcome = "ready";
        let checkSettled = false;
        let signedOutAt: number | undefined;
        const kept = () => new Set([current, previous].filter((generation): generation is string => !!generation).map(executable));
        const assertLaunch = (when: string, expected: string | null) => {
          const launched = ledger.launchable()?.command ?? null;
          assert.equal(launched, expected, `${label}: launch ${when}`);
          if (launched) {
            assert.ok(kept().has(launched), `${label}: ${when}, the launch names a generation the store keeps`);
            if (uncommitted) assert.notEqual(launched, executable(uncommitted), `${label}: ${when}, never the uncommitted candidate`);
          }
        };
        const assertSignOut = (when: string) => {
          // Cleared only by a ready check whose probe saw access working after the report.
          const expected = signedOutAt === undefined
            ? settled === "ready"
            : checkSettled && settled === "ready" && observed!.at > signedOutAt;
          assert.equal(antigravitySignOutSuperseded({ status: settled }, ledger.accessObservedAt(), signedOutAt), expected,
            `${label}: sign-out cleared ${when}`);
        };

        order.forEach((step, index) => {
          const at = index + 1;
          switch (step) {
            case "update activates":
              previous = current;
              current = G2;
              uncommitted = G2;
              break;
            case "access check completes":
              observed = { command: executable(current), at };
              break;
            case "ready check completes":
              settled = outcome;
              checkSettled = true;
              ledger.settle(outcome === "ready" ? { command: observed!.command, managed: true, accessObservedAt: observed!.at } : null,
                uncommitted);
              break;
            case "launch starts":
              // Before the install ends the candidate is never launchable: what was committed runs,
              // unless a check that was not ready withdrew it.
              assertLaunch(`at step ${at}`, checkSettled && outcome !== "ready" ? null : executable(G1));
              break;
            case "sign-out detected":
              signedOutAt = at;
              break;
          }
          assertSignOut(`after ${step}`);
        });

        // The install ends: the supervisor commits, or undoes, the activation and discards anything
        // still held.
        if (end === "committed") {
          uncommitted = null;
          ledger.commit();
        } else if (end === "rolled back") {
          current = previous!;
          previous = undefined;
          uncommitted = null;
        }
        ledger.discard();
        const verifiedCandidate = outcome === "ready" && observed!.command === executable(G2);
        assertLaunch("after the install ends",
          outcome !== "ready" ? null : end === "committed" && verifiedCandidate ? executable(G2) : executable(G1));
        assertSignOut("after the install ends");
        cases++;
      }
    }
  }
  assert.equal(cases, 2 * 60 * 3);
});

test("a second committed update keeps launching a generation the store kept", () => {
  const ledger = new AntigravityLaunchLedger();
  const G3 = join(GENERATIONS, "g3");
  ledger.settle({ command: executable(G1), managed: true, accessObservedAt: 1 }, null);
  for (const [candidate, at] of [[G2, 2], [G3, 3]] as const) {
    ledger.settle({ command: executable(candidate), managed: true, accessObservedAt: at }, candidate);
    assert.notEqual(ledger.launchable()?.command, executable(candidate), "held until committed");
    ledger.commit();
    assert.equal(ledger.launchable()?.command, executable(candidate));
  }
});

test("a PATH copy verified while an update is pending is launchable; an unreadable pending record holds every managed copy", () => {
  const ledger = new AntigravityLaunchLedger();
  ledger.settle({ command: "/usr/local/bin/agy", managed: false, accessObservedAt: 5 }, G2);
  assert.equal(ledger.launchable()?.command, "/usr/local/bin/agy");
  ledger.settle({ command: executable(G1), managed: true, accessObservedAt: 6 }, GENERATIONS);
  assert.equal(ledger.launchable()?.command, "/usr/local/bin/agy", "an unreadable record could name g1");
  assert.equal(ledger.accessObservedAt(), 6, "the sign-in was still seen working");
  ledger.discard();
  ledger.settle(null, null);
  assert.equal(ledger.launchable(), null);
  assert.equal(ledger.accessObservedAt(), undefined);
});
