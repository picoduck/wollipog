import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OPERATOR_VIDEO_VALIDATION_PROFILES, type OperatorVideoValidationProfile } from "./operator-video-validation.js";
import type { PreparedMediaIdentity } from "./prepared-media-sessions.js";
import type { TemporalVideoManifest, VideoReviewCriterion } from "./video-evidence-runtime.js";

/** Human video validation runs (#1321): the pieces of the Human-only certification path that need no
 * Session or runner state. The coordinator lives in `delegated-video-reviews.ts`. */
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Server-pinned blind challenge criteria. They ask for every transient without hinting how many,
 * where or when; the Human compares the answer with the private oracle only after the run. */
export const VIDEO_VALIDATION_CRITERIA: readonly VideoReviewCriterion[] = Object.freeze([
  { criterionId: "every_frame_in_order", description: "Every source frame was reviewed in presentation order, with none skipped." },
  { criterionId: "transient_overlays", description: "Report every coloured rectangle that appears in exactly one frame: its colour, " +
    "its position and size in pixels, its frame index and its exact source presentation time. Report none if there are none." },
]);
export const videoValidationPrompt = (criteria: readonly VideoReviewCriterion[]) => [
  "Review a silent synthetic test recording for a Human validation run. Judge it against each pinned criterion:",
  ...criteria.map((c) => `- ${c.criterionId}: ${c.description}`),
  "Report exactly what you observe. A Human compares your answer with a private record afterward; your verdict approves nothing.",
].join("\n");

/** The one admission identity a validation run of this exact original gate, evidence and profile can
 * have. It is fixed before any reviewer exists, so a Human permit can pin it. */
export function videoValidationIdentity(gate: { rootSessionId: string; childSessionId: string; occurrenceId: string;
  resourceDigest: string }, evidenceId: string, profile: OperatorVideoValidationProfile): PreparedMediaIdentity {
  return { rootSessionId: gate.rootSessionId, childSessionId: gate.childSessionId,
    admissionId: `video_validation_${sha(`${gate.occurrenceId}\0${evidenceId}\0${profile}`).slice(0, 32)}`,
    requestSha256: sha({ purpose: "operator_video_validation", occurrenceId: gate.occurrenceId, evidenceId,
      resourceDigest: gate.resourceDigest, profile }) };
}

/** The reviewer's launch identity, known before its Session exists: its reviewed namespace policy and
 * the run's one admission. The runner reports its actual launch separately. */
export const videoValidationLaunchSha256 = (namespacePolicySha256: string, admissionId: string) =>
  sha({ purpose: "operator_video_validation", namespacePolicySha256, admissionId });

/** What the server's own isolated decoder derived from one source under one profile: exactly the
 * manifest a validation review of those bytes pins. */
export interface VideoValidationDerivation {
  sourceSha256: string;
  profile: OperatorVideoValidationProfile;
  manifestSha256: string;
  orderedFramesSha256: string;
  frames: number;
  width: number;
  height: number;
  durationUs: number;
}

/** Derivation cache for the synchronous permit scope port. Rows are written only from the server's
 * decoder output and checked against the profile; a request body never writes one. */
export class VideoValidationDerivations {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS video_validation_derivations (source_sha256 TEXT NOT NULL, profile TEXT NOT NULL," +
      "record TEXT NOT NULL, PRIMARY KEY(source_sha256, profile));");
  }
  get(sourceSha256: string, profile: OperatorVideoValidationProfile): VideoValidationDerivation | null {
    const row = this.db.prepare("SELECT record FROM video_validation_derivations WHERE source_sha256=? AND profile=?")
      .get(sourceSha256, profile) as { record: string } | undefined;
    if (!row) return null;
    const derived = JSON.parse(row.record) as VideoValidationDerivation;
    return derived.sourceSha256 === sourceSha256 && derived.profile === profile ? derived : null;
  }
  /** Records the derivation when it matches the profile's exact envelope; returns it, or null. */
  save(sourceSha256: string, profile: OperatorVideoValidationProfile, manifest: TemporalVideoManifest,
    manifestSha256: string): VideoValidationDerivation | null {
    const expected = OPERATOR_VIDEO_VALIDATION_PROFILES[profile];
    const last = manifest.frames.at(-1);
    const derived: VideoValidationDerivation = { sourceSha256, profile, manifestSha256, orderedFramesSha256: sha(manifest.frames),
      frames: manifest.frames.length, width: manifest.width, height: manifest.height,
      durationUs: last ? last.ptsUs + last.durationUs : 0 };
    if (!digest(sourceSha256) || manifest.sourceSha256 !== sourceSha256 || !digest(manifestSha256) ||
      derived.frames !== expected.frames || derived.width !== expected.width || derived.height !== expected.height ||
      derived.durationUs !== expected.durationUs) return null;
    this.db.prepare("INSERT OR REPLACE INTO video_validation_derivations VALUES (?,?,?)").run(sourceSha256, profile, JSON.stringify(derived));
    return derived;
  }
}

/** The fields a Human adjudicates from evidence outside Wollipog. The inspection view leaves them
 * null; the Human fills them before recording, and the ingress validates every one. */
export const HUMAN_INSPECTED_RUN_FIELDS = Object.freeze(["usageEvidenceSha256", "pricingEvidenceSha256",
  "oracleIsolationEvidenceSha256", "actualInputTokens", "actualOutputTokens", "allSourceFramesDelivered", "blindOracleMatched",
  "privateOracleExcludedFromReviewerContext", "oracleNamespaceInaccessibleVerified", "providerUsageVerified",
  "currentOfficialPricingVerified", "sourceAndArtifactsStillMatch"] as const);
