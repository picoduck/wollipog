//! Exact Stop/cleanup SOURCE. No PID, process manager, filesystem deletion or settlement API.
use crate::host_contract::HostCodeBindings;
#[derive(Clone, PartialEq, Eq)]
pub struct OwnedHandleSource {
    pub binding: HostCodeBindings,
    pub sdk_thread_id: String,
    pub dispatch_sha256: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum CleanupSourceError {
    Invalid,
    Binding,
    ReplacementOperation,
    Fenced,
}
#[derive(Debug, PartialEq, Eq)]
pub enum StopSourceReadback {
    PreparedUnknown,
    ExistingUnknown,
}
pub struct CleanupSource {
    original: OwnedHandleSource,
    operation: Option<String>,
    revoked: bool,
    owned_buffers: Vec<Vec<u8>>,
}
impl CleanupSource {
    pub fn new(
        original: OwnedHandleSource,
        owned_buffers: Vec<Vec<u8>>,
    ) -> Result<Self, CleanupSourceError> {
        if original.sdk_thread_id.is_empty()
            || original.sdk_thread_id.len() > 256
            || original.sdk_thread_id.chars().any(char::is_control)
            || original.dispatch_sha256.len() != 64
            || !original
                .dispatch_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(CleanupSourceError::Invalid);
        }
        Ok(Self {
            original,
            operation: None,
            revoked: false,
            owned_buffers,
        })
    }
    pub fn prepare_stop_source(
        &mut self,
        current: &OwnedHandleSource,
        operation: &str,
    ) -> Result<StopSourceReadback, CleanupSourceError> {
        if current != &self.original {
            return Err(CleanupSourceError::Binding);
        }
        if operation.is_empty() || operation.len() > 256 || operation.chars().any(char::is_control)
        {
            return Err(CleanupSourceError::Invalid);
        }
        if let Some(old) = &self.operation {
            return if old == operation {
                Ok(StopSourceReadback::ExistingUnknown)
            } else {
                Err(CleanupSourceError::ReplacementOperation)
            };
        }
        if self.revoked {
            return Err(CleanupSourceError::Fenced);
        }
        self.operation = Some(operation.into());
        Ok(StopSourceReadback::PreparedUnknown)
    }
    pub fn final_handle_matches(&self, current: &OwnedHandleSource) -> bool {
        !self.revoked && self.operation.is_some() && current == &self.original
    }
    pub fn revoke_source_handle(&mut self) {
        self.revoked = true;
    }
    pub fn clear_owned_source_buffers(&mut self) {
        for bytes in &mut self.owned_buffers {
            bytes.fill(0);
            bytes.clear();
        }
        self.owned_buffers.clear();
    }
    pub fn source_buffer_count(&self) -> usize {
        self.owned_buffers.len()
    }
    pub fn capacity_or_cost_settled(&self) -> bool {
        false
    }
}
/// Opaque production intent; no constructor/issuer/test mint. A source Stop description is
/// not this type and cannot reach an eventual SDK shutdown adapter.
pub(crate) struct ProductionStopIntent {
    binding: HostCodeBindings,
    sdk_thread_id: String,
    operation_id: String,
    dispatch_sha256: String,
}
impl ProductionStopIntent {
    pub(crate) fn check(
        &self,
        current: &HostCodeBindings,
        thread_id: &str,
        dispatch: &str,
    ) -> Result<(), crate::host_bridge::BridgeError> {
        if &self.binding != current
            || self.sdk_thread_id != thread_id
            || self.dispatch_sha256 != dispatch
            || self.operation_id.is_empty()
        {
            return Err(crate::host_bridge::BridgeError::InvalidDispatch);
        }
        crate::host_bridge::production_issuer_status()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn handle() -> OwnedHandleSource {
        OwnedHandleSource {
            binding: crate::host_bridge::tests::binding(),
            sdk_thread_id: "fake-thread".into(),
            dispatch_sha256: "f".repeat(64),
        }
    }
    #[test]
    fn eight_stop_cases_keep_exact_unknown_operation_and_only_clear_owned_buffers() {
        for case in 0..8 {
            let h = handle();
            let mut c =
                CleanupSource::new(h.clone(), vec![b"invented-private-marker".to_vec()]).unwrap();
            assert_eq!(
                c.prepare_stop_source(&h, "fake-stop"),
                Ok(StopSourceReadback::PreparedUnknown)
            );
            let mut current = h.clone();
            match case {
                0 => {}
                1 => c.revoke_source_handle(),
                2 => current.sdk_thread_id.push('x'),
                3 => current.binding.media.generation.push('x'),
                4 => current.dispatch_sha256 = "bad".into(),
                5 => {
                    assert_eq!(
                        c.prepare_stop_source(&h, "fake-stop"),
                        Ok(StopSourceReadback::ExistingUnknown)
                    );
                }
                6 => {
                    assert_eq!(
                        c.prepare_stop_source(&h, "replacement"),
                        Err(CleanupSourceError::ReplacementOperation)
                    );
                }
                _ => {
                    assert_eq!(
                        c.prepare_stop_source(&h, "\0bad"),
                        Err(CleanupSourceError::Invalid)
                    );
                }
            }
            assert_eq!(
                c.final_handle_matches(&current),
                !matches!(case, 1 | 2 | 3 | 4)
            );
            assert_eq!(
                c.prepare_stop_source(&h, "fake-stop"),
                Ok(StopSourceReadback::ExistingUnknown)
            );
            c.clear_owned_source_buffers();
            assert_eq!(c.source_buffer_count(), 0);
            assert!(!c.capacity_or_cost_settled());
        }
    }
}
