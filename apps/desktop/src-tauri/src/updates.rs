//! #1646: update the desktop app in place from published GitHub releases.
//!
//! The manifest is `latest.json` on the latest PUBLISHED release. GitHub's `releases/latest` never
//! resolves to a draft or a prerelease, so neither is ever offered here; the comparator below
//! refuses a prerelease to a stable build as well, in case the manifest itself is wrong.
//!
//! Three checks stand between a download and an install. The plugin verifies the package against
//! the update public key compiled into this build, and `requireSignedVersion` makes it reject a
//! signature that does not name the announced version, which is what stops a tampered manifest from
//! pairing a new version number with an older signed package. The platform code signature is
//! checked by the OS as usual. And installing restarts the app, which stops the managed control
//! plane and local runner, so the restart goes through the same work-in-flight guard as closing
//! the window: a first attempt while work is live is held and warned about, and the user decides.
//!
//! Some installs cannot be replaced by this process at all. A `.deb` or `.rpm` belongs to the
//! system package manager, and a build without an update key cannot verify anything, so those
//! report the new release and point at its page instead of attempting an install.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::instances::InstanceRegistryState;
use crate::settings::{read_settings, read_settings_result, write_settings, DesktopSettings};

/// Where the release pages live. A new release's page is `<this>/tag/v<version>`.
const RELEASES_URL: &str = "https://github.com/picoduck/wollipog/releases";

/// Set to `1` to turn off every update request, including the manual check, for environments
/// that disallow outbound requests to GitHub.
pub(crate) const DISABLE_UPDATE_CHECK_ENV: &str = "WOLLIPOG_DISABLE_UPDATE_CHECK";

/// The manifest is a few kilobytes; a stalled request should fail and say so.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// The whole package download, which is ~100 MB. Without it a stalled download holds the install
/// lock, and the button, for as long as the connection stays open.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// Emitted with the `UpdateCheck` whenever a check finishes, so an open Settings page shows the
/// result of the background check too. Named here and in `apps/web/src/desktop-updates.ts`.
pub(crate) const UPDATE_CHECKED_EVENT: &str = "wollipog://desktop-update-checked";

/// Whether this installation can replace itself, and if not, why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub(crate) enum InstallMode {
    InPlace,
    ReleasePage { reason: String },
}

/// Decide how an update would be installed, from facts about this build.
///
/// Split from the runtime lookups so each platform's answer is testable on any one of them.
pub(crate) fn install_mode(
    bundle: Option<BundleType>,
    has_update_key: bool,
    appimage_path_known: bool,
) -> InstallMode {
    let release_page = |reason: &str| InstallMode::ReleasePage {
        reason: reason.to_string(),
    };
    if !has_update_key {
        return release_page(
            "This build was not signed for in-place updates. Install the new release from its page.",
        );
    }
    match bundle {
        Some(BundleType::App | BundleType::Dmg | BundleType::Msi | BundleType::Nsis) => {
            InstallMode::InPlace
        }
        // The plugin replaces the file `APPIMAGE` names. Without it the running image is a mount,
        // and there is nothing on disk to replace.
        Some(BundleType::AppImage) if appimage_path_known => InstallMode::InPlace,
        Some(BundleType::AppImage) => release_page(
            "This AppImage is not running from a file Wollipog can replace. Download the new release from its page.",
        ),
        Some(BundleType::Deb) => release_page(
            "This app was installed from a .deb package. Install the new package from the release page.",
        ),
        Some(BundleType::Rpm) => release_page(
            "This app was installed from an .rpm package. Install the new package from the release page.",
        ),
        None => release_page(
            "This build was not installed from a release package. Install the new release from its page.",
        ),
    }
}

/// Whether `candidate` should be offered to a build running `current`.
///
/// Newer only, and never a prerelease to a stable build.
pub(crate) fn offers_update(current: &semver::Version, candidate: &semver::Version) -> bool {
    candidate > current && (candidate.pre.is_empty() || !current.pre.is_empty())
}

pub(crate) fn release_page_url(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{version}")
}

fn update_checks_disabled_by(value: Option<std::ffi::OsString>) -> bool {
    value.is_some_and(|value| {
        let value = value.to_string_lossy();
        let value = value.trim();
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    })
}

fn update_checks_allowed() -> bool {
    !update_checks_disabled_by(std::env::var_os(DISABLE_UPDATE_CHECK_ENV))
}

fn has_update_key(app: &tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|pubkey| pubkey.as_str())
        .is_some_and(|pubkey| !pubkey.trim().is_empty())
}

fn current_install_mode(app: &tauri::AppHandle) -> InstallMode {
    #[cfg(target_os = "linux")]
    let appimage_path_known = app.env().appimage.is_some();
    #[cfg(not(target_os = "linux"))]
    let appimage_path_known = false;
    install_mode(
        tauri::utils::platform::bundle_type(),
        has_update_key(app),
        appimage_path_known,
    )
}

/// The result of the last check, kept so Settings can show it without asking GitHub again.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(crate) enum UpdateCheck {
    Current {
        #[serde(rename = "checkedAt")]
        checked_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        release_url: String,
        checked_at: i64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateStatus {
    current_version: String,
    install: InstallMode,
    automatic_checks: bool,
    checks_allowed: bool,
    releases_url: &'static str,
    last_check: Option<UpdateCheck>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum InstallOutcome {
    /// Nothing newer was published after all.
    Current,
    /// Work is in flight. Nothing was installed; the user was warned and may try again.
    HeldForWork { sessions: usize },
    /// Installed. The app is restarting (Windows: the installer has taken over).
    Restarting,
}

/// A verified package waiting for the user to confirm past a work-in-flight warning.
struct PendingUpdate {
    update: Update,
    bytes: Vec<u8>,
    /// macOS/AppImage: the files are already replaced and only the restart is outstanding, because
    /// work started while they were being replaced.
    installed: bool,
}

#[derive(Default)]
pub(crate) struct DesktopUpdater {
    last_check: Mutex<Option<UpdateCheck>>,
    /// Held for a whole install attempt so two clicks cannot download or install twice.
    pending: tokio::sync::Mutex<Option<PendingUpdate>>,
    /// This gesture's own warning latch. Shared with the close guard's, deferring an install
    /// ("Not Now") would have authorized the next window close without a warning, and the reverse.
    warned_at: Mutex<Option<Instant>>,
    /// Set by the Windows exit hook once it has stopped the managed processes, so a failed installer
    /// launch knows the app it returns to has none.
    services_stopped: AtomicBool,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn fetch_update(app: &tauri::AppHandle) -> Result<Option<Update>, String> {
    if !update_checks_allowed() {
        return Err(format!(
            "Update checks are turned off by {DISABLE_UPDATE_CHECK_ENV}."
        ));
    }
    // Windows: `install` launches the installer and exits this process directly, without
    // `RunEvent::Exit`. The installer would then find the control-plane and runner executables in
    // use, so stop them first, exactly as an ordinary exit does. This replaces the plugin's default
    // hook, which only runs Tauri's own cleanup, so that cleanup is called here too.
    let hook_app = app.clone();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .version_comparator(|current, release| offers_update(&current, &release.version))
        .on_before_exit(move || {
            hook_app
                .state::<DesktopUpdater>()
                .services_stopped
                .store(true, Ordering::Relaxed);
            crate::teardown_managed_processes(&hook_app);
            hook_app.cleanup_before_exit();
        })
        .build()
        .map_err(|error| format!("Could not prepare the update check: {error}"))?;
    updater
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))
}

fn record_check(app: &tauri::AppHandle, update: Option<&Update>) -> UpdateCheck {
    let check = match update {
        Some(update) => UpdateCheck::Available {
            version: update.version.clone(),
            release_url: release_page_url(&update.version),
            checked_at: now_millis(),
        },
        None => UpdateCheck::Current {
            checked_at: now_millis(),
        },
    };
    *app.state::<DesktopUpdater>().last_check.lock().unwrap() = Some(check.clone());
    let _ = app.emit(UPDATE_CHECKED_EVENT, &check);
    check
}

/// Ask the close guard's question under this gesture's own latch. `Some(sessions)` holds.
async fn hold_for_work(app: &tauri::AppHandle) -> Result<Option<usize>, String> {
    let task_app = app.clone();
    tokio::task::spawn_blocking(move || {
        crate::exit_hold_for_work(&task_app, &task_app.state::<DesktopUpdater>().warned_at)
    })
    .await
    .map_err(|error| format!("Could not check for running work: {error}"))
}

#[tauri::command]
pub(crate) fn desktop_update_status(app: tauri::AppHandle) -> DesktopUpdateStatus {
    DesktopUpdateStatus {
        current_version: app.package_info().version.to_string(),
        install: current_install_mode(&app),
        automatic_checks: read_settings(&app).automatic_update_checks,
        checks_allowed: update_checks_allowed(),
        releases_url: RELEASES_URL,
        last_check: app
            .state::<DesktopUpdater>()
            .last_check
            .lock()
            .unwrap()
            .clone(),
    }
}

/// Ask for the latest published release. `automatic` is the background check, which respects the
/// user's setting; a click on "Check for Updates" does not.
#[tauri::command]
pub(crate) async fn check_for_desktop_update(
    app: tauri::AppHandle,
    automatic: Option<bool>,
) -> Result<Option<UpdateCheck>, String> {
    if automatic.unwrap_or(false)
        && (!update_checks_allowed() || !read_settings(&app).automatic_update_checks)
    {
        return Ok(None);
    }
    let update = fetch_update(&app).await?;
    Ok(Some(record_check(&app, update.as_ref())))
}

#[tauri::command]
pub(crate) async fn set_automatic_update_checks(
    app: tauri::AppHandle,
    registry: tauri::State<'_, InstanceRegistryState>,
    enabled: bool,
) -> Result<bool, String> {
    // The settings file is read-modify-written by several commands; this lock is what orders them.
    let _guard = registry.0.lock().await;
    let task_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let previous = read_settings_result(&task_app)?;
        write_settings(
            &task_app,
            DesktopSettings {
                automatic_update_checks: enabled,
                ..previous
            },
        )?;
        Ok(enabled)
    })
    .await
    .map_err(|error| format!("Saving the update setting failed: {error}"))?
}

/// Download, verify, and install the newest release, then restart.
///
/// The package is downloaded and verified BEFORE asking whether work is in flight: the answer is
/// only good for a moment, and a download can take minutes. A held attempt keeps the verified
/// package, so confirming does not download it again.
///
/// The question is asked again after macOS or the AppImage has replaced the files, because work can
/// start while they are being replaced. When the first answer was a confirmation the latch still
/// covers it; when there was no work the first time, new work is warned about like any other, and
/// confirming then only restarts.
#[tauri::command]
pub(crate) async fn install_desktop_update(
    app: tauri::AppHandle,
) -> Result<InstallOutcome, String> {
    if let InstallMode::ReleasePage { reason } = current_install_mode(&app) {
        return Err(reason);
    }
    let updater = app.state::<DesktopUpdater>();
    let mut pending = updater.pending.lock().await;

    let installed = pending.as_ref().is_some_and(|held| held.installed);
    if !installed {
        let update = fetch_update(&app).await?;
        record_check(&app, update.as_ref());
        let Some(mut update) = update else {
            *pending = None;
            return Ok(InstallOutcome::Current);
        };
        let reusable = pending
            .as_ref()
            .is_some_and(|held| held.update.version == update.version);
        if !reusable {
            // The plugin verifies the signature against the compiled-in key, and the signed version
            // against the announced one, before it returns any bytes.
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            let bytes = update.download(|_, _| {}, || {}).await.map_err(|error| {
                format!("The update could not be downloaded and verified: {error}")
            })?;
            *pending = Some(PendingUpdate {
                update,
                bytes,
                installed: false,
            });
        }
    }

    if let Some(sessions) = hold_for_work(&app).await? {
        return Ok(InstallOutcome::HeldForWork { sessions });
    }

    if !installed {
        let PendingUpdate { update, bytes, .. } = pending
            .take()
            .expect("a verified update is pending at this point");
        let task_app = app.clone();
        let (update, result) = tokio::task::spawn_blocking(move || {
            // Windows does not return from here on success; see the exit hook in `fetch_update`.
            let result = update.install(bytes);
            (update, result)
        })
        .await
        .map_err(|error| format!("The update install task failed: {error}"))?;
        if let Err(error) = result {
            return Err(recover_from_failed_install(&task_app, error));
        }
        *pending = Some(PendingUpdate {
            update,
            bytes: Vec::new(),
            installed: true,
        });
        if let Some(sessions) = hold_for_work(&app).await? {
            return Ok(InstallOutcome::HeldForWork { sessions });
        }
    }

    // A restart raises `RunEvent::Exit`, which stops the sidecar and runner before the new process
    // starts. `handle_run_event` does not guard it: it was decided here, and Tauri ignores a
    // prevented restart anyway.
    app.request_restart();
    Ok(InstallOutcome::Restarting)
}

/// Say why an install failed, restarting the app when the failure left it without its services.
///
/// On Windows the exit hook stops the sidecar and runner before the installer is launched, and the
/// shutdown it begins refuses any later respawn. If the launch then fails, the old app is still
/// open with no control plane; restarting it is the only way back.
fn recover_from_failed_install(
    app: &tauri::AppHandle,
    error: tauri_plugin_updater::Error,
) -> String {
    let message = format!("The update could not be installed: {error}");
    if app
        .state::<DesktopUpdater>()
        .services_stopped
        .load(Ordering::Relaxed)
    {
        eprintln!("[desktop] {message}; restarting to recover the managed processes");
        app.request_restart();
        return format!("{message}. Wollipog is restarting.");
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(value: &str) -> semver::Version {
        semver::Version::parse(value).unwrap()
    }

    #[test]
    fn signed_bundles_that_own_their_files_update_in_place() {
        for bundle in [
            BundleType::App,
            BundleType::Dmg,
            BundleType::Msi,
            BundleType::Nsis,
        ] {
            assert_eq!(
                install_mode(Some(bundle), true, false),
                InstallMode::InPlace
            );
        }
        assert_eq!(
            install_mode(Some(BundleType::AppImage), true, true),
            InstallMode::InPlace
        );
    }

    #[test]
    fn package_manager_installs_point_to_the_release_page() {
        for bundle in [BundleType::Deb, BundleType::Rpm] {
            let InstallMode::ReleasePage { reason } =
                install_mode(Some(bundle.clone()), true, true)
            else {
                panic!("{bundle:?} must never be replaced in place");
            };
            assert!(reason.contains("package"), "{reason}");
        }
    }

    #[test]
    fn a_build_without_an_update_key_never_installs() {
        for bundle in [
            Some(BundleType::App),
            Some(BundleType::Msi),
            Some(BundleType::Nsis),
            Some(BundleType::AppImage),
            None,
        ] {
            assert!(matches!(
                install_mode(bundle, false, true),
                InstallMode::ReleasePage { .. }
            ));
        }
    }

    #[test]
    fn an_appimage_without_its_file_or_an_unknown_bundle_is_not_replaced() {
        assert!(matches!(
            install_mode(Some(BundleType::AppImage), true, false),
            InstallMode::ReleasePage { .. }
        ));
        assert!(matches!(
            install_mode(None, true, true),
            InstallMode::ReleasePage { .. }
        ));
    }

    #[test]
    fn only_newer_releases_are_offered_and_never_a_prerelease_to_a_stable_build() {
        assert!(offers_update(&version("0.27.0"), &version("0.28.0")));
        assert!(!offers_update(&version("0.28.0"), &version("0.28.0")));
        assert!(!offers_update(&version("0.28.0"), &version("0.27.0")));
        assert!(!offers_update(&version("0.27.0"), &version("0.28.0-rc.1")));
        assert!(offers_update(
            &version("0.28.0-rc.1"),
            &version("0.28.0-rc.2")
        ));
        assert!(offers_update(&version("0.28.0-rc.1"), &version("0.28.0")));
    }

    #[test]
    fn the_disable_switch_accepts_ordinary_truthy_values_only() {
        use std::ffi::OsString;
        assert!(!update_checks_disabled_by(None));
        for off in ["", "0", "false", "FALSE", " "] {
            assert!(
                !update_checks_disabled_by(Some(OsString::from(off))),
                "{off:?}"
            );
        }
        for on in ["1", "true", "yes"] {
            assert!(
                update_checks_disabled_by(Some(OsString::from(on))),
                "{on:?}"
            );
        }
    }

    #[test]
    fn release_pages_are_addressed_by_tag() {
        assert_eq!(
            release_page_url("0.28.0"),
            "https://github.com/picoduck/wollipog/releases/tag/v0.28.0"
        );
    }

    #[test]
    fn the_shipped_config_pins_the_published_manifest_and_signed_versions() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert_eq!(
            updater["endpoints"],
            serde_json::json!([
                "https://github.com/picoduck/wollipog/releases/latest/download/latest.json"
            ])
        );
        assert_eq!(updater["requireSignedVersion"], true);
        // The key arrives only through the release workflow's overlay; a committed key would make
        // every local `tauri build` demand the private key.
        assert_eq!(updater["pubkey"], "");
        assert_eq!(config["bundle"]["createUpdaterArtifacts"], false);
    }
}
