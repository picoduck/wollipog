# Campaign Pause and Resume

The campaign owner can choose **Pause Campaign** in Campaign Status, with an optional local
date and time. An empty time waits for **Resume Campaign**. Only the owning human can use the
pause endpoint; Full Control and agent credentials cannot resume a campaign. The chosen time
authorizes only the scheduled resume, restoring existing authority and budgets unchanged.

An Orchestrator asking on the owner's behalf uses the existing typed Owner Question
(`request_owner_decision`, `kind: "question"`) and directs the owner to Campaign Status. An
answer is not an action approval and does not itself pause or resume anything. Never improvise
suspension with ledger handoffs or verify preserved children as delivered.

Pause is durable across control-plane restarts. It holds campaign continuations, durable prompt
delivery, new children, restarts, verification and archival. The status is **Paused**, including
while protected work drains; the In Flight row explains that distinction. The control plane does
not interrupt a running provider or its tools. At an idle boundary it requests the existing
durable Stop without revoking decisions. Pending requests, approved or armed decisions, queue
watches and background jobs retain their lifecycle. A queued merge is never dequeued. These
members remain in flight until their protected work settles; pause is not a promise that an
already running turn or merge instantly stops spending.

Resume waits for confirmed Stops, then uses normal restart admission (including budgets, account
availability, runner connectivity and child capacity). Failed admission retains the pause for
retry. Each restored child and the root receive a durable, deduplicated continuation warning that
main may have moved. Suspended work is never verification or delivery evidence. Older dashboards
receive Campaign Stuck (or the older Blocked fallback), with the pause recorded in the timeline.

Operational evidence: the timeline records each pause/resume with its actor and time; structured
`campaign_paused` and `campaign_resumed` events correlate by campaign ID and pause timestamp.
Campaign Status shows the latest pause and resume, selected time, and in-flight member count.

An ordinary Stop, a guardrail Stop or an unrelated provider end retains the ordinary decision
revocation and cleanup rules. Only the Stop issued to preserve an idle pause member keeps its
queued notices for resume; a later ordinary Stop supersedes that preservation intent. Owner
resolutions during pause keep their notification owed, including on older runners. Other internal
notices queue durably without restarting the provider, while human/agent prompt admission remains
held. Shared viewers can inspect the pause, but receive no pause/resume controls unless their
principal-specific command permissions establish ownership.
