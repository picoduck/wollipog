use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use atomic_write_file::AtomicWriteFile;
use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::instances::{canonical_remote_origin, InstanceKind, InstanceProfile, LOCAL_INSTANCE_ID};

pub(crate) const SETTINGS_FILE: &str = "desktop-settings.json";

#[derive(Clone, Default, Deserialize, Serialize)]
pub(crate) struct LocalRunnerSettings {
    pub(crate) runner_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub(crate) struct DesktopSettings {
    pub(crate) tailnet_access: bool,
    pub(crate) local_runner: Option<LocalRunnerSettings>,
    pub(crate) remote_instances: Vec<InstanceProfile>,
    pub(crate) active_instance_id: String,
    pub(crate) pending_remote_deletions: Vec<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            tailnet_access: false,
            local_runner: None,
            remote_instances: Vec::new(),
            active_instance_id: crate::instances::LOCAL_INSTANCE_ID.to_string(),
            pending_remote_deletions: Vec::new(),
        }
    }
}

pub(crate) fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve the Wollipog data directory: {error}"))
}

pub(crate) fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(SETTINGS_FILE))
}

pub(crate) fn read_settings(app: &tauri::AppHandle) -> DesktopSettings {
    read_settings_result(app).unwrap_or_default()
}

pub(crate) fn read_settings_result(app: &tauri::AppHandle) -> Result<DesktopSettings, String> {
    let path = settings_path(app)?;
    read_settings_file_result(&path)
}

pub(crate) fn read_settings_file_result(path: &Path) -> Result<DesktopSettings, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DesktopSettings::default())
        }
        Err(_) => return Err("could not read desktop settings".into()),
    };
    let settings: DesktopSettings = serde_json::from_slice(&bytes).map_err(|_| {
        "desktop settings are corrupted; repair the settings file before making changes".to_string()
    })?;
    validate_settings(&settings)?;
    Ok(settings)
}

fn validate_settings(settings: &DesktopSettings) -> Result<(), String> {
    let mut profile_ids = HashSet::new();
    let mut server_ids = HashSet::new();
    let mut origins = HashSet::new();
    for profile in &settings.remote_instances {
        let canonical = canonical_remote_origin(&profile.origin)
            .map_err(|_| "desktop settings contain an invalid remote instance".to_string())?;
        if profile.kind != InstanceKind::Remote
            || uuid::Uuid::parse_str(&profile.id).is_err()
            || uuid::Uuid::parse_str(&profile.server_instance_id).is_err()
            || profile.label.trim().is_empty()
            || profile.label.len() > 100
            || profile.label.chars().any(char::is_control)
            || profile.origin != canonical.origin
            || chrono::DateTime::parse_from_rfc3339(&profile.created_at).is_err()
            || profile
                .last_connected_at
                .as_ref()
                .is_some_and(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
            || !profile_ids.insert(profile.id.as_str())
            || !server_ids.insert(profile.server_instance_id.as_str())
            || !origins.insert(profile.origin.as_str())
        {
            return Err("desktop settings contain invalid or duplicate remote instances".into());
        }
    }
    if settings.active_instance_id != LOCAL_INSTANCE_ID
        && (uuid::Uuid::parse_str(&settings.active_instance_id).is_err()
            || !profile_ids.contains(settings.active_instance_id.as_str()))
    {
        return Err("desktop settings contain an invalid active instance".into());
    }
    let mut pending_ids = HashSet::new();
    if settings.pending_remote_deletions.iter().any(|profile_id| {
        uuid::Uuid::parse_str(profile_id).is_err()
            || !profile_ids.contains(profile_id.as_str())
            || !pending_ids.insert(profile_id.as_str())
            || settings.active_instance_id == *profile_id
    }) {
        return Err("desktop settings contain an invalid pending instance removal".into());
    }
    Ok(())
}

pub(crate) fn write_settings(
    app: &tauri::AppHandle,
    settings: DesktopSettings,
) -> Result<(), String> {
    write_settings_file(&settings_path(app)?, &settings)
}

pub(crate) fn write_settings_file(path: &Path, settings: &DesktopSettings) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("could not resolve the Wollipog settings directory".into());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create the Wollipog settings directory: {error}"))?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("could not serialize desktop settings: {error}"))?;
    let mut file = AtomicWriteFile::open(path)
        .map_err(|error| format!("could not prepare desktop settings: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("could not save desktop settings: {error}"))?;
    file.commit()
        .map_err(|error| format!("could not commit desktop settings: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_settings_default_to_local_instance() {
        let parsed: DesktopSettings = serde_json::from_str(r#"{"tailnet_access":true}"#).unwrap();
        assert!(parsed.tailnet_access);
        assert_eq!(
            parsed.active_instance_id,
            crate::instances::LOCAL_INSTANCE_ID
        );
        assert!(parsed.remote_instances.is_empty());
    }

    #[test]
    fn settings_file_is_replaced_without_partial_json() {
        let dir = std::env::temp_dir().join(format!("wollipog-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        fs::write(&path, br#"{"tailnet_access":false}"#).unwrap();
        let next = DesktopSettings {
            tailnet_access: true,
            ..DesktopSettings::default()
        };
        write_settings_file(&path, &next).unwrap();
        let parsed = read_settings_file_result(&path).unwrap();
        assert!(parsed.tailnet_access);
        assert_eq!(
            parsed.active_instance_id,
            crate::instances::LOCAL_INSTANCE_ID
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn malformed_settings_fail_closed_for_mutations() {
        let dir =
            std::env::temp_dir().join(format!("wollipog-settings-bad-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SETTINGS_FILE);
        fs::write(&path, b"{broken").unwrap();
        assert!(read_settings_file_result(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{broken");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn serialized_settings_contain_profile_metadata_but_have_no_credential_field() {
        let settings = DesktopSettings {
            remote_instances: vec![InstanceProfile {
                id: uuid::Uuid::new_v4().to_string(),
                server_instance_id: uuid::Uuid::new_v4().to_string(),
                kind: crate::instances::InstanceKind::Remote,
                label: "Remote".into(),
                origin: "https://example.test".into(),
                created_at: "2026-07-21T00:00:00Z".into(),
                last_connected_at: None,
            }],
            ..DesktopSettings::default()
        };
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("https://example.test"));
        assert!(!json.contains("token"));
        assert!(!json.contains("credential"));
        assert!(!json.contains("secret"));
    }

    #[test]
    fn semantic_profile_corruption_is_rejected_before_any_mutation() {
        let duplicate_id = uuid::Uuid::new_v4().to_string();
        let server_id = uuid::Uuid::new_v4().to_string();
        let profile = |origin: &str| InstanceProfile {
            id: duplicate_id.clone(),
            server_instance_id: server_id.clone(),
            kind: crate::instances::InstanceKind::Remote,
            label: "Remote".into(),
            origin: origin.into(),
            created_at: "2026-07-21T00:00:00Z".into(),
            last_connected_at: None,
        };
        let settings = DesktopSettings {
            remote_instances: vec![
                profile("https://one.example.test"),
                profile("https://two.example.test"),
            ],
            ..DesktopSettings::default()
        };
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    fn semantic_active_tombstone_and_timestamp_corruption_is_rejected() {
        let profile_id = uuid::Uuid::new_v4().to_string();
        let profile = InstanceProfile {
            id: profile_id.clone(),
            server_instance_id: uuid::Uuid::new_v4().to_string(),
            kind: crate::instances::InstanceKind::Remote,
            label: "Remote".into(),
            origin: "https://one.example.test".into(),
            created_at: "2026-07-21T00:00:00Z".into(),
            last_connected_at: None,
        };
        let mut settings = DesktopSettings {
            remote_instances: vec![profile],
            active_instance_id: uuid::Uuid::new_v4().to_string(),
            ..DesktopSettings::default()
        };
        assert!(validate_settings(&settings).is_err());

        settings.active_instance_id = LOCAL_INSTANCE_ID.into();
        settings.pending_remote_deletions = vec![profile_id.clone(), profile_id.clone()];
        assert!(validate_settings(&settings).is_err());

        settings.pending_remote_deletions.clear();
        settings.remote_instances[0].created_at = "not-a-timestamp".into();
        assert!(validate_settings(&settings).is_err());
    }
}
