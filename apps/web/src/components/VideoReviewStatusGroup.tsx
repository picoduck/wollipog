import { useEffect, useState } from "react";
import type { VideoReviewerMachineStatus, VideoReviewSettingsStatus } from "@wollipog/protocol";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import type { StatusTone } from "../status-meta.js";
import { ChevronRightIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";
import { SettingRow, SettingsGroup } from "./ui/SettingsRows.js";

type Load =
  | { kind: "loading" }
  | { kind: "loaded"; status: VideoReviewSettingsStatus }
  | { kind: "administrators_only" }
  | { kind: "unsupported" }
  | { kind: "failed" };

/** Readiness in dashboard copy; the server's sentences name its own internals. */
const UNAVAILABLE: Record<string, string> = {
  no_paced_video_peer: "No machine advertises the media-only video reviewer yet, so video evidence stays with you.",
  live_validation: "No current live proof certifies a media-only reviewer, so video evidence stays with you.",
  reviewer_unavailable: "Wollipog's video review service isn't attached yet, so video evidence stays with you.",
};

const date = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));

/** The badge and sentence for one machine: its installation gap, or its live proof state. */
function machineState(machine: VideoReviewerMachineStatus): { label: string; tone: StatusTone; sentence: string } {
  if (machine.gap || !machine.proof) return { label: "Unavailable", tone: "neutral", sentence: machine.gap?.reason ?? "" };
  const proof = machine.proof;
  switch (proof.state) {
    case "certified": return { label: "Certified", tone: "success", sentence: `Certified on ${date(proof.validatedAt)} until ${date(proof.expiresAt)}.` };
    case "expired": return { label: "Expired", tone: "warning", sentence: `The live proof expired on ${date(proof.expiresAt)}. Record a new certification to delegate video review.` };
    case "revoked": return { label: "Revoked", tone: "danger", sentence: "The live proof was revoked. Record a new certification to delegate video review." };
    case "missing": return { label: "Not Certified", tone: "neutral", sentence: "No live proof certifies this reviewer's current attestation yet." };
  }
}

/**
 * Delegated video evidence review (#1321): whether it can run, each machine's certification and why
 * it is unavailable. Read-only. Certification is recorded by the Human through its own ingress.
 */
export function VideoReviewStatusGroup() {
  const api = useApi();
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    api.videoReviewStatus().then((status) => {
      if (!current) return;
      // A server that answers the path with something else predates the route: show nothing.
      const valid = status && typeof status.readiness === "object" && status.readiness !== null && Array.isArray(status.machines);
      setLoad(valid ? { kind: "loaded", status } : { kind: "unsupported" });
    }, (caught: unknown) => {
      if (!current) return;
      const status = caught instanceof ApiError ? caught.status : 0;
      setLoad({ kind: status === 403 ? "administrators_only" : status === 404 ? "unsupported" : "failed" });
    });
    return () => { current = false; };
  }, [api]);

  if (load.kind === "loading" || load.kind === "unsupported") return null;
  const intro = load.kind === "administrators_only"
    ? "Only an owner or admin of the personal organization can see video review certification."
    : load.kind === "failed"
    ? "Video review certification couldn't be loaded."
    : load.status.readiness.available
    ? "The Orchestrator can delegate video evidence to a certified media-only reviewer."
    : UNAVAILABLE[load.status.readiness.code] ?? load.status.readiness.reason;
  const status = load.kind === "loaded" ? load.status : null;

  return <SettingsGroup
    title="Video Evidence Review"
    intro={intro}
    foot={status && <details className="disclosure orchestrator-about">
      <summary><ChevronRightIcon className="disclosure-chevron" />About Video Evidence Review</summary>
      <div className="disclosure-body">
        <p>
          Video is reviewed by a separate Claude Code reviewer on {status.reviewer.model} at {status.reviewer.effort} effort
          that can see only the recording&apos;s frames. Its machine must hold a live proof that you recorded after inspecting three
          metered validation runs. A proof certifies one exact reviewer attestation and expires after 30 days.
        </p>
        <p>
          The Orchestrator and its children must also run on attested Claude Code agents, and the campaign&apos;s evidence envelope
          must name {status.reviewer.model}, so a different harness or model keeps video with you. Frames go only to
          the Claude Code provider named in that envelope.
        </p>
        <p>
          Only {status.mediaTypes.map((type) => type === "video/mp4" ? "MP4" : "WebM").join(" and ")} recordings attached as
          private Session artifacts can be delegated. Other formats and externally stored evidence stay with you.
        </p>
      </div>
    </details>}
  >
    {status?.machines.map((machine, index, machines) => {
      const state = machineState(machine);
      // A machine with several Claude Code agents names the agent each row describes.
      const shared = machines.some((other, otherIndex) => otherIndex !== index && other.runnerId === machine.runnerId);
      return <SettingRow
        key={`${machine.runnerId}:${machine.agentId ?? ""}`}
        title={shared && machine.agentId ? `${machine.machineName} (${machine.agentId})` : machine.machineName}
        badge={<StatusBadge tone={state.tone} label={state.label} />}
        description={state.sentence}
      />;
    })}
  </SettingsGroup>;
}
