//! DISTINCT unregistered owning-host adapter SOURCE. No executable, account loader or issuer.
//! Fake source descriptions are never admission values and cannot reach the SDK adapter.
use crate::host_contract::{
    FrameCodeManifest, HostCodeBindings, HostCodeError, HostCodePreparation,
};

#[derive(Debug, PartialEq, Eq)]
pub enum BridgeError {
    Source(HostCodeError),
    RuntimeIssuerUnavailable,
    InvalidDispatch,
    AlreadyAttempted,
    UnknownSdkEffect,
    UnsupportedEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupSourceOutcome {
    Accepted,
    RefusedBeforeEffect,
    LostReply,
    Exception,
    Duplicate,
    Replacement,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupSourceState {
    Prepared,
    Unknown,
    ActiveClaim,
    NeverDispatchedClaim,
}

pub struct StartupSourceDescription {
    binding: HostCodeBindings,
    dispatch_sha256: String,
}

/// No I/O or callback/effect port exists here. A fake test driver consumes descriptions.
pub struct SourceStartup {
    contract: HostCodePreparation,
    state: StartupSourceState,
    original_dispatch: Option<String>,
}
impl SourceStartup {
    pub fn new(
        binding: HostCodeBindings,
        manifest: FrameCodeManifest,
    ) -> Result<Self, BridgeError> {
        Ok(Self {
            contract: HostCodePreparation::new(binding, manifest).map_err(BridgeError::Source)?,
            state: StartupSourceState::Prepared,
            original_dispatch: None,
        })
    }
    pub fn prepare_description(
        &mut self,
        current: &HostCodeBindings,
        dispatch: &str,
    ) -> Result<StartupSourceDescription, BridgeError> {
        self.contract
            .code_summary(current)
            .map_err(BridgeError::Source)?;
        if dispatch.len() != 64
            || !dispatch
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(BridgeError::InvalidDispatch);
        }
        if self.original_dispatch.is_some() {
            return Err(BridgeError::AlreadyAttempted);
        }
        // Source anchor precedes any fake effect description. Real durable dispatch requires
        // the server transaction/owning-channel claim; this in-memory state is not that proof.
        self.original_dispatch = Some(dispatch.into());
        self.state = StartupSourceState::Unknown;
        Ok(StartupSourceDescription {
            binding: current.clone(),
            dispatch_sha256: dispatch.into(),
        })
    }
    pub fn record_source_outcome(
        &mut self,
        description: &StartupSourceDescription,
        current: &HostCodeBindings,
        outcome: StartupSourceOutcome,
    ) -> Result<(), BridgeError> {
        self.contract
            .code_summary(current)
            .map_err(BridgeError::Source)?;
        if &description.binding != current
            || self.original_dispatch.as_deref() != Some(&description.dispatch_sha256)
        {
            return Err(BridgeError::InvalidDispatch);
        }
        if self.state != StartupSourceState::Unknown {
            return Err(BridgeError::AlreadyAttempted);
        }
        self.state = match outcome {
            StartupSourceOutcome::Accepted => StartupSourceState::ActiveClaim,
            StartupSourceOutcome::RefusedBeforeEffect => StartupSourceState::NeverDispatchedClaim,
            _ => StartupSourceState::Unknown,
        };
        Ok(())
    }
    pub fn source_state(&self) -> StartupSourceState {
        self.state
    }
    pub fn reject_external_route(&self, method: &str) -> Result<(), BridgeError> {
        self.contract
            .reject_client_route(method)
            .map_err(BridgeError::Source)
    }
    pub fn reject_resume(&self, mode: &str) -> Result<(), BridgeError> {
        self.contract
            .reject_resume(mode)
            .map_err(BridgeError::Source)
    }
}

/// Exact immutable metadata SOURCE snapshot, never an admission or a runtime grant.
/// Pure comparisons/tests may construct source snapshots; they cannot mint production types.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SourceAdmissionCommitments {
    binding: HostCodeBindings,
    criteria_text: String,
    criteria_ids: Vec<String>,
    frame_count: usize,
    dispatch_sha256: String,
    durable_anchor_sha256: String,
    native_envelope: crate::native_transport::NativeEnvelopeSource,
}
impl SourceAdmissionCommitments {
    pub(crate) fn validate_source(&self, current: &HostCodeBindings) -> Result<(), BridgeError> {
        if &self.binding != current {
            return Err(BridgeError::InvalidDispatch);
        }
        self.native_envelope
            .validate_source_bounds()
            .map_err(|_| BridgeError::InvalidDispatch)?;
        if self.native_envelope.frames.len() != self.frame_count
            || self.criteria_text.is_empty()
            || self.criteria_text.len() > 32768
            || self.criteria_ids.is_empty()
            || self.criteria_ids.len() > 64
            || self
                .criteria_ids
                .iter()
                .any(|v| v.is_empty() || v.len() > 256 || v.chars().any(char::is_control))
            || self
                .criteria_ids
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.criteria_ids.len()
            || [&self.dispatch_sha256, &self.durable_anchor_sha256]
                .iter()
                .any(|v| {
                    v.len() != 64
                        || !v
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
        {
            return Err(BridgeError::InvalidDispatch);
        }
        Ok(()) // SOURCE validity never supplies the missing issuer or measured runtime authority.
    }
    pub(crate) fn require_same_source(
        &self,
        supplied: &Self,
        current: &HostCodeBindings,
    ) -> Result<(), BridgeError> {
        self.validate_source(current)?;
        supplied.validate_source(current)?;
        if self != supplied {
            return Err(BridgeError::InvalidDispatch);
        }
        Ok(())
    }
    pub(crate) fn envelope(&self) -> &crate::native_transport::NativeEnvelopeSource {
        &self.native_envelope
    }
    pub(crate) fn criterion_ids(&self) -> &[String] {
        &self.criteria_ids
    }
    pub(crate) fn frame_count(&self) -> usize {
        self.frame_count
    }
}

/// No constructor/Deserialize/Clone/test factory. No production issuer is installed.
/// Even a valid SourceAdmissionCommitments value cannot produce this type.
pub(crate) struct ProductionAdmission {
    commitments: SourceAdmissionCommitments,
}
impl ProductionAdmission {
    fn check_current(&self, current: &HostCodeBindings) -> Result<(), BridgeError> {
        self.commitments.validate_source(current)?;
        production_issuer_status()
    }
    pub(crate) fn checked_source(
        &self,
        current: &HostCodeBindings,
    ) -> Result<&SourceAdmissionCommitments, BridgeError> {
        self.check_current(current)?;
        Ok(&self.commitments)
    }
}
pub fn production_issuer_status() -> Result<(), BridgeError> {
    // Human/audited host registration is absent. Do not replace this with a caller boolean.
    Err(BridgeError::RuntimeIssuerUnavailable)
}

#[cfg(feature = "native-core")]
pub(crate) mod sdk {
    use super::*;
    use codex_core::{CodexThread, ThreadManager};
    use codex_protocol::dynamic_tools::DynamicToolCallRequest;
    use codex_protocol::protocol::{EventMsg, Op};
    use std::sync::Arc;

    pub(crate) struct OwnedNativeHost {
        thread: Arc<CodexThread>,
        commitments: SourceAdmissionCommitments,
        sdk_thread_id: String,
        turn_id: Option<String>,
        initial_turn_attempted: bool,
        pending_call: Option<(String, String)>,
        consumed_calls: std::collections::BTreeSet<String>,
    }
    pub(crate) enum ScopedEventSource {
        Tool(DynamicToolCallRequest),
        UsageAvailable,
        TurnFinishedUnpriced,
        TurnAbortedUnpriced,
    }
    pub(crate) async fn start_owned(
        manager: &ThreadManager,
        preparation: crate::native::RestrictedStartupPreparation,
        admission: &ProductionAdmission,
        current: &HostCodeBindings,
    ) -> Result<OwnedNativeHost, BridgeError> {
        // MUST precede start_thread, which can prewarm provider transport. Currently always
        // refuses: no registered issuer, authenticated namespace or actual admission exists.
        admission.check_current(current)?;
        let commitments = admission.commitments.clone(); // freeze BEFORE possible startup/prewarm
        let options = preparation
            .into_host_start_options(&current.media)
            .map_err(|_| BridgeError::InvalidDispatch)?;
        let started = manager
            .start_thread(options)
            .await
            .map_err(|_| BridgeError::UnknownSdkEffect)?;
        Ok(OwnedNativeHost {
            sdk_thread_id: started.thread_id.to_string(),
            thread: started.thread,
            commitments,
            turn_id: None,
            initial_turn_attempted: false,
            pending_call: None,
            consumed_calls: Default::default(),
        })
    }
    impl OwnedNativeHost {
        fn current(
            &self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<(), BridgeError> {
            if self.sdk_thread_id.is_empty() {
                return Err(BridgeError::InvalidDispatch);
            }
            self.commitments
                .require_same_source(&admission.commitments, current)?;
            admission.check_current(current)
        }
        pub(crate) async fn start_criteria_turn(
            &mut self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<(), BridgeError> {
            self.current(admission, current)?;
            if self.initial_turn_attempted
                || admission.commitments.criteria_text.is_empty()
                || admission.commitments.criteria_text.len() > 32768
            {
                return Err(BridgeError::InvalidDispatch);
            }
            self.initial_turn_attempted = true; // unknown submission is never automatically repeated
            let request = codex_core::TurnInputRequest::user_input(vec![
                codex_protocol::user_input::UserInput::Text {
                    text: admission.commitments.criteria_text.clone(),
                    text_elements: vec![],
                },
            ]);
            let submitted = self
                .thread
                .start_turn_if_idle(request)
                .await
                .map_err(|_| BridgeError::UnknownSdkEffect)?;
            match submitted {
                codex_core::StartIfIdleSubmission::Started { turn_id, .. } => {
                    self.turn_id = Some(turn_id);
                    Ok(())
                }
                _ => Err(BridgeError::UnknownSdkEffect),
            }
        }
        pub(crate) async fn next_scoped_event(
            &mut self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<ScopedEventSource, BridgeError> {
            self.current(admission, current)?;
            let event = self
                .thread
                .next_event()
                .await
                .map_err(|_| BridgeError::UnknownSdkEffect)?;
            match event.msg {
                EventMsg::DynamicToolCallRequest(call) => {
                    if self.pending_call.is_some()
                        || self.consumed_calls.contains(&call.call_id)
                        || self.turn_id.as_deref() != Some(call.turn_id.as_str())
                    {
                        return Err(BridgeError::UnsupportedEvent);
                    }
                    crate::native_transport::sdk::validate_scoped_call(
                        &call,
                        &admission.commitments.criteria_ids,
                        admission.commitments.frame_count,
                    )
                    .map_err(|_| BridgeError::UnsupportedEvent)?;
                    self.pending_call = Some((call.call_id.clone(), call.turn_id.clone()));
                    Ok(ScopedEventSource::Tool(call))
                }
                EventMsg::TokenCount(_) => Ok(ScopedEventSource::UsageAvailable),
                EventMsg::TurnComplete(_) => Ok(ScopedEventSource::TurnFinishedUnpriced),
                EventMsg::TurnAborted(_) => Ok(ScopedEventSource::TurnAbortedUnpriced),
                _ => Err(BridgeError::UnsupportedEvent),
            }
        }
        pub(crate) async fn submit_scoped_response(
            &mut self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
            response: crate::native_transport::sdk::PreparedToolResponse,
        ) -> Result<(), BridgeError> {
            self.current(admission, current)?;
            let (call_id, turn_id) = self
                .pending_call
                .as_ref()
                .ok_or(BridgeError::InvalidDispatch)?;
            if !response.coordinates_match(current, call_id, turn_id, &self.commitments) {
                return Err(BridgeError::InvalidDispatch);
            }
            let (id, response) = response.into_sdk_parts();
            self.pending_call = None; // an unknown submit response must not replay this call
            self.consumed_calls.insert(id.clone());
            self.thread
                .submit(Op::DynamicToolResponse { id, response })
                .await
                .map_err(|_| BridgeError::UnknownSdkEffect)?;
            Ok(())
        }
        pub(crate) async fn usage_source_snapshot(
            &self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<Option<codex_protocol::protocol::TokenUsageInfo>, BridgeError> {
            self.current(admission, current)?;
            Ok(self.thread.token_usage_info().await)
        }
        pub(crate) async fn shutdown_exact_owned(
            &self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
            intent: &crate::native_cleanup::ProductionStopIntent,
        ) -> Result<(), BridgeError> {
            self.current(admission, current)?;
            intent.check(
                current,
                &self.sdk_thread_id,
                &self.commitments.dispatch_sha256,
            )?; // exact durable owning intent, immediately before effect
            self.thread
                .shutdown_and_wait()
                .await
                .map_err(|_| BridgeError::UnknownSdkEffect)?;
            self.thread.wait_until_terminated().await;
            // Termination remains unpriced. No capacity release/refund/quality certification.
            Ok(())
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    /// Invented, untrusted SOURCE values only; this cannot create ProductionAdmission.
    pub(crate) fn source_commitments(
        native_envelope: crate::native_transport::NativeEnvelopeSource,
    ) -> SourceAdmissionCommitments {
        SourceAdmissionCommitments {
            binding: binding(),
            criteria_text: "Invented source criteria.".into(),
            criteria_ids: vec!["fake-criterion".into()],
            frame_count: native_envelope.frames.len(),
            dispatch_sha256: "f".repeat(64),
            durable_anchor_sha256: "a".repeat(64),
            native_envelope,
        }
    }
    #[test]
    fn replacement_source_commitments_refuse_before_fake_effect_without_admission_factory() {
        use crate::native_transport::{
            CanonicalFrameTimeSource, NativeEnvelopeSource, NativeProfileSource,
        };
        let original = source_commitments(NativeEnvelopeSource {
            profile: NativeProfileSource::PacedComplete,
            width: 960,
            height: 540,
            source_bytes: 1,
            duration_us: 66_000,
            audio_channels: 0,
            webm_vp9: true,
            frames: (0..2)
                .map(|ordinal| CanonicalFrameTimeSource {
                    ordinal,
                    presentation_us: ordinal as u64 * 33_000,
                    duration_us: 33_000,
                })
                .collect(),
        });
        let b = binding();
        let mut fake_effects = 0;
        original.require_same_source(&original.clone(), &b).unwrap();
        fake_effects += 1; // the sole identical SOURCE control; no SDK handle exists
        for field in 0..17 {
            let mut replacement = original.clone();
            match field {
                0 => replacement.dispatch_sha256 = "b".repeat(64),
                1 => replacement.durable_anchor_sha256 = "c".repeat(64),
                2 => replacement.native_envelope.profile = NativeProfileSource::Candidate,
                3 => replacement.native_envelope.width = 1280,
                4 => replacement.native_envelope.height = 720,
                5 => replacement.native_envelope.source_bytes = 2,
                6 => replacement.native_envelope.duration_us += 1,
                7 => replacement.native_envelope.audio_channels = 1,
                8 => replacement.native_envelope.webm_vp9 = false,
                9 => replacement.frame_count += 1,
                10 => replacement.native_envelope.frames[0].ordinal = 1,
                11 => replacement.native_envelope.frames[0].presentation_us = 1,
                12 => replacement.native_envelope.frames[0].duration_us += 1,
                13 => replacement.criteria_text.push('x'),
                14 => replacement.criteria_ids[0].push('x'),
                15 => replacement.criteria_ids.push("fake-other".into()),
                _ => replacement.binding.media.generation.push('x'),
            }
            if original.require_same_source(&replacement, &b).is_ok() {
                fake_effects += 1;
            }
            assert_eq!(
                original.require_same_source(&replacement, &b),
                Err(BridgeError::InvalidDispatch)
            );
            assert_eq!(fake_effects, 1);
        }
        let mut two_ids = original.clone();
        two_ids.criteria_ids.push("fake-other".into());
        let mut reordered = two_ids.clone();
        reordered.criteria_ids.reverse();
        assert_eq!(
            two_ids.require_same_source(&reordered, &b),
            Err(BridgeError::InvalidDispatch)
        );
        assert_eq!(
            production_issuer_status(),
            Err(BridgeError::RuntimeIssuerUnavailable)
        );
    }
    pub(crate) fn binding() -> HostCodeBindings {
        HostCodeBindings {
            media: crate::MediaCodeBindings {
                execution_identity: crate::EXECUTION_IDENTITY.into(),
                sdk_revision: crate::SDK_REVISION.into(),
                root_session_id: "fake-root".into(),
                child_session_id: "fake-child".into(),
                reviewer_session_id: "fake-reviewer".into(),
                generation: "fake-generation".into(),
                model_id: "gpt-6.1-sol".into(),
                command_sha256: "a".repeat(64),
                scope_sha256: "b".repeat(64),
                namespace_sha256: "c".repeat(64),
                context_manifest_sha256: "d".repeat(64),
            },
            occurrence_id: "fake-occurrence".into(),
            policy_revision: 1,
            owner_session_id: "fake-root".into(),
            audience_sha256: "e".repeat(64),
        }
    }
    fn manifest() -> FrameCodeManifest {
        FrameCodeManifest {
            source_sha256: "1".repeat(64),
            coverage_manifest_sha256: "2".repeat(64),
            criteria_sha256: "3".repeat(64),
            source_duration_ms: 1,
            frames: vec![crate::host_contract::FrameCodeCoordinates {
                ordinal: 0,
                sha256: "4".repeat(64),
                presentation_ms: 0,
                duration_ms: 1,
            }],
        }
    }
    #[test]
    fn six_fake_outcomes_preserve_one_attempt_and_never_mint_runtime_admission() {
        for outcome in [
            StartupSourceOutcome::Accepted,
            StartupSourceOutcome::RefusedBeforeEffect,
            StartupSourceOutcome::LostReply,
            StartupSourceOutcome::Exception,
            StartupSourceOutcome::Duplicate,
            StartupSourceOutcome::Replacement,
        ] {
            let b = binding();
            let mut source = SourceStartup::new(b.clone(), manifest()).unwrap();
            let description = source.prepare_description(&b, &"f".repeat(64)).unwrap();
            assert_eq!(source.source_state(), StartupSourceState::Unknown);
            source
                .record_source_outcome(&description, &b, outcome)
                .unwrap();
            assert!(source.prepare_description(&b, &"f".repeat(64)).is_err());
            assert_eq!(
                production_issuer_status(),
                Err(BridgeError::RuntimeIssuerUnavailable)
            );
            if !matches!(
                outcome,
                StartupSourceOutcome::Accepted | StartupSourceOutcome::RefusedBeforeEffect
            ) {
                assert_eq!(source.source_state(), StartupSourceState::Unknown);
            }
        }
    }
    #[test]
    fn replacement_authority_and_every_external_or_resume_route_refuse() {
        let b = binding();
        let mut source = SourceStartup::new(b.clone(), manifest()).unwrap();
        let mut changed = b.clone();
        changed.media.generation.push('x');
        assert!(
            source
                .prepare_description(&changed, &"f".repeat(64))
                .is_err()
        );
        assert_eq!(source.source_state(), StartupSourceState::Prepared);
        let description = source.prepare_description(&b, &"f".repeat(64)).unwrap();
        assert!(
            source
                .record_source_outcome(&description, &changed, StartupSourceOutcome::Accepted)
                .is_err()
        );
        assert_eq!(source.source_state(), StartupSourceState::Unknown);
        for line in include_str!("../pinned-client-methods.json").lines() {
            if let Some(method) = line
                .trim()
                .strip_prefix("\"method\": \"")
                .and_then(|s| s.strip_suffix("\","))
            {
                assert!(source.reject_external_route(method).is_err());
            }
        }
        assert!(source.reject_external_route("unknown/future").is_err());
        for mode in ["warm", "cold", "fork", "resume", "reconnect"] {
            assert!(source.reject_resume(mode).is_err());
        }
    }
}
