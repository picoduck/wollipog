import React from "react";
import { createRoot } from "react-dom/client";
import type { ControlPlaneToUi, RunnerView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import type { RunnerSkillsResponse } from "../skills.js";
import { SkillsView } from "../components/SkillsView.js";
import "../styles.css";

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  displayName: "Build Machine",
  agents: [
    {
      id: "claude",
      name: "Claude",
      command: "claude",
      args: [],
      env: {},
      driver: "claude-code",
      available: true,
    },
  ],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 90,
};

const snapshot: ControlPlaneToUi = {
  type: "snapshot",
  capabilities: {
    sessionSubscriptions: false,
    boundedDelivery: false,
    paginatedSessionHistory: false,
    projects: false,
  },
  runners: [runner],
  boxes: [],
  sessions: [],
  runs: [],
  pods: [],
};

class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    }, 0);
  }
  send() {}
  close() {}
}

const connection: UiConnectionRuntime = {
  instanceId: "skill-removals-e2e",
  runtimeKey: "skill-removals-e2e:1",
  createSocket: () => new FixtureSocket(),
  close() {},
};

const navigation: ViewNavigation = {
  current: () => ({ name: "skills" }),
  push() {},
  listen: () => () => {},
};

const reportedAt = 1_700_000_000_000;
const removalsReportedAt = 1_699_999_000_000;
const runnerSkills: RunnerSkillsResponse = {
  removalReporting: "supported",
  desired: [{
    name: "code-review",
    versionDigest: "d1",
    targets: [{ agentId: "claude", invocation: "agent" }],
  }],
  reported: {
    deployed: [{
      name: "code-review",
      digest: "d1",
      links: [{ agentId: "claude", status: "linked" }],
    }],
    unmanaged: [],
    removals: [
      {
        path: "~/.codex/skills/retired-skill-with-a-long-name",
        reason: "No longer in the desired skill list.",
      },
      {
        path: "~/.claude/skills/conflicted-canonical-skill",
        reason: "The canonical location it routes through is conflicted.",
      },
    ],
    removalsUpdatedAt: removalsReportedAt,
    updatedAt: reportedAt,
  },
};

const client = {
  ...api,
  listSkills: async () => ({ skills: [{
    id: "skill-1",
    name: "code-review",
    description: "Reviews code",
    latestVersion: { id: "v1", digest: "d1", createdAt: reportedAt },
  }] }),
  listSkillGroups: async () => ({ groups: [] }),
  getSkill: async () => ({
    skill: {
      id: "skill-1",
      name: "code-review",
      description: "Reviews code",
      latestVersion: { id: "v1", digest: "d1", createdAt: reportedAt },
    },
    latestVersion: {
      id: "v1",
      digest: "d1",
      createdAt: reportedAt,
      files: [{
        path: "SKILL.md",
        content: "---\nname: code-review\n---\n\nAlways review the diff.\n",
        encoding: "utf8" as const,
      }],
    },
    assignments: [],
  }),
  listSkillAssignments: async () => ({ assignments: [] }),
  runnerSkills: async () => runnerSkills,
} as unknown as ApiClient;

function SkillsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <SkillsView /> : null;
}

createRoot(document.getElementById("root")!).render(
  <ApiProvider client={client}>
    <StoreProvider connection={connection} navigation={navigation}>
      <SkillsWhenReady />
    </StoreProvider>
  </ApiProvider>,
);
