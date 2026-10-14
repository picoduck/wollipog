//! Pure source preparation. There is no executable, provider client, account loader, SDK
//! session start, filesystem/network operation, resume, or live registration in this crate.
//! The optional native-core module must compile against the pinned SDK before use; compiling
//! restrictions is not proof of actual context/namespace isolation, media delivery, or authority.

pub const EXECUTION_IDENTITY: &str = "wollipog-native-media-core-v1";
pub const SDK_REVISION: &str = "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";
pub const MEDIA_TOOLS: [&str; 2] = [
    "review_video_evidence_frame",
    "submit_video_evidence_verdict",
];

#[derive(Clone, PartialEq, Eq)]
pub struct MediaCodeBindings {
    pub execution_identity: String,
    pub sdk_revision: String,
    pub root_session_id: String,
    pub child_session_id: String,
    pub reviewer_session_id: String,
    pub generation: String,
    pub model_id: String,
    pub command_sha256: String,
    pub scope_sha256: String,
    pub namespace_sha256: String,
    pub context_manifest_sha256: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundaryError {
    WrongExecutionIdentity,
    InvalidBinding,
    ReplacementBinding,
    ResumeUnsupported,
    ContextUnverified,
    ConfigurationUnsupported,
    ToolUnavailable,
}

/// A frozen CODE binding, not a grant. Independent real runtime observation must cover ALL
/// context/FS/network/resource/API/control routes before an operator can permit any SDK session.
pub struct MediaCodeBoundary {
    binding: MediaCodeBindings,
}
impl MediaCodeBoundary {
    pub fn new(binding: MediaCodeBindings) -> Result<Self, BoundaryError> {
        if binding.execution_identity != EXECUTION_IDENTITY || binding.sdk_revision != SDK_REVISION
        {
            return Err(BoundaryError::WrongExecutionIdentity);
        }
        let id = |v: &str| !v.is_empty() && v.len() <= 256 && !v.chars().any(char::is_control);
        let digest = |v: &str| {
            v.len() == 64
                && v.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if ![
            &binding.root_session_id,
            &binding.child_session_id,
            &binding.reviewer_session_id,
            &binding.generation,
            &binding.model_id,
        ]
        .iter()
        .all(|v| id(v))
            || binding.root_session_id == binding.child_session_id
            || binding.root_session_id == binding.reviewer_session_id
            || binding.child_session_id == binding.reviewer_session_id
            || ![
                &binding.command_sha256,
                &binding.scope_sha256,
                &binding.namespace_sha256,
                &binding.context_manifest_sha256,
            ]
            .iter()
            .all(|v| digest(v))
        {
            return Err(BoundaryError::InvalidBinding);
        }
        Ok(Self { binding })
    }
    pub fn check_binding(&self, current: &MediaCodeBindings) -> Result<(), BoundaryError> {
        if &self.binding != current {
            return Err(BoundaryError::ReplacementBinding);
        }
        Ok(())
    }
    pub fn check_tool(&self, current: &MediaCodeBindings, name: &str) -> Result<(), BoundaryError> {
        self.check_binding(current)?;
        if !MEDIA_TOOLS.contains(&name) {
            return Err(BoundaryError::ToolUnavailable);
        }
        Ok(())
    }
    pub fn resume(&self) -> Result<(), BoundaryError> {
        // No history-based, cold, warm or fork resume can borrow these startup restrictions.
        Err(BoundaryError::ResumeUnsupported)
    }
    pub fn model_id(&self) -> &str {
        &self.binding.model_id
    }
}

/// These are independent observed routes, not alternative configuration toggles. A missing
/// observation refuses a plan. Disclosed synthetic true values in tests are not real proof.
#[derive(Clone, Copy)]
pub struct RouteExclusionObservations {
    pub context: bool,
    pub filesystem: bool,
    pub network: bool,
    pub resources: bool,
    pub plugins: bool,
    pub other_sessions: bool,
    pub management_api: bool,
    pub provider_context: bool,
    pub private_oracle: bool,
}
impl RouteExclusionObservations {
    pub fn check(&self) -> Result<(), BoundaryError> {
        if ![
            self.context,
            self.filesystem,
            self.network,
            self.resources,
            self.plugins,
            self.other_sessions,
            self.management_api,
            self.provider_context,
            self.private_oracle,
        ]
        .iter()
        .all(|v| *v)
        {
            return Err(BoundaryError::ContextUnverified);
        }
        Ok(())
    }
}

#[cfg(feature = "native-core")]
pub mod native;

pub mod host_bridge;
pub mod host_contract;
pub mod native_cleanup;
pub mod native_transport;
pub mod native_usage;

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> MediaCodeBindings {
        MediaCodeBindings {
            execution_identity: EXECUTION_IDENTITY.into(),
            sdk_revision: SDK_REVISION.into(),
            root_session_id: "synthetic-root".into(),
            child_session_id: "synthetic-child".into(),
            reviewer_session_id: "synthetic-media".into(),
            generation: "synthetic-generation".into(),
            model_id: "gpt-6.1-sol".into(),
            command_sha256: "a".repeat(64),
            scope_sha256: "b".repeat(64),
            namespace_sha256: "c".repeat(64),
            context_manifest_sha256: "d".repeat(64),
        }
    }
    #[test]
    fn code_boundary_is_distinct_and_does_not_permit_resume_or_generic_tools() {
        let binding = fixture();
        let boundary = MediaCodeBoundary::new(binding.clone()).unwrap();
        for name in MEDIA_TOOLS {
            assert_eq!(boundary.check_tool(&binding, name), Ok(()));
        }
        for name in [
            "exec_command",
            "Read",
            "view_image",
            "web.run",
            "resources/read",
            "get_session",
            "attach_session_artifact",
            "run_campaign_review_job",
        ] {
            assert_eq!(
                boundary.check_tool(&binding, name),
                Err(BoundaryError::ToolUnavailable)
            );
        }
        assert_eq!(boundary.resume(), Err(BoundaryError::ResumeUnsupported));
        let mut aliased = binding.clone();
        aliased.execution_identity = "codex-app-server".into();
        assert!(matches!(
            MediaCodeBoundary::new(aliased),
            Err(BoundaryError::WrongExecutionIdentity)
        ));
    }
    #[test]
    fn every_binding_coordinate_is_immutable() {
        let original = fixture();
        let boundary = MediaCodeBoundary::new(original.clone()).unwrap();
        let mut changes = Vec::new();
        macro_rules! change {
            ($field:ident) => {{
                let mut value = original.clone();
                value.$field.push('x');
                changes.push(value);
            }};
        }
        change!(execution_identity);
        change!(sdk_revision);
        change!(root_session_id);
        change!(child_session_id);
        change!(reviewer_session_id);
        change!(generation);
        change!(model_id);
        change!(command_sha256);
        change!(scope_sha256);
        change!(namespace_sha256);
        change!(context_manifest_sha256);
        for changed in changes {
            assert_eq!(
                boundary.check_binding(&changed),
                Err(BoundaryError::ReplacementBinding)
            );
        }
    }
    #[test]
    fn every_namespace_and_context_route_requires_its_own_observation() {
        // Exhaust the complete input domain; only one of 512 combinations covers every route.
        for mask in 0..512 {
            let values: [bool; 9] = std::array::from_fn(|bit| mask & (1 << bit) != 0);
            let observations = RouteExclusionObservations {
                context: values[0],
                filesystem: values[1],
                network: values[2],
                resources: values[3],
                plugins: values[4],
                other_sessions: values[5],
                management_api: values[6],
                provider_context: values[7],
                private_oracle: values[8],
            };
            assert_eq!(
                observations.check(),
                if mask == 511 {
                    Ok(())
                } else {
                    Err(BoundaryError::ContextUnverified)
                }
            );
        }
    }
}
