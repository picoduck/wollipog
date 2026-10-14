//! Release-pinned native startup restriction construction ONLY. Never calls start_thread.
use crate::{BoundaryError, MEDIA_TOOLS, MediaCodeBoundary, RouteExclusionObservations};
use codex_core::{StartThreadOptions, config::Config};
use codex_extension_api::{ExtensionDataInit, SessionIsolation, ToolName, ToolPolicy};
use codex_protocol::{dynamic_tools::DynamicToolSpec, openai_models::ReasoningEffort};

fn restriction_data() -> ExtensionDataInit {
    let mut data = ExtensionDataInit::new();
    data.insert(SessionIsolation::Isolated);
    data.insert(ToolPolicy {
        allowed_tools: Some(
            MEDIA_TOOLS
                .iter()
                .map(|name| ToolName::plain(*name))
                .collect(),
        ),
        require_managed_sandbox: true,
        require_unified_exec: true,
        expose_additional_permissions: false,
    });
    // No explicit inherited extensions/capability roots are added. Isolated core startup uses
    // its empty extension registry and suppresses implicit Apps and executor-discovered MCP.
    data
}

/// Sealed CODE preparation. There is deliberately no getter, execution method, Clone
/// implementation or conversion exposing SDK options or a native control channel.
pub struct RestrictedStartupPreparation {
    _options: StartThreadOptions,
}

#[derive(Debug, PartialEq, Eq)]
pub struct StartupCodeSummary {
    execution_identity: &'static str,
    sdk_revision: &'static str,
    scoped_tools: [&'static str; 2],
    resume_supported: bool,
    runtime_authorized: bool,
}

impl StartupCodeSummary {
    pub fn execution_identity(&self) -> &'static str {
        self.execution_identity
    }
    pub fn sdk_revision(&self) -> &'static str {
        self.sdk_revision
    }
    pub fn scoped_tools(&self) -> [&'static str; 2] {
        self.scoped_tools
    }
    pub fn resume_supported(&self) -> bool {
        self.resume_supported
    }
    pub fn runtime_authorized(&self) -> bool {
        self.runtime_authorized
    }
}

impl RestrictedStartupPreparation {
    pub fn code_summary(&self) -> StartupCodeSummary {
        StartupCodeSummary {
            execution_identity: crate::EXECUTION_IDENTITY,
            sdk_revision: crate::SDK_REVISION,
            scoped_tools: MEDIA_TOOLS,
            resume_supported: false,
            runtime_authorized: false,
        }
    }
}

pub fn prepare_restricted_start(
    config: Config,
    boundary: &MediaCodeBoundary,
    observations: &RouteExclusionObservations,
) -> Result<RestrictedStartupPreparation, BoundaryError> {
    // This validates declared CODE facts, never authenticates runtime measurements or a grant.
    observations.check()?;
    if config.model.as_deref() != Some(boundary.model_id())
        || config.model_reasoning_effort != Some(ReasoningEffort::High)
        || config.base_instructions.is_some()
        || config.developer_instructions.is_some()
        || !config.ephemeral
        || config.feedback_enabled
        || !config.mcp_servers.get().is_empty()
        || config.orchestrator_mcp_enabled
        || config.include_apps_instructions
        || config.include_skill_instructions
        || config.include_collaboration_mode_instructions
    {
        return Err(BoundaryError::ConfigurationUnsupported);
    }
    // Construct NEW options; never accept a caller's retained history, instruction provider,
    // inherited environment, capability registry, client MCP extensions or resume attachment.
    let mut options = StartThreadOptions::new(config);
    options.thread_extension_init = restriction_data();
    options.turn_extension_init = ExtensionDataInit::new();
    options.environments = Some(vec![]);
    options.allow_provider_model_fallback = false;
    options.dynamic_tools =
        serde_json::from_str::<Vec<DynamicToolSpec>>(include_str!("../scoped-tools.json"))
            .map_err(|_| BoundaryError::ConfigurationUnsupported)?;
    Ok(RestrictedStartupPreparation { _options: options })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_pinned_native_policy_denies_builtins_and_keeps_only_scoped_names() {
        let data = restriction_data();
        assert_eq!(
            *data.get::<SessionIsolation>().unwrap(),
            SessionIsolation::Isolated
        );
        let policy = data.get::<ToolPolicy>().unwrap();
        for name in MEDIA_TOOLS {
            assert!(policy.allows(&ToolName::plain(name)));
        }
        for name in [
            "exec",
            "exec_command",
            "shell_command",
            "Read",
            "view_image",
            "apply_patch",
            "web_search",
            "spawn_agent",
            "get_session",
        ] {
            assert!(!policy.allows(&ToolName::plain(name)));
        }
        assert!(!policy.expose_additional_permissions);
        assert!(policy.require_managed_sandbox && policy.require_unified_exec);
    }
}
