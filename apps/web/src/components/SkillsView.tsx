import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { statusMeta } from "../status-meta.js";
import { SKILL_DESCRIPTION_MAX_CHARS, runnerSupportsProtocol, type RunnerView, type SkillDriftState, type SkillFile, type SkillInvocationPolicy } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useStoreActions, useStoreSelector } from "../store.js";
import { machineOptionLabels } from "../runners.js";
import { useFeedback } from "./FeedbackProvider.js";
import { DetailSkeleton, Modal, Skeleton } from "./common.js";
import { accountLabelText } from "../personal-identifiers.js";
import { Select } from "./ui/ChoiceControls.js";
import { PlusIcon, SkillsIcon } from "./Icons.js";
import { Markdown } from "./Markdown.js";
import { Notice } from "./Notice.js";
import { DetailBar, PageHeader } from "./PageHeader.js";
import { Steps } from "./Steps.js";
import { useIsMobile } from "./useIsMobile.js";
import { backLabel, destination, viewPath, type SkillsPane, type View } from "../navigation.js";
import { SkillGitImportDialog } from "./SkillGitImportDialog.js";
import { SkillGitAutoUpdateControls } from "./SkillGitAutoUpdate.js";
import { SkillMachineImportDialog } from "./SkillMachineImportDialog.js";
import { SkillVersionHistoryDialog } from "./SkillVersionHistoryDialog.js";
import { SkillMachineVersionDialog } from "./SkillMachineVersionDialog.js";
import { SkillDriftImportDialog } from "./SkillDriftImportDialog.js";
import { SkillOrphanImportDialog } from "./SkillOrphanImportDialog.js";
import { SkillOrphanedCopies } from "./SkillOrphanedCopies.js";
import { AddAssignmentDialog } from "./SkillAssignmentDialog.js";
import { SkillGroupsDialog } from "./SkillGroupsDialog.js";
import { SkillInheritedAssignments } from "./SkillInheritedAssignments.js";
import { SkillAssignmentMatrix } from "./SkillAssignmentMatrix.js";
import { SkillBuiltInSection } from "./SkillBuiltInSection.js";
import { SkillBuiltInReviewDialog } from "./SkillBuiltInReviewDialog.js";
import {
  describeAgentSelector,
  describeAssignmentScope,
  driftVariantLabel,
  groupSkillList,
  invocationLabel,
  normalizeRemovalReporting,
  omittedKeptAsideCopies,
  orphanedCopyKey,
  orphanedCopyRef,
  reportedOrphanedCopies,
  reportedSkillDrift,
  reportedSkillLinkRemovals,
  reportedUnmanagedSkills,
  skillAssignmentsFromPayload,
  skillDeployBadge,
  skillFilesFromUploads,
  skillFromPayload,
  skillGroupsFromPayload,
  skillMarkdownBody,
  skillMarkdownTemplate,
  skillRecommended,
  skillsFromPayload,
  validateSkillDraft,
  type RunnerSkillsResponse,
  type SkillAgentSelector,
  type SkillAssignmentView,
  type OrphanedSkillCopy,
  type OrphanedSkillCopyResolution,
  type SkillDriftCopy,
  type SkillDriftResolution,
  type SkillGroupView,
  type SkillSummary,
} from "../skills.js";

function formatTime(value: number | undefined): string {
  return value === undefined ? "—" : new Date(value).toLocaleString();
}

function NewSkillDialog({ onClose, onCreate, busy }: {
  onClose: () => void;
  onCreate: (input: { name: string; description: string; files: SkillFile[] }) => Promise<void>;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [markdown, setMarkdown] = useState(() => skillMarkdownTemplate("", ""));
  const [markdownTouched, setMarkdownTouched] = useState(false);
  const [folderFiles, setFolderFiles] = useState<SkillFile[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  const buildFiles = (): SkillFile[] => folderFiles.length
    ? folderFiles
    : [{ path: "SKILL.md", content: markdown, encoding: "utf8" }];

  const readFolder = async (list: FileList | null) => {
    if (!list || list.length === 0) {
      setFolderFiles([]);
      return;
    }
    const uploads = await Promise.all([...list].map(async (file) => ({
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })));
    const converted = skillFilesFromUploads(uploads);
    setErrors(converted.errors);
    setFolderFiles(converted.files);
  };

  const submit = async () => {
    const files = buildFiles();
    const found = validateSkillDraft({ name: name.trim(), files });
    setErrors(found);
    if (found.length) return;
    await onCreate({ name: name.trim(), description: description.trim(), files });
  };

  return (
    <Modal title="New Skill" onClose={onClose} size="lg" footer={
      <>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Creating…" : "Create Skill"}
        </button>
      </>
    }>
      <div className="form">
        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            value={name}
            maxLength={64}
            placeholder="my-skill"
            onChange={(event) => {
              const next = event.target.value;
              setName(next);
              if (!markdownTouched) setMarkdown(skillMarkdownTemplate(next, description));
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <input
            value={description}
            maxLength={SKILL_DESCRIPTION_MAX_CHARS}
            placeholder="What this skill helps an agent do"
            onChange={(event) => {
              const next = event.target.value;
              setDescription(next);
              if (!markdownTouched) setMarkdown(skillMarkdownTemplate(name, next));
            }}
          />
        </label>
        <label className="field">
          <span>SKILL.md</span>
          <textarea
            value={markdown}
            rows={10}
            disabled={folderFiles.length > 0}
            onChange={(event) => {
              setMarkdownTouched(true);
              setMarkdown(event.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>Folder Upload</span>
          <input
            type="file"
            multiple
            {...({ webkitdirectory: "" } as Record<string, string>)}
            onChange={(event) => void readFolder(event.target.files)}
          />
          <small className="skills-hint">
            Optional: pick a skill folder to upload every file in it. The folder replaces the SKILL.md editor above.
          </small>
        </label>
        {folderFiles.length > 0 && (
          <p className="skills-hint">
            {folderFiles.length} file{folderFiles.length === 1 ? "" : "s"} ready: {folderFiles.map((file) => file.path).join(", ")}
          </p>
        )}
        {errors.length > 0 && (
          <div className="form-error" role="alert">
            {errors.map((message) => <div key={message}>{message}</div>)}
          </div>
        )}
      </div>
    </Modal>
  );
}


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
  const [groups, setGroups] = useState<SkillGroupView[]>([]);
  const [loadedDetail, setDetail] = useState<SkillSummary | null>(null);
  // A detail loaded for an earlier selection is never shown under the current one.
  const detail = loadedDetail && loadedDetail.id === selectedId ? loadedDetail : null;
  const [assignments, setAssignments] = useState<SkillAssignmentView[]>([]);
  const [machineSkills, setMachineSkills] = useState<Record<string, RunnerSkillsResponse>>({});
  const [busy, setBusy] = useState(false);
  const [syncingRunnerId, setSyncingRunnerId] = useState<string | null>(null);
  const [versionRunnerId, setVersionRunnerId] = useState<string | undefined>();
  const [driftImport, setDriftImport] = useState<{ runnerId: string; copy: SkillDriftCopy } | null>(null);
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
    const [skillsPayload, groupsPayload] = await Promise.all([api.listSkills(), api.listSkillGroups()]);
    if (generation !== listGeneration.current) return;
    setSkills(skillsFromPayload(skillsPayload));
    setGroups(skillGroupsFromPayload(groupsPayload));
  }, [api]);

  const refreshDetail = useCallback(async (skillId: string) => {
    // A mutation that finishes after the user selected another skill, or none, refreshes nothing.
    if (selectedRef.current !== skillId) return;
    const generation = (detailGeneration.current += 1);
    const [detailPayload, assignmentsPayload] = await Promise.all([
      api.getSkill(skillId),
      api.listSkillAssignments(skillId),
    ]);
    if (generation !== detailGeneration.current || selectedRef.current !== skillId) return;
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

  const grouped = useMemo(() => groupSkillList(skills ?? [], groups), [skills, groups]);

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
  }) => {
    if (!selectedId) return;
    await mutate(async () => {
      await api.createSkillAssignment({ skillId: selectedId, ...input });
      setDialog(null);
    }, async () => {
      // The list's assignment counts decide which built-in skills are still recommended.
      await refreshList();
      await refreshDetail(selectedId);
      await refreshMachines();
    });
  };

  /** One-step assignment of a recommended built-in skill to every supported agent. */
  const assignRecommended = (runnerId: string | null) => createAssignment({
    scopeKind: runnerId ? "runner" : "instance",
    ...(runnerId ? { runnerId } : {}),
    agentSelector: { kind: "all" },
    invocation: "agent",
  });

  const setRecommendationDismissed = async (skillId: string, dismissed: boolean) => {
    await mutate(() => api.setSkillRecommendationDismissed(skillId, dismissed), async () => {
      await refreshList();
      await refreshDetail(skillId);
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

  /** Names with a reported edited copy on any machine, so the list can point at them. */
  const driftedSkillNames = useMemo(() => new Set(Object.values(machineSkills)
    .flatMap((machine) => machine.reported?.drift ?? []).map((entry) => entry.name)), [machineSkills]);

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

  const orphanResolved = async (result: OrphanedSkillCopyResolution) => {
    if (result.warning) showToast(result.warning, { tone: "error" });
    await refreshList();
    if (selectedId) await refreshDetail(selectedId);
    await refreshMachines();
  };

  const discardOrphan = async (runner: RunnerView, copy: OrphanedSkillCopy) => {
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
    await mutate(async () => {
      // Exactly what the machine reported: a kept-aside copy's fingerprint of every entry, plus its content
      // digest when readable; a deleted skill's copy by its digest, or null when it was unreadable.
      const result = await api.discardOrphanedSkillCopy(runner.runnerId, orphanedCopyRef(copy), copy.kind === "kept_aside"
        ? { observedFingerprint: copy.observedFingerprint!, ...(copy.observedDigest ? { observedDigest: copy.observedDigest } : {}) }
        : { observedDigest: copy.observedDigest ?? null });
      await orphanResolved(result);
    });
  };

  const restoreDrift = async (runner: RunnerView, entry: SkillDriftState) => {
    const machine = machineLabels.get(runner.runnerId) ?? runner.runnerId;
    const confirmed = await confirm({
      title: "Restore Library Version",
      message: `The edited copy of “${entry.name}” on ${machine} is discarded and cannot be recovered. If the library still ` +
        "has the version it was deployed from, the machine rebuilds that version in its place, then syncs to its assigned version.",
      confirmLabel: "Restore Library Version",
      tone: "danger",
    });
    if (!confirmed) return;
    await mutate(async () => {
      const result = await api.restoreSkillDrift(runner.runnerId,
        { name: entry.name, digest: entry.digest, variant: entry.variant }, entry.observedDigest ?? null);
      await driftResolved(result);
    });
  };

  const latest = detail?.latestVersion ?? null;
  const gitSource = detail?.gitSource ?? latest?.gitSource;
  const heldUpdate = detail?.gitAutoUpdate?.enabled ? detail.gitAutoUpdate.held : null;
  const skillMd = latest?.files?.find((file) => file.path === "SKILL.md" && file.encoding === "utf8");

  const howId = `skills-how-${useId().replace(/:/g, "")}`;
  const skillName = detail?.name ?? skills?.find((skill) => skill.id === selectedId)?.name;
  // On a phone the list and the open detail are two screens (§6.2): the detail takes the app bar,
  // as the shared detail bar with Back, and the list is hidden until Back.
  const phoneDetail = isMobile && detailOpen;
  const showOrphanEntry = orphanCount > 0 || showOrphans || keptAsideUnreported;
  // An empty library is one state across both panes (§6.1, §12.1), and that state offers creation,
  // so the header keeps only Manage Groups…. A route into a skill or the orphaned copies still
  // opens its pane: deleting every skill is exactly when orphaned copies appear.
  const spanningEmpty = skills !== null && skills.length === 0 && !route.id && !showOrphans;
  const manageGroups = { label: "Manage Groups…", variant: "ghost" as const, onClick: () => setDialog("groups") };
  const importItems = [
    { label: "Import from Git…", description: "Copy a skill from a Git repository and keep its source.", onClick: () => setDialog("git-import") },
    { label: "Import from Machine…", description: "Snapshot a skill that already lives on a connected machine.", onClick: () => setDialog("machine-import") },
  ];

  return (
    <>
    {phoneDetail && (
      <DetailBar
        title={route.id ? skillName ?? "Skill" : PANE_TITLES[route.pane!]}
        backLabel={backLabel("skills")}
        onBack={() => select(null)}
      />
    )}
    <section className="page full fill">
      {!phoneDetail && (
        <PageHeader
          title={destination("skills").name}
          description={destination("skills").description}
          // §4.2, left to right: [Manage Groups…] [Import ▾] [+ New Skill]. Manage Groups… is the first
          // into ⋯ as the header narrows; on a phone ⋯ holds it and both imports, one item each.
          secondary={spanningEmpty ? [manageGroups] : [manageGroups, { label: "Import", items: importItems }]}
          primary={spanningEmpty ? undefined : { label: "New Skill", onClick: () => setDialog("new-skill") }}
        />
      )}
      {error && <Notice tone="danger" role="alert" onDismiss={() => setError(null)}>{error}</Notice>}

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
                <button type="button" className="btn primary lg" onClick={() => setDialog("new-skill")}>
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
        <aside className="master-detail-list" aria-label="Skills" data-focus-zone="list" tabIndex={-1}>
          {showOrphanEntry && (
            <div className="master-detail-list-head clip-focus">
              <button
                type="button"
                className={`row row-2${showOrphans ? " is-selected" : ""}`}
                aria-current={showOrphans ? "true" : undefined}
                onClick={() => openPane("orphans")}
              >
                <span className="row-body">
                  <span className="row-line">
                    <span className="row-title">Orphaned Copies</span>
                    {orphanCount > 0 && <StatusBadge tone="warning" noDot label={orphanCount} />}
                  </span>
                  <span className="row-sub">Edited copies on machines that no library skill shows</span>
                </span>
              </button>
            </div>
          )}
          <div
            ref={listBodyRef}
            className="master-detail-list-body clip-focus"
            onScroll={(event) => {
              // A hidden list reports 0; that is not where the person left it.
              if (event.currentTarget.clientHeight > 0) listScrollTop.current = event.currentTarget.scrollTop;
            }}
          >
            {skills === null && <Skeleton rows={5} announce="Loading skills" />}
            {grouped.map((group) => (
              <div className="skills-group" key={group.id ?? "ungrouped"}>
                <h3 className="skills-group-title">{group.name}</h3>
                {group.skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className={`row${skill.description ? " row-2" : ""}${selectedId === skill.id ? " is-selected" : ""}`}
                    aria-current={selectedId === skill.id ? "true" : undefined}
                    onClick={() => select(skill.id)}
                  >
                    <span className="row-body">
                      <span className="row-line">
                        <span className="row-title">{skill.name}</span>
                        {driftedSkillNames.has(skill.name) && <StatusBadge meta={statusMeta("skill", "edited")} />}
                        {skill.builtIn && <StatusBadge tone="neutral" noDot label="Built-In" />}
                        {skillRecommended(skill) && <StatusBadge tone="neutral" noDot label="Recommended" />}
                      </span>
                      {skill.description && <span className="row-sub">{skill.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <div ref={detailRef} className="master-detail-detail" data-focus-zone="main" tabIndex={-1}>
          {showOrphans ? (
            <SkillOrphanedCopies
              runners={runners}
              machineLabels={machineLabels}
              machineSkills={machineSkills}
              busy={busy}
              syncingRunnerId={syncingRunnerId}
              onSync={(runnerId) => void syncMachine(runnerId)}
              onReview={(runner, copy) => setOrphanImport({ runnerId: runner.runnerId, copy })}
              onDiscard={(runner, copy) => void discardOrphan(runner, copy)}
            />
          ) : skills === null ? (
            <DetailSkeleton />
          ) : !selectedId ? (
            /* The default detail (/skills, /skills/overview) until the Library Overview (#1971)
               replaces it. */
            <p className="skills-hint">
              Select a skill to see its content, assignments, and per-machine deployment.
            </p>
          ) : detailError?.skillId === selectedId ? (
            <State
              variant="error"
              compact
              title="Couldn't Load This Skill"
              actions={<button type="button" className="btn sm" onClick={() => loadDetail(selectedId)}>Retry</button>}
              details={<div className="code-well"><code>{detailError.message}</code></div>}
            >
              It may have been deleted, or Wollipog could not be reached.
            </State>
          ) : !detail ? (
            <DetailSkeleton announce="Loading skill" />
          ) : null}
          {!showOrphans && detail && (
            <>
              <div className="skills-detail-head">
                <div>
                  <h3>{detail.name}</h3>
                  {detail.description && <p className="skills-hint">{detail.description}</p>}
                  <p className="skills-meta muted">
                    {latest?.digest ? `Version ${latest.digest.slice(0, 12)}` : "No version recorded"}
                    {" · "}
                    {formatTime(latest?.createdAt)}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn ghost danger sm"
                  disabled={busy}
                  onClick={() => void deleteSkill(detail)}
                >
                  Delete Skill
                </button>
              </div>

              <SkillBuiltInSection
                key={`built-in-${detail.id}`}
                skill={detail}
                runners={runners}
                machineLabels={machineLabels}
                busy={busy}
                onAssign={(runnerId) => void assignRecommended(runnerId)}
                onDismiss={(dismissed) => void setRecommendationDismissed(detail.id, dismissed)}
                onReview={() => setDialog("built-in-review")}
              />
              <button className="btn sm" type="button" onClick={() => setDialog("version-history")}>Version History</button>
              <button className="btn sm" type="button" onClick={() => setDialog("machine-versions")}>Machine Versions</button>
              {skillMd && (
                <section className="skills-section" aria-label="Skill Content">
                  <h4>Content</h4>
                  <div className="skills-doc">
                    <Markdown highlightEligible={false}>{skillMarkdownBody(skillMd.content)}</Markdown>
                  </div>
                </section>
              )}

              {gitSource && <section className="skills-section skills-git-source">
                <h4>Git Source</h4>
                <p className="skills-hint">{gitSource.url} · {gitSource.path || "/"} · {gitSource.ref}</p>
                <p className="skills-hint">Commit {gitSource.commit}</p>
                <SkillGitAutoUpdateControls status={detail.gitAutoUpdate} gitRef={gitSource.ref} busy={busy}
                  onChange={(enabled) => void mutate(() => api.setSkillGitAutoUpdate(detail.id, enabled), () => refreshDetail(detail.id))} />
                <button className={`btn sm${heldUpdate ? " primary" : ""}`} type="button" onClick={() => setDialog("git-update")}>
                  {heldUpdate ? "Review Held Update" : "Check for Updates"}
                </button>
              </section>}
              {latest?.machineSource && <section className="skills-section skills-machine-import">
                <h4>Machine Snapshot Source</h4>
                <p className="skills-hint">{machineLabels.get(latest.machineSource.runnerId) ?? latest.machineSource.runnerId} · {latest.machineSource.context?.kind === "wsl" ? `WSL: ${latest.machineSource.context.distro} · ` : ""}{latest.machineSource.sourceDirectory}/{latest.machineSource.name}</p>
                <p className="skills-hint">Digest: {latest.machineSource.digest}</p>
                <p className="skills-hint">Imported {formatTime(latest.machineSource.importedAt)}. This records a snapshot, not an adopted source directory.</p>
              </section>}

              {detail.groupId && <SkillInheritedAssignments key={detail.id} groupId={detail.groupId} groups={groups} runners={runners} machineLabels={machineLabels} onManage={() => setDialog("groups")} />}
              <section className="skills-section" aria-label="Assignments">
                <div className="skills-section-heading">
                  <h4>Assignments</h4>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => { setError(null); setDialog("add-assignment"); }}>
                    Add Assignment
                  </button>
                </div>
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
              </section>

              <SkillAssignmentMatrix key={`matrix-${detail.id}`} skillId={detail.id} skillName={detail.name} runners={runners} machineLabels={machineLabels} machineSkills={machineSkills} onManageVersion={runnerId => { setVersionRunnerId(runnerId); setDialog("machine-versions"); }} />
              <section className="skills-section" aria-label="Deployment">
                <h4>Deployment</h4>
                {runners.length === 0 && <p className="skills-hint">Connect a machine to deploy this skill.</p>}
                {runners.map((runner) => {
                  const machine = machineSkills[runner.runnerId];
                  const desired = machine?.desired.find((entry) => entry.name === detail.name);
                  const badge = skillDeployBadge({
                    loadError: machine?.loadError,
                    loading: !machine,
                    runnerOnline: runner.status === "online",
                    desired,
                    reported: machine?.reported,
                    skillName: detail.name,
                    agents: runner.agents,
                    providerAccounts: runner.providerAccounts,
                  });
                  const unmanaged = reportedUnmanagedSkills(machine?.reported);
                  const removals = reportedSkillLinkRemovals(machine?.reported);
                  const removalReporting = machine?.removalReporting ?? "unknown";
                  const drift = reportedSkillDrift(machine?.reported, detail.name);
                  const canResolveDrift = runner.status === "online" && !busy &&
                    runnerSupportsProtocol(runner.protocolVersion, "skillDrift");
                  const machineLabel = machineLabels.get(runner.runnerId) ?? runner.runnerId;
                  return (
                    <article className="skills-machine" key={runner.runnerId}>
                      <div className="skills-machine-head">
                        <strong>{machineLabels.get(runner.runnerId) ?? runner.runnerId}</strong>
                        <StatusBadge meta={badge} title={badge.detail} />
                        <button
                          type="button"
                          className="btn sm"
                          disabled={runner.status !== "online" || syncingRunnerId !== null}
                          onClick={() => void syncMachine(runner.runnerId)}
                        >
                          {syncingRunnerId === runner.runnerId ? "Syncing…" : "Sync Now"}
                        </button>
                      </div>
                      {badge.detail && <p className="skills-hint">{badge.detail}</p>}
                      {drift.length > 0 && (
                        <div className="skills-drift">
                          <h5>Edited Copies</h5>
                          <ul>
                            {drift.map((entry) => (
                              <li key={`${entry.variant}:${entry.digest}`}>
                                <strong>{driftVariantLabel(entry.variant)}</strong>
                                <span className="muted"> · Version {entry.digest.slice(0, 12)}</span>
                                {entry.detail && <p className="skills-hint">{entry.detail}</p>}
                                <div className="skills-drift-actions">
                                  <button
                                    type="button"
                                    className="btn sm"
                                    disabled={!canResolveDrift || !entry.observedDigest}
                                    onClick={() => setDriftImport({
                                      runnerId: runner.runnerId,
                                      copy: { name: entry.name, digest: entry.digest, variant: entry.variant },
                                    })}
                                  >
                                    Import Edit as New Version
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost danger sm"
                                    disabled={!canResolveDrift}
                                    onClick={() => void restoreDrift(runner, entry)}
                                  >
                                    Restore Library Version
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                          {runner.status === "online" && !runnerSupportsProtocol(runner.protocolVersion, "skillDrift") && (
                            <p className="skills-hint">Update this machine's runner to resolve edited copies here.</p>
                          )}
                        </div>
                      )}
                      {unmanaged.length > 0 && (
                        <div className="skills-unmanaged">
                          <h5>Unmanaged Skills</h5>
                          <ul>
                            {unmanaged.map((entry) => (
                              <li key={`${entry.providerAccountId ?? "legacy"}:${entry.agentId}:${entry.name}`}>
                                <strong>{entry.name}</strong>
                                {entry.providerAccountId && <span className="muted"> · {accountLabelText(
                                  runner.providerAccounts?.find((account) => account.id === entry.providerAccountId)?.label ??
                                    "Provider Account",
                                )}</span>}
                                <span className="muted"> · {entry.agentId}</span>
                                {entry.description && <span className="muted"> — {entry.description}</span>}
                              </li>
                            ))}
                          </ul>
                          <p className="skills-hint">
                            These skills live on the machine but are not managed here. Use Import from Machine to preview or import a snapshot. On a compatible Linux runner, an identical assigned version can then be adopted with an explicit recovery-aware confirmation.
                          </p>
                        </div>
                      )}
                      {machine && (removals.length > 0 || removalReporting !== "unknown") && (
                        <div className="skills-removals">
                          <h5>Recent Link Removals</h5>
                          {removalReporting === "unsupported" && (
                            <p className="skills-hint">
                              This runner version cannot report new managed link removals.
                            </p>
                          )}
                          {removalReporting === "supported" && removals.length === 0 && (
                            <p className="skills-hint">No managed link removals have been reported.</p>
                          )}
                          {removals.length > 0 && (
                            <>
                              <p className="skills-hint">
                                Reported {formatTime(machine.reported?.removalsUpdatedAt ?? machine.reported?.updatedAt)}
                              </p>
                              <ul>
                                {removals.map((entry, index) => (
                                  <li key={`${entry.path}:${entry.reason}:${index}`}>
                                    <strong>{entry.path}</strong>
                                    {entry.providerAccountId && <span className="muted"> · {accountLabelText(
                                      runner.providerAccounts?.find((account) => account.id === entry.providerAccountId)?.label ??
                                        "Provider Account",
                                    )}</span>}
                                    <span className="muted"> — {entry.reason}</span>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </section>
            </>
          )}
        </div>
      </div>
      )}

      {dialog === "groups" && <SkillGroupsDialog runners={runners} machineLabels={machineLabels} onClose={() => setDialog(null)} onChanged={async () => {
        await refreshList();
        if (selectedId) await refreshDetail(selectedId);
        await refreshMachines();
      }} />}
      {dialog === "new-skill" && (
        <NewSkillDialog busy={busy} onClose={() => setDialog(null)} onCreate={createSkill} />
      )}
      {dialog === "version-history" && detail && <SkillVersionHistoryDialog key={detail.id} skillId={detail.id} onClose={() => setDialog(null)} onRestored={async () => {
        await refreshList();
        await refreshDetail(detail.id);
        await refreshMachines();
      }} />}
      {dialog === "machine-versions" && detail && <SkillMachineVersionDialog key={detail.id} skillId={detail.id} runners={runners} initialRunnerId={versionRunnerId} onClose={() => { setDialog(null); setVersionRunnerId(undefined); }} onSaved={refreshMachines} />}
      {dialog === "machine-import" && <SkillMachineImportDialog runners={runners} onClose={() => setDialog(null)} onImported={async () => {
        await refreshList();
        if (selectedId) await refreshDetail(selectedId);
        await refreshMachines();
      }} />}
      {(dialog === "git-import" || dialog === "git-update") && <SkillGitImportDialog
        source={dialog === "git-update" && gitSource ? { ...gitSource, subdirectory: gitSource.path } : undefined}
        onClose={() => setDialog(null)} onImported={async () => {
          await refreshList();
          if (selectedId) await refreshDetail(selectedId);
          await refreshMachines();
        }} />}
      {driftImport && detail && (
        <SkillDriftImportDialog
          key={`${driftImport.runnerId}:${driftImport.copy.variant}:${driftImport.copy.digest}`}
          runnerId={driftImport.runnerId}
          machineLabel={machineLabels.get(driftImport.runnerId) ?? driftImport.runnerId}
          copy={driftImport.copy}
          onClose={() => setDriftImport(null)}
          onImported={async (result) => {
            setDriftImport(null);
            await driftResolved(result);
          }}
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
        />
      )}
      {dialog === "built-in-review" && detail && (
        <SkillBuiltInReviewDialog
          key={detail.id}
          skillId={detail.id}
          skillName={detail.name}
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
          skill={detail}
          runners={runners}
          machineLabels={machineLabels}
          busy={busy}
          error={error}
          onClose={() => setDialog(null)}
          onCreate={createAssignment}
        />
      )}
    </section>
    </>
  );
}
