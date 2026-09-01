import React, { type SVGProps } from "react";
import {
  ArrowDown as LucideArrowDown,
  ArrowUp as LucideArrowUp,
  ChartNoAxesColumn as LucideChartNoAxesColumn,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  CircleGauge as LucideCircleGauge,
  Code as LucideCode,
  Columns3 as LucideColumns3,
  Copy as LucideCopy,
  CornerUpLeft as LucideCornerUpLeft,
  Ellipsis as LucideEllipsis,
  EllipsisVertical as LucideEllipsisVertical,
  Folder as LucideFolder,
  FolderKanban as LucideFolderKanban,
  GitBranch as LucideGitBranch,
  GitCommitVertical as LucideGitCommitVertical,
  GitFork as LucideGitFork,
  GitPullRequest as LucideGitPullRequest,
  Globe as LucideGlobe,
  Grid2X2 as LucideGrid2X2,
  Image as LucideImage,
  Inbox as LucideInbox,
  Info as LucideInfo,
  Keyboard as LucideKeyboard,
  List as LucideList,
  Lock as LucideLock,
  MessageCircleQuestion as LucideMessageCircleQuestion,
  Mic as LucideMic,
  Monitor as LucideMonitor,
  MonitorCog as LucideMonitorCog,
  NotebookText as LucideNotebookText,
  PanelBottom as LucidePanelBottom,
  PanelRight as LucidePanelRight,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  RefreshCw as LucideRefreshCw,
  Search as LucideSearch,
  Settings as LucideSettings,
  Share as LucideShare,
  Shield as LucideShield,
  SlidersHorizontal as LucideSlidersHorizontal,
  Smartphone as LucideSmartphone,
  Square as LucideSquare,
  SquareTerminal as LucideSquareTerminal,
  Terminal as LucideTerminal,
  TriangleAlert as LucideTriangleAlert,
  Upload as LucideUpload,
  UserPlus as LucideUserPlus,
  Users as LucideUsers,
  UsersRound as LucideUsersRound,
  WandSparkles as LucideWandSparkles,
  Workflow as LucideWorkflow,
  X as LucideX,
  Zap as LucideZap,
  type LucideIcon,
} from "lucide-react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

type LibraryIconProps = IconProps & { glyph: LucideIcon };

/** Keep Lucide glyphs on Wollipog's size, stroke, class, and accessibility contract. */
function LibraryIcon({ glyph: Glyph, size = 16, className, children: _children, ...props }: LibraryIconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.8}
      aria-hidden="true"
      focusable="false"
      className={`app-icon${className ? ` ${className}` : ""}`}
      {...props}
    />
  );
}

/** Shared rendering contract for the documented product-mark exceptions below. */
function IconBase({ size = 16, children, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`app-icon${className ? ` ${className}` : ""}`}
      {...props}
    >
      {children}
    </svg>
  );
}

export function GridIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGrid2X2} {...props} />;
}

export function InboxIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideInbox} {...props} />;
}

export function ProjectsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideFolderKanban} {...props} />;
}

export function BoardIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideColumns3} {...props} />;
}

export function ConnectionsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideMonitorCog} {...props} />;
}

export function RunsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideWorkflow} {...props} />;
}

export function PodsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideUsersRound} {...props} />;
}

export function AutomationsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideZap} {...props} />;
}

export function SkillsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideWandSparkles} {...props} />;
}

export function UsageIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideChartNoAxesColumn} {...props} />;
}

export function ChevronDownIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideChevronDown} {...props} />;
}

export function ChevronRightIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideChevronRight} {...props} />;
}

export function ChevronLeftIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideChevronLeft} {...props} />;
}

export function PlusIcon(props: IconProps) {
  return <LibraryIcon glyph={LucidePlus} {...props} />;
}

export function MoreHorizontalIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideEllipsis} {...props} />;
}

export function MoreVerticalIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideEllipsisVertical} {...props} />;
}

export function ShareIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideShare} {...props} />;
}

export function RefreshIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideRefreshCw} {...props} />;
}

export function UpdateIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideUpload} {...props} />;
}

export function SearchIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSearch} {...props} />;
}

export function CloseIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideX} {...props} />;
}

export function SettingsIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSettings} {...props} />;
}

export function UserPlusIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideUserPlus} {...props} />;
}

export function DeviceIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSmartphone} {...props} />;
}

export function TeamIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideUsers} {...props} />;
}

export function EditIcon(props: IconProps) {
  return <LibraryIcon glyph={LucidePencil} {...props} />;
}

export function CopyIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideCopy} {...props} />;
}

export function CheckIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideCheck} {...props} />;
}

export function WarningIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideTriangleAlert} {...props} />;
}

export function InfoIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideInfo} {...props} />;
}

export function KeyboardIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideKeyboard} {...props} />;
}

export function LockIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideLock} {...props} />;
}

export function WarningTriangleIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideTriangleAlert} {...props} />;
}

export function PinnedPanelIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideList} {...props} />;
}

export function DockBottomIcon(props: IconProps) {
  return <LibraryIcon glyph={LucidePanelBottom} {...props} />;
}

export function PanelRightIcon(props: IconProps) {
  return <LibraryIcon glyph={LucidePanelRight} {...props} />;
}

export function TerminalIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideTerminal} {...props} />;
}

export function CommandLineIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSquareTerminal} {...props} />;
}

export function GlobeIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGlobe} {...props} />;
}

export function FolderIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideFolder} {...props} />;
}

export function FolderOutlineIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideFolder} {...props} />;
}

export function FolderUpIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideCornerUpLeft} {...props} />;
}

export function HelpIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideMessageCircleQuestion} {...props} />;
}

export function MicIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideMic} {...props} />;
}

export function ImageIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideImage} {...props} />;
}

export function ChainIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGitCommitVertical} {...props} />;
}

export function CodeIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideCode} {...props} />;
}

/** Product mark: Lucide intentionally does not provide vendor logos. */
export function VisualStudioCodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m17.5 4-8 6.2L5.5 7.3 3 9.5l4 2.5-4 2.5 2.5 2.2 4-2.9 8 6.2 3.5-1.7V5.7z" />
      <path d="M17.5 4v16M9.5 10.2v3.6" />
    </IconBase>
  );
}

/** Product mark: Lucide intentionally does not provide vendor logos. */
export function CursorEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m8 7 8.8 5-4 1.1-1.7 4.2z" />
    </IconBase>
  );
}

/** Product mark: Lucide intentionally does not provide vendor logos. */
export function WindsurfEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 8.5c3.2-2 5.7-2 8 0s4.8 2 10 0" />
      <path d="M3 12c3.2-2 5.7-2 8 0s4.8 2 10 0" />
      <path d="M3 15.5c3.2-2 5.7-2 8 0s4.8 2 10 0" />
    </IconBase>
  );
}

/** Product mark: Lucide intentionally does not provide vendor logos. */
export function ZedEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M8 8h8l-8 8h8" />
    </IconBase>
  );
}

/** Filled to preserve the approvals status mark's intentional visual weight. */
export function ShieldIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideShield} fill="currentColor" stroke="none" {...props} />;
}

export function ArrowUpIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideArrowUp} {...props} />;
}

export function ArrowDownIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideArrowDown} {...props} />;
}

/** Filled to preserve the non-terminal turn interruption control. */
export function StopTurnIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSquare} fill="currentColor" stroke="none" {...props} />;
}

export function TuningIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSlidersHorizontal} {...props} />;
}

/** Brand mark: GitHub's official solid, 16-unit geometry is not a Lucide interface glyph. */
export function GitHubIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`app-icon${className ? ` ${className}` : ""}`}
      {...props}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Filled to preserve the 13px folder mark's intentional visual weight. */
export function FolderSolidIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideFolder} fill="currentColor" stroke="none" {...props} />;
}

export function GearIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideSettings} {...props} />;
}

export function NotesIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideNotebookText} {...props} />;
}

export function ComputerIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideMonitor} {...props} />;
}

export function BranchIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGitBranch} {...props} />;
}

export function ThreadForkIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGitFork} {...props} />;
}

export function DialIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideCircleGauge} {...props} />;
}

export function PullRequestIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGitPullRequest} {...props} />;
}
