import { useEffect, useRef, useState } from "react";
import { runnerSupportsProtocol, type IdentityAdministrationView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { canManageProviderProfiles } from "../provider-profile-access.js";
import { runnerDisplay } from "../runners.js";
import { useStore } from "../store.js";
import { Modal } from "./common.js";
import { MachineAgentsSection } from "./MachineAgentsSection.js";
import { ProviderAccountsSection } from "./ProviderAccountsSection.js";
import { BusyButton } from "./ui/BusyButton.js";
import { Notice } from "./Notice.js";

/** Opens over the caller so its draft, location and installation stay mounted. */
export function AccountSetupDialog({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const api = useApi();
  const { runners, boxes } = useStore();
  const runner = runners.get(runnerId);
  const box = [...boxes.values()].find((value) => value.runnerId === runnerId);
  const [loaded, setLoaded] = useState<{ api: ApiClient; identity: IdentityAdministrationView | null } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [refreshResult, setRefreshResult] = useState<{ failed: boolean; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    void api.getIdentity().then((identity) => { if (live) setLoaded({ api, identity }); })
      .catch(() => { if (live) setLoaded({ api, identity: null }); });
    return () => { live = false; };
  }, [api]);
  const identity = loaded?.api === api ? loaded.identity : null;
  const identitySettled = loaded?.api === api;
  const name = runnerDisplay(runner, box, runnerId).name;
  const online = runner?.status === "online" && (!box || box.status === "online");
  const rediscover = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshResult(null);
    try {
      await api.rediscover(runnerId);
      setRefreshResult({ failed: false, message: "Rediscovery requested. Agent and account details update when the runner reports." });
    } catch (error) {
      setRefreshResult({ failed: true, message: error instanceof Error ? error.message : String(error) });
    } finally { refreshingRef.current = false; setRefreshing(false); }
  };
  return (
    <Modal title="Account Setup" description={name} onClose={onClose} phoneSheet="full"
      tertiary={runner?.canManage === true ? <BusyButton className="btn ghost" busy={refreshing} progress="Requesting rediscovery…" disabled={!online} onClick={() => void rediscover()}>Rediscover Agents</BusyButton> : undefined}
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <p className="section-note">Review this machine's installations and permitted sign-ins. Your draft stays open. Changing this machine's account policy also updates drafts that use that policy.</p>
      {refreshResult && <Notice compact tone={refreshResult.failed ? "danger" : "neutral"} role={refreshResult.failed ? "alert" : "status"}
        title={refreshResult.failed ? "Couldn't Request Rediscovery" : "Rediscovery Requested"}>{refreshResult.message}</Notice>}
      {runner ? <>
        {!online && <p className="section-note">This machine is offline. Installation and account details are last reported; reconnect before starting setup.</p>}
        {!runnerSupportsProtocol(runner.protocolVersion, "providerLogin") && <p className="section-note">Update this machine's runner to set up accounts here. Its existing sign-in status may be unknown.</p>}
        {!runnerSupportsProtocol(runner.protocolVersion, "providerSetupReadiness") && <p className="section-note">This runner does not report separate installation, account-use, or last-check facts. Update it for those details; unknown status does not mean signed out.</p>}
        <MachineAgentsSection runner={runner} online={online} machineName={name} canFindSessions={false} />
        <ProviderAccountsSection runner={runner} online={online} machineName={name}
          canManageProfiles={canManageProviderProfiles(identity?.context)} profileAccessKnown={identitySettled} showMachineSettings={false} />
      </> : <p>This machine is no longer available. Return to your draft to choose another machine.</p>}
    </Modal>
  );
}
