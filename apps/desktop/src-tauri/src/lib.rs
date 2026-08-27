//! Wollipog desktop shell. A thin Tauri window that loads the existing web UI
//! (the Vite dev server in dev, the built `apps/web/dist` in release) and runs the
//! control plane as a bundled sidecar so the packaged app is self-contained — no
//! separate `pnpm dev` / Node process required. If a control plane is already
//! listening (e.g. the dev stack), the sidecar is skipped.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex,
};
use std::thread;
use std::time::{Duration, Instant};

use atomic_write_file::AtomicWriteFile;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use fs2::FileExt;
use hmac::{Hmac, Mac};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{Emitter, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

mod instances;
mod remote_transport;
mod secrets;
mod settings;

use instances::{
    add_remote_instance, edit_remote_instance, instance_registry, remove_remote_instance,
    repair_remote_instance, set_active_instance, InstanceRegistryState,
};
use remote_transport::{
    remote_http_cancel, remote_http_request, remote_transport_close, remote_transport_open,
    remote_ui_close, remote_ui_open, remote_ui_send, RemoteTransport,
};
use settings::{
    app_data_dir, read_settings, read_settings_result, write_settings, DesktopSettings,
    LocalRunnerSettings,
};

const OWNERSHIP_LOCK_FILE: &str = "desktop-owner.lock";
const OWNERSHIP_NOTIFICATION_FILE: &str = "desktop-owner-notification.json";
const OWNERSHIP_NOTIFICATION_VERSION: u8 = 1;
const OWNERSHIP_NOTIFICATION_NONCE_BYTES: usize = 32;
const OWNERSHIP_NOTIFICATION_MARKER_MAX_BYTES: u64 = 512;
const OWNERSHIP_NOTIFICATION_REQUEST_MAX_BYTES: usize = 64;
const OWNERSHIP_NOTIFICATION_RETRY_INTERVAL: Duration = Duration::from_millis(25);
const OWNERSHIP_NOTIFICATION_IO_TIMEOUT: Duration = Duration::from_millis(500);
const OWNERSHIP_NOTIFICATION_FOCUS_TIMEOUT: Duration = Duration::from_secs(1);
// Covers the normal shared 20-second child stop plus the 10-second operation drain and scheduler
// margin. A pathological final escalation remains fail-closed: the contender exits after this.
const OWNERSHIP_NOTIFICATION_TAKEOVER_TIMEOUT: Duration = Duration::from_secs(35);
const OWNERSHIP_NOTIFICATION_JOIN_TIMEOUT: Duration = Duration::from_secs(1);
// The runner advertises an 11.5-second graceful-stop budget. Leave enough margin for its final
// descendant-boundary verification before the desktop escalates to SIGKILL.
const OWNED_CHILD_STOP_TIMEOUT: Duration = Duration::from_secs(20);
const LOCAL_RUNNER_LEGACY_OWNER_FILE: &str = ".wollipog-runner-owner-v1.json";
const LOCAL_RUNNER_OWNER_FILE: &str = ".wollipog-runner-owner-v2.json";

/// An advisory ownership lock backed by the OS, not by the file's presence.
///
/// The file intentionally survives clean exits and crashes. Only this open handle owns the lock,
/// so the kernel releases ownership if the process dies without running Rust destructors.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct ProcessOwnership {
    _file: fs::File,
    notification_path: PathBuf,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum ProcessOwnershipAttempt {
    Acquired(ProcessOwnership),
    Contended,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProcessOwnershipPhase {
    Starting,
    Ready,
    ShuttingDown,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProcessOwnershipMarker {
    version: u8,
    phase: ProcessOwnershipPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl ProcessOwnershipMarker {
    fn phase(phase: ProcessOwnershipPhase) -> Self {
        Self {
            version: OWNERSHIP_NOTIFICATION_VERSION,
            phase,
            port: None,
            nonce: None,
        }
    }

    fn ready(port: u16, nonce: String) -> Self {
        Self {
            version: OWNERSHIP_NOTIFICATION_VERSION,
            phase: ProcessOwnershipPhase::Ready,
            port: Some(port),
            nonce: Some(nonce),
        }
    }

    fn ready_endpoint(&self) -> Option<(u16, &[u8])> {
        if self.version != OWNERSHIP_NOTIFICATION_VERSION
            || self.phase != ProcessOwnershipPhase::Ready
        {
            return None;
        }
        let port = self.port?;
        let nonce = self.nonce.as_deref()?;
        let decoded = URL_SAFE_NO_PAD.decode(nonce).ok()?;
        (port != 0
            && decoded.len() == OWNERSHIP_NOTIFICATION_NONCE_BYTES
            && URL_SAFE_NO_PAD.encode(&decoded) == nonce)
            .then_some((port, nonce.as_bytes()))
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn process_ownership_path(identifier: &str) -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|directory| directory.join(identifier).join(OWNERSHIP_LOCK_FILE))
        .ok_or_else(|| "could not resolve the Wollipog data directory".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn process_ownership_notification_path(lock_path: &Path) -> Result<PathBuf, String> {
    lock_path
        .parent()
        .map(|directory| directory.join(OWNERSHIP_NOTIFICATION_FILE))
        .ok_or_else(|| "could not resolve the desktop ownership directory".to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn publish_process_ownership_marker(
    path: &Path,
    marker: &ProcessOwnershipMarker,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(marker)
        .map_err(|error| format!("could not serialize desktop ownership state: {error}"))?;
    if bytes.len() as u64 > OWNERSHIP_NOTIFICATION_MARKER_MAX_BYTES {
        return Err("desktop ownership state exceeded its size limit".into());
    }
    let mut staged = open_private_atomic_file(path)
        .map_err(|error| format!("could not stage desktop ownership state: {error}"))?;
    staged
        .file
        .write_all(&bytes)
        .map_err(|error| format!("could not write desktop ownership state: {error}"))?;
    commit_private_atomic_file(staged)
        .map_err(|error| format!("could not publish desktop ownership state: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn read_process_ownership_marker(path: &Path) -> Option<ProcessOwnershipMarker> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() == 0 || metadata.len() > OWNERSHIP_NOTIFICATION_MARKER_MAX_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 != metadata.len() {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Try to become the one desktop process allowed to own bundled children.
///
/// The injected path keeps the platform primitive directly testable. A stale file is harmless:
/// `try_lock_exclusive` consults kernel lock state, never file contents or a reusable PID.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn acquire_process_ownership_at(path: &Path) -> Result<ProcessOwnershipAttempt, String> {
    let Some(parent) = path.parent() else {
        return Err("could not resolve the desktop ownership directory".into());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create the desktop ownership directory: {error}"))?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| format!("could not open the desktop ownership lock: {error}"))?;
    match file.try_lock_exclusive() {
        Ok(()) => {
            let notification_path = process_ownership_notification_path(path)?;
            publish_process_ownership_marker(
                &notification_path,
                &ProcessOwnershipMarker::phase(ProcessOwnershipPhase::Starting),
            )?;
            Ok(ProcessOwnershipAttempt::Acquired(ProcessOwnership {
                _file: file,
                notification_path,
            }))
        }
        Err(error)
            if error.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                || error.kind() == std::io::ErrorKind::WouldBlock =>
        {
            Ok(ProcessOwnershipAttempt::Contended)
        }
        Err(error) => Err(format!(
            "could not acquire the desktop ownership lock: {error}"
        )),
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum ProcessOwnershipResolution {
    Acquired(ProcessOwnership),
    Notified,
    TimedOut,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn notify_process_owner(marker: &ProcessOwnershipMarker) -> bool {
    let Some((port, nonce)) = marker.ready_endpoint() else {
        return false;
    };
    let address = std::net::SocketAddr::V4(std::net::SocketAddrV4::new(
        std::net::Ipv4Addr::LOCALHOST,
        port,
    ));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, OWNERSHIP_NOTIFICATION_IO_TIMEOUT)
    else {
        return false;
    };
    if stream
        .set_read_timeout(Some(OWNERSHIP_NOTIFICATION_IO_TIMEOUT))
        .is_err()
        || stream
            .set_write_timeout(Some(OWNERSHIP_NOTIFICATION_IO_TIMEOUT))
            .is_err()
        || stream.write_all(nonce).is_err()
        || stream.write_all(b"\n").is_err()
        || stream.shutdown(std::net::Shutdown::Write).is_err()
    {
        return false;
    }
    let mut acknowledgement = [0_u8; 4];
    stream.read_exact(&mut acknowledgement).is_ok() && acknowledgement == *b"ACK\n"
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_process_ownership_at(
    lock_path: &Path,
    timeout: Duration,
) -> Result<ProcessOwnershipResolution, String> {
    let notification_path = process_ownership_notification_path(lock_path)?;
    let deadline = Instant::now() + timeout;
    loop {
        match acquire_process_ownership_at(lock_path)? {
            ProcessOwnershipAttempt::Acquired(ownership) => {
                return Ok(ProcessOwnershipResolution::Acquired(ownership));
            }
            ProcessOwnershipAttempt::Contended => {
                if read_process_ownership_marker(&notification_path)
                    .as_ref()
                    .is_some_and(notify_process_owner)
                {
                    return Ok(ProcessOwnershipResolution::Notified);
                }
            }
        }
        if Instant::now() >= deadline {
            return Ok(ProcessOwnershipResolution::TimedOut);
        }
        thread::sleep(OWNERSHIP_NOTIFICATION_RETRY_INTERVAL);
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resolve_process_ownership(identifier: &str) -> Result<ProcessOwnershipResolution, String> {
    resolve_process_ownership_at(
        &process_ownership_path(identifier)?,
        OWNERSHIP_NOTIFICATION_TAKEOVER_TIMEOUT,
    )
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn handle_process_owner_notification(
    mut stream: TcpStream,
    expected_nonce: &[u8],
    focus: &dyn Fn() -> bool,
) {
    let _ = stream.set_read_timeout(Some(OWNERSHIP_NOTIFICATION_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(OWNERSHIP_NOTIFICATION_IO_TIMEOUT));
    let mut request = Vec::new();
    if (&mut stream)
        .take((OWNERSHIP_NOTIFICATION_REQUEST_MAX_BYTES + 1) as u64)
        .read_to_end(&mut request)
        .is_err()
        || request.len() > OWNERSHIP_NOTIFICATION_REQUEST_MAX_BYTES
        || request.last() != Some(&b'\n')
        || &request[..request.len() - 1] != expected_nonce
        || !focus()
    {
        return;
    }
    let _ = stream.write_all(b"ACK\n");
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct ProcessOwnerNotificationServer {
    stop: Arc<AtomicBool>,
    port: u16,
    completed: std::sync::mpsc::Receiver<()>,
    thread: Option<thread::JoinHandle<()>>,
    notification_path: PathBuf,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl ProcessOwnerNotificationServer {
    fn start(
        notification_path: PathBuf,
        focus: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|error| {
            format!("could not bind the desktop notification listener: {error}")
        })?;
        listener.set_nonblocking(true).map_err(|error| {
            format!("could not configure the desktop notification listener: {error}")
        })?;
        let port = listener
            .local_addr()
            .map_err(|error| {
                format!("could not inspect the desktop notification listener: {error}")
            })?
            .port();
        let mut nonce_bytes = [0_u8; OWNERSHIP_NOTIFICATION_NONCE_BYTES];
        getrandom::fill(&mut nonce_bytes)
            .map_err(|error| format!("could not create desktop notification identity: {error}"))?;
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let expected_nonce = nonce.as_bytes().to_vec();
        let stop = Arc::new(AtomicBool::new(false));
        let task_stop = Arc::clone(&stop);
        let (completed_tx, completed) = std::sync::mpsc::sync_channel(1);
        let task = thread::spawn(move || {
            while !task_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, address)) if address.ip().is_loopback() => {
                        handle_process_owner_notification(stream, &expected_nonce, &*focus);
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(OWNERSHIP_NOTIFICATION_RETRY_INTERVAL);
                    }
                    Err(_) => break,
                }
            }
            let _ = completed_tx.send(());
        });
        let mut server = Self {
            stop,
            port,
            completed,
            thread: Some(task),
            notification_path,
        };
        if let Err(error) = publish_process_ownership_marker(
            &server.notification_path,
            &ProcessOwnershipMarker::ready(port, nonce),
        ) {
            server.stop();
            return Err(error);
        }
        Ok(server)
    }

    fn stop(&mut self) {
        if self.thread.is_none() {
            return;
        }
        let _ = publish_process_ownership_marker(
            &self.notification_path,
            &ProcessOwnershipMarker::phase(ProcessOwnershipPhase::ShuttingDown),
        );
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, self.port));
        if self
            .completed
            .recv_timeout(OWNERSHIP_NOTIFICATION_JOIN_TIMEOUT)
            .is_ok()
        {
            if let Some(task) = self.thread.take() {
                let _ = task.join();
            }
        } else {
            eprintln!("[desktop] timed out stopping the desktop notification listener");
            self.thread.take();
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl Drop for ProcessOwnerNotificationServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Child handle paired with positive confirmation from the shell event reader that it exited.
struct ManagedChild<C = CommandChild> {
    child: C,
    terminated: Arc<AtomicBool>,
}

impl<C> ManagedChild<C> {
    fn new(child: C, terminated: Arc<AtomicBool>) -> Self {
        Self { child, terminated }
    }

    fn has_terminated(&self) -> bool {
        self.terminated.load(Ordering::Acquire)
    }
}

fn terminate_managed_children_with<C>(
    children: Vec<(ManagedChild<C>, &'static str)>,
    timeout: Duration,
    mut request_stop: impl FnMut(&C) -> bool,
    mut force_stop: impl FnMut(C),
    mut wait: impl FnMut(&AtomicBool, Duration) -> bool,
) -> Vec<(&'static str, bool)> {
    let deadline = Instant::now() + timeout;
    let pending = children
        .into_iter()
        .map(|(child, label)| {
            // The shell plugin may already have reaped this PID. Never send raw SIGTERM after its
            // confirmed exit, because the OS may have recycled the numeric PID for another process.
            if child.has_terminated() {
                (None, child.terminated, label)
            } else if request_stop(&child.child) {
                (Some(child.child), child.terminated, label)
            } else {
                force_stop(child.child);
                (None, child.terminated, label)
            }
        })
        .collect::<Vec<_>>();

    pending
        .into_iter()
        .map(|(child, terminated, label)| {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let confirmed = wait(&terminated, remaining);
            if !confirmed {
                if let Some(child) = child {
                    force_stop(child);
                }
            }
            (label, confirmed)
        })
        .collect()
}

#[cfg(unix)]
fn request_managed_child_stop(child: &CommandChild) -> bool {
    // Tauri's CommandChild::kill is SIGKILL on Unix. Give the runner its bounded SIGTERM cleanup
    // path first so it can empty provider descendant boundaries and release HOME ownership.
    unsafe { libc::kill(child.pid() as i32, libc::SIGTERM) == 0 }
}

#[cfg(windows)]
fn request_managed_child_stop(_child: &CommandChild) -> bool {
    false
}

fn terminate_managed_children(children: Vec<(ManagedChild, &'static str)>) {
    for (label, confirmed) in terminate_managed_children_with(
        children,
        OWNED_CHILD_STOP_TIMEOUT,
        request_managed_child_stop,
        |child| {
            let _ = child.kill();
        },
        |terminated, timeout| wait_until(|| terminated.load(Ordering::Acquire), true, timeout),
    ) {
        if !confirmed {
            eprintln!("[desktop] timed out waiting for the {label} process to stop");
        }
    }
}

fn terminate_managed_child(child: ManagedChild, label: &'static str) {
    terminate_managed_children(vec![(child, label)]);
}

/// Lifecycle phase for the control plane owned (or observed) by the desktop.
///
/// `Starting`, `Reconfiguring`, and `RollingBack` are deliberately observable. They replace using
/// the mutex itself as a transition fence, so close/status/token paths can snapshot state quickly.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum SidecarPhase {
    #[default]
    Stopped,
    Starting,
    Running,
    Reconfiguring,
    RollingBack,
    External,
}

struct SidecarState<C = CommandChild> {
    /// A running child or a pending candidate already installed before its readiness wait.
    child: Option<C>,
    phase: SidecarPhase,
    generation: u64,
    shutting_down: bool,
    launch_identity: Option<Arc<SidecarLaunchIdentity>>,
    child_terminated: Option<Arc<AtomicBool>>,
}

impl<C> Default for SidecarState<C> {
    fn default() -> Self {
        Self {
            child: None,
            phase: SidecarPhase::Stopped,
            generation: 0,
            shutting_down: false,
            launch_identity: None,
            child_terminated: None,
        }
    }
}

struct SidecarLaunchIdentity {
    launch_id: String,
    secret: SecretString,
}

struct SpawnedSidecar<C> {
    child: C,
    identity: Arc<SidecarLaunchIdentity>,
    terminated: Arc<AtomicBool>,
}

struct RejectedSidecarCandidate<C> {
    child: C,
    terminated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedCandidateState {
    Current,
    Terminated,
    Superseded,
}

/// Whether the user has already been warned that closing would stop work.
///
/// §23.1 is a data-loss-class bug: closing the window runs `RunEvent::Exit`, which kills the
/// sidecar and the local runner, so every in-flight agent turn dies with no warning and nothing on
/// screen ever said so.
///
/// One mutex rather than two atomics. Round one was right that a pair of `Relaxed` atomics is not
/// one guard state: a report could land between the close handler's two loads and let an exit
/// through with a stale flag. There is only one field left now, but the lock is what makes
/// "read, decide, set" indivisible against a concurrent second close.
#[derive(Default)]
struct CloseGuard {
    /// When the user was last warned, if they have been.
    ///
    /// A time, not a flag. A flag that is never cleared cannot strand anyone — but it is spent by
    /// the FIRST warning, whether or not that warning was right. The control plane parks guardrail
    /// cards as `input_required` with an approval that outlives this process, so one false warning
    /// about a settled card would permanently disarm the guard, and the next close would kill a
    /// real turn in silence.
    ///
    /// Scoped to the attempt instead: "close again" authorizes the next close for a short grace
    /// period. Closing twice in a row always works, so the escape hatch is intact; come back an
    /// hour later with new work running and you are warned about it.
    warned_at: Mutex<Option<Instant>>,
    /// Set when a window close was allowed to destroy the last window.
    ///
    /// Tauri raises `ExitRequested` right after, and asking again there can answer differently —
    /// work may have started in between. Preventing the exit at that point leaves a process with no
    /// window: nothing to close, nothing to warn into, and a second launch swallowed by the
    /// single-instance guard. One close gesture gets one decision.
    exit_authorized: AtomicBool,
}

/// Session statuses whose work dies with the process.
///
/// Kept next to the query that uses it, and cross-checked against the protocol's `SessionStatus`
/// union by a test in `apps/web/src/desktop-close-guard.test.ts` — so adding a status there fails
/// this build's sibling test rather than silently classifying it as "nothing to lose".
const WORK_IN_FLIGHT_STATUSES: [&str; 4] = ["queued", "starting", "running", "input_required"];

/// Statuses that are known to have nothing left to lose.
///
/// Listed rather than inferred, because "not in the busy list" is the wrong default across a
/// version skew: a newer control plane can return a status this build has never heard of, and
/// treating it as safe is how an active turn gets killed silently. Anything in neither list makes
/// the whole answer `Unknown`, which warns.
const SETTLED_STATUSES: [&str; 4] = ["idle", "completed", "failed", "stopped"];

/// The event the shell emits when it holds a close back, and the dashboard listens for.
///
/// Named here and in `apps/web/src/components/DesktopCloseGuard.tsx`, and a test in each language
/// checks they still agree: two spellings of one event name is a feature that silently does nothing.
const CLOSE_WOULD_STOP_WORK_EVENT: &str = "wollipog://close-would-stop-work";

/// What the shell knows about work that closing would destroy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExitRisk {
    /// Nothing to lose — no control plane, or it says nothing is in flight.
    None,
    /// This many sessions have a turn open.
    Sessions(usize),
    /// The control plane is up but could not be asked. Treated as risk, deliberately.
    Unknown,
}

/// How long a warning authorizes the close that follows it.
///
/// Long enough to read the message and click again; short enough that it cannot silently cover work
/// that starts later.
const CLOSE_WARNING_GRACE: Duration = Duration::from_secs(30);

/// Whether a previous warning still authorizes this close.
fn warning_still_authorizes(warned_at: Option<Instant>, now: Instant, grace: Duration) -> bool {
    warned_at.is_some_and(|at| now.duration_since(at) <= grace)
}

/// Take the authorization a permitted window close left behind, consuming it.
///
/// The consume is IN here rather than at the call site, so a test can exercise it. Written as a
/// bare `swap` beside a test that also called `swap`, the rule was asserted and the code was not —
/// changing the call site to a `load` left the test green while one permitted close authorized
/// every later quit.
fn take_exit_authorization(guard: &CloseGuard) -> bool {
    guard.exit_authorized.swap(false, Ordering::Relaxed)
}

/// Whether an `ExitRequested` should be guarded, given the authorization a window close left behind.
fn should_guard_exit(authorized_by_window_close: bool) -> bool {
    !authorized_by_window_close
}

/// Whether a close should be held back.
///
/// `Unknown` holds, because the cost of being wrong is not symmetric: a needless warning costs one
/// keypress, and a missed one costs an agent turn. The escape hatch is that a close following a
/// recent warning ALWAYS exits — see `warning_still_authorizes`, which scopes that to the attempt
/// rather than to the process, so a false warning cannot disarm the guard for good.
fn should_hold_close(risk: ExitRisk, already_warned: bool) -> bool {
    if already_warned {
        return false;
    }
    match risk {
        ExitRisk::None => false,
        ExitRisk::Sessions(count) => count > 0,
        ExitRisk::Unknown => true,
    }
}

/// What closing would actually destroy.
///
/// Ownership first, and that ordering is the point. Round two found three separate bugs that all
/// came from querying before knowing what the shell owns: a health probe that failed while our
/// runner was mid-turn was read as "nothing to lose"; sessions belonging to OTHER runners — which
/// survive and reconnect — were counted as work closing would stop; and the bootstrap credential
/// was sent to whatever held the loopback port, authenticated by nothing but a public marker
/// string, in exactly the window where an impostor could be holding it.
///
/// Exit kills two children: the managed sidecar and the managed local runner. Sessions on any other
/// runner outlive it. So if this shell owns no local runner child, there is nothing for exit to
/// destroy and no reason to ask anyone anything.
fn local_work_in_flight(app: &tauri::AppHandle) -> ExitRisk {
    let runner_id = {
        let local_runner = app.state::<LocalRunner>();
        let state = local_runner.0.lock().unwrap();
        match runner_id_or_exit_risk(&state) {
            Ok(runner_id) => runner_id,
            Err(risk) => return risk,
        }
    };
    // We own a runner with possibly-live work. From here every uncertainty warns.
    // Only a control plane this process spawned can authenticate the answer. A loopback impostor
    // may see the runner id, launch id, fresh challenge and request MAC while this launch is still
    // current, but it receives no owner bearer or launch secret and cannot produce a valid response,
    // so the answer remains Unknown.
    let (sidecar_generation, launch_identity) = {
        let sidecar = app.state::<Sidecar>();
        let state = sidecar.0.lock().unwrap();
        match managed_sidecar_identity(&state) {
            Some(snapshot) => snapshot,
            None => return ExitRisk::Unknown,
        }
    };
    let generation_is_current = {
        let sidecar = app.state::<Sidecar>();
        let state = sidecar.0.lock().unwrap();
        managed_sidecar_identity_is_current(&state, sidecar_generation, &launch_identity.launch_id)
    };
    if !generation_is_current {
        return ExitRisk::Unknown;
    }
    let Ok((head, body)) = post_managed_local(
        MANAGED_EXIT_RISK_PATH,
        &runner_id,
        &launch_identity,
        EXIT_RISK_REQUEST_DOMAIN,
        EXIT_RISK_RESPONSE_DOMAIN,
        CLOSE_QUERY_READ_BUDGET,
    ) else {
        return ExitRisk::Unknown;
    };
    {
        let sidecar = app.state::<Sidecar>();
        let state = sidecar.0.lock().unwrap();
        if !managed_sidecar_identity_is_current(
            &state,
            sidecar_generation,
            &launch_identity.launch_id,
        ) {
            return ExitRisk::Unknown;
        }
    }
    risk_from_response(&head, &body, &runner_id)
}

/// Sessions on `runner_id` with a turn open — or `Unknown` if any of them cannot be classified.
///
/// Archived sessions included: archiving does not stop a session, and a side chat is created
/// archived. Other runners' sessions excluded: they survive this process exiting.
fn risk_for_runner(sessions: &[serde_json::Value], runner_id: &str) -> ExitRisk {
    let mut count = 0usize;
    for session in sessions {
        match session.get("runnerId").and_then(|value| value.as_str()) {
            Some(owner) if owner == runner_id => {}
            Some(_) => continue,
            // A row with no runner cannot be attributed, so it cannot be dismissed either. Skipping
            // it silently is how a malformed response reads as "nothing is running".
            None => return ExitRisk::Unknown,
        }
        if session
            .get("pendingApproval")
            .is_some_and(|value| !value.is_null())
        {
            count += 1;
            continue;
        }
        match session.get("status").and_then(|value| value.as_str()) {
            Some(status) if WORK_IN_FLIGHT_STATUSES.contains(&status) => count += 1,
            Some(status) if SETTLED_STATUSES.contains(&status) => {}
            // A status this build does not know, or no status at all. Refusing to guess is the
            // whole reason `Unknown` exists.
            _ => return ExitRisk::Unknown,
        }
    }
    ExitRisk::Sessions(count)
}

/// Decide, warn, and latch — in one place, under one lock.
///
/// Both the window close and the application quit route through this, because they are the same
/// question asked by two different OS gestures. macOS Cmd+Q and the app menu never raise a window
/// `CloseRequested` at all, so a guard that only listened there was silent on the most ordinary way
/// a Mac user quits.
///
/// Returns true when the caller should PREVENT the close.
fn hold_close_for_work(app: &tauri::AppHandle) -> bool {
    let guard = app.state::<CloseGuard>();
    // Checked, released, then re-checked. Holding the lock across the query would make the SECOND
    // close wait on a control-plane round trip whose answer it does not need — the warning already
    // decided it. Releasing and re-taking costs a second check, which is what the re-check is for.
    if warning_still_authorizes(
        *guard.warned_at.lock().unwrap(),
        Instant::now(),
        CLOSE_WARNING_GRACE,
    ) {
        return false;
    }
    let risk = local_work_in_flight(app);
    if !should_hold_close(risk, false) {
        return false;
    }
    let mut warned_at = guard.warned_at.lock().unwrap();
    if warning_still_authorizes(*warned_at, Instant::now(), CLOSE_WARNING_GRACE) {
        // Another close path warned while this one was querying. One warning is the whole rule.
        return false;
    }
    *warned_at = Some(Instant::now());
    drop(warned_at);

    let count = match risk {
        ExitRisk::Sessions(count) => count,
        // The dashboard says "work may still be running" for an unknown count; it never invents one.
        ExitRisk::Unknown | ExitRisk::None => 0,
    };
    // Best effort: if no webview can show this, the user presses close again and exits.
    for window in app.webview_windows().values() {
        let _ = window.emit(CLOSE_WOULD_STOP_WORK_EVENT, count);
    }
    true
}

/// Read a control-plane response into a risk, failing closed on anything unexpected.
///
/// Split out from the socket work so it can be tested: a 401 body is JSON too, and parsing it
/// without checking the status would find no `sessions` key — or, worse, some future error shape
/// that happens to carry one — and report "nothing is running" for a question that was never
/// answered.
fn risk_from_response(head: &str, body: &str, runner_id: &str) -> ExitRisk {
    // The STATUS TOKEN, not a prefix: `starts_with("HTTP/1.1 200")` also accepts `HTTP/1.1 2000`.
    let status_ok = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .is_some_and(|code| code == "200");
    if !status_ok {
        return ExitRisk::Unknown;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return ExitRisk::Unknown;
    };
    let Some(sessions) = parsed.get("sessions").and_then(|value| value.as_array()) else {
        return ExitRisk::Unknown;
    };
    risk_for_runner(sessions, runner_id)
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn canonical_base64url(value: &str, expected_len: usize) -> Option<Vec<u8>> {
    if value.is_empty()
        || value.contains('=')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    (decoded.len() == expected_len && URL_SAFE_NO_PAD.encode(&decoded) == value).then_some(decoded)
}

fn managed_mac(
    identity: &SidecarLaunchIdentity,
    domain: &[u8],
    challenge: &[u8],
    payload: &[u8],
) -> Result<String, String> {
    let secret = canonical_base64url(identity.secret.expose_secret(), 32)
        .ok_or_else(|| "the managed control-plane launch secret is invalid".to_string())?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&secret)
        .map_err(|_| "the managed control-plane launch secret is invalid".to_string())?;
    mac.update(domain);
    mac.update(challenge);
    mac.update(payload);
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn verify_managed_mac(
    identity: &SidecarLaunchIdentity,
    domain: &[u8],
    challenge: &[u8],
    payload: &[u8],
    presented: &str,
) -> bool {
    let Some(presented) = canonical_base64url(presented, 32) else {
        return false;
    };
    let Ok(secret) = canonical_base64url(identity.secret.expose_secret(), 32).ok_or(()) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&secret) else {
        return false;
    };
    mac.update(domain);
    mac.update(challenge);
    mac.update(payload);
    mac.verify_slice(&presented).is_ok()
}

fn new_sidecar_launch_identity() -> Result<Arc<SidecarLaunchIdentity>, String> {
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret)
        .map_err(|error| format!("could not create the control-plane launch secret: {error}"))?;
    Ok(Arc::new(SidecarLaunchIdentity {
        launch_id: uuid::Uuid::new_v4().simple().to_string(),
        secret: SecretString::from(URL_SAFE_NO_PAD.encode(secret)),
    }))
}

const EXIT_RISK_REQUEST_DOMAIN: &[u8] = b"wollipog.desktop.exit-risk.request.v1\0";
const EXIT_RISK_RESPONSE_DOMAIN: &[u8] = b"wollipog.desktop.exit-risk.response.v1\0";
const PROVISION_REQUEST_DOMAIN: &[u8] = b"wollipog.desktop.managed-provision.request.v1\0";
const PROVISION_RESPONSE_DOMAIN: &[u8] = b"wollipog.desktop.managed-provision.response.v1\0";
const MANAGED_EXIT_RISK_PATH: &str = "/internal/desktop/exit-risk";
const MANAGED_PROVISION_PATH: &str = "/internal/desktop/runner-credential";
const MANAGED_LAUNCH_ID_HEADER: &str = "x-wollipog-launch-id";
const MANAGED_CHALLENGE_HEADER: &str = "x-wollipog-challenge";
const MANAGED_REQUEST_MAC_HEADER: &str = "x-wollipog-request-mac";
const MANAGED_RESPONSE_MAC_HEADER: &str = "x-wollipog-response-mac";

#[derive(Clone, Copy)]
struct ManagedReadBudget {
    deadline: Duration,
    idle_timeout: Duration,
    max_bytes: usize,
}

/// Mutual-HMAC POST to the exact managed launch. No owner bearer or launch secret is transmitted.
fn post_managed_local(
    path: &str,
    runner_id: &str,
    identity: &SidecarLaunchIdentity,
    request_domain: &[u8],
    response_domain: &[u8],
    read_budget: ManagedReadBudget,
) -> Result<(String, String), String> {
    let addr = format!("{LOCAL_HOST}:{CP_PORT}")
        .parse()
        .map_err(|error| format!("could not resolve the local control plane: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(300))
        .map_err(|error| format!("could not connect to the local control plane: {error}"))?;
    stream
        .set_write_timeout(Some(Duration::from_millis(300)))
        .map_err(|error| format!("could not bound the local control-plane write: {error}"))?;
    let mut challenge = [0u8; 32];
    getrandom::fill(&mut challenge)
        .map_err(|error| format!("could not create the managed request challenge: {error}"))?;
    let challenge_header = URL_SAFE_NO_PAD.encode(challenge);
    let request_mac = managed_mac(identity, request_domain, &challenge, runner_id.as_bytes())?;
    let (request, body) =
        managed_request(identity, path, runner_id, &challenge_header, &request_mac)?;
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| format!("could not send the managed request: {error}"))?;
    let response = read_bounded(
        &mut stream,
        read_budget.deadline,
        read_budget.idle_timeout,
        read_budget.max_bytes,
    )
    .ok_or_else(|| "the managed control plane returned no bounded response".to_string())?;
    let (head, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "the managed control plane returned an incomplete response".to_string())?;
    let response_mac = header_value(head, MANAGED_RESPONSE_MAC_HEADER)
        .ok_or_else(|| "the managed control plane omitted its response proof".to_string())?;
    if !verify_managed_mac(
        identity,
        response_domain,
        &challenge,
        body.as_bytes(),
        response_mac,
    ) {
        return Err("the managed control-plane response proof is invalid".into());
    }
    Ok((head.to_string(), body.to_string()))
}

fn managed_request(
    identity: &SidecarLaunchIdentity,
    path: &str,
    runner_id: &str,
    challenge: &str,
    request_mac: &str,
) -> Result<(String, Vec<u8>), String> {
    let body = serde_json::to_vec(&serde_json::json!({ "runnerId": runner_id }))
        .map_err(|error| format!("could not encode the managed request: {error}"))?;
    let head = format!(
        "POST {path} HTTP/1.0\r\nHost: {LOCAL_HOST}\r\n{MANAGED_LAUNCH_ID_HEADER}: {}\r\n{MANAGED_CHALLENGE_HEADER}: {challenge}\r\n{MANAGED_REQUEST_MAC_HEADER}: {request_mac}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        identity.launch_id,
        body.len(),
    );
    Ok((head, body))
}

/// Total wall-clock the close path will spend waiting on the control plane.
const CLOSE_QUERY_DEADLINE: Duration = Duration::from_millis(1_500);
/// Maximum silence between close-query response bytes, so a trickling peer cannot renew the wait.
const CLOSE_QUERY_IDLE_TIMEOUT: Duration = Duration::from_millis(700);
/// Ceiling on the response we will read. A busy machine's session list is far below this.
const CLOSE_QUERY_MAX_BYTES: usize = 4 * 1024 * 1024;
const CLOSE_QUERY_READ_BUDGET: ManagedReadBudget = ManagedReadBudget {
    deadline: CLOSE_QUERY_DEADLINE,
    idle_timeout: CLOSE_QUERY_IDLE_TIMEOUT,
    max_bytes: CLOSE_QUERY_MAX_BYTES,
};

/// Read until EOF, a deadline, or a byte ceiling — whichever comes first.
///
/// `read_to_string` is the wrong call on a close path. `set_read_timeout` bounds each individual
/// read, not the whole exchange, so a peer trickling one byte every 600ms holds the read open
/// forever — and this runs on the UI thread, where "forever" means the window never closes. The
/// ceiling matters for the same reason: the response is a full session list, and it is the close
/// path that pays for reading it.
///
/// Returning `None` on a timeout is deliberate. The caller turns that into `ExitRisk::Unknown`,
/// which HOLDS the close — so a slow control plane costs a warning, never a silent kill.
fn read_bounded(
    stream: &mut TcpStream,
    deadline: Duration,
    idle_timeout: Duration,
    max_bytes: usize,
) -> Option<String> {
    let started = Instant::now();
    let mut collected: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let elapsed = started.elapsed();
        if elapsed >= deadline {
            return None;
        }
        // Never wait past the deadline on any single read, so the total stays bounded.
        let remaining = deadline - elapsed;
        stream
            .set_read_timeout(Some(remaining.min(idle_timeout)))
            .ok()?;
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                if collected.len() + read > max_bytes {
                    return None;
                }
                collected.extend_from_slice(&chunk[..read]);
            }
            Err(_) => return None,
        }
    }
    String::from_utf8(collected).ok()
}

/// The managed sidecar lifecycle. The mutex protects only state transitions, never process or I/O.
#[derive(Default)]
struct Sidecar(Mutex<SidecarState<ManagedChild>>, Arc<SidecarOperations>);

#[derive(Default)]
struct SidecarOperationState {
    active: usize,
    shutting_down: bool,
}

/// Admission and drain gate for every bundled-process operation that can spawn a child.
///
/// A permit covers sidecar start/reconfigure/rollback and local-runner replacement, including
/// rejection and termination of a candidate that lost to committed Exit. The condition variable
/// is separate from both lifecycle states, so Exit never holds a lifecycle mutex while it waits or
/// kills a process.
#[derive(Default)]
struct SidecarOperations {
    state: Mutex<SidecarOperationState>,
    idle: Condvar,
}

struct SidecarOperationPermit<'a> {
    operations: &'a SidecarOperations,
}

impl SidecarOperations {
    fn begin(&self) -> Result<SidecarOperationPermit<'_>, String> {
        let mut state = self.state.lock().unwrap();
        if state.shutting_down {
            return Err("the desktop is shutting down".into());
        }
        state.active = state
            .active
            .checked_add(1)
            .expect("sidecar operation count overflowed");
        Ok(SidecarOperationPermit { operations: self })
    }

    fn begin_shutdown(&self) {
        self.state.lock().unwrap().shutting_down = true;
    }

    fn is_shutting_down(&self) -> bool {
        self.state.lock().unwrap().shutting_down
    }

    fn wait_for_idle(&self, timeout: Duration) -> bool {
        let state = self.state.lock().unwrap();
        let (state, _) = self
            .idle
            .wait_timeout_while(state, timeout, |state| state.active != 0)
            .unwrap();
        state.active == 0
    }

    fn active_count(&self) -> usize {
        self.state.lock().unwrap().active
    }
}

impl Drop for SidecarOperationPermit<'_> {
    fn drop(&mut self) {
        let mut state = self.operations.state.lock().unwrap();
        state.active = state
            .active
            .checked_sub(1)
            .expect("sidecar operation count underflowed");
        if state.active == 0 {
            self.operations.idle.notify_all();
        }
    }
}

const SIDECAR_OPERATION_DRAIN_TIMEOUT: Duration = Duration::from_secs(10);

enum BeginSidecarReconfiguration<C> {
    Unchanged,
    Started {
        generation: u64,
        previous_child: Option<C>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SidecarStartOutcome {
    External,
    Managed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalRunnerControlPlane {
    External,
    Managed(u64),
}

#[derive(Clone, Copy)]
struct SidecarNetworkChange {
    previous_tailnet_access: bool,
    enabled: bool,
}

fn managed_sidecar_generation<C>(state: &SidecarState<C>) -> Option<u64> {
    (!state.shutting_down
        && state.phase == SidecarPhase::Running
        && state.child.is_some()
        && state.launch_identity.is_some()
        && !state
            .child_terminated
            .as_ref()
            .is_some_and(|terminated| terminated.load(Ordering::Acquire)))
    .then_some(state.generation)
}

fn managed_sidecar_generation_is_current<C>(state: &SidecarState<C>, generation: u64) -> bool {
    managed_sidecar_generation(state) == Some(generation)
}

fn local_runner_control_plane<C>(
    state: &SidecarState<C>,
) -> Result<LocalRunnerControlPlane, &'static str> {
    if state.shutting_down {
        return Err("the local control plane is not ready");
    }
    match state.phase {
        SidecarPhase::External => Ok(LocalRunnerControlPlane::External),
        SidecarPhase::Running => managed_sidecar_generation(state)
            .map(LocalRunnerControlPlane::Managed)
            .ok_or("the local control plane is not ready"),
        SidecarPhase::Starting | SidecarPhase::Reconfiguring | SidecarPhase::RollingBack => {
            Err("the local control plane is being reconfigured")
        }
        SidecarPhase::Stopped => Err("the local control plane is not ready"),
    }
}

fn managed_sidecar_identity<C>(
    state: &SidecarState<C>,
) -> Option<(u64, Arc<SidecarLaunchIdentity>)> {
    managed_sidecar_generation(state).and_then(|generation| {
        state
            .launch_identity
            .as_ref()
            .map(|identity| (generation, Arc::clone(identity)))
    })
}

fn managed_sidecar_identity_is_current<C>(
    state: &SidecarState<C>,
    generation: u64,
    launch_id: &str,
) -> bool {
    managed_sidecar_generation_is_current(state, generation)
        && state
            .launch_identity
            .as_ref()
            .is_some_and(|identity| identity.launch_id == launch_id)
}

fn begin_sidecar_start<C>(state: &mut SidecarState<C>) -> Result<u64, String> {
    if state.shutting_down {
        return Err("the desktop is shutting down".into());
    }
    if state.phase != SidecarPhase::Stopped || state.child.is_some() {
        return Err("the control plane is already being started".into());
    }
    state.generation = state.generation.wrapping_add(1);
    state.phase = SidecarPhase::Starting;
    Ok(state.generation)
}

fn begin_sidecar_reconfiguration<C>(
    state: &mut SidecarState<C>,
    setting_unchanged: bool,
) -> Result<BeginSidecarReconfiguration<C>, String> {
    if state.shutting_down {
        return Err("the desktop is shutting down".into());
    }
    if state.phase == SidecarPhase::External {
        return Err(
            "Tailnet access cannot be changed while another control plane owns port 4317.".into(),
        );
    }
    if matches!(
        state.phase,
        SidecarPhase::Starting | SidecarPhase::Reconfiguring | SidecarPhase::RollingBack
    ) {
        return Err("The local control plane is already being reconfigured.".into());
    }
    if setting_unchanged && state.phase == SidecarPhase::Running && state.child.is_some() {
        return Ok(BeginSidecarReconfiguration::Unchanged);
    }

    state.generation = state.generation.wrapping_add(1);
    state.phase = SidecarPhase::Reconfiguring;
    Ok(BeginSidecarReconfiguration::Started {
        generation: state.generation,
        previous_child: state.child.take(),
    })
}

fn sidecar_operation_is_current<C>(
    state: &SidecarState<C>,
    generation: u64,
    phase: SidecarPhase,
) -> bool {
    !state.shutting_down && state.generation == generation && state.phase == phase
}

fn require_current_sidecar_operation<C>(
    sidecar: &Mutex<SidecarState<C>>,
    generation: u64,
    phase: SidecarPhase,
    superseded: &'static str,
) -> Result<(), String> {
    let state = sidecar.lock().unwrap();
    sidecar_operation_is_current(&state, generation, phase)
        .then_some(())
        .ok_or_else(|| superseded.to_string())
}

fn install_sidecar_candidate<C>(
    state: &mut SidecarState<C>,
    generation: u64,
    phase: SidecarPhase,
    candidate: SpawnedSidecar<C>,
) -> Result<(), RejectedSidecarCandidate<C>> {
    let terminated = candidate.terminated.load(Ordering::Acquire);
    if terminated
        || !sidecar_operation_is_current(state, generation, phase)
        || state.child.is_some()
    {
        return Err(RejectedSidecarCandidate {
            child: candidate.child,
            terminated,
        });
    }
    state.child = Some(candidate.child);
    state.launch_identity = Some(candidate.identity);
    state.child_terminated = Some(candidate.terminated);
    Ok(())
}

fn managed_candidate_state<C>(
    state: &SidecarState<C>,
    generation: u64,
    phase: SidecarPhase,
    terminated: &Arc<AtomicBool>,
) -> ManagedCandidateState {
    if !sidecar_operation_is_current(state, generation, phase) {
        return ManagedCandidateState::Superseded;
    }
    if terminated.load(Ordering::Acquire) {
        return ManagedCandidateState::Terminated;
    }
    if state.child.is_none()
        || state.launch_identity.is_none()
        || state
            .child_terminated
            .as_ref()
            .is_none_or(|current| !Arc::ptr_eq(current, terminated))
    {
        return ManagedCandidateState::Superseded;
    }
    ManagedCandidateState::Current
}

fn commit_managed_sidecar<C>(
    state: &mut SidecarState<C>,
    generation: u64,
    phase: SidecarPhase,
    terminated: &Arc<AtomicBool>,
) -> ManagedCandidateState {
    let candidate_state = managed_candidate_state(state, generation, phase, terminated);
    if candidate_state == ManagedCandidateState::Current {
        state.phase = SidecarPhase::Running;
        // The Terminated task publishes the flag before waiting for this mutex. Re-check after the
        // tentative phase write so a death concurrent with classification is still pre-commit.
        if terminated.load(Ordering::Acquire) {
            state.phase = phase;
            return ManagedCandidateState::Terminated;
        }
    }
    candidate_state
}

fn commit_external_sidecar<C>(state: &mut SidecarState<C>, generation: u64) -> bool {
    if !sidecar_operation_is_current(state, generation, SidecarPhase::Starting)
        || state.child.is_some()
    {
        return false;
    }
    state.phase = SidecarPhase::External;
    true
}

fn transition_sidecar_operation<C>(
    state: &mut SidecarState<C>,
    generation: u64,
    from: SidecarPhase,
    to: SidecarPhase,
) -> Result<Option<C>, ()> {
    if !sidecar_operation_is_current(state, generation, from) {
        return Err(());
    }
    let child = state.child.take();
    state.launch_identity = None;
    state.child_terminated = None;
    state.phase = to;
    Ok(child)
}

fn shutdown_sidecar<C>(state: &mut SidecarState<C>) -> Option<C> {
    state.shutting_down = true;
    state.generation = state.generation.wrapping_add(1);
    state.phase = SidecarPhase::Stopped;
    state.launch_identity = None;
    state.child_terminated = None;
    state.child.take()
}

fn clear_terminated_sidecar<C>(
    state: &mut SidecarState<C>,
    generation: u64,
    launch_id: &str,
) -> Option<C> {
    if state.generation != generation
        || state
            .launch_identity
            .as_ref()
            .is_none_or(|identity| identity.launch_id != launch_id)
    {
        return None;
    }
    state.launch_identity = None;
    state.child_terminated = None;
    if state.phase == SidecarPhase::Running {
        state.phase = SidecarPhase::Stopped;
    }
    state.child.take()
}

#[cfg(test)]
fn shutdown_sidecar_and_wait<C>(
    sidecar: &Mutex<SidecarState<C>>,
    operations: &SidecarOperations,
    timeout: Duration,
    mut terminate: impl FnMut(C),
) -> bool {
    operations.begin_shutdown();
    let child = {
        let mut state = sidecar.lock().unwrap();
        shutdown_sidecar(&mut state)
    };
    if let Some(child) = child {
        terminate(child);
    }
    operations.wait_for_idle(timeout)
}

struct LocalRunnerState<C = CommandChild> {
    child: Option<C>,
    runner_id: Option<String>,
    /// Process ownership generation. Replacement, termination and exit fence child installation.
    generation: u64,
    /// Latest credential-file writer. Process-only supersession must not steal rollback ownership.
    credential_generation: u64,
    /// Once committed Exit begins, no delayed or user-triggered replacement may stage new work.
    shutting_down: bool,
}

impl<C> Default for LocalRunnerState<C> {
    fn default() -> Self {
        Self {
            child: None,
            runner_id: None,
            generation: 0,
            credential_generation: 0,
            shutting_down: false,
        }
    }
}

/// The runner bundled with Wollipog and managed for the lifetime of the desktop app.
#[derive(Default)]
struct LocalRunner(Mutex<LocalRunnerState<ManagedChild>>);

/// The identity of the process this shell would kill on exit.
///
/// A child without an identity (or an identity without a child) violates the state invariant. The
/// close guard fails safe in that case instead of consulting separately mutable settings.
fn owned_local_runner_id<C>(state: &LocalRunnerState<C>) -> Result<Option<String>, ()> {
    match (&state.child, &state.runner_id) {
        (None, None) => Ok(None),
        (Some(_), Some(runner_id)) => Ok(Some(runner_id.clone())),
        _ => Err(()),
    }
}

fn runner_id_or_exit_risk<C>(state: &LocalRunnerState<C>) -> Result<String, ExitRisk> {
    match owned_local_runner_id(state) {
        Ok(Some(runner_id)) => Ok(runner_id),
        Ok(None) => Err(ExitRisk::None),
        Err(()) => Err(ExitRisk::Unknown),
    }
}

fn begin_local_runner_replacement<C>(state: &mut LocalRunnerState<C>) -> (u64, Option<C>) {
    state.generation = state.generation.wrapping_add(1);
    state.runner_id = None;
    (state.generation, state.child.take())
}

fn stage_local_runner_replacement<C>(
    state: &mut LocalRunnerState<C>,
    stage_credential: impl FnOnce() -> Result<(), String>,
    writes_credential: bool,
) -> Result<(u64, Option<u64>, Option<C>), String> {
    if state.shutting_down {
        return Err("the desktop is shutting down".into());
    }
    stage_credential()?;
    let credential_generation = writes_credential.then(|| {
        state.credential_generation = state.credential_generation.wrapping_add(1);
        state.credential_generation
    });
    let (generation, previous) = begin_local_runner_replacement(state);
    Ok((generation, credential_generation, previous))
}

fn clear_terminated_local_runner<C>(state: &mut LocalRunnerState<C>, generation: u64) -> bool {
    if state.generation != generation {
        return false;
    }
    state.child = None;
    state.runner_id = None;
    true
}

fn shutdown_local_runner<C>(state: &mut LocalRunnerState<C>) -> Option<C> {
    state.shutting_down = true;
    state.generation = state.generation.wrapping_add(1);
    state.runner_id = None;
    state.child.take()
}

fn should_restore_saved_local_runner<C>(
    captured_runner_id: &str,
    current_runner_id: Option<&str>,
    state: &LocalRunnerState<C>,
) -> bool {
    !state.shutting_down
        && current_runner_id == Some(captured_runner_id)
        && matches!(owned_local_runner_id(state), Ok(None))
}

fn decide_saved_local_runner_restore<C>(
    _registry_guard: &tokio::sync::MutexGuard<'_, ()>,
    captured_runner_id: &str,
    state: &LocalRunnerState<C>,
    read_current_runner_id: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<bool, String> {
    let current_runner_id = read_current_runner_id()?;
    Ok(should_restore_saved_local_runner(
        captured_runner_id,
        current_runner_id.as_deref(),
        state,
    ))
}

fn commit_local_runner_candidate<C>(
    state: &mut LocalRunnerState<C>,
    generation: u64,
    runner_id: String,
    child: C,
    terminated: bool,
    publish_settings: impl FnOnce() -> Result<(), String>,
) -> Result<(), (C, String)> {
    if state.shutting_down {
        return Err((child, "the desktop is shutting down".into()));
    }
    if state.generation != generation {
        return Err((
            child,
            "the bundled local runner replacement was superseded".into(),
        ));
    }
    if terminated {
        return Err((
            child,
            "the bundled local runner stopped before it could connect".into(),
        ));
    }
    if let Err(error) = publish_settings() {
        return Err((child, error));
    }
    state.runner_id = Some(runner_id);
    state.child = Some(child);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TailnetAccessStatus {
    available: bool,
    enabled: bool,
    managed: bool,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalRunnerStatus {
    available: bool,
    enabled: bool,
    running: bool,
    runner_id: Option<String>,
    suggested_runner_id: String,
}

const CP_PORT: u16 = 4317;
const LOCAL_HOST: &str = "127.0.0.1";
const TAILNET_BIND_HOST: &str = "0.0.0.0";
/// Marker returned by our control plane's /healthz — distinguishes it from any other
/// process that happens to hold the port.
const LOCAL_DEVICE_TOKEN_FILE: &str = "local-device.token";
const LOCAL_RUNNER_TOKEN_FILE: &str = "local-runner.token";
const LOCAL_RUNNER_DATA_DIR: &str = "local-runner-data";
const LOCAL_RUNNER_MACHINE_ID_FILE: &str = "local-runner-machine-id";
static LOCAL_RUNNER_MACHINE_ID_LOCK: Mutex<()> = Mutex::new(());

/// Is OUR control plane already serving the port? We GET /healthz and look for the marker,
/// so a stale dev server with the wrong db, an unrelated process, or a rogue listener on
/// the port does NOT cause us to skip the managed sidecar and bind to the wrong service.
fn our_control_plane_running() -> bool {
    match format!("{LOCAL_HOST}:{CP_PORT}").parse() {
        Ok(addr) => probe_marker(addr),
        Err(_) => false,
    }
}

/// The health probe against one address, so a test can point it at a listener it controls.
///
/// Extracted for exactly that reason: written against the fixed port, nothing could drive it, and
/// the bound added here had no test — which is how the unbounded version survived a mutation pass.
fn probe_marker(addr: std::net::SocketAddr) -> bool {
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));
    if stream
        .write_all(
            format!("GET /healthz HTTP/1.0\r\nHost: {LOCAL_HOST}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .is_err()
    {
        return false;
    }
    // Bounded, because this probe is on the CLOSE path. `read_to_string` with a per-read timeout is
    // not a bound: a peer sending one byte every 500ms renews the wait forever and grows the buffer
    // without a ceiling, freezing the window that is trying to close. Round three was right that
    // bounding `read_bounded` and leaving this alone left the close path unbounded, which is the
    // opposite of what the previous commit message claimed.
    match read_bounded(
        &mut stream,
        HEALTH_PROBE_DEADLINE,
        HEALTH_PROBE_DEADLINE,
        HEALTH_PROBE_MAX_BYTES,
    ) {
        Some(response) => response_has_control_plane_service(&response),
        None => false,
    }
}

fn response_has_control_plane_service(response: &str) -> bool {
    let Some((head, body)) = response
        .split_once("\r\n\r\n")
        .or_else(|| response.split_once("\n\n"))
    else {
        return false;
    };
    let Some(status_line) = head.lines().next() else {
        return false;
    };
    let Some((version, status_and_reason)) = status_line.split_once(' ') else {
        return false;
    };
    let Some((status, _reason)) = status_and_reason.split_once(' ') else {
        return false;
    };
    if !matches!(version, "HTTP/1.0" | "HTTP/1.1")
        || status.len() != 3
        || !status.bytes().all(|byte| byte.is_ascii_digit())
        || !matches!(status.parse::<u16>(), Ok(200..=299))
    {
        return false;
    }
    if head.lines().skip(1).any(|line| {
        let Some((name, _value)) = line.split_once(':') else {
            return true;
        };
        name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
    }) {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body.trim())
        .ok()
        .and_then(|value| {
            value
                .get("service")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|service| instances::is_control_plane_service(&service))
}

/// Wall-clock the close path will spend on the health probe.
const HEALTH_PROBE_DEADLINE: Duration = Duration::from_millis(600);
/// A health response is a few hundred bytes; anything larger is not one.
const HEALTH_PROBE_MAX_BYTES: usize = 64 * 1024;

fn port_open() -> bool {
    let Ok(addr) = format!("{LOCAL_HOST}:{CP_PORT}").parse() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn wait_until(mut predicate: impl FnMut() -> bool, expected: bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if predicate() == expected {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    predicate() == expected
}

fn local_runner_token_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LOCAL_RUNNER_TOKEN_FILE))
}

fn local_runner_machine_id_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LOCAL_RUNNER_MACHINE_ID_FILE))
}

fn local_device_token_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LOCAL_DEVICE_TOKEN_FILE))
}

fn local_runner_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join(LOCAL_RUNNER_DATA_DIR))
}

fn valid_runner_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && !value
            .chars()
            .any(|ch| ch <= '\u{20}' || ch == '\u{7f}' || "/\\?#%".contains(ch))
}

const LEGACY_RUNNER_TOKEN_PREFIX: &str = "mamr_";
const WOLLIPOG_RUNNER_TOKEN_PREFIX: &str = "wollipogr_";

fn valid_runner_token_with_prefix(value: &str, prefix: &str) -> bool {
    let Some(secret) = value.strip_prefix(prefix) else {
        return false;
    };

    secret.len() == 43
        && secret
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn valid_runner_token(value: &str) -> bool {
    valid_runner_token_with_prefix(value, WOLLIPOG_RUNNER_TOKEN_PREFIX)
        || valid_runner_token_with_prefix(value, LEGACY_RUNNER_TOKEN_PREFIX)
}

fn valid_local_device_token(value: &str) -> bool {
    value.len() == 43
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn read_local_device_token(app: &tauri::AppHandle) -> Result<String, String> {
    let path = local_device_token_path(app)?;
    let token = fs::read_to_string(&path)
        .map_err(|error| format!("could not read the local dashboard credential: {error}"))?;
    let token = token.strip_suffix('\n').unwrap_or(&token);
    if !valid_local_device_token(token) {
        return Err("the local dashboard credential is invalid".into());
    }
    Ok(token.to_string())
}

fn select_external_local_runner_authorization_token(
    presented_token: Option<String>,
) -> Result<String, String> {
    let token = presented_token.ok_or_else(|| {
        "Pair this desktop with the local control plane before setting up its runner.".to_string()
    })?;
    if !valid_local_device_token(&token) {
        return Err("the local dashboard credential is invalid".into());
    }
    Ok(token)
}

fn write_local_runner_token(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    if !valid_runner_token(token) {
        return Err("the control plane returned an invalid local runner credential".into());
    }
    let path = local_runner_token_path(app)?;
    write_local_runner_credential_file(&path, token.as_bytes())
}

struct PrivateAtomicFile {
    file: AtomicWriteFile,
    temp_path: PathBuf,
}

fn find_open_atomic_temp_path(
    destination: &Path,
    file: &AtomicWriteFile,
) -> std::io::Result<PathBuf> {
    let Some(parent) = destination.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the atomic destination has no parent directory",
        ));
    };
    let open_handle = same_file::Handle::from_file(file.as_file().try_clone()?)?;
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let entry_handle = match same_file::Handle::from_path(entry.path()) {
            Ok(handle) => handle,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if open_handle == entry_handle {
            return Ok(entry.path());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "could not identify the atomic temporary file",
    ))
}

fn open_private_atomic_file(path: &Path) -> std::io::Result<PrivateAtomicFile> {
    let file = {
        #[cfg(unix)]
        {
            let mut options = AtomicWriteFile::options();
            // The mode applies to the temporary inode before any secret bytes are written. Never copy
            // a permissive mode from an older destination over that secure creation mode.
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            atomic_write_file::unix::OpenOptionsExt::preserve_mode(&mut options, false);
            options.open(path)?
        }
        #[cfg(not(unix))]
        {
            AtomicWriteFile::open(path)?
        }
    };
    let temp_path = find_open_atomic_temp_path(path, &file)?;
    Ok(PrivateAtomicFile { file, temp_path })
}

fn commit_private_atomic_file(staged: PrivateAtomicFile) -> std::io::Result<()> {
    let PrivateAtomicFile { file, temp_path } = staged;
    match file.commit() {
        Ok(()) => Ok(()),
        Err(commit_error) => match fs::remove_file(&temp_path) {
            Ok(()) => Err(commit_error),
            Err(cleanup_error) if cleanup_error.kind() == std::io::ErrorKind::NotFound => {
                Err(commit_error)
            }
            Err(cleanup_error) => Err(std::io::Error::new(
                commit_error.kind(),
                format!(
                    "{commit_error}; could not remove the failed atomic temporary file {}: {cleanup_error}",
                    temp_path.display()
                ),
            )),
        },
    }
}

fn write_local_runner_credential_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("could not resolve the local runner credential directory".into());
    };
    fs::create_dir_all(parent).map_err(|error| {
        format!("could not create the local runner credential directory: {error}")
    })?;
    let mut staged = open_private_atomic_file(path)
        .map_err(|error| format!("could not prepare the local runner credential: {error}"))?;
    staged
        .file
        .write_all(bytes)
        .map_err(|error| format!("could not save the local runner credential: {error}"))?;
    commit_private_atomic_file(staged)
        .map_err(|error| format!("could not commit the local runner credential: {error}"))
}

fn read_local_runner_machine_id_file(path: &Path) -> Result<Option<uuid::Uuid>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "could not read the local runner machine identity: {error}"
            ))
        }
    };
    let value = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|value| uuid::Uuid::parse_str(value.trim()).ok());
    Ok(value)
}

fn write_local_runner_machine_id_file(path: &Path, machine_id: uuid::Uuid) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("could not resolve the local runner machine identity directory".into());
    };
    fs::create_dir_all(parent).map_err(|error| {
        format!("could not create the local runner machine identity directory: {error}")
    })?;
    let mut staged = open_private_atomic_file(path)
        .map_err(|error| format!("could not prepare the local runner machine identity: {error}"))?;
    staged
        .file
        .write_all(machine_id.hyphenated().to_string().as_bytes())
        .map_err(|error| format!("could not save the local runner machine identity: {error}"))?;
    commit_private_atomic_file(staged)
        .map_err(|error| format!("could not commit the local runner machine identity: {error}"))
}

fn load_or_create_local_runner_machine_id(path: &Path) -> Result<uuid::Uuid, String> {
    let _guard = LOCAL_RUNNER_MACHINE_ID_LOCK
        .lock()
        .map_err(|_| "the local runner machine identity lock is unavailable".to_string())?;
    if let Some(machine_id) = read_local_runner_machine_id_file(path)? {
        return Ok(machine_id);
    }
    let machine_id = uuid::Uuid::new_v4();
    write_local_runner_machine_id_file(path, machine_id)?;
    Ok(machine_id)
}

fn suggested_local_runner_id(path: &Path) -> Result<String, String> {
    let machine_id = load_or_create_local_runner_machine_id(path)?;
    let simple = machine_id.simple().to_string();
    Ok(format!("this-machine-{}", &simple[..8]))
}

fn local_runner_suggestion_or_default(suggestion: Result<String, String>) -> String {
    match suggestion {
        Ok(suggestion) => suggestion,
        Err(error) => {
            eprintln!(
                "[desktop] could not load the local runner machine identity; using the compatibility name: {error}"
            );
            "this-machine".into()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PreviousLocalRunnerCredential {
    Missing,
    Present(Vec<u8>),
}

fn snapshot_local_runner_credential_file(
    path: &std::path::Path,
) -> Result<PreviousLocalRunnerCredential, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(PreviousLocalRunnerCredential::Present(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PreviousLocalRunnerCredential::Missing)
        }
        Err(error) => Err(format!(
            "could not preserve the existing local runner credential: {error}"
        )),
    }
}

fn restore_local_runner_credential_file(
    path: &std::path::Path,
    previous: &PreviousLocalRunnerCredential,
) -> Result<(), String> {
    match previous {
        PreviousLocalRunnerCredential::Present(bytes) => {
            write_local_runner_credential_file(path, bytes)
        }
        PreviousLocalRunnerCredential::Missing => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "could not remove the failed local runner credential: {error}"
            )),
        },
    }
}

fn should_restore_previous_local_runner_credential(
    same_runner_id: bool,
    is_latest_credential_writer: bool,
) -> bool {
    // Reissuing a same-ID pending credential revokes its predecessor immediately; an active
    // predecessor may remain valid until cutover, but the fully and atomically installed fresh
    // credential is at least as usable. Never replace it with a snapshot of uncertain server state.
    !same_runner_id && is_latest_credential_writer
}

fn post_external_local_json(
    path: &str,
    payload: &serde_json::Value,
    authorization_token: &str,
) -> Result<(u16, serde_json::Value), String> {
    let addr = format!("{LOCAL_HOST}:{CP_PORT}")
        .parse()
        .map_err(|error| format!("could not resolve the local control plane: {error}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|error| format!("could not connect to the local control plane: {error}"))?;
    let body = serde_json::to_vec(payload)
        .map_err(|error| format!("could not encode the local runner request: {error}"))?;
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {LOCAL_HOST}\r\nAuthorization: Bearer {authorization_token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .map_err(|error| format!("could not send the local runner request: {error}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("could not read the local runner response: {error}"))?;
    let response = String::from_utf8(response)
        .map_err(|_| "the local control plane returned a non-UTF-8 response".to_string())?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "the local control plane returned an incomplete response".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "the local control plane returned an invalid status".to_string())?;
    let json = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    Ok((status, json))
}

fn provision_local_runner_credential(
    runner_id: &str,
    authorization_token: &str,
) -> Result<String, String> {
    let payload = serde_json::json!({
        "runnerId": runner_id,
        "label": "Wollipog local runner",
    });
    let (mut status, mut body) =
        post_external_local_json("/api/runner-credentials", &payload, authorization_token)?;
    if status == 409 {
        (status, body) = post_external_local_json(
            &format!("/api/runner-credentials/{runner_id}/rotate"),
            &serde_json::json!({ "label": "Wollipog local runner" }),
            authorization_token,
        )?;
    }
    if !(200..300).contains(&status) {
        let detail = body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the credential request failed");
        return Err(format!("could not provision the local runner: {detail}"));
    }
    let token = body
        .get("token")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "the control plane did not return a local runner credential".to_string())?;
    if !valid_runner_token(token) {
        return Err("the control plane returned an invalid local runner credential".into());
    }
    Ok(token.to_string())
}

fn provision_managed_local_runner_credential(
    runner_id: &str,
    identity: &SidecarLaunchIdentity,
) -> Result<String, String> {
    let (head, body) = post_managed_local(
        MANAGED_PROVISION_PATH,
        runner_id,
        identity,
        PROVISION_REQUEST_DOMAIN,
        PROVISION_RESPONSE_DOMAIN,
        PROVISION_QUERY_READ_BUDGET,
    )?;
    managed_provisioning_response(&head, &body)
}

const PROVISION_QUERY_DEADLINE: Duration = Duration::from_secs(5);
// Credential issuance may legitimately pause on first database access or antivirus scanning.
// Unlike the UI-thread close query, it can spend the full wall-clock budget waiting for a byte.
const PROVISION_QUERY_IDLE_TIMEOUT: Duration = PROVISION_QUERY_DEADLINE;
const PROVISION_QUERY_MAX_BYTES: usize = 256 * 1024;
const PROVISION_QUERY_READ_BUDGET: ManagedReadBudget = ManagedReadBudget {
    deadline: PROVISION_QUERY_DEADLINE,
    idle_timeout: PROVISION_QUERY_IDLE_TIMEOUT,
    max_bytes: PROVISION_QUERY_MAX_BYTES,
};

fn managed_provisioning_response(head: &str, body: &str) -> Result<String, String> {
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| "the local control plane returned an invalid status".to_string())?;
    let body: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| "the local control plane returned invalid JSON".to_string())?;
    if !(200..300).contains(&status) {
        let detail = body
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the credential request failed");
        return Err(format!("could not provision the local runner: {detail}"));
    }
    let token = body
        .get("token")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "the control plane did not return a local runner credential".to_string())?;
    if !valid_runner_token(token) {
        return Err("the control plane returned an invalid local runner credential".into());
    }
    Ok(token.to_string())
}

fn network_profile(enabled: bool) -> (&'static str, &'static str) {
    if enabled {
        (TAILNET_BIND_HOST, "1")
    } else {
        (LOCAL_HOST, "0")
    }
}

fn packaged_web_dist(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = app.path().resource_dir().ok()?.join("web");
    path.join("index.html").is_file().then_some(path)
}

fn spawn_sidecar_process(
    app: &tauri::AppHandle,
    tailnet_access: bool,
    generation: u64,
) -> Result<SpawnedSidecar<ManagedChild>, String> {
    let db_dir = app_data_dir(app)?;
    fs::create_dir_all(&db_dir)
        .map_err(|error| format!("could not create the Wollipog data directory: {error}"))?;
    let db = db_dir.join("control-plane.db");
    let (host, tailnet_only) = network_profile(tailnet_access);

    let identity = new_sidecar_launch_identity()?;
    let terminated = Arc::new(AtomicBool::new(false));
    let mut command = app
        .shell()
        .sidecar("control-plane")
        .map_err(|error| format!("control-plane sidecar not found: {error}"))?
        .env("CONTROL_PLANE_HOST", host)
        .env("CONTROL_PLANE_PORT", CP_PORT.to_string())
        .env("CONTROL_PLANE_TAILNET_ONLY", tailnet_only)
        .env("CONTROL_PLANE_DB", db.to_string_lossy().into_owned())
        .env(
            "CONTROL_PLANE_LOCAL_TOKEN_FILE",
            local_device_token_path(app)?.to_string_lossy().into_owned(),
        )
        .env("WOLLIPOG_DESKTOP_LAUNCH_ID", identity.launch_id.clone())
        .env(
            "WOLLIPOG_DESKTOP_LAUNCH_SECRET",
            identity.secret.expose_secret(),
        );
    if let Some(web_dist) = packaged_web_dist(app) {
        command = command.env("WOLLIPOG_WEB_DIST", web_dist.to_string_lossy().into_owned());
    }

    let (mut rx, child) = command
        .spawn()
        .map_err(|error| format!("failed to start the control-plane sidecar: {error}"))?;
    let task_app = app.clone();
    let task_identity = Arc::clone(&identity);
    let task_terminated = Arc::clone(&terminated);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let detail = String::from_utf8_lossy(&bytes);
                    let detail = detail.trim_end();
                    if !detail.is_empty() {
                        eprintln!("[control-plane] {detail}");
                    }
                }
                CommandEvent::Terminated(_) => {
                    // Publish liveness loss before waiting for lifecycle cleanup. Credential and
                    // close-risk readers reject the identity immediately, even if commit owns the
                    // state mutex; commit re-checks this flag before reporting success.
                    task_terminated.store(true, Ordering::Release);
                    let sidecar = task_app.state::<Sidecar>();
                    let mut state = sidecar.0.lock().unwrap();
                    let _ =
                        clear_terminated_sidecar(&mut state, generation, &task_identity.launch_id);
                }
                _ => {}
            }
        }
    });

    Ok(SpawnedSidecar {
        child: ManagedChild::new(child, Arc::clone(&terminated)),
        identity,
        terminated,
    })
}

fn wait_for_sidecar_state(
    app: &tauri::AppHandle,
    predicate: impl Fn() -> bool,
    expected: bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    let sidecar = app.state::<Sidecar>();
    while Instant::now() < deadline {
        if sidecar.1.is_shutting_down() {
            return false;
        }
        if predicate() == expected {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    !sidecar.1.is_shutting_down() && predicate() == expected
}

fn wait_for_sidecar_ready(app: &tauri::AppHandle) -> bool {
    wait_for_sidecar_state(app, our_control_plane_running, true)
}

fn wait_for_sidecar_stopped(app: &tauri::AppHandle) -> bool {
    wait_for_sidecar_state(app, port_open, false)
}

fn start_sidecar_operation<C>(
    sidecar: &Mutex<SidecarState<C>>,
    operations: &SidecarOperations,
    tailnet_access: bool,
    mut external_probe: impl FnMut() -> bool,
    mut spawn: impl FnMut(bool, u64) -> Result<SpawnedSidecar<C>, String>,
    mut wait_ready: impl FnMut() -> bool,
    mut terminate: impl FnMut(C),
) -> Result<SidecarStartOutcome, String> {
    let _permit = operations.begin()?;
    let generation = {
        let mut state = sidecar.lock().unwrap();
        begin_sidecar_start(&mut state)?
    };

    if external_probe() {
        let committed = {
            let mut state = sidecar.lock().unwrap();
            commit_external_sidecar(&mut state, generation)
        };
        return committed
            .then_some(SidecarStartOutcome::External)
            .ok_or_else(|| "the control-plane startup was superseded".into());
    }

    require_current_sidecar_operation(
        sidecar,
        generation,
        SidecarPhase::Starting,
        "the control-plane startup was superseded",
    )?;
    let candidate = match spawn(tailnet_access, generation) {
        Ok(candidate) => candidate,
        Err(error) => {
            let _ = {
                let mut state = sidecar.lock().unwrap();
                transition_sidecar_operation(
                    &mut state,
                    generation,
                    SidecarPhase::Starting,
                    SidecarPhase::Stopped,
                )
            };
            return Err(error);
        }
    };
    let candidate_terminated = Arc::clone(&candidate.terminated);
    let installed = {
        let mut state = sidecar.lock().unwrap();
        install_sidecar_candidate(&mut state, generation, SidecarPhase::Starting, candidate)
    };
    if let Err(rejected) = installed {
        terminate(rejected.child);
        if rejected.terminated {
            let _ = {
                let mut state = sidecar.lock().unwrap();
                transition_sidecar_operation(
                    &mut state,
                    generation,
                    SidecarPhase::Starting,
                    SidecarPhase::Stopped,
                )
            };
            return Err("the control-plane sidecar terminated during startup".into());
        }
        return Err("the control-plane startup was superseded".into());
    }

    if !wait_ready() {
        let failed = {
            let mut state = sidecar.lock().unwrap();
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::Starting,
                SidecarPhase::Stopped,
            )
        };
        return match failed {
            Ok(candidate) => {
                if let Some(candidate) = candidate {
                    terminate(candidate);
                }
                Err("the control-plane sidecar did not become ready".into())
            }
            Err(()) => Err("the control-plane startup was superseded".into()),
        };
    }

    let (commit, terminated_child) = {
        let mut state = sidecar.lock().unwrap();
        let commit = commit_managed_sidecar(
            &mut state,
            generation,
            SidecarPhase::Starting,
            &candidate_terminated,
        );
        let terminated_child = if commit == ManagedCandidateState::Terminated {
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::Starting,
                SidecarPhase::Stopped,
            )
            .expect("a current terminated startup can transition to stopped")
        } else {
            None
        };
        (commit, terminated_child)
    };
    match commit {
        ManagedCandidateState::Current => Ok(SidecarStartOutcome::Managed),
        ManagedCandidateState::Terminated => {
            if let Some(child) = terminated_child {
                terminate(child);
            }
            Err("the control-plane sidecar terminated after becoming ready".into())
        }
        ManagedCandidateState::Superseded => Err("the control-plane startup was superseded".into()),
    }
}

fn restore_previous_sidecar<C, Spawn, WaitStopped, WaitReady, Terminate>(
    sidecar: &Mutex<SidecarState<C>>,
    generation: u64,
    previous_tailnet_access: bool,
    spawn: &mut Spawn,
    wait_stopped: &mut WaitStopped,
    wait_ready: &mut WaitReady,
    terminate: &mut Terminate,
) -> Result<(), String>
where
    Spawn: FnMut(bool, u64) -> Result<SpawnedSidecar<C>, String>,
    WaitStopped: FnMut() -> bool,
    WaitReady: FnMut() -> bool,
    Terminate: FnMut(C),
{
    let candidate = {
        let mut state = sidecar.lock().unwrap();
        transition_sidecar_operation(
            &mut state,
            generation,
            SidecarPhase::Reconfiguring,
            SidecarPhase::RollingBack,
        )
    }
    .map_err(|()| "the control-plane rollback was superseded".to_string())?;
    if let Some(candidate) = candidate {
        terminate(candidate);
    }
    if !wait_stopped() {
        let _ = {
            let mut state = sidecar.lock().unwrap();
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::RollingBack,
                SidecarPhase::Stopped,
            )
        };
        return Err("the failed replacement control plane did not stop".into());
    }

    require_current_sidecar_operation(
        sidecar,
        generation,
        SidecarPhase::RollingBack,
        "the control-plane rollback was superseded",
    )?;
    let rollback = match spawn(previous_tailnet_access, generation) {
        Ok(candidate) => candidate,
        Err(error) => {
            let _ = {
                let mut state = sidecar.lock().unwrap();
                transition_sidecar_operation(
                    &mut state,
                    generation,
                    SidecarPhase::RollingBack,
                    SidecarPhase::Stopped,
                )
            };
            return Err(format!(
                "the previous control plane could not be restarted: {error}"
            ));
        }
    };
    let rollback_terminated = Arc::clone(&rollback.terminated);
    let installed = {
        let mut state = sidecar.lock().unwrap();
        install_sidecar_candidate(&mut state, generation, SidecarPhase::RollingBack, rollback)
    };
    if let Err(rejected) = installed {
        terminate(rejected.child);
        if rejected.terminated {
            let _ = {
                let mut state = sidecar.lock().unwrap();
                transition_sidecar_operation(
                    &mut state,
                    generation,
                    SidecarPhase::RollingBack,
                    SidecarPhase::Stopped,
                )
            };
            return Err("the previous control plane terminated during rollback".into());
        }
        return Err("the control-plane rollback was superseded".into());
    }

    if !wait_ready() {
        let failed = {
            let mut state = sidecar.lock().unwrap();
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::RollingBack,
                SidecarPhase::Stopped,
            )
        };
        return match failed {
            Ok(rollback) => {
                if let Some(rollback) = rollback {
                    terminate(rollback);
                }
                Err("the previous control plane did not become ready".into())
            }
            Err(()) => Err("the control-plane rollback was superseded".into()),
        };
    }

    let (commit, terminated_child) = {
        let mut state = sidecar.lock().unwrap();
        let commit = commit_managed_sidecar(
            &mut state,
            generation,
            SidecarPhase::RollingBack,
            &rollback_terminated,
        );
        let terminated_child = if commit == ManagedCandidateState::Terminated {
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::RollingBack,
                SidecarPhase::Stopped,
            )
            .expect("a current terminated rollback can transition to stopped")
        } else {
            None
        };
        (commit, terminated_child)
    };
    match commit {
        ManagedCandidateState::Current => Ok(()),
        ManagedCandidateState::Terminated => {
            if let Some(child) = terminated_child {
                terminate(child);
            }
            Err("the previous control plane terminated during rollback".into())
        }
        ManagedCandidateState::Superseded => {
            Err("the control-plane rollback was superseded".into())
        }
    }
}

#[allow(
    clippy::too_many_arguments,
    reason = "lifecycle callbacks stay injected so shutdown races remain deterministic in tests"
)]
fn reconfigure_sidecar_operation<C>(
    sidecar: &Mutex<SidecarState<C>>,
    operations: &SidecarOperations,
    change: SidecarNetworkChange,
    mut terminate: impl FnMut(C),
    mut wait_stopped: impl FnMut() -> bool,
    mut spawn: impl FnMut(bool, u64) -> Result<SpawnedSidecar<C>, String>,
    mut wait_ready: impl FnMut() -> bool,
    mut publish_settings: impl FnMut() -> Result<(), String>,
    mut restore_settings: impl FnMut(bool) -> Result<(), String>,
) -> Result<(), String> {
    // Every callback is intentionally invoked after the state guard has been dropped. In
    // particular, candidates are installed before `wait_ready`, allowing committed Exit to take
    // and kill them while the readiness probe is still in flight.
    let _permit = operations.begin()?;
    let begin = {
        let mut state = sidecar.lock().unwrap();
        begin_sidecar_reconfiguration(&mut state, change.previous_tailnet_access == change.enabled)?
    };
    let generation = match begin {
        BeginSidecarReconfiguration::Unchanged => return Ok(()),
        BeginSidecarReconfiguration::Started {
            generation,
            previous_child,
        } => {
            if let Some(previous_child) = previous_child {
                terminate(previous_child);
            }
            generation
        }
    };

    if !wait_stopped() {
        let cleared = {
            let mut state = sidecar.lock().unwrap();
            transition_sidecar_operation(
                &mut state,
                generation,
                SidecarPhase::Reconfiguring,
                SidecarPhase::Stopped,
            )
        };
        return if cleared.is_ok() {
            Err("The local control plane did not stop; Tailnet access was not changed.".into())
        } else {
            Err("the control-plane reconfiguration was superseded".into())
        };
    }

    require_current_sidecar_operation(
        sidecar,
        generation,
        SidecarPhase::Reconfiguring,
        "the control-plane reconfiguration was superseded",
    )?;
    let mut restore_persisted_settings = false;
    let primary_error = match spawn(change.enabled, generation) {
        Ok(candidate) => {
            let target_terminated = Arc::clone(&candidate.terminated);
            let installed = {
                let mut state = sidecar.lock().unwrap();
                install_sidecar_candidate(
                    &mut state,
                    generation,
                    SidecarPhase::Reconfiguring,
                    candidate,
                )
            };
            if let Err(rejected) = installed {
                terminate(rejected.child);
                if rejected.terminated {
                    Some("the replacement control plane terminated during startup".to_string())
                } else {
                    return Err("the control-plane reconfiguration was superseded".into());
                }
            } else if !wait_ready() {
                Some("the replacement control plane did not become ready".to_string())
            } else {
                let current = {
                    let state = sidecar.lock().unwrap();
                    managed_candidate_state(
                        &state,
                        generation,
                        SidecarPhase::Reconfiguring,
                        &target_terminated,
                    )
                };
                match current {
                    ManagedCandidateState::Terminated => {
                        Some("the replacement control plane terminated after startup".to_string())
                    }
                    ManagedCandidateState::Superseded => {
                        return Err("the control-plane reconfiguration was superseded".into());
                    }
                    ManagedCandidateState::Current => match publish_settings() {
                        Ok(()) => {
                            let committed = {
                                let mut state = sidecar.lock().unwrap();
                                commit_managed_sidecar(
                                    &mut state,
                                    generation,
                                    SidecarPhase::Reconfiguring,
                                    &target_terminated,
                                )
                            };
                            match committed {
                                ManagedCandidateState::Current => return Ok(()),
                                ManagedCandidateState::Terminated => {
                                    restore_persisted_settings = true;
                                    Some(
                                        "the replacement control plane terminated after startup"
                                            .to_string(),
                                    )
                                }
                                ManagedCandidateState::Superseded => {
                                    return Err(
                                        "the control-plane reconfiguration was superseded".into()
                                    );
                                }
                            }
                        }
                        Err(error) => Some(error),
                    },
                }
            }
        }
        Err(error) => Some(error),
    };

    let primary_error = primary_error.expect("a failed replacement has an error");
    let (settings_restore_error, recovery_tailnet_access) = if restore_persisted_settings {
        match restore_settings(change.previous_tailnet_access) {
            Ok(()) => (None, change.previous_tailnet_access),
            Err(error) => (Some(error), change.enabled),
        }
    } else {
        (None, change.previous_tailnet_access)
    };
    let rollback = restore_previous_sidecar(
        sidecar,
        generation,
        recovery_tailnet_access,
        &mut spawn,
        &mut wait_stopped,
        &mut wait_ready,
        &mut terminate,
    );
    let mut errors = vec![primary_error];
    if let Some(error) = settings_restore_error {
        errors.push(format!(
            "the previous Tailnet access setting could not be restored: {error}"
        ));
    }
    if let Err(error) = rollback {
        errors.push(error);
    }
    Err(errors.join("; "))
}

/// Start the control-plane sidecar unless one is already running. Failures are logged,
/// not fatal — the UI then shows its offline banner instead of crashing the shell.
fn start_sidecar(app: &tauri::AppHandle) {
    let settings = read_settings(app);
    let sidecar = app.state::<Sidecar>();
    match start_sidecar_operation(
        &sidecar.0,
        &sidecar.1,
        settings.tailnet_access,
        our_control_plane_running,
        |enabled, generation| spawn_sidecar_process(app, enabled, generation),
        || wait_for_sidecar_ready(app),
        |child| terminate_managed_child(child, "control-plane sidecar"),
    ) {
        Ok(SidecarStartOutcome::External) => {
            eprintln!("[desktop] control plane already on :{CP_PORT} — not starting the sidecar");
        }
        Ok(SidecarStartOutcome::Managed) => {
            eprintln!(
                "[desktop] control plane started on {}:{CP_PORT}",
                network_profile(settings.tailnet_access).0
            );
        }
        Err(error) => eprintln!("[desktop] {error}"),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LocalRunnerLaunchIntent {
    RestoreSaved,
    UserRequested,
}

fn local_runner_owner_marker_present(data_dir: &Path) -> Result<bool, String> {
    for marker in [LOCAL_RUNNER_OWNER_FILE, LOCAL_RUNNER_LEGACY_OWNER_FILE] {
        let marker_path = data_dir.join(marker);
        match marker_path.try_exists() {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(error) => {
                return Err(format!(
                    "could not inspect the local runner owner marker {}: {error}",
                    marker_path.display()
                ));
            }
        }
    }
    Ok(false)
}

fn local_runner_args(
    runner_id: &str,
    token_file: &Path,
    data_dir: &Path,
    intent: LocalRunnerLaunchIntent,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "--runner-id".to_string(),
        runner_id.to_string(),
        "--control-plane-url".to_string(),
        format!("ws://{LOCAL_HOST}:{CP_PORT}/runner"),
        "--token-file".to_string(),
        token_file.to_string_lossy().into_owned(),
        "--data-dir".to_string(),
        data_dir.to_string_lossy().into_owned(),
    ];
    if intent == LocalRunnerLaunchIntent::UserRequested
        && !local_runner_owner_marker_present(data_dir)?
    {
        args.push("--adopt-legacy-data-dir".to_string());
    }
    Ok(args)
}

fn spawn_local_runner(
    app: &tauri::AppHandle,
    runner_id: &str,
    generation: u64,
    intent: LocalRunnerLaunchIntent,
) -> Result<ManagedChild, String> {
    if !valid_runner_id(runner_id) {
        return Err("the local runner id is invalid".into());
    }
    let token_file = local_runner_token_path(app)?;
    if !token_file.is_file() {
        return Err("the local runner credential is missing; reconnect this machine".into());
    }
    let data_dir = local_runner_data_dir(app)?;
    fs::create_dir_all(&data_dir)
        .map_err(|error| format!("could not create the local runner data directory: {error}"))?;
    let cwd = app_data_dir(app)?;
    let args = local_runner_args(runner_id, &token_file, &data_dir, intent)?;
    let (mut rx, child) = app
        .shell()
        .sidecar("runner")
        .map_err(|error| format!("bundled local runner not found: {error}"))?
        .current_dir(cwd)
        .args(args)
        .spawn()
        .map_err(|error| format!("failed to start the bundled local runner: {error}"))?;
    let terminated = Arc::new(AtomicBool::new(false));
    let task_terminated = Arc::clone(&terminated);
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    if !line.trim().is_empty() {
                        eprintln!("[local-runner] {}", line.trim_end());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    task_terminated.store(true, Ordering::Release);
                    let local_runner = task_app.state::<LocalRunner>();
                    let mut state = local_runner.0.lock().unwrap();
                    clear_terminated_local_runner(&mut state, generation);
                    eprintln!(
                        "[local-runner] stopped (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    break;
                }
                CommandEvent::Error(error) => eprintln!("[local-runner] {error}"),
                CommandEvent::Stdout(_) => {}
                _ => {}
            }
        }
    });
    Ok(ManagedChild::new(child, terminated))
}

struct LocalRunnerReplacementFailure {
    message: String,
    generation: Option<u64>,
    credential_generation: Option<u64>,
}

impl LocalRunnerReplacementFailure {
    fn attempt_is_current<C>(&self, state: &LocalRunnerState<C>) -> bool {
        self.generation
            .is_some_and(|generation| state.generation == generation)
    }

    fn is_latest_credential_writer<C>(&self, state: &LocalRunnerState<C>) -> bool {
        self.credential_generation
            .is_some_and(|generation| state.credential_generation == generation)
    }
}

fn should_restore_replacement_credential<C>(
    failure: &LocalRunnerReplacementFailure,
    state: &LocalRunnerState<C>,
    same_runner_id: bool,
) -> bool {
    should_restore_previous_local_runner_credential(
        same_runner_id,
        failure.is_latest_credential_writer(state),
    )
}

fn restore_replacement_credential_if_decided(
    should_restore: bool,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if !should_restore {
        return Ok(false);
    }
    restore()?;
    Ok(true)
}

fn replace_local_runner(
    app: &tauri::AppHandle,
    runner_id: &str,
    intent: LocalRunnerLaunchIntent,
    stage_credential: impl FnOnce() -> Result<(), String>,
    writes_credential: bool,
    publish_settings: impl FnOnce() -> Result<(), String>,
) -> Result<(), LocalRunnerReplacementFailure> {
    let sidecar = app.state::<Sidecar>();
    let _operation = sidecar
        .1
        .begin()
        .map_err(|message| LocalRunnerReplacementFailure {
            message,
            generation: None,
            credential_generation: None,
        })?;
    if !our_control_plane_running() {
        return Err(LocalRunnerReplacementFailure {
            message: "the local control plane is not ready".into(),
            generation: None,
            credential_generation: None,
        });
    }
    let local_runner = app.state::<LocalRunner>();
    let (generation, credential_generation, previous) = {
        let mut state = local_runner.0.lock().unwrap();
        stage_local_runner_replacement(&mut state, stage_credential, writes_credential).map_err(
            |message| LocalRunnerReplacementFailure {
                message,
                generation: None,
                credential_generation: None,
            },
        )?
    };
    if let Some(child) = previous {
        terminate_managed_child(child, "previous local runner");
    }
    let spawn_is_current = {
        let state = local_runner.0.lock().unwrap();
        if state.shutting_down {
            Err("the desktop is shutting down")
        } else if state.generation != generation {
            Err("the bundled local runner replacement was superseded")
        } else {
            Ok(())
        }
    };
    spawn_is_current.map_err(|message| LocalRunnerReplacementFailure {
        message: message.into(),
        generation: Some(generation),
        credential_generation,
    })?;
    let child = spawn_local_runner(app, runner_id, generation, intent).map_err(|message| {
        LocalRunnerReplacementFailure {
            message,
            generation: Some(generation),
            credential_generation,
        }
    })?;
    let terminated = child.has_terminated();
    let committed = {
        let mut state = local_runner.0.lock().unwrap();
        commit_local_runner_candidate(
            &mut state,
            generation,
            runner_id.to_string(),
            child,
            terminated,
            publish_settings,
        )
    };
    match committed {
        Ok(()) => Ok(()),
        Err((child, message)) => {
            terminate_managed_child(child, "rejected local runner candidate");
            Err(LocalRunnerReplacementFailure {
                message,
                generation: Some(generation),
                credential_generation,
            })
        }
    }
}

fn start_saved_local_runner(app: &tauri::AppHandle) {
    // The control-plane sidecar is spawned immediately before this function, but its listener is
    // not necessarily ready yet. Keep filesystem, TCP and process work off both the UI thread and
    // async-runtime workers while allowing the embedded server a bounded window to become healthy.
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let settings = read_settings(&task_app);
        let Some(local) = settings.local_runner else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(15);
        while !our_control_plane_running() {
            if task_app.state::<Sidecar>().1.is_shutting_down() {
                return;
            }
            if Instant::now() >= deadline {
                eprintln!("[desktop] could not start the saved local runner: the local control plane did not become ready");
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let registry = task_app.state::<InstanceRegistryState>();
        let guard = registry.0.blocking_lock();
        let should_restore = {
            let local_runner = task_app.state::<LocalRunner>();
            let state = local_runner.0.lock().unwrap();
            decide_saved_local_runner_restore(&guard, &local.runner_id, &state, || {
                read_settings_result(&task_app)
                    .map(|settings| settings.local_runner.map(|current| current.runner_id))
            })
        };
        let should_restore = match should_restore {
            Ok(should_restore) => should_restore,
            Err(error) => {
                eprintln!("[desktop] could not start the saved local runner: {error}");
                return;
            }
        };
        if !should_restore {
            eprintln!(
                "[desktop] skipped restoring saved local runner {} because newer configuration won",
                local.runner_id
            );
            return;
        }
        match replace_local_runner(
            &task_app,
            &local.runner_id,
            LocalRunnerLaunchIntent::RestoreSaved,
            || Ok(()),
            false,
            || Ok(()),
        ) {
            Ok(()) => eprintln!("[desktop] local runner started as {}", local.runner_id),
            Err(error) => eprintln!(
                "[desktop] could not start the saved local runner: {}",
                error.message
            ),
        }
    });
}

fn local_runner_status_snapshot(
    configured_runner_id: Option<String>,
    credential_present: bool,
    running_runner_id: Option<String>,
    running: bool,
    suggested_runner_id: String,
) -> LocalRunnerStatus {
    let enabled = configured_runner_id.is_some() && credential_present;
    let runner_id = running_runner_id.or(configured_runner_id);
    LocalRunnerStatus {
        available: true,
        enabled,
        running,
        runner_id,
        suggested_runner_id,
    }
}

fn local_runner_status_value(
    app: &tauri::AppHandle,
    local_runner: &LocalRunner,
) -> LocalRunnerStatus {
    let suggested_runner_id = local_runner_suggestion_or_default(
        local_runner_machine_id_path(app).and_then(|path| suggested_local_runner_id(&path)),
    );
    let settings = read_settings(app);
    let configured_runner_id = settings.local_runner.map(|local| local.runner_id);
    let credential_present = local_runner_token_path(app)
        .map(|path| path.is_file())
        .unwrap_or(false);
    let state = local_runner.0.lock().unwrap();
    let running = state.child.is_some();
    local_runner_status_snapshot(
        configured_runner_id,
        credential_present,
        state.runner_id.clone(),
        running,
        suggested_runner_id,
    )
}

const EXTERNAL_URL_POLICY_ERROR_PREFIX: &str = "wollipog-external-url-policy:";

fn external_url_has_userinfo(url: &str) -> bool {
    let authority = url
        .split_once("://")
        .map(|(_, authority)| authority)
        .unwrap_or("");
    let end = authority.find(['/', '?', '#']).unwrap_or(authority.len());
    authority[..end].contains('@')
}

fn validate_external_url(url: &str) -> Result<(), String> {
    if url.is_empty() || url.trim() != url || url.chars().any(char::is_control) {
        return Err(
            "Wollipog can open only complete HTTP or HTTPS links in your system browser.".into(),
        );
    }
    let Some((raw_scheme, _)) = url.split_once("://") else {
        return Err(
            "Wollipog can open only complete HTTP or HTTPS links in your system browser.".into(),
        );
    };
    if !raw_scheme.eq_ignore_ascii_case("http") && !raw_scheme.eq_ignore_ascii_case("https") {
        return Err("Wollipog can open only HTTP and HTTPS links in your system browser.".into());
    }
    let parsed = url::Url::parse(url).map_err(|_| {
        "Wollipog can open only complete HTTP or HTTPS links in your system browser.".to_string()
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "Wollipog can open only HTTP and HTTPS links in your system browser; {} links are blocked.",
            parsed.scheme()
        ));
    }
    if parsed.host_str().is_none() {
        return Err("This HTTP or HTTPS link does not include a valid host.".into());
    }
    if external_url_has_userinfo(url)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(
            "Remove the embedded username or password before opening this link in your system browser."
                .into(),
        );
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum ExternalUrlOpenError {
    Policy(String),
    Opener(String),
}

fn open_external_url_with(
    url: String,
    opener: impl FnOnce(String) -> Result<(), String>,
) -> Result<(), ExternalUrlOpenError> {
    validate_external_url(&url).map_err(ExternalUrlOpenError::Policy)?;
    opener(url).map_err(ExternalUrlOpenError::Opener)
}

fn external_url_open_error_message(error: ExternalUrlOpenError) -> String {
    match error {
        ExternalUrlOpenError::Policy(message) => {
            format!("{EXTERNAL_URL_POLICY_ERROR_PREFIX}{message}")
        }
        ExternalUrlOpenError::Opener(message) => {
            format!("The system browser could not open this link: {message}")
        }
    }
}

/// The only page-accessible route to the OS opener. The caller cannot select a program, execute a
/// command, or open a local path; validation happens again here at the native trust boundary.
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_external_url_with(url, |url| {
        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|error| error.to_string())
    })
    .map_err(external_url_open_error_message)
}

#[tauri::command]
fn local_runner_status(
    app: tauri::AppHandle,
    local_runner: State<'_, LocalRunner>,
) -> LocalRunnerStatus {
    local_runner_status_value(&app, &local_runner)
}

#[tauri::command]
fn local_pairing_url(
    app: tauri::AppHandle,
    sidecar: State<'_, Sidecar>,
) -> Result<Option<String>, String> {
    let generation = {
        let state = sidecar.0.lock().unwrap();
        let Some(generation) = managed_sidecar_generation(&state) else {
            return Ok(None);
        };
        generation
    };
    let token = read_local_device_token(&app)?;
    let state = sidecar.0.lock().unwrap();
    if !managed_sidecar_generation_is_current(&state, generation) {
        return Ok(None);
    }
    Ok(Some(format!("http://{LOCAL_HOST}:{CP_PORT}/#pair={token}")))
}

#[tauri::command]
async fn connect_local_runner(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    runner_id: String,
    local_device_token: Option<String>,
) -> Result<LocalRunnerStatus, String> {
    let _guard = registry.0.lock().await;
    tokio::task::spawn_blocking(move || {
        connect_local_runner_blocking(&app, runner_id, local_device_token)
    })
    .await
    .map_err(|error| format!("Local runner setup task failed: {error}"))?
}

fn connect_local_runner_blocking(
    app: &tauri::AppHandle,
    runner_id: String,
    local_device_token: Option<String>,
) -> Result<LocalRunnerStatus, String> {
    if !valid_runner_id(&runner_id) {
        return Err("Choose a valid local runner name.".into());
    }
    let local_runner = app.state::<LocalRunner>();
    let sidecar = app.state::<Sidecar>();
    enum ProvisioningChannel {
        External(String),
        Managed {
            generation: u64,
            identity: Arc<SidecarLaunchIdentity>,
        },
    }
    let provisioning = {
        let state = sidecar.0.lock().unwrap();
        match local_runner_control_plane(&state).map_err(str::to_string)? {
            LocalRunnerControlPlane::External => ProvisioningChannel::External(
                select_external_local_runner_authorization_token(local_device_token)?,
            ),
            LocalRunnerControlPlane::Managed(generation) => {
                let (identity_generation, identity) = managed_sidecar_identity(&state)
                    .ok_or_else(|| "the local control plane is not ready".to_string())?;
                debug_assert_eq!(generation, identity_generation);
                ProvisioningChannel::Managed {
                    generation,
                    identity,
                }
            }
        }
    };
    let previous_settings = read_settings_result(app)?;
    let same_runner_id = previous_settings
        .local_runner
        .as_ref()
        .is_some_and(|local| local.runner_id == runner_id);
    let credential_path = local_runner_token_path(app)?;
    let previous_credential = snapshot_local_runner_credential_file(&credential_path)?;
    if matches!(&provisioning, ProvisioningChannel::External(_)) && !our_control_plane_running() {
        return Err("the local control plane is not ready".into());
    }
    let token = match &provisioning {
        ProvisioningChannel::External(authorization_token) => {
            provision_local_runner_credential(&runner_id, authorization_token)?
        }
        ProvisioningChannel::Managed {
            generation,
            identity,
        } => {
            {
                let state = sidecar.0.lock().unwrap();
                if !managed_sidecar_identity_is_current(&state, *generation, &identity.launch_id) {
                    return Err("the local control plane changed before provisioning".into());
                }
            }
            let token = provision_managed_local_runner_credential(&runner_id, identity)?;
            let state = sidecar.0.lock().unwrap();
            if !managed_sidecar_identity_is_current(&state, *generation, &identity.launch_id) {
                return Err("the local control plane changed while provisioning".into());
            }
            token
        }
    };
    let mut next_settings = previous_settings;
    next_settings.local_runner = Some(LocalRunnerSettings {
        runner_id: runner_id.clone(),
    });
    if let Err(failure) = replace_local_runner(
        app,
        &runner_id,
        LocalRunnerLaunchIntent::UserRequested,
        || {
            if let Err(error) = write_local_runner_token(app, &token) {
                let rollback = if same_runner_id {
                    Ok(())
                } else {
                    restore_local_runner_credential_file(&credential_path, &previous_credential)
                };
                return Err(match rollback {
                    Ok(()) => error,
                    Err(rollback_error) => {
                        format!("{error}; rollback also failed: {rollback_error}")
                    }
                });
            }
            Ok(())
        },
        true,
        || write_settings(app, next_settings),
    ) {
        let (attempt_is_current, should_restore) = {
            let state = local_runner.0.lock().unwrap();
            (
                failure.attempt_is_current(&state),
                should_restore_replacement_credential(&failure, &state, same_runner_id),
            )
        };
        let restore = restore_replacement_credential_if_decided(should_restore, || {
            restore_local_runner_credential_file(&credential_path, &previous_credential)
        });
        let restored = restore.map_err(|rollback_error| {
            format!(
                "{}; credential rollback also failed: {rollback_error}",
                failure.message
            )
        })?;
        if restored && !attempt_is_current {
            eprintln!(
                "[desktop] restoring the local runner credential after process replacement was superseded"
            );
        }
        return Err(failure.message);
    }
    Ok(local_runner_status_value(app, &local_runner))
}

#[tauri::command]
fn tailnet_access_status(
    app: tauri::AppHandle,
    sidecar: State<'_, Sidecar>,
) -> TailnetAccessStatus {
    let settings = read_settings(&app);
    let state = sidecar.0.lock().unwrap();
    TailnetAccessStatus {
        available: true,
        enabled: settings.tailnet_access,
        managed: state.phase != SidecarPhase::External,
    }
}

fn format_tailnet_access_error(error: String) -> String {
    match error.as_str() {
        "Tailnet access cannot be changed while another control plane owns port 4317."
        | "The local control plane is already being reconfigured."
        | "The local control plane did not stop; Tailnet access was not changed." => error,
        _ => format!("Tailnet access could not be changed: {error}"),
    }
}

#[tauri::command]
async fn set_tailnet_access(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    enabled: bool,
) -> Result<TailnetAccessStatus, String> {
    let _guard = registry.0.lock().await;
    let task_app = app.clone();
    tokio::task::spawn_blocking(move || {
        let previous = read_settings_result(&task_app)?;
        let previous_tailnet_access = previous.tailnet_access;
        let previous_settings = previous.clone();
        let next = DesktopSettings {
            tailnet_access: enabled,
            ..previous
        };
        let sidecar = task_app.state::<Sidecar>();
        reconfigure_sidecar_operation(
            &sidecar.0,
            &sidecar.1,
            SidecarNetworkChange {
                previous_tailnet_access,
                enabled,
            },
            |child| terminate_managed_child(child, "control-plane sidecar"),
            || wait_for_sidecar_stopped(&task_app),
            |tailnet_access, generation| {
                spawn_sidecar_process(&task_app, tailnet_access, generation)
            },
            || wait_for_sidecar_ready(&task_app),
            || write_settings(&task_app, next.clone()),
            |tailnet_access| {
                write_settings(
                    &task_app,
                    DesktopSettings {
                        tailnet_access,
                        ..previous_settings.clone()
                    },
                )
            },
        )
        .map_err(format_tailnet_access_error)?;
        Ok(TailnetAccessStatus {
            available: true,
            enabled,
            managed: true,
        })
    })
    .await
    .map_err(|error| format!("Tailnet access reconfiguration task failed: {error}"))?
}

fn run_runtime_then_finalize<L>(
    ownership: L,
    run_return: impl FnOnce() -> i32,
    finalize: impl FnOnce(),
    release: impl FnOnce(L),
) -> i32 {
    let exit_code = run_return();
    finalize();
    release(ownership);
    exit_code
}

fn teardown_managed_processes_with<T>(
    begin_shutdown: impl FnOnce(),
    take_children: impl FnOnce() -> T,
    terminate_children: impl FnOnce(T),
    close_transports: impl FnOnce(),
    drain_operations: impl FnOnce() -> bool,
) -> bool {
    begin_shutdown();
    let children = take_children();
    terminate_children(children);
    close_transports();
    drain_operations()
}

fn finalize_managed_processes_with<T>(
    begin_shutdown: impl FnOnce(),
    mut take_children: impl FnMut() -> T,
    mut terminate_children: impl FnMut(T),
    drain_operations: impl FnOnce() -> bool,
    active_operations: impl FnOnce() -> usize,
) -> (bool, usize) {
    begin_shutdown();
    terminate_children(take_children());
    let drained = drain_operations();
    // A permitted operation may have installed a child after the committed-Exit snapshot.
    // Re-snapshot after the bounded drain and escalate every child known at this point.
    terminate_children(take_children());
    (drained, active_operations())
}

fn take_managed_children_for_shutdown(
    app: &tauri::AppHandle,
) -> (Option<ManagedChild>, Option<ManagedChild>) {
    let sidecar = app.state::<Sidecar>();
    // Mark both lifecycle states before doing any I/O. An operation already between spawn and
    // installation will now reject and terminate its candidate instead of publishing it.
    let sidecar_child = {
        let mut state = sidecar.0.lock().unwrap();
        shutdown_sidecar(&mut state)
    };
    let local_runner_child = {
        let local_runner = app.state::<LocalRunner>();
        let mut state = local_runner.0.lock().unwrap();
        shutdown_local_runner(&mut state)
    };
    (sidecar_child, local_runner_child)
}

fn terminate_owned_children(
    (sidecar_child, local_runner_child): (Option<ManagedChild>, Option<ManagedChild>),
) {
    let mut children = Vec::with_capacity(2);
    if let Some(child) = local_runner_child {
        children.push((child, "local runner"));
    }
    if let Some(child) = sidecar_child {
        children.push((child, "control-plane sidecar"));
    }
    terminate_managed_children(children);
}

fn teardown_managed_processes(app: &tauri::AppHandle) {
    let operations = Arc::clone(&app.state::<Sidecar>().1);
    let drained = teardown_managed_processes_with(
        || operations.begin_shutdown(),
        || take_managed_children_for_shutdown(app),
        terminate_owned_children,
        || {
            let remote_transport = app.state::<RemoteTransport>().inner().clone();
            tauri::async_runtime::block_on(remote_transport.close_all());
        },
        || operations.wait_for_idle(SIDECAR_OPERATION_DRAIN_TIMEOUT),
    );

    if !drained {
        eprintln!(
            "[desktop] timed out draining an in-flight managed-process operation during exit"
        );
    }
}

fn finalize_managed_processes_after_runtime(app: &tauri::AppHandle) {
    let operations = Arc::clone(&app.state::<Sidecar>().1);
    let (drained, active) = finalize_managed_processes_with(
        || operations.begin_shutdown(),
        || take_managed_children_for_shutdown(app),
        terminate_owned_children,
        || operations.wait_for_idle(SIDECAR_OPERATION_DRAIN_TIMEOUT),
        || operations.active_count(),
    );
    if !drained || active != 0 {
        eprintln!(
            "[desktop] final managed-process drain completed with {active} operation permit(s) still active"
        );
    }
}

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
fn focus_existing_instance(app: &tauri::AppHandle) -> bool {
    if let Some(window) = app.webview_windows().values().next() {
        let _ = window.unminimize();
        return window.set_focus().is_ok();
    }
    false
}

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
fn process_ownership_phase_plugin(
    notification_path: PathBuf,
) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("process-ownership-phase")
        .on_event(move |_app, event| {
            if let RunEvent::Exit = event {
                let _ = publish_process_ownership_marker(
                    &notification_path,
                    &ProcessOwnershipMarker::phase(ProcessOwnershipPhase::ShuttingDown),
                );
            }
        })
        .build()
}

#[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
fn process_owner_focus_callback(app: tauri::AppHandle) -> Arc<dyn Fn() -> bool + Send + Sync> {
    Arc::new(move || {
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let task_app = app.clone();
        if app
            .run_on_main_thread(move || {
                let _ = result_tx.send(focus_existing_instance(&task_app));
            })
            .is_err()
        {
            return false;
        }
        result_rx
            .recv_timeout(OWNERSHIP_NOTIFICATION_FOCUS_TIMEOUT)
            .unwrap_or(false)
    })
}

fn handle_run_event(app: &tauri::AppHandle, event: RunEvent) {
    if let RunEvent::ExitRequested { api, .. } = &event {
        let authorized = take_exit_authorization(&app.state::<CloseGuard>());
        if should_guard_exit(authorized) && hold_close_for_work(app) {
            api.prevent_exit();
        }
    }
    if let RunEvent::Exit = event {
        teardown_managed_processes(app);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    // This kernel-backed lock is acquired before full plugin registration and before setup can
    // start either bundled child. A contender can only use the owner's authenticated loopback
    // focus endpoint or wait a bounded interval for authoritative lock release; it never builds
    // another Tauri runtime or competes for the single-instance plugin registration.
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    let process_ownership = match resolve_process_ownership(&context.config().identifier) {
        Ok(ProcessOwnershipResolution::Acquired(ownership)) => ownership,
        Ok(ProcessOwnershipResolution::Notified) => return,
        Ok(ProcessOwnershipResolution::TimedOut) => {
            eprintln!("[desktop] another Wollipog desktop process owns the bundled services");
            return;
        }
        Err(error) => {
            eprintln!("[desktop] {error}");
            return;
        }
    };
    let builder = tauri::Builder::default();
    let managed_process_operations = Arc::new(SidecarOperations::default());

    // §23.4. A second launch would race the first for the sidecar port and for the settings file,
    // which is written atomically but not locked. Focus the window that is already running instead.
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    let builder = builder
        // PluginStore initializes and dispatches events in registration order. Publish shutdown
        // before single-instance destroys its platform registration on RunEvent::Exit.
        .plugin(process_ownership_phase_plugin(
            process_ownership.notification_path.clone(),
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = focus_existing_instance(app);
        }));

    // §23.2. Geometry is restored on launch; without it the window opens at the default size every
    // time, on whichever display the OS picks. Desktop only — the crate is compiled out on mobile,
    // so an unconditional reference to its `Builder` fails to build for Android and iOS.
    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    let builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());

    let app = builder
        .plugin(tauri_plugin_shell::init())
        .manage(CloseGuard::default())
        .manage(Sidecar(
            Mutex::new(SidecarState::default()),
            Arc::clone(&managed_process_operations),
        ))
        .manage(LocalRunner::default())
        .manage(InstanceRegistryState::default())
        .manage(RemoteTransport::default())
        .invoke_handler(tauri::generate_handler![
            tailnet_access_status,
            set_tailnet_access,
            local_runner_status,
            local_pairing_url,
            connect_local_runner,
            instance_registry,
            add_remote_instance,
            edit_remote_instance,
            repair_remote_instance,
            remove_remote_instance,
            set_active_instance,
            remote_transport_open,
            remote_http_request,
            remote_http_cancel,
            remote_transport_close,
            remote_ui_open,
            remote_ui_send,
            remote_ui_close,
            open_external_url
        ])
        .on_window_event(|window, event| {
            // §23.1. `RunEvent::Exit` kills the sidecar and the local runner, so closing the window
            // ends every in-flight agent turn. Hold the FIRST close while work is running; a second
            // always exits, so this can never strand a user in an app they cannot quit.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                if hold_close_for_work(&app) {
                    api.prevent_close();
                } else {
                    // This close was allowed. The `ExitRequested` it causes is the same gesture and
                    // must not be re-decided, or a race could strand a windowless process.
                    app.state::<CloseGuard>()
                        .exit_authorized
                        .store(true, Ordering::Relaxed);
                }
            }
        })
        .setup(|app| {
            start_sidecar(app.handle());
            start_saved_local_runner(app.handle());
            Ok(())
        })
        .build(context)
        .expect("error while building the Wollipog desktop shell");

    #[cfg(all(desktop, not(any(target_os = "android", target_os = "ios"))))]
    {
        let app_handle = app.handle().clone();
        let mut notification_server = ProcessOwnerNotificationServer::start(
            process_ownership.notification_path.clone(),
            process_owner_focus_callback(app_handle.clone()),
        )
        .map(Some)
        .unwrap_or_else(|error| {
            eprintln!("[desktop] {error}");
            None
        });
        let exit_code = run_runtime_then_finalize(
            process_ownership,
            || app.run_return(handle_run_event),
            || {
                if let Some(server) = notification_server.as_mut() {
                    server.stop();
                }
                finalize_managed_processes_after_runtime(&app_handle);
            },
            drop,
        );
        // Tauri's returning desktop runtime leaves process termination to its caller. Ownership
        // has been released only after the bounded final escalation above completed.
        std::process::exit(exit_code);
    }

    #[cfg(not(all(desktop, not(any(target_os = "android", target_os = "ios")))))]
    app.run(handle_run_event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_validation_allows_only_complete_credential_free_http_links() {
        for allowed in [
            "https://example.com/a%2Fb?q=x%20y#fragment",
            "http://localhost:4317/docs",
            "HTTPS://github.com/picoduck/wollipog",
        ] {
            assert_eq!(validate_external_url(allowed), Ok(()), "{allowed}");
        }
        for blocked in [
            "mailto:person@example.com",
            "file:///tmp/report.txt",
            "wollipog://session/123",
            "javascript:alert(1)",
            "https://user:password@example.com/private",
            "https://@example.com/empty-user",
            "https://?query",
            "https:example.com/no-authority",
            "/relative/path",
            " https://example.com",
            "https://example.com\n",
        ] {
            assert!(validate_external_url(blocked).is_err(), "{blocked}");
        }
    }

    #[test]
    fn external_url_opener_receives_the_exact_valid_url_once() {
        use std::cell::RefCell;

        let calls = RefCell::new(Vec::new());
        let url = "https://example.com/a%2Fb?q=x%20y#Case".to_string();
        open_external_url_with(url.clone(), |opened| {
            calls.borrow_mut().push(opened);
            Ok(())
        })
        .unwrap();
        assert_eq!(calls.into_inner(), vec![url]);
    }

    #[test]
    fn external_url_opener_is_not_called_for_blocked_input_and_propagates_failure() {
        use std::cell::Cell;

        let calls = Cell::new(0);
        let blocked = open_external_url_with("file:///tmp/private".into(), |_| {
            calls.set(calls.get() + 1);
            Ok(())
        });
        assert!(matches!(blocked, Err(ExternalUrlOpenError::Policy(_))));
        assert_eq!(calls.get(), 0);

        let failure = open_external_url_with("https://example.com".into(), |_| {
            calls.set(calls.get() + 1);
            Err("mocked opener failure".into())
        });
        assert_eq!(
            failure,
            Err(ExternalUrlOpenError::Opener("mocked opener failure".into()))
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(
            external_url_open_error_message(ExternalUrlOpenError::Policy("blocked".into())),
            format!("{EXTERNAL_URL_POLICY_ERROR_PREFIX}blocked")
        );
        assert_eq!(
            external_url_open_error_message(ExternalUrlOpenError::Opener("missing browser".into())),
            "The system browser could not open this link: missing browser"
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    const OWNERSHIP_HELPER_MODE: &str = "WOLLIPOG_OWNERSHIP_HELPER_MODE";
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    const OWNERSHIP_HELPER_LOCK_PATH: &str = "WOLLIPOG_OWNERSHIP_HELPER_LOCK_PATH";
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    const OWNERSHIP_HELPER_READY_PATH: &str = "WOLLIPOG_OWNERSHIP_HELPER_READY_PATH";
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    const OWNERSHIP_HELPER_MAX_LIFETIME: Duration = Duration::from_secs(30);

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    struct OwnershipHelperProcess {
        child: Option<std::process::Child>,
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    impl OwnershipHelperProcess {
        fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
            self.child
                .take()
                .expect("ownership helper already reaped")
                .wait()
        }

        fn kill_and_wait(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    impl Drop for OwnershipHelperProcess {
        fn drop(&mut self) {
            self.kill_and_wait();
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn ownership_test_directory(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "wollipog-ownership-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn wait_for_helper_ready(path: &Path) {
        assert!(
            wait_until(|| path.is_file(), true, Duration::from_secs(5)),
            "ownership helper did not become ready at {}",
            path.display()
        );
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn spawn_ownership_helper(
        mode: &str,
        lock_path: &Path,
        ready_path: &Path,
    ) -> OwnershipHelperProcess {
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--ignored")
            .arg("--exact")
            .arg("tests::process_ownership_lock_helper")
            .arg("--nocapture")
            .env(OWNERSHIP_HELPER_MODE, mode)
            .env(OWNERSHIP_HELPER_LOCK_PATH, lock_path)
            .env(OWNERSHIP_HELPER_READY_PATH, ready_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("ownership helper should start");
        OwnershipHelperProcess { child: Some(child) }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    #[ignore = "entrypoint used only by ownership helper-process tests"]
    fn process_ownership_lock_helper() {
        let mode = std::env::var(OWNERSHIP_HELPER_MODE).expect("helper mode");
        let lock_path =
            PathBuf::from(std::env::var_os(OWNERSHIP_HELPER_LOCK_PATH).expect("helper lock path"));
        let ready_path = PathBuf::from(
            std::env::var_os(OWNERSHIP_HELPER_READY_PATH).expect("helper ready path"),
        );
        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("helper unexpectedly lost ownership"),
        };
        fs::write(&ready_path, b"ready").unwrap();
        match mode.as_str() {
            "hold" => thread::sleep(OWNERSHIP_HELPER_MAX_LIFETIME),
            "exit-without-drop" => {
                std::mem::forget(ownership);
                std::process::exit(86);
            }
            _ => panic!("unknown helper mode"),
        }
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn ownership_lock_acquires_contends_drops_and_ignores_stale_file_contents() {
        let directory = ownership_test_directory("lifecycle");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        fs::write(&lock_path, b"stale owner metadata").unwrap();

        let first = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("first acquisition should win"),
        };
        assert!(matches!(
            acquire_process_ownership_at(&lock_path).unwrap(),
            ProcessOwnershipAttempt::Contended
        ));
        drop(first);
        let reacquired = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("drop should release kernel ownership"),
        };
        drop(reacquired);
        assert_eq!(fs::read(&lock_path).unwrap(), b"stale owner metadata");
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn ownership_lock_fails_closed_when_its_directory_cannot_be_created() {
        let directory = ownership_test_directory("bad-parent");
        fs::create_dir_all(&directory).unwrap();
        let parent_file = directory.join("not-a-directory");
        fs::write(&parent_file, b"file").unwrap();
        let error = match acquire_process_ownership_at(&parent_file.join(OWNERSHIP_LOCK_FILE)) {
            Ok(_) => panic!("an unusable ownership path must not allow startup"),
            Err(error) => error,
        };
        assert!(error.contains("could not create the desktop ownership directory"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn helper_process_contention_ends_only_when_the_owner_process_dies() {
        let directory = ownership_test_directory("helper-contention");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        let ready_path = directory.join("ready");
        let mut helper = spawn_ownership_helper("hold", &lock_path, &ready_path);
        wait_for_helper_ready(&ready_path);

        assert!(matches!(
            acquire_process_ownership_at(&lock_path).unwrap(),
            ProcessOwnershipAttempt::Contended
        ));
        helper.kill_and_wait();
        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => {
                panic!("the OS should release ownership when the helper is killed")
            }
        };
        drop(ownership);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn process_exit_without_drop_releases_the_lock_but_leaves_the_file() {
        let directory = ownership_test_directory("helper-crash");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        let ready_path = directory.join("ready");
        let mut helper = spawn_ownership_helper("exit-without-drop", &lock_path, &ready_path);
        wait_for_helper_ready(&ready_path);
        let status = helper.wait().unwrap();
        assert_eq!(status.code(), Some(86));
        assert!(
            lock_path.is_file(),
            "the persistent lock file is never deleted"
        );

        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => {
                panic!("process death should release ownership without running Drop")
            }
        };
        drop(ownership);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn stable_process_owner_acknowledges_only_the_published_nonce_and_successful_focus() {
        let directory = ownership_test_directory("notification-ack");
        fs::create_dir_all(&directory).unwrap();
        let marker_path = directory.join(OWNERSHIP_NOTIFICATION_FILE);
        let focused = Arc::new(AtomicBool::new(false));
        let task_focused = Arc::clone(&focused);
        let mut server = ProcessOwnerNotificationServer::start(
            marker_path.clone(),
            Arc::new(move || {
                task_focused.store(true, Ordering::Release);
                true
            }),
        )
        .unwrap();
        let marker = read_process_ownership_marker(&marker_path).unwrap();
        assert!(notify_process_owner(&marker));
        assert!(focused.load(Ordering::Acquire));

        let mut wrong_nonce = [0_u8; OWNERSHIP_NOTIFICATION_NONCE_BYTES];
        getrandom::fill(&mut wrong_nonce).unwrap();
        let stale = ProcessOwnershipMarker::ready(server.port, URL_SAFE_NO_PAD.encode(wrong_nonce));
        assert!(!notify_process_owner(&stale));
        server.stop();
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn notification_without_a_focusable_window_receives_no_acknowledgement() {
        let directory = ownership_test_directory("notification-no-window");
        fs::create_dir_all(&directory).unwrap();
        let marker_path = directory.join(OWNERSHIP_NOTIFICATION_FILE);
        let mut server =
            ProcessOwnerNotificationServer::start(marker_path.clone(), Arc::new(|| false)).unwrap();
        let marker = read_process_ownership_marker(&marker_path).unwrap();
        assert!(!notify_process_owner(&marker));
        server.stop();
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn notification_server_publish_failure_stops_its_listener_within_the_join_budget() {
        let directory = ownership_test_directory("notification-publish-failure");
        let marker_directory = directory.join("marker-is-a-directory");
        fs::create_dir_all(&marker_directory).unwrap();
        let started = Instant::now();
        let result = ProcessOwnerNotificationServer::start(marker_directory, Arc::new(|| true));
        assert!(result.is_err());
        assert!(started.elapsed() < OWNERSHIP_NOTIFICATION_JOIN_TIMEOUT + Duration::from_secs(1));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn contention_notifies_a_ready_owner_without_registering_another_runtime() {
        let directory = ownership_test_directory("notification-contention");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("test process should own the lock"),
        };
        let focused = Arc::new(AtomicBool::new(false));
        let task_focused = Arc::clone(&focused);
        let mut server = ProcessOwnerNotificationServer::start(
            ownership.notification_path.clone(),
            Arc::new(move || {
                task_focused.store(true, Ordering::Release);
                true
            }),
        )
        .unwrap();

        assert!(matches!(
            resolve_process_ownership_at(&lock_path, Duration::from_secs(1)).unwrap(),
            ProcessOwnershipResolution::Notified
        ));
        assert!(focused.load(Ordering::Acquire));
        server.stop();
        drop(ownership);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn contender_takes_over_only_after_notification_shutdown_and_lock_release() {
        let directory = ownership_test_directory("notification-takeover");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("test process should own the lock"),
        };
        let mut server = ProcessOwnerNotificationServer::start(
            ownership.notification_path.clone(),
            Arc::new(|| false),
        )
        .unwrap();
        let task_lock_path = lock_path.clone();
        let contender = thread::spawn(move || {
            resolve_process_ownership_at(&task_lock_path, Duration::from_secs(2)).unwrap()
        });
        thread::sleep(Duration::from_millis(100));
        server.stop();
        drop(ownership);

        let next_ownership = match contender.join().unwrap() {
            ProcessOwnershipResolution::Acquired(ownership) => ownership,
            ProcessOwnershipResolution::Notified => {
                panic!("an unacknowledged notification must not consume the launch")
            }
            ProcessOwnershipResolution::TimedOut => panic!("released ownership should be acquired"),
        };
        drop(next_ownership);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn marker_parsing_rejects_oversized_unknown_and_semantically_invalid_state() {
        let directory = ownership_test_directory("notification-marker");
        fs::create_dir_all(&directory).unwrap();
        let marker_path = directory.join(OWNERSHIP_NOTIFICATION_FILE);
        fs::write(
            &marker_path,
            vec![b'x'; OWNERSHIP_NOTIFICATION_MARKER_MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert!(read_process_ownership_marker(&marker_path).is_none());
        fs::write(
            &marker_path,
            br#"{"version":1,"phase":"ready","port":4317,"nonce":"AA","extra":true}"#,
        )
        .unwrap();
        assert!(read_process_ownership_marker(&marker_path).is_none());
        assert!(
            ProcessOwnershipMarker::ready(0, URL_SAFE_NO_PAD.encode([0_u8; 32]))
                .ready_endpoint()
                .is_none()
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn ownership_phase_plugin_is_registered_before_single_instance() {
        let source = include_str!("lib.rs");
        let phase = source
            .find(".plugin(process_ownership_phase_plugin(")
            .expect("ownership phase plugin registration");
        let single = source
            .find(".plugin(tauri_plugin_single_instance::init(")
            .expect("single-instance plugin registration");
        assert!(
            phase < single,
            "phase Exit hook must run before single-instance destroys registration"
        );
    }

    #[test]
    fn contender_and_shutdown_wiring_preserve_the_ownership_invariant() {
        let source = include_str!("lib.rs");
        let resolution = source
            .find("Ok(ProcessOwnershipResolution::Notified) => return")
            .expect("acknowledged contenders exit before builder construction");
        let builder = source[resolution..]
            .find("let builder = tauri::Builder::default()")
            .map(|offset| resolution + offset)
            .expect("full builder construction");
        assert!(resolution < builder);

        let runtime = source
            .find("let exit_code = run_runtime_then_finalize(")
            .expect("desktop returning runtime");
        let runtime_end = source[runtime..]
            .find("std::process::exit(exit_code);")
            .map(|offset| runtime + offset)
            .expect("desktop process exit");
        let runtime_source = &source[runtime..runtime_end];
        let stop = runtime_source
            .find("server.stop();")
            .expect("notification server stop in finalizer");
        let final_drain = runtime_source
            .find("finalize_managed_processes_after_runtime")
            .expect("final managed-process drain");
        let ownership_release = runtime_source
            .find("drop,")
            .expect("ownership release callback");
        assert!(
            stop < final_drain && final_drain < ownership_release,
            "listener stop and final drain must both precede OS ownership release"
        );
    }

    #[test]
    fn local_runner_replacement_is_dispatched_to_a_blocking_worker() {
        let source = include_str!("lib.rs");
        let start = source
            .find("async fn connect_local_runner(")
            .expect("connect command");
        let end = source[start..]
            .find("fn connect_local_runner_blocking(")
            .map(|offset| start + offset)
            .expect("blocking implementation");
        assert!(
            source[start..end].contains("tokio::task::spawn_blocking"),
            "process, filesystem, and TCP replacement work must not block an async worker"
        );
    }

    #[test]
    fn local_runner_adoption_requires_an_explicit_reconnect() {
        let data_dir = std::env::temp_dir().join(format!(
            "wollipog-local-runner-args-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&data_dir).unwrap();
        let token_file = Path::new("runner-token");
        let restored = local_runner_args(
            "local-runner",
            token_file,
            &data_dir,
            LocalRunnerLaunchIntent::RestoreSaved,
        )
        .unwrap();
        let reconnected = local_runner_args(
            "local-runner",
            token_file,
            &data_dir,
            LocalRunnerLaunchIntent::UserRequested,
        )
        .unwrap();
        assert!(!restored.iter().any(|arg| arg == "--adopt-legacy-data-dir"));
        assert_eq!(
            reconnected
                .iter()
                .filter(|arg| arg.as_str() == "--adopt-legacy-data-dir")
                .count(),
            1
        );
        for marker in [LOCAL_RUNNER_OWNER_FILE, LOCAL_RUNNER_LEGACY_OWNER_FILE] {
            let marker_path = data_dir.join(marker);
            fs::write(&marker_path, b"malformed marker must remain fail-closed").unwrap();
            let owned_restore = local_runner_args(
                "local-runner",
                token_file,
                &data_dir,
                LocalRunnerLaunchIntent::RestoreSaved,
            )
            .unwrap();
            assert!(
                !owned_restore
                    .iter()
                    .any(|arg| arg == "--adopt-legacy-data-dir"),
                "automatic restore must never receive legacy adoption authority"
            );
            let owned_reconnect = local_runner_args(
                "renamed-runner",
                token_file,
                &data_dir,
                LocalRunnerLaunchIntent::UserRequested,
            )
            .unwrap();
            assert!(
                !owned_reconnect
                    .iter()
                    .any(|arg| arg == "--adopt-legacy-data-dir"),
                "{marker} must reach the runner's fail-closed validation"
            );
            fs::remove_file(marker_path).unwrap();
        }
        fs::remove_dir_all(&data_dir).unwrap();

        let source = include_str!("lib.rs");
        let saved_start = source
            .find("fn start_saved_local_runner(")
            .expect("saved local runner startup");
        let saved_end = source[saved_start..]
            .find("fn local_runner_status_snapshot(")
            .map(|offset| saved_start + offset)
            .expect("saved startup boundary");
        let saved_source = &source[saved_start..saved_end];
        assert!(saved_source.contains("LocalRunnerLaunchIntent::RestoreSaved"));
        assert!(!saved_source.contains("LocalRunnerLaunchIntent::UserRequested"));

        let reconnect_start = source
            .find("fn connect_local_runner_blocking(")
            .expect("user reconnect implementation");
        let reconnect_end = source[reconnect_start..]
            .find("fn disconnect_local_runner_blocking(")
            .map(|offset| reconnect_start + offset)
            .expect("user reconnect boundary");
        assert!(source[reconnect_start..reconnect_end]
            .contains("LocalRunnerLaunchIntent::UserRequested"));

        let replacement_start = source
            .find("fn replace_local_runner(")
            .expect("local runner replacement");
        let replacement_end = source[replacement_start..]
            .find("fn start_saved_local_runner(")
            .map(|offset| replacement_start + offset)
            .expect("replacement boundary");
        let replacement_source = &source[replacement_start..replacement_end];
        let terminate = replacement_source
            .find("terminate_managed_child(child, \"previous local runner\")")
            .expect("previous runner termination");
        let spawn = replacement_source
            .find("spawn_local_runner(app, runner_id, generation, intent)")
            .expect("new runner spawn");
        assert!(
            terminate < spawn,
            "the managed child must stop before adoption"
        );
    }

    #[test]
    fn runtime_returns_before_final_drain_and_ownership_release() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let runtime_events = Arc::clone(&events);
        let finalizer_events = Arc::clone(&events);
        let release_events = Arc::clone(&events);
        let exit_code = run_runtime_then_finalize(
            (),
            || {
                runtime_events.lock().unwrap().push("runtime");
                27
            },
            || finalizer_events.lock().unwrap().push("finalize"),
            move |_| release_events.lock().unwrap().push("release"),
        );
        assert_eq!(exit_code, 27);
        assert_eq!(*events.lock().unwrap(), ["runtime", "finalize", "release"]);
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn real_process_ownership_remains_held_through_runtime_and_finalization() {
        let directory = ownership_test_directory("runtime-finalization");
        fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join(OWNERSHIP_LOCK_FILE);
        let ownership = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => panic!("test process should own the lock"),
        };
        run_runtime_then_finalize(
            ownership,
            || {
                assert!(matches!(
                    acquire_process_ownership_at(&lock_path).unwrap(),
                    ProcessOwnershipAttempt::Contended
                ));
                0
            },
            || {
                assert!(matches!(
                    acquire_process_ownership_at(&lock_path).unwrap(),
                    ProcessOwnershipAttempt::Contended
                ));
            },
            drop,
        );
        let reacquired = match acquire_process_ownership_at(&lock_path).unwrap() {
            ProcessOwnershipAttempt::Acquired(ownership) => ownership,
            ProcessOwnershipAttempt::Contended => {
                panic!("ownership should release after finalization")
            }
        };
        drop(reacquired);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn managed_children_are_all_signaled_before_any_confirmation_wait() {
        struct TestChild {
            name: &'static str,
            terminated: Arc<AtomicBool>,
        }

        let events = Arc::new(Mutex::new(Vec::new()));
        let first_terminated = Arc::new(AtomicBool::new(false));
        let second_terminated = Arc::new(AtomicBool::new(false));
        let children = vec![
            (
                ManagedChild::new(
                    TestChild {
                        name: "sidecar",
                        terminated: Arc::clone(&first_terminated),
                    },
                    Arc::clone(&first_terminated),
                ),
                "control-plane sidecar",
            ),
            (
                ManagedChild::new(
                    TestChild {
                        name: "runner",
                        terminated: Arc::clone(&second_terminated),
                    },
                    Arc::clone(&second_terminated),
                ),
                "local runner",
            ),
        ];
        let signal_events = Arc::clone(&events);
        let wait_events = Arc::clone(&events);
        let results = terminate_managed_children_with(
            children,
            Duration::from_secs(1),
            move |child| {
                signal_events
                    .lock()
                    .unwrap()
                    .push(format!("signal {}", child.name));
                child.terminated.store(true, Ordering::Release);
                true
            },
            |_| panic!("confirmed children do not require force"),
            move |terminated, _| {
                wait_events.lock().unwrap().push("wait".into());
                terminated.load(Ordering::Acquire)
            },
        );
        assert_eq!(
            *events.lock().unwrap(),
            ["signal sidecar", "signal runner", "wait", "wait"]
        );
        assert_eq!(
            results,
            [("control-plane sidecar", true), ("local runner", true)]
        );
    }

    #[test]
    fn managed_child_timeouts_share_one_deadline_and_closed_events_are_unconfirmed() {
        let children = vec![
            (
                ManagedChild::new("sidecar", Arc::new(AtomicBool::new(false))),
                "control-plane sidecar",
            ),
            (
                ManagedChild::new("runner", Arc::new(AtomicBool::new(false))),
                "local runner",
            ),
        ];
        let waits = Arc::new(Mutex::new(Vec::new()));
        let task_waits = Arc::clone(&waits);
        let results = terminate_managed_children_with(
            children,
            Duration::from_millis(50),
            |_| true,
            |_| {},
            move |_, remaining| {
                task_waits.lock().unwrap().push(remaining);
                thread::sleep(Duration::from_millis(10));
                false
            },
        );
        assert!(results.iter().all(|(_, confirmed)| !confirmed));
        let waits = waits.lock().unwrap();
        assert_eq!(waits.len(), 2);
        assert!(
            waits[1] < waits[0],
            "both confirmations must consume the same timeout budget"
        );
    }

    #[test]
    fn managed_child_confirmed_exit_is_never_signaled_by_recycled_pid() {
        let terminated = Arc::new(AtomicBool::new(true));
        let results = terminate_managed_children_with(
            vec![(
                ManagedChild::new("runner", Arc::clone(&terminated)),
                "local runner",
            )],
            Duration::from_secs(1),
            |_| panic!("a confirmed-exit PID must not be signaled"),
            |_| panic!("a confirmed-exit child must not be force-killed"),
            |state, _| state.load(Ordering::Acquire),
        );
        assert_eq!(results, [("local runner", true)]);
    }

    #[test]
    fn production_teardown_marks_both_states_before_io_and_drains_last() {
        let sidecar = Mutex::new(SidecarState {
            child: Some("sidecar"),
            ..SidecarState::default()
        });
        let runner = Mutex::new(LocalRunnerState {
            child: Some("runner"),
            ..LocalRunnerState::default()
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let begin_events = Arc::clone(&events);
        let terminate_events = Arc::clone(&events);
        let close_events = Arc::clone(&events);
        let drain_events = Arc::clone(&events);

        assert!(teardown_managed_processes_with(
            || begin_events.lock().unwrap().push("begin"),
            || {
                let sidecar_child = shutdown_sidecar(&mut sidecar.lock().unwrap());
                let runner_child = shutdown_local_runner(&mut runner.lock().unwrap());
                (sidecar_child, runner_child)
            },
            |children| {
                assert!(sidecar.lock().unwrap().shutting_down);
                assert!(runner.lock().unwrap().shutting_down);
                assert_eq!(children, (Some("sidecar"), Some("runner")));
                terminate_events.lock().unwrap().push("terminate");
            },
            || close_events.lock().unwrap().push("close"),
            || {
                drain_events.lock().unwrap().push("drain");
                true
            },
        ));
        assert_eq!(
            *events.lock().unwrap(),
            ["begin", "terminate", "close", "drain"]
        );
    }

    #[test]
    fn production_teardown_uses_the_real_operation_gate_only_after_child_and_transport_io() {
        let operations = SidecarOperations::default();
        let permit = operations.begin().unwrap();
        let sidecar = Mutex::new(SidecarState {
            child: Some("sidecar"),
            ..SidecarState::default()
        });
        let runner = Mutex::new(LocalRunnerState {
            child: Some("runner"),
            ..LocalRunnerState::default()
        });
        let events = Arc::new(Mutex::new(Vec::new()));
        let begin_events = Arc::clone(&events);
        let terminate_events = Arc::clone(&events);
        let close_events = Arc::clone(&events);
        let drain_events = Arc::clone(&events);

        assert!(teardown_managed_processes_with(
            || {
                operations.begin_shutdown();
                begin_events.lock().unwrap().push("begin");
            },
            || {
                let sidecar_child = shutdown_sidecar(&mut sidecar.lock().unwrap());
                let runner_child = shutdown_local_runner(&mut runner.lock().unwrap());
                (sidecar_child, runner_child)
            },
            |children| {
                assert!(sidecar.lock().unwrap().shutting_down);
                assert!(runner.lock().unwrap().shutting_down);
                assert_eq!(children, (Some("sidecar"), Some("runner")));
                terminate_events.lock().unwrap().push("terminate");
            },
            move || {
                close_events.lock().unwrap().push("close");
                drop(permit);
            },
            || {
                let drained = operations.wait_for_idle(Duration::from_secs(1));
                drain_events.lock().unwrap().push("drain");
                drained
            },
        ));
        assert_eq!(
            *events.lock().unwrap(),
            ["begin", "terminate", "close", "drain"]
        );
        assert_eq!(operations.active_count(), 0);
        assert!(operations.begin().is_err());
    }

    #[test]
    fn bounded_final_escalation_resnapshots_late_children_before_release() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let snapshots = Arc::new(Mutex::new(vec![vec!["initial"], vec!["late"]].into_iter()));
        let begin_events = Arc::clone(&events);
        let take_events = Arc::clone(&events);
        let terminate_events = Arc::clone(&events);
        let drain_events = Arc::clone(&events);
        let active_events = Arc::clone(&events);
        let task_snapshots = Arc::clone(&snapshots);

        let (drained, active) = finalize_managed_processes_with(
            || begin_events.lock().unwrap().push("begin"),
            || {
                take_events.lock().unwrap().push("snapshot");
                task_snapshots
                    .lock()
                    .unwrap()
                    .next()
                    .expect("finalization must take exactly two snapshots")
            },
            |children| {
                terminate_events
                    .lock()
                    .unwrap()
                    .push(if children == ["initial"] {
                        "terminate initial"
                    } else {
                        "terminate late"
                    });
            },
            || {
                drain_events.lock().unwrap().push("bounded drain");
                false
            },
            || {
                active_events.lock().unwrap().push("active count");
                2
            },
        );

        assert!(!drained);
        assert_eq!(active, 2);
        assert_eq!(
            *events.lock().unwrap(),
            [
                "begin",
                "snapshot",
                "terminate initial",
                "bounded drain",
                "snapshot",
                "terminate late",
                "active count"
            ]
        );
    }

    #[test]
    fn shutdown_waits_for_an_in_flight_runner_candidate_to_be_rejected_and_killed() {
        let operations = Arc::new(SidecarOperations::default());
        let runner = Arc::new(Mutex::new(LocalRunnerState::<&'static str>::default()));
        let candidate_spawned = Arc::new(AtomicBool::new(false));
        let allow_install = Arc::new((Mutex::new(false), Condvar::new()));
        let candidate_killed = Arc::new(AtomicBool::new(false));

        let task_operations = Arc::clone(&operations);
        let task_runner = Arc::clone(&runner);
        let task_spawned = Arc::clone(&candidate_spawned);
        let task_allow_install = Arc::clone(&allow_install);
        let task_killed = Arc::clone(&candidate_killed);
        let replacement = thread::spawn(move || {
            let _operation = task_operations.begin().unwrap();
            let generation = {
                let mut state = task_runner.lock().unwrap();
                stage_local_runner_replacement(&mut state, || Ok(()), false)
                    .unwrap()
                    .0
            };
            task_spawned.store(true, Ordering::Release);
            let (lock, ready) = &*task_allow_install;
            let mut install = lock.lock().unwrap();
            while !*install {
                install = ready.wait(install).unwrap();
            }
            drop(install);

            let result = {
                let mut state = task_runner.lock().unwrap();
                commit_local_runner_candidate(
                    &mut state,
                    generation,
                    "runner-1".into(),
                    "candidate",
                    false,
                    || Ok(()),
                )
            };
            let (candidate, message) =
                result.expect_err("shutdown must reject the in-flight candidate");
            assert_eq!(candidate, "candidate");
            assert_eq!(message, "the desktop is shutting down");
            task_killed.store(true, Ordering::Release);
        });

        assert!(wait_until(
            || candidate_spawned.load(Ordering::Acquire),
            true,
            Duration::from_secs(2)
        ));
        operations.begin_shutdown();
        assert_eq!(
            shutdown_local_runner(&mut runner.lock().unwrap()),
            None,
            "the candidate is spawned but not installed yet"
        );

        let waiter_operations = Arc::clone(&operations);
        let waiter_started = Arc::new(AtomicBool::new(false));
        let task_waiter_started = Arc::clone(&waiter_started);
        let ownership_released = Arc::new(AtomicBool::new(false));
        let waiter_released = Arc::clone(&ownership_released);
        let teardown = thread::spawn(move || {
            task_waiter_started.store(true, Ordering::Release);
            assert!(waiter_operations.wait_for_idle(Duration::from_secs(2)));
            waiter_released.store(true, Ordering::Release);
        });
        assert!(wait_until(
            || waiter_started.load(Ordering::Acquire),
            true,
            Duration::from_secs(2)
        ));
        assert!(
            !ownership_released.load(Ordering::Acquire),
            "ownership cannot release while a spawn/install operation is in flight"
        );

        let (lock, ready) = &*allow_install;
        *lock.lock().unwrap() = true;
        ready.notify_all();
        replacement.join().unwrap();
        teardown.join().unwrap();
        assert!(candidate_killed.load(Ordering::Acquire));
        assert!(ownership_released.load(Ordering::Acquire));
        assert!(
            operations.begin().is_err(),
            "committed shutdown permanently closes process admission"
        );
    }

    #[test]
    fn the_close_event_name_is_one_tauri_will_actually_emit() {
        // `Emitter::emit` returns `Err(IllegalEventName)` for a name outside this set, and the call
        // site discards the result because there is no useful recovery — so an illegal name would
        // make the warning silently inert. The rule is tauri 2.11.3
        // `src/event/event_name.rs::is_event_name_valid`, restated here because it is private.
        assert!(
            CLOSE_WOULD_STOP_WORK_EVENT
                .chars()
                .all(|c| c.is_alphanumeric() || c == '-' || c == '/' || c == ':' || c == '_'),
            "{CLOSE_WOULD_STOP_WORK_EVENT} would be rejected by Emitter::emit",
        );
        assert!(!CLOSE_WOULD_STOP_WORK_EVENT.is_empty());
    }

    #[test]
    fn a_close_is_held_only_while_work_is_at_risk_and_only_once() {
        assert!(
            should_hold_close(ExitRisk::Sessions(1), false),
            "work in flight: hold"
        );
        assert!(
            !should_hold_close(ExitRisk::Sessions(1), true),
            "a second close always exits"
        );
        assert!(
            !should_hold_close(ExitRisk::Sessions(0), false),
            "nothing running, nothing to warn about"
        );
        assert!(
            !should_hold_close(ExitRisk::None, false),
            "no control plane, so nothing for exit to kill"
        );
        assert!(!should_hold_close(ExitRisk::None, true));
    }

    #[test]
    fn a_control_plane_that_cannot_be_asked_is_treated_as_work_at_risk() {
        // The costs are not symmetric: a needless warning costs one keypress, a missed one costs an
        // agent turn. So "up but unanswerable" holds, while "not running at all" does not — there
        // is genuinely nothing for exit to destroy in that case.
        assert!(should_hold_close(ExitRisk::Unknown, false));
        assert!(
            !should_hold_close(ExitRisk::Unknown, true),
            "and it still cannot trap the user"
        );
    }

    #[test]
    fn a_trickling_peer_cannot_hold_the_close_path_open() {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        // A peer that answers, slowly, and never finishes. `read_to_string` would sit here as long
        // as bytes keep arriving inside each per-read timeout — which is forever, on the UI thread.
        let server = thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                for _ in 0..600 {
                    if socket.write_all(b"x").is_err() {
                        return;
                    }
                    let _ = socket.flush();
                    thread::sleep(Duration::from_millis(50));
                }
            }
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        let started = Instant::now();
        let result = read_bounded(
            &mut stream,
            Duration::from_millis(400),
            Duration::from_millis(700),
            1024 * 1024,
        );
        let elapsed = started.elapsed();
        assert!(
            result.is_none(),
            "a peer that never finishes must not produce an answer"
        );
        assert!(
            elapsed < Duration::from_millis(2_000),
            "the read ran for {elapsed:?}, unbounded"
        );
        drop(stream);
        let _ = server.join();
    }

    #[test]
    fn provisioning_can_wait_longer_for_its_first_byte_than_the_close_path() {
        use std::io::Write as _;
        use std::net::TcpListener;

        let delayed_response = |deadline: Duration, idle_timeout: Duration| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                if let Ok((mut socket, _)) = listener.accept() {
                    thread::sleep(Duration::from_millis(900));
                    let _ = socket.write_all(b"HTTP/1.0 200 OK\r\n\r\n{}");
                }
            });
            let mut stream = TcpStream::connect(addr).unwrap();
            let response = read_bounded(&mut stream, deadline, idle_timeout, 1024);
            drop(stream);
            server.join().unwrap();
            response
        };

        assert!(
            delayed_response(CLOSE_QUERY_DEADLINE, CLOSE_QUERY_IDLE_TIMEOUT).is_none(),
            "the UI-thread close path keeps its anti-trickle idle ceiling"
        );
        assert_eq!(PROVISION_QUERY_IDLE_TIMEOUT, PROVISION_QUERY_DEADLINE);
        assert!(
            delayed_response(PROVISION_QUERY_DEADLINE, PROVISION_QUERY_IDLE_TIMEOUT).is_some(),
            "credential provisioning may use its full five-second first-byte budget"
        );
    }

    #[test]
    fn the_health_probe_gives_up_on_a_peer_that_trickles() {
        use std::io::Write as _;
        use std::net::TcpListener;

        // This probe runs on the CLOSE path, before the sessions query. Bounding the query and
        // leaving this unbounded left the window unable to close at all — the failure it is
        // supposed to prevent, arrived at from the other side.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                for _ in 0..600 {
                    if socket.write_all(b"z").is_err() {
                        return;
                    }
                    let _ = socket.flush();
                    thread::sleep(Duration::from_millis(50));
                }
            }
        });

        let started = Instant::now();
        let answered = probe_marker(addr);
        let elapsed = started.elapsed();
        assert!(
            !answered,
            "a peer that never sends the marker is not our control plane"
        );
        assert!(
            elapsed < Duration::from_millis(2_500),
            "the health probe ran for {elapsed:?}"
        );
        let _ = server.join();
    }

    #[test]
    fn the_health_probe_recognises_our_control_plane_and_nothing_else() {
        use std::io::Write as _;
        use std::net::TcpListener;

        for (body, expected) in [
            (
                format!(
                    "HTTP/1.0 200 OK

{{\"service\":\"{}\"}}",
                    instances::LEGACY_CONTROL_PLANE_SERVICE
                ),
                true,
            ),
            (
                format!(
                    "HTTP/1.0 200 OK

{{\"service\":\"{}\"}}",
                    instances::WOLLIPOG_CONTROL_PLANE_SERVICE
                ),
                true,
            ),
            (
                format!(
                    "HTTP/1.0 200 OK

{{\"service\":\"something-else\",\"note\":\"{}\"}}",
                    instances::WOLLIPOG_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                "HTTP/1.0 200 OK

{\"service\":\"something-else\"}"
                    .to_string(),
                false,
            ),
            (
                format!(
                    "HTTP/1.0 500 Internal Server Error\r\n\r\n{{\"service\":\"{}\"}}",
                    instances::WOLLIPOG_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "HTTP/1.1 404 Not Found\r\n\r\n{{\"service\":\"{}\"}}",
                    instances::LEGACY_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "{{\"service\":\"{}\"}}",
                    instances::WOLLIPOG_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "HTTP/1.0 two-hundred OK\r\n\r\n{{\"service\":\"{}\"}}",
                    instances::LEGACY_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "HTTP/1.0 200 OK\r\nMalformed Header\r\n\r\n{{\"service\":\"{}\"}}",
                    instances::LEGACY_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "HTTP/1.0 200 OK\r\n\r\n{{\"service\":\"{}-suffix\"}}",
                    instances::WOLLIPOG_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
            (
                format!(
                    "HTTP/1.0 200 OK\r\n\r\n{{\"service_name\":\"{}\"}}",
                    instances::LEGACY_CONTROL_PLANE_SERVICE
                ),
                false,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let server = thread::spawn(move || {
                if let Ok((mut socket, _)) = listener.accept() {
                    // Drain the request FIRST. Closing a socket with unread incoming data is an
                    // abortive close on Windows, and the RST discards the reply before the client
                    // reads it — which looks exactly like the probe rejecting a valid marker.
                    let mut request = [0u8; 1024];
                    let _ = socket.read(&mut request);
                    let _ = socket.write_all(body.as_bytes());
                    let _ = socket.flush();
                }
            });
            assert_eq!(probe_marker(addr), expected);
            let _ = server.join();
        }
    }

    #[test]
    fn an_oversized_response_is_refused_rather_than_buffered() {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let _ = socket.write_all(&vec![b'y'; 64 * 1024]);
            }
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        assert!(
            read_bounded(
                &mut stream,
                Duration::from_millis(1_000),
                Duration::from_millis(700),
                1024,
            )
            .is_none(),
            "the close path must not buffer an unbounded body",
        );
        drop(stream);
        let _ = server.join();
    }

    #[test]
    fn a_prompt_peer_is_read_in_full() {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                let _ = socket.write_all(b"HTTP/1.0 200 OK\r\n\r\n{\"sessions\":[]}");
            }
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        let body = read_bounded(
            &mut stream,
            Duration::from_millis(1_000),
            Duration::from_millis(700),
            1024 * 1024,
        )
        .unwrap();
        assert!(body.starts_with("HTTP/1.0 200 OK"));
        assert!(body.ends_with(r#"{"sessions":[]}"#));
        drop(stream);
        let _ = server.join();
    }

    #[test]
    fn a_response_that_was_not_answered_is_unknown_rather_than_idle() {
        // The dangerous direction: any of these silently reading as "nothing is running" would let
        // the first close destroy work. Each must come back Unknown, which holds the close.
        assert_eq!(
            risk_from_response(
                "HTTP/1.1 401 Unauthorized",
                r#"{"error":"unauthorized"}"#,
                "runner-1"
            ),
            ExitRisk::Unknown,
            "an unauthorised answer is not an answer",
        );
        // Even if a future error shape carries a sessions key, a non-200 still means unanswered.
        assert_eq!(
            risk_from_response(
                "HTTP/1.1 500 Internal Server Error",
                r#"{"sessions":[]}"#,
                "runner-1"
            ),
            ExitRisk::Unknown,
        );
        assert_eq!(
            risk_from_response("HTTP/1.1 200 OK", "not json at all", "runner-1"),
            ExitRisk::Unknown
        );
        assert_eq!(
            risk_from_response("HTTP/1.1 200 OK", r#"{"other":[]}"#, "runner-1"),
            ExitRisk::Unknown
        );
        assert_eq!(
            risk_from_response("HTTP/1.1 200 OK", r#"{"sessions":"nope"}"#, "runner-1"),
            ExitRisk::Unknown
        );
    }

    #[test]
    fn a_warning_authorizes_the_close_that_follows_it_and_not_forever() {
        // The escape hatch: close, read the warning, close again — that must always exit.
        let warned = Instant::now();
        assert!(warning_still_authorizes(
            Some(warned),
            warned + Duration::from_secs(1),
            CLOSE_WARNING_GRACE
        ));
        assert!(warning_still_authorizes(
            Some(warned),
            warned + Duration::from_secs(29),
            CLOSE_WARNING_GRACE
        ));

        // And the reason it is a clock rather than a flag: a warning about a settled guardrail card
        // must not disarm the guard for the rest of the process, or the next close kills real work.
        assert!(!warning_still_authorizes(
            Some(warned),
            warned + Duration::from_secs(31),
            CLOSE_WARNING_GRACE
        ));
        assert!(!warning_still_authorizes(
            Some(warned),
            warned + Duration::from_secs(3_600),
            CLOSE_WARNING_GRACE
        ));
        assert!(
            !warning_still_authorizes(None, warned, CLOSE_WARNING_GRACE),
            "nobody has been warned yet"
        );
    }

    #[test]
    fn one_permitted_close_authorizes_exactly_one_exit() {
        // The flag says "the window close that caused this exit already decided". Read without
        // being consumed, it would also authorize the NEXT quit — and on macOS a closed window does
        // not necessarily end the process, so that next quit can be a Cmd+Q with live work.
        let guard = CloseGuard::default();
        assert!(
            should_guard_exit(take_exit_authorization(&guard)),
            "an exit nobody authorized is guarded"
        );

        guard.exit_authorized.store(true, Ordering::Relaxed);
        assert!(
            !should_guard_exit(take_exit_authorization(&guard)),
            "the exit caused by a permitted close passes without a second decision"
        );
        assert!(
            should_guard_exit(take_exit_authorization(&guard)),
            "and the one after it is guarded again — the authorization was consumed, not read"
        );
    }

    #[test]
    fn only_the_runner_this_process_owns_counts() {
        // Sessions on another runner survive this process exiting — counting them produces a
        // warning about work closing would not touch, and a false warning spends the one warning
        // the user gets.
        let sessions: Vec<serde_json::Value> = serde_json::from_str(
            r#"[
                {"id":"a","runnerId":"ours","status":"running"},
                {"id":"b","runnerId":"theirs","status":"running"},
                {"id":"c","runnerId":"ours","status":"idle"},
                {"id":"h","runnerId":"ours","status":"input_required"},
                {"id":"d","runnerId":"ours","status":"running","archived":true},
                {"id":"e","runnerId":"ours","status":"completed","pendingApproval":{"id":"x"}},
                {"id":"f","runnerId":"theirs","status":"queued"}
            ]"#,
        )
        .unwrap();
        assert_eq!(risk_for_runner(&sessions, "ours"), ExitRisk::Sessions(4),
            "a, d (archived is still running), e (approval pending) and h (a turn open, waiting on a person)");
        assert_eq!(risk_for_runner(&sessions, "theirs"), ExitRisk::Sessions(2));
        assert_eq!(risk_for_runner(&sessions, "nobody"), ExitRisk::Sessions(0));
        assert_eq!(risk_for_runner(&[], "ours"), ExitRisk::Sessions(0));
    }

    #[test]
    fn a_row_with_no_runner_cannot_be_dismissed() {
        // A malformed response must not read as "nothing is running". Skipping an unattributable
        // row is exactly that.
        let orphan: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id":"a","status":"running"}]"#).unwrap();
        assert_eq!(risk_for_runner(&orphan, "ours"), ExitRisk::Unknown);

        let wrong_type: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id":"a","runnerId":7,"status":"idle"}]"#).unwrap();
        assert_eq!(risk_for_runner(&wrong_type, "ours"), ExitRisk::Unknown);
    }

    #[test]
    fn the_status_line_is_parsed_rather_than_prefix_matched() {
        // `starts_with("HTTP/1.1 200")` also accepts `HTTP/1.1 2000`, which is not a success and
        // would have its body read as an answer.
        assert_eq!(
            risk_from_response("HTTP/1.1 2000 Nonsense", r#"{"sessions":[]}"#, "ours"),
            ExitRisk::Unknown,
        );
        assert_eq!(
            risk_from_response("HTTP/1.1 200 OK", r#"{"sessions":[]}"#, "ours"),
            ExitRisk::Sessions(0),
        );
        assert_eq!(
            risk_from_response("", r#"{"sessions":[]}"#, "ours"),
            ExitRisk::Unknown
        );
        assert_eq!(
            risk_from_response("garbage", r#"{"sessions":[]}"#, "ours"),
            ExitRisk::Unknown
        );
    }

    #[test]
    fn a_status_this_build_does_not_know_is_unknown_rather_than_safe() {
        // Version skew: a newer control plane returns a status this build has never heard of.
        // "Not in the busy list" is the wrong default — it is how an active turn gets killed.
        let newer: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id":"a","runnerId":"ours","status":"compacting"}]"#)
                .unwrap();
        assert_eq!(risk_for_runner(&newer, "ours"), ExitRisk::Unknown);

        let missing: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id":"a","runnerId":"ours"}]"#).unwrap();
        assert_eq!(risk_for_runner(&missing, "ours"), ExitRisk::Unknown);

        // But an unknown status on ANOTHER runner is not our problem and must not warn.
        let elsewhere: Vec<serde_json::Value> =
            serde_json::from_str(r#"[{"id":"a","runnerId":"theirs","status":"compacting"}]"#)
                .unwrap();
        assert_eq!(risk_for_runner(&elsewhere, "ours"), ExitRisk::Sessions(0));
    }

    #[test]
    fn the_busy_and_settled_lists_together_cover_every_status_without_overlap() {
        for busy in WORK_IN_FLIGHT_STATUSES {
            assert!(!SETTLED_STATUSES.contains(&busy), "{busy} is in both lists");
        }
        // The union is checked against the protocol's SessionStatus union on the TypeScript side.
        assert_eq!(WORK_IN_FLIGHT_STATUSES.len() + SETTLED_STATUSES.len(), 8);
    }

    #[test]
    fn an_answered_response_reports_what_it_counted() {
        assert_eq!(
            risk_from_response("HTTP/1.1 200 OK", r#"{"sessions":[]}"#, "ours"),
            ExitRisk::Sessions(0),
        );
        assert_eq!(
            risk_from_response(
                "HTTP/1.0 200 OK",
                r#"{"sessions":[{"runnerId":"ours","status":"running"},{"runnerId":"ours","status":"idle"}]}"#,
                "ours",
            ),
            ExitRisk::Sessions(1),
        );
    }

    #[test]
    fn every_busy_status_is_one_the_protocol_actually_emits() {
        // The list is checked against the protocol union by a test on the TypeScript side; this
        // half only pins that it is non-empty and free of duplicates, so a careless edit that
        // emptied it would fail here rather than silently classify everything as safe.
        assert!(!WORK_IN_FLIGHT_STATUSES.is_empty());
        let mut sorted = WORK_IN_FLIGHT_STATUSES;
        sorted.sort_unstable();
        let mut unique = sorted.to_vec();
        unique.dedup();
        assert_eq!(
            unique.len(),
            WORK_IN_FLIGHT_STATUSES.len(),
            "a duplicate hides a missing status"
        );
    }

    #[test]
    fn desktop_settings_default_to_tailnet_access_off() {
        let parsed: DesktopSettings = serde_json::from_str("{}").unwrap();
        assert!(!parsed.tailnet_access);
        assert!(parsed.local_runner.is_none());
    }

    #[test]
    fn network_profiles_keep_default_loopback_only() {
        assert_eq!(network_profile(false), ("127.0.0.1", "0"));
        assert_eq!(network_profile(true), ("0.0.0.0", "1"));
    }

    #[test]
    fn managed_hmac_matches_the_pinned_cross_language_vector_and_exact_bytes() {
        let identity = SidecarLaunchIdentity {
            launch_id: "0123456789abcdef0123456789abcdef".into(),
            secret: SecretString::from(
                concat!("AAECAwQFBgcICQoLDA0OD", "xAREhMUFRYXGBkaGxwdHh8").to_string(),
            ),
        };
        let challenge =
            canonical_base64url("ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8", 32).unwrap();
        let runner_id = b"this-machine-2f5a7c9d";
        let body = br#"{"sessions":[{"runnerId":"this-machine-2f5a7c9d","status":"running","pendingApproval":null}]}"#;
        assert_eq!(
            managed_mac(&identity, EXIT_RISK_REQUEST_DOMAIN, &challenge, runner_id).unwrap(),
            "eZH-Q-EUQPBAADeiSSBcN_iwVW4oFN2or6WI71dljJc"
        );
        let response_mac =
            managed_mac(&identity, EXIT_RISK_RESPONSE_DOMAIN, &challenge, body).unwrap();
        assert_eq!(response_mac, "9l9hl855e9kP7gkTUr6mXS2p8IkGloqLOQftwXQQjlw");
        assert!(verify_managed_mac(
            &identity,
            EXIT_RISK_RESPONSE_DOMAIN,
            &challenge,
            body,
            &response_mac
        ));
        let mut changed = body.to_vec();
        changed.push(b' ');
        assert!(!verify_managed_mac(
            &identity,
            EXIT_RISK_RESPONSE_DOMAIN,
            &challenge,
            &changed,
            &response_mac
        ));
        assert!(!verify_managed_mac(
            &identity,
            EXIT_RISK_RESPONSE_DOMAIN,
            &challenge,
            body,
            &format!("{response_mac}=")
        ));
    }

    #[test]
    fn managed_requests_never_carry_the_launch_secret_or_an_owner_bearer() {
        let identity = test_launch_identity(42);
        let challenge = URL_SAFE_NO_PAD.encode([7u8; 32]);
        for (path, domain) in [
            (MANAGED_EXIT_RISK_PATH, EXIT_RISK_REQUEST_DOMAIN),
            (MANAGED_PROVISION_PATH, PROVISION_REQUEST_DOMAIN),
        ] {
            let mac = managed_mac(&identity, domain, &[7u8; 32], b"this-machine").unwrap();
            let (head, body) =
                managed_request(&identity, path, "this-machine", &challenge, &mac).unwrap();
            let wire = format!("{head}{}", String::from_utf8(body).unwrap());
            assert!(!wire.contains(identity.secret.expose_secret()));
            assert!(!wire.to_ascii_lowercase().contains("authorization:"));
            assert!(!wire.contains("token="));
            assert!(!wire.contains("secret"));
            assert_eq!(
                head.lines().next(),
                Some(format!("POST {path} HTTP/1.0").as_str())
            );
        }
    }

    #[test]
    fn managed_response_headers_keep_the_first_duplicate_and_colons_in_values() {
        let head = concat!(
            "HTTP/1.0 404 Not Found\r\n",
            "x-wollipog-response-mac: first:with:colons\r\n",
            "X-Wollipog-Response-Mac: second\r\n",
            "content-type: application/json\r\n",
        );
        assert_eq!(
            header_value(head, MANAGED_RESPONSE_MAC_HEADER),
            Some("first:with:colons")
        );
        assert_eq!(header_value(head, "missing"), None);
        assert_eq!(
            header_value(
                "x-wollipog-response-mac: status-line\r\n",
                MANAGED_RESPONSE_MAC_HEADER
            ),
            None,
            "the HTTP status line is never a response header"
        );
    }

    #[test]
    fn signed_managed_provisioning_errors_are_reported_as_runner_conflicts() {
        assert_eq!(
            managed_provisioning_response(
                "HTTP/1.1 404 Not Found\r\ncontent-type: application/json",
                r#"{"error":"runner not found"}"#,
            ),
            Err("could not provision the local runner: runner not found".into())
        );
    }

    #[test]
    fn every_spawn_gets_a_distinct_launch_id_and_secret() {
        let target = new_sidecar_launch_identity().unwrap();
        let rollback = new_sidecar_launch_identity().unwrap();
        assert_ne!(target.launch_id, rollback.launch_id);
        assert_ne!(
            target.secret.expose_secret(),
            rollback.secret.expose_secret()
        );
    }

    fn running_sidecar(child: &'static str) -> Mutex<SidecarState<&'static str>> {
        Mutex::new(SidecarState {
            child: Some(child),
            phase: SidecarPhase::Running,
            generation: 7,
            shutting_down: false,
            launch_identity: Some(test_launch_identity(7)),
            child_terminated: Some(Arc::new(AtomicBool::new(false))),
        })
    }

    fn test_launch_identity(seed: u8) -> Arc<SidecarLaunchIdentity> {
        Arc::new(SidecarLaunchIdentity {
            launch_id: format!("{seed:032x}"),
            secret: SecretString::from(URL_SAFE_NO_PAD.encode([seed; 32])),
        })
    }

    fn spawned<C>(child: C, seed: u8) -> SpawnedSidecar<C> {
        SpawnedSidecar {
            child,
            identity: test_launch_identity(seed),
            terminated: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn only_a_ready_managed_child_can_expose_credentials_or_query_work() {
        let mut state = SidecarState::<u8>::default();
        for phase in [
            SidecarPhase::Stopped,
            SidecarPhase::Starting,
            SidecarPhase::Reconfiguring,
            SidecarPhase::RollingBack,
            SidecarPhase::External,
        ] {
            state.phase = phase;
            state.child = Some(1);
            state.launch_identity = Some(test_launch_identity(1));
            state.child_terminated = Some(Arc::new(AtomicBool::new(false)));
            assert_eq!(managed_sidecar_generation(&state), None, "phase={phase:?}");
        }

        state.phase = SidecarPhase::Running;
        state.generation = 9;
        assert_eq!(managed_sidecar_generation(&state), Some(9));
        assert!(managed_sidecar_generation_is_current(&state, 9));
        state.shutting_down = true;
        assert_eq!(managed_sidecar_generation(&state), None);
    }

    #[test]
    fn managed_currency_requires_the_exact_launch_and_termination_token() {
        let identity = test_launch_identity(9);
        let termination = Arc::new(AtomicBool::new(false));
        let state = SidecarState {
            child: Some("candidate"),
            phase: SidecarPhase::Running,
            generation: 9,
            shutting_down: false,
            launch_identity: Some(Arc::clone(&identity)),
            child_terminated: Some(Arc::clone(&termination)),
        };
        assert!(managed_sidecar_identity_is_current(
            &state,
            9,
            &identity.launch_id
        ));
        assert!(!managed_sidecar_identity_is_current(
            &state,
            9,
            &test_launch_identity(10).launch_id
        ));
        assert_eq!(
            managed_candidate_state(&state, 9, SidecarPhase::Running, &termination),
            ManagedCandidateState::Current
        );
        assert_eq!(
            managed_candidate_state(
                &state,
                9,
                SidecarPhase::Running,
                &Arc::new(AtomicBool::new(false)),
            ),
            ManagedCandidateState::Superseded,
            "a same-generation rollback launch has a different termination token"
        );
    }

    #[test]
    fn local_runner_connection_errors_distinguish_stopped_from_transitional_sidecars() {
        let mut state = SidecarState::<u8>::default();
        assert_eq!(
            local_runner_control_plane(&state),
            Err("the local control plane is not ready")
        );

        for phase in [
            SidecarPhase::Starting,
            SidecarPhase::Reconfiguring,
            SidecarPhase::RollingBack,
        ] {
            state.phase = phase;
            assert_eq!(
                local_runner_control_plane(&state),
                Err("the local control plane is being reconfigured"),
                "phase={phase:?}"
            );
        }

        state.phase = SidecarPhase::External;
        assert_eq!(
            local_runner_control_plane(&state),
            Ok(LocalRunnerControlPlane::External)
        );
        state.phase = SidecarPhase::Running;
        state.child = Some(1);
        state.generation = 11;
        state.launch_identity = Some(test_launch_identity(11));
        state.child_terminated = Some(Arc::new(AtomicBool::new(false)));
        assert_eq!(
            local_runner_control_plane(&state),
            Ok(LocalRunnerControlPlane::Managed(11))
        );
        state.shutting_down = true;
        assert_eq!(
            local_runner_control_plane(&state),
            Err("the local control plane is not ready")
        );
    }

    #[test]
    fn tailnet_errors_preserve_complete_messages_and_wrap_internal_details_once() {
        for complete in [
            "Tailnet access cannot be changed while another control plane owns port 4317.",
            "The local control plane is already being reconfigured.",
            "The local control plane did not stop; Tailnet access was not changed.",
        ] {
            assert_eq!(format_tailnet_access_error(complete.into()), complete);
        }
        assert_eq!(
            format_tailnet_access_error("the control-plane rollback was superseded".into()),
            "Tailnet access could not be changed: the control-plane rollback was superseded"
        );
    }

    #[test]
    fn stale_or_target_termination_cannot_clear_the_live_rollback_launch() {
        let rollback = test_launch_identity(22);
        let mut state = SidecarState {
            child: Some("rollback"),
            phase: SidecarPhase::Running,
            generation: 12,
            shutting_down: false,
            launch_identity: Some(Arc::clone(&rollback)),
            child_terminated: Some(Arc::new(AtomicBool::new(false))),
        };
        assert_eq!(
            clear_terminated_sidecar(&mut state, 11, &rollback.launch_id),
            None
        );
        assert_eq!(
            clear_terminated_sidecar(&mut state, 12, &test_launch_identity(21).launch_id),
            None
        );
        assert_eq!(state.child, Some("rollback"));
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(
            clear_terminated_sidecar(&mut state, 12, &rollback.launch_id),
            Some("rollback")
        );
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert!(state.launch_identity.is_none());
    }

    #[test]
    fn successful_reconfiguration_keeps_every_long_callback_outside_the_mutex() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let terminated = RefCell::new(Vec::new());
        let published = Cell::new(false);
        reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| {
                assert!(sidecar.try_lock().is_ok());
                terminated.borrow_mut().push(child);
            },
            || {
                let state = sidecar.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::Reconfiguring);
                assert_eq!(state.child, None);
                true
            },
            |enabled, _generation| {
                assert!(enabled);
                assert!(sidecar.try_lock().is_ok());
                Ok(spawned("new", 8))
            },
            || {
                let state = sidecar.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::Reconfiguring);
                assert_eq!(state.child, Some("new"));
                true
            },
            || {
                assert!(sidecar.try_lock().is_ok());
                published.set(true);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();

        assert_eq!(&*terminated.borrow(), &["old"]);
        assert!(published.get());
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.generation, 8);
        assert_eq!(state.child, Some("new"));
    }

    #[test]
    fn unchanged_running_configuration_returns_without_starting_a_transition() {
        let sidecar = running_sidecar("old");
        reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: false,
            },
            |_| panic!("the existing child must not be terminated"),
            || panic!("the port must not be polled"),
            |_, _| panic!("no process should be spawned"),
            || panic!("readiness must not be polled"),
            || panic!("settings must not be rewritten"),
            |_| Ok(()),
        )
        .unwrap();
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.generation, 7);
        assert_eq!(state.child, Some("old"));
    }

    #[test]
    fn unchanged_setting_with_no_child_repairs_the_managed_sidecar() {
        use std::cell::Cell;

        let sidecar = Mutex::new(SidecarState::<&str>::default());
        let published = Cell::new(false);
        reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: false,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                assert!(!enabled);
                Ok(spawned("repair", 1))
            },
            || true,
            || {
                published.set(true);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap();
        let state = sidecar.lock().unwrap();
        assert!(published.get());
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("repair"));
    }

    #[test]
    fn external_and_in_progress_sidecars_reject_reconfiguration() {
        for phase in [
            SidecarPhase::External,
            SidecarPhase::Starting,
            SidecarPhase::Reconfiguring,
            SidecarPhase::RollingBack,
        ] {
            let sidecar = Mutex::new(SidecarState::<&str> {
                phase,
                ..SidecarState::default()
            });
            let error = reconfigure_sidecar_operation(
                &sidecar,
                &SidecarOperations::default(),
                SidecarNetworkChange {
                    previous_tailnet_access: false,
                    enabled: true,
                },
                |_| panic!("no child may be terminated"),
                || panic!("the port must not be polled"),
                |_, _| panic!("no process should be spawned"),
                || panic!("readiness must not be polled"),
                || panic!("settings must not be written"),
                |_| Ok(()),
            )
            .unwrap_err();
            assert!(!error.is_empty(), "phase={phase:?}");
            assert_eq!(sidecar.lock().unwrap().phase, phase);
        }
    }

    #[test]
    fn stop_timeout_clears_the_reconfiguring_phase_without_spawning() {
        use std::cell::RefCell;

        let sidecar = running_sidecar("old");
        let terminated = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| terminated.borrow_mut().push(child),
            || false,
            |_, _| panic!("a replacement cannot start while the port remains open"),
            || panic!("readiness must not be polled"),
            || panic!("settings must not be written"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("did not stop"));
        assert_eq!(&*terminated.borrow(), &["old"]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
    }

    #[test]
    fn target_spawn_failure_restores_the_previous_profile_but_reports_failure() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let terminated = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| terminated.borrow_mut().push(child),
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                if enabled {
                    Err("target spawn failed".into())
                } else {
                    Ok(spawned("rollback", 2))
                }
            },
            || {
                let state = sidecar.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::RollingBack);
                assert_eq!(state.child, Some("rollback"));
                true
            },
            || panic!("failed target startup must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, "target spawn failed");
        assert_eq!(spawns.get(), 2);
        assert_eq!(&*terminated.borrow(), &["old"]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("rollback"));
    }

    #[test]
    fn a_target_terminated_before_install_rolls_back_with_a_distinct_identity() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0u8);
        let launch_ids = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                let candidate = spawned(if enabled { "target" } else { "rollback" }, spawns.get());
                launch_ids
                    .borrow_mut()
                    .push(candidate.identity.launch_id.clone());
                if enabled {
                    candidate.terminated.store(true, Ordering::Release);
                }
                Ok(candidate)
            },
            || true,
            || panic!("a terminated target cannot publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("terminated during startup"));
        assert_eq!(spawns.get(), 2);
        assert_ne!(launch_ids.borrow()[0], launch_ids.borrow()[1]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("rollback"));
        assert_eq!(
            state.launch_identity.as_ref().unwrap().launch_id,
            launch_ids.borrow()[1]
        );
    }

    #[test]
    fn a_target_terminated_after_readiness_rolls_back_with_a_distinct_identity() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0u8);
        let ready_checks = Cell::new(0);
        let launch_ids = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                let candidate = spawned(if enabled { "target" } else { "rollback" }, spawns.get());
                launch_ids
                    .borrow_mut()
                    .push(candidate.identity.launch_id.clone());
                Ok(candidate)
            },
            || {
                ready_checks.set(ready_checks.get() + 1);
                if ready_checks.get() == 1 {
                    let mut state = sidecar.lock().unwrap();
                    let launch_id = state.launch_identity.as_ref().unwrap().launch_id.clone();
                    state
                        .child_terminated
                        .as_ref()
                        .unwrap()
                        .store(true, Ordering::Release);
                    assert_eq!(
                        clear_terminated_sidecar(&mut state, 8, &launch_id),
                        Some("target")
                    );
                }
                true
            },
            || panic!("a terminated target cannot publish settings"),
            |_| panic!("unpublished settings need no restoration"),
        )
        .unwrap_err();
        assert!(error.contains("replacement control plane terminated after startup"));
        assert_eq!(spawns.get(), 2);
        assert_eq!(ready_checks.get(), 2);
        assert_ne!(launch_ids.borrow()[0], launch_ids.borrow()[1]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("rollback"));
        assert_eq!(
            state.launch_identity.as_ref().unwrap().launch_id,
            launch_ids.borrow()[1]
        );
    }

    #[test]
    fn target_termination_during_settings_publish_restores_settings_and_rolls_back() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let profiles = RefCell::new(Vec::new());
        let ready_checks = Cell::new(0);
        let settings_restored = Cell::new(false);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                profiles.borrow_mut().push(enabled);
                Ok(spawned(
                    if enabled { "target" } else { "rollback" },
                    spawns.get() as u8,
                ))
            },
            || {
                ready_checks.set(ready_checks.get() + 1);
                true
            },
            || {
                let mut state = sidecar.lock().unwrap();
                let launch_id = state.launch_identity.as_ref().unwrap().launch_id.clone();
                state
                    .child_terminated
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
                assert_eq!(
                    clear_terminated_sidecar(&mut state, 8, &launch_id),
                    Some("target")
                );
                Ok(())
            },
            |tailnet_access| {
                assert!(!tailnet_access);
                settings_restored.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("replacement control plane terminated after startup"));
        assert!(settings_restored.get());
        assert_eq!(spawns.get(), 2);
        assert_eq!(&*profiles.borrow(), &[true, false]);
        assert_eq!(ready_checks.get(), 2);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("rollback"));
    }

    #[test]
    fn failed_settings_restore_recovers_with_the_persisted_target_profile() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let profiles = RefCell::new(Vec::new());
        let restored_profile = Cell::new(None);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                profiles.borrow_mut().push(enabled);
                spawns.set(spawns.get() + 1);
                Ok(spawned(
                    if spawns.get() == 1 {
                        "target"
                    } else {
                        "recovery"
                    },
                    spawns.get() as u8,
                ))
            },
            || true,
            || {
                let mut state = sidecar.lock().unwrap();
                let launch_id = state.launch_identity.as_ref().unwrap().launch_id.clone();
                state
                    .child_terminated
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
                assert_eq!(
                    clear_terminated_sidecar(&mut state, 8, &launch_id),
                    Some("target")
                );
                Ok(())
            },
            |tailnet_access| {
                restored_profile.set(Some(tailnet_access));
                Err("disk stayed enabled".into())
            },
        )
        .unwrap_err();

        assert!(error.contains("replacement control plane terminated after startup"));
        assert!(error.contains(
            "the previous Tailnet access setting could not be restored: disk stayed enabled"
        ));
        assert_eq!(restored_profile.get(), Some(false));
        assert_eq!(&*profiles.borrow(), &[true, true]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("recovery"));
    }

    #[test]
    fn rollback_termination_after_readiness_unwinds_to_stopped() {
        use std::cell::Cell;

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let ready_checks = Cell::new(0);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                Ok(spawned(
                    if enabled { "target" } else { "rollback" },
                    spawns.get() as u8,
                ))
            },
            || {
                ready_checks.set(ready_checks.get() + 1);
                if ready_checks.get() == 1 {
                    return false;
                }
                let mut state = sidecar.lock().unwrap();
                let launch_id = state.launch_identity.as_ref().unwrap().launch_id.clone();
                state
                    .child_terminated
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
                assert_eq!(
                    clear_terminated_sidecar(&mut state, 8, &launch_id),
                    Some("rollback")
                );
                true
            },
            || panic!("an unready target cannot publish settings"),
            |_| panic!("unpublished settings need no restoration"),
        )
        .unwrap_err();
        assert!(error.contains("replacement control plane did not become ready"));
        assert!(error.contains("previous control plane terminated during rollback"));
        assert_eq!(spawns.get(), 2);
        assert_eq!(ready_checks.get(), 2);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
        assert!(state.launch_identity.is_none());
        assert!(state.child_terminated.is_none());
    }

    #[test]
    fn rollback_spawn_failure_clears_the_phase_and_preserves_both_errors() {
        use std::cell::Cell;

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |_, _| {
                spawns.set(spawns.get() + 1);
                if spawns.get() == 1 {
                    Err("target spawn failed".into())
                } else {
                    Err("rollback spawn failed".into())
                }
            },
            || panic!("no spawned process can become ready"),
            || panic!("settings must not be written"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("target spawn failed"));
        assert!(error.contains("rollback spawn failed"));
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
    }

    #[test]
    fn target_and_rollback_readiness_failures_kill_each_tracked_candidate() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let ready_checks = Cell::new(0);
        let terminated = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| terminated.borrow_mut().push(child),
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                Ok(spawned(
                    if enabled { "target" } else { "rollback" },
                    spawns.get() as u8,
                ))
            },
            || {
                ready_checks.set(ready_checks.get() + 1);
                let state = sidecar.lock().unwrap();
                if ready_checks.get() == 1 {
                    assert_eq!(state.phase, SidecarPhase::Reconfiguring);
                    assert_eq!(state.child, Some("target"));
                } else {
                    assert_eq!(state.phase, SidecarPhase::RollingBack);
                    assert_eq!(state.child, Some("rollback"));
                }
                false
            },
            || panic!("an unready target must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("replacement control plane did not become ready"));
        assert!(error.contains("previous control plane did not become ready"));
        assert_eq!(spawns.get(), 2);
        assert_eq!(ready_checks.get(), 2);
        assert_eq!(&*terminated.borrow(), &["old", "target", "rollback"]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
    }

    #[test]
    fn rollback_waits_for_the_failed_target_to_stop_before_spawning() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let stop_checks = Cell::new(0);
        let terminated = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| terminated.borrow_mut().push(child),
            || {
                stop_checks.set(stop_checks.get() + 1);
                stop_checks.get() == 1
            },
            |enabled, _generation| {
                assert!(enabled, "rollback must not spawn before the target stops");
                Ok(spawned("target", 3))
            },
            || false,
            || panic!("an unready target must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("failed replacement control plane did not stop"));
        assert_eq!(stop_checks.get(), 2);
        assert_eq!(&*terminated.borrow(), &["old", "target"]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
    }

    #[test]
    fn settings_failure_kills_the_target_and_restores_the_previous_profile() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let ready_checks = Cell::new(0);
        let terminated = RefCell::new(Vec::new());
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |child| terminated.borrow_mut().push(child),
            || true,
            |enabled, _generation| {
                spawns.set(spawns.get() + 1);
                Ok(spawned(
                    if enabled { "target" } else { "rollback" },
                    spawns.get() as u8,
                ))
            },
            || {
                ready_checks.set(ready_checks.get() + 1);
                true
            },
            || Err("settings stayed unchanged".into()),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error, "settings stayed unchanged");
        assert_eq!(spawns.get(), 2);
        assert_eq!(ready_checks.get(), 2);
        assert_eq!(&*terminated.borrow(), &["old", "target"]);
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("rollback"));
    }

    #[test]
    fn shutdown_during_the_first_stop_wait_prevents_primary_spawn() {
        use std::cell::Cell;

        let sidecar = running_sidecar("old");
        let operations = SidecarOperations::default();
        let spawns = Cell::new(0);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &operations,
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || {
                operations.begin_shutdown();
                shutdown_sidecar(&mut sidecar.lock().unwrap());
                true
            },
            |_, _| {
                spawns.set(spawns.get() + 1);
                Ok(spawned("must-not-spawn", 30))
            },
            || panic!("no candidate exists"),
            || panic!("shutdown must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(spawns.get(), 0);
        assert!(error.contains("reconfiguration was superseded"));
        assert!(operations.wait_for_idle(Duration::ZERO));
    }

    #[test]
    fn shutdown_during_rollback_stop_wait_prevents_rollback_spawn() {
        use std::cell::Cell;

        let sidecar = running_sidecar("old");
        let operations = SidecarOperations::default();
        let waits = Cell::new(0);
        let spawns = Cell::new(0);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &operations,
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || {
                waits.set(waits.get() + 1);
                if waits.get() == 2 {
                    operations.begin_shutdown();
                    shutdown_sidecar(&mut sidecar.lock().unwrap());
                }
                true
            },
            |_, _| {
                spawns.set(spawns.get() + 1);
                if spawns.get() == 1 {
                    Ok(spawned("failed-target", 31))
                } else {
                    panic!("rollback must not spawn after committed shutdown")
                }
            },
            || false,
            || panic!("a failed target must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert_eq!(waits.get(), 2);
        assert_eq!(spawns.get(), 1);
        assert!(error.contains("replacement control plane did not become ready"));
        assert!(error.contains("rollback was superseded"));
        assert!(operations.wait_for_idle(Duration::ZERO));
    }

    #[test]
    fn exit_drain_waits_for_a_parked_spawn_to_reject_and_terminate_its_candidate() {
        use std::sync::mpsc;

        let sidecar = Arc::new(running_sidecar("old"));
        let operations = Arc::new(SidecarOperations::default());
        let candidate_terminated = Arc::new(AtomicBool::new(false));
        let drain_returned = Arc::new(AtomicBool::new(false));
        let (spawned_tx, spawned_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();

        let task_sidecar = Arc::clone(&sidecar);
        let task_operations = Arc::clone(&operations);
        let task_terminated = Arc::clone(&candidate_terminated);
        let operation = thread::spawn(move || {
            reconfigure_sidecar_operation(
                &task_sidecar,
                &task_operations,
                SidecarNetworkChange {
                    previous_tailnet_access: false,
                    enabled: true,
                },
                |child| {
                    if child == "candidate" {
                        task_terminated.store(true, Ordering::Release);
                    }
                },
                || true,
                |_, _| {
                    spawned_tx.send(()).unwrap();
                    continue_rx.recv().unwrap();
                    Ok(spawned("candidate", 32))
                },
                || panic!("shutdown rejects the candidate before readiness"),
                || panic!("shutdown must not publish settings"),
                |_| Ok(()),
            )
            .unwrap_err()
        });
        spawned_rx.recv_timeout(Duration::from_secs(2)).unwrap();

        let exit_sidecar = Arc::clone(&sidecar);
        let exit_operations = Arc::clone(&operations);
        let exit_terminated = Arc::clone(&candidate_terminated);
        let exit_returned = Arc::clone(&drain_returned);
        let drain = thread::spawn(move || {
            let drained = shutdown_sidecar_and_wait(
                &exit_sidecar,
                &exit_operations,
                Duration::from_secs(2),
                |_| {},
            );
            assert!(drained);
            assert!(
                exit_terminated.load(Ordering::Acquire),
                "drain returned before the rejected candidate was terminated"
            );
            exit_returned.store(true, Ordering::Release);
        });
        assert!(wait_until(
            || operations.state.lock().unwrap().shutting_down,
            true,
            Duration::from_secs(2)
        ));
        assert!(
            !drain_returned.load(Ordering::Acquire),
            "Exit cannot return while spawn is still parked"
        );

        continue_tx.send(()).unwrap();
        let error = operation.join().unwrap();
        drain.join().unwrap();
        assert!(error.contains("reconfiguration was superseded"));
        assert!(candidate_terminated.load(Ordering::Acquire));
        assert!(drain_returned.load(Ordering::Acquire));
    }

    #[test]
    fn external_probe_that_loses_to_shutdown_cannot_commit_or_spawn() {
        let sidecar = Mutex::new(SidecarState::<&str>::default());
        let operations = SidecarOperations::default();
        let error = start_sidecar_operation(
            &sidecar,
            &operations,
            false,
            || {
                operations.begin_shutdown();
                shutdown_sidecar(&mut sidecar.lock().unwrap());
                true
            },
            |_, _| panic!("an external probe result never starts a managed child"),
            || panic!("external readiness is already proven"),
            |_| panic!("there is no managed child"),
        )
        .unwrap_err();
        assert!(error.contains("startup was superseded"));
        assert_eq!(sidecar.lock().unwrap().phase, SidecarPhase::Stopped);
        assert!(operations.wait_for_idle(Duration::ZERO));
    }

    #[test]
    fn initial_probe_that_loses_to_shutdown_prevents_managed_spawn() {
        let sidecar = Mutex::new(SidecarState::<&str>::default());
        let operations = SidecarOperations::default();
        let error = start_sidecar_operation(
            &sidecar,
            &operations,
            false,
            || {
                operations.begin_shutdown();
                shutdown_sidecar(&mut sidecar.lock().unwrap());
                false
            },
            |_, _| panic!("managed spawn must recheck currency after the external probe"),
            || panic!("no candidate exists"),
            |_| panic!("there is no managed child"),
        )
        .unwrap_err();
        assert!(error.contains("startup was superseded"));
        assert_eq!(sidecar.lock().unwrap().phase, SidecarPhase::Stopped);
        assert!(operations.wait_for_idle(Duration::ZERO));
    }

    #[test]
    fn shutdown_takes_the_pending_child_and_rejects_late_success_and_rollback() {
        use std::cell::{Cell, RefCell};

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let exited_child = RefCell::new(None);
        let published = Cell::new(false);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |_, _| {
                spawns.set(spawns.get() + 1);
                Ok(spawned("pending", 4))
            },
            || {
                let mut state = sidecar.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::Reconfiguring);
                assert_eq!(state.child, Some("pending"));
                *exited_child.borrow_mut() = shutdown_sidecar(&mut state);
                true
            },
            || {
                published.set(true);
                Ok(())
            },
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("superseded"));
        assert_eq!(spawns.get(), 1, "shutdown must fence rollback spawn");
        assert_eq!(*exited_child.borrow(), Some("pending"));
        assert!(!published.get(), "stale success must not publish settings");
        let mut state = sidecar.lock().unwrap();
        assert!(state.shutting_down);
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert!(begin_sidecar_reconfiguration(&mut state, false).is_err());
        assert!(begin_sidecar_start(&mut state).is_err());
    }

    #[test]
    fn shutdown_during_failed_spawn_prevents_late_rollback() {
        use std::cell::Cell;

        let sidecar = running_sidecar("old");
        let spawns = Cell::new(0);
        let error = reconfigure_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            SidecarNetworkChange {
                previous_tailnet_access: false,
                enabled: true,
            },
            |_| {},
            || true,
            |_, _| {
                spawns.set(spawns.get() + 1);
                let mut state = sidecar.lock().unwrap();
                shutdown_sidecar(&mut state);
                Err("spawn failed during Exit".into())
            },
            || panic!("no candidate exists"),
            || panic!("stale failure must not publish settings"),
            |_| Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("spawn failed during Exit"));
        assert!(error.contains("rollback was superseded"));
        assert_eq!(spawns.get(), 1);
        assert!(sidecar.lock().unwrap().shutting_down);
    }

    #[test]
    fn a_stale_generation_cannot_replace_or_clear_the_winner() {
        let mut newer_transition = SidecarState {
            child: None,
            phase: SidecarPhase::Reconfiguring,
            generation: 9,
            shutting_down: false,
            ..SidecarState::default()
        };
        let rejected = install_sidecar_candidate(
            &mut newer_transition,
            8,
            SidecarPhase::Reconfiguring,
            spawned("stale", 5),
        )
        .unwrap_err();
        assert_eq!(rejected.child, "stale");
        assert!(!rejected.terminated);
        assert_eq!(newer_transition.child, None);
        assert_eq!(
            transition_sidecar_operation(
                &mut newer_transition,
                8,
                SidecarPhase::Reconfiguring,
                SidecarPhase::Stopped
            ),
            Err(())
        );
        assert_eq!(newer_transition.phase, SidecarPhase::Reconfiguring);

        let mut state = SidecarState {
            child: Some("winner"),
            phase: SidecarPhase::Running,
            generation: 9,
            shutting_down: false,
            launch_identity: Some(test_launch_identity(9)),
            child_terminated: Some(Arc::new(AtomicBool::new(false))),
        };
        let rejected = install_sidecar_candidate(
            &mut state,
            8,
            SidecarPhase::Reconfiguring,
            spawned("stale", 5),
        )
        .unwrap_err();
        assert_eq!(rejected.child, "stale");
        assert!(!rejected.terminated);
        let stale_termination = Arc::new(AtomicBool::new(false));
        assert_eq!(
            commit_managed_sidecar(
                &mut state,
                8,
                SidecarPhase::Reconfiguring,
                &stale_termination,
            ),
            ManagedCandidateState::Superseded
        );
        assert_eq!(
            transition_sidecar_operation(
                &mut state,
                8,
                SidecarPhase::Reconfiguring,
                SidecarPhase::RollingBack
            ),
            Err(())
        );
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("winner"));
        assert_eq!(state.generation, 9);
    }

    #[test]
    fn startup_tracks_managed_candidates_and_commits_external_ownership() {
        use std::cell::{Cell, RefCell};

        let external = Mutex::new(SidecarState::<&str>::default());
        let outcome = start_sidecar_operation(
            &external,
            &SidecarOperations::default(),
            false,
            || {
                let state = external.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::Starting);
                true
            },
            |_, _| panic!("an external control plane suppresses managed spawn"),
            || panic!("external readiness is already proven"),
            |_| panic!("there is no managed child"),
        )
        .unwrap();
        assert_eq!(outcome, SidecarStartOutcome::External);
        assert_eq!(external.lock().unwrap().phase, SidecarPhase::External);

        let managed = Mutex::new(SidecarState::<&str>::default());
        let terminated = RefCell::new(Vec::new());
        let spawned_profile = Cell::new(None);
        let outcome = start_sidecar_operation(
            &managed,
            &SidecarOperations::default(),
            true,
            || false,
            |enabled, _generation| {
                assert!(managed.try_lock().is_ok());
                spawned_profile.set(Some(enabled));
                Ok(spawned("candidate", 6))
            },
            || {
                let state = managed.lock().unwrap();
                assert_eq!(state.phase, SidecarPhase::Starting);
                assert_eq!(state.child, Some("candidate"));
                true
            },
            |child| terminated.borrow_mut().push(child),
        )
        .unwrap();
        assert_eq!(outcome, SidecarStartOutcome::Managed);
        assert_eq!(spawned_profile.get(), Some(true));
        assert!(terminated.borrow().is_empty());
        let state = managed.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Running);
        assert_eq!(state.child, Some("candidate"));
    }

    #[test]
    fn startup_failures_and_shutdown_clear_or_supersede_the_starting_phase() {
        use std::cell::RefCell;

        let failed = Mutex::new(SidecarState::<&str>::default());
        let error = start_sidecar_operation(
            &failed,
            &SidecarOperations::default(),
            false,
            || false,
            |_, _| Err("launch failed".into()),
            || panic!("no candidate exists"),
            |_| {},
        )
        .unwrap_err();
        assert_eq!(error, "launch failed");
        assert_eq!(failed.lock().unwrap().phase, SidecarPhase::Stopped);

        let unready = Mutex::new(SidecarState::<&str>::default());
        let terminated = RefCell::new(Vec::new());
        let error = start_sidecar_operation(
            &unready,
            &SidecarOperations::default(),
            false,
            || false,
            |_, _| Ok(spawned("candidate", 7)),
            || false,
            |child| terminated.borrow_mut().push(child),
        )
        .unwrap_err();
        assert!(error.contains("did not become ready"));
        assert_eq!(&*terminated.borrow(), &["candidate"]);
        assert_eq!(unready.lock().unwrap().phase, SidecarPhase::Stopped);

        let stale = Mutex::new(SidecarState::<&str>::default());
        let exited_child = RefCell::new(None);
        let error = start_sidecar_operation(
            &stale,
            &SidecarOperations::default(),
            false,
            || false,
            |_, _| Ok(spawned("pending", 8)),
            || {
                let mut state = stale.lock().unwrap();
                *exited_child.borrow_mut() = shutdown_sidecar(&mut state);
                true
            },
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("superseded"));
        assert_eq!(*exited_child.borrow(), Some("pending"));
        assert!(stale.lock().unwrap().shutting_down);
    }

    #[test]
    fn startup_termination_after_readiness_unwinds_to_stopped() {
        let sidecar = Mutex::new(SidecarState::<&str>::default());
        let error = start_sidecar_operation(
            &sidecar,
            &SidecarOperations::default(),
            false,
            || false,
            |_, _| Ok(spawned("candidate", 40)),
            || {
                let mut state = sidecar.lock().unwrap();
                let generation = state.generation;
                let launch_id = state.launch_identity.as_ref().unwrap().launch_id.clone();
                state
                    .child_terminated
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
                assert_eq!(
                    clear_terminated_sidecar(&mut state, generation, &launch_id),
                    Some("candidate")
                );
                true
            },
            |_| {},
        )
        .unwrap_err();
        assert!(error.contains("terminated after becoming ready"));
        let state = sidecar.lock().unwrap();
        assert_eq!(state.phase, SidecarPhase::Stopped);
        assert_eq!(state.child, None);
        assert!(state.launch_identity.is_none());
        assert!(state.child_terminated.is_none());
    }

    #[test]
    fn local_runner_credentials_and_ids_are_strictly_validated() {
        assert!(valid_runner_id("this-machine"));
        assert!(!valid_runner_id(" runner"));
        assert!(!valid_runner_id("runner/path"));
        assert!(!valid_runner_id("runner%2Fpath"));
        assert!(valid_runner_token(
            "mamr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_"
        ));
        assert!(valid_runner_token(
            "wollipogr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_"
        ));
        assert!(!valid_runner_token("mamr_short"));
        assert!(!valid_runner_token("wollipogr_short"));
        assert!(!valid_runner_token(
            "mamr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO+/"
        ));
        assert!(!valid_runner_token(
            "wollipogr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO+/"
        ));
        assert!(!valid_runner_token(
            "mamr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_a"
        ));
        assert!(!valid_runner_token(
            "wollipogr_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_a"
        ));
        assert!(!valid_runner_token(
            "wollipog_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_"
        ));
        assert!(!valid_runner_token(&format!("mamr_{}a", "é".repeat(21))));
        assert!(!valid_runner_token(&format!(
            "wollipogr_{}a",
            "é".repeat(21)
        )));
        assert!(valid_local_device_token(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO1_"
        ));
        assert!(!valid_local_device_token("short"));
        assert!(!valid_local_device_token(
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO+/"
        ));
    }

    #[test]
    fn external_runner_auth_requires_an_explicit_pairing_token() {
        let external = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        assert_eq!(
            select_external_local_runner_authorization_token(Some(external.clone())).unwrap(),
            external
        );
        assert!(select_external_local_runner_authorization_token(None).is_err());
        assert!(select_external_local_runner_authorization_token(Some("short".into())).is_err());
    }

    #[test]
    fn owned_local_runner_identity_is_snapshotted_with_its_child() {
        let mut state = LocalRunnerState::<u8>::default();
        assert_eq!(owned_local_runner_id(&state), Ok(None));

        state.child = Some(1);
        assert_eq!(
            owned_local_runner_id(&state),
            Err(()),
            "a child without an identity must fail closed"
        );
        state.runner_id = Some("runner-a".into());
        assert_eq!(owned_local_runner_id(&state), Ok(Some("runner-a".into())));

        state.child = None;
        assert_eq!(
            owned_local_runner_id(&state),
            Err(()),
            "an identity without its child also violates the invariant"
        );
    }

    #[test]
    fn replacement_moves_child_and_identity_through_one_state_machine() {
        use std::cell::Cell;

        let mut state = LocalRunnerState {
            child: Some("child-a"),
            runner_id: Some("runner-a".into()),
            generation: 9,
            credential_generation: 4,
            shutting_down: false,
        };
        let (generation, previous) = begin_local_runner_replacement(&mut state);
        assert_eq!(generation, 10);
        assert_eq!(previous, Some("child-a"));
        assert_eq!(owned_local_runner_id(&state), Ok(None));

        let published = Cell::new(false);
        commit_local_runner_candidate(
            &mut state,
            generation,
            "runner-b".into(),
            "child-b",
            false,
            || {
                published.set(true);
                Ok(())
            },
        )
        .unwrap();
        assert!(published.get());
        assert_eq!(state.child, Some("child-b"));
        assert_eq!(state.runner_id.as_deref(), Some("runner-b"));
    }

    #[test]
    fn failed_credential_staging_does_not_begin_replacement() {
        let mut state = LocalRunnerState {
            child: Some("child-a"),
            runner_id: Some("runner-a".into()),
            generation: 9,
            credential_generation: 4,
            shutting_down: false,
        };
        let result = stage_local_runner_replacement(
            &mut state,
            || Err("credential file stayed unchanged".into()),
            true,
        );
        assert_eq!(result.unwrap_err(), "credential file stayed unchanged");
        assert_eq!(state.generation, 9);
        assert_eq!(state.credential_generation, 4);
        assert_eq!(state.child, Some("child-a"));
        assert_eq!(state.runner_id.as_deref(), Some("runner-a"));
    }

    #[test]
    fn failed_candidate_publication_leaves_no_mismatched_running_identity() {
        let mut state = LocalRunnerState {
            child: Some("child-a"),
            runner_id: Some("runner-a".into()),
            generation: 2,
            credential_generation: 1,
            shutting_down: false,
        };
        let (generation, previous) = begin_local_runner_replacement(&mut state);
        assert_eq!(previous, Some("child-a"));

        let error = commit_local_runner_candidate(
            &mut state,
            generation,
            "runner-b".into(),
            "child-b",
            false,
            || Err("settings stayed on runner-a".into()),
        )
        .unwrap_err();
        assert_eq!(error.0, "child-b");
        assert_eq!(error.1, "settings stayed on runner-a");
        assert_eq!(owned_local_runner_id(&state), Ok(None));
    }

    #[test]
    fn a_newer_generation_wins_over_late_success_and_termination() {
        use std::cell::Cell;

        let mut state = LocalRunnerState::<&str>::default();
        let (stale_generation, _) = begin_local_runner_replacement(&mut state);
        state.generation = stale_generation.wrapping_add(1);
        state.child = Some("winner-child");
        state.runner_id = Some("winner".into());

        let published = Cell::new(false);
        let rejected = commit_local_runner_candidate(
            &mut state,
            stale_generation,
            "stale".into(),
            "stale-child",
            false,
            || {
                published.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(rejected.0, "stale-child");
        assert!(
            !published.get(),
            "a stale candidate must not publish settings"
        );
        assert_eq!(state.child, Some("winner-child"));
        assert_eq!(state.runner_id.as_deref(), Some("winner"));

        assert!(!clear_terminated_local_runner(&mut state, stale_generation));
        assert_eq!(
            owned_local_runner_id(&state),
            Ok(Some("winner".into())),
            "a stale termination must not clear the winner"
        );
    }

    #[test]
    fn a_candidate_that_already_terminated_never_publishes_settings() {
        use std::cell::Cell;

        let mut state = LocalRunnerState::<&str>::default();
        let (generation, _) = begin_local_runner_replacement(&mut state);
        let published = Cell::new(false);
        let rejected = commit_local_runner_candidate(
            &mut state,
            generation,
            "runner-b".into(),
            "child-b",
            true,
            || {
                published.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(rejected.0, "child-b");
        assert!(!published.get());
        assert_eq!(owned_local_runner_id(&state), Ok(None));
    }

    #[test]
    fn matching_termination_clears_child_and_identity_together() {
        let mut state = LocalRunnerState {
            child: Some("child-a"),
            runner_id: Some("runner-a".into()),
            generation: 7,
            credential_generation: 3,
            shutting_down: false,
        };
        assert!(clear_terminated_local_runner(&mut state, 7));
        assert_eq!(owned_local_runner_id(&state), Ok(None));
        assert_eq!(state.credential_generation, 3);
    }

    #[test]
    fn committed_exit_fences_staging_and_candidate_commit() {
        use std::cell::Cell;

        let mut state = LocalRunnerState {
            child: Some("owned-child"),
            runner_id: Some("runner-a".into()),
            generation: 7,
            credential_generation: 3,
            shutting_down: false,
        };
        assert_eq!(shutdown_local_runner(&mut state), Some("owned-child"));
        assert!(state.shutting_down);
        assert_eq!(state.generation, 8);
        assert_eq!(owned_local_runner_id(&state), Ok(None));

        let staged = Cell::new(false);
        let error = stage_local_runner_replacement(
            &mut state,
            || {
                staged.set(true);
                Ok(())
            },
            true,
        )
        .unwrap_err();
        assert_eq!(error, "the desktop is shutting down");
        assert!(!staged.get(), "Exit must fence credential writes");
        assert_eq!(state.credential_generation, 3);

        let published = Cell::new(false);
        let rejected = commit_local_runner_candidate(
            &mut state,
            8,
            "runner-b".into(),
            "late-child",
            false,
            || {
                published.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(rejected.0, "late-child");
        assert_eq!(rejected.1, "the desktop is shutting down");
        assert!(!published.get());
    }

    #[test]
    fn invalid_owned_identity_maps_to_unknown_exit_risk() {
        let mut state = LocalRunnerState::<u8> {
            child: Some(1),
            ..LocalRunnerState::default()
        };
        assert_eq!(
            runner_id_or_exit_risk(&state),
            Err(ExitRisk::Unknown),
            "the close guard must not fall back to separately mutable settings"
        );
        state.child = None;
        assert_eq!(runner_id_or_exit_risk(&state), Err(ExitRisk::None));
    }

    #[test]
    fn startup_restore_defers_to_current_settings_or_a_running_child() {
        let mut state = LocalRunnerState::<u8>::default();
        assert!(should_restore_saved_local_runner(
            "runner-a",
            Some("runner-a"),
            &state
        ));
        assert!(!should_restore_saved_local_runner(
            "runner-a",
            Some("runner-b"),
            &state
        ));

        state.child = Some(1);
        state.runner_id = Some("runner-a".into());
        assert!(!should_restore_saved_local_runner(
            "runner-a",
            Some("runner-a"),
            &state
        ));

        state.child = None;
        state.runner_id = None;
        state.shutting_down = true;
        assert!(!should_restore_saved_local_runner(
            "runner-a",
            Some("runner-a"),
            &state
        ));
    }

    #[test]
    fn startup_restore_requires_serialization_and_rereads_current_settings() {
        use std::cell::Cell;

        let registry = tokio::sync::Mutex::new(());
        let guard = registry.blocking_lock();
        let state = LocalRunnerState::<u8>::default();
        let reads = Cell::new(0);

        assert!(
            decide_saved_local_runner_restore(&guard, "runner-a", &state, || {
                reads.set(reads.get() + 1);
                Ok(Some("runner-a".into()))
            })
            .unwrap()
        );
        assert!(
            !decide_saved_local_runner_restore(&guard, "runner-a", &state, || {
                reads.set(reads.get() + 1);
                Ok(Some("runner-b".into()))
            })
            .unwrap()
        );
        assert_eq!(reads.get(), 2, "each decision must re-read settings");
    }

    #[test]
    fn replacement_failure_classifies_process_and_credential_generations_independently() {
        let mut state = LocalRunnerState::<u8> {
            generation: 8,
            credential_generation: 3,
            ..LocalRunnerState::default()
        };
        let failure = LocalRunnerReplacementFailure {
            message: "superseded".into(),
            generation: Some(7),
            credential_generation: Some(3),
        };
        assert!(!failure.attempt_is_current(&state));
        assert!(
            failure.is_latest_credential_writer(&state),
            "Exit may supersede the process without staging another credential"
        );

        state.credential_generation = 4;
        assert!(
            !failure.is_latest_credential_writer(&state),
            "a newer credential writer owns rollback"
        );
        assert!(!should_restore_replacement_credential(
            &failure, &state, false
        ));
        let preflight = LocalRunnerReplacementFailure {
            message: "not ready".into(),
            generation: None,
            credential_generation: None,
        };
        assert!(!preflight.attempt_is_current(&state));
        assert!(!preflight.is_latest_credential_writer(&state));
    }

    #[test]
    fn credential_restore_wiring_runs_only_for_the_latest_different_id_writer() {
        use std::cell::Cell;

        let mut state = LocalRunnerState::<u8> {
            credential_generation: 3,
            ..LocalRunnerState::default()
        };
        let failure = LocalRunnerReplacementFailure {
            message: "replacement failed".into(),
            generation: Some(7),
            credential_generation: Some(3),
        };
        let calls = Cell::new(0);

        assert!(restore_replacement_credential_if_decided(
            should_restore_replacement_credential(&failure, &state, false),
            || {
                calls.set(calls.get() + 1);
                Ok(())
            }
        )
        .unwrap());
        assert_eq!(calls.get(), 1);
        assert!(!restore_replacement_credential_if_decided(
            should_restore_replacement_credential(&failure, &state, true),
            || {
                calls.set(calls.get() + 1);
                Ok(())
            }
        )
        .unwrap());
        assert_eq!(
            calls.get(),
            1,
            "same-ID snapshots have uncertain server state and must not replace a fresh token"
        );

        state.credential_generation = 4;
        assert!(!restore_replacement_credential_if_decided(
            should_restore_replacement_credential(&failure, &state, false),
            || {
                calls.set(calls.get() + 1);
                Ok(())
            }
        )
        .unwrap());
        assert_eq!(calls.get(), 1, "a superseded writer cannot restore");
    }

    #[test]
    fn credential_restore_wiring_propagates_filesystem_errors() {
        use std::cell::Cell;

        let error =
            restore_replacement_credential_if_decided(true, || Err("restore failed".into()))
                .unwrap_err();
        assert_eq!(error, "restore failed");
        let called = Cell::new(false);
        assert!(!restore_replacement_credential_if_decided(false, || {
            called.set(true);
            Ok(())
        })
        .unwrap());
        assert!(!called.get());
    }

    #[test]
    fn credential_write_is_atomic_and_creates_the_temporary_file_private() {
        let dir = std::env::temp_dir().join(format!(
            "wollipog-local-runner-atomic-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.token");
        let previous = b"previous-credential";
        fs::write(&path, previous).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }

        let mut staged = open_private_atomic_file(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                staged
                    .file
                    .as_file()
                    .metadata()
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
                "the temporary inode must be private before secret bytes are written"
            );
        }
        staged.file.write_all(b"partial-candidate").unwrap();
        let abandoned_temp = staged.temp_path.clone();
        drop(staged);
        assert!(
            !abandoned_temp.exists(),
            "dropping an uncommitted write must discard its temporary file"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            previous,
            "an uncommitted partial write must leave the destination byte-exact"
        );

        write_local_runner_credential_file(&path, b"complete-candidate").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete-candidate");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "preserve_mode(false) must not retain a permissive destination mode"
            );
        }

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_atomic_commit_removes_only_its_own_secret_temporary_file() {
        let dir = std::env::temp_dir().join(format!(
            "wollipog-local-runner-atomic-failure-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.token");
        let mut first = open_private_atomic_file(&path).unwrap();
        let mut concurrent = open_private_atomic_file(&path).unwrap();
        first.file.write_all(b"first-secret").unwrap();
        concurrent.file.write_all(b"concurrent-secret").unwrap();
        let first_temp = first.temp_path.clone();
        let concurrent_temp = concurrent.temp_path.clone();
        assert_ne!(first_temp, concurrent_temp);

        // A directory at the destination makes the crate's final rename fail on every supported
        // desktop platform. Its `commit` has already disabled Drop cleanup at that point.
        fs::create_dir(&path).unwrap();
        assert!(commit_private_atomic_file(first).is_err());
        assert!(
            !first_temp.exists(),
            "the failed writer's secret temporary file must be removed"
        );
        assert!(
            concurrent_temp.exists(),
            "cleanup must not sweep another writer's temporary file"
        );

        drop(concurrent);
        assert!(!concurrent_temp.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn machine_identity_is_stable_per_directory_and_distinct_between_installations() {
        let root = std::env::temp_dir().join(format!(
            "wollipog-local-runner-machine-id-{}",
            uuid::Uuid::new_v4()
        ));
        let first_path = root.join("first").join(LOCAL_RUNNER_MACHINE_ID_FILE);
        let second_path = root.join("second").join(LOCAL_RUNNER_MACHINE_ID_FILE);

        let first = load_or_create_local_runner_machine_id(&first_path).unwrap();
        assert_eq!(
            load_or_create_local_runner_machine_id(&first_path).unwrap(),
            first,
            "re-reading one installation must keep its identity"
        );
        let second = load_or_create_local_runner_machine_id(&second_path).unwrap();
        assert_ne!(
            first, second,
            "separate application-data directories represent separate installations"
        );
        assert_eq!(
            fs::read_to_string(&first_path).unwrap(),
            first.hyphenated().to_string(),
            "the persisted bytes are the canonical machine UUID"
        );
        assert_eq!(
            suggested_local_runner_id(&first_path).unwrap(),
            format!("this-machine-{}", &first.simple().to_string()[..8])
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&first_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_and_empty_machine_identity_files_recover_to_stable_canonical_ids() {
        let root = std::env::temp_dir().join(format!(
            "wollipog-local-runner-machine-id-recovery-{}",
            uuid::Uuid::new_v4()
        ));
        for (name, invalid_bytes) in [
            ("corrupt", b"not-a-machine-id".as_slice()),
            ("empty", b"".as_slice()),
        ] {
            let path = root.join(name).join(LOCAL_RUNNER_MACHINE_ID_FILE);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, invalid_bytes).unwrap();

            let recovered = load_or_create_local_runner_machine_id(&path).unwrap();
            assert_eq!(
                fs::read_to_string(&path).unwrap(),
                recovered.hyphenated().to_string(),
                "{name} content must be replaced with a canonical UUID"
            );
            assert_eq!(
                load_or_create_local_runner_machine_id(&path).unwrap(),
                recovered,
                "the recovered {name} identity must remain stable"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_runner_status_falls_back_when_machine_identity_is_unavailable() {
        let suggestion =
            local_runner_suggestion_or_default(Err("identity directory is unavailable".into()));
        let status = local_runner_status_snapshot(
            Some("configured-runner".into()),
            true,
            None,
            false,
            suggestion,
        );
        assert!(
            status.enabled,
            "status must survive an optional identity failure"
        );
        assert_eq!(status.runner_id.as_deref(), Some("configured-runner"));
        assert_eq!(status.suggested_runner_id, "this-machine");
    }

    #[test]
    fn local_runner_status_keeps_configured_identity_and_exposes_the_suggestion() {
        let status = local_runner_status_snapshot(
            Some("configured-runner".into()),
            true,
            None,
            false,
            "this-machine-a1b2c3d4".into(),
        );
        assert_eq!(
            status,
            LocalRunnerStatus {
                available: true,
                enabled: true,
                running: false,
                runner_id: Some("configured-runner".into()),
                suggested_runner_id: "this-machine-a1b2c3d4".into(),
            }
        );

        let running = local_runner_status_snapshot(
            Some("configured-runner".into()),
            true,
            Some("owned-runner".into()),
            true,
            "this-machine-a1b2c3d4".into(),
        );
        assert_eq!(running.runner_id.as_deref(), Some("owned-runner"));
        assert_eq!(running.suggested_runner_id, "this-machine-a1b2c3d4");
    }

    #[test]
    fn credential_rollback_restores_exact_bytes_or_removes_a_new_file() {
        let dir = std::env::temp_dir().join(format!(
            "wollipog-local-runner-credential-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.token");

        let missing = snapshot_local_runner_credential_file(&path).unwrap();
        assert_eq!(missing, PreviousLocalRunnerCredential::Missing);
        write_local_runner_credential_file(&path, b"candidate").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        restore_local_runner_credential_file(&path, &missing).unwrap();
        assert!(!path.exists());

        let previous_bytes = b"previous-credential\n";
        write_local_runner_credential_file(&path, previous_bytes).unwrap();
        let previous = snapshot_local_runner_credential_file(&path).unwrap();
        write_local_runner_credential_file(&path, b"candidate").unwrap();
        restore_local_runner_credential_file(&path, &previous).unwrap();
        assert_eq!(fs::read(&path).unwrap(), previous_bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn process_supersession_still_restores_the_latest_staged_credential() {
        let dir = std::env::temp_dir().join(format!(
            "wollipog-local-runner-stage-generation-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("runner.token");
        let previous_bytes = b"runner-a-credential\n";
        write_local_runner_credential_file(&path, previous_bytes).unwrap();
        let previous = snapshot_local_runner_credential_file(&path).unwrap();

        let mut state = LocalRunnerState::<u8>::default();
        let (generation, credential_generation, previous_child) = stage_local_runner_replacement(
            &mut state,
            || write_local_runner_credential_file(&path, b"runner-b-credential"),
            true,
        )
        .unwrap();
        assert_eq!(previous_child, None);
        assert_eq!(credential_generation, Some(1));

        state.generation = generation.wrapping_add(1);
        let failure = LocalRunnerReplacementFailure {
            message: "Exit superseded the process".into(),
            generation: Some(generation),
            credential_generation,
        };
        assert!(!failure.attempt_is_current(&state));
        assert!(failure.is_latest_credential_writer(&state));
        let should_restore = should_restore_replacement_credential(&failure, &state, false);
        assert!(
            restore_replacement_credential_if_decided(should_restore, || {
                restore_local_runner_credential_file(&path, &previous)
            })
            .unwrap()
        );
        assert_eq!(fs::read(&path).unwrap(), previous_bytes);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn credential_rollback_keeps_the_atomically_installed_same_id_token() {
        for (same_runner_id, latest_writer, expected) in [
            (false, false, false),
            (false, true, true),
            (true, false, false),
            (true, true, false),
        ] {
            assert_eq!(
                should_restore_previous_local_runner_credential(same_runner_id, latest_writer),
                expected,
                "same_runner_id={same_runner_id}, latest_writer={latest_writer}"
            );
        }
    }
}
