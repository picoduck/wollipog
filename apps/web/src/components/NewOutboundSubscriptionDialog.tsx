import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CreateOutboundEventSubscriptionRequest, OutboundEventKind } from "@wollipog/protocol";
import { callbackUrlError, eventCountLabel, OUTBOUND_EVENT_GROUPS, outboundEventLabel } from "../outbound-events.js";
import { FieldError } from "./FieldError.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, SegmentedControl, Select } from "./ui/ChoiceControls.js";

type ScopeKind = "project" | "automation";

/** The events a new subscription starts with. */
const DEFAULT_EVENTS: OutboundEventKind[] = ["session.created", "session.input_required"];

const SCOPE_ERROR: Record<ScopeKind, string> = {
  project: "Choose the project whose events to send.",
  automation: "Choose the automation whose events to send.",
};
const EVENTS_ERROR = "Choose at least one event to send.";

/**
 * New Subscription (#2973, docs/design-system.md §7.1–§7.3, §8.1, §8.4–§8.5): what to send events
 * for, the HTTPS address to send them to, which events, and the two opt-in extras. The address is
 * checked on blur once edited and on submit; Create Subscription with any field invalid focuses the
 * first one and sends nothing. The control plane's own check stays authoritative: its refusal is a
 * danger notice at the end of the body.
 */
export function NewOutboundSubscriptionDialog({ projects, automations, create, onClose }: {
  projects: ReadonlyArray<{ id: string; name: string }>;
  automations: ReadonlyArray<{ id: string; name: string }>;
  /** Creates the subscription. It resolves once the parent holds the secret and has closed this dialog. */
  create: (request: CreateOutboundEventSubscriptionRequest) => Promise<void>;
  onClose: () => void;
}) {
  const ids = useId();
  const formId = `${ids}-form`;
  const urlId = `${ids}-url`;
  const urlHelperId = `${ids}-url-helper`;
  const scopeErrorId = `${ids}-scope-error`;
  const eventsErrorId = `${ids}-events-error`;
  const extrasHelperId = `${ids}-extras-helper`;
  const [scopeKind, setScopeKind] = useState<ScopeKind>("project");
  const [chosenScope, setChosenScope] = useState<Record<ScopeKind, string | null>>({ project: null, automation: null });
  const [callbackUrl, setCallbackUrl] = useState("");
  const [urlEdited, setUrlEdited] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [eventKinds, setEventKinds] = useState<ReadonlySet<OutboundEventKind>>(() => new Set(DEFAULT_EVENTS));
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [includeSessionName, setIncludeSessionName] = useState(false);
  const [includeQuestionTitle, setIncludeQuestionTitle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const creating = useRef(false);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true; a create
  // that settles after the dialog has gone changes nothing here.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const urlRef = useRef<HTMLInputElement>(null);
  const scopeRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<HTMLFieldSetElement>(null);

  const options = scopeKind === "project" ? projects : automations;
  // A choice that has since gone (the project was deleted) falls back to the first one still listed.
  const scopeId = options.some((option) => option.id === chosenScope[scopeKind])
    ? chosenScope[scopeKind]
    : options[0]?.id ?? null;
  const scopeLabel = scopeKind === "project" ? "Project" : "Automation";

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating.current) return;
    const nextUrlError = callbackUrlError(callbackUrl);
    const nextScopeError = scopeId ? null : SCOPE_ERROR[scopeKind];
    const nextEventsError = eventKinds.size > 0 ? null : EVENTS_ERROR;
    setUrlEdited(true);
    setUrlError(nextUrlError);
    setScopeError(nextScopeError);
    setEventsError(nextEventsError);
    // Focus moves to the first invalid field in the order they are drawn, which announces its error (§8.5).
    if (nextScopeError) {
      scopeRef.current?.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')?.focus();
      return;
    }
    if (nextUrlError) {
      urlRef.current?.focus();
      return;
    }
    if (nextEventsError) {
      eventsRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    creating.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await create({
        callbackUrl: callbackUrl.trim(),
        scope: scopeKind === "project"
          ? { kind: "project", projectId: scopeId! }
          : { kind: "automation", automationId: scopeId! },
        // In the dialog's order, whatever order they were checked in.
        eventKinds: OUTBOUND_EVENT_GROUPS.flatMap((group) => group.kinds).filter((kind) => eventKinds.has(kind)),
        includeSessionName,
        includeQuestionTitle,
      });
    } catch (cause) {
      if (mounted.current) setFailure(cause instanceof Error && cause.message ? cause.message : String(cause));
    } finally {
      creating.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const toggleEvent = (kind: OutboundEventKind, checked: boolean) => {
    const next = new Set(eventKinds);
    if (checked) next.add(kind); else next.delete(kind);
    setEventKinds(next);
    if (next.size > 0) setEventsError(null);
  };

  return (
    <Modal
      title="New Subscription"
      phoneSheet="full"
      className="outbound-subscription-dialog"
      // A create in flight finishes or fails before the dialog can go, so its secret is never lost.
      onClose={busy ? () => {} : onClose}
      footer={(
        <>
          <p className="outbound-subscription-dialog-count" aria-live="polite">
            {eventKinds.size === 0 ? "No events selected" : `${eventCountLabel(eventKinds.size)} selected`}
          </p>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton type="submit" form={formId} className="btn primary" busy={busy} progress="Creating the subscription…">
            Create Subscription
          </BusyButton>
        </>
      )}
    >
      <form id={formId} className="form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field" ref={scopeRef}>
          <span className="field-label" aria-hidden="true">Send Events For</span>
          <SegmentedControl<ScopeKind>
            className="block"
            label="Send Events For"
            value={scopeKind}
            options={[
              { value: "project", label: "A Project" },
              { value: "automation", label: "An Automation" },
            ]}
            onChange={(next) => {
              setScopeKind(next);
              setScopeError(null);
            }}
          />
          <Select<string>
            label={scopeLabel}
            value={scopeId}
            placeholder={`Choose ${scopeKind === "project" ? "a Project" : "an Automation"}`}
            emptyLabel={scopeKind === "project" ? "No projects yet." : "No automations yet."}
            options={options.map((option) => ({ value: option.id, label: option.name }))}
            invalid={scopeError !== null}
            describedBy={scopeError ? scopeErrorId : undefined}
            onChange={(next) => {
              setChosenScope((prior) => ({ ...prior, [scopeKind]: next }));
              setScopeError(null);
            }}
          />
          {scopeError && <FieldError id={scopeErrorId}>{scopeError}</FieldError>}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={urlId}>Callback URL</label>
          <input
            ref={urlRef}
            id={urlId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={2048}
            value={callbackUrl}
            placeholder="e.g. https://events.example.com/wollipog"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlHelperId}
            onChange={(event) => {
              const next = event.target.value;
              setCallbackUrl(next);
              setUrlEdited(true);
              // An error showing clears as soon as the value is valid (§8.5).
              if (urlError) setUrlError(callbackUrlError(next));
            }}
            onBlur={() => { if (urlEdited) setUrlError(callbackUrlError(callbackUrl)); }}
          />
          {urlError
            ? <FieldError id={urlHelperId}>{urlError}</FieldError>
            : <p className="field-helper" id={urlHelperId}>Each request is signed with a secret you copy once, after creating.</p>}
        </div>

        <fieldset
          ref={eventsRef}
          className="outbound-subscription-events"
          aria-describedby={eventsError ? eventsErrorId : undefined}
          aria-invalid={eventsError ? true : undefined}
        >
          <legend>Events</legend>
          <div className="outbound-subscription-event-groups">
            {OUTBOUND_EVENT_GROUPS.map((group) => (
              <div className="outbound-subscription-event-group" role="group" aria-labelledby={`${ids}-group-${group.label}`} key={group.label}>
                <h3 className="group-label" id={`${ids}-group-${group.label}`}>{group.label}</h3>
                {group.kinds.map((kind) => (
                  <Checkbox key={kind} label={outboundEventLabel(kind)} checked={eventKinds.has(kind)}
                    onChange={(checked) => toggleEvent(kind, checked)} />
                ))}
              </div>
            ))}
          </div>
          {eventsError && <FieldError id={eventsErrorId}>{eventsError}</FieldError>}
        </fieldset>

        <fieldset className="outbound-subscription-extras" aria-describedby={extrasHelperId}>
          <legend>Also Include</legend>
          <Checkbox label="Session Name" checked={includeSessionName} onChange={setIncludeSessionName} />
          <Checkbox label="Question Title" checked={includeQuestionTitle} onChange={setIncludeQuestionTitle} />
          <p className="field-helper" id={extrasHelperId}>Excluded unless selected.</p>
        </fieldset>

        {failure && (
          <Notice tone="danger" role="alert" title="Couldn't Create Subscription"
            details={<pre className="code-well">{failure}</pre>}>
            Check the address and try again.
          </Notice>
        )}
      </form>
    </Modal>
  );
}
