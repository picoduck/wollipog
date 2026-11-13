import { CampaignSection, useCampaignEntries } from "./CampaignSections.js";
import React, { useState } from "react";
import type { CampaignPendingCause, CampaignRepositoryBoundaryView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { projectAvailabilityMeta } from "../project-management.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

const REMOVED = { label: "Removed", tone: "danger" as const };

/** Why one Location waits (#4312), told as what is on record. An entry stored before #4312 has no
 * cause, and its row says nothing about who added it. */
const PENDING_CAUSE: Record<CampaignPendingCause, string> = {
  added_by_other: "Someone other than the campaign's owner added this Location to the Project.",
  no_recorded_adder: "No one is recorded as having added this Location to the Project.",
  owner_added: "The campaign's owner added this Location, and it hasn't joined on its own.",
  repository_added: "The campaign's owner approved adding another Location of its repository, and this one wasn't part of that approval.",
};

/**
 * A campaign's repository boundary (#4117): every repository it covers with that repository's
 * Locations, the Locations left out and why, the Locations that wait for the owner and why, and
 * the Locations that joined after launch. Only the campaign's own session offers
 * Include in Campaign; the server checks that the person is its owner.
 */
export function CampaignRepositories({ campaignId, boundary, canInclude }: {
  campaignId: string;
  boundary: CampaignRepositoryBoundaryView;
  canInclude: boolean;
}) {
  const api = useApi();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entries = useCampaignEntries(boundary.repositories);
  const joinedAt = new Map(boundary.joins.map((join) => [join.locationId, join.revision]));
  const limitedBecause = new Map((boundary.limitedLocations ?? []).map((location) => [location.locationId, location.reason]));
  const include = async (locationId: string) => {
    if (busy) return;
    setBusy(locationId); setError(null);
    try {
      await api.includeCampaignLocation(campaignId, locationId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not include the Location.");
    } finally {
      setBusy(null);
    }
  };

  return <CampaignSection title="Repositories" count={boundary.repositories.length} attention={boundary.pendingLocations.map(item => item.locationId).join("|")} className="campaign-detail-section">
    <dl className="facts">
      {entries.visible.map((entry) => {
        const usable = entry.locations.some((location) => location.availability === "available");
        return <div key={entry.repository}>
          <dt>{entry.repository}</dt>
          <dd>
            {entry.locations.length === 0 ? "No Locations" : <ul className="campaign-detail-list" aria-label={`Locations of ${entry.repository}`}>
              {entry.locations.map((location) => <li key={location.locationId}>
                {location.name}
                {location.isDefault && <> <span className="project-location-default">Default</span></>}{" "}
                <StatusBadge meta={location.availability === "removed" ? REMOVED : projectAvailabilityMeta(location.availability)} />
                {joinedAt.has(location.locationId) && <span className="campaign-status-meta">{joinedAt.get(location.locationId)
                  ? `Joined at boundary revision ${joinedAt.get(location.locationId)}.` : "Joined after launch."}</span>}
                {limitedBecause.has(location.locationId) && <span className="campaign-status-meta">{limitedBecause.get(location.locationId)}</span>}
              </li>)}
            </ul>}
            {!usable && <span className="campaign-status-meta">No Location of this repository is available, so it can't take new work until one is.</span>}
          </dd>
        </div>;
      })}
      {/* A Custom campaign's list has no authority boundary, so it has no revision to show. */}
      {boundary.revision > 0 && <div>
        <dt>Boundary Revision</dt>
        <dd>{boundary.revision}</dd>
      </div>}
    </dl>{entries.more}
    {boundary.excludedLocations.length > 0 && <>
      <h4 className="section-title">Excluded Locations</h4>
      <ul className="campaign-detail-list" aria-label="Excluded Locations">
        {boundary.excludedLocations.map((location) => <li key={location.locationId}>
          {location.name}
          {location.repository && <span className="campaign-status-meta">{location.repository}</span>}
          <span className="campaign-status-meta">{location.reason}</span>
        </li>)}
      </ul>
    </>}
    {boundary.pendingLocations.length > 0 && <>
      <h4 className="section-title">Waiting to Be Included</h4>
      <p className="section-note">These Locations join this campaign only when its owner includes them.</p>
      <ul className="campaign-detail-list" aria-label="Locations Waiting to Be Included">
        {boundary.pendingLocations.map((location) => <li key={location.locationId}>
          {location.name}
          {canInclude && <> <BusyButton type="button" className="btn sm" busy={busy === location.locationId} progress="Inspecting the Location…"
            disabled={busy !== null && busy !== location.locationId}
            aria-label={`Include ${location.name} in Campaign`} onClick={() => void include(location.locationId)}>
            Include in Campaign
          </BusyButton></>}
          {location.cause && <span className="campaign-status-meta">{PENDING_CAUSE[location.cause]}</span>}
        </li>)}
      </ul>
    </>}
    {(boundary.availableLocations?.length ?? 0) > 0 && <>
      <h4 className="section-title">Available but Not in This Campaign</h4>
      <p className="section-note">
        Your first message limited this campaign to {boundary.repositoryLimits?.join(", ") ?? "some of its repositories"}. These
        Locations are in the Project, but they join only if the Orchestrator asks to add their repository and you approve it.
      </p>
      <ul className="campaign-detail-list" aria-label="Locations Available but Not in This Campaign">
        {boundary.availableLocations!.map((location) => <li key={location.locationId}>
          {location.name}
          <span className="campaign-status-meta">{location.repository}</span>
        </li>)}
      </ul>
    </>}
    {error && <Notice tone="danger" role="alert" title="Couldn't Include the Location">{error}</Notice>}
  </CampaignSection>;
}
