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
        let (width, height, source_bytes, duration, frames, interval) = match self.profile {
            NativeProfileSource::Candidate => (640, 360, 8 * 1024 * 1024, 4_000_000, 16, 250_000),
            NativeProfileSource::PacedComplete => {
                (1280, 720, 32 * 1024 * 1024, 30_000_000, 900, 33_333)
            }
        };
        if !self.webm_vp9
            || self.audio_channels != 0
            || self.width == 0
            || self.height == 0
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
pub struct WindowTransportSource {
    binding: HostCodeBindings,
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
            || self.next + window.images.len() > self.frame_count
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
        if self
            .derived_bytes
            .checked_add(decoded_bytes)
            .ok_or(TransportError::InvalidWindow)?
            > 128 * 1024 * 1024
        {
            return Err(TransportError::InvalidWindow);
        }
        self.pending = Some(PendingWindow {
            call,
            window: window.clone(),
            end: self.next + window.images.len(),
            end_time: previous_end.ok_or(TransportError::InvalidWindow)?,
            decoded_bytes,
        });
        Ok(())
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
        let pending = self.pending.take().ok_or(TransportError::WrongAck)?;
        self.next = pending.end;
        self.next_time = pending.end_time;
        self.derived_bytes += pending.decoded_bytes;
        self.completed_calls.insert(pending.call.call_id.clone());
        self.last_ack = Some((pending.call, pending.window));
        Ok(())
    }
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

#[cfg(feature = "native-core")]
pub(crate) mod sdk {
    use super::*;
    use codex_protocol::dynamic_tools::{
        DynamicToolCallOutputContentItem, DynamicToolCallRequest, DynamicToolResponse,
    };
    pub(crate) struct PreparedToolResponse {
        binding: HostCodeBindings,
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
        ) -> bool {
            &self.binding == binding && self.call_id == call_id && self.turn_id == turn_id
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
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        criteria: &[String],
        transport: &mut WindowTransportSource,
    ) -> Result<PreparedToolResponse, TransportError> {
        validate_scoped_call(call, criteria, transport.frame_count)?;
        if call.tool != crate::MEDIA_TOOLS[1] {
            return Err(TransportError::InvalidCall);
        }
        transport.require_complete_source_coverage(binding)?;
        if transport.source_verdict.is_some() {
            return Err(TransportError::Replay);
        }
        transport.source_verdict = Some(call.arguments.clone());
        // Only source report recording, never UI approval, runtime attestation or settlement.
        Ok(PreparedToolResponse{binding:binding.clone(),call_id:call.call_id.clone(),turn_id:call.turn_id.clone(),response:DynamicToolResponse{content_items:vec![DynamicToolCallOutputContentItem::InputText{text:"Source verdict recorded; original owner gate and authentic runtime receipts remain required.".into()}],success:true}})
    }
    /// Convert only an already source-ACKed window; actual authenticated byte validation and
    /// genuine delivery ACK must precede use in a real host. No issuer/runtime permit is minted.
    pub(crate) fn source_image_response(
        binding: &HostCodeBindings,
        call: &DynamicToolCallRequest,
        window: &SourceWindow,
        transport: &WindowTransportSource,
        envelope: &NativeEnvelopeSource,
    ) -> Result<PreparedToolResponse, TransportError> {
        envelope.validate_source_bounds()?;
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
        if transport.frame_count != envelope.frames.len() {
            return Err(TransportError::InvalidWindow);
        }
        let (frame_cap, total_cap) = match envelope.profile {
            NativeProfileSource::Candidate => (1024 * 1024, 8 * 1024 * 1024),
            NativeProfileSource::PacedComplete => (2 * 1024 * 1024, 128 * 1024 * 1024),
        };
        if transport.derived_bytes > total_cap {
            return Err(TransportError::InvalidWindow);
        }
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
            let decoded =
                encoded.len() / 4 * 3 - (encoded.len() - encoded.trim_end_matches('=').len());
            if decoded > frame_cap {
                return Err(TransportError::InvalidWindow);
            }
        }
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
            call_id: call.call_id.clone(),
            turn_id: call.turn_id.clone(),
            response,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
                7 => envelope.frames[0].duration_us = 33332,
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
        assert!(sdk::source_image_response(&b, &sdk_call, &w, &t, &envelope).is_err());
        t.prepare_source_window(&b, c.clone(), &w).unwrap();
        t.acknowledge_source_window(&b, &c, &w.window_sha256)
            .unwrap();
        let prepared = sdk::source_image_response(&b, &sdk_call, &w, &t, &envelope).unwrap();
        assert!(prepared.coordinates_match(&b, &c.call_id, &c.turn_id));
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
        assert!(sdk::source_image_response(&b, &sdk_call, &malformed, &t, &envelope).is_err());
        let verdict = codex_protocol::dynamic_tools::DynamicToolCallRequest {
            call_id: "fake-verdict".into(),
            turn_id: c.turn_id,
            started_at_ms: 0,
            namespace: None,
            tool: crate::MEDIA_TOOLS[1].into(),
            arguments: serde_json::json!({"report":{"outcome":"reject","rationale":"Invented source observation.","criteria":[{"criterionId":"fake-criterion","outcome":"fail","observedFrameIndices":[0],"observation":"Invented source defect."}]}}),
        };
        sdk::source_verdict_response(&b, &verdict, &["fake-criterion".into()], &mut t).unwrap();
        assert!(t.source_verdict.is_some());
        assert!(
            sdk::source_verdict_response(&b, &verdict, &["fake-criterion".into()], &mut t).is_err()
        );
        assert_eq!(
            crate::host_bridge::production_issuer_status(),
            Err(crate::host_bridge::BridgeError::RuntimeIssuerUnavailable)
        );
    }
}
