import React, { type SVGProps, useId } from "react";
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

// Simple Icons 16.29.0 paths (24×24 monochrome product marks), verified against
// Cursor's official brand assets and Zed's official logo_96.svg source asset.
const SIMPLE_ICONS_CURSOR_PATH =
  "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";
const SIMPLE_ICONS_ZED_INDUSTRIES_PATH =
  "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z";

/** Official Visual Studio Code stable product mark (brand asset bundle dated 2021-06-21). */
export function VisualStudioCodeIcon(props: IconProps) {
  const instanceId = useId().replace(/:/g, "");
  const maskId = `vscode-mask-${instanceId}`;
  const lowerFilterId = `vscode-lower-filter-${instanceId}`;
  const bodyFilterId = `vscode-body-filter-${instanceId}`;
  const overlayId = `vscode-overlay-${instanceId}`;
  return (
    <IconBase viewBox="0 0 100 100" fill="none" stroke="none" {...props}>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style={{ maskType: "alpha" }}>
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M70.9119 99.3171C72.4869 99.9307 74.2828 99.8914 75.8725 99.1264L96.4608 89.2197C98.6242 88.1787 100 85.9892 100 83.5872V16.4133C100 14.0113 98.6243 11.8218 96.4609 10.7808L75.8725 0.873756C73.7862 -0.130129 71.3446 0.11576 69.5135 1.44695C69.252 1.63711 69.0028 1.84943 68.769 2.08341L29.3551 38.0415L12.1872 25.0096C10.589 23.7965 8.35363 23.8959 6.86933 25.2461L1.36303 30.2549C-0.452552 31.9064 -0.454633 34.7627 1.35853 36.417L16.2471 50.0001L1.35853 63.5832C-0.454633 65.2374 -0.452552 68.0938 1.36303 69.7453L6.86933 74.7541C8.35363 76.1043 10.589 76.2037 12.1872 74.9905L29.3551 61.9587L68.769 97.9167C69.3925 98.5406 70.1246 99.0104 70.9119 99.3171ZM75.0152 27.2989L45.1091 50.0001L75.0152 72.7012V27.2989Z"
          fill="white"
        />
      </mask>
      <g mask={`url(#${maskId})`}>
        <path
          d="M96.4614 10.7962L75.8569 0.875542C73.4719 -0.272773 70.6217 0.211611 68.75 2.08333L1.29858 63.5832C-0.515693 65.2373 -0.513607 68.0937 1.30308 69.7452L6.81272 74.754C8.29793 76.1042 10.5347 76.2036 12.1338 74.9905L93.3609 13.3699C96.086 11.3026 100 13.2462 100 16.6667V16.4275C100 14.0265 98.6246 11.8378 96.4614 10.7962Z"
          fill="#0065A9"
        />
        <g filter={`url(#${lowerFilterId})`}>
          <path
            d="M96.4614 89.2038L75.8569 99.1245C73.4719 100.273 70.6217 99.7884 68.75 97.9167L1.29858 36.4169C-0.515693 34.7627 -0.513607 31.9063 1.30308 30.2548L6.81272 25.246C8.29793 23.8958 10.5347 23.7964 12.1338 25.0095L93.3609 86.6301C96.086 88.6974 100 86.7538 100 83.3334V83.5726C100 85.9735 98.6246 88.1622 96.4614 89.2038Z"
            fill="#007ACC"
          />
        </g>
        <g filter={`url(#${bodyFilterId})`}>
          <path
            d="M75.8578 99.1263C73.4721 100.274 70.6219 99.7885 68.75 97.9166C71.0564 100.223 75 98.5895 75 95.3278V4.67213C75 1.41039 71.0564 -0.223106 68.75 2.08329C70.6219 0.211402 73.4721 -0.273666 75.8578 0.873633L96.4587 10.7807C98.6234 11.8217 100 14.0112 100 16.4132V83.5871C100 85.9891 98.6234 88.1786 96.4586 89.2196L75.8578 99.1263Z"
            fill="#1F9CF0"
          />
        </g>
        <g style={{ mixBlendMode: "overlay" }} opacity="0.25">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M70.8511 99.3171C72.4261 99.9306 74.2221 99.8913 75.8117 99.1264L96.4 89.2197C98.5634 88.1787 99.9392 85.9892 99.9392 83.5871V16.4133C99.9392 14.0112 98.5635 11.8217 96.4001 10.7807L75.8117 0.873695C73.7255 -0.13019 71.2838 0.115699 69.4527 1.44688C69.1912 1.63705 68.942 1.84937 68.7082 2.08335L29.2943 38.0414L12.1264 25.0096C10.5283 23.7964 8.29285 23.8959 6.80855 25.246L1.30225 30.2548C-0.513334 31.9064 -0.515415 34.7627 1.29775 36.4169L16.1863 50L1.29775 63.5832C-0.515415 65.2374 -0.513334 68.0937 1.30225 69.7452L6.80855 74.754C8.29285 76.1042 10.5283 76.2036 12.1264 74.9905L29.2943 61.9586L68.7082 97.9167C69.3317 98.5405 70.0638 99.0104 70.8511 99.3171ZM74.9544 27.2989L45.0483 50L74.9544 72.7012V27.2989Z"
            fill={`url(#${overlayId})`}
          />
        </g>
      </g>
      <defs>
        <filter id={lowerFilterId} x="-8.39411" y="15.8291" width="116.727" height="92.2456" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.16667" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <filter id={bodyFilterId} x="60.4167" y="-8.07558" width="47.9167" height="116.151" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
          <feOffset />
          <feGaussianBlur stdDeviation="4.16667" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend mode="overlay" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape" />
        </filter>
        <linearGradient id={overlayId} x1="49.9392" y1="0.257812" x2="49.9392" y2="99.7423" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
    </IconBase>
  );
}

/** Cursor product mark from Simple Icons 16.29.0. */
export function CursorEditorIcon(props: IconProps) {
  return (
    <IconBase fill="currentColor" stroke="none" {...props}>
      <path d={SIMPLE_ICONS_CURSOR_PATH} />
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

/** Zed Industries product mark from Simple Icons 16.29.0. */
export function ZedEditorIcon(props: IconProps) {
  return (
    <IconBase fill="currentColor" stroke="none" {...props}>
      <path d={SIMPLE_ICONS_ZED_INDUSTRIES_PATH} />
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
  const { style, ...rest } = props;
  return (
    <LibraryIcon
      glyph={LucideSquare}
      fill="currentColor"
      stroke="none"
      {...rest}
      style={{ transform: "scale(0.67)", transformOrigin: "center", ...style }}
    />
  );
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
