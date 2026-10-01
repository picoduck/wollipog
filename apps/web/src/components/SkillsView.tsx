import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { State } from "./State.js";
import { runnerSupportsProtocol, type RunnerView, type SkillDriftState, type SkillFile, type SkillInvocationPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { machineOptionLabels } from "../runners.js";
import { useFeedback } from "./FeedbackProvider.js";
import { DetailSkeleton } from "./common.js";
import { Select } from "./ui/ChoiceControls.js";
import { PlusIcon, SkillsIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { Steps } from "./Steps.js";
import { useIsMobile } from "./useIsMobile.js";
import { backLabel, destination, viewPath, type SkillsPane, type View } from "../navigation.js";
import { SkillGitImportDialog } from "./SkillGitImportDialog.js";
import { SkillMachineImportDialog } from "./SkillMachineImportDialog.js";
import { SkillVersionHistoryDialog } from "./SkillVersionHistoryDialog.js";
import { SkillMachineVersionDialog } from "./SkillMachineVersionDialog.js";
import { SkillDriftImportDialog } from "./SkillDriftImportDialog.js";
import { SkillOrphanImportDialog } from "./SkillOrphanImportDialog.js";
import { canResolveOrphanedCopy, orphanedCopyDiscardable, SkillOrphanedCopies } from "./SkillOrphanedCopies.js";
import { AddAssignmentDialog } from "./SkillAssignmentDialog.js";
import { NewSkillDialog } from "./NewSkillDialog.js";
import { SkillGroupsDialog } from "./SkillGroupsDialog.js";
import { SkillInheritedAssignments } from "./SkillInheritedAssignments.js";
import { SkillDeployment } from "./SkillDeployment.js";
import { SkillNoticeSlot, skillNoticeItem } from "./SkillNoticeSlot.js";
import { SkillInstructions } from "./SkillInstructions.js";
import { SkillSource } from "./SkillSource.js";
import { SAVED_MS } from "./ui/SettingsRows.js";
import type { SkillRule } from "../skill-assignment-matrix.js";
import { SkillBuiltInReviewDialog } from "./SkillBuiltInReviewDialog.js";
import { SkillList } from "./SkillList.js";
import { SkillDetailHeader, SkillDetailSection, skillDetailMenu } from "./SkillDetailHeader.js";
import { SkillsOverview } from "./SkillsOverview.js";
import {
  describeAgentSelector,
  describeAssignmentScope,
  invocationLabel,
  normalizeRemovalReporting,
  omittedKeptAsideCopies,
  orphanedCopyKey,
  orphanedCopyRef,
  reportedOrphanedCopies,
  skillAssignmentsFromPayload,
  skillFromPayload,
  skillGroupsFromPayload,
  skillOverviewAttention,
  skillsFromPayload,
  type RunnerSkillsResponse,
  type SkillAgentSelector,
  type SkillAssignmentView,
  type OrphanedSkillCopy,
  type OrphanedSkillCopyResolution,
  type SkillDriftCopy,
  type SkillDriftResolution,
  type SkillGroupAssignmentView,
  type SkillGroupView,
  type SkillSummary,
} from "../skills.js";

/** An Agent Skills route: a skill, a pane (Orphaned Copies, Library Overview), or the bare list. */
export type SkillsRoute = Extract<View, { name: "skills" }>;

/** The route's detail title on a phone, where the open detail takes the app bar (§6.2). */
const PANE_TITLES: Record<SkillsPane, string> = { orphans: "Orphaned Copies", overview: "Library Overview" };

export function SkillsView({ route = { name: "skills" } }: { route?: SkillsRoute } = {}) {
  const api = useApi();
  const { navigate } = useStoreActions();
  const isMobile = useIsMobile();
  const { confirm, showToast } = useFeedback();
  const runnersMap = useStoreSelector((state) => state.runners);
  const boxes = useStoreSelector((state) => state.boxes);
  const runners = useMemo(() => [...runnersMap.values()], [runnersMap]);
  const machineLabels = useMemo(() => {
    const boxByRunner = new Map([...boxes.values()].map((box) => [box.runnerId, box]));
    return machineOptionLabels(runners, (id) => boxByRunner.get(id));
  }, [boxes, runners]);

  // The route is the only source of selection (§6): `/skills/~<id>` a skill, `/skills/orphans` the
  // Orphaned Copies pane, `/skills` and `/skills/overview` the default detail.
  const selectedId = route.id ?? null;
  const showOrphans = !route.id && route.pane === "orphans";
  /** Whether the route opens something in the detail pane, which on a phone is its own screen. */
  const detailOpen = Boolean(route.id || route.pane);
  const routeKey = viewPath(route);

  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const libraryNames = useMemo(() => new Set((skills ?? []).map((skill) => skill.name)), [skills]);
  const [groups, setGroups] = useState<SkillGroupView[]>([]);
  const [loadedDetail, setDetail] = useState<SkillSummary | null>(null);
  // A detail loaded for an earlier selection is never shown under the current one.
  const detail = loadedDetail && loadedDetail.id === selectedId ? loadedDetail : null;
  const [assignments, setAssignments] = useState<SkillAssignmentView[]>([]);
  /** The open skill's group's rules, which can be what deploys it, as of a reload `revision`. */
  const [groupRules, setGroupRules] = useState<{ groupId: string; revision: number; rules: SkillGroupAssignmentView[] } | null>(null);
  const [groupRulesRevision, setGroupRulesRevision] = useState(0);
  const [machineSkills, setMachineSkills] = useState<Record<string, RunnerSkillsResponse>>({});
  const [busy, setBusy] = useState(false);
  const [syncingRunnerId, setSyncingRunnerId] = useState<string | null>(null);
  const [versionRunnerId, setVersionRunnerId] = useState<string | undefined>();
  const [driftImport, setDriftImport] = useState<{ runnerId: string; copy: SkillDriftCopy; entry: SkillDriftState } | null>(null);
  const [orphanImport, setOrphanImport] = useState<{ runnerId: string; copy: OrphanedSkillCopy } | null>(null);
  /** A failed action (or machine refresh): a notice above the panes, not a load failure. */
  const [error, setError] = useState<string | null>(null);
  /** The library could not be read: its notice replaces both panes, with Retry (§12.4). */
  const [listError, setListError] = useState<string | null>(null);
  /** The selected skill could not be read: its notice replaces the detail. */
  const [detailError, setDetailError] = useState<{ skillId: string; message: string } | null>(null);
  const [dialog, setDialog] = useState<"groups" | "new-skill" | "add-assignment" | "git-import" | "git-update" | "machine-import" | "version-history" | "machine-versions" | "built-in-review" | null>(null);

  /** The selection as of now, for async work that finishes after the user moved on. */
  const selectedRef = useRef(selectedId);
  useLayoutEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  // Selecting pushes the route, so a link such as onboarding's Open Skills selects its skill, Back
  // returns to the previous selection, and the bare Skills route (the rail) clears it. The ref moves
  // at once, so work that finishes before the route re-renders already sees the new selection.
  const select = useCallback((skillId: string | null) => {
    selectedRef.current = skillId;
    navigate(skillId ? { name: "skills", id: skillId } : { name: "skills" });
  }, [navigate]);
  const openPane = useCallback((pane: SkillsPane) => {
    selectedRef.current = null;
    navigate({ name: "skills", pane });
  }, [navigate]);

  // Each pane scrolls on its own (§6). A new route starts the detail at its top; on a phone, where
  // the route swaps the whole screen, focus moves to the new page title, which shows no ring (§16.1).
  const listBodyRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const previousRouteKey = useRef(routeKey);
  useLayoutEffect(() => {
    if (previousRouteKey.current === routeKey) return;
    previousRouteKey.current = routeKey;
    if (detailRef.current) detailRef.current.scrollTop = 0;
    if (isMobile) document.getElementById("page-title")?.focus({ preventScroll: true });
  }, [routeKey, isMobile]);
  // A phone hides the list while a detail is open, which loses its scroll position; Back puts the
  // list back where it was (§6.2). Recorded only while the list is on screen.
  const listScrollTop = useRef(0);
  useLayoutEffect(() => {
    if (!detailOpen && listBodyRef.current) listBodyRef.current.scrollTop = listScrollTop.current;
  }, [detailOpen]);

  /** Only the newest started refresh of each surface may commit (see AutomationsView). */
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const refreshList = useCallback(async () => {
    const generation = (listGeneration.current += 1);
    // A failure is fenced like a success: an older request that rejects after a newer one loaded
    // must not replace the library with its error.
    const [skillsPayload, groupsPayload] = await Promise.all([api.listSkills(), api.listSkillGroups()])
      .catch((cause: unknown) => {
        if (generation === listGeneration.current) throw cause;
        return [null, null] as const;
      });
    if (generation !== listGeneration.current || !skillsPayload || !groupsPayload) return;
    // The newest load succeeded, from Retry or from a mutation's refresh: its error is over.
    setListError(null);
    setSkills(skillsFromPayload(skillsPayload));
    setGroups(skillGroupsFromPayload(groupsPayload));
  }, [api]);

  const refreshDetail = useCallback(async (skillId: string) => {
    // A mutation that finishes after the user selected another skill, or none, refreshes nothing.
    if (selectedRef.current !== skillId) return;
    const generation = (detailGeneration.current += 1);
    const current = () => generation === detailGeneration.current && selectedRef.current === skillId;
    const [detailPayload, assignmentsPayload] = await Promise.all([
      api.getSkill(skillId),
      api.listSkillAssignments(skillId),
    ]).catch((cause: unknown) => {
      // Only the newest request for the current selection reports its failure.
      if (current()) throw cause;
      return [null, null] as const;
    });
    if (!current() || !detailPayload || !assignmentsPayload) return;
    setDetailError((error) => error?.skillId === skillId ? null : error);
    setDetail(skillFromPayload(detailPayload));
    setAssignments(skillAssignmentsFromPayload(assignmentsPayload));
  }, [api]);

  const refreshMachines = useCallback(async () => {
    const loaded = await Promise.all(runners.map(async (runner) => {
      try {
        const response = await api.runnerSkills(runner.runnerId);
        return [runner.runnerId, {
          ...response,
          removalReporting: normalizeRemovalReporting(response.removalReporting),
          driftReporting: normalizeRemovalReporting(response.driftReporting),
          keptAsideReporting: normalizeRemovalReporting(response.keptAsideReporting),
        } satisfies RunnerSkillsResponse] as const;
      } catch {
        // A machine that predates the skills routes reads as never reported rather than an error
        // banner over the whole view.
        return [runner.runnerId, {
          desired: [], reported: null, removalReporting: "unknown", loadError: "Skills status could not be loaded. Try Sync Now or reopen this view.",
        } satisfies RunnerSkillsResponse] as const;
      }
    }));
    setMachineSkills(Object.fromEntries(loaded));
  }, [api, runners]);

  const loadList = useCallback(() => {
    setListError(null);
    refreshList().catch((cause) => setListError((cause as Error).message));
  }, [refreshList]);
  useEffect(loadList, [loadList]);

  useEffect(() => {
    refreshMachines().catch((cause) => setError((cause as Error).message));
  }, [refreshMachines]);

  const loadDetail = useCallback((skillId: string) => {
    setDetailError(null);
    refreshDetail(skillId).catch((cause) => {
      if (selectedRef.current === skillId) setDetailError({ skillId, message: (cause as Error).message });
    });
  }, [refreshDetail]);

  useEffect(() => {
    if (!selectedId) {
      // A detail load still in flight must not repopulate the pane after the selection clears.
      detailGeneration.current += 1;
      setDetail(null);
      setAssignments([]);
      return;
    }
    loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // A group's rule can be the one that skips an agent; its notice then sends the person to Groups.
  // Unreadable rules leave the notice without a fix rather than blaming one of the skill's own.
  const detailGroupId = detail?.groupId;
  useEffect(() => {
    if (!detailGroupId) return;
    let active = true;
    api.listSkillGroupAssignments(detailGroupId)
      .then((result) => { if (active) setGroupRules({ groupId: detailGroupId, revision: groupRulesRevision, rules: result.assignments }); })
      .catch(() => { if (active) setGroupRules(null); });
    return () => { active = false; };
  }, [api, detailGroupId, groupRulesRevision]);

  const mutate = async (work: () => Promise<unknown>, after?: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await after?.();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createSkill = async (input: { name: string; description: string; files: SkillFile[] }) => {
    await mutate(async () => {
      const created = skillFromPayload(await api.createSkill({
        name: input.name,
        ...(input.description ? { description: input.description } : {}),
        files: input.files,
      }));
      setDialog(null);
      if (created) select(created.id);
    }, async () => {
      await refreshList();
      await refreshMachines();
    });
  };

  const createAssignment = async (input: {
    scopeKind: "instance" | "runner";
    runnerId?: string;
    agentSelector: SkillAgentSelector;
    invocation: SkillInvocationPolicy;
  }, skillId = selectedId) => {
    if (!skillId) return;
    await mutate(async () => {
      await api.createSkillAssignment({ skillId, ...input });
      setDialog(null);
    }, async () => {
      // The list's assignment counts decide which built-in skills are still recommended.
      await refreshList();
      await refreshDetail(skillId);
      await refreshMachines();
    });
  };

  /** One-step assignment of a recommended built-in skill to every supported agent, from its detail
   * or from the Library Overview. */
  const assignRecommended = (skillId: string, runnerId: string | null) => createAssignment({
    scopeKind: runnerId ? "runner" : "instance",
    ...(runnerId ? { runnerId } : {}),
    agentSelector: { kind: "all" },
    invocation: "agent",
  }, skillId);

  const setRecommendationDismissed = async (skillId: string, dismissed: boolean) => {
    await mutate(() => api.setSkillRecommendationDismissed(skillId, dismissed), async () => {
      await refreshList();
      await refreshDetail(skillId);
    });
  };

  /** The skill's heading: the detail's title, or on a phone the detail bar's. */
  const focusSkillHeading = () => {
    const heading = isMobile
      ? document.getElementById("page-title")
      : detailRef.current?.querySelector<HTMLElement>(".skill-detail-title");
    heading?.focus({ preventScroll: true });
  };

  /** The notice's close button leaves with the notice, so focus moves to the skill's heading first. */
  const dismissRecommendation = (skillId: string) => {
    focusSkillHeading();
    void setRecommendationDismissed(skillId, true);
  };

  /** Source's Show Recommendation leaves too, and the restored notice sits right under the heading. */
  const showRecommendation = (skillId: string) => {
    focusSkillHeading();
    void setRecommendationDismissed(skillId, false);
  };

  /** Automatic Updates applies on click (§8.6): its own request shows busy, and a confirmed change
   * shows "Saved" for 2s. Kept per skill, so another skill never shows this one's state. */
  const [autoUpdateSave, setAutoUpdateSave] = useState<{ skillId: string; state: "saving" | "saved" } | null>(null);
  const savedTimer = useRef<number | null>(null);
  useEffect(() => () => { if (savedTimer.current !== null) window.clearTimeout(savedTimer.current); }, []);
  const setGitAutoUpdate = async (skillId: string, enabled: boolean) => {
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    setAutoUpdateSave({ skillId, state: "saving" });
    let saved = false;
    await mutate(async () => {
      await api.setSkillGitAutoUpdate(skillId, enabled);
      saved = true;
    }, async () => {
      // Disabling drops a held update, which the list shows as Update Held.
      await refreshList();
      await refreshDetail(skillId);
    });
    if (!saved) {
      setAutoUpdateSave(null);
      return;
    }
    setAutoUpdateSave({ skillId, state: "saved" });
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null;
      setAutoUpdateSave((current) => current?.skillId === skillId && current.state === "saved" ? null : current);
    }, SAVED_MS);
  };

  /** One atomic change to the rule behind a deployment error. A control plane that predates
   * `agentSelector` on update ignores it, so the returned rule is checked rather than trusted. */
  const updateRule = async (skillId: string, rule: SkillRule, patch: { invocation?: SkillInvocationPolicy; agentSelector?: SkillAgentSelector }) => {
    await mutate(async () => {
      const payload = await api.updateSkillAssignment(rule.id, patch);
      const updated = "assignment" in payload ? payload.assignment : payload as SkillAssignmentView;
      if (patch.agentSelector && JSON.stringify(updated?.agentSelector) !== JSON.stringify(patch.agentSelector)) {
        throw new Error("This Wollipog server can't change which agents an assignment covers yet, so nothing changed. Update Wollipog, then try again.");
      }
    }, async () => {
      await refreshList();
      await refreshDetail(skillId);
      await refreshMachines();
    });
  };

  const deleteSkill = async (skill: SkillSummary) => {
    const confirmed = await confirm({
      title: "Delete Skill",
      message: `“${skill.name}”, its versions and its assignments are removed, and the next sync removes it from every machine.` +
        (skill.builtIn ? " Later Wollipog releases do not add this built-in skill back." : ""),
      confirmLabel: "Delete Skill",
      tone: "danger",
    });
    if (!confirmed) return;
    await mutate(async () => {
      await api.deleteSkill(skill.id);
      select(null);
    }, async () => {
      await refreshList();
      await refreshMachines();
    });
  };

  const syncMachine = async (runnerId: string) => {
    setSyncingRunnerId(runnerId);
    setError(null);
    try {
      const reported = await api.syncRunnerSkills(runnerId);
      setMachineSkills((current) => ({
        ...current,
        [runnerId]: {
          desired: current[runnerId]?.desired ?? [],
          reported,
          removalReporting: current[runnerId]?.removalReporting ?? "unknown",
          // Kept until the refresh below replaces them, so resolved copies do not flicker out and back.
          ...(current[runnerId]?.orphaned ? { orphaned: current[runnerId]!.orphaned } : {}),
          ...(current[runnerId]?.keptAsideReporting ? { keptAsideReporting: current[runnerId]!.keptAsideReporting } : {}),
          ...(current[runnerId]?.loadError || !current[runnerId] ? { loadError: current[runnerId]?.loadError ?? "Desired skill assignments have not loaded." } : {}),
        },
      }));
      await refreshMachines();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSyncingRunnerId(null);
    }
  };

  const driftResolved = async (result: SkillDriftResolution) => {
    if (result.warning) showToast(result.warning, { tone: "error" });
    await refreshList();
    if (selectedId) await refreshDetail(selectedId);
    await refreshMachines();
  };

  /** A v183 or v184 runner may keep copies aside without reporting them, so its update notice stays reachable. */
  const keptAsideUnreported = useMemo(() => runners.some((runner) => runnerSupportsProtocol(runner.protocolVersion, "skillDrift") &&
    !runnerSupportsProtocol(runner.protocolVersion, "skillKeptAsideCopies")), [runners]);
  const orphanCount = useMemo(() => runners.reduce((count, runner) =>
    count + reportedOrphanedCopies(machineSkills[runner.runnerId]).length + omittedKeptAsideCopies(machineSkills[runner.runnerId]),
  0), [machineSkills, runners]);

  // One list for the overview's Needs Attention and the phone's Library Overview row, so the two
  // counts cannot differ.
  const overviewAttention = useMemo(() => skillOverviewAttention({
    skills: skills ?? [],
    runners,
    machineSkills,
    orphanCount,
    machineLabel: (runnerId) => machineLabels.get(runnerId) ?? runnerId,
  }), [skills, runners, machineSkills, orphanCount, machineLabels]);

  const orphanResolved = async (result: OrphanedSkillCopyResolution) => {
    if (result.warning) showToast(result.warning, { tone: "error" });
    await refreshList();
    if (selectedId) await refreshDetail(selectedId);
    await refreshMachines();
  };

  /** `onConfirmed` closes the review the discard was chosen from (#1973). */
  const discardOrphan = async (runner: RunnerView, copy: OrphanedSkillCopy, onConfirmed?: () => void) => {
    const machine = machineLabels.get(runner.runnerId) ?? runner.runnerId;
    const fenced = "It is deleted only if it still matches what this page shows; if it changed, nothing is deleted.";
    const copyName = `${copy.kind === "kept_aside" ? "kept-aside" : "edited"} copy${copy.name ? ` of “${copy.name}”` : ""}`;
    const confirmed = await confirm({
      title: "Discard Copy",
      message: copy.kind === "kept_aside"
        ? `The ${copyName} on ${machine} is discarded from the skill store and cannot be recovered` +
          `${copy.observedDigest ? "" : " (it is not valid skill content, so it cannot be previewed)"}. ${fenced}`
        : copy.observedDigest
          ? `The ${copyName} on ${machine} is discarded and cannot be recovered, and its links are removed like those of ` +
            `any skill that is no longer assigned. ${fenced}`
          : `The ${copyName} on ${machine} cannot be read, so the machine moves it aside instead of deleting it and ` +
            "removes its links. It then appears here as a kept-aside copy, which you can discard.",
      confirmLabel: "Discard Copy",
      tone: "danger",
    });
    if (!confirmed) return;
    onConfirmed?.();
    await mutate(async () => {
      // Exactly what the machine reported: a kept-aside copy's fingerprint of every entry, plus its content
      // digest when readable; a deleted skill's copy by its digest, or null when it was unreadable.
      const result = await api.discardOrphanedSkillCopy(runner.runnerId, orphanedCopyRef(copy), copy.kind === "kept_aside"
        ? { observedFingerprint: copy.observedFingerprint!, ...(copy.observedDigest ? { observedDigest: copy.observedDigest } : {}) }
        : { observedDigest: copy.observedDigest ?? null });
      await orphanResolved(result);
    });
  };

  /** `onConfirmed` closes the review the restore was chosen from (#1973). */
  const restoreDrift = async (runner: RunnerView, entry: SkillDriftState, onConfirmed?: () => void) => {
    const machine = machineLabels.get(runner.runnerId) ?? runner.runnerId;
    const confirmed = await confirm({
      title: "Restore Library Version",
      message: `The edited copy of “${entry.name}” on ${machine} is discarded and cannot be recovered. If the library still ` +
        "has the version it was deployed from, the machine rebuilds that version in its place, then syncs to its assigned version.",
      confirmLabel: "Restore Library Version",
      tone: "danger",
    });
    if (!confirmed) return;
    onConfirmed?.();
    await mutate(async () => {
      const result = await api.restoreSkillDrift(runner.runnerId,
        { name: entry.name, digest: entry.digest, variant: entry.variant }, entry.observedDigest ?? null);
      await driftResolved(result);
    });
  };

  // The machines whose copy an open review is of, for its restore or discard alternative (#1973).
  const driftRunner = driftImport ? runners.find((runner) => runner.runnerId === driftImport.runnerId) : undefined;
  const orphanRunner = orphanImport ? runners.find((runner) => runner.runnerId === orphanImport.runnerId) : undefined;

  const latest = detail?.latestVersion ?? null;
  const gitSource = detail?.gitSource ?? latest?.gitSource;
  // Until the group's current rules are read, a rule of the skill's own could be blamed for what
  // the group's rule does, so the notice offers no fix.
  const groupRulesCurrent = Boolean(detailGroupId && groupRules?.groupId === detailGroupId &&
    groupRules.revision === groupRulesRevision);
  const detailRules = useMemo<SkillRule[]>(() => [
    ...assignments,
    ...(groupRulesCurrent ? groupRules!.rules : []),
  ], [assignments, groupRulesCurrent, groupRules]);
  // One answer for the slot and for Source, so a notice the slot shows is never repeated below.
  const noticeItem = detail
    ? skillNoticeItem(detail, runners, machineSkills, detailRules, !detailGroupId || groupRulesCurrent)
    : null;

  const howId = `skills-how-${useId().replace(/:/g, "")}`;
  const skillName = detail?.name ?? skills?.find((skill) => skill.id === selectedId)?.name;
  // On a phone the list and the open detail are two screens (§6.2): the detail takes the app bar,
  // as the shared detail bar with Back, and the list is hidden until Back.
  const phoneDetail = isMobile && detailOpen;
  // The list's foot entry and the empty library's notice appear only while there is something to
  // review, even on /skills/orphans (#1974): the pane itself says when everything is resolved.
  const showOrphanEntry = orphanCount > 0 || keptAsideUnreported;
  // An empty library is one state across both panes (§6.1, §12.1), and that state offers creation,
  // so the header keeps only Manage Groups…. A route into a skill or the orphaned copies still
  // opens its pane: deleting every skill is exactly when orphaned copies appear.
  const spanningEmpty = skills !== null && skills.length === 0 && !route.id && !showOrphans;
  const manageGroups = { label: "Manage Groups…", variant: "ghost" as const, onClick: () => setDialog("groups") };
  // The open skill's actions (#1962): Add Assignment… beside ⋯ on a wide pane; on a phone the
  // detail bar's ⋯ holds Add Assignment… and then the same items.
  const addAssignment = { label: "Add Assignment…", disabled: busy, onClick: () => { setError(null); setDialog("add-assignment"); } };
  const openNewSkill = () => { setError(null); setDialog("new-skill"); };
  /** Closing a dialog that shows its own failure takes the failure with it, rather than leaving it on the page. */
  const closeErrorDialog = () => { setDialog(null); setError(null); };
  const detailMenu = detail ? skillDetailMenu(detail, busy, {
    onVersionHistory: () => setDialog("version-history"),
    onMachineVersion: () => { setVersionRunnerId(undefined); setDialog("machine-versions"); },
    onCheckForUpdates: () => setDialog("git-update"),
    onDelete: () => void deleteSkill(detail),
  }) : [];
  const importItems = [
    { label: "Import from Git…", description: "Copy a skill from a Git repository and keep its source.", onClick: () => setDialog("git-import") },
    { label: "Import from Machine…", description: "Snapshot a skill that already lives on a connected machine.", onClick: () => setDialog("machine-import") },
  ];

  return (
    <section className="page full fill">
      {/* Inside the fill page, so the bar and the panes share the column's height; the page has no
          gutter of its own, so the bar stays full-bleed like every detail bar. */}
      {phoneDetail && (
        <DetailBar
          title={route.id ? skillName ?? "Skill" : PANE_TITLES[route.pane!]}
          backLabel={backLabel("skills")}
          onBack={() => select(null)}
          menu={route.id && detail && !listError && detailError?.skillId !== selectedId ? [addAssignment, ...detailMenu] : []}
        />
      )}
      {!phoneDetail && (
        <PageHeader
          title={destination("skills").name}
          description={destination("skills").description}
          // §4.2, left to right: [Manage Groups…] [Import ▾] [+ New Skill]. Manage Groups… is the first
          // into ⋯ as the header narrows; on a phone ⋯ holds it and both imports, one item each.
          secondary={spanningEmpty ? [manageGroups] : [manageGroups, { label: "Import", items: importItems }]}
          primary={spanningEmpty ? undefined : { label: "New Skill", onClick: openNewSkill }}
        />
      )}
      {/* New Skill and Add Assignment show their own request's failure above their footer (§7.3). */}
      {error && dialog !== "new-skill" && dialog !== "add-assignment" && (
        <Notice tone="danger" role="alert" onDismiss={() => setError(null)}>{error}</Notice>
      )}

      {listError ? (
        <div className="master-detail-state">
          <State
            variant="error"
            title="Couldn't Load Skills"
            actions={<button type="button" className="btn sm" onClick={loadList}>Retry</button>}
            details={<div className="code-well"><code>{listError}</code></div>}
          >
            The skill library could not be read. Check the connection to Wollipog, then retry.
          </State>
        </div>
      ) : spanningEmpty ? (
        <div className="master-detail-state">
          <State
            icon={<SkillsIcon />}
            title={`No ${destination("skills").name} Yet`}
            headingLevel={2}
            actions={
              <>
                <button type="button" className="btn primary lg" onClick={openNewSkill}>
                  <PlusIcon />
                  New Skill
                </button>
                <button type="button" className="btn" onClick={() => setDialog("git-import")}>Import from Git…</button>
                <button type="button" className="btn" onClick={() => setDialog("machine-import")}>Import from Machine…</button>
              </>
            }
          >
            Skills teach an agent a repeatable task. Write one here, or import one from Git or from a machine.
          </State>
          {showOrphanEntry && (
            <Notice
              tone="warning"
              title="Orphaned Copies"
              actions={<button type="button" className="btn sm" onClick={() => openPane("orphans")}>Review Orphaned Copies</button>}
            >
              Your machines still hold edited copies that no library skill shows.
            </Notice>
          )}
          <section className="skills-how" aria-labelledby={howId}>
            <h3 id={howId} className="skills-how-title">How Skills Work</h3>
            <Steps horizontal>
              <li><strong>Write or Import</strong><span>Write a skill here, or bring one in from Git or a machine.</span></li>
              <li><strong>Assign</strong><span>Choose which machines and agents get it.</span></li>
              <li><strong>Deploy</strong><span>Each machine installs its assigned skills when it next syncs.</span></li>
            </Steps>
          </section>
        </div>
      ) : (
      <div className="master-detail" data-detail-open={detailOpen ? "" : undefined}>
        <SkillList
          skills={skills}
          groups={groups}
          runners={runners}
          machineSkills={machineSkills}
          selectedId={selectedId}
          onSelect={select}
          orphans={{ shown: showOrphanEntry, count: orphanCount, selected: showOrphans, onOpen: () => openPane("orphans") }}
          // On a phone the overview is a route of its own, opened from the list's first row (§6.2).
          overview={isMobile ? { count: overviewAttention.length, onOpen: () => openPane("overview") } : undefined}
          bodyRef={listBodyRef}
          onBodyScroll={(event) => {
            // A hidden list reports 0; that is not where the person left it.
            if (event.currentTarget.clientHeight > 0) listScrollTop.current = event.currentTarget.scrollTop;
          }}
        />

        <div ref={detailRef} className="master-detail-detail" data-focus-zone="main" tabIndex={-1}>
          {showOrphans ? (
            <SkillOrphanedCopies
              runners={runners}
              machineLabels={machineLabels}
              machineSkills={machineSkills}
              busy={busy}
              syncingRunnerId={syncingRunnerId}
              showTitle={!isMobile}
              onSync={(runnerId) => void syncMachine(runnerId)}
              onReview={(runner, copy) => setOrphanImport({ runnerId: runner.runnerId, copy })}
              onDiscard={(runner, copy) => void discardOrphan(runner, copy)}
              onOpenOverview={() => openPane("overview")}
            />
          ) : selectedId && detailError?.skillId === selectedId ? (
            <State
              variant="error"
              compact
              title="Couldn't Load This Skill"
              actions={<button type="button" className="btn sm" onClick={() => loadDetail(selectedId)}>Retry</button>}
              details={<div className="code-well"><code>{detailError.message}</code></div>}
            >
              It may have been deleted, or Wollipog could not be reached.
            </State>
          ) : selectedId && !detail ? (
            // While the whole library loads, the list's skeleton is the one announcement.
            <DetailSkeleton announce={skills === null ? undefined : "Loading skill"} />
          ) : !selectedId && skills === null ? (
            <DetailSkeleton />
          ) : !selectedId && skills ? (
            // The default detail (§6.1): /skills beside the list, and /skills/overview on its own.
            <SkillsOverview
              skills={skills}
              groups={groups}
              runners={runners}
              machineSkills={machineSkills}
              machineLabels={machineLabels}
              attention={overviewAttention}
              busy={busy}
              showTitle={!isMobile}
              onOpenSkill={select}
              onOpenOrphans={() => openPane("orphans")}
              onAssignRecommended={(skillId, runnerId) => void assignRecommended(skillId, runnerId)}
              onDismissRecommendation={(skillId) => void setRecommendationDismissed(skillId, true)}
              onNewSkill={openNewSkill}
              onImportFromGit={() => setDialog("git-import")}
              onImportFromMachine={() => setDialog("machine-import")}
            />
          ) : null}
          {/* Exactly one detail state: a failed reload never leaves the cached skill actionable below
              its error. */}
          {!showOrphans && detail && detailError?.skillId !== selectedId && (
            <div className="skill-detail">
              <SkillDetailHeader
                key={detail.id}
                skill={detail}
                groupName={detail.groupId ? groups.find((group) => group.id === detail.groupId)?.name : undefined}
                showTitle={!phoneDetail}
                addAssignment={addAssignment}
                menu={detailMenu}
              />
              {/* §13.2: one notice under the header, the most urgent thing this skill needs (#1972). */}
              <SkillNoticeSlot
                key={`notice-${detail.id}`}
                skill={detail}
                runners={runners}
                machineLabels={machineLabels}
                machineSkills={machineSkills}
                rules={detailRules}
                rulesComplete={!detailGroupId || groupRulesCurrent}
                item={noticeItem}
                busy={busy}
                syncingRunnerId={syncingRunnerId}
                onSwitchToAgentInvocable={(rule) => void updateRule(detail.id, rule, { invocation: "agent" })}
                onLimitToClaudeCode={(rule) => void updateRule(detail.id, rule, { agentSelector: { kind: "driver", driver: "claude-code" } })}
                onEditGroups={() => setDialog("groups")}
                onSync={(runnerId) => void syncMachine(runnerId)}
                onReviewEdit={(runnerId, entry) => setDriftImport({
                  runnerId,
                  copy: { name: entry.name, digest: entry.digest, variant: entry.variant },
                  entry,
                })}
                onRestore={(runner, entry) => void restoreDrift(runner, entry)}
                onReviewGitUpdate={() => setDialog("git-update")}
                onReviewBuiltInUpdate={() => setDialog("built-in-review")}
                onAssign={(runnerId) => void assignRecommended(detail.id, runnerId)}
                onChooseAgents={addAssignment.onClick}
                onDismissRecommendation={() => dismissRecommendation(detail.id)}
              />
              {/* §5.1: unboxed sections, in the order Deployment, Assignments, Instructions, Source.
                  #1982 rebuilds what Assignments holds. */}
              <SkillDetailSection title="Deployment" note="What each machine reports.">
                <SkillDeployment
                  key={`deployment-${detail.id}`}
                  skill={detail}
                  runners={runners}
                  machineLabels={machineLabels}
                  machineSkills={machineSkills}
                  rules={detailRules}
                  rulesComplete={!detailGroupId || groupRulesCurrent}
                  groupName={(groupId) => groups.find((group) => group.id === groupId)?.name}
                  syncingRunnerId={syncingRunnerId}
                  onSync={(runnerId) => void syncMachine(runnerId)}
                  onManageVersion={(runnerId) => { setVersionRunnerId(runnerId); setDialog("machine-versions"); }}
                />
              </SkillDetailSection>
              <SkillDetailSection title="Assignments">
                {detail.groupId && <SkillInheritedAssignments key={detail.id} groupId={detail.groupId} groups={groups} runners={runners} machineLabels={machineLabels} onManage={() => setDialog("groups")} />}
                {assignments.length === 0 ? (
                  <p className="skills-hint">No direct assignments. Group assignments may still deploy this skill.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="table skills-table">
                      <thead>
                        <tr>
                          <th scope="col">Scope</th>
                          <th scope="col" className="col-agents">Agents</th>
                          <th scope="col" className="col-invocation">Invocation</th>
                          <th scope="col" className="col-enabled">Enabled</th>
                          <th scope="col" className="col-actions actions-cell"><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {assignments.map((assignment) => {
                          const runner = assignment.runnerId ? runnersMap.get(assignment.runnerId) : undefined;
                          return (
                            <tr key={assignment.id}>
                              <td>{describeAssignmentScope(assignment, (id) => machineLabels.get(id))}</td>
                              <td className="cell-meta cell-fill cell-dim">
                                <span className="cell-label" aria-hidden="true">Agents: </span>
                                {describeAgentSelector(assignment.agentSelector, runner?.agents ?? [])}
                              </td>
                              <td className="cell-meta">
                                <span className="cell-label" aria-hidden="true">Invocation</span>
                                <Select<SkillInvocationPolicy>
                                  label="Invocation"
                                  value={assignment.invocation}
                                  disabled={busy}
                                  options={[
                                    { value: "agent", label: invocationLabel("agent") },
                                    { value: "manual", label: invocationLabel("manual") },
                                  ]}
                                  onChange={(value) => void mutate(
                                    () => api.updateSkillAssignment(assignment.id, { invocation: value }),
                                    async () => {
                                      // The library's lastAssignmentChangedAt feeds Recently Changed.
                                      await refreshList();
                                      await refreshDetail(detail.id);
                                      await refreshMachines();
                                    },
                                  )}
                                />
                              </td>
                              <td className="cell-status">
                                <span className="cell-label" aria-hidden="true">Enabled </span>
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={assignment.enabled}
                                  aria-label="Enabled"
                                  className="btn sm"
                                  disabled={busy}
                                  onClick={() => void mutate(
                                    () => api.updateSkillAssignment(assignment.id, { enabled: !assignment.enabled }),
                                    async () => {
                                      await refreshList();
                                      await refreshDetail(detail.id);
                                      await refreshMachines();
                                    },
                                  )}
                                >
                                  {assignment.enabled ? "On" : "Off"}
                                </button>
                              </td>
                              <td className="actions-cell">
                                <button
                                  type="button"
                                  className="btn ghost danger sm"
                                  disabled={busy}
                                  onClick={() => void (async () => {
                                    const confirmed = await confirm({
                                      title: "Remove Assignment",
                                      message: "The next sync removes the skill from the machines this assignment covered.",
                                      confirmLabel: "Remove Assignment",
                                      tone: "danger",
                                    });
                                    if (!confirmed) return;
                                    await mutate(() => api.deleteSkillAssignment(assignment.id), async () => {
                                      await refreshList();
                                      await refreshDetail(detail.id);
                                      await refreshMachines();
                                    });
                                  })()}
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </SkillDetailSection>
              {latest?.files && latest.files.length > 0 && <SkillInstructions key={`instructions-${latest.id ?? detail.id}`} files={latest.files} />}
              <SkillSource
                key={`source-${detail.id}`}
                skill={detail}
                machineLabels={machineLabels}
                busy={busy}
                heldInSlot={noticeItem?.kind === "git-held"}
                autoUpdate={{
                  saving: autoUpdateSave?.skillId === detail.id && autoUpdateSave.state === "saving",
                  saved: autoUpdateSave?.skillId === detail.id && autoUpdateSave.state === "saved",
                }}
                onCheckForUpdates={() => setDialog("git-update")}
                onSetAutoUpdate={(enabled) => void setGitAutoUpdate(detail.id, enabled)}
                onShowRecommendation={() => showRecommendation(detail.id)}
                onReviewBuiltIn={() => setDialog("built-in-review")}
              />
            </div>
          )}
        </div>
      </div>
      )}

      {dialog === "groups" && <SkillGroupsDialog runners={runners} machineLabels={machineLabels} onClose={() => setDialog(null)} onChanged={async () => {
        setGroupRulesRevision((revision) => revision + 1);
        await refreshList();
        if (selectedId) await refreshDetail(selectedId);
        await refreshMachines();
      }} />}
      {dialog === "new-skill" && (
        <NewSkillDialog busy={busy} error={error} onClose={closeErrorDialog} onCreate={createSkill} />
      )}
      {dialog === "version-history" && detail && <SkillVersionHistoryDialog key={detail.id} skillId={detail.id} machineName={(runnerId) => machineLabels.get(runnerId)} onClose={() => setDialog(null)} onRestored={async () => {
        await refreshList();
        await refreshDetail(detail.id);
        await refreshMachines();
      }} />}
      {dialog === "machine-versions" && detail && <SkillMachineVersionDialog key={detail.id} skillId={detail.id} runners={runners} machineLabels={machineLabels} initialRunnerId={versionRunnerId} onClose={() => { setDialog(null); setVersionRunnerId(undefined); }} onSaved={refreshMachines} />}
      {dialog === "machine-import" && <SkillMachineImportDialog runners={runners} libraryNames={libraryNames} machineLabels={machineLabels} onClose={() => setDialog(null)} onImported={async () => {
        await refreshList();
        if (selectedId) await refreshDetail(selectedId);
        await refreshMachines();
      }} />}
      {(dialog === "git-import" || dialog === "git-update") && <SkillGitImportDialog
        check={dialog === "git-update" && gitSource && detail
          ? { skillName: detail.name, source: { ...gitSource, subdirectory: gitSource.path }, autoUpdate: detail.gitAutoUpdate }
          : undefined}
        libraryVersions={new Map((skills ?? []).map((skill) => [skill.name, skill.latestVersion]))}
        onClose={() => setDialog(null)} onImported={async () => {
          await refreshList();
          if (selectedId) await refreshDetail(selectedId);
          await refreshMachines();
        }} />}
      {driftImport && detail && (
        <SkillDriftImportDialog
          key={`${driftImport.runnerId}:${driftImport.copy.variant}:${driftImport.copy.digest}`}
          skillId={detail.id}
          runnerId={driftImport.runnerId}
          machineLabel={machineLabels.get(driftImport.runnerId) ?? driftImport.runnerId}
          copy={driftImport.copy}
          onClose={() => setDriftImport(null)}
          onImported={async (result) => {
            setDriftImport(null);
            await driftResolved(result);
          }}
          onRestore={(closeReview) => { if (driftRunner) void restoreDrift(driftRunner, driftImport.entry, closeReview); }}
          restoreDisabled={busy || !driftRunner || driftRunner.status !== "online" ||
            !runnerSupportsProtocol(driftRunner.protocolVersion, "skillDrift")}
        />
      )}
      {orphanImport && (
        <SkillOrphanImportDialog
          key={`${orphanImport.runnerId}:${orphanedCopyKey(orphanImport.copy)}`}
          runnerId={orphanImport.runnerId}
          machineLabel={machineLabels.get(orphanImport.runnerId) ?? orphanImport.runnerId}
          copy={orphanImport.copy}
          onClose={() => setOrphanImport(null)}
          onImported={async (result) => {
            setOrphanImport(null);
            await orphanResolved(result);
          }}
          onDiscard={(closeReview) => { if (orphanRunner) void discardOrphan(orphanRunner, orphanImport.copy, closeReview); }}
          discardDisabled={busy || !orphanRunner || !canResolveOrphanedCopy(orphanRunner, orphanImport.copy) ||
            !orphanedCopyDiscardable(orphanImport.copy)}
        />
      )}
      {dialog === "built-in-review" && detail && (
        <SkillBuiltInReviewDialog
          key={detail.id}
          skillId={detail.id}
          skillName={detail.name}
          kind={detail.builtIn ? "update" : "adopt"}
          onClose={() => setDialog(null)}
          onAccepted={async () => {
            setDialog(null);
            await refreshList();
            await refreshDetail(detail.id);
            await refreshMachines();
          }}
        />
      )}
      {dialog === "add-assignment" && detail && (
        <AddAssignmentDialog
          variant="skill"
          runners={runners}
          machineLabels={machineLabels}
          busy={busy}
          error={error}
          onClose={closeErrorDialog}
          onCreate={createAssignment}
        />
      )}
    </section>
  );
}
