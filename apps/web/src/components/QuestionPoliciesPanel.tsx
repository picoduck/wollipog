import React, { useContext, useEffect, useRef, useState } from "react";
import type { GovernancePolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { questionRuleDescription } from "../governance-policies.js";
import { approvalsPolicyAnchorId } from "../navigation.js";
import { InfoIcon } from "./Icons.js";
import { MenuSurface } from "./Menu.js";
import { useDismissiblePopover } from "./interactions.js";
import { SettingsGroup } from "./SettingsView.js";
import { StatusBadge } from "./StatusBadge.js";
import { SAVED_MS, SwitchRow } from "./ui/SettingsRows.js";

export const QUESTION_POLICY_STARTERS = [
  { id: "review", title: "Review Sharing and Retries", description: "Approve sending a diff for review or retrying a review." },
  { id: "push", title: "Push and Open Pull Requests", description: "Approve pushing a branch or opening a pull request." },
  { id: "evidence", title: "Evidence Upload", description: "Approve uploading UI evidence to the private evidence bucket." },
] as const;

export type QuestionPolicyStarter = typeof QUESTION_POLICY_STARTERS[number];

/** Who the person is, for the policies they own. */
export interface PolicyOwner {
  userId: string;
  organizationId: string;
}

export function starterQuestionPolicyId(category: QuestionPolicyStarter, userId: string): string {
  return `questions:${category.id}:${userId}`;
}

export function starterQuestionPolicy(category: QuestionPolicyStarter, userId: string, organizationId: string, enabled: boolean): Omit<GovernancePolicy, "createdAt" | "updatedAt"> {
  return {
    policyId: starterQuestionPolicyId(category, userId), name: category.title, enabled, effect: "allow", priority: 0,
    ownerUserId: userId, scope: { organizationId },
    questionRule: {
      starterCategory: category.id, questionPattern: "*?",
      answer: { text: "Yes. Proceed with this routine workflow step." },
    },
  };
}

/** The person's own question policies that are not starters, by name. */
export function customQuestionPolicies(policies: readonly GovernancePolicy[], owner: PolicyOwner): GovernancePolicy[] {
  const starterIds = new Set(QUESTION_POLICY_STARTERS.map((category) => starterQuestionPolicyId(category, owner.userId)));
  return policies
    .filter((policy) => policy.questionRule && policy.ownerUserId === owner.userId && !starterIds.has(policy.policyId))
    .sort((a, b) => a.name.localeCompare(b.name) || a.policyId.localeCompare(b.policyId));
}

/** One switch: a starter, which may not be stored yet, or a stored custom policy. */
interface QuestionPolicyRow {
  key: string;
  policyId: string;
  title: string;
  description: string;
  custom: boolean;
  current: GovernancePolicy | undefined;
}

function questionPolicyRows(policies: readonly GovernancePolicy[], owner: PolicyOwner): QuestionPolicyRow[] {
  const starters = QUESTION_POLICY_STARTERS.map((category): QuestionPolicyRow => {
    const policyId = starterQuestionPolicyId(category, owner.userId);
    return {
      key: category.id, policyId, title: category.title, description: category.description, custom: false,
      current: policies.find((policy) => policy.policyId === policyId),
    };
  });
  const custom = customQuestionPolicies(policies, owner).map((policy): QuestionPolicyRow => ({
    key: policy.policyId, policyId: policy.policyId, title: policy.name.trim() || "Untitled Policy",
    description: questionRuleDescription(policy.questionRule!), custom: true, current: policy,
  }));
  return [...starters, ...custom];
}

/** The sentence a failed save shows on its row; the server's own words go to the announcement. */
const SAVE_FAILED = "Couldn't save this change.";

/**
 * Settings › Approvals › Routine Questions (#2158): the three starters, then the person's custom
 * question policies, each one switch that saves at once (§8.6). A failure stays on the row that
 * failed, in place of its description, with Try Again; the switch keeps the saved value.
 *
 * The policies are loaded by the section, which shares them with the Tool Policies list; a save
 * hands the stored policy back through `onSaved`.
 */
export function QuestionPoliciesPanel({ policies, owner, onSaved }: {
  /** Null while loading. */
  policies: readonly GovernancePolicy[] | null;
  owner: PolicyOwner | null;
  onSaved: (policy: GovernancePolicy) => void;
}) {
  const api = useApi();
  const { invalidate: invalidatePolicyNames } = useContext(GovernancePolicyNamesContext);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  /** Per row: the value a failed save wanted, and the server's reason. */
  const [failures, setFailures] = useState<ReadonlyMap<string, { enabled: boolean; detail: string }>>(() => new Map());
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const savedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  async function save(row: QuestionPolicyRow, enabled: boolean) {
    if (!owner || busy.has(row.key)) return;
    setBusy((old) => new Set(old).add(row.key));
    setFailures((old) => withoutKey(old, row.key));
    if (savedKey === row.key) setSavedKey(null);
    try {
      let next: Omit<GovernancePolicy, "createdAt" | "updatedAt">;
      if (row.current) {
        const { createdAt: _created, updatedAt: _updated, builtin: _builtin, ...existing } = row.current;
        next = { ...existing, enabled };
      } else {
        const category = QUESTION_POLICY_STARTERS.find((starter) => starter.id === row.key)!;
        next = starterQuestionPolicy(category, owner.userId, owner.organizationId, enabled);
      }
      onSaved(await api.putGovernancePolicy(next));
      // Decision Records name policies by their display name; a new policy needs its name loaded.
      invalidatePolicyNames();
      setSavedKey(row.key);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSavedKey((key) => key === row.key ? null : key), SAVED_MS);
    } catch (error) {
      setFailures((old) => new Map(old).set(row.key, { enabled, detail: (error as Error).message }));
    } finally {
      setBusy((old) => withoutKey(old, row.key));
    }
  }

  return (
    <SettingsGroup
      title="Routine Questions"
      intro={<>Answer routine permission questions automatically in sessions you own. <HowRoutineAnswersWork /></>}
    >
      {policies === null || owner === null ? <SkeletonRows count={3} announce="Loading routine questions…" /> : questionPolicyRows(policies, owner).map((row) => {
        const failure = failures.get(row.key);
        return (
          <SwitchRow
            key={row.key}
            anchorId={approvalsPolicyAnchorId(row.policyId)}
            title={row.title}
            badge={row.custom ? <StatusBadge tone="neutral" noDot label="Custom" /> : undefined}
            description={row.description}
            checked={row.current?.enabled ?? false}
            busy={busy.has(row.key)}
            saved={savedKey === row.key}
            failure={failure
              ? { message: SAVE_FAILED, detail: failure.detail, onRetry: () => void save(row, failure.enabled) }
              : null}
            onClick={() => void save(row, !(row.current?.enabled ?? false))}
          />
        );
      })}
    </SettingsGroup>
  );
}

function withoutKey<T extends ReadonlySet<string> | ReadonlyMap<string, unknown>>(collection: T, key: string): T {
  if (!collection.has(key)) return collection;
  const next = collection instanceof Map ? new Map(collection) : new Set(collection as ReadonlySet<string>);
  next.delete(key);
  return next as unknown as T;
}

/**
 * Skeleton rows at the real row's height and anatomy (§12.3): a title bar over a shorter one. One
 * polite announcement for the group; the bars themselves are hidden from assistive technology.
 */
export function SkeletonRows({ count, announce }: { count: number; announce: string }) {
  return (
    <div className="approvals-skeleton" role="status">
      <span className="sr-only">{announce}</span>
      {Array.from({ length: count }, (_, index) => (
        <div className="ui-row approvals-skeleton-row" aria-hidden="true" key={index}>
          <span />
          <span className="ui-row-body">
            <span className="skeleton-bar title" />
            <span className="skeleton-bar" />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The rest of how routine answers work, behind one info popover (§9.2); a bottom sheet on a phone. */
function HowRoutineAnswersWork() {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "routine-answers");
  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        className="link approvals-info-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popover.panelId : undefined}
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        <InfoIcon size={14} aria-hidden="true" />How Routine Answers Work
      </button>
      {open && (
        <MenuSurface
          surfaceRef={popover.panelRef}
          anchor={{ trigger: popover.triggerRef }}
          id={popover.panelId}
          kind="popover"
          role="dialog"
          label="How Routine Answers Work"
          width={340}
          tabIndex={-1}
          className="approvals-info"
          onDismiss={() => popover.close(true)}
          onKeyDown={popover.onPanelKeyDown}
        >
          <p>Each kind of question starts off. Turn one on and Wollipog answers it for you in the sessions you own.</p>
          <p>
            A starter recognizes a simple “May I” or “Can I” question about its one step. A question that
            adds another action, or that Wollipog does not recognize, still asks you. Merging, deleting,
            publishing an issue and deploying always ask you.
          </p>
          <p>An answer is sent only when the question accepts a typed reply. Any other kind of form still asks you.</p>
          <p>Custom policies are created from the command line or by an agent. You can turn yours on and off here.</p>
        </MenuSurface>
      )}
    </>
  );
}
