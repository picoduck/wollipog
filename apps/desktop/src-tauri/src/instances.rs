use std::net::Ipv4Addr;

use chrono::{SecondsFormat, Utc};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

use crate::remote_transport::{probe_remote_instance, RemoteTransport};
use crate::secrets::{
    native_secret_delete, native_secret_get, native_secret_get_optional, native_secret_set,
};
use crate::settings::{read_settings_result, write_settings, DesktopSettings};

pub(crate) const LOCAL_INSTANCE_ID: &str = "local";
pub(crate) const LEGACY_CONTROL_PLANE_SERVICE: &str = "misko-agent-manager-control-plane";
pub(crate) const WOLLIPOG_CONTROL_PLANE_SERVICE: &str = "wollipog-control-plane";
const CONTROL_PLANE_API_VERSION: u32 = 1;
const REQUIRED_CAPABILITY: &str = "remote-instance-v1";
const MAX_ORIGIN_LENGTH: usize = 2048;
const MAX_LABEL_LENGTH: usize = 100;

pub(crate) fn is_control_plane_service(value: &str) -> bool {
    matches!(
        value,
        LEGACY_CONTROL_PLANE_SERVICE | WOLLIPOG_CONTROL_PLANE_SERVICE
    )
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum InstanceKind {
    Local,
    Remote,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceProfile {
    pub(crate) id: String,
    pub(crate) server_instance_id: String,
    pub(crate) kind: InstanceKind,
    pub(crate) label: String,
    pub(crate) origin: String,
    pub(crate) created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_connected_at: Option<String>,
}

impl InstanceProfile {
    fn local() -> Self {
        Self {
            id: LOCAL_INSTANCE_ID.to_string(),
            server_instance_id: LOCAL_INSTANCE_ID.to_string(),
            kind: InstanceKind::Local,
            label: "This Machine".to_string(),
            origin: "http://127.0.0.1:4317".to_string(),
            created_at: String::new(),
            last_connected_at: None,
        }
    }

    pub(crate) fn has_same_stable_configuration(&self, other: &Self) -> bool {
        let Self {
            id,
            server_instance_id,
            kind,
            label,
            origin,
            created_at,
            last_connected_at: _,
        } = self;
        let Self {
            id: other_id,
            server_instance_id: other_server_instance_id,
            kind: other_kind,
            label: other_label,
            origin: other_origin,
            created_at: other_created_at,
            last_connected_at: _,
        } = other;
        id == other_id
            && server_instance_id == other_server_instance_id
            && kind == other_kind
            && label == other_label
            && origin == other_origin
            && created_at == other_created_at
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceRegistrySnapshot {
    profiles: Vec<InstanceProfile>,
    active_instance_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransportSecurity {
    Tls,
    Loopback,
    TailscaleRouteRequired,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CanonicalRemoteOrigin {
    pub(crate) origin: String,
    pub(crate) security: TransportSecurity,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ControlPlaneInstanceInfo {
    pub(crate) service: String,
    pub(crate) instance_id: String,
    pub(crate) display_name: String,
    pub(crate) api_version: u32,
    pub(crate) app_version: String,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Default)]
pub(crate) struct InstanceRegistryState(pub(crate) Mutex<()>);

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn valid_token(value: &str) -> bool {
    (16..=256).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validate_label(label: &str) -> Result<String, String> {
    let label = label.trim();
    if label.is_empty() || label.len() > MAX_LABEL_LENGTH || label.chars().any(char::is_control) {
        return Err("Enter an instance name between 1 and 100 characters.".into());
    }
    Ok(label.to_string())
}

fn cleartext_policy(host: &str) -> Option<TransportSecurity> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host == "[::1]" || host == "::1" {
        return Some(TransportSecurity::Loopback);
    }
    let ip = host.parse::<Ipv4Addr>().ok()?;
    if ip.is_loopback() {
        return Some(TransportSecurity::Loopback);
    }
    let octets = ip.octets();
    (octets[0] == 100 && (64..=127).contains(&octets[1]))
        .then_some(TransportSecurity::TailscaleRouteRequired)
}

pub(crate) fn canonical_remote_origin(raw: &str) -> Result<CanonicalRemoteOrigin, String> {
    if raw.is_empty()
        || raw.len() > MAX_ORIGIN_LENGTH
        || raw != raw.trim()
        || raw.chars().any(char::is_control)
        || raw.contains(['\\', '*', '?', '#'])
    {
        return Err(
            "Enter a complete remote instance address without credentials, query, or fragment."
                .into(),
        );
    }
    let scheme_end = raw
        .find("://")
        .ok_or_else(|| "Enter a complete remote instance address, including //.".to_string())?;
    let authority_start = scheme_end + 3;
    let path_start = raw[authority_start..]
        .find('/')
        .map(|index| authority_start + index);
    let raw_path = path_start.map(|index| &raw[index..]).unwrap_or("");
    if !matches!(raw_path, "" | "/" | "/index.html") {
        return Err("The remote instance address path must be / or /index.html.".into());
    }
    let mut url =
        Url::parse(raw).map_err(|_| "Enter a valid remote instance address.".to_string())?;
    if !raw
        .to_ascii_lowercase()
        .starts_with(&format!("{}://", url.scheme()))
    {
        return Err("Enter a complete remote instance address, including //.".into());
    }
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port() == Some(0)
        || !matches!(url.path(), "" | "/" | "/index.html")
    {
        return Err("The remote instance address is not allowed.".into());
    }
    let host = url.host_str().unwrap().trim_end_matches('.').to_string();
    if url.scheme() == "http" {
        if let Ok(ip) = host.parse::<Ipv4Addr>() {
            let raw_authority = &raw[authority_start..path_start.unwrap_or(raw.len())];
            let raw_host = raw_authority
                .rsplit_once(':')
                .filter(|(_, port)| port.bytes().all(|byte| byte.is_ascii_digit()))
                .map(|(host, _)| host)
                .unwrap_or(raw_authority);
            if raw_host != ip.to_string() {
                return Err(
                    "Use canonical dotted-decimal IPv4 notation for HTTP addresses.".into(),
                );
            }
        }
    }
    url.set_host(Some(&host))
        .map_err(|_| "Enter a valid remote instance host.".to_string())?;
    url.set_path("");
    let security = if url.scheme() == "https" {
        TransportSecurity::Tls
    } else {
        cleartext_policy(url.host_str().unwrap()).ok_or_else(|| {
            "HTTP is allowed only for loopback or a verified literal Tailscale IPv4 address."
                .to_string()
        })?
    };
    Ok(CanonicalRemoteOrigin {
        origin: url.origin().ascii_serialization(),
        security,
    })
}

pub(crate) fn validate_discovery(info: &ControlPlaneInstanceInfo) -> Result<(), String> {
    if !is_control_plane_service(&info.service) {
        return Err("The address is not a Wollipog control plane.".into());
    }
    if info.api_version != CONTROL_PLANE_API_VERSION {
        return Err(format!(
            "This Wollipog control plane uses unsupported API version {}.",
            info.api_version
        ));
    }
    if !info
        .capabilities
        .iter()
        .any(|value| value == REQUIRED_CAPABILITY)
    {
        return Err("This Wollipog control plane does not support remote instances.".into());
    }
    if Uuid::parse_str(&info.instance_id).is_err() {
        return Err("The Wollipog control plane returned an invalid instance identity.".into());
    }
    if info.display_name.len() > 200 || info.app_version.is_empty() || info.app_version.len() > 100
    {
        return Err("The Wollipog control plane returned invalid compatibility metadata.".into());
    }
    Ok(())
}

fn normalized_active_id(settings: &DesktopSettings) -> String {
    if settings.active_instance_id == LOCAL_INSTANCE_ID
        || settings.remote_instances.iter().any(|profile| {
            profile.id == settings.active_instance_id
                && !settings.pending_remote_deletions.contains(&profile.id)
        })
    {
        settings.active_instance_id.clone()
    } else {
        LOCAL_INSTANCE_ID.to_string()
    }
}

fn snapshot(settings: &DesktopSettings) -> InstanceRegistrySnapshot {
    let mut profiles = Vec::with_capacity(settings.remote_instances.len() + 1);
    profiles.push(InstanceProfile::local());
    profiles.extend(
        settings
            .remote_instances
            .iter()
            .filter(|profile| !settings.pending_remote_deletions.contains(&profile.id))
            .cloned(),
    );
    InstanceRegistrySnapshot {
        profiles,
        active_instance_id: normalized_active_id(settings),
    }
}

#[tauri::command]
pub(crate) async fn instance_registry(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
) -> Result<InstanceRegistrySnapshot, String> {
    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    if !settings.pending_remote_deletions.is_empty() {
        for profile_id in settings.pending_remote_deletions.clone() {
            native_secret_delete(profile_id).await?;
        }
        let pending = settings.pending_remote_deletions.clone();
        settings
            .remote_instances
            .retain(|profile| !pending.contains(&profile.id));
        settings.pending_remote_deletions.clear();
        write_settings(&app, settings.clone())?;
    }
    let active = normalized_active_id(&settings);
    if settings.active_instance_id != active {
        settings.active_instance_id = active;
        write_settings(&app, settings.clone())?;
    }
    Ok(snapshot(&settings))
}

#[tauri::command]
pub(crate) async fn add_remote_instance(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    label: String,
    origin: String,
    token: String,
) -> Result<InstanceRegistrySnapshot, String> {
    let label = validate_label(&label)?;
    let endpoint = canonical_remote_origin(&origin)?;
    if !valid_token(&token) {
        return Err("Enter a valid pairing token.".into());
    }
    let token = SecretString::from(token);
    let info = probe_remote_instance(&endpoint, &token).await?;
    validate_discovery(&info)?;

    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    if settings
        .remote_instances
        .iter()
        .any(|profile| profile.origin == endpoint.origin)
    {
        return Err("That remote instance address is already saved.".into());
    }
    if settings
        .remote_instances
        .iter()
        .any(|profile| profile.server_instance_id == info.instance_id)
    {
        return Err("That Wollipog instance is already saved under another address.".into());
    }
    let profile = InstanceProfile {
        id: Uuid::new_v4().to_string(),
        server_instance_id: info.instance_id,
        kind: InstanceKind::Remote,
        label,
        origin: endpoint.origin,
        created_at: now(),
        last_connected_at: Some(now()),
    };
    native_secret_set(profile.id.clone(), token).await?;
    settings.remote_instances.push(profile.clone());
    if let Err(error) = write_settings(&app, settings.clone()) {
        let rollback = native_secret_delete(profile.id.clone()).await;
        return Err(match rollback {
            Ok(()) => error,
            Err(_) => format!("{error} The secure credential rollback also failed."),
        });
    }
    Ok(snapshot(&settings))
}

#[tauri::command]
pub(crate) async fn set_active_instance(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    profile_id: String,
) -> Result<InstanceRegistrySnapshot, String> {
    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    if profile_id != LOCAL_INSTANCE_ID
        && (!settings
            .remote_instances
            .iter()
            .any(|profile| profile.id == profile_id)
            || settings.pending_remote_deletions.contains(&profile_id))
    {
        return Err("The selected Wollipog instance no longer exists.".into());
    }
    settings.active_instance_id = profile_id;
    write_settings(&app, settings.clone())?;
    Ok(snapshot(&settings))
}

#[tauri::command]
pub(crate) async fn edit_remote_instance(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    transport: State<'_, RemoteTransport>,
    profile_id: String,
    label: String,
    origin: String,
    token: Option<String>,
) -> Result<InstanceRegistrySnapshot, String> {
    let label = validate_label(&label)?;
    let endpoint = canonical_remote_origin(&origin)?;
    let expected = {
        let _guard = registry.0.lock().await;
        let settings = read_settings_result(&app)?;
        if settings
            .remote_instances
            .iter()
            .any(|profile| profile.id != profile_id && profile.origin == endpoint.origin)
        {
            return Err("That remote instance address is already saved.".into());
        }
        remote_profile(&settings, &profile_id)?
    };
    let changes_origin = endpoint.origin != expected.origin;
    let supplied_token = if changes_origin {
        let token = token.ok_or_else(|| {
            "Enter a pairing token before changing the remote instance address.".to_string()
        })?;
        if !valid_token(&token) {
            return Err("Enter a valid pairing token.".into());
        }
        Some(SecretString::from(token))
    } else {
        None
    };
    let saved_token;
    let probe_token = if let Some(token) = supplied_token.as_ref() {
        token
    } else {
        saved_token = native_secret_get(profile_id.clone()).await?;
        &saved_token
    };
    let info = probe_remote_instance(&endpoint, probe_token).await?;
    validate_discovery(&info)?;
    if expected.server_instance_id != info.instance_id {
        return Err(
            "That address belongs to a different Wollipog instance. Add it separately.".into(),
        );
    }
    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    unchanged_remote_profile(&settings, &expected, "edited")?;
    if settings
        .remote_instances
        .iter()
        .any(|profile| profile.id != profile_id && profile.origin == endpoint.origin)
    {
        return Err("That remote instance address is already saved.".into());
    }
    let previous_token = if changes_origin {
        Some(native_secret_get(profile_id.clone()).await?)
    } else {
        None
    };
    if let Some(token) = supplied_token {
        native_secret_set(profile_id.clone(), token).await?;
    }
    let profile = settings
        .remote_instances
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "The remote Wollipog instance no longer exists.".to_string())?;
    profile.label = label;
    profile.origin = endpoint.origin;
    profile.last_connected_at = Some(now());
    if let Err(error) = write_settings(&app, settings.clone()) {
        if let Some(previous_token) = previous_token {
            let rollback = native_secret_set(profile_id.clone(), previous_token).await;
            return Err(match rollback {
                Ok(()) => error,
                Err(_) => format!("{error} The secure credential rollback also failed."),
            });
        }
        return Err(error);
    }
    transport.close_profile(&profile_id).await;
    Ok(snapshot(&settings))
}

#[tauri::command]
pub(crate) async fn repair_remote_instance(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    transport: State<'_, RemoteTransport>,
    profile_id: String,
    token: String,
) -> Result<InstanceRegistrySnapshot, String> {
    if !valid_token(&token) {
        return Err("Enter a valid pairing token.".into());
    }
    let expected = {
        let _guard = registry.0.lock().await;
        remote_profile(&read_settings_result(&app)?, &profile_id)?
    };
    let endpoint = canonical_remote_origin(&expected.origin)?;
    let token = SecretString::from(token);
    let info = probe_remote_instance(&endpoint, &token).await?;
    validate_discovery(&info)?;
    if expected.server_instance_id != info.instance_id {
        return Err("The address now belongs to a different Wollipog instance.".into());
    }

    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    unchanged_remote_profile(&settings, &expected, "repaired")?;
    let profile = settings
        .remote_instances
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "The remote Wollipog instance no longer exists.".to_string())?;
    let previous = native_secret_get_optional(profile_id.clone()).await?;
    native_secret_set(profile_id.clone(), token).await?;
    profile.last_connected_at = Some(now());
    if let Err(error) = write_settings(&app, settings.clone()) {
        let rollback = match previous {
            Some(value) => native_secret_set(profile_id.clone(), value).await,
            None => native_secret_delete(profile_id.clone()).await,
        };
        return Err(match rollback {
            Ok(()) => error,
            Err(_) => format!("{error} The secure credential rollback also failed."),
        });
    }
    transport.close_profile(&profile_id).await;
    Ok(snapshot(&settings))
}

#[tauri::command]
pub(crate) async fn remove_remote_instance(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    transport: State<'_, RemoteTransport>,
    profile_id: String,
) -> Result<InstanceRegistrySnapshot, String> {
    if profile_id == LOCAL_INSTANCE_ID {
        return Err("This Machine cannot be removed.".into());
    }
    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)?;
    let previous = settings.clone();
    settings
        .remote_instances
        .iter()
        .position(|profile| profile.id == profile_id)
        .ok_or_else(|| "The remote Wollipog instance no longer exists.".to_string())?;
    if settings.active_instance_id == profile_id {
        settings.active_instance_id = LOCAL_INSTANCE_ID.to_string();
    }
    if !settings.pending_remote_deletions.contains(&profile_id) {
        settings.pending_remote_deletions.push(profile_id.clone());
    }
    write_settings(&app, settings.clone())?;
    transport.close_profile(&profile_id).await;
    if let Err(error) = native_secret_delete(profile_id.clone()).await {
        let rollback = write_settings(&app, previous.clone());
        return Err(match rollback {
            Ok(()) => error,
            Err(_) => format!("{error} The profile-removal rollback also failed."),
        });
    }
    settings
        .remote_instances
        .retain(|profile| profile.id != profile_id);
    settings
        .pending_remote_deletions
        .retain(|id| id != &profile_id);
    write_settings(&app, settings.clone())?;
    Ok(snapshot(&settings))
}

pub(crate) fn remote_profile(
    settings: &DesktopSettings,
    profile_id: &str,
) -> Result<InstanceProfile, String> {
    if settings
        .pending_remote_deletions
        .iter()
        .any(|pending| pending == profile_id)
    {
        return Err("The remote Wollipog instance is being removed.".into());
    }
    settings
        .remote_instances
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "The remote Wollipog instance no longer exists.".to_string())
}

fn unchanged_remote_profile(
    settings: &DesktopSettings,
    expected: &InstanceProfile,
    operation: &str,
) -> Result<(), String> {
    let current = remote_profile(settings, &expected.id)?;
    if !current.has_same_stable_configuration(expected) {
        return Err(format!(
            "The remote instance changed while it was being {operation}. Try again."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_origins_are_canonical_and_fail_closed() {
        let https = canonical_remote_origin("https://Example.COM:443/index.html").unwrap();
        assert_eq!(https.origin, "https://example.com");
        assert_eq!(https.security, TransportSecurity::Tls);
        let tailscale = canonical_remote_origin("http://100.66.16.98:4317/").unwrap();
        assert_eq!(
            tailscale.security,
            TransportSecurity::TailscaleRouteRequired
        );
        let loopback = canonical_remote_origin("http://127.12.0.1:4317").unwrap();
        assert_eq!(loopback.security, TransportSecurity::Loopback);

        for bad in [
            "http://example.com",
            "http://100.63.255.255:4317",
            "http://100.128.0.0:4317",
            concat!("https://user:", "secret@example.com"),
            "https://example.com/?x=1",
            "https://example.com/#pair=secret",
            "https://example.com/admin",
            "https://example.com/admin/../",
            "https://*.example.com",
            " https://example.com",
            "https:example.com",
            "http://0x64421062:4317",
            "http://0144.0102.0020.0142:4317",
        ] {
            assert!(canonical_remote_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn missing_active_profiles_fall_back_to_local() {
        let settings = DesktopSettings {
            active_instance_id: "deleted".into(),
            ..DesktopSettings::default()
        };
        assert_eq!(normalized_active_id(&settings), LOCAL_INSTANCE_ID);
        let view = snapshot(&settings);
        assert_eq!(view.active_instance_id, LOCAL_INSTANCE_ID);
        assert_eq!(view.profiles[0].label, "This Machine");

        let pending_id = Uuid::new_v4().to_string();
        let pending = DesktopSettings {
            active_instance_id: pending_id.clone(),
            pending_remote_deletions: vec![pending_id.clone()],
            remote_instances: vec![InstanceProfile {
                id: pending_id,
                server_instance_id: Uuid::new_v4().to_string(),
                kind: InstanceKind::Remote,
                label: "Deleting".into(),
                origin: "https://example.test".into(),
                created_at: now(),
                last_connected_at: None,
            }],
            ..DesktopSettings::default()
        };
        let view = snapshot(&pending);
        assert_eq!(view.active_instance_id, LOCAL_INSTANCE_ID);
        assert_eq!(view.profiles.len(), 1);
    }

    #[test]
    fn discovery_requires_exact_service_version_capability_and_uuid() {
        let mut info = ControlPlaneInstanceInfo {
            service: LEGACY_CONTROL_PLANE_SERVICE.into(),
            instance_id: Uuid::new_v4().to_string(),
            display_name: "Remote".into(),
            api_version: CONTROL_PLANE_API_VERSION,
            app_version: "0.9.0".into(),
            capabilities: vec![REQUIRED_CAPABILITY.into()],
        };
        assert!(validate_discovery(&info).is_ok());
        info.service = WOLLIPOG_CONTROL_PLANE_SERVICE.into();
        assert!(validate_discovery(&info).is_ok());
        info.service = "other".into();
        assert!(validate_discovery(&info).is_err());
    }

    #[test]
    fn labels_and_pairing_tokens_are_bounded() {
        assert_eq!(validate_label(" Remote ").unwrap(), "Remote");
        assert!(validate_label("").is_err());
        assert!(valid_token("abcdefghijklmnop"));
        assert!(!valid_token("too short"));
        assert!(!valid_token(&"a".repeat(257)));
    }

    #[test]
    fn mutation_fence_ignores_activity_but_rejects_stable_changes_and_pending_removal() {
        let profile = InstanceProfile {
            id: Uuid::new_v4().to_string(),
            server_instance_id: Uuid::new_v4().to_string(),
            kind: InstanceKind::Remote,
            label: "Remote".into(),
            origin: "https://example.test".into(),
            created_at: now(),
            last_connected_at: None,
        };
        let mut settings = DesktopSettings {
            remote_instances: vec![profile.clone()],
            ..DesktopSettings::default()
        };
        assert!(unchanged_remote_profile(&settings, &profile, "opened").is_ok());

        settings.remote_instances[0].last_connected_at = Some("2026-07-29T18:00:00.000Z".into());
        assert!(unchanged_remote_profile(&settings, &profile, "opened").is_ok());

        let mut assert_rejected = |changed: InstanceProfile| {
            settings.remote_instances[0] = changed;
            assert!(unchanged_remote_profile(&settings, &profile, "opened").is_err());
        };

        let mut changed = profile.clone();
        changed.id = Uuid::new_v4().to_string();
        assert_rejected(changed);
        let mut changed = profile.clone();
        changed.server_instance_id = Uuid::new_v4().to_string();
        assert_rejected(changed);
        let mut changed = profile.clone();
        changed.kind = InstanceKind::Local;
        assert_rejected(changed);
        let mut changed = profile.clone();
        changed.label = "Changed".into();
        assert_rejected(changed);
        let mut changed = profile.clone();
        changed.origin = "https://changed.example.test".into();
        assert_rejected(changed);
        let mut changed = profile.clone();
        changed.created_at = "2026-07-29T18:01:00.000Z".into();
        assert_rejected(changed);

        settings.remote_instances[0] = profile.clone();
        settings.pending_remote_deletions.push(profile.id.clone());
        assert!(unchanged_remote_profile(&settings, &profile, "opened").is_err());
    }

    #[test]
    fn overlapping_open_snapshots_survive_each_others_activity_updates() {
        let profile = InstanceProfile {
            id: Uuid::new_v4().to_string(),
            server_instance_id: Uuid::new_v4().to_string(),
            kind: InstanceKind::Remote,
            label: "Remote".into(),
            origin: "https://example.test".into(),
            created_at: "2026-07-29T18:00:00.000Z".into(),
            last_connected_at: None,
        };
        let open_a = profile.clone();
        let open_b = profile.clone();
        let mut settings = DesktopSettings {
            remote_instances: vec![profile],
            ..DesktopSettings::default()
        };

        assert!(unchanged_remote_profile(&settings, &open_a, "opened").is_ok());
        settings.remote_instances[0].last_connected_at = Some("2026-07-29T18:01:00.000Z".into());
        assert!(unchanged_remote_profile(&settings, &open_b, "opened").is_ok());

        settings.remote_instances[0].origin = "https://changed.example.test".into();
        assert!(unchanged_remote_profile(&settings, &open_b, "opened").is_err());
    }
}
