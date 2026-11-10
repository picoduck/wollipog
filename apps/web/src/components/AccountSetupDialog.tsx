import { useEffect, useState } from "react";
import { runnerSupportsProtocol, type IdentityAdministrationView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { ApiClient } from "../api.js";
import { canManageProviderProfiles } from "../provider-profile-access.js";
import { runnerDisplay } from "../runners.js";
import { useStore } from "../store.js";
import { Modal } from "./common.js";
import { MachineAgentsSection } from "./MachineAgentsSection.js";
import { ProviderAccountsSection } from "./ProviderAccountsSection.js";

/** Opens over the caller so its draft, location and installation stay mounted. */
export function AccountSetupDialog({ runnerId, onClose }: { runnerId: string; onClose: () => void }) {
  const api = useApi();
  const { runners, boxes } = useStore();
  const runner = runners.get(runnerId);
  const box = [...boxes.values()].find((value) => value.runnerId === runnerId);
  const [loaded, setLoaded] = useState<{ api: ApiClient; identity: IdentityAdministrationView | null } | null>(null);
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
  return (
    <Modal title="Account Setup" description={name} onClose={onClose} phoneSheet="full"
      footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <p className="section-note">Review this machine's installations and permitted sign-ins. Your draft stays open. Changing this machine's account policy also updates drafts that use that policy.</p>
      {runner ? <>
        {!online && <p className="section-note">This machine is offline. Installation and account details are last reported; reconnect before starting setup.</p>}
        {!runnerSupportsProtocol(runner.protocolVersion, "providerLogin") && <p className="section-note">Update this machine's runner to set up accounts here. Its existing sign-in status may be unknown.</p>}
        <MachineAgentsSection runner={runner} online={online} machineName={name} canFindSessions={false} />
        <ProviderAccountsSection runner={runner} online={online} machineName={name}
          canManageProfiles={canManageProviderProfiles(identity?.context)} profileAccessKnown={identitySettled} showMachineSettings={false} />
      </> : <p>This machine is no longer available. Return to your draft to choose another machine.</p>}
    </Modal>
  );
}
