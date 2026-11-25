import { canonicalReleasePayload } from "./release-payload.mjs";

export type ReleaseDecisionCategory = "release_tag" | "release_publish";

export function isReleaseDecisionCategory(category: unknown): category is ReleaseDecisionCategory {
  return category === "release_tag" || category === "release_publish";
}

interface ReleaseTarget {
  repository: string;
  tag: string;
  commitSha: string;
  releasePayloadDigest: string;
}

export interface ReleaseTagDecisionSnapshot extends ReleaseTarget {
  category: "release_tag";
}

export interface ReleaseAssetIdentity {
  id: number;
  name: string;
  size: number;
  digest: string;
}

export interface ReleasePublishPayload {
  name: string;
  body: string;
  draft: { name: string | null; body: string | null; targetCommitish: string };
  assets: ReleaseAssetIdentity[];
  previousStable: { id: number; tag: string } | null;
  /** When present, publication also requires this exact successful workflow attempt. */
  workflow?: { runId: number; attempt: number };
}

export interface ReleasePublishDecisionSnapshot extends ReleaseTarget {
  category: "release_publish";
  releaseId: number;
  releasePayload: ReleasePublishPayload;
}

export type ReleaseDecisionSnapshot = ReleaseTagDecisionSnapshot | ReleasePublishDecisionSnapshot;
export type ReleaseForgeAction = (Omit<ReleaseTagDecisionSnapshot, "category"> & { kind: "release_tag" })
  | (Omit<ReleasePublishDecisionSnapshot, "category"> & { kind: "release_publish" });

const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const STABLE_TAG = /^v(?:0|[1-9][0-9]{0,11})\.(?:0|[1-9][0-9]{0,11})\.(?:0|[1-9][0-9]{0,11})$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
export const RELEASE_DECISION_MAX_ASSETS = 128;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value);
const tagName = (value: unknown): value is string => typeof value === "string" && STABLE_TAG.test(value);

export function normalizeReleaseAssets(value: unknown): ReleaseAssetIdentity[] | null {
  if (!Array.isArray(value) || value.length > RELEASE_DECISION_MAX_ASSETS) return null;
  const assets: ReleaseAssetIdentity[] = [];
  const names = new Set<string>();
  const ids = new Set<number>();
  for (const entry of value) {
    const asset = object(entry);
    if (!asset || !positive(asset.id) || !text(asset.name, 255) || !asset.name || !positive(asset.size) ||
        typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest) ||
        names.has(asset.name) || ids.has(asset.id)) return null;
    assets.push({ id: asset.id, name: asset.name, size: asset.size, digest: asset.digest });
    names.add(asset.name);
    ids.add(asset.id);
  }
  return assets.sort((a, b) => a.id - b.id);
}

export function releaseTagPayload({ tag, commitSha }: ReleaseTarget) {
  return { ref: `refs/tags/${tag}`, sha: commitSha };
}

export function releasePublishMutation({ tag, commitSha, releasePayload }: ReleasePublishDecisionSnapshot) {
  return { tag_name: tag, target_commitish: commitSha, name: releasePayload.name, body: releasePayload.body,
    draft: false, prerelease: false, make_latest: "true" };
}

/** The draft preconditions are part of the approved bytes, along with the fixed mutation. */
export function releaseDecisionPayloadBytes(target: ReleaseDecisionSnapshot): string {
  return target.category === "release_tag" ? canonicalReleasePayload(releaseTagPayload(target))
    : canonicalReleasePayload({ mutation: releasePublishMutation(target), draft: target.releasePayload.draft,
      assets: target.releasePayload.assets, previousStable: target.releasePayload.previousStable,
      ...(target.releasePayload.workflow ? { workflow: target.releasePayload.workflow } : {}) });
}

export function releaseDecisionResourceKey(target: ReleaseDecisionSnapshot): string {
  return `${target.category}:${target.repository.toLowerCase()}:${target.tag}`;
}

export function releaseDecisionSubject(target: ReleaseDecisionSnapshot): string {
  return `${target.repository} · ${target.tag}`;
}

export function normalizeReleaseDecision(value: Record<string, unknown>): ReleaseDecisionSnapshot | null {
  const { category, repository, tag, commitSha, releasePayloadDigest, releaseId } = value;
  if (!isReleaseDecisionCategory(category) || typeof repository !== "string" || !REPOSITORY.test(repository) ||
      /\/(?:\.|\.\.)$/u.test(repository) || !tagName(tag) || typeof commitSha !== "string" || !SHA.test(commitSha) ||
      typeof releasePayloadDigest !== "string" || !DIGEST.test(releasePayloadDigest)) return null;
  const base = { repository: repository.toLowerCase(), tag, commitSha, releasePayloadDigest };
  const allowed = ["category", "repository", "tag", "commitSha", "releasePayloadDigest"];
  if (category === "release_tag") {
    return Object.keys(value).every((key) => allowed.includes(key)) ? { category, ...base } : null;
  }
  if (!positive(releaseId) || Object.keys(value).some((key) => ![...allowed, "releaseId", "releasePayload"].includes(key))) return null;
  const payload = object(value.releasePayload);
  const draft = object(payload?.draft);
  const stable = object(payload?.previousStable);
  const workflow = object(payload?.workflow);
  const assets = normalizeReleaseAssets(payload?.assets);
  if (!payload || !text(payload.name, 256) || !payload.name.trim() || !text(payload.body, 32_768) ||
      !draft || (draft.name !== null && !text(draft.name, 256)) || (draft.body !== null && !text(draft.body, 32_768)) ||
      !text(draft.targetCommitish, 255) || !draft.targetCommitish || !assets ||
      (payload.previousStable !== null && (!stable || !positive(stable.id) || !tagName(stable.tag) || stable.id === releaseId)) ||
      (payload.workflow !== undefined && (!workflow || !positive(workflow.runId) || !positive(workflow.attempt)))) return null;
  const releasePayload: ReleasePublishPayload = {
    name: payload.name, body: payload.body,
    draft: { name: draft.name, body: draft.body, targetCommitish: draft.targetCommitish },
    assets,
    previousStable: stable ? { id: stable.id as number, tag: stable.tag as string } : null,
    ...(workflow ? { workflow: { runId: workflow.runId as number, attempt: workflow.attempt as number } } : {}),
  };
  // Reject unrecognized preconditions rather than acknowledging a digest for an ignored field.
  if (canonicalReleasePayload({ ...payload, assets: [...(payload.assets as ReleaseAssetIdentity[])].sort((a, b) => a.id - b.id) }) !==
      canonicalReleasePayload(releasePayload)) return null;
  return { category, ...base, releaseId, releasePayload };
}
