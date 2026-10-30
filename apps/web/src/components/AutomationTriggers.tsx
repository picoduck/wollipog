import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type {
  AutomationSchedule,
  AutomationTriggerCredential,
  AutomationTriggerDeliveryPolicy,
  AutomationTriggerKind,
  AutomationTriggerView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  createTriggerRequest,
  draftDeliveryPolicy,
  emptyTriggerDraft,
  SESSION_SELECTORS,
  targetChoiceNote,
  TRIGGER_KIND_LABEL,
  triggerAcceptsLabel,
  triggerEndpoint,
  triggerRequestShape,
  triggerUseLabels,
  type TriggerDraft,
} from "../automation-triggers.js";
import { writeClipboardText } from "../clipboard.js";
import { CopyButton } from "./common.js";
import { useFeedback, type ConfirmationOptions } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { ChevronDownIcon, ChevronRightIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSurface } from "./Menu.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { OneLineCodeWell } from "./OneLineCodeWell.js";
import { ActionsMenu, type ActionsMenuChoice, type PageMenuAction } from "./PageHeader.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Checkbox, Select } from "./ui/ChoiceControls.js";
import { Switch } from "./ui/SettingsRows.js";
import { useIsMobile } from "./useIsMobile.js";

const BACK_TO_MORE_ACTIONS = "Back to More Actions";
const NAME_ERROR = "Enter a name for the trigger.";
const NO_ADDRESS = "No reachable address yet";
const NO_ADDRESS_REASON = "Wollipog needs an address others can reach before a trigger can be called.";

/** The Triggers section's one help line (#2972). */
export const TRIGGERS_HELP = "A paused automation ignores its triggers.";

const failureMessage = (cause: unknown) => cause instanceof Error && cause.message ? cause.message : String(cause);

/** A multi-line code well (§11.7) with its copy button, named by `name` ("Copy Headers"). */
function CodeWell({ value, name }: { value: string; name: string }) {
  return (
    <div className="code-well">
      <pre>{value}</pre>
      <CopyButton text={value} iconOnly ariaLabel={`Copy ${name}`} className="icon-btn sm" />
    </div>
  );
}

/**
 * How to Call (§11.7): the signed request a trigger of this kind and policy takes, as reference,
 * with Copy on each well. The full contract is docs/automation-triggers.md.
 */
function HowToCallReference({ kind, policy, triggerId }: {
  kind: AutomationTriggerKind;
  policy: AutomationTriggerDeliveryPolicy | undefined;
  triggerId?: string;
}) {
  const shape = triggerRequestShape(kind, policy, triggerId);
  const targetNote = targetChoiceNote(policy);
  const references = policy && (policy.allowPrompt || policy.parameterNames.length > 0);
  return (
    <div className="automation-trigger-reference">
      <div className="field">
        <span className="field-label">Request</span>
        <CodeWell value={shape.headers} name="Request" />
      </div>
      <div className="field">
        <span className="field-label">Body</span>
        <CodeWell value={shape.body} name="Body" />
        <p className="field-helper">
          {kind === "chatops" ? "The command is always run. " : ""}
          Reusing an event ID with a different body is refused.{targetNote ? ` ${targetNote}` : ""}
        </p>
      </div>
      <div className="field">
        <span className="field-label">Signed Text</span>
        <CodeWell value={shape.signing} name="Signed Text" />
        <p className="field-helper">
          Sign these lines with HMAC-SHA256 and the signing secret, and send the hex digest after v1=. The timestamp must be within five minutes.
        </p>
      </div>
      {references && (
        <p className="field-helper">
          In the automation&apos;s prompt, place them with <code>{"{{delivery.prompt}}"}</code> and <code>{"{{delivery.parameters.<name>}}"}</code>.
        </p>
      )}
    </div>
  );
}

/** The one-time secret (§13.2): a warning that it shows once, and the secret with Copy Secret. */
function SigningSecretNotice({ secret }: { secret: string }) {
  return (
    <Notice tone="warning" role="status" title="Copy the Signing Secret Now" className="automation-trigger-secret-notice">
      <p>It won&apos;t be shown again.</p>
      <OneLineCodeWell value={secret} name="Secret" />
    </Notice>
  );
}

/** Where a trigger is called: its address with Copy URL, or why it has none yet. */
function AddressField({ endpoint }: { endpoint: string | null }) {
  return (
    <div className="field">
      <span className="field-label">Address</span>
      {endpoint
        ? <OneLineCodeWell value={endpoint} name="URL" />
        : <p className="field-helper">{`${NO_ADDRESS}. ${NO_ADDRESS_REASON}`}</p>}
    </div>
  );
}

/**
 * New Webhook Trigger and New Chat-Ops Trigger (#2972, docs/design-system.md §7.1–§7.5, §8.1,
 * §8.4): a name, the details callers may add, and How to Call. Create Trigger sends the same request
 * the inline form did. Once created, the same dialog shows the address and the one-time secret; the
 * secret lives only in this dialog's state, so Done, Escape or the backdrop clears it with the
 * dialog.
 */
export function NewTriggerDialog({ automation, kind, publicOrigin, onCreated, onClose }: {
  automation: AutomationSchedule;
  kind: AutomationTriggerKind;
  publicOrigin: string | null;
  /** The trigger exists: the page reads its triggers again. */
  onCreated: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const ids = useId();
  const formId = `${ids}-form`;
  const nameId = `${ids}-name`;
  const nameErrorId = `${ids}-name-error`;
  const namesId = `${ids}-names`;
  const namesHelperId = `${ids}-names-helper`;
  const referenceId = `${ids}-reference`;
  const [draft, setDraft] = useState<TriggerDraft>(() => emptyTriggerDraft(automation.name, kind));
  const [nameError, setNameError] = useState<string | null>(null);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<AutomationTriggerCredential | null>(null);
  const creating = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true; a create
  // that settles after the dialog has gone changes nothing here.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // The form, and the Create Trigger that was focused, are gone: the secret's Copy Secret takes focus.
  useEffect(() => {
    if (created) bodyRef.current?.querySelector<HTMLElement>('[aria-label="Copy Secret"]')?.focus();
  }, [created]);

  const kindLabel = TRIGGER_KIND_LABEL[kind];
  const takesDetails = automation.action.kind !== "workflow_run";
  const update = (change: Partial<TriggerDraft>) => setDraft((current) => ({ ...current, ...change }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating.current) return;
    if (!draft.name.trim()) {
      setNameError(NAME_ERROR);
      nameRef.current?.focus();
      return;
    }
    creating.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const credential = await api.createAutomationTrigger(automation.automationId, createTriggerRequest(kind, draft));
      if (!mounted.current) return;
      setCreated(credential);
      onCreated();
    } catch (cause) {
      if (mounted.current) setFailure(failureMessage(cause));
    } finally {
      creating.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (created) {
    return (
      <Modal
        title={`${kindLabel} Trigger Created`}
        onClose={onClose}
        footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
      >
        <div className="form" ref={bodyRef}>
          <AddressField endpoint={triggerEndpoint(publicOrigin, created.trigger.triggerId)} />
          <SigningSecretNotice secret={created.secret} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`New ${kindLabel} Trigger`}
      // A create in flight finishes or fails before the dialog can go, so its secret is never lost.
      onClose={busy ? () => {} : onClose}
      initialFocusRef={nameRef}
      footer={(
        <>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <BusyButton type="submit" form={formId} className="btn primary" busy={busy} progress="Creating the trigger…">
            Create Trigger
          </BusyButton>
        </>
      )}
    >
      <form id={formId} className="form" noValidate onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label className="field-label" htmlFor={nameId}>Name</label>
          <input
            ref={nameRef}
            id={nameId}
            value={draft.name}
            maxLength={80}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? nameErrorId : undefined}
            onChange={(event) => {
              const name = event.target.value;
              update({ name });
              if (nameError && name.trim()) setNameError(null);
            }}
          />
          {nameError && <FieldError id={nameErrorId}>{nameError}</FieldError>}
        </div>

        {takesDetails && (
          <div className="automation-trigger-details">
            {/* The whole row is the switch (§8.4), named by its title and described by its sentence. */}
            <Switch
              className="automation-trigger-switch"
              checked={draft.configurable}
              labelledBy={`${ids}-details-title`}
              describedBy={`${ids}-details-desc`}
              onChange={(configurable) => update({ configurable })}
            >
              <span className="automation-trigger-switch-text">
                <span className="automation-trigger-switch-title" id={`${ids}-details-title`}>Let Callers Add Details</span>
                <span className="automation-trigger-switch-desc" id={`${ids}-details-desc`}>Each request can bring text or values for the prompt.</span>
              </span>
            </Switch>
            {draft.configurable && (
              <div className="automation-trigger-detail-fields">
                <Checkbox
                  label="Prompt Text"
                  checked={draft.allowPrompt}
                  onChange={(allowPrompt) => update({ allowPrompt })}
                />
                <div className="field">
                  <label className="field-label" htmlFor={namesId}>Named Values</label>
                  <input
                    id={namesId}
                    className="automation-trigger-names"
                    value={draft.parameterNames}
                    placeholder="issue, run_id"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={namesHelperId}
                    onChange={(event) => update({ parameterNames: event.target.value })}
                  />
                  <p className="field-helper" id={namesHelperId}>Separate names with commas.</p>
                </div>
                <div className="field">
                  <span className="field-label" aria-hidden="true">If a Referenced Value Is Missing</span>
                  <Select<TriggerDraft["missingReferences"]>
                    label="If a Referenced Value Is Missing"
                    value={draft.missingReferences}
                    options={[
                      { value: "reject", label: "Reject the Delivery" },
                      { value: "use_stored", label: "Use the Saved Text" },
                    ]}
                    onChange={(missingReferences) => update({ missingReferences })}
                  />
                </div>
                {automation.action.kind === "prompt_session" && (
                  <fieldset className="automation-trigger-selectors">
                    <legend className="field-label">Choose the Session By</legend>
                    {SESSION_SELECTORS.map(([selector, label]) => (
                      <Checkbox
                        key={selector}
                        label={label}
                        checked={draft.sessionSelectors.includes(selector)}
                        onChange={(checked) => update({
                          sessionSelectors: checked
                            ? [...draft.sessionSelectors, selector]
                            : draft.sessionSelectors.filter((candidate) => candidate !== selector),
                        })}
                      />
                    ))}
                  </fieldset>
                )}
              </div>
            )}
          </div>
        )}

        <div className="disclosure inline">
          <button
            type="button"
            className="disclosure-trigger"
            aria-expanded={referenceOpen}
            aria-controls={referenceOpen ? referenceId : undefined}
            onClick={() => setReferenceOpen((open) => !open)}
          >
            <ChevronRightIcon className="disclosure-chevron" aria-hidden="true" />
            How to Call
          </button>
          {referenceOpen && (
            <div className="disclosure-body" id={referenceId}>
              <HowToCallReference kind={kind} policy={draftDeliveryPolicy(draft)} />
            </div>
          )}
        </div>

        {failure && (
          <Notice tone="danger" role="alert" title="Couldn't Create Trigger"
            details={<pre className="code-well">{failure}</pre>}>
            Check the name and details, then try again.
          </Notice>
        )}
      </form>
    </Modal>
  );
}

/** How to Call… for one trigger: its address, and the request its kind and options take. */
function HowToCallDialog({ trigger, publicOrigin, onClose }: {
  trigger: AutomationTriggerView;
  publicOrigin: string | null;
  onClose: () => void;
}) {
  return (
    <Modal
      title="How to Call"
      description={trigger.name}
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <div className="form">
        <AddressField endpoint={triggerEndpoint(publicOrigin, trigger.triggerId)} />
        <HowToCallReference kind={trigger.kind} policy={trigger.deliveryPolicy} triggerId={trigger.triggerId} />
      </div>
    </Modal>
  );
}

/** The new secret after Rotate Secret, shown once; closing the dialog clears it. */
function RotatedSecretDialog({ credential, onClose }: {
  credential: AutomationTriggerCredential;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Secret Rotated"
      description={credential.trigger.name}
      onClose={onClose}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}
    >
      <SigningSecretNotice secret={credential.secret} />
    </Modal>
  );
}

/** Add Trigger (§3.2, §9.1): a menu button in the section's head with the two kinds. */
function AddTriggerMenu({ disabled, onChoose }: {
  disabled: boolean;
  onChoose: (kind: AutomationTriggerKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "automation-add-trigger-menu");
  const choose = (kind: AutomationTriggerKind) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    onChoose(kind);
  };
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className="btn sm"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
      >
        Add Trigger
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="Add Trigger"
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          <MenuItem onClick={() => choose("webhook")}>Webhook Trigger…</MenuItem>
          <MenuItem onClick={() => choose("chatops")}>Chat-Ops Trigger…</MenuItem>
        </MenuSurface>
      )}
    </>
  );
}

/**
 * One trigger (§5.2, §11.3): a two-line row with its name, then its kind and use in words. Copy URL
 * trails it on wider screens; ⋯ holds Copy URL, How to Call…, Rotate Secret… and Revoke Trigger…
 */
function TriggerRow({ trigger, endpoint, now, phone, onCopy, menu }: {
  trigger: AutomationTriggerView;
  endpoint: string | null;
  now: number;
  phone: boolean;
  onCopy: () => void;
  menu: PageMenuAction[];
}) {
  const accepts = triggerAcceptsLabel(trigger.deliveryPolicy);
  return (
    <div className="row row-2 automation-trigger-row" data-trigger-id={trigger.triggerId}>
      <span className="row-body">
        <span className="row-line"><span className="row-title" title={trigger.name}>{trigger.name}</span></span>
        <span className="row-sub automation-trigger-meta">
          <span>{TRIGGER_KIND_LABEL[trigger.kind]}</span>
          {endpoint
            ? triggerUseLabels(trigger, now).map((label) => <span key={label}>{label}</span>)
            : <span>{NO_ADDRESS}</span>}
          {accepts && <span title={accepts}>{accepts}</span>}
        </span>
      </span>
      {!phone && (
        <button type="button" className="btn sm ghost" disabled={!endpoint}
          title={endpoint ? undefined : NO_ADDRESS_REASON} onClick={onCopy}>
          Copy URL
        </button>
      )}
      <ActionsMenu size="sm" label={`${trigger.name} Actions`} items={menu} />
    </div>
  );
}

/**
 * An automation's Triggers section (#2972, docs/design-system.md §5.2, §7, §9.1, §13.2): Add Trigger
 * in its head, one help line, and one surface of trigger rows. New Trigger is controlled, because
 * the page's ⋯ opens it too. Rotate Secret and Revoke Trigger confirm from the row's ⋯, and on a
 * phone replace its sheet with Back. A new or rotated secret lives only in its dialog's state.
 */
export function AutomationTriggers({ automation, triggers, publicOrigin, now, disabled, adding, onAddingChange, onChanged, onRevoked }: {
  automation: AutomationSchedule;
  triggers: readonly AutomationTriggerView[];
  publicOrigin: string | null;
  now: number;
  /** An action of the page is running: nothing new starts here. */
  disabled: boolean;
  /** The kind New Trigger is open for, or null. */
  adding: AutomationTriggerKind | null;
  onAddingChange: (kind: AutomationTriggerKind | null) => void;
  /** A trigger was created or rotated: the page reads its triggers again. */
  onChanged: () => void;
  /** A trigger was revoked: its row goes now, and the page reads its triggers again. */
  onRevoked: (triggerId: string) => void;
}) {
  const api = useApi();
  const { confirm, showToast } = useFeedback();
  const phone = useIsMobile();
  const [howToCall, setHowToCall] = useState<AutomationTriggerView | null>(null);
  const [rotated, setRotated] = useState<AutomationTriggerCredential | null>(null);
  // Set in the effect body, so StrictMode's simulated unmount and remount leave it true; a request
  // that settles after the page has gone shows nothing.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  /** Triggers revoked here: a rotation's secret for one of them signs nothing and is never shown. */
  const revokedIds = useRef(new Set<string>());

  const copyUrl = async (endpoint: string) => {
    // ⋯ or Copy URL keeps focus. A refused write falls back to a selected field only while the copy
    // still owns the interaction: the page is mounted and focus is still there, or nowhere.
    const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unclaimed = () => document.activeElement === null || document.activeElement === document.body;
    const copied = await writeClipboardText(endpoint, () => mounted.current && (unclaimed() || document.activeElement === invoker));
    if (copied === null) return;
    if (unclaimed()) invoker?.focus();
    if (copied) showToast("URL copied.", { tone: "success", detail: endpoint, detailStyle: "mono" });
    else showToast("Couldn't copy the URL.", { tone: "error" });
  };

  // Neither Rotate nor Revoke can be withdrawn once sent, so the confirmation stays until the
  // request settles: a dismissed request still running could otherwise show its secret late.
  const confirmFromMenu = (choice: ActionsMenuChoice, options: ConfirmationOptions) => confirm({
    ...options,
    tone: "danger",
    cancelWhileRunning: false,
    back: { label: BACK_TO_MORE_ACTIONS, run: choice.reopen },
  });

  const rotate = (trigger: AutomationTriggerView, choice: ActionsMenuChoice) => void confirmFromMenu(choice, {
    title: "Rotate Secret",
    message: `“${trigger.name}” gets a new signing secret. Requests signed with the old one are rejected right away.`,
    confirmLabel: "Rotate Secret",
    progress: "Rotating the secret…",
    onConfirm: async () => {
      const credential = await api.rotateAutomationTrigger(automation.automationId, trigger.triggerId);
      if (!mounted.current || revokedIds.current.has(trigger.triggerId)) return;
      setRotated(credential);
      onChanged();
    },
  });

  const revoke = (trigger: AutomationTriggerView, choice: ActionsMenuChoice) => void confirmFromMenu(choice, {
    title: "Revoke Trigger",
    message: `“${trigger.name}” stops accepting requests, and deliveries that haven't started are rejected. This can't be undone.`,
    confirmLabel: "Revoke Trigger",
    progress: "Revoking the trigger…",
    onConfirm: async () => {
      await api.deleteAutomationTrigger(automation.automationId, trigger.triggerId);
      revokedIds.current.add(trigger.triggerId);
      if (!mounted.current) return;
      // A secret shown for this trigger signs nothing any more.
      setRotated((current) => current?.trigger.triggerId === trigger.triggerId ? null : current);
      setHowToCall((current) => current?.triggerId === trigger.triggerId ? null : current);
    },
  }).then((revoked) => { if (revoked && mounted.current) onRevoked(trigger.triggerId); });

  const menuFor = (trigger: AutomationTriggerView, endpoint: string | null): PageMenuAction[] => [
    {
      label: "Copy URL",
      disabled: !endpoint,
      ...(endpoint ? {} : { description: NO_ADDRESS_REASON }),
      onClick: () => { if (endpoint) void copyUrl(endpoint); },
    },
    { label: "How to Call…", onClick: () => setHowToCall(trigger) },
    { label: "Rotate Secret…", disabled, onClick: (choice) => rotate(trigger, choice) },
    { label: "Revoke Trigger…", danger: true, disabled, onClick: (choice) => revoke(trigger, choice) },
  ];

  return (
    <section className="section" aria-labelledby="automation-triggers">
      <div className="section-head">
        <h2 className="section-title" id="automation-triggers" tabIndex={-1}>Triggers</h2>
        <div className="actions"><AddTriggerMenu disabled={disabled} onChoose={onAddingChange} /></div>
      </div>
      <p className="section-note">{TRIGGERS_HELP}</p>
      {triggers.length === 0
        ? <p className="automation-empty">No triggers yet.</p>
        : (
          <div className="surface">
            {triggers.map((trigger) => {
              const endpoint = triggerEndpoint(publicOrigin, trigger.triggerId);
              return (
                <TriggerRow
                  key={trigger.triggerId}
                  trigger={trigger}
                  endpoint={endpoint}
                  now={now}
                  phone={phone}
                  onCopy={() => { if (endpoint) void copyUrl(endpoint); }}
                  menu={menuFor(trigger, endpoint)}
                />
              );
            })}
          </div>
        )}
      {adding && (
        <NewTriggerDialog
          automation={automation}
          kind={adding}
          publicOrigin={publicOrigin}
          onCreated={onChanged}
          onClose={() => onAddingChange(null)}
        />
      )}
      {howToCall && <HowToCallDialog trigger={howToCall} publicOrigin={publicOrigin} onClose={() => setHowToCall(null)} />}
      {rotated && <RotatedSecretDialog credential={rotated} onClose={() => setRotated(null)} />}
    </section>
  );
}
