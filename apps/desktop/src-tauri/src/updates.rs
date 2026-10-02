//! #1646: update the desktop app in place from published GitHub releases.
//!
//! Stable updates use `releases/latest/download/latest.json`. An explicit prerelease opt-in
//! discovers published releases through GitHub's API and selects the highest semantic version
//! carrying an update manifest. Both channels reject drafts and downgrades and use the same
//! signature verification and work-in-flight guard.
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

use serde::{Deserialize, Serialize};
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
pub(crate) const UPDATE_CHANNEL_CHANGED_EVENT: &str = "wollipog://desktop-update-channel-changed";

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
/// Newer only. A prerelease requires explicit opt-in regardless of the installed version.
pub(crate) fn offers_update(
    current: &semver::Version,
    candidate: &semver::Version,
    prerelease_updates: bool,
) -> bool {
    candidate.cmp_precedence(current).is_gt() && (candidate.pre.is_empty() || prerelease_updates)
}

#[derive(Deserialize)]
struct PublishedRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<ReleaseAsset>,
}

#[derive(Deserialize)]
struct ReleaseAsset {
    name: String,
    state: String,
    size: u64,
}

impl PublishedRelease {
    fn update_version(&self, prerelease_updates: bool) -> Option<semver::Version> {
        if self.draft || self.published_at.is_none() || (self.prerelease && !prerelease_updates) {
            return None;
        }
        let version = semver::Version::parse(self.tag_name.strip_prefix('v')?).ok()?;
        // Build metadata does not order updates and is not part of the release tag contract.
        if !version.build.is_empty() || (!version.pre.is_empty() && !prerelease_updates) {
            return None;
        }
        self.assets
            .iter()
            .any(|asset| asset.name == "latest.json" && asset.state == "uploaded" && asset.size > 0)
            .then_some(version)
    }
}

/// Do not trust API ordering: publishing an older maintenance release must not hide a newer RC.
fn newest_release(
    releases: &[PublishedRelease],
    current: &semver::Version,
    prerelease_updates: bool,
) -> Option<semver::Version> {
    releases
        .iter()
        .filter_map(|release| release.update_version(prerelease_updates))
        .filter(|version| offers_update(current, version, prerelease_updates))
        .max_by(semver::Version::cmp_precedence)
}

/// Discover every page within the check deadline. A truncated history is an error, never "current".
async fn discover_release(
    api_url: &str,
    current: &semver::Version,
    prerelease_updates: bool,
) -> Result<Option<semver::Version>, String> {
    let client = reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .user_agent("Wollipog-Desktop-Updater")
        .build()
        .map_err(|_| "Could not prepare release discovery.".to_string())?;
    let mut newest: Option<semver::Version> = None;
    for page in 1..=100 {
        let mut endpoint = url::Url::parse(api_url)
            .map_err(|_| "Could not prepare the release discovery URL.".to_string())?;
        endpoint
            .query_pairs_mut()
            .append_pair("per_page", "100")
            .append_pair("page", &page.to_string());
        let mut response = client
            .get(endpoint)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|_| "Could not reach GitHub to discover releases.".to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "Could not discover releases: GitHub returned HTTP {}.",
                response.status().as_u16()
            ));
        }
        let has_next = response
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("rel=\"next\""));
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Could not read GitHub releases.".to_string())?
        {
            if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
                return Err("GitHub release discovery exceeded the response size limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let releases: Vec<PublishedRelease> = serde_json::from_slice(&bytes)
            .map_err(|_| "GitHub returned invalid release metadata.".to_string())?;
        if let Some(candidate) = newest_release(&releases, current, prerelease_updates) {
            if newest
                .as_ref()
                .is_none_or(|previous| candidate.cmp_precedence(previous).is_gt())
            {
                newest = Some(candidate);
            }
        }
        if !has_next {
            return Ok(newest);
        }
    }
    Err("GitHub release discovery exceeded the page limit.".into())
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
        #[serde(rename = "prereleaseUpdates")]
        prerelease_updates: bool,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        version: String,
        release_url: String,
        checked_at: i64,
        prerelease_updates: bool,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopUpdateStatus {
    current_version: String,
    install: InstallMode,
    automatic_checks: bool,
    prerelease_updates: bool,
    checks_allowed: bool,
    releases_url: &'static str,
    last_check: Option<UpdateCheck>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum InstallOutcome {
    /// Nothing newer was published after all.
    Current,
    /// Work is in flight. Nothing was installed; the user was warned and may try again. `sessions`
    /// is 0 when the control plane could not say. `session_ids` names the sessions it could (#1975),
    /// as the close event does: ids only, so the dashboard's confirmation takes their titles from the
    /// local instance it has loaded.
    HeldForWork {
        sessions: usize,
        #[serde(rename = "sessionIds")]
        session_ids: Vec<String>,
    },
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
    /// A channel change cannot race a check, download, or held install.
    operation: tokio::sync::Mutex<()>,
    /// Held for a whole install attempt so two clicks cannot download or install twice.
    pending: tokio::sync::Mutex<Option<PendingUpdate>>,
    /// This gesture's own warning latch. Shared with the close guard's, deferring an install
    /// ("Install Later") would have authorized the next window close without a warning, and the reverse.
    warned_at: Mutex<Option<Instant>>,
    /// Set when a held install asked the dashboard to confirm (#2065), and spent by Restart Anyway.
    ///
    /// Without it a confirmation was only good while `warned_at` was inside the close guard's grace
    /// period, so a dialog left open longer was held and asked again. Like the close guard's
    /// `confirmation_requested` (#1965), it answers the question however long the dialog was open,
    /// and only a held install can ask it.
    confirmation_requested: AtomicBool,
    /// Set by the Windows exit hook once it has stopped the managed processes, so a failed installer
    /// launch knows the app it returns to has none.
    services_stopped: AtomicBool,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn fetch_update(app: &tauri::AppHandle, entry_point: &str) -> Result<Option<Update>, String> {
    if !update_checks_allowed() {
        return Err(format!(
            "Update checks are turned off by {DISABLE_UPDATE_CHECK_ENV}."
        ));
    }
    let prerelease_updates = read_settings_result(app)?.prerelease_updates;
    let request_id = uuid::Uuid::new_v4();
    let started = Instant::now();
    let result = tokio::time::timeout(CHECK_TIMEOUT, fetch_channel_update(app, prerelease_updates))
        .await
        .unwrap_or_else(|_| Err("The update check timed out. Try again later.".into()));
    eprintln!(
        "{}",
        serde_json::json!({
            "event": "desktop_update_check", "requestId": request_id, "entryPoint": entry_point,
            "channel": if prerelease_updates { "prerelease" } else { "stable" },
            "outcome": match &result { Ok(Some(_)) => "available", Ok(None) => "current", Err(_) => "failed" },
            "candidateVersion": result.as_ref().ok().and_then(|update| update.as_ref()).map(|update| &update.version),
            "durationMs": started.elapsed().as_millis(),
        })
    );
    result
}

async fn fetch_channel_update(
    app: &tauri::AppHandle,
    prerelease_updates: bool,
) -> Result<Option<Update>, String> {
    let expected_version = if prerelease_updates {
        let candidate = discover_release(
            "https://api.github.com/repos/picoduck/wollipog/releases",
            &app.package_info().version,
            true,
        )
        .await?;
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        Some(candidate)
    } else {
        None
    };
    let mismatch = std::sync::Arc::new(AtomicBool::new(false));
    let comparator_mismatch = mismatch.clone();
    let expected = expected_version.clone();
    // Windows: `install` launches the installer and exits this process directly, without
    // `RunEvent::Exit`. The installer would then find the control-plane and runner executables in
    // use, so stop them first, exactly as an ordinary exit does. This replaces the plugin's default
    // hook, which only runs Tauri's own cleanup, so that cleanup is called here too.
    let hook_app = app.clone();
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .version_comparator(move |current, release| {
            if expected
                .as_ref()
                .is_some_and(|version| version != &release.version)
            {
                comparator_mismatch.store(true, Ordering::Relaxed);
                return false;
            }
            offers_update(&current, &release.version, prerelease_updates)
        })
        .on_before_exit(move || {
            hook_app
                .state::<DesktopUpdater>()
                .services_stopped
                .store(true, Ordering::Relaxed);
            crate::teardown_managed_processes(&hook_app);
            hook_app.cleanup_before_exit();
        });
    if let Some(version) = expected_version {
        let endpoint = format!("{RELEASES_URL}/download/v{version}/latest.json")
            .parse()
            .map_err(|_| "Could not prepare the release manifest URL.".to_string())?;
        builder = builder
            .endpoints(vec![endpoint])
            .map_err(|error| format!("Could not prepare the release endpoint: {error}"))?;
    }
    let updater = builder
        .build()
        .map_err(|error| format!("Could not prepare the update check: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    if mismatch.load(Ordering::Relaxed) {
        return Err("The update manifest version does not match its release tag.".into());
    }
    Ok(update)
}

fn record_check(app: &tauri::AppHandle, update: Option<&Update>) -> UpdateCheck {
    let prerelease_updates = read_settings(app).prerelease_updates;
    let check = match update {
        Some(update) => UpdateCheck::Available {
            version: update.version.clone(),
            release_url: release_page_url(&update.version),
            checked_at: now_millis(),
            prerelease_updates,
        },
        None => UpdateCheck::Current {
            checked_at: now_millis(),
            prerelease_updates,
        },
    };
    *app.state::<DesktopUpdater>().last_check.lock().unwrap() = Some(check.clone());
    let _ = app.emit(UPDATE_CHECKED_EVENT, &check);
    check
}

/// Only an explicit confirmation may ride a recent warning.
///
/// The latch alone let any install request within the grace period through: a second, concurrent
/// request from the other surface (Settings and the toast), or a plain "Install and Restart" right
/// after "Install Later", restarted over live work without anyone choosing "Restart Anyway".
fn forget_unconfirmed_warning(latch: &Mutex<Option<Instant>>, confirmed: bool) {
    if !confirmed {
        *latch.lock().unwrap() = None;
    }
}

/// Record that a held install has asked the dashboard to confirm, for Restart Anyway to spend.
fn request_install_confirmation(updater: &DesktopUpdater) {
    updater
        .confirmation_requested
        .store(true, Ordering::Relaxed);
}

/// Whether this request is the Restart Anyway a held install asked for, spending that request.
///
/// Only a confirmed request spends it, so a plain "Install and Restart" from either surface is asked
/// afresh and leaves an open dialog's answer in place. A confirmed request with nothing to spend
/// goes through `hold_for_work` as before.
fn take_install_confirmation(updater: &DesktopUpdater, confirmed: bool) -> bool {
    confirmed
        && updater
            .confirmation_requested
            .swap(false, Ordering::Relaxed)
}

/// Ask the close guard's question under this gesture's own latch. `Some(outcome)` holds, and asks
/// the dashboard to confirm.
async fn hold_for_work(
    app: &tauri::AppHandle,
    confirmed: bool,
) -> Result<Option<InstallOutcome>, String> {
    let task_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let updater = task_app.state::<DesktopUpdater>();
        forget_unconfirmed_warning(&updater.warned_at, confirmed);
        let work = crate::exit_hold_for_work(&task_app, &updater.warned_at)?;
        request_install_confirmation(&updater);
        Some(InstallOutcome::HeldForWork {
            sessions: work.count,
            session_ids: work.session_ids,
        })
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
        prerelease_updates: read_settings(&app).prerelease_updates,
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
    let updater = app.state::<DesktopUpdater>();
    let _operation = updater.operation.lock().await;
    if automatic.unwrap_or(false)
        && (!update_checks_allowed() || !read_settings(&app).automatic_update_checks)
    {
        return Ok(None);
    }
    let update = fetch_update(
        &app,
        if automatic.unwrap_or(false) {
            "background"
        } else {
            "manual"
        },
    )
    .await?;
    Ok(Some(record_check(&app, update.as_ref())))
}

#[tauri::command]
pub(crate) async fn set_prerelease_updates(
    app: tauri::AppHandle,
    registry: tauri::State<'_, InstanceRegistryState>,
    enabled: bool,
) -> Result<DesktopUpdateStatus, String> {
    let updater = app.state::<DesktopUpdater>();
    let _operation = updater.operation.lock().await;
    let mut pending = updater.pending.lock().await;
    if pending.as_ref().is_some_and(|update| update.installed) {
        return Err(
            "Restart to finish installing the update before changing update channels.".into(),
        );
    }
    let _settings = registry.0.lock().await;
    let task_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let previous = read_settings_result(&task_app)?;
        write_settings(
            &task_app,
            DesktopSettings {
                prerelease_updates: enabled,
                ..previous
            },
        )
    })
    .await
    .map_err(|error| format!("Saving the update channel failed: {error}"))??;
    *pending = None;
    *updater.last_check.lock().unwrap() = None;
    updater
        .confirmation_requested
        .store(false, Ordering::Relaxed);
    *updater.warned_at.lock().unwrap() = None;
    let status = desktop_update_status(app.clone());
    let _ = app.emit(UPDATE_CHANNEL_CHANGED_EVENT, &status);
    eprintln!(
        "{}",
        serde_json::json!({"event": "desktop_update_channel_changed", "requestId": uuid::Uuid::new_v4(), "entryPoint": "settings", "channel": if enabled { "prerelease" } else { "stable" }})
    );
    Ok(status)
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
/// `confirmed` is the "Restart Anyway" answer to this gesture's own warning. It installs without
/// asking again when a held install asked for it (#2065), however long the dialog was open, and
/// spends that request. Anything else is asked afresh, except that a confirmation with no request to
/// spend still rides the warning within its grace period, as it always has.
///
/// The question is asked again after macOS or the AppImage has replaced the files, because work can
/// start while they are being replaced. A spent request or the latch covers a confirmation; when
/// there was no work the first time, new work is warned about like any other, and confirming then
/// only restarts.
#[tauri::command]
pub(crate) async fn install_desktop_update(
    app: tauri::AppHandle,
    confirmed: Option<bool>,
) -> Result<InstallOutcome, String> {
    let confirmed = confirmed.unwrap_or(false);
    if let InstallMode::ReleasePage { reason } = current_install_mode(&app) {
        return Err(reason);
    }
    let updater = app.state::<DesktopUpdater>();
    let _operation = updater.operation.lock().await;
    let mut pending = updater.pending.lock().await;

    let installed = pending.as_ref().is_some_and(|held| held.installed);
    if !installed {
        let update = fetch_update(&app, "install").await?;
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

    // Spent only here, once the package is in hand: a failed check or download leaves the dialog
    // open with its question still answerable.
    let answered = take_install_confirmation(&updater, confirmed);
    if !answered {
        if let Some(held) = hold_for_work(&app, confirmed).await? {
            return Ok(held);
        }
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
        // A spent request answered this whole request. Otherwise the latch says what it was told: a
        // confirmation still covers it, and an unconfirmed request that found no work has nothing
        // in it.
        if !answered {
            if let Some(held) = hold_for_work(&app, true).await? {
                return Ok(held);
            }
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
    fn stable_channel_requires_opt_in_even_when_running_a_prerelease() {
        assert!(offers_update(&version("0.27.0"), &version("0.28.0"), false));
        assert!(!offers_update(&version("0.28.0"), &version("0.28.0"), true));
        assert!(!offers_update(&version("0.28.0"), &version("0.27.0"), true));
        assert!(!offers_update(
            &version("0.27.0"),
            &version("0.28.0-rc.1"),
            false
        ));
        assert!(offers_update(
            &version("0.27.0"),
            &version("0.28.0-rc.1"),
            true
        ));
        assert!(!offers_update(
            &version("0.28.0-rc.1"),
            &version("0.28.0-rc.2"),
            false
        ));
        assert!(offers_update(
            &version("0.28.0-rc.2"),
            &version("0.28.0-rc.10"),
            true
        ));
        assert!(!offers_update(
            &version("0.28.0-rc.10"),
            &version("0.28.0-rc.2"),
            true
        ));
        assert!(offers_update(
            &version("0.28.0-rc.1"),
            &version("0.28.0"),
            false
        ));
        assert!(!offers_update(
            &version("0.28.0-rc.1"),
            &version("0.27.9"),
            false
        ));
        assert!(!offers_update(
            &version("0.28.0+one"),
            &version("0.28.0+two"),
            true
        ));
    }

    fn release(tag: &str, prerelease: bool) -> PublishedRelease {
        PublishedRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease,
            published_at: Some("2026-10-02T00:00:00Z".into()),
            assets: vec![ReleaseAsset {
                name: "latest.json".into(),
                state: "uploaded".into(),
                size: 100,
            }],
        }
    }

    #[test]
    fn discovery_orders_versions_and_excludes_unpublished_or_unusable_releases() {
        let mut draft = release("v9.0.0-rc.1", true);
        draft.draft = true;
        let mut unpublished = release("v8.0.0-rc.1", true);
        unpublished.published_at = None;
        let mut unsigned = release("v7.0.0-rc.1", true);
        unsigned.assets.clear();
        let mut empty = release("v6.0.0-rc.1", true);
        empty.assets[0].size = 0;
        let mut uploading = release("v5.0.0-rc.1", true);
        uploading.assets[0].state = "new".into();
        let releases = vec![
            draft,
            unpublished,
            unsigned,
            empty,
            uploading,
            release("v0.28.0", false),
            release("v0.29.0-rc.10", true),
            release("v0.29.0-rc.2", true),
            release("v0.27.9", false),
            release("v9.0.0+build", true),
            release("invalid", false),
            release("v0.0.0-test.999", true),
        ];
        assert_eq!(
            newest_release(&releases, &version("0.27.0"), true),
            Some(version("0.29.0-rc.10"))
        );
        assert_eq!(
            newest_release(&releases, &version("0.27.0"), false),
            Some(version("0.28.0"))
        );
        assert_eq!(
            newest_release(&releases, &version("0.29.0-rc.10"), false),
            None
        );
        let final_release = vec![release("v0.29.0-rc.10", true), release("v0.29.0", false)];
        assert_eq!(
            newest_release(&final_release, &version("0.29.0-rc.2"), true),
            Some(version("0.29.0"))
        );
        // Even a mistakenly unmarked prerelease stays out of the stable channel.
        assert_eq!(
            newest_release(&[release("v1.0.0-rc.1", false)], &version("0.29.0"), false),
            None
        );
    }

    #[tokio::test]
    async fn discovery_follows_pages_and_reports_api_errors() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/releases", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for (page, tag) in [(1, "v0.28.0"), (2, "v0.29.0-rc.2"), (1, "error")] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                assert!(request.contains(&format!("per_page=100&page={page}")));
                let (status, body, link) = if tag == "error" {
                    ("429 Too Many Requests", "{}".to_string(), "")
                } else {
                    (
                        "200 OK",
                        serde_json::json!([{
                            "tag_name": tag, "draft": false, "prerelease": tag.contains('-'),
                            "published_at": "2026-10-02T00:00:00Z",
                            "assets": [{"name": "latest.json", "size": 100, "state": "uploaded"}],
                        }])
                        .to_string(),
                        if page == 1 {
                            "Link: <http://ignored.test/releases?page=2>; rel=\"next\"\r\n"
                        } else {
                            ""
                        },
                    )
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{link}\r\n{body}", body.len()).unwrap();
            }
        });
        assert_eq!(
            discover_release(&url, &version("0.27.0"), true)
                .await
                .unwrap(),
            Some(version("0.29.0-rc.2"))
        );
        assert!(discover_release(&url, &version("0.27.0"), true)
            .await
            .unwrap_err()
            .contains("HTTP 429"));
        server.join().unwrap();
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
    fn only_a_confirmation_rides_a_recent_warning() {
        let latch = Mutex::new(Some(Instant::now()));
        forget_unconfirmed_warning(&latch, true);
        assert!(
            latch.lock().unwrap().is_some(),
            "Restart Anyway keeps its warning"
        );
        forget_unconfirmed_warning(&latch, false);
        assert!(
            latch.lock().unwrap().is_none(),
            "a plain install request is asked afresh, never waved through by another's warning"
        );
    }

    #[test]
    fn restart_anyway_installs_however_long_the_dialog_was_open() {
        // #2065. The held install warned more than the grace period ago, so the latch alone would
        // hold the confirmation again and ask the same question twice.
        let updater = DesktopUpdater::default();
        let warned = Instant::now()
            .checked_sub(crate::CLOSE_WARNING_GRACE + Duration::from_secs(1))
            .expect("the monotonic clock has run past one grace period");
        *updater.warned_at.lock().unwrap() = Some(warned);
        request_install_confirmation(&updater);
        assert!(!crate::warning_still_authorizes(
            *updater.warned_at.lock().unwrap(),
            Instant::now(),
            crate::CLOSE_WARNING_GRACE
        ));
        assert!(
            take_install_confirmation(&updater, true),
            "Restart Anyway answers the question the held install asked"
        );
        assert!(
            !take_install_confirmation(&updater, true),
            "a second confirmation finds nothing to spend"
        );
    }

    #[test]
    fn only_a_confirmation_spends_a_held_install_request() {
        let updater = DesktopUpdater::default();
        assert!(
            !take_install_confirmation(&updater, true),
            "a confirmation no held install asked for is held as before"
        );

        request_install_confirmation(&updater);
        assert!(
            !take_install_confirmation(&updater, false),
            "a plain Install and Restart is asked afresh"
        );
        assert!(
            take_install_confirmation(&updater, true),
            "and leaves the open dialog's answer to its Restart Anyway"
        );
    }

    #[test]
    fn a_held_install_names_the_working_sessions_by_id() {
        let held = InstallOutcome::HeldForWork {
            sessions: 3,
            session_ids: vec!["s_one".into(), "s_two".into()],
        };
        assert_eq!(
            serde_json::to_value(&held).unwrap(),
            serde_json::json!({"outcome": "heldForWork", "sessions": 3, "sessionIds": ["s_one", "s_two"]})
        );
        assert_eq!(
            serde_json::to_value(InstallOutcome::Restarting).unwrap(),
            serde_json::json!({"outcome": "restarting"})
        );
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
