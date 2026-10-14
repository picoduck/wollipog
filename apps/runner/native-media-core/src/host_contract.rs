//! Pure offline host contract preparation, with no SDK, effect port, transport or runtime issuer.
//! Successful CODE admissions describe synthetic state only. They cannot authorize execution,
//! attest a namespace, issue evidence receipts, resolve a UI gate or settle capacity/cost/quality.
use crate::{BoundaryError, MediaCodeBindings, MediaCodeBoundary, RouteExclusionObservations};

#[derive(Clone, PartialEq, Eq)]
pub struct HostCodeBindings {
    pub media: MediaCodeBindings,
    pub occurrence_id: String,
    pub policy_revision: u64,
    pub owner_session_id: String,
    pub audience_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameCodeCoordinates {
    pub ordinal: usize,
    pub sha256: String,
    pub presentation_ms: u64,
    pub duration_ms: u64,
}

#[derive(Clone, PartialEq, Eq)]
pub struct FrameCodeManifest {
    pub source_sha256: String,
    pub coverage_manifest_sha256: String,
    pub criteria_sha256: String,
    pub source_duration_ms: u64,
    pub frames: Vec<FrameCodeCoordinates>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HostCodeError {
    Binding(BoundaryError),
    InvalidManifest,
    ClientRouteUnavailable,
    ResumeUnsupported,
    RuntimeAuthorityUnavailable,
    WrongFrame,
    IncompleteDelivery,
    WrongCriteria,
    VerdictAlreadyRecorded,
    InvalidOperation,
    ReplacementOperation,
    Fenced,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeQualityVerdict {
    AcceptSyntheticCriteria,
    RejectSyntheticCriteria,
}

#[derive(Debug, PartialEq, Eq)]
pub struct HostCodeSummary {
    delivered_frames: usize,
    quality_verdict: Option<CodeQualityVerdict>,
    stop_intent_prepared: bool,
    revoked: bool,
    runtime_authorized: bool,
}

impl HostCodeSummary {
    pub fn delivered_frames(&self) -> usize {
        self.delivered_frames
    }
    pub fn quality_verdict(&self) -> Option<CodeQualityVerdict> {
        self.quality_verdict
    }
    pub fn stop_intent_prepared(&self) -> bool {
        self.stop_intent_prepared
    }
    pub fn revoked(&self) -> bool {
        self.revoked
    }
    pub fn runtime_authorized(&self) -> bool {
        self.runtime_authorized
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CodeStopPreparation {
    PreparedUnknown,
    ExistingUnknown,
}

/// An untrusted claim, deliberately distinct from a runtime attestation. There is no issuer
/// registry, signature verifier, trusted constructor or test-only production grant in this crate.
pub struct ClaimedRuntimeMeasurements {
    pub issuer_id: String,
    pub binding: HostCodeBindings,
    pub routes: RouteExclusionObservations,
}

pub struct HostCodePreparation {
    binding: HostCodeBindings,
    manifest: FrameCodeManifest,
    delivered: usize,
    verdict: Option<CodeQualityVerdict>,
    stop_operation: Option<String>,
    revoked: bool,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl HostCodePreparation {
    pub fn new(
        binding: HostCodeBindings,
        manifest: FrameCodeManifest,
    ) -> Result<Self, HostCodeError> {
        MediaCodeBoundary::new(binding.media.clone()).map_err(HostCodeError::Binding)?;
        if !valid_id(&binding.occurrence_id)
            || binding.policy_revision == 0
            || binding.owner_session_id != binding.media.root_session_id
            || !valid_digest(&binding.audience_sha256)
        {
            return Err(HostCodeError::Binding(BoundaryError::InvalidBinding));
        }
        if ![
            &manifest.source_sha256,
            &manifest.coverage_manifest_sha256,
            &manifest.criteria_sha256,
        ]
        .iter()
        .all(|value| valid_digest(value))
            || manifest.frames.is_empty()
            || manifest.frames.len() > 900
        {
            return Err(HostCodeError::InvalidManifest);
        }
        let mut expected_time = 0;
        for (ordinal, frame) in manifest.frames.iter().enumerate() {
            if frame.ordinal != ordinal
                || frame.presentation_ms != expected_time
                || frame.duration_ms == 0
                || !valid_digest(&frame.sha256)
            {
                return Err(HostCodeError::InvalidManifest);
            }
            expected_time = frame
                .presentation_ms
                .checked_add(frame.duration_ms)
                .ok_or(HostCodeError::InvalidManifest)?;
        }
        if expected_time != manifest.source_duration_ms {
            return Err(HostCodeError::InvalidManifest);
        }
        Ok(Self {
            binding,
            manifest,
            delivered: 0,
            verdict: None,
            stop_operation: None,
            revoked: false,
        })
    }

    fn check_binding(&self, current: &HostCodeBindings) -> Result<(), HostCodeError> {
        if current != &self.binding {
            return Err(HostCodeError::Binding(BoundaryError::ReplacementBinding));
        }
        Ok(())
    }

    fn check_unfenced(&self, current: &HostCodeBindings) -> Result<(), HostCodeError> {
        self.check_binding(current)?;
        if self.revoked || self.stop_operation.is_some() {
            return Err(HostCodeError::Fenced);
        }
        Ok(())
    }

    /// Ordinary and unknown App Server routes are never passed through this source contract.
    pub fn reject_client_route(&self, _method: &str) -> Result<(), HostCodeError> {
        Err(HostCodeError::ClientRouteUnavailable)
    }

    /// Includes warm, cold, fork and reconnect-to-thread. No mode can restore ordinary context.
    pub fn reject_resume(&self, _mode: &str) -> Result<(), HostCodeError> {
        Err(HostCodeError::ResumeUnsupported)
    }

    pub fn require_runtime_authority(
        &self,
        _claim: Option<&ClaimedRuntimeMeasurements>,
    ) -> Result<(), HostCodeError> {
        // Even plausible complete-looking claims are untrusted. No CODE test can mint authority.
        Err(HostCodeError::RuntimeAuthorityUnavailable)
    }

    pub fn admit_synthetic_frame(
        &mut self,
        current: &HostCodeBindings,
        frame: &FrameCodeCoordinates,
    ) -> Result<(), HostCodeError> {
        self.check_unfenced(current)?;
        if self.manifest.frames.get(self.delivered) != Some(frame) {
            return Err(HostCodeError::WrongFrame);
        }
        self.delivered += 1;
        Ok(())
    }

    pub fn record_synthetic_verdict(
        &mut self,
        current: &HostCodeBindings,
        criteria_sha256: &str,
        verdict: CodeQualityVerdict,
    ) -> Result<(), HostCodeError> {
        self.check_unfenced(current)?;
        if criteria_sha256 != self.manifest.criteria_sha256 {
            return Err(HostCodeError::WrongCriteria);
        }
        if self.delivered != self.manifest.frames.len() {
            return Err(HostCodeError::IncompleteDelivery);
        }
        if self.verdict.is_some() {
            return Err(HostCodeError::VerdictAlreadyRecorded);
        }
        self.verdict = Some(verdict);
        Ok(())
    }

    /// State preparation only: no signal, dispatcher, PID, registered handle or settlement.
    pub fn prepare_synthetic_stop(
        &mut self,
        current: &HostCodeBindings,
        operation_id: &str,
    ) -> Result<CodeStopPreparation, HostCodeError> {
        self.check_binding(current)?;
        if !valid_id(operation_id) {
            return Err(HostCodeError::InvalidOperation);
        }
        if let Some(original) = &self.stop_operation {
            return if original == operation_id {
                Ok(CodeStopPreparation::ExistingUnknown)
            } else {
                Err(HostCodeError::ReplacementOperation)
            };
        }
        if self.revoked {
            return Err(HostCodeError::Fenced);
        }
        self.stop_operation = Some(operation_id.to_owned());
        Ok(CodeStopPreparation::PreparedUnknown)
    }

    pub fn revoke_code_preparation(
        &mut self,
        current: &HostCodeBindings,
    ) -> Result<(), HostCodeError> {
        self.check_binding(current)?;
        self.revoked = true;
        Ok(())
    }

    pub fn code_summary(
        &self,
        current: &HostCodeBindings,
    ) -> Result<HostCodeSummary, HostCodeError> {
        self.check_binding(current)?;
        Ok(HostCodeSummary {
            delivered_frames: self.delivered,
            quality_verdict: self.verdict,
            stop_intent_prepared: self.stop_operation.is_some(),
            revoked: self.revoked,
            runtime_authorized: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bindings() -> HostCodeBindings {
        HostCodeBindings {
            media: MediaCodeBindings {
                execution_identity: crate::EXECUTION_IDENTITY.into(),
                sdk_revision: crate::SDK_REVISION.into(),
                root_session_id: "synthetic-root".into(),
                child_session_id: "synthetic-child".into(),
                reviewer_session_id: "synthetic-reviewer".into(),
                generation: "synthetic-generation".into(),
                model_id: "gpt-6.1-sol".into(),
                command_sha256: "a".repeat(64),
                scope_sha256: "b".repeat(64),
                namespace_sha256: "c".repeat(64),
                context_manifest_sha256: "d".repeat(64),
            },
            occurrence_id: "synthetic-occurrence".into(),
            policy_revision: 1,
            owner_session_id: "synthetic-root".into(),
            audience_sha256: "e".repeat(64),
        }
    }
    fn manifest() -> FrameCodeManifest {
        FrameCodeManifest {
            source_sha256: "1".repeat(64),
            coverage_manifest_sha256: "2".repeat(64),
            criteria_sha256: "3".repeat(64),
            source_duration_ms: 264,
            frames: (0..8)
                .map(|ordinal| FrameCodeCoordinates {
                    ordinal,
                    sha256: format!("{ordinal:064x}"),
                    presentation_ms: ordinal as u64 * 33,
                    duration_ms: 33,
                })
                .collect(),
        }
    }
    fn fixture() -> HostCodePreparation {
        HostCodePreparation::new(bindings(), manifest()).unwrap()
    }
    fn observations(mask: u16) -> RouteExclusionObservations {
        let bits: [bool; 9] = std::array::from_fn(|bit| mask & (1 << bit) != 0);
        RouteExclusionObservations {
            context: bits[0],
            filesystem: bits[1],
            network: bits[2],
            resources: bits[3],
            plugins: bits[4],
            other_sessions: bits[5],
            management_api: bits[6],
            provider_context: bits[7],
            private_oracle: bits[8],
        }
    }

    #[test]
    fn every_pinned_and_unknown_client_route_is_denied_before_fake_effects() {
        // Parse only the trusted generated inventory's method lines, not untrusted production JSON.
        let inventory = include_str!("../pinned-client-methods.json");
        let methods: Vec<_> = inventory
            .lines()
            .filter_map(|line| {
                line.trim()
                    .strip_prefix("\"method\": \"")?
                    .strip_suffix("\",")
            })
            .collect();
        assert_eq!(methods.len(), 173);
        let unique: std::collections::BTreeSet<_> = methods.iter().copied().collect();
        assert_eq!(unique.len(), methods.len());
        for key in [
            "thread/start",
            "thread/resume",
            "thread/fork",
            "thread/shellCommand",
            "turn/start",
            "command/exec",
            "fs/readFile",
            "mcpServer/resource/read",
        ] {
            assert!(
                unique.contains(key),
                "missing dangerous pinned method {key}"
            );
        }
        let preparation = fixture();
        let mut fake_effects = 0;
        for method in methods.into_iter().chain([
            "",
            "unknown/future",
            "thread/start\0",
            "Thread/Start",
            "../command/exec",
            "submit_video_evidence_verdict",
        ]) {
            let result = preparation.reject_client_route(method);
            if result.is_ok() {
                fake_effects += 1;
            }
            assert_eq!(result, Err(HostCodeError::ClientRouteUnavailable));
        }
        assert_eq!(fake_effects, 0);
    }

    #[test]
    fn every_binding_mutation_preserves_state_and_denies_all_scoped_actions() {
        let original = bindings();
        let mut changes = Vec::new();
        macro_rules! media_change {
            ($field:ident) => {{
                let mut b = original.clone();
                b.media.$field.push('x');
                changes.push(b);
            }};
        }
        media_change!(execution_identity);
        media_change!(sdk_revision);
        media_change!(root_session_id);
        media_change!(child_session_id);
        media_change!(reviewer_session_id);
        media_change!(generation);
        media_change!(model_id);
        media_change!(command_sha256);
        media_change!(scope_sha256);
        media_change!(namespace_sha256);
        media_change!(context_manifest_sha256);
        macro_rules! host_change {
            ($field:ident) => {{
                let mut b = original.clone();
                b.$field.push('x');
                changes.push(b);
            }};
        }
        host_change!(occurrence_id);
        host_change!(owner_session_id);
        host_change!(audience_sha256);
        let mut b = original.clone();
        b.policy_revision += 1;
        changes.push(b);
        assert_eq!(changes.len(), 15);
        for changed in changes {
            let mut preparation = fixture();
            let before = preparation.code_summary(&original).unwrap();
            let error = Err(HostCodeError::Binding(BoundaryError::ReplacementBinding));
            assert_eq!(
                preparation.admit_synthetic_frame(&changed, &manifest().frames[0]),
                error
            );
            assert_eq!(
                preparation.record_synthetic_verdict(
                    &changed,
                    &manifest().criteria_sha256,
                    CodeQualityVerdict::AcceptSyntheticCriteria
                ),
                error
            );
            assert_eq!(
                preparation.prepare_synthetic_stop(&changed, "synthetic-stop"),
                Err(HostCodeError::Binding(BoundaryError::ReplacementBinding))
            );
            assert_eq!(preparation.revoke_code_preparation(&changed), error);
            assert_eq!(preparation.code_summary(&original).unwrap(), before);
        }
    }

    #[test]
    fn malformed_preparation_bindings_and_temporal_manifest_refuse() {
        for value in ["", "\0bad", "\n", &"x".repeat(257)] {
            let mut b = bindings();
            b.occurrence_id = value.into();
            assert!(matches!(
                HostCodePreparation::new(b, manifest()),
                Err(HostCodeError::Binding(BoundaryError::InvalidBinding))
            ));
        }
        let mut b = bindings();
        b.policy_revision = 0;
        assert!(HostCodePreparation::new(b, manifest()).is_err());
        for digest in ["", &"A".repeat(64), &"a".repeat(63), &"g".repeat(64)] {
            let mut b = bindings();
            b.audience_sha256 = digest.into();
            assert!(HostCodePreparation::new(b, manifest()).is_err());
        }
        for case in 0..7 {
            let mut m = manifest();
            match case {
                0 => m.frames.clear(),
                1 => m.frames.swap(0, 1),
                2 => m.frames[1].presentation_ms += 1,
                3 => m.frames[0].duration_ms = 0,
                4 => m.frames[0].sha256 = "g".repeat(64),
                5 => m.source_duration_ms += 1,
                _ => m.frames[0].duration_ms = u64::MAX,
            }
            assert!(matches!(
                HostCodePreparation::new(bindings(), m),
                Err(HostCodeError::InvalidManifest)
            ));
        }
    }

    #[test]
    fn all_resume_modes_refuse_before_and_after_preparation_without_effects() {
        let mut preparation = fixture();
        for prepared in [false, true] {
            if prepared {
                preparation
                    .admit_synthetic_frame(&bindings(), &manifest().frames[0])
                    .unwrap();
            }
            let before = preparation.code_summary(&bindings()).unwrap();
            for mode in ["warm", "cold", "resume", "fork", "reconnect"] {
                assert_eq!(
                    preparation.reject_resume(mode),
                    Err(HostCodeError::ResumeUnsupported)
                );
            }
            assert_eq!(preparation.code_summary(&bindings()).unwrap(), before);
        }
    }

    #[test]
    fn all_declared_route_combinations_and_forged_measurements_have_no_runtime_authority() {
        let preparation = fixture();
        assert_eq!(
            preparation.require_runtime_authority(None),
            Err(HostCodeError::RuntimeAuthorityUnavailable)
        );
        for mask in 0..512 {
            let claim = ClaimedRuntimeMeasurements {
                issuer_id: "invented-untrusted-issuer".into(),
                binding: bindings(),
                routes: observations(mask),
            };
            assert_eq!(
                preparation.require_runtime_authority(Some(&claim)),
                Err(HostCodeError::RuntimeAuthorityUnavailable)
            );
            assert!(
                !preparation
                    .code_summary(&bindings())
                    .unwrap()
                    .runtime_authorized
            );
        }
        for route in 0..9 {
            let mut changed = bindings();
            changed.media.namespace_sha256 = format!("{route:064x}");
            let claim = ClaimedRuntimeMeasurements {
                issuer_id: "invented-untrusted-issuer".into(),
                binding: changed,
                routes: observations(511 ^ (1 << route)),
            };
            assert_eq!(
                preparation.require_runtime_authority(Some(&claim)),
                Err(HostCodeError::RuntimeAuthorityUnavailable)
            );
        }
        // A complete-looking claim with an alleged trusted name still cannot register an issuer.
        let forged = ClaimedRuntimeMeasurements {
            issuer_id: "claimed-trusted-host".into(),
            binding: bindings(),
            routes: observations(511),
        };
        assert_eq!(
            preparation.require_runtime_authority(Some(&forged)),
            Err(HostCodeError::RuntimeAuthorityUnavailable)
        );
    }

    #[test]
    fn ordered_frame_claims_do_not_replace_criteria_quality_or_exact_stop_state() {
        let binding = bindings();
        let m = manifest();
        let mut preparation = fixture();
        assert_eq!(
            preparation.record_synthetic_verdict(
                &binding,
                &m.criteria_sha256,
                CodeQualityVerdict::AcceptSyntheticCriteria
            ),
            Err(HostCodeError::IncompleteDelivery)
        );
        assert_eq!(
            preparation.admit_synthetic_frame(&binding, &m.frames[1]),
            Err(HostCodeError::WrongFrame)
        );
        let mut wrong = m.frames[0].clone();
        wrong.sha256 = "f".repeat(64);
        assert_eq!(
            preparation.admit_synthetic_frame(&binding, &wrong),
            Err(HostCodeError::WrongFrame)
        );
        for coordinate in 0..3 {
            let mut wrong = m.frames[0].clone();
            match coordinate {
                0 => wrong.ordinal += 1,
                1 => wrong.presentation_ms += 1,
                _ => wrong.duration_ms += 1,
            }
            assert_eq!(
                preparation.admit_synthetic_frame(&binding, &wrong),
                Err(HostCodeError::WrongFrame)
            );
            assert_eq!(
                preparation
                    .code_summary(&binding)
                    .unwrap()
                    .delivered_frames(),
                0
            );
        }
        preparation
            .admit_synthetic_frame(&binding, &m.frames[0])
            .unwrap();
        assert_eq!(
            preparation.admit_synthetic_frame(&binding, &m.frames[0]),
            Err(HostCodeError::WrongFrame)
        );
        for frame in &m.frames[1..] {
            preparation.admit_synthetic_frame(&binding, frame).unwrap();
        }
        assert_eq!(
            preparation.admit_synthetic_frame(&binding, &m.frames[7]),
            Err(HostCodeError::WrongFrame)
        );
        assert_eq!(
            preparation.code_summary(&binding).unwrap().quality_verdict,
            None
        );
        assert_eq!(
            preparation.record_synthetic_verdict(
                &binding,
                &"f".repeat(64),
                CodeQualityVerdict::AcceptSyntheticCriteria
            ),
            Err(HostCodeError::WrongCriteria)
        );
        preparation
            .record_synthetic_verdict(
                &binding,
                &m.criteria_sha256,
                CodeQualityVerdict::RejectSyntheticCriteria,
            )
            .unwrap();
        assert_eq!(
            preparation.record_synthetic_verdict(
                &binding,
                &m.criteria_sha256,
                CodeQualityVerdict::AcceptSyntheticCriteria
            ),
            Err(HostCodeError::VerdictAlreadyRecorded)
        );
        let before = preparation.code_summary(&binding).unwrap();
        assert_eq!(
            preparation.prepare_synthetic_stop(&binding, "synthetic-stop"),
            Ok(CodeStopPreparation::PreparedUnknown)
        );
        assert_eq!(
            preparation.prepare_synthetic_stop(&binding, "synthetic-stop"),
            Ok(CodeStopPreparation::ExistingUnknown)
        );
        assert_eq!(
            preparation.prepare_synthetic_stop(&binding, "replacement-stop"),
            Err(HostCodeError::ReplacementOperation)
        );
        assert_eq!(
            preparation.prepare_synthetic_stop(&binding, "\0malformed"),
            Err(HostCodeError::InvalidOperation)
        );
        assert_eq!(
            preparation.admit_synthetic_frame(&binding, &m.frames[7]),
            Err(HostCodeError::Fenced)
        );
        preparation.revoke_code_preparation(&binding).unwrap();
        assert_eq!(
            preparation.prepare_synthetic_stop(&binding, "synthetic-stop"),
            Ok(CodeStopPreparation::ExistingUnknown)
        );
        let after = preparation.code_summary(&binding).unwrap();
        assert_eq!(after.delivered_frames, before.delivered_frames);
        assert_eq!(after.quality_verdict, before.quality_verdict);
        assert!(after.revoked && after.stop_intent_prepared && !after.runtime_authorized);
    }

    #[test]
    fn synthetic_revocation_and_privacy_summary_never_expose_markers_or_grant_authority() {
        let b = bindings();
        let mut preparation = fixture();
        preparation.revoke_code_preparation(&b).unwrap();
        assert_eq!(
            preparation.admit_synthetic_frame(&b, &manifest().frames[0]),
            Err(HostCodeError::Fenced)
        );
        assert_eq!(
            preparation.prepare_synthetic_stop(&b, "synthetic-stop"),
            Err(HostCodeError::Fenced)
        );
        let summary = format!("{:?}", preparation.code_summary(&b).unwrap());
        for private_marker in [
            "synthetic-root",
            "synthetic-reviewer",
            "synthetic-occurrence",
            "synthetic-generation",
            &"a".repeat(64),
            &"3".repeat(64),
        ] {
            assert!(!summary.contains(private_marker));
        }
        assert!(summary.contains("runtime_authorized: false"));
    }
}
