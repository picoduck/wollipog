import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CreateWorkspaceReferenceRequest, GitDiffInfo } from "@wollipog/protocol";
import { writeClipboardText } from "../clipboard.js";
import {
  diffLineAttachRange,
  diffLineCopyText,
  diffLineStageTarget,
  EMPTY_LINE_SELECTION,
  extendDiffLineSelection,
  liveDiffLineSelection,
  placeDiffLineSelection,
  toggleDiffLine,
  type DiffLineRef,
  type DiffLineSelection,
  type PlacedDiffLine,
} from "../diff-line-selection.js";
import { useFeedback } from "./FeedbackProvider.js";
import type { DiffLineSelectionControls } from "./GitDiffViewer.js";
import { usePanelEscapeLayer } from "./RightPanel.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Stage Lines (Unstage Lines in the Staged view): absent outside the Uncommitted scope. */
export interface LineStageControls {
  direction: "stage" | "unstage";
  /** Why no line can be staged here right now, shown in the bar; null when staging can run. */
  unavailable: string | null;
  /** Why the signed-in person may not run Git actions (#1870), and the id of the element saying so. */
  refusal: { reason: string; id: string } | null;
  onLines: (direction: "stage" | "unstage", filePath: string, hunkIndex: number, lineIndices: number[]) => void;
}

export interface DiffLineSelectionState {
  /** Select Lines is on. */
  selecting: boolean;
  setSelecting: (selecting: boolean) => void;
  /** The selected lines the diff on screen still holds, in reading order. */
  placed: PlacedDiffLine[];
  clear: () => void;
  /** Let go of these lines only, keeping any picked since (an attach that just finished). */
  remove: (keys: ReadonlySet<string>) => void;
  /** What the diff viewer needs to show and pick lines. */
  controls: DiffLineSelectionControls;
  /** The Select Lines button, where focus goes when the bar it was in goes away. */
  toggleRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Review's Select Lines (#2849). The selection belongs to one change set as shown: switching the
 * session, the scope or pane, or between Unified and Side by Side starts from nothing, and a line
 * whose hunk a refresh rewrote leaves it. Escape inside the panel turns Select Lines off, which
 * clears the selection, before it can restore or close the panel.
 */
export function useDiffLineSelection({ diff, sessionId, view, fallbackRef, onPick }: {
  diff: GitDiffInfo | null;
  sessionId: string;
  /** Where focus goes when the bar leaves and the Select Lines button is not in the row. */
  fallbackRef?: RefObject<HTMLElement | null>;
  /** A line was picked: the host's other selection gives up the foot (#2850's findings). */
  onPick?: () => void;
  /** The lineage and layout on screen: the selection is kept only while they stay the same. */
  view: string;
}): DiffLineSelectionState {
  const owner = `${sessionId}\u0000${view}`;
  const [selectingFor, setSelectingFor] = useState<string | null>(null);
  const [stored, setStored] = useState<{ owner: string; selection: DiffLineSelection }>(
    () => ({ owner, selection: EMPTY_LINE_SELECTION }),
  );
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // Select Lines outlives a scope, pane or layout switch, not a session switch.
  const selecting = selectingFor === sessionId && diff !== null && diff.files.length > 0;
  const selection = stored.owner === owner ? stored.selection : EMPTY_LINE_SELECTION;
  const placed = useMemo(() => placeDiffLineSelection(selection, diff), [selection, diff]);
  const live = liveDiffLineSelection(selection, placed);
  // What a switch or a refresh dropped stays dropped: committed during render (as ReviewPanel's
  // anchors are), so returning to the pane, or a hunk coming back, never revives an old selection.
  // `liveDiffLineSelection` returns the same object once nothing more drops, which ends this.
  if (stored.owner !== owner || live !== stored.selection) setStored({ owner, selection: live });
  const liveRef = useRef(live);
  liveRef.current = live;
  const diffRef = useRef(diff);
  diffRef.current = diff;

  const update = (next: (prior: DiffLineSelection) => DiffLineSelection) =>
    setStored({ owner, selection: next(liveRef.current) });
  const clear = () => setStored({ owner, selection: EMPTY_LINE_SELECTION });
  const remove = (keys: ReadonlySet<string>) => update((prior) => {
    const lines = new Map([...prior.lines].filter(([key]) => !keys.has(key)));
    return { lines, anchor: prior.anchor !== null && lines.has(prior.anchor) ? prior.anchor : null };
  });
  const setSelecting = (on: boolean) => {
    setSelectingFor(on ? sessionId : null);
    if (!on) clear();
  };
  usePanelEscapeLayer(selecting ? () => setSelecting(false) : null);

  const selected = useMemo(() => new Set(live.lines.keys()), [live]);
  const controls: DiffLineSelectionControls = {
    selecting,
    selected,
    onLine: (ref: DiffLineRef, extend: boolean) => {
      onPick?.();
      update((prior) => extend
        ? extendDiffLineSelection(prior, ref, diffRef.current?.files.find((file) => file.path === ref.filePath))
        : toggleDiffLine(prior, ref));
    },
    onSelectLine: (ref: DiffLineRef) => {
      onPick?.();
      setSelectingFor(sessionId);
      setStored({ owner, selection: toggleDiffLine(EMPTY_LINE_SELECTION, ref) });
    },
  };

  // The bar leaves under the focus it may hold (Clear, Stage Lines, Attach to Prompt): focus goes
  // back to Select Lines rather than to the page, where Escape would no longer reach the panel.
  const barShown = placed.length > 0;
  const barWasShown = useRef(false);
  useLayoutEffect(() => {
    const wasShown = barWasShown.current;
    barWasShown.current = barShown;
    if (!wasShown || barShown) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (toggleRef.current?.isConnected ? toggleRef.current : fallbackRef?.current)?.focus({ preventScroll: true });
  });

  return { selecting, setSelecting, placed, clear, remove, controls, toggleRef };
}

const lineCount = (count: number) => `${count} line${count === 1 ? "" : "s"}`;

/**
 * The selection bar (#2849; docs/design-system.md §3.2): in the panel's foot in place of the commit
 * bar while lines are selected. The count, then Clear, Copy Lines, Stage Lines and Attach to Prompt,
 * primary last. An action that cannot run with this selection stays in the bar, says why in the
 * bar's text, and is `aria-disabled` so a keyboard user still reaches it and hears the reason.
 */
export function LineSelectionBar({ placed, diff, onAttach, stage, onClear, onRemove }: {
  placed: PlacedDiffLine[];
  diff: GitDiffInfo;
  /** Absent when this runner cannot attach workspace references. */
  onAttach?: (target: CreateWorkspaceReferenceRequest) => Promise<void>;
  stage: LineStageControls | null;
  onClear: () => void;
  /** Let go of exactly the lines an action took, keeping lines picked while it ran. */
  onRemove: (keys: ReadonlySet<string>) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const { showToast } = useFeedback();
  const [attachBusy, setAttachBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const range = diffLineAttachRange(placed);
  const attachReason = range ? null : "Select one continuous range to attach it.";
  const target = diffLineStageTarget(placed);
  const targetFile = target.kind === "lines" ? diff.files.find((file) => file.path === target.filePath) : undefined;
  const stageWord = stage?.direction === "unstage" ? "unstage" : "stage";
  const stageReason = !stage ? null
    : stage.refusal ? null
    : stage.unavailable ?? (target.kind === "unchanged"
      ? `Select a changed line to ${stageWord} it.`
      : target.kind === "spread"
        ? `Select lines in one hunk to ${stageWord} them.`
        : targetFile?.status !== "modified"
          ? `Only a modified file's lines can be ${stageWord}d one by one.`
          : null);
  const stageBlocked = stage !== null && (stage.refusal !== null || stageReason !== null);
  const attachId = `${uid}-attach-reason`;
  const stageId = `${uid}-stage-reason`;

  const attach = async () => {
    if (!onAttach || !range || attachBusy) return;
    setAttachBusy(true);
    // Lines stay pickable while the attach runs: only the ones it sends are let go when it lands.
    const sent = new Set(placed.map(({ ref }) => ref.key));
    try {
      await onAttach({ ...range, kind: "diff", diffHash: diff.diffHash, diffScope: diff.scope });
      if (mountedRef.current) onRemove(sent);
    } finally {
      if (mountedRef.current) setAttachBusy(false);
    }
  };
  const stageLines = () => {
    if (!stage || stageBlocked || target.kind !== "lines") return;
    stage.onLines(stage.direction, target.filePath, target.hunkIndex, target.lineIndices);
    onClear();
  };
  const copy = async () => {
    const button = document.activeElement;
    const current = () => mountedRef.current && (document.activeElement === button || document.activeElement === document.body);
    const result = await writeClipboardText(diffLineCopyText(placed), current);
    if (result === null) return;
    if (button instanceof HTMLElement && button.isConnected && document.activeElement === document.body) button.focus();
    if (result) showToast(`Copied ${lineCount(placed.length)}.`, { tone: "success" });
    else showToast("Couldn't copy the lines.", { tone: "error" });
  };

  return (
    <section className="selbar" aria-label="Selected Lines">
      <div className="selbar-row">
        <span className="selbar-count">{lineCount(placed.length)} selected</span>
        <div className="selbar-actions">
          <button type="button" className="btn ghost sm" disabled={attachBusy} onClick={onClear}>Clear</button>
          <button type="button" className="btn sm" onClick={() => void copy()}>Copy Lines</button>
          {stage && (
            <button
              type="button"
              className="btn sm"
              aria-disabled={stageBlocked || undefined}
              title={stage.refusal?.reason}
              aria-describedby={stage.refusal ? stage.refusal.id : stageReason ? stageId : undefined}
              onClick={stageLines}
            >
              {stage.direction === "unstage" ? "Unstage Lines" : "Stage Lines"}
            </button>
          )}
          {onAttach && (
            <BusyButton
              className="btn primary sm"
              busy={attachBusy}
              progress={`Attaching ${placed.length === 1 ? "the line" : "the lines"} to the prompt…`}
              aria-disabled={attachReason ? true : undefined}
              aria-describedby={attachReason ? attachId : undefined}
              onClick={() => void attach()}
            >
              Attach to Prompt
            </BusyButton>
          )}
        </div>
      </div>
      {onAttach && attachReason && <p className="selbar-reason" id={attachId}>{attachReason}</p>}
      {stageReason && <p className="selbar-reason" id={stageId}>{stageReason}</p>}
    </section>
  );
}
