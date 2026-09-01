import React, { type SVGProps } from "react";
import { GitFork as LucideGitFork, type LucideIcon } from "lucide-react";

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * The shared base for icons whose geometry Wollipog owns.
 *
 * NOT exported. It was, briefly, so a component could compose a one-off glyph inline — and that is
 * a hole rather than a convenience: a component owning new geometry through IconBase contains no
 * literal `<svg>`, so the ownership lock stays green while the icon set quietly grows a member
 * nobody can find. Every glyph is a named export here instead.
 */
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

type LibraryIconProps = IconProps & { glyph: LucideIcon };

/** Keep library glyphs on the same size, stroke, class, and accessibility contract as local ones. */
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

export function GridIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.25" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.25" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.25" />
      <rect x="14" y="14" width="6.5" height="6.5" rx="1.25" />
    </IconBase>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H10l-5.5 3v-3H5.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
      <path d="M8 9h8M8 12.5h5" />
    </IconBase>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </IconBase>
  );
}

export function BoardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M9.2 4v16M14.8 4v16" />
    </IconBase>
  );
}

export function ConnectionsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="5" width="17" height="12" rx="2" />
      <path d="M8 21h8M12 17v4M7.5 9h.01M10.5 9h6" />
    </IconBase>
  );
}

export function RunsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="7" cy="7" r="2.5" />
      <circle cx="17" cy="7" r="2.5" />
      <circle cx="12" cy="17" r="2.5" />
      <path d="m8.8 8.8 2 5.6M15.2 8.8l-2 5.6M9.5 17h-4M18.5 17h-4" />
    </IconBase>
  );
}

export function PodsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="9" r="3" />
      <circle cx="17" cy="8" r="2.25" />
      <path d="M3.5 19c.7-3.2 2.5-5 5.5-5s4.8 1.8 5.5 5M14.2 13.2c2.9-.5 5.3 1.2 6.1 4" />
    </IconBase>
  );
}

export function AutomationsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 2.8 5 13h6l-1 8.2L19 10h-6z" />
    </IconBase>
  );
}

export function SkillsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11 3.5 12.9 9.6 19 11.5l-6.1 1.9L11 19.5l-1.9-6.1L3 11.5l6.1-1.9Z" />
      <path d="M18.5 3.5v4M20.5 5.5h-4" />
    </IconBase>
  );
}

export function UsageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m7 9.5 5 5 5-5" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9.5 7 5 5-5 5" />
    </IconBase>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m14.5 7-5 5 5 5" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function MoreHorizontalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function MoreVerticalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 13.5V19h14v-5.5" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 6v5h-5M4 18v-5h5" />
      <path d="M6.1 9a7 7 0 0 1 11.7-2.2L20 11M4 13l2.2 4.2A7 7 0 0 0 17.9 15" />
    </IconBase>
  );
}

export function UpdateIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 14v5h14v-5" />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" />
    </IconBase>
  );
}

export function UserPlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c.6-4 2.4-6 5.5-6 2.4 0 4.1 1.2 5 3.5M18 8v6M15 11h6" />
    </IconBase>
  );
}

export function DeviceIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="6" y="2.8" width="12" height="18.4" rx="2.2" />
      <path d="M10 17.8h4" />
    </IconBase>
  );
}

export function TeamIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="8" cy="8" r="2.7" />
      <circle cx="16.5" cy="9" r="2.2" />
      <path d="M2.8 20c.5-4 2.3-6 5.2-6 3 0 4.8 2 5.3 6M13.5 15c2.9-.5 5.3 1.2 6 4" />
    </IconBase>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12.5 4.2 4.2L19 7" />
    </IconBase>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3.5 21 20H3L12 3.5Z" />
      <path d="M12 9v5M12 17.25h.01" />
    </IconBase>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 10.5V17" />
      <path d="M12 7.25h.01" />
    </IconBase>
  );
}

export function KeyboardIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </IconBase>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Icons lifted out of components.
 *
 * Every one of these was an inline `<svg>` in the component that used it, and they had drifted:
 * three stroke widths (1.8, 2, and a spread `stroke` object), five sizes, one non-24 viewBox, and
 * three fill-style paths among otherwise stroked icons. Sharing IconBase is what makes them one
 * set rather than twenty-one drawings.
 * ---------------------------------------------------------------------------------------------- */

export function LockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </IconBase>
  );
}

export function WarningTriangleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10.3 3.8 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </IconBase>
  );
}

/** The pinned-summary panel: a list with a marker beside each row. */
export function PinnedPanelIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h10M4 12h10M4 18h10" />
      <circle cx="19" cy="6" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
      <circle cx="19" cy="18" r="1.2" />
    </IconBase>
  );
}

/** The shell dock: a pane split along the bottom. */
export function DockBottomIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 15h18" />
    </IconBase>
  );
}

/** The right panel: a pane split along the right. */
export function PanelRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </IconBase>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 10l-2 2 2 2M16 10l2 2-2 2" />
    </IconBase>
  );
}

export function CommandLineIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M12 15h5" />
    </IconBase>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 4 5.6 4 9s-1.5 6.4-4 9c-2.5-2.6-4-5.6-4-9s1.5-6.4 4-9z" />
    </IconBase>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7V5a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" />
    </IconBase>
  );
}

/** The directory listing's folder, whose proportions differ from the launcher's above. */
export function FolderOutlineIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </IconBase>
  );
}

export function FolderUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 14 4 9l5-5" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </IconBase>
  );
}

export function HelpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />
      <path d="M12 16v.01M12 8a2 2 0 0 1 1 3.7c-.6.4-1 .7-1 1.3" />
    </IconBase>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </IconBase>
  );
}

/** A framed photo — the composer's image attachment action. */
export function ImageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.25" />
      <circle cx="8.75" cy="10" r="1.6" />
      <path d="M3.5 16.5 8.5 12l4 3.5 3-2.5 4.5 4" />
    </IconBase>
  );
}

/** Two nodes on a line — the session's context chain. */
export function ChainIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6" />
    </IconBase>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />
    </IconBase>
  );
}

/** Recognizable editor marks used only beside an explicit text label in the Open destination menu. */
export function VisualStudioCodeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m17.5 4-8 6.2L5.5 7.3 3 9.5l4 2.5-4 2.5 2.5 2.2 4-2.9 8 6.2 3.5-1.7V5.7z" />
      <path d="M17.5 4v16M9.5 10.2v3.6" />
    </IconBase>
  );
}

export function CursorEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m8 7 8.8 5-4 1.1-1.7 4.2z" />
    </IconBase>
  );
}

export function WindsurfEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 8.5c3.2-2 5.7-2 8 0s4.8 2 10 0" />
      <path d="M3 12c3.2-2 5.7-2 8 0s4.8 2 10 0" />
      <path d="M3 15.5c3.2-2 5.7-2 8 0s4.8 2 10 0" />
    </IconBase>
  );
}

export function ZedEditorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M8 8h8l-8 8h8" />
    </IconBase>
  );
}

/**
 * SOLID, not stroked — the approvals control is a status mark whose weight is the point, and
 * running its path through IconBase's `fill: none` turned it into a thin hollow outline.
 */
export function ShieldIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`app-icon${className ? ` ${className}` : ""}`}
      {...props}
    >
      <path d="M12 2l8 3v6c0 5-3.4 8.6-8 9-4.6-.4-8-4-8-9V5l8-3z" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 20V5M5 12l7-7 7 7" />
    </IconBase>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 4v15M5 12l7 7 7-7" />
    </IconBase>
  );
}

/** Filled square used for non-terminal turn interruption controls. */
export function StopTurnIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      {/* 12 of 24 viewBox units: optically matched to the send arrow's ~8px stroked glyph —
         a solid square reads heavier, so it sits slightly smaller than the arrow's extents. */}
      <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

/** A gear with spokes, distinct from SettingsIcon's cog. */
export function TuningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6M5 7l4.5 3M19 17l-4.5-3" />
    </IconBase>
  );
}

/**
 * GitHub's mark, which is a BRAND and so keeps its own 16-unit geometry and solid fill rather than
 * being redrawn as a stroked 24-unit icon. It sits here beside the rest for one import site, not
 * because it follows the same rules — the same reasoning as AgentIcon's vendor marks.
 */
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

/** A SOLID folder, used where the glyph sits beside a label at 13px and needs the weight. */
export function FolderSolidIcon({ size = 16, className, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={`app-icon${className ? ` ${className}` : ""}`}
      {...props}
    >
      <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
    </svg>
  );
}

/** The topbar Settings trigger's gear, which is a different drawing from SettingsIcon's. */
export function GearIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </IconBase>
  );
}

/* --- The pinned-summary row glyphs, which composed IconBase inline in the component. ------------ */

export function NotesIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M8 10h8M8 14h5" />
    </IconBase>
  );
}

/** A local machine, as opposed to GlobeIcon's remote one. */
export function ComputerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8" />
    </IconBase>
  );
}

/** Two nodes on a line: the branch this session works on. */
export function BranchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </IconBase>
  );
}

/** The standard Lucide fork glyph, used for branching a conversation into a new session. */
export function ThreadForkIcon(props: IconProps) {
  return <LibraryIcon glyph={LucideGitFork} {...props} />;
}

/** A node with two spokes: the session's model or effort setting. */
export function DialIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v6M12 15v6" />
    </IconBase>
  );
}

/** Three nodes joined: a pull request. */
export function PullRequestIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="12" r="3" />
      <path d="M6 9v6M15 12h-3a3 3 0 0 1-3-3" />
    </IconBase>
  );
}
