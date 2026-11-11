import React from "react";
import type { ProviderLoginStartFailure as Failure } from "../provider-login-start-failure.js";

export function ProviderLoginStartFailure({ failure }: { failure: Failure }) {
  return <>
    <p>{failure.message}</p>
    {failure.detail && <p>{failure.detail}</p>}
    {failure.guidance && <p>{failure.guidance}</p>}
    {failure.inspectCommand && <details>
      <summary>Local Linux Inspection</summary>
      <p>On the affected Linux Machine, open a terminal as the OS user running the runner and use its installed Wollipog CLI. Preserve account data and avoid broad home-directory permission changes.</p>
      <p><code>{failure.inspectCommand}</code></p>
      {failure.repairCommand && <>
        <p>If inspection reports a repairable write-permission problem, the operator can run the following command in an interactive terminal and review its confirmation. Other problems require operator guidance.</p>
        <p><code>{failure.repairCommand}</code></p>
      </>}
    </details>}
  </>;
}
