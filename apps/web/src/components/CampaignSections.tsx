import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

interface Entry { title: string; count: number; attention: string; heading: HTMLHeadingElement | null; open: () => void }
const attentionMemory = new Map<string, Map<string, string>>();
const sectionMemory = new Map<string, Map<string, boolean>>();
export function forgetCampaignSections(): void { sectionMemory.clear(); attentionMemory.clear(); }
const Context = createContext<{
  memory: Map<string, boolean>;
  attentionMemory: Map<string, string>;
  register: (id: string, entry: Entry | null) => void;
  all: { value: boolean; revision: number } | null;
} | null>(null);

/** Sections register only when rendered, including those loaded independently from older servers. */
export function CampaignSections({ campaignId, targetTitle, children }: { campaignId: string; targetTitle?: string; children: ReactNode }) {
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map());
  const [all, setAll] = useState<{ value: boolean; revision: number } | null>(null);
  const memory = useMemo(() => {
    let saved = sectionMemory.get(campaignId);
    if (!saved) { saved = new Map(); sectionMemory.set(campaignId, saved); }
    return saved;
  }, [campaignId]);
  const attention = useMemo(() => {
    let saved = attentionMemory.get(campaignId);
    if (!saved) { saved = new Map(); attentionMemory.set(campaignId, saved); }
    return saved;
  }, [campaignId]);
  const register = useCallback((id: string, entry: Entry | null) => setEntries(current => {
    const next = new Map(current);
    if (entry) next.set(id, entry); else next.delete(id);
    return next;
  }), []);
  const context = useMemo(() => ({ memory, attentionMemory: attention, register, all }), [memory, attention, register, all]);
  const indexRef = useRef<HTMLElement>(null);
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const reveal = useCallback((entry: Entry) => {
    setSelectedTitle(entry.title);
    entry.open();
    requestAnimationFrame(() => {
      if (!entry.heading) return;
      // Scroll only this panel. scrollIntoView also scrolls overflow-hidden ancestors, which
      // can move the phone sheet and its chrome. Account for the index's actual text size.
      const scroller = indexRef.current?.closest<HTMLElement>(".campaign-status");
      if (scroller) scroller.scrollTo({ top: scroller.scrollTop + entry.heading.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top - (indexRef.current?.getBoundingClientRect().height ?? 0) - 12 });
      entry.heading.focus({ preventScroll: true });
    });
  }, []);
  const reached = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!targetTitle || reached.current === targetTitle) return;
    const entry = [...entries.values()].find(entry => entry.title === targetTitle);
    if (!entry) return;
    reached.current = targetTitle;
    reveal(entry);
  }, [entries, targetTitle, reveal]);
  const ordered = [...entries].sort((a, b) => {
    const position = a[1].heading?.compareDocumentPosition(b[1].heading!);
    return position && position & 4 ? -1 : 1;
  });
  return <Context.Provider value={context}>
    <nav ref={indexRef} className="campaign-section-index" aria-label="Campaign Sections">
      <span className="section-title">Go to Section</span>
      <div className="campaign-section-links" role="group" aria-label="Go to Section">
        {ordered.map(([id, entry]) => <button key={id} type="button" className="btn sm"
          aria-current={selectedTitle === entry.title ? "location" : undefined} onClick={() => reveal(entry)}>
          {entry.title} · {entry.count}{entry.attention ? " · Attention" : ""}
        </button>)}
      </div>
      <div><button type="button" className="btn sm" onClick={() => setAll(current => ({ value: false, revision: (current?.revision ?? 0) + 1 }))}>Collapse All</button>{" "}
        <button type="button" className="btn sm" onClick={() => setAll(current => ({ value: true, revision: (current?.revision ?? 0) + 1 }))}>Expand All</button></div>
    </nav>
    {children}
  </Context.Provider>;
}

/** Keep bodies mounted while folded: polling, in-progress controls and new attention still work. */
export function CampaignSection({ title, count = 0, attention = "", defaultOpen = false, className, children }: {
  title: string; count?: number; attention?: string; defaultOpen?: boolean; className?: string; children: ReactNode;
}) {
  const context = useContext(Context);
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = useState(() => context?.memory.get(title) ?? (defaultOpen || Boolean(attention)));
  const [fresh, setFresh] = useState(false);
  const previous = useRef(context?.attentionMemory.get(title) ?? attention);
  const memory = context?.memory;
  const register = context?.register;
  const setOpen = useCallback((value: boolean) => {
    memory?.set(title, value);
    setExpanded(value);
  }, [memory, title]);
  useEffect(() => {
    if (memory && !memory.has(title)) memory.set(title, expanded);
  }, [memory, title, expanded]);
  useEffect(() => {
    if (attention && attention.split("|").some(key => !previous.current.split("|").includes(key))) { setOpen(true); setFresh(true); }
    previous.current = attention;
    context?.attentionMemory.set(title, attention);
  }, [attention, setOpen, context?.attentionMemory, title]);
  const appliedAll = useRef(context?.all);
  useEffect(() => {
    if (context?.all && (appliedAll.current !== context.all || context.all.value)) setOpen(context.all.value);
    appliedAll.current = context?.all;
  }, [context?.all, setOpen]);
  useEffect(() => {
    register?.(id, { title, count, attention, heading: heading.current, open: () => setOpen(true) });
    return () => register?.(id, null);
  }, [register, id, title, count, attention, setOpen]);
  if (!context) return <section className={className} aria-labelledby={id}>
    <h3 id={id} className="section-title">{title}</h3>{children}
  </section>;
  return <section className={className} aria-labelledby={id} data-campaign-section={title}>
    <h3 aria-label={title} id={id} ref={heading} tabIndex={-1} className="section-title campaign-section-heading">
      <button type="button" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => { setOpen(!expanded); setFresh(false); }}>
        <span aria-hidden="true">{expanded ? "▾" : "▸"} </span>{title} · {count}{attention && <span> · Attention</span>}{fresh && <span> · New</span>}
      </button>
    </h3>
    <div id={`${id}-body`} hidden={!expanded}>{children}</div>
  </section>;
}

/** Bound reference lists locally; the server's own truncated totals remain explicit. */
export function useCampaignEntries<T>(items: readonly T[], limit = 3) {
  const [all, setAll] = useState(false);
  return { visible: all ? items : items.slice(0, limit), more: !all && items.length > limit
    ? <button type="button" className="btn ghost sm" onClick={() => setAll(true)}>Show All ({items.length})</button> : null };
}
