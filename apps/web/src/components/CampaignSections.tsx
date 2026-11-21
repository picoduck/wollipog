import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon, CollapseAllIcon, ExpandAllIcon, ListIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";

/** `count` is absent for a section that is always one thing (Summary), where a count says nothing. */
interface Entry { title: string; count?: number; attention: string; heading: HTMLHeadingElement | null; open: () => void }
const attentionMemory = new Map<string, Map<string, string>>();
const sectionMemory = new Map<string, Map<string, boolean>>();
export function forgetCampaignSections(): void { sectionMemory.clear(); attentionMemory.clear(); }
const Context = createContext<{
  memory: Map<string, boolean>;
  attentionMemory: Map<string, string>;
  register: (id: string, entry: Entry | null) => void;
  all: { value: boolean; revision: number } | null;
} | null>(null);

/** A jump leaves its heading 12px below the index; the current section is the last heading within this of it. */
const CURRENT_SLACK = 16;

/** The menu item's accessible name: its visible title, then what the trailing count and dot show. */
function sectionName(entry: Entry): string {
  return `${entry.title}${entry.count === undefined ? "" : `, ${entry.count}`}${entry.attention ? ", Needs Attention" : ""}`;
}

/** Sections register only when rendered, including those loaded independently from older servers. */
export function CampaignSections({ campaignId, targetTitle, targetKey, onTargetReached, children }: {
  campaignId: string; targetTitle?: string; targetKey?: string; onTargetReached?: () => void; children: ReactNode;
}) {
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
  const ordered = [...entries].sort((a, b) => {
    const position = a[1].heading?.compareDocumentPosition(b[1].heading!);
    return position && position & 4 ? -1 : 1;
  });
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  const [currentTitle, setCurrentTitle] = useState<string | null>(null);
  // A jump to a section near the end cannot scroll its heading up to the index, so the section it
  // chose stays current until the panel scrolls away from where the jump left it.
  const jumped = useRef<{ title: string; top: number } | null>(null);
  const scroller = useCallback(() => indexRef.current?.closest<HTMLElement>(".campaign-status") ?? null, []);
  const updateCurrent = useCallback(() => {
    const index = indexRef.current;
    const panel = scroller();
    const list = orderedRef.current;
    if (!index || !list.length) return;
    const pin = jumped.current;
    if (pin && panel && Math.abs(panel.scrollTop - pin.top) <= 2 && list.some(([, entry]) => entry.title === pin.title)) {
      setCurrentTitle(pin.title);
      return;
    }
    jumped.current = null;
    let current = list[0]![1].title;
    // At the top of the panel nothing has scrolled under the index yet.
    if (!panel || panel.scrollTop > 0) {
      const line = index.getBoundingClientRect().bottom + CURRENT_SLACK;
      for (const [, entry] of list) if (entry.heading && entry.heading.getBoundingClientRect().top <= line) current = entry.title;
    }
    setCurrentTitle(current);
  }, [scroller]);
  useEffect(() => {
    const panel = scroller();
    if (!panel) return;
    // One measurement per frame, however many scroll events arrive in it.
    let pending = false;
    let live = true;
    const onScroll = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; if (live) updateCurrent(); });
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => { live = false; panel.removeEventListener("scroll", onScroll); };
  }, [scroller, updateCurrent]);
  // Sections arriving, leaving, folding or unfolding move headings without any scroll.
  useEffect(() => { requestAnimationFrame(updateCurrent); }, [entries, all, updateCurrent]);
  const reveal = useCallback((entry: Entry) => {
    setCurrentTitle(entry.title);
    entry.open();
    requestAnimationFrame(() => {
      if (!entry.heading) return;
      // Scroll only this panel. scrollIntoView also scrolls overflow-hidden ancestors, which
      // can move the phone sheet and its chrome. Account for the index's actual text size.
      const panel = scroller();
      if (panel) {
        panel.scrollTo({ top: panel.scrollTop + entry.heading.getBoundingClientRect().top
          - panel.getBoundingClientRect().top - (indexRef.current?.getBoundingClientRect().height ?? 0) - 12 });
        jumped.current = { title: entry.title, top: panel.scrollTop };
      }
      entry.heading.focus({ preventScroll: true });
    });
  }, [scroller]);
  const reached = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = targetKey ?? targetTitle;
    if (!targetTitle || reached.current === key) return;
    const entry = [...entries.values()].find(entry => entry.title === targetTitle);
    if (!entry) return;
    reached.current = key;
    onTargetReached?.();
    reveal(entry);
  }, [entries, targetTitle, targetKey, reveal, onTargetReached]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useAccessibleMenu(menuOpen, setMenuOpen, "campaign-section-menu");
  const { menuRef } = menu;
  // Declared after the menu hook, so it runs after the hook's opening focus: the menu opens on
  // the section you are in, not on the first one.
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[aria-current="location"]')?.focus();
  }, [menuOpen, menuRef]);
  const current = ordered.find(([, entry]) => entry.title === currentTitle)?.[1] ?? ordered[0]?.[1];
  const needing = ordered.filter(([, entry]) => entry.attention).map(([, entry]) => entry);
  const setEvery = (value: boolean) => setAll(previous => ({ value, revision: (previous?.revision ?? 0) + 1 }));
  return <Context.Provider value={context}>
    <nav ref={indexRef} className="campaign-section-index" aria-label="Campaign Sections">
      <button ref={menu.triggerRef} type="button" className="btn ghost sm campaign-section-trigger" title="Go to Section"
        aria-label={current ? `Go to Section, Current Section: ${current.title}` : "Go to Section"}
        aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuOpen ? menu.menuId : undefined}
        disabled={!current} onClick={menu.toggle} onKeyDown={menu.onTriggerKeyDown}>
        <ListIcon size={14} />
        {current ? <>
          <span className="campaign-section-trigger-label">Section:</span>
          <span className="campaign-section-current">{current.title}</span>
        </> : <span className="campaign-section-current">Go to Section</span>}
        <ChevronDownIcon size={14} />
      </button>
      {needing.length > 0 && <button type="button" className="campaign-section-attention"
        title="Go to the first section that needs attention" onClick={() => reveal(needing[0]!)}>
        <span className="campaign-section-dot" aria-hidden="true" />
        {needing.length} {needing.length === 1 ? "Needs" : "Need"} Attention
      </button>}
      <span className="campaign-section-tools">
        <button type="button" className="icon-btn sm" aria-label="Collapse All" title="Collapse All" onClick={() => setEvery(false)}>
          <CollapseAllIcon size={14} />
        </button>
        <button type="button" className="icon-btn sm" aria-label="Expand All" title="Expand All" onClick={() => setEvery(true)}>
          <ExpandAllIcon size={14} />
        </button>
      </span>
    </nav>
    {menuOpen && <MenuSurface surfaceRef={menuRef} anchor={{ trigger: menu.triggerRef }} id={menu.menuId}
      label="Go to Section" boundary=".campaign-status" className="campaign-section-menu"
      onDismiss={() => menu.close(true)} onKeyDown={menu.onMenuKeyDown}>
      {ordered.map(([id, entry]) => <MenuItem key={id} aria-label={sectionName(entry)}
        aria-current={entry === current ? "location" : undefined}
        className={[entry === current ? "is-active" : "", entry.count === 0 ? "campaign-section-empty" : ""].filter(Boolean).join(" ") || undefined}
        icon={entry.attention ? <span className="campaign-section-dot" /> : undefined}
        trail={entry.count === undefined ? undefined : <span className="count">{entry.count}</span>}
        onClick={() => { menu.close(false); reveal(entry); }}>
        {entry.title}
      </MenuItem>)}
    </MenuSurface>}
    {children}
  </Context.Provider>;
}

/**
 * Keep bodies mounted while folded: polling, in-progress controls and new attention still work.
 * Omit `count` for a section that is always one thing (Summary, Campaign Pause): it shows none.
 */
export function CampaignSection({ title, count, attention = "", defaultOpen = false, className, children }: {
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
        {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        <span>{title}{count === undefined ? "" : ` · ${count}`}{attention && <span> · Attention</span>}{fresh && <span> · New</span>}</span>
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
