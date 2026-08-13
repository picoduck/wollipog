import { useEffect, useState } from "react";
import type { SshConfigHost } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { Modal } from "./common.js";

/**
 * "Add a box" flow: the user enters an SSH target and the control plane bootstraps a runner
 * there over a reverse SSH tunnel (deploying the runner binary + auto-detecting agents). The
 * box appears in the list via the live socket as it goes bootstrapping → deploying → online.
 */
export function AddBoxDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const [displayName, setDisplayName] = useState("");
  const [displayNameEdited, setDisplayNameEdited] = useState(false);
  const [selectedHost, setSelectedHost] = useState("");
  const [sshTarget, setSshTarget] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([]);

  // Offer the dashboard machine's ~/.ssh/config hosts for one-click import.
  useEffect(() => {
    api.sshConfigHosts().then((r) => setSshHosts(r.hosts)).catch(() => {});
  }, [api]);

  const importHost = (alias: string) => {
    const h = sshHosts.find((x) => x.host === alias);
    if (!h) return;
    // Submit the alias itself so the box's ssh/scp resolve the whole Host block — HostName, User,
    // IdentityFile, ProxyJump, HostKeyAlias, etc. Rewriting to `user@HostName` would bypass those
    // alias-scoped settings and can turn a known-good `ssh <alias>` into a failing connection.
    setSelectedHost(h.host);
    setSshTarget(h.host);
    setSshPort(h.port ? String(h.port) : "22");
    if (!displayNameEdited) setDisplayName(h.host);
  };

  const portNum = sshPort.trim() === "" ? 22 : Number(sshPort);
  const portValid = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const canAdd = sshTarget.trim().length > 0 && portValid && !submitting;

  const submit = async () => {
    if (!canAdd) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.addBox({
        displayName: displayName.trim() || undefined,
        sshTarget: sshTarget.trim(),
        workspacePath: workspacePath.trim() || undefined,
        sshPort: portNum,
      });
      onClose(); // it now streams into the list via box_upsert
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Connect via SSH"
      onClose={onClose}
      footer={
        <>
          {error && <span className="form-error" role="alert">{error}</span>}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!canAdd}>
            {submitting ? "Connecting…" : "Connect Machine"}
          </button>
        </>
      }
    >
      <div className="onboard">
        <p className="muted">
          Connect a <strong>development machine</strong> over SSH. The dashboard installs and starts a runner there through a
          reverse tunnel, then auto-detects its agents — no config files, nothing to expose inbound on the machine.
        </p>
        <ul className="tick">
          <li>
            You can already <code>ssh</code> to it without a password (key loaded in your agent / <code>~/.ssh</code>)
          </li>
          <li>
            <code>ssh</code> + <code>scp</code> are on this machine (built in on macOS/Linux and Windows 10+)
          </li>
          <li>The machine is Unix-like (Linux/macOS) for now</li>
        </ul>
        {sshHosts.length > 0 && (
          <label className="field">
            <span>
              Import From <code>~/.ssh/config</code>
            </span>
            <select
              value={selectedHost}
              onChange={(e) => importHost(e.target.value)}
            >
              <option value="" disabled>
                Choose a Host…
              </option>
              {sshHosts.map((h) => (
                <option key={h.host} value={h.host}>
                  {h.host}
                  {h.hostName ? ` — ${h.user ? `${h.user}@` : ""}${h.hostName}${h.port ? `:${h.port}` : ""}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>Machine Name</span>
          <input
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              setDisplayNameEdited(true);
            }}
            placeholder="My Development Machine"
            autoFocus
          />
        </label>
        <label className="field">
          <span>SSH Target</span>
          <input
            value={sshTarget}
            onChange={(e) => {
              setSshTarget(e.target.value);
              setSelectedHost("");
            }}
            placeholder="user@host"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Workspace Path (Optional)</span>
            <input
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
              placeholder="/home/you/your-repo"
            />
          </label>
          <label className="field">
            <span>SSH Port</span>
            <input value={sshPort} onChange={(e) => setSshPort(e.target.value)} inputMode="numeric" />
          </label>
        </div>
        {!portValid && <p className="form-error" role="alert">Port must be an integer between 1 and 65535.</p>}
      </div>
    </Modal>
  );
}
