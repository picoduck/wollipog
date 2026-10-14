//! Best-effort SDK usage SOURCE, never authoritative billed cost or final settlement.
use crate::host_contract::HostCodeBindings;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageSourceCounters {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: u64,
    pub total: u64,
}
#[derive(Clone, PartialEq, Eq)]
pub struct UsageSourceRecord {
    pub thread_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub root_turn_id: String,
    pub response_id: String,
    pub counters: UsageSourceCounters,
}
#[derive(Debug, PartialEq, Eq)]
pub enum UsageSourceError {
    Binding,
    Invalid,
    ConflictingResponse,
    Nonmonotonic,
}
pub struct UsageSourceLedger {
    binding: HostCodeBindings,
    thread_id: String,
    session_id: String,
    turn_id: String,
    root_turn_id: String,
    records: std::collections::BTreeMap<String, UsageSourceRecord>,
    last: Option<UsageSourceCounters>,
}
impl UsageSourceLedger {
    pub fn new(
        binding: HostCodeBindings,
        thread_id: String,
        session_id: String,
        turn_id: String,
        root_turn_id: String,
    ) -> Self {
        Self {
            binding,
            thread_id,
            session_id,
            turn_id,
            root_turn_id,
            records: Default::default(),
            last: None,
        }
    }
    pub fn record(
        &mut self,
        current: &HostCodeBindings,
        record: UsageSourceRecord,
    ) -> Result<(), UsageSourceError> {
        if current != &self.binding
            || record.thread_id != self.thread_id
            || record.session_id != self.session_id
            || record.turn_id != self.turn_id
            || record.root_turn_id != self.root_turn_id
        {
            return Err(UsageSourceError::Binding);
        }
        if record.response_id.is_empty()
            || record.response_id.len() > 256
            || record.response_id.chars().any(char::is_control)
            || record.counters.cache_read > record.counters.input
            || record.counters.reasoning > record.counters.output
        {
            return Err(UsageSourceError::Invalid);
        }
        if let Some(old) = self.records.get(&record.response_id) {
            return if old == &record {
                Ok(())
            } else {
                Err(UsageSourceError::ConflictingResponse)
            };
        }
        if self.last.as_ref().is_some_and(|old| {
            record.counters.input < old.input
                || record.counters.cache_read < old.cache_read
                || record.counters.cache_write < old.cache_write
                || record.counters.output < old.output
                || record.counters.reasoning < old.reasoning
                || record.counters.total < old.total
        }) {
            return Err(UsageSourceError::Nonmonotonic);
        }
        self.last = Some(record.counters.clone());
        self.records.insert(record.response_id.clone(), record);
        Ok(())
    }
    pub fn source_record_count(&self) -> usize {
        self.records.len()
    }
    pub fn final_priced_usage_proven(&self) -> bool {
        false
    }
}
#[cfg(feature = "native-core")]
pub(crate) fn from_sdk_record(
    record: &codex_protocol::protocol::TokenUsageRecord,
) -> Result<UsageSourceRecord, UsageSourceError> {
    let u = &record.thread_token_usage;
    let nonnegative = |v: i64| u64::try_from(v).map_err(|_| UsageSourceError::Invalid);
    Ok(UsageSourceRecord {
        thread_id: record.thread_id.to_string(),
        session_id: record.session_id.to_string(),
        turn_id: record.turn_id.clone(),
        root_turn_id: record.root_turn_id.clone(),
        response_id: record.response_id.clone(),
        counters: UsageSourceCounters {
            input: nonnegative(u.input_tokens)?,
            cache_read: nonnegative(u.cached_input_tokens)?,
            cache_write: nonnegative(u.cache_write_input_tokens)?,
            output: nonnegative(u.output_tokens)?,
            reasoning: nonnegative(u.reasoning_output_tokens)?,
            total: nonnegative(u.total_tokens)?,
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> UsageSourceRecord {
        UsageSourceRecord {
            thread_id: "fake-thread".into(),
            session_id: "fake-sdk-session".into(),
            turn_id: "fake-turn".into(),
            root_turn_id: "fake-root-turn".into(),
            response_id: "fake-response".into(),
            counters: UsageSourceCounters {
                input: 10,
                cache_read: 2,
                cache_write: 1,
                output: 4,
                reasoning: 1,
                total: 14,
            },
        }
    }
    #[test]
    fn eight_usage_cases_preserve_history_and_never_claim_pricing_or_finality() {
        for case in 0..8 {
            let b = crate::host_bridge::tests::binding();
            let mut l = UsageSourceLedger::new(
                b.clone(),
                "fake-thread".into(),
                "fake-sdk-session".into(),
                "fake-turn".into(),
                "fake-root-turn".into(),
            );
            let first = record();
            l.record(&b, first.clone()).unwrap();
            let mut next = first.clone();
            next.response_id = "fake-next".into();
            let mut current = b.clone();
            match case {
                0 => next.counters.input += 1,
                1 => next.response_id.clear(),
                2 => next.counters.cache_read = 100,
                3 => next.counters.cache_write += 1,
                4 => next.counters.input = 9,
                5 => next = first.clone(),
                6 => {
                    next.response_id = first.response_id.clone();
                    next.counters.input += 1;
                }
                _ => current.media.generation.push('x'),
            }
            let result = l.record(&current, next);
            if matches!(case, 0 | 3 | 5) {
                assert!(result.is_ok())
            } else {
                assert!(result.is_err())
            }
            assert!(!l.final_priced_usage_proven());
            let mut wrong_root = record();
            wrong_root.response_id = "fake-other-root".into();
            wrong_root.root_turn_id.push('x');
            assert_eq!(l.record(&b, wrong_root), Err(UsageSourceError::Binding));
            assert_eq!(
                l.source_record_count(),
                if matches!(case, 0 | 3) { 2 } else { 1 }
            );
        }
    }
}
