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

## Export Inventory

| Export | Decision | Mapping or Exception | Rationale |
| --- | --- | --- | --- |
| `GridIcon` | Lucide | `Grid2X2` | Generic grid navigation. |
| `InboxIcon` | Lucide | `Inbox` | Generic inbox navigation. |
| `ProjectsIcon` | Lucide | `FolderKanban` | Project collection navigation. |
| `BoardIcon` | Lucide | `Columns3` | Generic board columns. |
| `ListIcon` | Lucide | `List` | Generic list layout. |
| `SnoozedIcon` | Lucide | `Clock3` | Snoozed reminder view. |
| `ConnectionsIcon` | Lucide | `MonitorCog` | Runner connection management. |
| `RunsIcon` | Lucide | `Workflow` | Generic workflow runs. |
| `PodsIcon` | Lucide | `UsersRound` | Collaboration group. |
| `AutomationsIcon` | Lucide | `Zap` | Automation action. |
| `SkillsIcon` | Lucide | `WandSparkles` | Reusable agent capability. |
| `UsageIcon` | Lucide | `ChartNoAxesColumn` | Usage metrics. |
| `ChevronDownIcon` | Lucide | `ChevronDown` | Directional disclosure. |
| `ChevronRightIcon` | Lucide | `ChevronRight` | Directional disclosure. |
| `ChevronLeftIcon` | Lucide | `ChevronLeft` | Directional disclosure. |
| `PlusIcon` | Lucide | `Plus` | Generic add action. |
| `MoreHorizontalIcon` | Lucide | `Ellipsis` | Horizontal overflow menu. |
| `MoreVerticalIcon` | Lucide | `EllipsisVertical` | Vertical overflow menu. |
| `ShareIcon` | Lucide | `Share` | Generic share action. |
| `RefreshIcon` | Lucide | `RefreshCw` | Generic refresh action. |
| `UpdateIcon` | Lucide | `Upload` | Install or upload an update. |
| `SearchIcon` | Lucide | `Search` | Generic search action. |
| `CloseIcon` | Lucide | `X` | Generic close action. |
| `SettingsIcon` | Lucide | `Settings` | Generic settings navigation. |
| `UserPlusIcon` | Lucide | `UserPlus` | Add a collaborator. |
| `DeviceIcon` | Lucide | `Smartphone` | Paired device. |
| `TeamIcon` | Lucide | `Users` | Team or access group. |
| `EditIcon` | Lucide | `Pencil` | Generic edit action. |
| `CopyIcon` | Lucide | `Copy` | Generic copy action. |
| `CheckIcon` | Lucide | `Check` | Generic success state. |
| `WarningIcon` | Lucide | `TriangleAlert` | Generic warning state. |
| `InfoIcon` | Lucide | `Info` | Generic information state. |
| `KeyboardIcon` | Lucide | `Keyboard` | Keyboard shortcuts. |
| `LockIcon` | Lucide | `Lock` | Locked or restricted state. |
| `WarningTriangleIcon` | Lucide | `TriangleAlert` | Generic warning banner. |
| `PinnedPanelIcon` | Lucide | `List` | Pinned summary list. |
| `DockBottomIcon` | Lucide | `PanelBottom` | Bottom dock placement. |
| `PanelRightIcon` | Lucide | `PanelRight` | Right panel placement. |
| `TerminalIcon` | Lucide | `Terminal` | Terminal destination. |
| `CommandLineIcon` | Lucide | `SquareTerminal` | Command-line destination. |
| `GlobeIcon` | Lucide | `Globe` | Remote host. |
| `FolderIcon` | Lucide | `Folder` | Generic directory. |
| `FolderOutlineIcon` | Lucide | `Folder` | Directory-list folder; stable alias. |
| `FolderUpIcon` | Lucide | `CornerUpLeft` | Navigate to the parent directory. |
| `HelpIcon` | Lucide | `MessageCircleQuestion` | Contextual help. |
| `MicIcon` | Lucide | `Mic` | Dictation action. |
| `ImageIcon` | Lucide | `Image` | Image attachment. |
| `ChainIcon` | Lucide | `GitCommitVertical` | Worktree or context-chain relationship. |
| `CodeIcon` | Lucide | `Code` | Generic code destination. |
| `VisualStudioCodeIcon` | Custom Exception | `Official VS Code Stable Mark (2021-06-21)` | Microsoft's canonical multicolor product mark; Lucide excludes vendor logos. |
| `CursorEditorIcon` | Custom Exception | `Simple Icons 16.29.0: Cursor` | Canonical monochrome product mark; Lucide excludes vendor logos. |
| `DevinDesktopIcon` | Custom Exception | `Official Devin Mark` | Cognition's compact product mark; Lucide excludes vendor logos. |
| `ZedEditorIcon` | Custom Exception | `Simple Icons 16.29.0: Zed Industries` | Canonical monochrome product mark; Lucide excludes vendor logos. |
| `ShieldIcon` | Lucide | `Shield` | Generic approval status, intentionally filled. |
| `ArrowUpIcon` | Lucide | `ArrowUp` | Generic upward action. |
| `ArrowDownIcon` | Lucide | `ArrowDown` | Generic downward action. |
| `StopTurnIcon` | Lucide | `Square` | Filled and optically scaled to preserve its send-arrow balance. |
| `TuningIcon` | Lucide | `SlidersHorizontal` | Model or effort tuning. |
| `GitHubIcon` | Custom Exception | `GitHub Mark` | Official brand mark with a 16-unit solid geometry. |
| `FolderSolidIcon` | Lucide | `Folder` | Generic folder, intentionally filled at 13px. |
| `GearIcon` | Lucide | `Settings` | Stable alias for the settings trigger. |
| `NotesIcon` | Lucide | `NotebookText` | Notes summary. |
| `ComputerIcon` | Lucide | `Monitor` | Local computer. |
| `BranchIcon` | Lucide | `GitBranch` | Git branch. |
| `ThreadForkIcon` | Lucide | `GitFork` | Conversation fork. |
| `DialIcon` | Lucide | `CircleGauge` | Model or effort setting. |
| `PullRequestIcon` | Lucide | `GitPullRequest` | Pull request. |

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
3. compare representative navigation, action, status, file, and panel icons at 13px, 14px, 16px,
   20px, 26px, and 28px where those sizes are used;
4. review light and dark themes at desktop and phone widths; and
5. exercise interactive, disabled, selected, warning, and status styling without changing visible
   labels or accessible control names.

The pre-migration production entry bundle was 1,736,906 bytes (482,380 bytes gzip); after the full
migration it is 1,739,444 bytes (484,263 bytes gzip), a 2,538-byte raw and 1,883-byte gzip increase.
The dedicated icon bundle contract provides the durable regression guard: it bundles every stable
icon export (20,235 bytes at migration), rejects evidence of the full Lucide catalog, and enforces
an icon-specific size budget independent of unrelated application growth.
