import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { PodMemberRole, PodMemberView, PodView, SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { POD_MAX_SESSIONS, podEligibleSessions } from "../pod-session-choices.js";
import { useStore } from "../store.js";
import { PodsIcon } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { PodSessionChoices } from "./PodSessionChoices.js";
import { State } from "./State.js";
import { BusyButton } from "./ui/BusyButton.js";
import { SegmentedControl, Select, type SegmentedOption, type SelectOption } from "./ui/ChoiceControls.js";
import { useFeedback } from "./FeedbackProvider.js";

const ROLE_OPTIONS: readonly SegmentedOption<PodMemberRole>[] = [
  { value: "lead", label: "Lead" },
  { value: "worker", label: "Worker" },
  { value: "reviewer", label: "Reviewer" },
];

/** "Same as Pod" is the empty value: the member keeps no budget of its own (`null`). */
const SAME_AS_POD = "";
const BUDGET_OPTIONS: readonly SelectOption<string>[] = [
  { value: SAME_AS_POD, label: "Same as Pod" },
  ...[4_096, 8_192, 16_384, 32_768].map((budget) => ({ value: String(budget), label: `${budget.toLocaleString("en-US")} tokens` })),
];

/**
 * Member Settings… (#2983), from a member's ⋯: its Role and its Context Budget, saved together with
 * one `updatePodMember`. Same as Pod clears the member's own budget (`null`). While automatic turns
 * or a merge run, Save is disabled with the reason in the footer.
 */
export function PodMemberSettingsDialog({ pod, member, name, blockedReason, onClose }: {
  pod: PodView;
  member: PodMemberView;
  /** The member as its column names it: "<Agent> · <Role> · <task>". */
  name: string;
  /** Why the settings cannot change now, or null. */
  blockedReason: string | null;
  onClose: () => void;
}) {
  const api = useApi();
  const ids = useId();
  const [role, setRole] = useState<PodMemberRole>(member.role);
  const [budget, setBudget] = useState(member.contextTokenBudget === null ? SAME_AS_POD : String(member.contextTokenBudget));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const podBudget = pod.orchestration?.policy.contextTokenBudget;
  const reasonId = `${ids}-reason`;
  const budgetHelpId = `${ids}-budget-help`;

  const save = async () => {
    if (busy || blockedReason) return;
    const contextTokenBudget = budget === SAME_AS_POD ? null : Number(budget);
    if (role === member.role && contextTokenBudget === member.contextTokenBudget) {
      onClose();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await api.updatePodMember(pod.id, member.sessionId, { role, contextTokenBudget });
      onClose();
    } catch (cause) {
      setFailure((cause as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Member Settings"
      description={name}
      onClose={onClose}
      footer={(
        <>
          {blockedReason && <span className="pod-member-reason" id={reasonId}>{blockedReason}</span>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <BusyButton className="btn primary" busy={busy} progress="Saving the member's settings…"
            disabled={Boolean(blockedReason)} aria-describedby={blockedReason ? reasonId : undefined}
            onClick={() => void save()}>
            Save
          </BusyButton>
        </>
      )}
    >
      <form
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="field">
          <span>Role</span>
          <SegmentedControl<PodMemberRole> label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} />
        </div>
        <div className="field">
          <span>Context Budget</span>
          <Select<string>
            label="Context Budget"
            value={budget}
            options={BUDGET_OPTIONS}
            describedBy={podBudget ? budgetHelpId : undefined}
            onChange={setBudget}
          />
          {podBudget && (
            <p className="field-helper" id={budgetHelpId}>{`The pod gives each member ${podBudget.toLocaleString("en-US")} tokens of the huddle.`}</p>
          )}
        </div>
        {failure && (
          <Notice tone="danger" role="alert" details={<code>{failure}</code>}>
            The member's settings weren't saved.
          </Notice>
        )}
      </form>
    </Modal>
  );
}

/** The footer's reason Add Members is unavailable, or null. */
export function addPodMembersBlockedReason(members: number, chosen: number): string | null {
  if (chosen === 0) return "Choose a session to add.";
  const room = POD_MAX_SESSIONS - members;
  if (chosen > room) return `A pod holds at most ${POD_MAX_SESSIONS} members. Choose at most ${room}.`;
  return null;
}

const addLabel = (count: number) => count === 0 ? "Add Members" : `Add ${count} ${count === 1 ? "Member" : "Members"}`;

/**
 * Add Member… (#2983), from the pod's bar: the eligible sessions as New Pod lists them (#2982's
 * `PodSessionChoices`), and Add N Members, which adds each chosen session in turn. A session that
 * could not join stays chosen, with the reason above the footer. With none eligible the list's place
 * says No Sessions Can Join and offers New Session…. While members are being added the dialog cannot
 * be dismissed.
 */
export function PodAddMembersDialog({ pod, blockedReason, onClose, onNewSession }: {
  pod: PodView;
  /** Why membership cannot change now (automatic turns, a merge), or null. */
  blockedReason: string | null;
  onClose: () => void;
  /** Opens New Session in this dialog's place. */
  onNewSession?: () => void;
}) {
  const api = useApi();
  const { sessions, pods } = useStore();
  const { showToast } = useFeedback();
  const ids = useId();
  const live = useMemo(() => podEligibleSessions(sessions.values(), pods.values()), [sessions, pods]);
  // The list as it stood when Add was pressed, kept until the requests settle: each member added
  // reaches this device (pod_upsert) before its answer and would otherwise leave the list (CR-1.1 of #2982).
  const [submitted, setSubmitted] = useState<SessionView[] | null>(null);
  const candidates = submitted ?? live;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<{ title: string; reason: string }[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const adding = useRef(false);

  const eligible = new Set(candidates.map((session) => session.id));
  const chosen = selected.filter((sessionId) => eligible.has(sessionId));
  const reason = blockedReason ?? addPodMembersBlockedReason(pod.members.length, chosen.length);
  const reasonId = `${ids}-reason`;

  const toggle = (sessionId: string) => setSelected((current) =>
    current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId],
  );
  const close = () => { if (!adding.current) onClose(); };

  const submit = async () => {
    if (adding.current || reason) return;
    adding.current = true;
    setSubmitted(candidates);
    setBusy(true);
    setFailures([]);
    const missed: { sessionId: string; title: string; reason: string }[] = [];
    for (const sessionId of chosen) {
      try {
        await api.addPodMember(pod.id, { sessionId });
      } catch (cause) {
        const title = candidates.find((session) => session.id === sessionId)?.title.trim() || "Untitled Session";
        missed.push({ sessionId, title, reason: (cause as Error).message });
      }
    }
    adding.current = false;
    if (!mounted.current) return;
    const added = chosen.length - missed.length;
    if (added > 0) showToast(`Added ${added} ${added === 1 ? "member" : "members"}.`, { tone: "success" });
    if (missed.length === 0) {
      onClose();
      return;
    }
    setSelected(missed.map((miss) => miss.sessionId));
    setFailures(missed);
    setSubmitted(null);
    setBusy(false);
  };

  return (
    <Modal
      title="Add Member"
      description={`Choose sessions to join “${pod.title}”.`}
      phoneSheet="full"
      onClose={close}
      footer={candidates.length === 0 ? (
        <button type="button" className="btn" onClick={close}>Cancel</button>
      ) : (
        <>
          {reason && <span className="pod-member-reason" id={reasonId}>{reason}</span>}
          <button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button>
          <BusyButton className="btn primary" busy={busy} progress="Adding members…"
            disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined}
            onClick={() => void submit()}>
            {addLabel(chosen.length)}
          </BusyButton>
        </>
      )}
    >
      {candidates.length === 0 ? (
        <State
          compact
          icon={<PodsIcon />}
          title="No Sessions Can Join"
          actions={onNewSession && (
            <button type="button" className="btn" onClick={onNewSession}>New Session…</button>
          )}
        >
          Start a session with its own worktree to add it here.
        </State>
      ) : (
        <PodSessionChoices sessions={candidates} value={chosen} onToggle={toggle} />
      )}
      {failures.length > 0 && (
        <Notice
          tone="danger"
          role="alert"
          details={<code>{failures.map((failure) => `${failure.title}: ${failure.reason}`).join("\n")}</code>}
        >
          {failures.length === 1
            ? `“${failures[0]!.title}” wasn't added. Try again.`
            : `${failures.length} sessions weren't added. Try again.`}
        </Notice>
      )}
    </Modal>
  );
}
