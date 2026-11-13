import React, { useRef, useState } from "react";
import type { CampaignWorktreeRetirementState } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";
import { Modal } from "./Modal.js";
import { Checkbox } from "./ui/ChoiceControls.js";

/** A signed-in person's two-step action. Neither a campaign grant nor an agent answer can take it. */
export function WorktreeRetirement({ campaignId, sessionId, path }: {
  campaignId: string; sessionId: string; path: string;
}) {
  const api = useApi();
  const [state, setState] = useState<CampaignWorktreeRetirementState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const inspect = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setOutcome(null); setState(null); setConfirmed(false);
    try { setState((await api.inspectCampaignWorktreeRetirement(campaignId, sessionId, path)).state); }
    catch (cause) { setOutcome({ ok: false, text: cause instanceof Error ? cause.message : "The worktree could not be inspected." }); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const retire = async () => {
    if (!state || !confirmed || busyRef.current) return;
    busyRef.current = true;
    setBusy(true); setOutcome(null);
    try {
      await api.confirmCampaignWorktreeRetirement(campaignId, sessionId, state);
      setOutcome({ ok: true, text: "The clean worktree was retired. Local branch refs were kept, so committed work remains available." });
    } catch (cause) {
      setOutcome({ ok: false, text: cause instanceof Error ? cause.message : "The worktree was retained. Inspect again before retrying." });
    } finally { busyRef.current = false; setBusy(false); setState(null); setConfirmed(false); }
  };
  return <div>
    {outcome && <Notice tone={outcome.ok ? "success" : "danger"} role={outcome.ok ? "status" : "alert"}
      title={outcome.ok ? "Worktree Retired" : "Worktree Retained"}>{outcome.text}</Notice>}
    {!state && !outcome?.ok && <BusyButton className="btn sm" busy={busy} progress="Inspecting worktree…" onClick={() => void inspect()}>
      Inspect Worktree
    </BusyButton>}
    {state && <Modal title="Retire Worktree" size="md" onClose={() => { if (!busyRef.current) { setState(null); setConfirmed(false); } }}
      footer={<>
        <button className="btn" disabled={busy} onClick={() => { setState(null); setConfirmed(false); }}>Cancel</button>
        <BusyButton className="btn danger" busy={busy} progress="Retiring worktree…" disabled={!confirmed}
          onClick={() => void retire()}>Retire Worktree</BusyButton>
      </>}>
      <dl className="facts">
        <div><dt>Path</dt><dd><code>{state.path}</code></dd></div>
        <div><dt>Branch</dt><dd><code>{state.branch}</code></dd></div>
        <div><dt>Tip</dt><dd><code>{state.headSha}</code></dd></div>
        <div><dt>Working Tree</dt><dd>Clean</dd></div>
      </dl>
      <p className="section-note">Retirement removes this clean checkout and keeps its local branch refs.
        Dirty trees and changed branches or tips are refused. Only you can confirm this action.</p>
      <Checkbox checked={confirmed} disabled={busy} onChange={setConfirmed} consent
        label="I have reviewed this worktree and want to retire its clean checkout." />
    </Modal>}
  </div>;
}
