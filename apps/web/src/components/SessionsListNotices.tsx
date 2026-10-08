import React, { useCallback, useState } from "react";
import type { ProviderLoginView, SessionView } from "@wollipog/protocol";
import {
  MachineSignInNotice,
  machineSignInPending,
  machineSignInTitle,
  type MachineSignInAction,
} from "./MachineSignInNotice.js";
import { RecommendedSkillsNotice, useSkillRecommendations } from "./RecommendedSkillsNotice.js";
import { SessionNoticeSlot, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { useWorktreeSetupSuggestion, WorktreeSetupNotice } from "./WorktreeSetupNotice.js";

/** The list slot's ranks, in one table (#2221). Severity orders first: a pending sign-in is a warning
 * and the other two are info. */
export const LIST_NOTICE_RANK = {
  machineSignIn: 1,
  setupSuggestion: 2,
  recommendedSkills: 3,
} as const;

/** The info dismissal scope `SessionNoticeSlot` keys by. No list entry uses the slot's own dismissal:
 * each has its own (Dismiss All, Dismiss Setup Notice, Cancel Sign-In). */
const LIST_SLOT_SCOPE = "sessions-list";

export interface MachineSignIn {
  runnerId: string;
  login: ProviderLoginView;
}

/**
 * The one notice slot at the top of the Sessions list pane (docs/design-system.md §13.2, #2221):
 * above the rows when stacked, at the top of the list column in Preview Right, and above the Board's
 * columns. It shows one notice, the most severe and then the lowest rank, and lists the others behind
 * that notice's "+N More": every machine sign-in that belongs to no session, the open Project's setup
 * suggestion, then Recommended Skills. `hidden` keeps the slot out while reconnecting, when what it
 * would show is stale (§12.5), and keeps its state for when the connection returns.
 */
export function SessionsListNotices({ signIns, machineName, setup, hidden = false, onOpenSkill, onSetupGenerated, onFocusLost }: {
  signIns: readonly MachineSignIn[];
  machineName: (runnerId: string) => string;
  /** The open Project tab's setup suggestion, if it has one. */
  setup?: { session: SessionView & { projectId: string }; projectName: string };
  hidden?: boolean;
  onOpenSkill: (skillId: string) => void;
  onSetupGenerated: (sessionId: string) => void;
  /** Where focus goes when the last notice leaves while it held focus. */
  onFocusLost?: () => void;
}) {
  const recommendations = useSkillRecommendations();
  // Kept here rather than in the notice, so a generation in flight stays guarded while another notice
  // is shown in the suggestion's place.
  const setupActions = useWorktreeSetupSuggestion(setup?.session, onSetupGenerated);
  // Each sign-in's action in flight, by entry key: choosing another notice unmounts the sign-in's, and
  // its request still runs, so coming back must still refuse a second action until it settles.
  const [runningSignIns, setRunningSignIns] = useState<ReadonlyMap<string, MachineSignInAction>>(() => new Map());
  const setSignInRunning = useCallback((key: string, action: MachineSignInAction | null) => {
    setRunningSignIns((current) => {
      const next = new Map(current);
      if (action) next.set(key, action);
      else next.delete(key);
      return next;
    });
  }, []);
  const entries: SessionNoticeEntry[] = hidden ? [] : signIns.map(({ runnerId, login }) => {
    const machine = machineName(runnerId);
    const key = `sign-in:${runnerId}:${login.operationId}`;
    return {
      key,
      severity: machineSignInPending(login) ? "warning" : "danger",
      rank: LIST_NOTICE_RANK.machineSignIn,
      title: machineSignInTitle(login, machine),
      // Keyed, so the slot showing another sign-in in this place mounts a fresh notice: a code typed
      // for one operation is never submitted to another.
      render: ({ trailing }) => (
        <MachineSignInNotice key={key} runnerId={runnerId} machine={machine} login={login}
          running={runningSignIns.get(key) ?? null}
          onRunningChange={(action) => setSignInRunning(key, action)}
          trailing={trailing} />
      ),
    };
  });
  if (setup && !hidden) {
    entries.push({
      key: `setup:${setup.session.projectId}`,
      severity: "info",
      rank: LIST_NOTICE_RANK.setupSuggestion,
      title: `Set Up ${setup.projectName}`,
      render: ({ trailing }) => (
        <WorktreeSetupNotice key={setup.session.id} projectName={setup.projectName} trailing={trailing}
          generating={setupActions.generating} dismissing={setupActions.dismissing} error={setupActions.error}
          generateRefusal={setupActions.generateRefusal} onGenerate={setupActions.generate}
          onDismiss={setupActions.dismiss} />
      ),
    });
  }
  if (recommendations.skills.length > 0 && !hidden) {
    entries.push({
      key: "recommended-skills",
      severity: "info",
      rank: LIST_NOTICE_RANK.recommendedSkills,
      title: "Recommended Skills",
      render: ({ trailing }) => (
        <RecommendedSkillsNotice recommendations={recommendations} trailing={trailing} onOpen={onOpenSkill} />
      ),
    });
  }
  return (
    <SessionNoticeSlot sessionId={LIST_SLOT_SCOPE} entries={entries} label="Sessions Notices"
      className="list-notice-slot" onFocusLost={onFocusLost} />
  );
}
