# Icon System

Wollipog keeps its public icon component names in
`apps/web/src/components/Icons.tsx`. Generic interface glyphs are named imports from
`lucide-react` and render through `LibraryIcon`; production components must never import Lucide
directly. This preserves one size, stroke, class, and accessibility contract while allowing the
underlying glyph set to be reviewed centrally.

Custom geometry is limited to product or vendor marks for which Lucide deliberately has no
equivalent. New exceptions require a rationale in this inventory and an ownership-test update.
Removal candidates should be deleted with all consumers rather than left as unused compatibility
exports.

## One Glyph per Meaning

Each export renders its own Lucide glyph, and each meaning has one export (docs/design-system.md
§18). No two exports share a glyph: the ownership test in `apps/web/src/icons.test.ts` fails when
two rows map to the same one.

## Sizes

`LibraryIcon` draws at 14, 16, 20 or 24px (`ICON_SIZES` in `Icons.tsx`): 14 beside small text, 16 by
default, 20 for prominent toolbar icons, and 24 for empty-state tiles and the phone tab bar. Any other
size logs a warning in development, the desktop rail's included: it draws at 20px, and its phone
tabs at 24px. Product and vendor marks (`AgentIcon` and the custom exceptions below) keep their own
sizes. A unit test fails when a production component passes an
icon a literal size off the scale, and `stylesheet-guardrails.test.ts` fails when a stylesheet rule
sets an icon's width or height to a px value off it.

## Text Glyphs

Characters such as ×, ✕, ✓, ▸, ▾, ↻ and → render in the text font rather than as icons.
`apps/web/src/text-glyph-ratchet.test.ts` records every production site that still uses one, with
the area epic that removes it, and fails when a new site appears. Legitimate text, such as a
keycap's display key or a multiplication sign in a label, is exempted there by name with a reason.

## Export Inventory

| Export | Decision | Mapping or Exception | Rationale |
| --- | --- | --- | --- |
| `GridIcon` | Lucide | `Grid2X2` | Generic grid navigation. |
| `InboxIcon` | Lucide | `Inbox` | Generic inbox navigation, and the Sessions No Sessions Yet state (#2220). |
| `ProjectsIcon` | Lucide | `FolderKanban` | Project collection navigation. |
| `BoardIcon` | Lucide | `Columns3` | Generic board columns. |
| `ListIcon` | Lucide | `List` | Generic list layout. |
| `FilterIcon` | Lucide | `ListFilter` | The phone Board's Filters button, which opens the Filters sheet. |
| `AlarmClockIcon` | Lucide | `AlarmClock` | Snooze: a snoozed Sessions row's return time (#2209) and the Sessions preview bar's Snooze button (#2210), and the Sessions No Snoozed Sessions and No Active Sessions states (#2220). |
| `DismissReminderIcon` | Lucide | `AlarmClockOff` | Dismiss Reminder in the Sessions context menu (#2214). |
| `ConnectionsIcon` | Lucide | `MonitorCog` | Runner connection management. |
| `RunsIcon` | Lucide | `Workflow` | Generic workflow runs. |
| `PodsIcon` | Lucide | `UsersRound` | Collaboration group. |
| `AutomationsIcon` | Lucide | `Zap` | Automation action. |
| `ServiceTierIcon` | Lucide | `Gauge` | Fast service-tier setting; distinct from the Automations bolt. |
| `CostIcon` | Lucide | `DollarSign` | A dollar amount inside a field, such as the Guardrails cost thresholds; the Request Card's Budget kind. |
| `CountIcon` | Lucide | `Hash` | A whole count inside a field, such as the Guardrails tool-call and live-child limits. |
| `SkillsIcon` | Lucide | `WandSparkles` | Reusable agent capability; a skill step in the transcript. |
| `RecommendedIcon` | Lucide | `Sparkles` | Something Wollipog recommends, such as a built-in skill. |
| `ArchiveIcon` | Lucide | `Archive` | Archived Sessions destination, outline like every rail glyph. |
| `UsageIcon` | Lucide | `ChartNoAxesColumn` | Usage metrics. |
| `ChevronDownIcon` | Lucide | `ChevronDown` | Directional disclosure. |
| `ChevronRightIcon` | Lucide | `ChevronRight` | Directional disclosure. |
| `ChevronLeftIcon` | Lucide | `ChevronLeft` | Directional disclosure. |
| `ChevronUpIcon` | Lucide | `ChevronUp` | Expand on the request dock's reading-back strip. |
| `ChevronsDownIcon` | Lucide | `ChevronsDown` | Show Context: Answer Mode shrinks to its head so the transcript shows. |
| `ChevronsUpIcon` | Lucide | `ChevronsUp` | Show Answer: Answer Mode's panel opens again. |
| `PlusIcon` | Lucide | `Plus` | Generic add action. |
| `PinIcon` | Lucide | `Pin` | Pinned session state. |
| `UnpinIcon` | Lucide | `PinOff` | Unpin Session in the Sessions context menu (#2214). |
| `ReplyIcon` | Lucide | `Reply` | Reply to a session: open it with the composer focused (#2214). |
| `MarkUnreadIcon` | Lucide | `MessageSquareDot` | Mark a session unread (#2214); `Mail` already means an email address. |
| `MarkReadIcon` | Lucide | `MessageSquareCheck` | Mark a session read (#2214). |
| `MoreHorizontalIcon` | Lucide | `Ellipsis` | Horizontal overflow menu. |
| `MoreVerticalIcon` | Lucide | `EllipsisVertical` | Vertical overflow menu. |
| `ShareIcon` | Lucide | `Share` | Generic share action. |
| `LinkIcon` | Lucide | `Link` | Copy a link to a page. |
| `DownloadIcon` | Lucide | `Download` | Export or download a file. |
| `RefreshIcon` | Lucide | `RefreshCw` | Generic refresh action. |
| `UpdateIcon` | Lucide | `Upload` | Install or upload an update. |
| `SearchIcon` | Lucide | `Search` | Generic search action. |
| `SearchOffIcon` | Lucide | `SearchX` | A search with no matches: the Sessions No Matches state. |
| `MapPinOffIcon` | Lucide | `MapPinOff` | A Project with no Location: the Sessions No Location Yet and No Location Available states (#2220). |
| `CloudOffIcon` | Lucide | `CloudOff` | A Project whose only Locations are on offline machines: the Sessions Location Offline state (#2220). |
| `CloseIcon` | Lucide | `X` | Generic close action. |
| `SettingsIcon` | Lucide | `Settings` | Generic settings navigation. |
| `UserPlusIcon` | Lucide | `UserPlus` | Add a collaborator. |
| `DeviceIcon` | Lucide | `Smartphone` | Paired device. |
| `TeamIcon` | Lucide | `Users` | Team or access group. |
| `EditIcon` | Lucide | `Pencil` | Generic edit action. |
| `CopyIcon` | Lucide | `Copy` | Generic copy action. |
| `CheckIcon` | Lucide | `Check` | Generic success state; a completed transcript step. |
| `SelectLinesIcon` | Lucide | `TextSelection` | Review's Select Lines toggle, which turns line selection on in the diff (#2849). |
| `WrapLinesIcon` | Lucide | `WrapText` | The Wrap Lines toggle in a markdown code block's header and in an artifact preview's code well (#2855). |
| `WarningIcon` | Lucide | `TriangleAlert` | Generic warning state. |
| `InfoIcon` | Lucide | `Info` | Generic information state; the info and neutral tone icon on toasts and notices; the session bar's Pinned Summary toggle, which opens the session's details column. |
| `SuccessIcon` | Lucide | `CircleCheck` | The success tone icon on toasts and notices; a completed plan step; an allowed or answered Decision Record; the UI evidence digest caption. |
| `DecisionClosedIcon` | Lucide | `CircleX` | A Decision Record that ended without going ahead: Rejected, Dismissed, Ended Early, Replaced, Resolved by Provider. |
| `DecisionBlockedIcon` | Lucide | `ShieldX` | A Decision Record blocked by a policy or fail-closed; a UI evidence tile whose bytes don't match the request's digest. |
| `DecisionTimedOutIcon` | Lucide | `TimerOff` | A Decision Record whose deadline passed. |
| `PlanPendingIcon` | Lucide | `Circle` | A plan step not started yet. |
| `PlanInProgressIcon` | Lucide | `CircleDot` | The plan step in progress. |
| `ErrorIcon` | Lucide | `CircleAlert` | The danger tone icon on toasts and notices; the failed count on a work ledger line; a UI evidence tile that Can't Load or Can't Show. |
| `KeyboardIcon` | Lucide | `Keyboard` | Keyboard shortcuts. |
| `AccountIcon` | Lucide | `CircleUserRound` | The provider account a session runs under. |
| `SignInIcon` | Lucide | `KeyRound` | The Request Card's Sign-In kind: a sign-in the session waits for (#2198). |
| `LockIcon` | Lucide | `Lock` | Locked or restricted state; a masked identifier that is not an email. |
| `SecureContextRequiredIcon` | Lucide | `LockKeyhole` | A page that must be HTTPS or localhost to check evidence: the HTTPS or Localhost Required notice and a UI evidence tile that is Not Shown. |
| `PlayIcon` | Lucide | `Play` | A recording: the mark over a UI evidence tile's first frame. |
| `MailIcon` | Lucide | `Mail` | A masked or revealed email address. |
| `EyeIcon` | Lucide | `Eye` | Reveal a masked personal identifier. |
| `EyeOffIcon` | Lucide | `EyeOff` | Hide a revealed personal identifier. |
| `PanelRightIcon` | Lucide | `PanelRight` | Right panel placement; Preview Right, the Sessions preview beside the list (#2219). |
| `PanelBottomIcon` | Lucide | `PanelBottom` | Preview Below, the Sessions preview under the list (#2219). |
| `Maximize2Icon` | Lucide | `Maximize2` | Show something larger: Expand Panel, where the side panel fills the session's content area (#2845), and an artifact preview's Enlarge, which opens an image or HTML preview in a full dialog (#2855). |
| `Minimize2Icon` | Lucide | `Minimize2` | Restore Panel: an expanded side panel returns beside the chat (#2845). |
| `PanelLeftOpenIcon` | Lucide | `PanelLeftOpen` | Expand Navigation: show names in the desktop rail. |
| `PanelLeftCloseIcon` | Lucide | `PanelLeftClose` | Collapse Navigation: return the desktop rail to icons. |
| `CommandLineIcon` | Lucide | `SquareTerminal` | Command-line destination; the session bar's Terminal toggle. |
| `GlobeIcon` | Lucide | `Globe` | Remote host; a web fetch step in the transcript. |
| `FolderIcon` | Lucide | `Folder` | Generic directory, and the Sessions No Sessions Without a Project state (#2220). |
| `FileIcon` | Lucide | `File` | Generic file; a file row in the @ picker beside the folder row. |
| `FileCodeIcon` | Lucide | `FileCode` | A file, line or diff reference attached to a message: the composer's reference chip and the transcript's. |
| `FolderOpenIcon` | Lucide | `FolderOpen` | Open in Files: shows a referenced file in the Files panel. |
| `BanIcon` | Lucide | `Ban` | Why a choice can't be made: a disabled command's reason in the / picker; the sign-in card's notice that a conversation can't continue under another account. |
| `UserXIcon` | Lucide | `UserX` | An account removed from its machine while Choose Another Account listed it. |
| `FolderUpIcon` | Lucide | `CornerUpLeft` | Navigate to the parent directory. |
| `QuestionIcon` | Lucide | `MessageCircleQuestion` | A question: an agent's question row and pending-question marker in the transcript; Side Chat's launcher; the Request Card's Question kind. |
| `LocateIcon` | Lucide | `Locate` | Show Where Asked: scrolls the transcript to a docked question's marker. |
| `MicIcon` | Lucide | `Mic` | Dictation action. |
| `ImageIcon` | Lucide | `Image` | Image attachment; the Request Card's UI Evidence kind; a screenshot artifact's kind tile in the Browser (#2854). |
| `ImageOffIcon` | Lucide | `ImageOff` | Transcript media that could not load; an attached or sent image that could not be shown; the composer's refused drop target when the model can't read images. |
| `ReportIcon` | Lucide | `ClipboardList` | A review report artifact's kind tile in the Browser (#2854). |
| `HtmlIcon` | Lucide | `CodeXml` | An HTML preview artifact's kind tile in the Browser (#2854). |
| `LogIcon` | Lucide | `Logs` | A test log artifact's kind tile in the Browser (#2854). |
| `JsonIcon` | Lucide | `Braces` | A JSON artifact's kind tile, such as a verdict, in the Browser (#2854). |
| `VideoIcon` | Lucide | `Film` | A video artifact's kind tile in the Browser (#2854). |
| `PaperclipIcon` | Lucide | `Paperclip` | A message that carries images: a row of the composer's queue tray. |
| `AtSignIcon` | Lucide | `AtSign` | Reference a workspace file: the + menu's Reference a File… row, which opens the @ picker. |
| `ChainIcon` | Lucide | `GitCommitVertical` | Worktree or context-chain relationship. |
| `CodeIcon` | Lucide | `Code` | Generic code destination. |
| `VisualStudioCodeIcon` | Custom Exception | `Official VS Code Stable Mark (2021-06-21)` | Microsoft's canonical multicolor product mark; Lucide excludes vendor logos. |
| `CursorEditorIcon` | Custom Exception | `Simple Icons 16.29.0: Cursor` | Canonical monochrome product mark; Lucide excludes vendor logos. |
| `DevinDesktopIcon` | Custom Exception | `Official Devin Mark` | Cognition's compact product mark; Lucide excludes vendor logos. |
| `ZedEditorIcon` | Custom Exception | `Simple Icons 16.29.0: Zed Industries` | Canonical monochrome product mark; Lucide excludes vendor logos. |
| `ShieldIcon` | Lucide | `Shield` | Generic approval status, intentionally filled; the Request Card's Permission kind. |
| `ShieldAlertIcon` | Lucide | `ShieldAlert` | A permission mode that skips approval checks: the composer bar's shield and that mode's permission menu row, amber on the icon only. |
| `ShieldCheckIcon` | Lucide | `ShieldCheck` | An Orchestrator's fixed permission mode in the composer bar, and Verified on an artifact preview's meta line once its bytes match their checksum (#2855). |
| `PlanIcon` | Lucide | `ListTodo` | A plan: the composer bar's Plan toggle and a transcript plan card's head; `ListChecks` already means the background job list. |
| `ArrowUpIcon` | Lucide | `ArrowUp` | Generic upward action. |
| `ArrowDownIcon` | Lucide | `ArrowDown` | Generic downward action; Jump to Question on a pending question's transcript marker, down to the request dock. |
| `StopTurnIcon` | Lucide | `Square` | Filled and optically scaled to preserve its send-arrow balance; also a stopped turn's footer mark. |
| `TuningIcon` | Lucide | `SlidersHorizontal` | Model or effort tuning. |
| `GitHubIcon` | Custom Exception | `GitHub Mark` | Official brand mark with a 16-unit solid geometry. |
| `NotesIcon` | Lucide | `NotebookText` | Notes summary. |
| `ComputerIcon` | Lucide | `Monitor` | Local computer. |
| `BranchIcon` | Lucide | `GitBranch` | Git branch. |
| `ThreadForkIcon` | Lucide | `GitFork` | Conversation fork. |
| `CompactedIcon` | Lucide | `FoldVertical` | The provider compacted the conversation into a summary. |
| `EditInForkIcon` | Lucide | `GitBranchPlus` | Edit a message in a new conversation fork; `GitBranch` already means a Git branch. |
| `RewindFilesIcon` | Lucide | `FileClock` | Rewind files to a turn's checkpoint. |
| `HandOffIcon` | Lucide | `ArrowRightLeft` | Hand a conversation off to another provider. |
| `DialIcon` | Lucide | `CircleGauge` | Model or effort setting. |
| `PullRequestIcon` | Lucide | `GitPullRequest` | Pull request. |
| `DiffIcon` | Lucide | `FileDiff` | Changed files in the Review panel; a patch artifact's kind tile in the Browser (#2854). |
| `TranscriptHitIcon` | Lucide | `FileText` | A transcript search hit in the command palette. |
| `JobsIcon` | Lucide | `ListChecks` | Background job list with per-job state. |
| `CampaignIcon` | Lucide | `ChartGantt` | An issue campaign's work items: Campaign Status in the right panel. |
| `ChildSessionRequestsIcon` | Lucide | `Network` | Who answers an Orchestrator's child session requests: the Pinned Summary's Child Session Requests row. |
| `WorkflowDecisionsIcon` | Lucide | `Route` | Where an Orchestrator's workflow gates are decided: the Pinned Summary's Workflow Decisions row; the Request Card's Workflow Decision kind. |
| `GuardrailsIcon` | Lucide | `Fence` | A session's limits: the + menu's Guardrails… row. `Gauge` already means the Fast service tier. |
| `OrchestratorControlsIcon` | Lucide | `Waypoints` | An Orchestrator's parent control and workflow gates: the + menu's Orchestrator Controls… row. `Workflow` already means workflow runs. |
| `ExternalLinkIcon` | Lucide | `ExternalLink` | A link that opens outside Wollipog. |
| `WrenchIcon` | Lucide | `Wrench` | Project setup suggestion. |
| `HeldIcon` | Lucide | `CirclePause` | Child sessions held from starting their next turn: the Held Children campaign notice. |
| `ExperimentIcon` | Lucide | `FlaskConical` | An experimental feature, on the page a turned-off experiment's route shows. |
| `VersionIcon` | Lucide | `Tag` | A numbered version ("v3") in a meta row. |
| `UpdatedIcon` | Lucide | `History` | When something last changed, in a meta row. |
| `FilesIcon` | Lucide | `Files` | A count of files, in a meta row. |
| `SkillSourceIcon` | Lucide | `Package` | Where a skill's content comes from (Git, Machine, Built-In or Library). |
| `ReadIcon` | Lucide | `BookOpen` | A read step in the transcript. |
| `FileEditIcon` | Lucide | `FilePen` | A file edit step in the transcript. |
| `NewFileIcon` | Lucide | `FilePlus` | A file edit step that created the file. |
| `DeleteIcon` | Lucide | `Trash2` | A delete step in the transcript. |
| `MoveIcon` | Lucide | `FolderInput` | A move or rename step in the transcript. |
| `FileSearchIcon` | Lucide | `FileSearch` | A search step in the transcript; distinct from the Search action's magnifier. |
| `TerminalIcon` | Lucide | `Terminal` | A command step in the transcript; distinct from the Command Line destination's framed terminal. |
| `ThoughtIcon` | Lucide | `Brain` | A thought step in the transcript. |
| `AgentLogIcon` | Lucide | `ScrollText` | An Agent Log step (a harness's own output) in the transcript. |
| `BotIcon` | Lucide | `Bot` | An agent step in the transcript. |
| `ToolIcon` | Lucide | `Hammer` | A tool step of any other kind; distinct from the project setup wrench; the Request Card's Tool Calls kind. |

The Visual Studio Code mark comes from Microsoft's
[official SVG asset bundle](https://code.visualstudio.com/assets/branding/visual-studio-code-icons.zip)
and follows its [icon and action-button guidelines](https://code.visualstudio.com/brand). The pinned
[Simple Icons 16.29.0 Cursor mark](https://github.com/simple-icons/simple-icons/blob/16.29.0/icons/cursor.svg)
traces to Cursor's [official brand assets](https://cursor.com/brand). The pinned
[Simple Icons 16.29.0 Zed Industries mark](https://github.com/simple-icons/simple-icons/blob/16.29.0/icons/zedindustries.svg)
traces to Zed's
[official repository asset](https://github.com/zed-industries/zed/blob/main/assets/icons/logo_96.svg).
The Devin Desktop mark is the exact compact SVG geometry used by the
[official product page](https://devin.ai/desktop) and its
[first-party SVG favicon](https://devin.ai/favicon.svg). The runtime intentionally keeps the legacy
`windsurf` editor id and CLI name because Devin Desktop is delivered as an in-place Windsurf update.

## Dependency and Visual-Review Policy

The manifest declares `lucide-react` and `pnpm-lock.yaml` pins the resolved release, so
`pnpm install --frozen-lockfile` is reproducible. A Lucide dependency update must:

1. keep all imports named and centralized in `Icons.tsx`;
2. run the full unit suite, typecheck, production build, and icon tree-shaking contract;
3. compare representative navigation, action, status, file, and panel icons at 14px, 16px, 20px
   and 24px;
4. review light and dark themes at desktop and phone widths; and
5. exercise interactive, disabled, selected, warning, and status styling without changing visible
   labels or accessible control names.

The pre-migration production entry bundle was 1,736,906 bytes (482,380 bytes gzip); after the full
migration it is 1,739,444 bytes (484,263 bytes gzip), a 2,538-byte raw and 1,883-byte gzip increase.
The dedicated icon bundle contract provides the durable regression guard: it bundles every stable
icon export, rejects evidence of the full Lucide catalog, and enforces an icon-specific size budget
independent of unrelated application growth. That budget is a 125,000-byte ceiling; the icon bundle
measured 20,235 bytes at migration. This document deliberately does not record the current figure,
which moves with every icon change: running `node apps/web/scripts/verify-icon-bundle.mjs` (also
part of `pnpm --filter web build`) prints the export count and byte total it measured.
