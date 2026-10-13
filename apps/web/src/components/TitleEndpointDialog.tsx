import React, { useId, useRef, useState } from "react";
import type {
  ConfigureSessionNamingCustomModelRequest,
  SessionNamingConnectionTestResult,
  SessionNamingSettingsView,
} from "@wollipog/protocol";
import { Modal } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { FieldError } from "./FieldError.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  connectionResult,
  endpointUrlError,
  modelIdError,
  plainFailure,
  timeoutError,
  type PlainFailure,
} from "./session-titles.js";

type Field = "machine" | "endpoint" | "model" | "timeout";
type Pending = "save" | "test" | "delete" | null;
/** What the last key action or connection test said, in the dialog above its footer. */
type Outcome = { tone: "success" | "warning"; message: string } | ({ tone: "danger" } & PlainFailure);

/**
 * Session titles from an endpoint you run (#3025): Send Through, Endpoint URL, Model and Timeout side
 * by side, and API Key, in a `.modal` (560px) that is a bottom sheet on phones (§7.1, §7.5).
 *
 * The key is write-only: it goes once to the chosen machine and is never returned, so the dialog can
 * only say that one is saved. Its actions show only when they can act (§3.1): Replace… and Delete…
 * beside a saved key, and Test Connection, at the footer's far left, once an endpoint is saved.
 *
 * Fields validate on blur after an edit and all at once on Save, which stays enabled and moves focus
 * to the first invalid field (§8.5). The saved URL is never returned either, only its origin, so
 * changing a saved endpoint means entering its URL again; saving unchanged fields keeps it as it is.
 */
export function TitleEndpointDialog({
  settings,
  onSave,
  onReplaceKey,
  onDeleteKey,
  onTest,
  onClose,
  returnFocusRef,
}: {
  settings: SessionNamingSettingsView;
  /** `null` keeps the saved endpoint and only makes it the source. */
  onSave: (config: ConfigureSessionNamingCustomModelRequest | null) => Promise<void>;
  onReplaceKey: (apiKey: string) => Promise<void>;
  onDeleteKey: () => Promise<void>;
  onTest: () => Promise<SessionNamingConnectionTestResult>;
  onClose: () => void;
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const { confirm } = useFeedback();
  const targets = settings.customModelTargets ?? [];
  const custom = settings.customModel;
  // An endpoint saved on a machine; one set in the server's environment has no key or test here.
  const saved = custom?.configurationSource === "runner" ? custom : undefined;
  const keySaved = saved?.apiKeyConfigured === true;
  const savedMachine = saved?.machineName ?? targets.find((target) => target.runnerId === saved?.runnerId)?.machineName;

  const [initial] = useState(() => ({
    runnerId: saved?.runnerId ?? targets.find((target) => target.available)?.runnerId ?? "",
    endpoint: "",
    model: saved?.model ?? "",
    timeout: String(saved?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    apiKey: "",
  }));
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [edited, setEdited] = useState<Partial<Record<Field, boolean>>>({});
  const [failure, setFailure] = useState<PlainFailure | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const pendingRef = useRef<Pending>(null);
  const [replacing, setReplacing] = useState(false);
  const fieldRefs = useRef<Partial<Record<Field, HTMLElement | null>>>({});
  const replaceRef = useRef<HTMLButtonElement>(null);
  const busy = pending !== null;

  // The machine a key is saved on stays chosen: the server refuses another until the key is deleted.
  const machineLocked = keySaved;
  const validate = (field: Field, values = draft): string | null => {
    switch (field) {
      case "machine": return values.runnerId ? null : "Choose a machine to send through.";
      // A key already saved on the machine travels with every request, just as a new one would.
      case "endpoint": return endpointUrlError(values.endpoint, keySaved || values.apiKey !== "");
      case "model": return modelIdError(values.model);
      case "timeout": return timeoutError(values.timeout);
    }
  };
  const setField = (field: keyof typeof draft, value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    setFailure(null);
    // An error showing clears as soon as the value is valid (§8.5).
    setErrors((previous) => {
      const remaining = { ...previous };
      for (const name of Object.keys(remaining) as Field[]) {
        if (!validate(name, next)) delete remaining[name];
      }
      return remaining;
    });
    if (field !== "apiKey") setEdited((previous) => ({ ...previous, [field === "runnerId" ? "machine" : field]: true }));
  };
  const blur = (field: Field) => {
    if (!edited[field]) return;
    const error = validate(field);
    setErrors((previous) => {
      const remaining = { ...previous };
      if (error) remaining[field] = error;
      else delete remaining[field];
      return remaining;
    });
  };

  const run = async (kind: Exclude<Pending, null>, action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = kind;
    setPending(kind);
    try {
      await action();
    } finally {
      pendingRef.current = null;
      setPending(null);
    }
  };

  const changed = (Object.keys(initial) as Array<keyof typeof initial>).some((key) => draft[key] !== initial[key]);
  const save = () => run("save", async () => {
    setFailure(null);
    setOutcome(null);
    // Unchanged fields keep the saved endpoint as it is.
    if (!changed && custom) {
      try {
        await onSave(null);
      } catch (caught) {
        setFailure(plainFailure(caught, "Couldn't save the title source.", "Try again."));
      }
      return;
    }
    const found: Partial<Record<Field, string>> = {};
    for (const field of ["machine", "endpoint", "model", "timeout"] as const) {
      const error = validate(field);
      if (error) found[field] = error;
    }
    const first = (["machine", "endpoint", "model", "timeout"] as const).find((field) => found[field]);
    if (first) {
      setErrors(found);
      setEdited({ machine: true, endpoint: true, model: true, timeout: true });
      const target = fieldRefs.current[first];
      (target instanceof HTMLInputElement ? target : target?.querySelector<HTMLElement>("button"))?.focus();
      return;
    }
    try {
      await onSave({
        runnerId: draft.runnerId,
        endpoint: draft.endpoint.trim(),
        model: draft.model.trim(),
        timeoutMs: Number(draft.timeout),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      });
    } catch (caught) {
      setFailure(plainFailure(caught, "Couldn't save the endpoint."));
    } finally {
      // The key is never kept in the page longer than the request that carries it.
      setDraft((current) => ({ ...current, apiKey: "" }));
    }
  });

  const test = () => run("test", async () => {
    setOutcome(null);
    try {
      setOutcome(connectionResult(await onTest()));
    } catch (caught) {
      setOutcome({ tone: "danger", ...plainFailure(caught, "Couldn't test the connection.") });
    }
  });

  const deleteKey = async () => {
    if (pendingRef.current) return;
    if (!await confirm({
      title: "Delete API Key",
      message: "The API key is deleted from the selected machine, and endpoints that require it stop working. This cannot be undone.",
      confirmLabel: "Delete API Key",
      tone: "danger",
    })) return;
    await run("delete", async () => {
      setOutcome(null);
      try {
        await onDeleteKey();
        setOutcome({ tone: "success", message: "The API key was deleted." });
      } catch (caught) {
        setOutcome({ tone: "danger", ...plainFailure(caught, "The API key wasn't deleted.") });
      }
    });
  };

  const close = () => {
    if (!pendingRef.current) onClose();
  };

  const errorOrHelper = (field: Field, helper?: React.ReactNode) => errors[field]
    ? <FieldError id={id(`${field}-error`)}>{errors[field]}</FieldError>
    : helper ? <p className="field-helper" id={id(`${field}-helper`)}>{helper}</p> : null;
  const describedBy = (field: Field, helper: boolean) =>
    errors[field] ? id(`${field}-error`) : helper ? id(`${field}-helper`) : undefined;

  return (
    <>
      <Modal
        title="Custom Endpoint for Titles"
        description="An OpenAI-compatible endpoint you run writes each new session's title."
        onClose={close}
        {...(returnFocusRef ? { returnFocusRef } : {})}
        tertiary={saved ? (
          <BusyButton className="btn ghost" busy={pending === "test"} progress="Testing the connection…" disabled={busy && pending !== "test"} onClick={() => void test()}>
            Test Connection
          </BusyButton>
        ) : undefined}
        footer={(
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
            <BusyButton className="btn primary" type="submit" form={id("form")} busy={pending === "save"} progress="Saving the endpoint…" disabled={busy && pending !== "save"}>
              Save
            </BusyButton>
          </>
        )}
      >
        <form
          id={id("form")}
          className="form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="field" ref={(node) => { fieldRefs.current.machine = node; }}>
            <span>Send Through</span>
            <Select
              label="Send Through"
              value={draft.runnerId || null}
              disabled={busy || machineLocked}
              invalid={Boolean(errors.machine)}
              describedBy={describedBy("machine", true)}
              placeholder="Choose a machine"
              options={targets.map((target) => ({
                value: target.runnerId,
                label: target.machineName,
                ...(target.available ? {} : { disabled: true, disabledReason: target.reason ?? "Unavailable." }),
              }))}
              onChange={(runnerId) => setField("runnerId", runnerId)}
            />
            {errorOrHelper("machine", machineLocked
              ? "Delete the saved key to send through another machine."
              : "Session text goes to your endpoint through this machine.")}
          </div>
          <div className="field">
            <label htmlFor={id("endpoint")}>Endpoint URL</label>
            <input
              id={id("endpoint")}
              ref={(node) => { fieldRefs.current.endpoint = node; }}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              value={draft.endpoint}
              placeholder={custom ? custom.endpointOrigin : "https://host/v1/chat/completions"}
              disabled={busy}
              aria-invalid={errors.endpoint ? true : undefined}
              aria-describedby={describedBy("endpoint", Boolean(custom))}
              onChange={(event) => setField("endpoint", event.target.value)}
              onBlur={() => blur("endpoint")}
            />
            {errorOrHelper("endpoint", custom ? `Saved for ${custom.endpointOrigin}. Enter the full URL again to change these settings.` : undefined)}
          </div>
          <div className="title-endpoint-pair">
            <div className="field">
              <label htmlFor={id("model")}>Model</label>
              <input
                id={id("model")}
                ref={(node) => { fieldRefs.current.model = node; }}
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                value={draft.model}
                placeholder="Model ID"
                disabled={busy}
                aria-invalid={errors.model ? true : undefined}
                aria-describedby={describedBy("model", false)}
                onChange={(event) => setField("model", event.target.value)}
                onBlur={() => blur("model")}
              />
              {errorOrHelper("model")}
            </div>
            <div className="field">
              <label htmlFor={id("timeout")}>Timeout</label>
              <span className="input-affix w-xs">
                <input
                  id={id("timeout")}
                  ref={(node) => { fieldRefs.current.timeout = node; }}
                  // Text, not number: a number field's spin buttons take the width its digits need.
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={String(MAX_TIMEOUT_MS).length}
                  value={draft.timeout}
                  disabled={busy}
                  aria-invalid={errors.timeout ? true : undefined}
                  aria-describedby={[id("timeout-unit"), describedBy("timeout", false)].filter(Boolean).join(" ")}
                  onChange={(event) => setField("timeout", event.target.value)}
                  onBlur={() => blur("timeout")}
                />
                <span className="input-affix-text" id={id("timeout-unit")}>ms</span>
              </span>
            </div>
          </div>
          {/* The timeout's error spans the pair: under a 96px field it would wrap word by word. */}
          {errors.timeout && <FieldError id={id("timeout-error")}>{errors.timeout}</FieldError>}
          {keySaved ? (
            <div className="field">
              <span id={id("key-label")}>API Key</span>
              <div className="title-endpoint-secret">
                <p className="title-endpoint-secret-text" id={id("key-line")}>
                  A key is saved on {savedMachine ?? "the selected machine"}.
                </p>
                <span className="title-endpoint-secret-actions">
                  <button
                    ref={replaceRef}
                    type="button"
                    className="btn sm ghost"
                    aria-haspopup="dialog"
                    aria-describedby={id("key-line")}
                    disabled={busy}
                    onClick={() => setReplacing(true)}
                  >
                    Replace…
                  </button>
                  <button
                    type="button"
                    className="btn sm ghost danger"
                    aria-haspopup="dialog"
                    aria-describedby={id("key-line")}
                    disabled={busy}
                    onClick={() => void deleteKey()}
                  >
                    Delete…
                  </button>
                </span>
              </div>
            </div>
          ) : (
            <div className="field">
              <label htmlFor={id("key")}>API Key (Optional)</label>
              <input
                id={id("key")}
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                disabled={busy}
                aria-describedby={id("key-helper")}
                onChange={(event) => setField("apiKey", event.target.value)}
              />
              <p className="field-helper" id={id("key-helper")}>The key is sent once to that machine and never shown again.</p>
            </div>
          )}
          {/* Always in the DOM, so the polite region exists before it has something to say. */}
          <div role="status" aria-atomic="true" className={outcome && outcome.tone !== "danger" ? undefined : "sr-only"}>
            {outcome && outcome.tone !== "danger" && <Notice tone={outcome.tone} compact>{outcome.message}</Notice>}
          </div>
          {outcome?.tone === "danger" && (
            <Notice tone="danger" role="alert" details={outcome.detail ? <code>{outcome.detail}</code> : undefined}>
              {outcome.message}
            </Notice>
          )}
          {failure && (
            <Notice tone="danger" role="alert" details={failure.detail ? <code>{failure.detail}</code> : undefined}>
              {failure.message}
            </Notice>
          )}
        </form>
      </Modal>
      {replacing && (
        <ReplaceKeyDialog
          machineName={savedMachine ?? "the selected machine"}
          returnFocusRef={replaceRef}
          onReplace={async (apiKey) => {
            await onReplaceKey(apiKey);
            setOutcome({ tone: "success", message: `The new key is saved on ${savedMachine ?? "the selected machine"}.` });
            setReplacing(false);
          }}
          onClose={() => setReplacing(false)}
        />
      )}
    </>
  );
}

/** Replace…: a new key for the saved endpoint, stacked over the endpoint dialog on desktop and in its
 * sheet's place, with Back, on a phone (§7.1). */
function ReplaceKeyDialog({ machineName, onReplace, onClose, returnFocusRef }: {
  machineName: string;
  onReplace: (apiKey: string) => Promise<void>;
  onClose: () => void;
  returnFocusRef: { current: HTMLElement | null };
}) {
  const ids = useId();
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<PlainFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (busy) return;
    if (!apiKey) {
      setError("Enter the new API key.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await onReplace(apiKey);
    } catch (caught) {
      setFailure(plainFailure(caught, "The API key wasn't replaced."));
      setBusy(false);
    } finally {
      setApiKey("");
    }
  };
  return (
    <Modal
      title="Replace API Key"
      onClose={() => { if (!busy) onClose(); }}
      returnFocusRef={returnFocusRef}
      footer={(
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <BusyButton className="btn primary" type="submit" form={`${ids}-form`} busy={busy} progress="Replacing the API key…">
            Replace API Key
          </BusyButton>
        </>
      )}
    >
      <form id={`${ids}-form`} className="form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="field">
          <label htmlFor={`${ids}-key`}>New API Key</label>
          <input
            ref={inputRef}
            id={`${ids}-key`}
            type="password"
            autoComplete="off"
            value={apiKey}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${ids}-error` : `${ids}-helper`}
            onChange={(event) => {
              setApiKey(event.target.value);
              if (event.target.value) setError(null);
            }}
          />
          {error
            ? <FieldError id={`${ids}-error`}>{error}</FieldError>
            : <p className="field-helper" id={`${ids}-helper`}>The key is sent once to {machineName} and never shown again.</p>}
        </div>
        {failure && (
          <Notice tone="danger" role="alert" details={failure.detail ? <code>{failure.detail}</code> : undefined}>
            {failure.message}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
