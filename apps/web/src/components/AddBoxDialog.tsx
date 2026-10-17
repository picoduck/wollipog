import { useEffect, useId, useRef, useState } from "react";
import type { SshConfigHost } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import { describeSshFailure } from "../format.js";
import { Modal } from "./common.js";
import { FieldError } from "./FieldError.js";
import { ChevronRightIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Select } from "./ui/ChoiceControls.js";

/** An empty Port connects on the SSH default. */
const DEFAULT_PORT = 22;

/** Why the SSH Target cannot be sent, or null. The control plane refuses the same values. */
export function sshTargetError(value: string): string | null {
  const target = value.trim();
  if (!target) return "Enter an SSH target, such as user@host.";
  if (target.startsWith("-") || /\s/.test(target)) return "Use an SSH target such as user@host, with no spaces or leading dash.";
  return null;
}

/** Why the Port cannot be sent, or null. Empty is the default port. */
export function sshPortError(value: string): string | null {
  const port = value.trim();
  if (!port) return null;
  const n = Number(port);
  return /^\d+$/.test(port) && n >= 1 && n <= 65535 ? null : "Use 1 to 65535.";
}

/**
 * Connect via SSH (docs/design-system.md §7, §8): the control plane bootstraps a runner on the
 * machine over SSH and the machine streams into the list as it goes bootstrapping → deploying →
 * online. SSH Target is the one required field, so it comes first and takes the opening focus (on a
 * fine pointer, which Modal decides). A refused request is one sentence above the footer with the
 * raw text behind Show Details (#2987).
 */
export function AddBoxDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const ids = useId();
  const fieldId = (name: string) => `${ids}-${name}`;
  const [displayName, setDisplayName] = useState("");
  const [displayNameEdited, setDisplayNameEdited] = useState(false);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [sshTarget, setSshTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [sshPort, setSshPort] = useState(String(DEFAULT_PORT));
  const [portEdited, setPortEdited] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; raw: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([]);
  const targetRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  // Offer this computer's ~/.ssh/config hosts to fill the target from.
  useEffect(() => {
    api.sshConfigHosts().then((r) => setSshHosts(r.hosts)).catch(() => {});
  }, [api]);

  const chooseHost = (alias: string) => {
    const h = sshHosts.find((x) => x.host === alias);
    if (!h) return;
    // Submit the alias itself so the machine's ssh/scp resolve the whole Host block — HostName, User,
    // IdentityFile, ProxyJump, HostKeyAlias, etc. Rewriting to `user@HostName` would bypass those
    // alias-scoped settings and can turn a known-good `ssh <alias>` into a failing connection.
    setSelectedHost(h.host);
    setSshTarget(h.host);
    setTargetError(null);
    setSshPort(h.port ? String(h.port) : String(DEFAULT_PORT));
    setPortError(null);
    if (!displayNameEdited) setDisplayName(h.host);
  };

  const close = () => {
    if (submittingRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (submittingRef.current) return;
    // Every field on submit (§8.5); focus moves to the first invalid one, which announces its error.
    const targetProblem = sshTargetError(sshTarget);
    const portProblem = sshPortError(sshPort);
    setTargetError(targetProblem);
    setPortError(portProblem);
    setPortEdited(true);
    if (targetProblem) {
      targetRef.current?.focus();
      return;
    }
    if (portProblem) {
      portRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFailure(null);
    const target = sshTarget.trim();
    try {
      await api.addBox({
        displayName: displayName.trim() || undefined,
        sshTarget: target,
        workspacePath: workspacePath.trim() || undefined,
        sshPort: sshPort.trim() ? Number(sshPort.trim()) : DEFAULT_PORT,
      });
      submittingRef.current = false;
      onClose(); // it now streams into the list via box_upsert
    } catch (e) {
      const raw = (e as Error).message;
      // An ApiError is the control plane's answer; anything else never reached it.
      const status = e instanceof ApiError ? e.status : null;
      setFailure({ message: describeSshFailure(raw, target, { status }), raw });
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const hostOptions = sshHosts.map((h) => ({
    value: h.host,
    label: h.host,
    ...(h.hostName ? { description: `${h.user ? `${h.user}@` : ""}${h.hostName}${h.port ? `:${h.port}` : ""}` } : {}),
  }));

  return (
    <Modal
      title="Connect via SSH"
      description="Wollipog installs and starts a runner on the machine over SSH."
      onClose={close}
      footer={
        <>
          <button className="btn" type="button" onClick={close} disabled={submitting}>
            Cancel
          </button>
          <BusyButton className="btn primary" type="submit" form={fieldId("form")} busy={submitting}
            progress="Connecting the machine…">
            Connect Machine
          </BusyButton>
        </>
      }
    >
      <form
        id={fieldId("form")}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <details className="disclosure">
          <summary><ChevronRightIcon className="disclosure-chevron" />What This Needs</summary>
          <div className="disclosure-body">
            <ul className="connect-ssh-needs">
              <li>You can already <code>ssh</code> to the machine without a password.</li>
              <li><code>ssh</code> and <code>scp</code> are on this computer.</li>
              <li>The machine runs Linux or macOS.</li>
            </ul>
          </div>
        </details>
        <div className="field">
          <div className="field-head"><label htmlFor={fieldId("target")}>SSH Target</label></div>
          <input
            ref={targetRef}
            id={fieldId("target")}
            value={sshTarget}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="user@host"
            readOnly={submitting}
            aria-invalid={targetError ? true : undefined}
            aria-describedby={targetError ? fieldId("target-error") : undefined}
            onChange={(e) => {
              const next = e.target.value;
              setSshTarget(next);
              setSelectedHost(null);
              // An error showing clears as soon as the value is valid (§8.5).
              if (targetError) setTargetError(sshTargetError(next));
            }}
          />
          {targetError && <FieldError id={fieldId("target-error")}>{targetError}</FieldError>}
        </div>
        {hostOptions.length > 0 && (
          <div className="field">
            <span>Choose from SSH Config</span>
            <Select
              label="Choose from SSH Config"
              placeholder="Choose a host…"
              value={selectedHost}
              options={hostOptions}
              disabled={submitting}
              onChange={chooseHost}
            />
          </div>
        )}
        <div className="field">
          <div className="field-head"><label htmlFor={fieldId("name")}>Machine Name (Optional)</label></div>
          <input
            id={fieldId("name")}
            value={displayName}
            maxLength={120}
            autoComplete="off"
            placeholder="e.g. Studio Mac"
            readOnly={submitting}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setDisplayNameEdited(true);
            }}
          />
        </div>
        <div className="connect-ssh-location">
          <div className="field">
            <div className="field-head"><label htmlFor={fieldId("workspace")}>Workspace Folder (Optional)</label></div>
            <input
              id={fieldId("workspace")}
              value={workspacePath}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="e.g. ~/code/app"
              readOnly={submitting}
              onChange={(e) => setWorkspacePath(e.target.value)}
            />
          </div>
          <div className="field connect-ssh-port">
            <div className="field-head"><label htmlFor={fieldId("port")}>Port</label></div>
            <input
              ref={portRef}
              id={fieldId("port")}
              className="w-xs"
              value={sshPort}
              inputMode="numeric"
              autoComplete="off"
              placeholder={String(DEFAULT_PORT)}
              readOnly={submitting}
              aria-invalid={portError ? true : undefined}
              aria-describedby={portError ? fieldId("port-error") : undefined}
              onChange={(e) => {
                const next = e.target.value;
                setSshPort(next);
                setPortEdited(true);
                if (portError) setPortError(sshPortError(next));
              }}
              onBlur={() => { if (portEdited && !submittingRef.current) setPortError(sshPortError(sshPort)); }}
            />
            {portError && <FieldError id={fieldId("port-error")}>{portError}</FieldError>}
          </div>
        </div>
        {failure && (
          <Notice tone="danger" role="alert" title="Couldn't Connect the Machine"
            details={<div className="code-well"><code>{failure.raw}</code></div>}>
            {failure.message}
          </Notice>
        )}
      </form>
    </Modal>
  );
}
