import { useRemoteAccess } from "../remote-access-context.js";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { IdentityAdministrationView, RemoteAccessView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { ApiError } from "../api.js";
import { CopyButton, Modal } from "./common.js";
import { Notice } from "./Notice.js";
import { ActionRow, SettingsGroup, ValueRow } from "./ui/SettingsRows.js";

const PairDeviceDialog = lazy(() => import("./PeopleDevicesPanel.js").then((module) => ({ default: module.PairDeviceDialog })));

export function RemoteAccessPanel() {
  const api = useApi();
  const shared = useRemoteAccess();
  const currentApi = useRef(api);
  currentApi.current = api;
  const [status, setStatus] = useState<RemoteAccessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [identity, setIdentity] = useState<IdentityAdministrationView | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setStatus(null); setError(null); setLoading(true); setOpen(false); setIdentity(null);
    if (!api.remoteAccess) { setLoading(false); return; }
    let current = true;
    void api.remoteAccess().then((next) => { if (current) setStatus(next); }).catch((cause: unknown) => {
      if (current && !(cause instanceof ApiError && (cause.status === 404 || cause.status === 403 || cause.status === 401))) {
        setError("Remote access could not be checked. Try again when this server is connected.");
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; alive.current = false; };
  }, [api]);
  const pair = async () => {
    setError(null);
    try {
      const next = await api.getIdentity();
      if (alive.current && currentApi.current === api) { setOpen(false); setIdentity(next); }
    } catch { if (alive.current && currentApi.current === api) setError("Pairing could not be opened. Retry from this computer's local dashboard."); }
  };
  if (loading || (!status && !error)) return null;
  return <>
    <SettingsGroup title="Remote Access" scope="This Server" notice={error ? <Notice tone="warning">{error}</Notice> : undefined}
      foot={!status?.canConfigure ? "An administrator sets this up in Wollipog on the computer running the server, or with its host administration CLI." : undefined}>
      {status?.origin && <ValueRow title="Secure Address" description={status.message} value={status.origin} mono wrap copy={status.origin} copyLabel="Copy Secure Address" />}
      {status?.canConfigure && <ActionRow title="Secure Dashboard" description={status.origin ? "Check or change how your other devices connect." : status.message}
        actionLabel={status.phase === "ready" ? "Manage Remote Access…" : "Set Up Remote Access…"} hasPopup="dialog" onAction={() => setOpen(true)} />}
      {!status?.canConfigure && !status?.origin && <p className="muted">{status?.message ?? error}</p>}
      {status?.phase === "ready" && status.canConfigure && <ActionRow title="Connect Another Device" description="Open a pairing link or scan its QR code on your phone."
        actionLabel="Pair a Device…" hasPopup="dialog" onAction={() => void pair()} />}
    </SettingsGroup>
    {open && status && <RemoteAccessSetupDialog initial={status} onChange={(next) => { setStatus(next); shared?.update(next); }} onClose={() => setOpen(false)} onPair={() => void pair()} />}
    {identity && <Suspense fallback={null}><PairDeviceDialog identity={identity} onClose={() => setIdentity(null)} onSaved={async () => {}} /></Suspense>}
  </>;
}

export function RemoteAccessSetupDialog({ initial, onChange, onClose, onPair }: {
  initial: RemoteAccessView; onChange: (status: RemoteAccessView) => void; onClose: () => void; onPair: () => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState(initial);
  const [provider, setProvider] = useState<"tailscale" | "https">(initial.provider ?? "tailscale");
  const [origin, setOrigin] = useState(initial.origin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remove, setRemove] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const apply = (next: RemoteAccessView) => { setStatus(next); onChange(next); };
  const run = async (action: "setup" | "disable") => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = action === "disable" ? await api.disableRemoteAccess() : await api.setupRemoteAccess(
        provider === "tailscale" ? { provider } : { provider, origin },
      );
      if (alive.current) { apply(next); setRemove(false); }
    } catch { if (alive.current) setError("Setup could not finish. Check that this server is connected and try again."); }
    finally { if (alive.current) setBusy(false); }
  };
  const close = async () => {
    if (busy || status.canDisable && status.phase !== "ready" || status.phase === "needs_repair") {
      setBusy(true);
      try { apply(await api.cancelRemoteAccess()); }
      catch { setError("Setup could not be cancelled. Retry before closing."); setBusy(false); return; }
    }
    onClose();
  };
  return <Modal title="Set Up Remote Access" description="Connect your phone or another computer through a secure address."
    onClose={() => void close()} footer={<>
      <button type="button" className="btn" onClick={() => void close()}>{status.phase === "ready" ? "Done" : "Cancel Setup"}</button>
      {status.phase === "ready" && !remove
        ? <button type="button" className="btn primary" onClick={onPair}>Pair a Device</button>
        : <button type="button" className="btn primary" disabled={busy || (provider === "https" && !origin.trim())} onClick={() => void run(remove ? "disable" : "setup")}>
          {busy ? "Checking Connection…" : remove ? "Turn Off Remote Access" : status.phase === "not_configured" ? "Set Up Remote Access" : "Retry Setup"}
        </button>}
    </>}>
    <div className="remote-access-form">
      {status.phase === "ready" && status.origin ? <Notice tone="success" title="Secure Dashboard Ready" actions={<>
        <a className="btn sm" href={status.origin} target="_blank" rel="noopener noreferrer">Open Dashboard</a>
        <CopyButton text={status.origin} label="Copy Address" className="btn sm" />
      </>}><p className="remote-access-address">{status.origin}</p><p>Pair your device, then use this address whenever you connect.</p></Notice> : null}
      {status.phase !== "ready" && <>
        <label className="field"><span>Connection Method</span><select aria-label="Connection Method" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as "tailscale" | "https"); setError(null); }}>
          <option value="tailscale">Tailscale</option><option value="https">Use an Existing HTTPS Address</option>
        </select><small>Tailscale keeps access within your private network. Your other device also needs Tailscale connected.</small></label>
        {provider === "https" && <label className="field"><span>HTTPS Address</span><input aria-label="HTTPS Address" type="url" value={origin} disabled={busy} placeholder="https://wollipog.example.com"
          onChange={(event) => setOrigin(event.target.value)} /><small>Use the address your HTTPS proxy provides, including its external port if needed.</small></label>}
      </>}
      {status.phase !== "not_configured" && status.phase !== "ready" && <Notice tone="warning" title={status.phase === "needs_authorization" ? "Authorize HTTPS" : "Connection Needs Attention"}
        actions={status.authorizationUrl ? <a className="btn sm" href={status.authorizationUrl} target="_blank" rel="noopener noreferrer">Authorize HTTPS</a> : undefined}>{status.message}</Notice>}
      {busy && <p role="status">Checking HTTPS, this server's identity, the dashboard, and the live connection…</p>}
      {error && <Notice tone="danger" role="alert">{error}</Notice>}
      <div className="remote-access-actions">
      {!busy && status.phase === "ready" && !remove && <button type="button" className="btn" onClick={() => setStatus({ ...status, phase: "not_configured" })}>Change Connection…</button>}
      {!busy && status.canDisable && !remove && <button type="button" className="btn ghost" onClick={() => setRemove(true)}>Turn Off Remote Access…</button>}
      </div>
      {remove && <Notice tone="warning" title="Turn Off Remote Access?" actions={<button type="button" className="btn sm" disabled={busy} onClick={() => setRemove(false)}>Keep Remote Access</button>}>
        Your other devices may disconnect. Wollipog removes only the Tailscale listener it created; an existing proxy stays configured.
      </Notice>}
      <details><summary>Connection Details</summary><p>The secure address uses its certificate's hostname and HTTPS port. Adding https:// to an IP address and the backend port can fail before Wollipog opens. Setup supplies the complete address for you.</p></details>
    </div>
  </Modal>;
}
