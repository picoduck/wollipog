import type { MouseEventHandler } from "react";

interface ShortcutHintBaseProps {
  label: string;
  shortcut: string;
  shortcutFirst?: boolean;
  className?: string;
  id?: string;
  title?: string;
}

type ShortcutHintInteractiveProps =
  | { ariaLabel?: string; onMouseDown?: MouseEventHandler<HTMLButtonElement>; onClick: MouseEventHandler<HTMLButtonElement> }
  | { ariaLabel?: string; onMouseDown: MouseEventHandler<HTMLButtonElement>; onClick?: MouseEventHandler<HTMLButtonElement> };

type ShortcutHintStaticProps = {
  ariaLabel?: undefined;
  onMouseDown?: undefined;
  onClick?: undefined;
};

export type ShortcutHintProps = ShortcutHintBaseProps & (ShortcutHintInteractiveProps | ShortcutHintStaticProps);

/** Shared label + boxed-keycap treatment for reader discovery hints and actions. */
export function ShortcutHint({
  label,
  shortcut,
  shortcutFirst = false,
  className,
  id,
  title,
  ariaLabel,
  onMouseDown,
  onClick,
}: ShortcutHintProps) {
  const interactive = onClick != null || onMouseDown != null;
  const labelNode = <span className="shortcut-hint-label">{label}</span>;
  const shortcutNode = <kbd aria-hidden={interactive ? "true" : undefined}>{shortcut}</kbd>;
  const content = shortcutFirst ? <>{shortcutNode}{labelNode}</> : <>{labelNode}{shortcutNode}</>;
  return interactive ? (
    <button
      type="button"
      id={id}
      className={`shortcut-hint shortcut-hint-button${className ? ` ${className}` : ""}`}
      title={title}
      aria-label={ariaLabel ?? label}
      data-shortcut-hint={shortcut}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <span
      id={id}
      className={`shortcut-hint${className ? ` ${className}` : ""}`}
      title={title}
      data-shortcut-hint={shortcut}
    >
      {content}
    </span>
  );
}
