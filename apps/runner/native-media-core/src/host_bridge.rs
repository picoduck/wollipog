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

/// No constructor/Deserialize/Clone/test factory. No production issuer is installed.
/// Neither SourceStartup nor an all-true route claim can produce this type.
pub(crate) struct ProductionAdmission {
    binding: HostCodeBindings,
    criteria_text: String,
    criteria_ids: Vec<String>,
    frame_count: usize,
    dispatch_sha256: String,
    durable_anchor_sha256: String,
    native_envelope: crate::native_transport::NativeEnvelopeSource,
}
impl ProductionAdmission {
    fn check_current(&self, current: &HostCodeBindings) -> Result<(), BridgeError> {
        if &self.binding != current {
            return Err(BridgeError::InvalidDispatch);
        }
        self.native_envelope
            .validate_source_bounds()
            .map_err(|_| BridgeError::InvalidDispatch)?;
        if self.native_envelope.frames.len() != self.frame_count
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
        production_issuer_status()
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
        binding: HostCodeBindings,
        sdk_thread_id: String,
        turn_id: Option<String>,
        initial_turn_attempted: bool,
        pending_call: Option<(String, String)>,
        consumed_calls: std::collections::BTreeSet<String>,
        dispatch_sha256: String,
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
            binding: current.clone(),
            turn_id: None,
            initial_turn_attempted: false,
            pending_call: None,
            consumed_calls: Default::default(),
            dispatch_sha256: admission.dispatch_sha256.clone(),
        })
    }
    impl OwnedNativeHost {
        fn current(
            &self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<(), BridgeError> {
            if &self.binding != current || self.sdk_thread_id.is_empty() {
                return Err(BridgeError::InvalidDispatch);
            }
            admission.check_current(current)
        }
        pub(crate) async fn start_criteria_turn(
            &mut self,
            admission: &ProductionAdmission,
            current: &HostCodeBindings,
        ) -> Result<(), BridgeError> {
            self.current(admission, current)?;
            if self.initial_turn_attempted
                || admission.criteria_text.is_empty()
                || admission.criteria_text.len() > 32768
            {
                return Err(BridgeError::InvalidDispatch);
            }
            self.initial_turn_attempted = true; // unknown submission is never automatically repeated
            let request = codex_core::TurnInputRequest::user_input(vec![
                codex_protocol::user_input::UserInput::Text {
                    text: admission.criteria_text.clone(),
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
                        &admission.criteria_ids,
                        admission.frame_count,
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
            if !response.coordinates_match(current, call_id, turn_id) {
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
            intent.check(current, &self.sdk_thread_id, &self.dispatch_sha256)?; // exact durable owning intent, immediately before effect
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
