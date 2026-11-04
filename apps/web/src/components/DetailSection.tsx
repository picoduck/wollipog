import { useId, type ReactNode } from "react";

/**
 * An unboxed detail section (§4.5, §5.1): a title row with its one action at the end, at most one
 * sentence under it, then its content. The skill detail (#1962) and the project detail (#2959)
 * draw every section with it, so their headings share one size.
 */
export function DetailSection({ title, count, note, actions, children }: {
  title: string;
  /** A plain count after the title (§11.4), for a section that lists things. */
  count?: number;
  /** One sentence under the title. */
  note?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${useId().replace(/:/g, "")}`;
  return (
    <section className="section" aria-labelledby={id}>
      <div className="section-head">
        <h3 id={id} className="section-title">{title}{count !== undefined && <> <span className="count">{count}</span></>}</h3>
        {actions && <div className="actions">{actions}</div>}
      </div>
      {note && <p className="section-note">{note}</p>}
      {children}
    </section>
  );
}
