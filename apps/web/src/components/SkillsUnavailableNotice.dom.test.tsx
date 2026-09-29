import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import type { RunnerSkillsResponse } from "../skills.js";
import {
  assignedSkillNamesForAgent,
  managedSkillsAvailableForTarget,
  parseSkillsNoticeDismissals,
  SKILLS_NOTICE_DISMISSALS_CAP,
  SkillsUnavailableNotice,
  skillsUnavailableSentence,
  targetsWithoutManagedSkills,
  useSessionSkillsUnavailable,
  useSkillsNoticeDismissal,
  withSkillsNoticeDismissal,
} from "./SkillsUnavailableNotice.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator, localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement, Node: domWindow.Node, Event: domWindow.Event, React, IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const desired: RunnerSkillsResponse["desired"] = [
  { name: "review", versionDigest: "a", targets: [{ agentId: "claude", invocation: "agent" }] },
  { name: "deploy", versionDigest: "b", targets: [{ agentId: "claude", invocation: "manual" }, { agentId: "codex", invocation: "agent" }] },
  { name: "codex-only", versionDigest: "c", targets: [{ agentId: "codex", invocation: "agent" }] },
];

test("only container and cloud targets lose managed skills", () => {
  assert.equal(managedSkillsAvailableForTarget(undefined), true);
  assert.equal(managedSkillsAvailableForTarget("host"), true);
  assert.equal(managedSkillsAvailableForTarget("container"), false);
  assert.equal(managedSkillsAvailableForTarget("cloud"), false);
});

test("only container and cloud targets are listed as lacking managed skills", () => {
  assert.deepEqual(targetsWithoutManagedSkills(undefined), []);
  assert.deepEqual(targetsWithoutManagedSkills([{ name: "Host", adapter: "host" }]), []);
  assert.deepEqual(targetsWithoutManagedSkills([
    { name: "Box", adapter: "container" }, { name: "Host", adapter: "host" }, { name: "Sky", adapter: "cloud" },
  ]), ["Box", "Sky"]);
});

test("assigned skill names follow the session agent", () => {
  assert.deepEqual(assignedSkillNamesForAgent(desired, "claude"), ["deploy", "review"]);
  assert.deepEqual(assignedSkillNamesForAgent(desired, "pi"), []);
  assert.deepEqual(assignedSkillNamesForAgent(desired, undefined), ["codex-only", "deploy", "review"]);
});

test("the sentence names the machine and up to three skills, counts more, and stops when they are unknown (#1977)", () => {
  assert.equal(skillsUnavailableSentence("Build Box", "container", ["deploy", "review"]),
    "Skills from Build Box aren’t available in container sessions, so deploy and review can’t be used here.");
  assert.equal(skillsUnavailableSentence("Build Box", "cloud", ["deploy"]),
    "Skills from Build Box aren’t available in cloud sessions, so deploy can’t be used here.");
  assert.equal(skillsUnavailableSentence("Build Box", "container", ["a", "b", "c"]),
    "Skills from Build Box aren’t available in container sessions, so a, b, and c can’t be used here.");
  assert.equal(skillsUnavailableSentence("Build Box", "container", ["a", "b", "c", "d", "e"]),
    "Skills from Build Box aren’t available in container sessions, so 5 assigned skills can’t be used here.");
  assert.equal(skillsUnavailableSentence("Build Box", "cloud", null),
    "Skills from Build Box aren’t available in cloud sessions.");
  for (const sentence of [
    skillsUnavailableSentence("Build Box", "container", ["deploy", "review"]),
    skillsUnavailableSentence("", "container", null),
  ]) {
    assert.doesNotMatch(sentence, /Machine|Assigned Skills:/u);
  }
});

test("the notice is a compact info condition with Open Agent Skills and a dismiss", async () => {
  const calls: string[] = [];
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <SkillsUnavailableNotice machine="Build Box" adapter="container" skillNames={["deploy", "review"]}
        onDismiss={() => calls.push("dismiss")} onOpenSkills={() => calls.push("open")} />,
    ));
    const notice = container.querySelector('[role="status"]')!;
    assert.equal(notice.getAttribute("aria-label"), "Skills Unavailable");
    assert.match(notice.className, /\bt-info\b/u);
    assert.match(notice.className, /\bcompact\b/u);
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Skills from Build Box aren’t available in container sessions, so deploy and review can’t be used here.");
    const buttons = [...notice.querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
      ["Open Agent Skills", "Dismiss Notice"]);
    await act(async () => { for (const button of buttons) button.click(); });
    assert.deepEqual(calls, ["open", "dismiss"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

function Probe({ adapter }: { adapter: "host" | "container" | "cloud" | undefined }) {
  const state = useSessionSkillsUnavailable({ runnerId: "runner-1", agentId: "claude", adapter });
  return <output>{JSON.stringify(state)}</output>;
}

async function probe(adapter: "host" | "container" | "cloud" | undefined, response: RunnerSkillsResponse | Error) {
  const calls: string[] = [];
  const client = {
    ...api,
    runnerSkills: async (runnerId: string) => {
      calls.push(runnerId);
      if (response instanceof Error) throw response;
      return response;
    },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(<ApiProvider client={client}><Probe adapter={adapter} /></ApiProvider>));
  const state = JSON.parse(container.textContent ?? "null") as unknown;
  await act(async () => root.unmount());
  container.remove();
  return { calls, state };
}

for (const adapter of ["container", "cloud"] as const) {
  test(`a ${adapter} session reports the Machine's assigned skills as unavailable`, async () => {
    const result = await probe(adapter, { desired, reported: null });
    assert.deepEqual(result.calls, ["runner-1"]);
    assert.deepEqual(result.state, { adapter, skillNames: ["deploy", "review"] });
  });
}

test("host sessions never fetch skills or report the condition", async () => {
  for (const adapter of ["host", undefined] as const) {
    const result = await probe(adapter, { desired, reported: null });
    assert.deepEqual(result.calls, []);
    assert.equal(result.state, null);
  }
});

test("no condition when nothing is assigned to the session's agent", async () => {
  assert.equal((await probe("container", { desired: [], reported: null })).state, null);
  assert.equal((await probe("container", { desired: [desired[2]!], reported: null })).state, null);
});

test("an unreadable assignment list still reports the absence, without names", async () => {
  assert.deepEqual((await probe("cloud", new Error("forbidden"))).state, { adapter: "cloud", skillNames: null });
});

test("returning to the tab re-reads assignments changed elsewhere", async () => {
  let current: RunnerSkillsResponse["desired"] = [];
  let calls = 0;
  const client = {
    ...api,
    runnerSkills: async () => { calls += 1; return { desired: current, reported: null }; },
  } as ApiClient;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const state = () => JSON.parse(container.textContent ?? "null") as unknown;
  try {
    await act(async () => root.render(<ApiProvider client={client}><Probe adapter="container" /></ApiProvider>));
    assert.equal(state(), null);

    current = desired;
    await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
    assert.deepEqual(state(), { adapter: "container", skillNames: ["deploy", "review"] });

    current = [];
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.Event("visibilitychange")); });
    assert.equal(state(), null);
    assert.equal(calls, 3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
  await act(async () => { domWindow.dispatchEvent(new domWindow.Event("focus")); });
  assert.equal(calls, 3, "an unmounted probe stops listening");
});

test("dismissals are a capped list, newest last, and garbage reads as none", () => {
  assert.deepEqual(parseSkillsNoticeDismissals(null), []);
  assert.deepEqual(parseSkillsNoticeDismissals("{"), []);
  assert.deepEqual(parseSkillsNoticeDismissals('{"a":1}'), []);
  assert.deepEqual(parseSkillsNoticeDismissals('["a",2,"b"]'), ["a", "b"]);
  assert.deepEqual(withSkillsNoticeDismissal(["a", "b"], "a"), ["b", "a"]);
  const full = Array.from({ length: SKILLS_NOTICE_DISMISSALS_CAP }, (_, index) => `s${index}`);
  const next = withSkillsNoticeDismissal(full, "new");
  assert.equal(next.length, SKILLS_NOTICE_DISMISSALS_CAP);
  assert.equal(next[0], "s1");
  assert.equal(next.at(-1), "new");
});

function DismissalProbe({ sessionId }: { sessionId: string }) {
  const [dismissed, dismiss] = useSkillsNoticeDismissal(sessionId);
  return <button type="button" onClick={dismiss}>{dismissed ? "dismissed" : "shown"}</button>;
}

test("a dismissal is kept per session on this device, so it survives a remount", async () => {
  domWindow.localStorage.clear();
  const render = async (sessionId: string) => {
    const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
    domWindow.document.body.append(container as never);
    const root = createRoot(container);
    await act(async () => root.render(<DismissalProbe sessionId={sessionId} />));
    return {
      button: () => container.querySelector("button")!,
      unmount: async () => { await act(async () => root.unmount()); container.remove(); },
    };
  };
  const first = await render("session-a");
  assert.equal(first.button().textContent, "shown");
  await act(async () => first.button().click());
  assert.equal(first.button().textContent, "dismissed");
  await first.unmount();

  const again = await render("session-a");
  assert.equal(again.button().textContent, "dismissed", "a reload does not bring it back");
  await again.unmount();
  const other = await render("session-b");
  assert.equal(other.button().textContent, "shown", "another session keeps its own notice");
  await other.unmount();
  domWindow.localStorage.clear();
});
