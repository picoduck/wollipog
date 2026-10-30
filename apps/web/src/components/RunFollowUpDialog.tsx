import { useEffect, useId, useRef, useState } from "react";
import { useStoreSelector } from "../store.js";
import { statusMeta, sessionStatusSummary } from "../status-meta.js";
import { matchesShortcut } from "../shortcuts.js";
import {
  followUpAvailability,
  followUpSelectable,
  type MemberSendResult,
} from "../run-members.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";

/** One member the dialog can send to, under the name the run page gives it. */
export interface FollowUpMember {
  sessionId: string;
  label: string;
}

const agentsLabel = (count: number) => `${count} ${count === 1 ? "Agent" : "Agents"}`;
const agentsSentence = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;

/** The toast once every chosen member has the message: "Sent to 3 agents". */
export const followUpSentMessage = (count: number) => `Sent to ${agentsSentence(count)}`;

/**
 * Follow Up… (#2976, docs/design-system.md §7.1–§7.3, §8.4): one message to the run's members the
 * person chooses, sent through each member's own `prompt` call. Members awaiting a prompt start
 * checked; a working member reads Running and an ended one Ended, both unavailable. When a send
 * fails the dialog stays open with each member's result and Retry Failed, which sends the same
 * message again to the failed members only.
 */
export function RunFollowUpDialog({ members, preselect, send, onSent, onClose }: {
  members: readonly FollowUpMember[];
  /** Follow Up with This Agent…: only this member starts checked. */
  preselect?: string;
  send: (sessionIds: string[], text: string) => Promise<MemberSendResult[]>;
  /** Every member the message went to has it; the dialog has closed itself. */
  onSent: (count: number) => void;
  onClose: () => void;
}) {
  const sessions = useStoreSelector((state) => state.sessions);
  const runners = useStoreSelector((state) => state.runners);
  const availability = (sessionId: string) => {
    const session = sessions.get(sessionId);
    return session ? followUpAvailability(session) : { kind: "ended" as const, reason: "Ended" };
  };
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set(
    preselect !== undefined
      ? (followUpSelectable(availability(preselect)) ? [preselect] : [])
      : members.filter((member) => availability(member.sessionId).kind === "ready").map((member) => member.sessionId),
  ));
  // Each member's latest result, once a send left one undelivered; until then the dialog is a form.
  const [results, setResults] = useState<ReadonlyMap<string, MemberSendResult> | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true; a send that
  // settles after the dialog has gone changes nothing.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const reasonId = useId();
  const messageId = useId();

  const message = text.trim();
  const targets = members.filter((member) => chosen.has(member.sessionId) && followUpSelectable(availability(member.sessionId)));
  const failed = results ? members.filter((member) => results.get(member.sessionId)?.ok === false) : [];
  // Why the primary is off, beside it in the footer and on the phone sheet too (§7.3).
  const reason = results ? null
    : !message ? "Write a message to send."
      : targets.length === 0 ? "Choose an agent to send to."
        : null;

  const deliver = async (sessionIds: string[]) => {
    if (sending.current || !message || sessionIds.length === 0) return;
    sending.current = true;
    setBusy(true);
    try {
      const outcome = await send(sessionIds, message);
      if (!mounted.current) return;
      const next = new Map(results ?? []);
      for (const result of outcome) next.set(result.sessionId, result);
      if ([...next.values()].every((result) => result.ok)) {
        onClose();
        onSent(next.size);
        return;
      }
      setResults(next);
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const submit = () => {
    if (results) void deliver(failed.map((member) => member.sessionId));
    else if (!reason) void deliver(targets.map((member) => member.sessionId));
  };
  const toggle = (sessionId: string) => setChosen((prior) => {
    const next = new Set(prior);
    if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
    return next;
  });

  return (
    <Modal
      title="Follow Up"
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          {reason && <p className="run-follow-up-reason" id={reasonId}>{reason}</p>}
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{results ? "Close" : "Cancel"}</button>
          {results ? (
            <BusyButton className="btn primary" busy={busy} progress="Sending again…" onClick={submit}>
              Retry Failed
            </BusyButton>
          ) : (
            <BusyButton className="btn primary" busy={busy} progress="Sending…" disabled={reason !== null}
              aria-describedby={reason ? reasonId : undefined} onClick={submit}>
              {targets.length ? `Send to ${agentsLabel(targets.length)}` : "Send to Agents"}
            </BusyButton>
          )}
        </>
      )}
    >
      {results && (
        <Notice tone="danger" role="alert" title="Couldn't Send to Every Agent">
          {failed.length === 1
            ? `${failed[0]!.label} didn't get the message. Retry it, or close and open its session.`
            : `${failed.length} agents didn't get the message. Retry them, or close and open their sessions.`}
        </Notice>
      )}
      <div className="field">
        <label className="field-label" htmlFor={messageId}>Message</label>
        <textarea
          id={messageId}
          rows={3}
          autoFocus
          value={text}
          readOnly={busy || results !== null}
          placeholder="What every chosen agent should do next…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (!matchesShortcut(event.nativeEvent, "send-run-follow-up")) return;
            event.preventDefault();
            submit();
          }}
        />
      </div>
      <div className="field">
        <span className="field-label">Send To</span>
        {results ? (
          <ul className="surface run-follow-up-results" aria-label="Send To">
            {members.filter((member) => results.has(member.sessionId)).map((member) => {
              const result = results.get(member.sessionId)!;
              return (
                <li className="row" key={member.sessionId}>
                  <span className="row-body">
                    <span className="row-title" title={member.label}>{member.label}</span>
                    {!result.ok && <span className="row-sub">{result.error}</span>}
                  </span>
                  <StatusBadge meta={statusMeta("followUp", result.ok ? "delivered" : "failed")} inline />
                </li>
              );
            })}
          </ul>
        ) : (
          <ChoiceRows<string>
            multiple
            label="Send To"
            // A chosen member that has started working since is unchecked as well as unavailable.
            value={[...chosen].filter((sessionId) => followUpSelectable(availability(sessionId)))}
            onChange={toggle}
            options={members.map((member) => {
              const available = availability(member.sessionId);
              const session = sessions.get(member.sessionId);
              const runnerOnline = session ? runners.get(session.runnerId)?.status !== "offline" : true;
              return followUpSelectable(available)
                ? {
                  value: member.sessionId,
                  title: member.label,
                  description: session ? sessionStatusSummary(session, { runnerOnline }).primary.meta.label : undefined,
                }
                : { value: member.sessionId, title: member.label, disabled: true, disabledReason: "reason" in available ? available.reason : undefined };
            })}
          />
        )}
      </div>
      {/* The footer's reason changes as the person types and chooses, and a disabled primary can't
          take focus to be read, so this region says it politely. */}
      <span className="sr-only" role="status">{reason ?? ""}</span>
    </Modal>
  );
}
