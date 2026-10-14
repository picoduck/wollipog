//! Bounded image/window adapter SOURCE. Source claims and fake ACKs are not delivery receipts.
//! SDK conversion has no Session, retrieval, network, issuer or permission side effect.
use crate::host_contract::HostCodeBindings;

#[derive(Debug, PartialEq, Eq)]
pub enum TransportError {
    Binding,
    InvalidCall,
    InvalidWindow,
    Backpressure,
    WrongAck,
    Incomplete,
    Replay,
    AdmissionUnavailable,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum NativeProfileSource {
    Candidate,
    PacedComplete,
}
#[derive(Clone, PartialEq, Eq)]
pub struct CanonicalFrameTimeSource {
    pub ordinal: usize,
    pub presentation_us: u64,
    pub duration_us: u64,
}
/// Metadata SOURCE only. Successful bounds checks do not authenticate bytes, profile or timing.
#[derive(Clone, PartialEq, Eq)]
pub struct NativeEnvelopeSource {
    pub profile: NativeProfileSource,
    pub width: u32,
    pub height: u32,
    pub source_bytes: usize,
    pub duration_us: u64,
    pub audio_channels: u32,
    pub webm_vp9: bool,
    pub frames: Vec<CanonicalFrameTimeSource>,
}
impl NativeEnvelopeSource {
    pub fn validate_source_bounds(&self) -> Result<(), TransportError> {
        let (min_width, min_height, width, height, source_bytes, duration, frames, interval) =
            match self.profile {
                NativeProfileSource::Candidate => {
                    (640, 360, 640, 360, 8 * 1024 * 1024, 4_000_000, 16, 250_000)
                }
                NativeProfileSource::PacedComplete => (
                    960,
                    540,
                    1280,
                    720,
                    32 * 1024 * 1024,
                    30_000_000,
                    900,
                    33_000,
                ),
            };
        if !self.webm_vp9
            || self.audio_channels != 0
            || self.width < min_width
            || self.height < min_height
            || self.width > width
            || self.height > height
            || self.source_bytes == 0
            || self.source_bytes > source_bytes
            || self.duration_us == 0
            || self.duration_us > duration
            || self.frames.is_empty()
            || self.frames.len() > frames
        {
            return Err(TransportError::InvalidWindow);
        }
        let mut end = 0;
        for (ordinal, frame) in self.frames.iter().enumerate() {
            if frame.ordinal != ordinal
                || frame.presentation_us != end
                || frame.duration_us < interval
            {
                return Err(TransportError::InvalidWindow);
            }
            end = frame
                .presentation_us
                .checked_add(frame.duration_us)
                .ok_or(TransportError::InvalidWindow)?;
        }
        if end != self.duration_us {
            return Err(TransportError::InvalidWindow);
        }
        Ok(())
    }
}
pub fn require_lossless_millisecond_mapping(
    milliseconds: u64,
    canonical_microseconds: u64,
) -> Result<(), TransportError> {
    if milliseconds.checked_mul(1000) != Some(canonical_microseconds) {
        return Err(TransportError::InvalidWindow);
    }
    Ok(())
}
#[derive(Clone, PartialEq, Eq)]
pub struct SourceCallCoordinates {
    pub call_id: String,
    pub turn_id: String,
    pub namespace: Option<String>,
    pub tool: String,
}
#[derive(Clone, PartialEq, Eq)]
pub struct SourceImage {
    pub ordinal: usize,
    pub sha256: String,
    pub presentation_us: u64,
    pub duration_us: u64,
    pub data_url: String,
}
#[derive(Clone, PartialEq, Eq)]
pub struct SourceWindow {
    pub source_sha256: String,
    pub manifest_sha256: String,
    pub window_sha256: String,
    pub images: Vec<SourceImage>,
}
struct PendingWindow {
    call: SourceCallCoordinates,
    window: SourceWindow,
    end: usize,
    end_time: u64,
    decoded_bytes: usize,
}
/// Validated metadata progress only. This is not an authenticated delivery or SDK submit receipt.
#[derive(Clone, PartialEq, Eq)]
struct ProfileSourceProgress {
    next: usize,
    end_time: u64,
    derived_bytes: usize,
}
pub struct WindowTransportSource {
    binding: HostCodeBindings,
    commitments: Option<crate::host_bridge::SourceAdmissionCommitments>,
    profile_source_progress: Option<ProfileSourceProgress>,
    source_sha256: String,
    manifest_sha256: String,
    frame_count: usize,
    next: usize,
    pending: Option<PendingWindow>,
    completed_calls: std::collections::BTreeSet<String>,
    last_ack: Option<(SourceCallCoordinates, SourceWindow)>,
    next_time: u64,
    derived_bytes: usize,
    #[cfg(feature = "native-core")]
    source_verdict: Option<serde_json::Value>,
}
fn id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn image_url(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("data:image/png;base64,") else {
        return false;
    };
    !encoded.is_empty()
        && encoded.len() % 4 == 0
        && encoded.len() <= ((2 * 1024 * 1024 + 2) / 3) * 4
        && encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
        && !encoded.trim_end_matches('=').contains('=')
        && encoded.len() - encoded.trim_end_matches('=').len() <= 2
}
impl WindowTransportSource {
    pub fn new(
        binding: HostCodeBindings,
        source_sha256: String,
        manifest_sha256: String,
        frame_count: usize,
    ) -> Result<Self, TransportError> {
        if !digest(&source_sha256)
            || !digest(&manifest_sha256)
            || frame_count == 0
            || frame_count > 900
        {
            return Err(TransportError::InvalidWindow);
        }
        Ok(Self {
            binding,
            commitments: None,
            profile_source_progress: None,
            source_sha256,
            manifest_sha256,
            frame_count,
            next: 0,
            pending: None,
            completed_calls: Default::default(),
            last_ack: None,
            next_time: 0,
            derived_bytes: 0,
            #[cfg(feature = "native-core")]
            source_verdict: None,
        })
    }
    pub fn prepare_source_window(
        &mut self,
        current: &HostCodeBindings,
        call: SourceCallCoordinates,
        window: &SourceWindow,
    ) -> Result<(), TransportError> {
        if current != &self.binding {
            return Err(TransportError::Binding);
        }
        if self.pending.is_some() {
            return Err(TransportError::Backpressure);
        }
        let pending = self.validate_source_window(current, &call, window)?;
        self.pending = Some(pending);
        Ok(())
    }
    /// Dry validation shared by prepare and final ACK. No source state is changed on refusal.
    fn validate_source_window(
        &self,
        current: &HostCodeBindings,
        call: &SourceCallCoordinates,
        window: &SourceWindow,
    ) -> Result<PendingWindow, TransportError> {
        if current != &self.binding {
            return Err(TransportError::Binding);
        }
        if !id(&call.call_id)
            || !id(&call.turn_id)
            || call.namespace.is_some()
            || call.tool != crate::MEDIA_TOOLS[0]
        {
            return Err(TransportError::InvalidCall);
        }
        if self.completed_calls.contains(&call.call_id) {
            return Err(TransportError::Replay);
        }
        if window.source_sha256 != self.source_sha256
            || window.manifest_sha256 != self.manifest_sha256
            || !digest(&window.window_sha256)
            || window.images.is_empty()
            || window.images.len() > 32
            || self
                .next
                .checked_add(window.images.len())
                .is_none_or(|end| end > self.frame_count)
        {
            return Err(TransportError::InvalidWindow);
        }
        let mut total = 0usize;
        let mut decoded_bytes = 0usize;
        let mut previous_end = Some(self.next_time);
        for (offset, image) in window.images.iter().enumerate() {
            if image.ordinal != self.next + offset
                || !digest(&image.sha256)
                || image.duration_us == 0
                || !image_url(&image.data_url)
            {
                return Err(TransportError::InvalidWindow);
            }
            if previous_end.is_some_and(|end| end != image.presentation_us) {
                return Err(TransportError::InvalidWindow);
            }
            previous_end = Some(
                image
                    .presentation_us
                    .checked_add(image.duration_us)
                    .ok_or(TransportError::InvalidWindow)?,
            );
            let encoded = image
                .data_url
                .strip_prefix("data:image/png;base64,")
                .ok_or(TransportError::InvalidWindow)?;
            let decoded =
                encoded.len() / 4 * 3 - (encoded.len() - encoded.trim_end_matches('=').len());
            if decoded > 2 * 1024 * 1024 {
                return Err(TransportError::InvalidWindow);
            }
            decoded_bytes = decoded_bytes
                .checked_add(decoded)
                .ok_or(TransportError::InvalidWindow)?;
            total = total
                .checked_add(image.data_url.len() + 256)
                .ok_or(TransportError::InvalidWindow)?;
            if total > 8 * 1024 * 1024 {
                return Err(TransportError::InvalidWindow);
            }
        }
        // URL syntax is not PNG decoding or digest authentication. The production issuer and
        // trusted verified-content retrieval are absent; these are explicitly source claims.
        let prospective_bytes = self
            .derived_bytes
            .checked_add(decoded_bytes)
            .ok_or(TransportError::InvalidWindow)?;
        if prospective_bytes > 128 * 1024 * 1024 {
            return Err(TransportError::InvalidWindow);
        }
        if let Some(source) = &self.commitments {
            self.require_source_commitments(current, source)?;
            self.require_matching_profile_source_progress()?;
            require_source_image_profile_total(self, window, source.envelope(), prospective_bytes)?;
        }
        Ok(PendingWindow {
            call: call.clone(),
            window: window.clone(),
            end: self
                .next
                .checked_add(window.images.len())
                .ok_or(TransportError::InvalidWindow)?,
            end_time: previous_end.ok_or(TransportError::InvalidWindow)?,
            decoded_bytes,
        })
    }
    // Freeze metadata only on a pristine SOURCE transport; never a runtime permit.
    fn bind_source_commitments(
        mut self,
        source: &crate::host_bridge::SourceAdmissionCommitments,
    ) -> Result<Self, TransportError> {
        source
            .validate_source(&self.binding)
            .map_err(|_| TransportError::Binding)?;
        if self.commitments.is_some()
            || self.profile_source_progress.is_some()
            || self.next != 0
            || self.next_time != 0
            || self.derived_bytes != 0
            || !self.completed_calls.is_empty()
            || self.pending.is_some()
            || self.last_ack.is_some()
            || source.frame_count() != self.frame_count
        {
            return Err(TransportError::Binding);
        }
        self.commitments = Some(source.clone());
        self.profile_source_progress = Some(ProfileSourceProgress {
            next: 0,
            end_time: 0,
            derived_bytes: 0,
        });
        Ok(self)
    }
    fn require_matching_profile_source_progress(&self) -> Result<(), TransportError> {
        let validated = self
            .profile_source_progress
            .as_ref()
            .ok_or(TransportError::Binding)?;
        if validated.next != self.next
            || validated.end_time != self.next_time
            || validated.derived_bytes != self.derived_bytes
        {
            return Err(TransportError::InvalidWindow);
        }
        Ok(())
    }
    fn require_source_commitments(
        &self,
        current: &HostCodeBindings,
        source: &crate::host_bridge::SourceAdmissionCommitments,
    ) -> Result<(), TransportError> {
        self.commitments
            .as_ref()
            .ok_or(TransportError::Binding)?
            .require_same_source(source, current)
            .map_err(|_| TransportError::Binding)
    }
    pub fn acknowledge_source_window(
        &mut self,
        current: &HostCodeBindings,
        call: &SourceCallCoordinates,
        window_sha256: &str,
    ) -> Result<(), TransportError> {
        if current != &self.binding {
            return Err(TransportError::Binding);
        }
        let pending = self.pending.as_ref().ok_or(TransportError::WrongAck)?;
        if &pending.call != call || pending.window.window_sha256 != window_sha256 {
            return Err(TransportError::WrongAck);
        }
        let validated = self.validate_source_window(current, &pending.call, &pending.window)?;
        if validated.end != pending.end
            || validated.end_time != pending.end_time
            || validated.decoded_bytes != pending.decoded_bytes
        {
            return Err(TransportError::InvalidWindow);
        }
        let next_bytes = self
            .derived_bytes
            .checked_add(validated.decoded_bytes)
            .ok_or(TransportError::InvalidWindow)?;
        // All potentially refusing checks precede take/progress/history mutation.
        let pending = self.pending.take().ok_or(TransportError::WrongAck)?;
        self.next = pending.end;
        self.next_time = pending.end_time;
        self.derived_bytes = next_bytes;
        if self.commitments.is_some() {
            self.profile_source_progress = Some(ProfileSourceProgress {
                next: self.next,
                end_time: self.next_time,
                derived_bytes: next_bytes,
            });
        }
        self.completed_calls.insert(pending.call.call_id.clone());
        self.last_ack = Some((pending.call, pending.window));
        Ok(())
    }
    /// Generic invented SOURCE count only; never use this as profile coverage or delivery proof.
    pub fn require_complete_source_coverage(
        &self,
        current: &HostCodeBindings,
    ) -> Result<(), TransportError> {
        if current != &self.binding {
            return Err(TransportError::Binding);
        }
        if self.pending.is_some() || self.next != self.frame_count {
            return Err(TransportError::Incomplete);
        }
        Ok(())
    }
    /// Complete bound PROFILE-SOURCE validity only, not pixels, authentic ACKs, SDK submission,
    /// model delivery, temporal/perceptual quality, owner approval or pricing/settlement authority.
    fn require_complete_profile_source_coverage(
        &self,
        current: &HostCodeBindings,
    ) -> Result<(), TransportError> {
        self.require_complete_source_coverage(current)?;
        let source = self.commitments.as_ref().ok_or(TransportError::Binding)?;
        self.require_source_commitments(current, source)?;
        self.require_matching_profile_source_progress()?;
        if self.next_time != source.envelope().duration_us {
            return Err(TransportError::InvalidWindow);
        }
        // Recheck aggregate source bounds; each recorded frame was checked before its source ACK.
        // There is no invented window, authenticated receipt or real delivery here.
        require_source_profile_totals(self, source.envelope(), self.derived_bytes).map(|_| ())
    }
    pub fn next_source_index(&self) -> usize {
        self.next
    }
    pub fn source_window_matches_last_ack(
        &self,
        current: &HostCodeBindings,
        call: &SourceCallCoordinates,
        window: &SourceWindow,
    ) -> bool {
        current == &self.binding
            && self
                .last_ack
                .as_ref()
                .is_some_and(|(original_call, original_window)| {
                    original_call == call && original_window == window
                })
    }
}

/// Pure SOURCE validation shared by the SDK adapter and offline regression tests.
/// It authenticates neither pixels nor admission; the SDK wrapper must still require its issuer.
fn require_source_image_profile(
    transport: &WindowTransportSource,
    window: &SourceWindow,
    envelope: &NativeEnvelopeSource,
) -> Result<(), TransportError> {
    require_source_image_profile_total(transport, window, envelope, transport.derived_bytes)
}
fn require_source_image_profile_total(
    transport: &WindowTransportSource,
    window: &SourceWindow,
    envelope: &NativeEnvelopeSource,
    cumulative_bytes: usize,
) -> Result<(), TransportError> {
    let frame_cap = require_source_profile_totals(transport, envelope, cumulative_bytes)?;
    for image in &window.images {
        if !image_url(&image.data_url) {
            return Err(TransportError::InvalidWindow);
        }
        let timing = envelope
            .frames
            .get(image.ordinal)
            .ok_or(TransportError::InvalidWindow)?;
        if timing.presentation_us != image.presentation_us
            || timing.duration_us != image.duration_us
        {
            return Err(TransportError::InvalidWindow);
        }
        let encoded = image
            .data_url
            .strip_prefix("data:image/png;base64,")
            .ok_or(TransportError::InvalidWindow)?;
        let decoded = encoded.len() / 4 * 3 - (encoded.len() - encoded.trim_end_matches('=').len());
        if decoded > frame_cap {
            return Err(TransportError::InvalidWindow);
        }
    }
    Ok(())
}
fn require_source_profile_totals(
    transport: &WindowTransportSource,
    envelope: &NativeEnvelopeSource,
    cumulative_bytes: usize,
) -> Result<usize, TransportError> {
    envelope.validate_source_bounds()?;
    if transport.frame_count != envelope.frames.len() {
        return Err(TransportError::InvalidWindow);
    }
    let (frame_cap, total_cap) = match envelope.profile {
        NativeProfileSource::Candidate => (1024 * 1024, 8 * 1024 * 1024),
        NativeProfileSource::PacedComplete => (2 * 1024 * 1024, 128 * 1024 * 1024),
    };
    if cumulative_bytes > total_cap {
        return Err(TransportError::InvalidWindow);
    }
    Ok(frame_cap)
}

#[cfg(feature = "native-core")]
pub(crate) mod sdk {
    use super::*;
    use codex_protocol::dynamic_tools::{
        DynamicToolCallOutputContentItem, DynamicToolCallRequest, DynamicToolResponse,
    };
    pub(crate) fn source_transport_for_admission(
        admission: &crate::host_bridge::ProductionAdmission,
        binding: &HostCodeBindings,
        source_sha256: String,
        manifest_sha256: String,
    ) -> Result<WindowTransportSource, TransportError> {
        let source = admission.checked_source(binding).map_err(admission_error)?;
        WindowTransportSource::new(
            binding.clone(),
            source_sha256,
            manifest_sha256,
            source.frame_count(),
        )?
        .bind_source_commitments(source)
    }
    pub(crate) struct PreparedToolResponse {
        binding: HostCodeBindings,
        commitments: crate::host_bridge::SourceAdmissionCommitments,
        call_id: String,
        turn_id: String,
        response: DynamicToolResponse,
    }
    impl PreparedToolResponse {
        pub(crate) fn coordinates_match(
            &self,
            binding: &HostCodeBindings,
            call_id: &str,
            turn_id: &str,
            commitments: &crate::host_bridge::SourceAdmissionCommitments,
        ) -> bool {
            &self.binding == binding
                && self.call_id == call_id
                && self.turn_id == turn_id
                && self
                    .commitments
                    .require_same_source(commitments, binding)
                    .is_ok()
        }
        pub(crate) fn into_sdk_parts(self) -> (String, DynamicToolResponse) {
            (self.call_id, self.response)
        }
    }
    pub(crate) fn frame_index(call: &DynamicToolCallRequest) -> Result<usize, TransportError> {
        if !id(&call.call_id)
            || !id(&call.turn_id)
            || call.namespace.is_some()
            || call.tool != crate::MEDIA_TOOLS[0]
        {
            return Err(TransportError::InvalidCall);
        }
        let object = call
            .arguments
            .as_object()
            .ok_or(TransportError::InvalidCall)?;
        if object.len() != 1 {
            return Err(TransportError::InvalidCall);
        }
        let index = object
            .get("index")
            .and_then(|v| v.as_u64())
            .ok_or(TransportError::InvalidCall)?;
        if index > 899 {
            return Err(TransportError::InvalidCall);
        }
        Ok(index as usize)
    }
    pub(crate) fn validate_scoped_call(
        call: &DynamicToolCallRequest,
        criterion_ids: &[String],
        frame_count: usize,
    ) -> Result<(), TransportError> {
        if call.tool == crate::MEDIA_TOOLS[0] {
            return frame_index(call).and_then(|index| {
                if index < frame_count {
                    Ok(())
                } else {
                    Err(TransportError::InvalidCall)
                }
            });
        }
        if !id(&call.call_id)
            || !id(&call.turn_id)
            || call.namespace.is_some()
            || call.tool != crate::MEDIA_TOOLS[1]
        {
            return Err(TransportError::InvalidCall);
        }
        let args = call
            .arguments
            .as_object()
            .ok_or(TransportError::InvalidCall)?;
        if args.len() != 1 {
            return Err(TransportError::InvalidCall);
        }
        let report = args
            .get("report")
            .and_then(|v| v.as_object())
            .ok_or(TransportError::InvalidCall)?;
        if report.len() != 3
            || !report
                .keys()
                .all(|k| matches!(k.as_str(), "outcome" | "criteria" | "rationale"))
        {
            return Err(TransportError::InvalidCall);
        }
        let outcome = report
            .get("outcome")
            .and_then(|v| v.as_str())
            .ok_or(TransportError::InvalidCall)?;
        if !matches!(outcome, "accept" | "reject") {
            return Err(TransportError::InvalidCall);
        }
        let text = |value: Option<&serde_json::Value>, max: usize| {
            value
                .and_then(|v| v.as_str())
                .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max)
        };
        if !text(report.get("rationale"), 8000) {
            return Err(TransportError::InvalidCall);
        }
        let criteria = report
            .get("criteria")
            .and_then(|v| v.as_array())
            .ok_or(TransportError::InvalidCall)?;
        if criteria.is_empty() || criteria.len() > 64 || criteria.len() != criterion_ids.len() {
            return Err(TransportError::InvalidCall);
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut has_defect = false;
        for criterion in criteria {
            let item = criterion.as_object().ok_or(TransportError::InvalidCall)?;
            if item.len() != 4
                || !item.keys().all(|k| {
                    matches!(
                        k.as_str(),
                        "criterionId" | "outcome" | "observedFrameIndices" | "observation"
                    )
                })
            {
                return Err(TransportError::InvalidCall);
            }
            let criterion_id = item
                .get("criterionId")
                .and_then(|v| v.as_str())
                .ok_or(TransportError::InvalidCall)?;
            if !id(criterion_id)
                || !criterion_ids.iter().any(|id| id == criterion_id)
                || !seen.insert(criterion_id)
            {
                return Err(TransportError::InvalidCall);
            }
            let result = item
                .get("outcome")
                .and_then(|v| v.as_str())
                .ok_or(TransportError::InvalidCall)?;
            if !matches!(result, "pass" | "fail" | "blocked")
                || !text(item.get("observation"), 4000)
            {
                return Err(TransportError::InvalidCall);
            }
            has_defect |= result != "pass";
            let indices = item
                .get("observedFrameIndices")
                .and_then(|v| v.as_array())
                .ok_or(TransportError::InvalidCall)?;
            if indices.is_empty() || indices.len() > 900 {
                return Err(TransportError::InvalidCall);
            }
            let mut observed = std::collections::BTreeSet::new();
            for value in indices {
                let i = value.as_u64().ok_or(TransportError::InvalidCall)?;
                if i >= frame_count as u64 || !observed.insert(i) {
                    return Err(TransportError::InvalidCall);
                }
            }
        }
        if outcome == "accept" && has_defect {
            return Err(TransportError::InvalidCall);
        }
        Ok(())
    }
    pub(crate) fn source_verdict_response(
        admission: &crate::host_bridge::ProductionAdmission,
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        transport: &mut WindowTransportSource,
    ) -> Result<PreparedToolResponse, TransportError> {
        let source = admission.checked_source(binding).map_err(admission_error)?;
        prepare_source_verdict_response(binding, call, transport, source)
    }
    fn admission_error(error: crate::host_bridge::BridgeError) -> TransportError {
        match error {
            crate::host_bridge::BridgeError::RuntimeIssuerUnavailable => {
                TransportError::AdmissionUnavailable
            }
            _ => TransportError::Binding,
        }
    }
    // Private pure SOURCE core. Tests never construct a production admission/host/Stop permit.
    pub(super) fn prepare_source_verdict_response(
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        transport: &mut WindowTransportSource,
        source: &crate::host_bridge::SourceAdmissionCommitments,
    ) -> Result<PreparedToolResponse, TransportError> {
        source
            .validate_source(binding)
            .map_err(|_| TransportError::Binding)?;
        transport.require_source_commitments(binding, source)?;
        if source.frame_count() != transport.frame_count {
            return Err(TransportError::InvalidWindow);
        }
        let criteria = source.criterion_ids();
        validate_scoped_call(call, criteria, transport.frame_count)?;
        if call.tool != crate::MEDIA_TOOLS[1] {
            return Err(TransportError::InvalidCall);
        }
        transport.require_complete_profile_source_coverage(binding)?;
        if transport.source_verdict.is_some() {
            return Err(TransportError::Replay);
        }
        transport.source_verdict = Some(call.arguments.clone());
        // Only source report recording, never UI approval, runtime attestation or settlement.
        Ok(PreparedToolResponse {
            binding: binding.clone(),
            commitments: source.clone(),
            call_id: call.call_id.clone(),
            turn_id: call.turn_id.clone(),
            response: DynamicToolResponse {
                content_items: vec![DynamicToolCallOutputContentItem::InputText {
                    text: "Source verdict recorded; original owner gate and authentic runtime receipts remain required.".into(),
                }],
                success: true,
            },
        })
    }
    /// Convert only an already source-ACKed window; actual authenticated byte validation and
    /// genuine delivery ACK must precede use in a real host. No issuer/runtime permit is minted.
    pub(crate) fn source_image_response(
        admission: &crate::host_bridge::ProductionAdmission,
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        window: &SourceWindow,
        transport: &WindowTransportSource,
    ) -> Result<PreparedToolResponse, TransportError> {
        let source = admission.checked_source(binding).map_err(admission_error)?;
        prepare_source_image_response(binding, call, window, transport, source)
    }
    pub(super) fn prepare_source_image_response(
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        window: &SourceWindow,
        transport: &WindowTransportSource,
        source: &crate::host_bridge::SourceAdmissionCommitments,
    ) -> Result<PreparedToolResponse, TransportError> {
        source
            .validate_source(binding)
            .map_err(|_| TransportError::Binding)?;
        transport.require_source_commitments(binding, source)?;
        let index = frame_index(call)?;
        let coordinates = SourceCallCoordinates {
            call_id: call.call_id.clone(),
            turn_id: call.turn_id.clone(),
            namespace: call.namespace.clone(),
            tool: call.tool.clone(),
        };
        if !transport.source_window_matches_last_ack(binding, &coordinates, window)
            || window.images.first().map(|image| image.ordinal) != Some(index)
            || transport.next != index + window.images.len()
            || !transport.completed_calls.contains(&call.call_id)
        {
            return Err(TransportError::WrongAck);
        }
        require_source_image_profile(transport, window, source.envelope())?;
        let mut content_items = Vec::new();
        for image in &window.images {
            content_items.push(DynamicToolCallOutputContentItem::InputText {
                text: format!(
                    "Frame {}: presentation {}us, duration {}us, digest {}",
                    image.ordinal, image.presentation_us, image.duration_us, image.sha256
                ),
            });
            content_items.push(DynamicToolCallOutputContentItem::InputImage {
                image_url: image.data_url.clone(),
            });
        }
        let response = DynamicToolResponse {
            content_items,
            success: true,
        };
        if serde_json::to_vec(&response)
            .map_err(|_| TransportError::InvalidWindow)?
            .len()
            > 8 * 1024 * 1024
        {
            return Err(TransportError::InvalidWindow);
        }
        Ok(PreparedToolResponse {
            binding: binding.clone(),
            commitments: source.clone(),
            call_id: call.call_id.clone(),
            turn_id: call.turn_id.clone(),
            response,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(PartialEq, Eq)]
    struct SourceStateSnapshot {
        binding: HostCodeBindings,
        commitments: Option<crate::host_bridge::SourceAdmissionCommitments>,
        profile_source_progress: Option<ProfileSourceProgress>,
        source_sha256: String,
        manifest_sha256: String,
        frame_count: usize,
        next: usize,
        next_time: u64,
        derived_bytes: usize,
        pending: Option<(SourceCallCoordinates, SourceWindow, usize, u64, usize)>,
        completed_calls: std::collections::BTreeSet<String>,
        last_ack: Option<(SourceCallCoordinates, SourceWindow)>,
        #[cfg(feature = "native-core")]
        source_verdict: Option<serde_json::Value>,
    }
    fn snapshot(t: &WindowTransportSource) -> SourceStateSnapshot {
        SourceStateSnapshot {
            binding: t.binding.clone(),
            commitments: t.commitments.clone(),
            profile_source_progress: t.profile_source_progress.clone(),
            source_sha256: t.source_sha256.clone(),
            manifest_sha256: t.manifest_sha256.clone(),
            frame_count: t.frame_count,
            next: t.next,
            next_time: t.next_time,
            derived_bytes: t.derived_bytes,
            pending: t.pending.as_ref().map(|p| {
                (
                    p.call.clone(),
                    p.window.clone(),
                    p.end,
                    p.end_time,
                    p.decoded_bytes,
                )
            }),
            completed_calls: t.completed_calls.clone(),
            last_ack: t.last_ack.clone(),
            #[cfg(feature = "native-core")]
            source_verdict: t.source_verdict.clone(),
        }
    }
    fn bound_transport(profile: NativeProfileSource) -> WindowTransportSource {
        let b = binding();
        let source = crate::host_bridge::tests::source_commitments(sixteen_frame_envelope(profile));
        WindowTransportSource::new(b, "1".repeat(64), "2".repeat(64), 16)
            .unwrap()
            .bind_source_commitments(&source)
            .unwrap()
    }
    #[test]
    fn bound_candidate_oversize_refuses_before_pending_and_preserves_entire_state() {
        let b = binding();
        let mut t = bound_transport(NativeProfileSource::Candidate);
        let before = snapshot(&t);
        let w = candidate_timing_window(0, 1, 2 * 1024 * 1024); //1.5MiB fake SOURCE size claim
        assert_eq!(
            t.prepare_source_window(&b, call(0), &w),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&t) == before);
    }
    #[test]
    fn bound_candidate_prospective_cap_refuses_before_second_pending() {
        let b = binding();
        let mut t = bound_transport(NativeProfileSource::Candidate);
        let first = candidate_timing_window(0, 8, 800 * 1024);
        let c = call(0);
        t.prepare_source_window(&b, c.clone(), &first).unwrap();
        t.acknowledge_source_window(&b, &c, &first.window_sha256)
            .unwrap();
        let before = snapshot(&t);
        let second = candidate_timing_window(8, 8, 800 * 1024);
        assert_eq!(
            t.prepare_source_window(&b, call(8), &second),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&t) == before);
        assert_eq!(t.next_source_index(), 8);
    }
    #[test]
    fn bound_canonical_mismatch_refuses_before_pending() {
        let b = binding();
        let mut t = bound_transport(NativeProfileSource::Candidate);
        let before = snapshot(&t);
        // Contiguous generic timing, but does not match frozen250000us Candidate coordinates.
        let w = window(0, 1);
        assert_eq!(
            t.prepare_source_window(&b, call(0), &w),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&t) == before);
    }
    #[test]
    fn malformed_source_pending_cached_end_refuses_before_ack_take() {
        let b = binding();
        let mut t = bound_transport(NativeProfileSource::Candidate);
        let w = candidate_timing_window(0, 1, 4);
        let c = call(0);
        t.prepare_source_window(&b, c.clone(), &w).unwrap();
        // Test-internal SOURCE corruption, not an external mutation API or live escape.
        t.pending.as_mut().unwrap().end += 1;
        let before = snapshot(&t);
        assert_eq!(
            t.acknowledge_source_window(&b, &c, &w.window_sha256),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&t) == before);
    }
    #[test]
    fn wrong_and_malformed_source_acks_preserve_known_pending_and_all_history() {
        let b = binding();
        let w = candidate_timing_window(0, 1, 4);
        let c = call(0);
        for field in 0..8 {
            let mut t = bound_transport(NativeProfileSource::Candidate);
            t.prepare_source_window(&b, c.clone(), &w).unwrap();
            let mut current = b.clone();
            let mut received = c.clone();
            let mut digest = w.window_sha256.clone();
            match field {
                0 => current.media.generation.push('x'),
                1 => received.call_id.push('x'),
                2 => digest = "f".repeat(64),
                3 => t.pending.as_mut().unwrap().end_time += 1,
                4 => t.pending.as_mut().unwrap().decoded_bytes += 1,
                5 => t.pending.as_mut().unwrap().window.images[0].duration_us += 1,
                6 => {
                    t.pending.as_mut().unwrap().window.images[0].data_url =
                        format!("data:image/png;base64,{}", "A".repeat(2 * 1024 * 1024))
                }
                _ => t.pending.as_mut().unwrap().window.images[0].sha256 = "g".repeat(64),
            }
            let before = snapshot(&t);
            assert!(
                t.acknowledge_source_window(&current, &received, &digest)
                    .is_err()
            );
            assert!(snapshot(&t) == before);
        }
    }
    #[test]
    fn exact_candidate_cap_has_profile_source_coverage_not_authenticated_delivery() {
        let b = binding();
        let mut t = bound_transport(NativeProfileSource::Candidate);
        for start in [0, 8] {
            let mut w = candidate_timing_window(start, 8, 4);
            for image in &mut w.images {
                // Valid SOURCE padding for a512KiB size claim, not actual decoded PNG pixels.
                let bytes = 512 * 1024usize;
                let encoded = ((bytes + 2) / 3) * 4;
                let padding = (3 - bytes % 3) % 3;
                image.data_url = format!(
                    "data:image/png;base64,{}{}",
                    "A".repeat(encoded - padding),
                    "=".repeat(padding)
                );
            }
            let c = call(start);
            t.prepare_source_window(&b, c.clone(), &w).unwrap();
            assert!(t.require_complete_profile_source_coverage(&b).is_err());
            t.acknowledge_source_window(&b, &c, &w.window_sha256)
                .unwrap();
        }
        assert_eq!(t.derived_bytes, 8 * 1024 * 1024);
        assert_eq!(t.next_time, 4_000_000);
        t.require_complete_profile_source_coverage(&b).unwrap();
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
        let before = snapshot(&t);
        assert_eq!(
            t.prepare_source_window(&b, call(0), &candidate_timing_window(0, 1, 4)),
            Err(TransportError::Replay)
        );
        assert!(snapshot(&t) == before);
    }
    #[test]
    fn all_bound_profile_frames_are_validated_before_source_ack_coverage() {
        let b = binding();
        for (profile, count, interval) in [
            (NativeProfileSource::Candidate, 16, 250_000),
            (NativeProfileSource::PacedComplete, 360, 33_333),
            (NativeProfileSource::PacedComplete, 900, 33_000),
        ] {
            let (width, height) = match profile {
                NativeProfileSource::Candidate => (640, 360),
                NativeProfileSource::PacedComplete => (960, 540),
            };
            let mut envelope = profile_envelope(profile, width, height, interval);
            envelope.duration_us = count as u64 * interval;
            envelope.frames = (0..count)
                .map(|ordinal| CanonicalFrameTimeSource {
                    ordinal,
                    presentation_us: ordinal as u64 * interval,
                    duration_us: interval,
                })
                .collect();
            let source = crate::host_bridge::tests::source_commitments(envelope);
            let mut t =
                WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), count)
                    .unwrap()
                    .bind_source_commitments(&source)
                    .unwrap();
            for start in (0..count).step_by(32) {
                let mut w = window(start, (count - start).min(32));
                for image in &mut w.images {
                    image.presentation_us = image.ordinal as u64 * interval;
                    image.duration_us = interval;
                }
                let c = call(start);
                t.prepare_source_window(&b, c.clone(), &w).unwrap();
                assert_eq!(t.next_source_index(), start);
                assert!(t.require_complete_profile_source_coverage(&b).is_err());
                let before = snapshot(&t);
                assert_eq!(
                    t.prepare_source_window(&b, call(start + 1), &w),
                    Err(TransportError::Backpressure)
                );
                assert!(snapshot(&t) == before);
                t.acknowledge_source_window(&b, &c, &w.window_sha256)
                    .unwrap();
            }
            assert_eq!(t.next_source_index(), count);
            assert_eq!(t.next_time, count as u64 * interval);
            t.require_complete_profile_source_coverage(&b).unwrap(); //SOURCE bounds/coverage, not model delivery
        }
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    #[test]
    fn unbound_counts_and_corrupted_profile_progress_cannot_be_profile_source_coverage() {
        let b = binding();
        let mut generic =
            WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 1).unwrap();
        let w = window(0, 1);
        let c = call(0);
        generic.prepare_source_window(&b, c.clone(), &w).unwrap();
        generic
            .acknowledge_source_window(&b, &c, &w.window_sha256)
            .unwrap();
        generic.require_complete_source_coverage(&b).unwrap(); // deliberately loose SOURCE counts only
        let before = snapshot(&generic);
        assert_eq!(
            generic.require_complete_profile_source_coverage(&b),
            Err(TransportError::Binding)
        );
        assert!(snapshot(&generic) == before);
        assert!(
            generic
                .bind_source_commitments(&crate::host_bridge::tests::source_commitments(
                    profile_envelope(NativeProfileSource::PacedComplete, 960, 540, 33_333)
                ))
                .is_err()
        );
        for field in 0..3 {
            let mut bound = bound_transport(NativeProfileSource::Candidate);
            match field {
                0 => bound.profile_source_progress.as_mut().unwrap().next = 1,
                1 => bound.profile_source_progress.as_mut().unwrap().end_time = 1,
                _ => {
                    bound
                        .profile_source_progress
                        .as_mut()
                        .unwrap()
                        .derived_bytes = 1
                }
            }
            let before = snapshot(&bound);
            assert_eq!(
                bound.prepare_source_window(&b, call(0), &candidate_timing_window(0, 1, 4)),
                Err(TransportError::InvalidWindow)
            );
            assert!(snapshot(&bound) == before);
        }
    }
    fn profile_envelope(
        profile: NativeProfileSource,
        width: u32,
        height: u32,
        interval: u64,
    ) -> NativeEnvelopeSource {
        NativeEnvelopeSource {
            profile,
            width,
            height,
            source_bytes: 1,
            duration_us: interval,
            audio_channels: 0,
            webm_vp9: true,
            frames: vec![CanonicalFrameTimeSource {
                ordinal: 0,
                presentation_us: 0,
                duration_us: interval,
            }],
        }
    }
    fn sixteen_frame_envelope(profile: NativeProfileSource) -> NativeEnvelopeSource {
        let (width, height) = match profile {
            NativeProfileSource::Candidate => (640, 360),
            NativeProfileSource::PacedComplete => (960, 540),
        };
        let mut e = profile_envelope(profile, width, height, 250_000);
        e.duration_us = 4_000_000;
        e.frames = (0..16)
            .map(|ordinal| CanonicalFrameTimeSource {
                ordinal,
                presentation_us: ordinal as u64 * 250_000,
                duration_us: 250_000,
            })
            .collect();
        e
    }
    fn candidate_timing_window(start: usize, count: usize, encoded_bytes: usize) -> SourceWindow {
        let mut w = window(start, count);
        for image in &mut w.images {
            image.presentation_us = image.ordinal as u64 * 250_000;
            image.duration_us = 250_000;
            // Invented text payload, not actual PNG/media bytes or a trusted delivery receipt.
            image.data_url = format!("data:image/png;base64,{}", "A".repeat(encoded_bytes));
        }
        w
    }
    #[test]
    fn candidate_frame_and_total_caps_cannot_borrow_alternate_paced_profile() {
        let b = binding();
        let candidate = sixteen_frame_envelope(NativeProfileSource::Candidate);
        let paced = sixteen_frame_envelope(NativeProfileSource::PacedComplete);
        candidate.validate_source_bounds().unwrap();
        paced.validate_source_bounds().unwrap();
        let candidate_source = crate::host_bridge::tests::source_commitments(candidate.clone());
        let paced_source = crate::host_bridge::tests::source_commitments(paced.clone());
        let mut t = WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16)
            .unwrap()
            .bind_source_commitments(&candidate_source)
            .unwrap();
        let w = candidate_timing_window(0, 1, 2 * 1024 * 1024); // exactly1.5MiB fake decoded-size claim
        let c = call(0);
        let before = snapshot(&t);
        assert_eq!(
            t.prepare_source_window(&b, c.clone(), &w),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&t) == before);
        assert_eq!(
            require_source_image_profile(&t, &w, &candidate),
            Err(TransportError::InvalidWindow)
        );
        let mut paced_frame = bound_transport(NativeProfileSource::PacedComplete);
        paced_frame
            .prepare_source_window(&b, c.clone(), &w)
            .unwrap();
        paced_frame
            .acknowledge_source_window(&b, &c, &w.window_sha256)
            .unwrap();
        require_source_image_profile(&paced_frame, &w, &paced).unwrap(); // independent SOURCE cap control only
        assert_eq!(
            t.require_source_commitments(&b, &paced_source),
            Err(TransportError::Binding)
        );
        assert_eq!(t.next_source_index(), 0);
        assert!(t.commitments.as_ref() == Some(&candidate_source));

        let mut total = WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16)
            .unwrap()
            .bind_source_commitments(&candidate_source)
            .unwrap();
        for start in [0, 8] {
            let w = candidate_timing_window(start, 8, 800 * 1024); //600KiB/frame; each serialized window<8MiB
            let c = call(start);
            if start == 0 {
                total.prepare_source_window(&b, c.clone(), &w).unwrap();
                total
                    .acknowledge_source_window(&b, &c, &w.window_sha256)
                    .unwrap();
                require_source_image_profile(&total, &w, &candidate).unwrap();
            } else {
                let before = snapshot(&total);
                assert_eq!(
                    total.prepare_source_window(&b, c, &w),
                    Err(TransportError::InvalidWindow)
                );
                assert!(snapshot(&total) == before);
                assert_eq!(total.next_source_index(), 8);
                assert_eq!(
                    total.require_complete_profile_source_coverage(&b),
                    Err(TransportError::Incomplete)
                );
                assert_eq!(
                    total.require_source_commitments(&b, &paced_source),
                    Err(TransportError::Binding)
                );
            }
        }
        let mut paced_total = bound_transport(NativeProfileSource::PacedComplete);
        for start in [0, 8] {
            let w = candidate_timing_window(start, 8, 800 * 1024);
            let c = call(start);
            paced_total
                .prepare_source_window(&b, c.clone(), &w)
                .unwrap();
            paced_total
                .acknowledge_source_window(&b, &c, &w.window_sha256)
                .unwrap();
        }
        assert!(paced_total.derived_bytes > 8 * 1024 * 1024);
        paced_total
            .require_complete_profile_source_coverage(&b)
            .unwrap(); // SOURCE only, no real delivery
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    #[test]
    fn frozen_transport_source_commitment_rejects_valid_replacement_before_state_change() {
        let b = binding();
        let original = crate::host_bridge::tests::source_commitments(sixteen_frame_envelope(
            NativeProfileSource::PacedComplete,
        ));
        let mut alternate_envelope = sixteen_frame_envelope(NativeProfileSource::PacedComplete);
        alternate_envelope.source_bytes = 2;
        alternate_envelope.validate_source_bounds().unwrap();
        let replacement = crate::host_bridge::tests::source_commitments(alternate_envelope);
        let t = WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16)
            .unwrap()
            .bind_source_commitments(&original)
            .unwrap();
        assert_eq!(
            t.require_source_commitments(&b, &replacement),
            Err(TransportError::Binding)
        );
        assert_eq!(t.next_source_index(), 0);
        assert!(t.pending.is_none() && t.completed_calls.is_empty() && t.last_ack.is_none());
        assert!(t.bind_source_commitments(&replacement).is_err());
    }
    #[test]
    fn candidate_undersized_geometry_refuses_without_borrowing_paced_bounds() {
        for (width, height) in [(639, 360), (640, 359), (1, 1)] {
            assert_eq!(
                profile_envelope(NativeProfileSource::Candidate, width, height, 250_000)
                    .validate_source_bounds(),
                Err(TransportError::InvalidWindow)
            );
        }
    }
    #[test]
    fn paced_undersized_geometry_refuses() {
        for (width, height) in [(959, 540), (960, 539), (1, 1)] {
            assert_eq!(
                profile_envelope(NativeProfileSource::PacedComplete, width, height, 33_333)
                    .validate_source_bounds(),
                Err(TransportError::InvalidWindow)
            );
        }
    }
    #[test]
    fn exact_retained_33000us_interval_is_accepted_without_rounding() {
        let envelope = profile_envelope(NativeProfileSource::PacedComplete, 960, 540, 33_000);
        envelope.validate_source_bounds().unwrap();
        assert_eq!(envelope.frames[0].duration_us, 33_000);
        require_lossless_millisecond_mapping(33, 33_000).unwrap();
    }
    #[test]
    fn profile_geometry_and_interval_positive_controls_are_valid_source_only() {
        for (profile, width, height, interval) in [
            (NativeProfileSource::Candidate, 640, 360, 250_000),
            (NativeProfileSource::PacedComplete, 960, 540, 33_333),
            (NativeProfileSource::PacedComplete, 1280, 720, 33_333),
        ] {
            profile_envelope(profile, width, height, interval)
                .validate_source_bounds()
                .unwrap();
        }
        assert!(
            profile_envelope(NativeProfileSource::Candidate, 640, 360, 249_999)
                .validate_source_bounds()
                .is_err()
        );
        assert!(
            profile_envelope(NativeProfileSource::PacedComplete, 960, 540, 32_999)
                .validate_source_bounds()
                .is_err()
        );
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    fn binding() -> HostCodeBindings {
        crate::host_bridge::tests::binding()
    }
    fn call(index: usize) -> SourceCallCoordinates {
        SourceCallCoordinates {
            call_id: format!("fake-call-{index}"),
            turn_id: "fake-turn".into(),
            namespace: None,
            tool: crate::MEDIA_TOOLS[0].into(),
        }
    }
    fn window(start: usize, count: usize) -> SourceWindow {
        SourceWindow {
            source_sha256: "1".repeat(64),
            manifest_sha256: "2".repeat(64),
            window_sha256: format!("{start:064x}"),
            images: (start..start + count)
                .map(|ordinal| SourceImage {
                    ordinal,
                    sha256: format!("{ordinal:064x}"),
                    presentation_us: ordinal as u64 * 33333,
                    duration_us: 33333,
                    data_url: "data:image/png;base64,QUJD".into(),
                })
                .collect(),
        }
    }
    #[test]
    fn twelve_malformed_cases_do_not_advance_or_ack_a_window() {
        for case in 0..12 {
            let b = binding();
            let mut t =
                WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 8).unwrap();
            let mut c = call(0);
            let mut w = window(0, 2);
            let mut current = b.clone();
            match case {
                0 => c.call_id.clear(),
                1 => c.turn_id = "\0bad".into(),
                2 => c.namespace = Some("generic".into()),
                3 => c.tool = "exec_command".into(),
                4 => current.media.generation.push('x'),
                5 => w.source_sha256 = "f".repeat(64),
                6 => w.manifest_sha256 = "f".repeat(64),
                7 => w.images[0].data_url = "https://untrusted.invalid/private".into(),
                8 => w.images[0].ordinal = 1,
                9 => w.images[1].presentation_us += 1,
                10 => w.images[0].sha256 = "g".repeat(64),
                _ => w.images[0].data_url = "data:image/jpeg;base64,QUJD".into(),
            }
            assert!(t.prepare_source_window(&current, c, &w).is_err());
            assert_eq!(t.next_source_index(), 0);
            assert!(t.require_complete_source_coverage(&b).is_err());
        }
    }
    #[test]
    fn all_frames_and_window_ack_precede_source_coverage_not_quality() {
        for total in [16, 360, 900] {
            let b = binding();
            let mut t =
                WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), total)
                    .unwrap();
            let mut batches = 0;
            while t.next_source_index() < total {
                let start = t.next_source_index();
                let w = window(start, (total - start).min(32));
                let c = call(start);
                t.prepare_source_window(&b, c.clone(), &w).unwrap();
                assert_eq!(t.next_source_index(), start);
                assert_eq!(
                    t.prepare_source_window(&b, call(start + 1), &w),
                    Err(TransportError::Backpressure)
                );
                assert!(
                    t.acknowledge_source_window(&b, &c, &"f".repeat(64))
                        .is_err()
                );
                t.acknowledge_source_window(&b, &c, &w.window_sha256)
                    .unwrap();
                assert!(t.prepare_source_window(&b, c.clone(), &w).is_err());
                batches += 1;
            }
            assert_eq!(batches, (total + 31) / 32);
            t.require_complete_source_coverage(&b).unwrap();
            assert_eq!(
                crate::host_bridge::production_issuer_status(),
                Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
            );
        }
    }
    #[test]
    fn canonical_microseconds_and_native_bounds_never_borrow_synthetic_ms_authority() {
        assert!(require_lossless_millisecond_mapping(33, 33333).is_err());
        assert!(require_lossless_millisecond_mapping(34, 33333).is_err());
        require_lossless_millisecond_mapping(250, 250000).unwrap();
        let good = || NativeEnvelopeSource {
            profile: NativeProfileSource::PacedComplete,
            width: 1280,
            height: 720,
            source_bytes: 1,
            duration_us: 33333,
            audio_channels: 0,
            webm_vp9: true,
            frames: vec![CanonicalFrameTimeSource {
                ordinal: 0,
                presentation_us: 0,
                duration_us: 33333,
            }],
        };
        good().validate_source_bounds().unwrap();
        for case in 0..9 {
            let mut envelope = good();
            match case {
                0 => {
                    envelope.duration_us = 30_001_000;
                    envelope.frames[0].duration_us = envelope.duration_us;
                }
                1 => envelope.width = 1281,
                2 => envelope.height = 721,
                3 => envelope.source_bytes = 32 * 1024 * 1024 + 1,
                4 => envelope.audio_channels = 1,
                5 => envelope.webm_vp9 = false,
                6 => envelope.frames[0].presentation_us = 1,
                7 => envelope.frames[0].duration_us = 32999,
                _ => envelope.profile = NativeProfileSource::Candidate,
            }
            assert!(envelope.validate_source_bounds().is_err());
        }
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    #[test]
    fn source_image_snapshot_and_cross_window_timing_are_immutable_after_ack() {
        let b = binding();
        let mut t =
            WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 4).unwrap();
        let original = window(0, 2);
        let c = call(0);
        t.prepare_source_window(&b, c.clone(), &original).unwrap();
        t.acknowledge_source_window(&b, &c, &original.window_sha256)
            .unwrap();
        assert!(t.source_window_matches_last_ack(&b, &c, &original));
        for field in 0..6 {
            let mut changed = original.clone();
            match field {
                0 => changed.images[0].data_url = "data:image/png;base64,REVG".into(),
                1 => changed.images[0].sha256 = "f".repeat(64),
                2 => changed.images[0].presentation_us += 1,
                3 => changed.images[0].duration_us += 1,
                4 => changed.source_sha256 = "f".repeat(64),
                _ => changed.window_sha256 = "f".repeat(64),
            }
            assert!(!t.source_window_matches_last_ack(&b, &c, &changed));
        }
        let mut next = window(2, 2);
        next.images[0].presentation_us += 1;
        assert!(t.prepare_source_window(&b, call(2), &next).is_err());
        assert_eq!(t.next_source_index(), 2);
    }
    #[cfg(feature = "native-core")]
    #[test]
    fn source_verdict_cannot_record_legacy_overcap_or_unbound_count_coverage() {
        let b = binding();
        let source = crate::host_bridge::tests::source_commitments(sixteen_frame_envelope(
            NativeProfileSource::Candidate,
        ));
        let verdict = codex_protocol::dynamic_tools::DynamicToolCallRequest {
            call_id: "fake-source-verdict".into(),
            turn_id: "fake-turn".into(),
            started_at_ms: 0,
            namespace: None,
            tool: crate::MEDIA_TOOLS[1].into(),
            arguments: serde_json::json!({"report":{"outcome":"reject","rationale":"Invented source claim.","criteria":[{"criterionId":"fake-criterion","outcome":"fail","observedFrameIndices":[0],"observation":"Invented source limitation."}]}}),
        };
        let mut legacy = bound_transport(NativeProfileSource::Candidate);
        // Reconstructed legacy SOURCE counters only, never authenticated delivery or admission.
        legacy.next = 16;
        legacy.next_time = 4_000_000;
        legacy.derived_bytes = 16 * 600 * 1024;
        legacy.profile_source_progress = Some(ProfileSourceProgress {
            next: legacy.next,
            end_time: legacy.next_time,
            derived_bytes: legacy.derived_bytes,
        });
        legacy.require_complete_source_coverage(&b).unwrap();
        let before = snapshot(&legacy);
        assert!(matches!(
            sdk::prepare_source_verdict_response(&b, &verdict, &mut legacy, &source),
            Err(TransportError::InvalidWindow)
        ));
        assert!(snapshot(&legacy) == before && legacy.source_verdict.is_none());
        let mut unbound =
            WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16).unwrap();
        for start in [0, 8] {
            let w = candidate_timing_window(start, 8, 4);
            let c = call(start);
            unbound.prepare_source_window(&b, c.clone(), &w).unwrap();
            unbound
                .acknowledge_source_window(&b, &c, &w.window_sha256)
                .unwrap();
        }
        unbound.require_complete_source_coverage(&b).unwrap();
        let before = snapshot(&unbound);
        assert!(matches!(
            sdk::prepare_source_verdict_response(&b, &verdict, &mut unbound, &source),
            Err(TransportError::Binding)
        ));
        assert!(snapshot(&unbound) == before && unbound.source_verdict.is_none());
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    #[cfg(feature = "native-core")]
    #[test]
    fn sdk_source_converter_uses_frozen_profile_and_final_response_provenance() {
        let b = binding();
        let candidate = crate::host_bridge::tests::source_commitments(sixteen_frame_envelope(
            NativeProfileSource::Candidate,
        ));
        let paced = crate::host_bridge::tests::source_commitments(sixteen_frame_envelope(
            NativeProfileSource::PacedComplete,
        ));
        let w = candidate_timing_window(0, 1, 2 * 1024 * 1024);
        let c = call(0);
        let sdk_call = codex_protocol::dynamic_tools::DynamicToolCallRequest {
            call_id: c.call_id.clone(),
            turn_id: c.turn_id.clone(),
            started_at_ms: 0,
            namespace: None,
            tool: crate::MEDIA_TOOLS[0].into(),
            arguments: serde_json::json!({"index":0}),
        };
        let mut candidate_t =
            WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16)
                .unwrap()
                .bind_source_commitments(&candidate)
                .unwrap();
        let before = snapshot(&candidate_t);
        assert_eq!(
            candidate_t.prepare_source_window(&b, c.clone(), &w),
            Err(TransportError::InvalidWindow)
        );
        assert!(snapshot(&candidate_t) == before);
        assert!(matches!(
            sdk::prepare_source_image_response(&b, &sdk_call, &w, &candidate_t, &candidate),
            Err(TransportError::WrongAck)
        ));
        assert!(matches!(
            sdk::prepare_source_image_response(&b, &sdk_call, &w, &candidate_t, &paced),
            Err(TransportError::Binding)
        ));
        assert_eq!(candidate_t.next_source_index(), 0);
        assert!(candidate_t.pending.is_none());

        let mut paced_t = WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 16)
            .unwrap()
            .bind_source_commitments(&paced)
            .unwrap();
        paced_t.prepare_source_window(&b, c.clone(), &w).unwrap();
        paced_t
            .acknowledge_source_window(&b, &c, &w.window_sha256)
            .unwrap();
        let response =
            sdk::prepare_source_image_response(&b, &sdk_call, &w, &paced_t, &paced).unwrap();
        let mut fake_submissions = 0;
        if response.coordinates_match(&b, &c.call_id, &c.turn_id, &candidate) {
            fake_submissions += 1;
        }
        assert_eq!(fake_submissions, 0);
        assert!(response.coordinates_match(&b, &c.call_id, &c.turn_id, &paced));
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
    #[cfg(feature = "native-core")]
    #[test]
    fn pinned_sdk_image_and_verdict_shapes_preserve_ack_timing_and_refuse_mutation() {
        let b = binding();
        let mut t =
            WindowTransportSource::new(b.clone(), "1".repeat(64), "2".repeat(64), 1).unwrap();
        let w = window(0, 1);
        let c = call(0);
        let sdk_call = codex_protocol::dynamic_tools::DynamicToolCallRequest {
            call_id: c.call_id.clone(),
            turn_id: c.turn_id.clone(),
            started_at_ms: 0,
            namespace: None,
            tool: crate::MEDIA_TOOLS[0].into(),
            arguments: serde_json::json!({"index":0}),
        };
        let envelope = NativeEnvelopeSource {
            profile: NativeProfileSource::PacedComplete,
            width: 1280,
            height: 720,
            source_bytes: 1,
            duration_us: 33333,
            audio_channels: 0,
            webm_vp9: true,
            frames: vec![CanonicalFrameTimeSource {
                ordinal: 0,
                presentation_us: 0,
                duration_us: 33333,
            }],
        };
        let source = crate::host_bridge::tests::source_commitments(envelope.clone());
        t = t.bind_source_commitments(&source).unwrap();
        assert!(sdk::prepare_source_image_response(&b, &sdk_call, &w, &t, &source).is_err());
        t.prepare_source_window(&b, c.clone(), &w).unwrap();
        t.acknowledge_source_window(&b, &c, &w.window_sha256)
            .unwrap();
        let prepared = sdk::prepare_source_image_response(&b, &sdk_call, &w, &t, &source).unwrap();
        assert!(prepared.coordinates_match(&b, &c.call_id, &c.turn_id, &source));
        let mut alternate = envelope.clone();
        alternate.source_bytes = 2;
        let alternate_source = crate::host_bridge::tests::source_commitments(alternate);
        assert!(!prepared.coordinates_match(&b, &c.call_id, &c.turn_id, &alternate_source));
        let (_, response) = prepared.into_sdk_parts();
        assert_eq!(response.content_items.len(), 2);
        assert!(
            matches!(&response.content_items[0],codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputText{text} if text.contains("33333us"))
        );
        assert!(
            matches!(&response.content_items[1],codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem::InputImage{image_url} if image_url=="data:image/png;base64,QUJD")
        );
        let mut malformed = w.clone();
        malformed.images[0].data_url = "data:image/png;base64,====".into();
        assert!(
            sdk::prepare_source_image_response(&b, &sdk_call, &malformed, &t, &source).is_err()
        );
        assert!(
            sdk::prepare_source_image_response(&b, &sdk_call, &w, &t, &alternate_source).is_err()
        );
        let verdict = codex_protocol::dynamic_tools::DynamicToolCallRequest {
            call_id: "fake-verdict".into(),
            turn_id: c.turn_id,
            started_at_ms: 0,
            namespace: None,
            tool: crate::MEDIA_TOOLS[1].into(),
            arguments: serde_json::json!({"report":{"outcome":"reject","rationale":"Invented source observation.","criteria":[{"criterionId":"fake-criterion","outcome":"fail","observedFrameIndices":[0],"observation":"Invented source defect."}]}}),
        };
        assert!(
            sdk::prepare_source_verdict_response(&b, &verdict, &mut t, &alternate_source).is_err()
        );
        assert!(t.source_verdict.is_none());
        let response = sdk::prepare_source_verdict_response(&b, &verdict, &mut t, &source).unwrap();
        assert!(response.coordinates_match(&b, &verdict.call_id, &verdict.turn_id, &source));
        assert!(!response.coordinates_match(
            &b,
            &verdict.call_id,
            &verdict.turn_id,
            &alternate_source
        ));
        assert!(t.source_verdict.is_some());
        assert!(sdk::prepare_source_verdict_response(&b, &verdict, &mut t, &source).is_err());
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
}
