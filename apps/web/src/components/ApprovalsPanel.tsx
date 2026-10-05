import React, { useCallback, useEffect, useRef, useState } from "react";
import type { GovernancePolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { approvalsPolicyAnchorId } from "../navigation.js";
import { setQuestionResponseStyle, useQuestionResponseStyle, type QuestionResponseStyle } from "../question-response-style.js";
import { Notice } from "./Notice.js";
import { QuestionPoliciesPanel, type PolicyOwner } from "./QuestionPoliciesPanel.js";
import { SettingsGroup } from "./SettingsView.js";
import { ToolPoliciesList } from "./ToolPoliciesList.js";
import { SegmentedRow } from "./ui/SettingsRows.js";

/** §12.3: a load that settles sooner than this renders nothing new. */
const SKELETON_DELAY_MS = 300;

type Load =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; policies: GovernancePolicy[]; owner: PolicyOwner };

/**
 * Settings › Approvals (#2158): what shapes the approvals a person sees, in one place — how they
 * answer questions, which routine questions are answered for them, and the read-only tool policies
 * that allow, ask about or deny tool calls.
 *
 * The policies load once for both server-backed groups. While they load each group shows skeleton
 * rows; a failed load is one danger notice with Retry at the top of the section, and Answering
 * Questions, which is stored on this device, stays usable beneath it.
 *
 * `policyId` scrolls to and focuses that policy's row once the list is in: the target of a policy
 * name linked from a Decision Record, a request card or Decision History.
 */
export function ApprovalsPanel({ policyId }: { policyId?: string }) {
  const api = useApi();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    setShowSkeleton(false);
    const timer = window.setTimeout(() => { if (active) setShowSkeleton(true); }, SKELETON_DELAY_MS);
    void Promise.all([api.governancePolicies(), api.getIdentity()]).then(([result, identity]) => {
      if (active) setLoad({ status: "ready", policies: result.policies, owner: identity.context });
    }).catch((error: Error) => {
      if (active) setLoad({ status: "failed", message: error.message });
    });
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, attempt]);

  const onSaved = useCallback((saved: GovernancePolicy) => {
    setLoad((current) => current.status !== "ready" ? current : {
      ...current,
      policies: [...current.policies.filter((policy) => policy.policyId !== saved.policyId), saved],
    });
  }, []);

  useScrollToPolicy(policyId, load.status === "ready");

  const ready = load.status === "ready" ? load : null;
  return (
    <>
      {load.status === "failed" && (
        <Notice
          tone="danger"
          role="alert"
          title="Couldn't Load Approvals"
          actions={<button type="button" className="btn sm" onClick={() => setAttempt((value) => value + 1)}>Retry</button>}
          details={<code>{load.message}</code>}
        >
          Routine questions and tool policies could not be read. Answering Questions still works on this device.
        </Notice>
      )}
      <AnsweringQuestionsGroup />
      {load.status !== "failed" && (load.status === "ready" || showSkeleton) && (
        <>
          <QuestionPoliciesPanel policies={ready?.policies ?? null} owner={ready?.owner ?? null} onSaved={onSaved} />
          <ToolPoliciesList policies={ready?.policies ?? null} />
        </>
      )}
    </>
  );
}

const ANSWER_QUESTIONS_IN = [
  { value: "interactive", label: "Form" },
  { value: "composer", label: "Composer" },
];

/** Where a pending question is answered. Stored on this device under its original key. */
function AnsweringQuestionsGroup() {
  const style = useQuestionResponseStyle();
  return (
    <SettingsGroup title="Answering Questions">
      <SegmentedRow
        title="Answer Questions In"
        description="Saved on this device."
        options={ANSWER_QUESTIONS_IN}
        value={style}
        onChange={(value) => setQuestionResponseStyle(value as QuestionResponseStyle)}
      />
    </SettingsGroup>
  );
}

/**
 * Brings a linked policy's row into view and focus once the policies are in, once per arrival at the
 * link: leaving it (to plain Approvals, say) and coming back with Back scrolls to the row again. The
 * row is marked until focus leaves it, so the eye lands on it as well as the keyboard.
 */
function useScrollToPolicy(policyId: string | undefined, ready: boolean) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (policyId === undefined) {
      done.current = null;
      return;
    }
    if (!ready || done.current === policyId) return;
    const row = document.getElementById(approvalsPolicyAnchorId(policyId));
    if (!row) return;
    done.current = policyId;
    row.scrollIntoView({ block: "center" });
    row.setAttribute("data-targeted", "");
    const control = row.matches("button") ? row : row.querySelector<HTMLElement>('[role="switch"]');
    control?.focus({ preventScroll: true });
    const clear = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
      row.removeAttribute("data-targeted");
      row.removeEventListener("focusout", clear);
    };
    row.addEventListener("focusout", clear);
  }, [policyId, ready]);
}
