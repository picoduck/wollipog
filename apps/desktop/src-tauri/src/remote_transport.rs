use std::collections::HashMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::{Client, Method, StatusCode};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::State;
use tokio::net::{TcpSocket, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::{Message, WebSocketConfig};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use url::Url;
use uuid::Uuid;

use crate::instances::{
    canonical_remote_origin, is_control_plane_service, now, remote_profile, CanonicalRemoteOrigin,
    ControlPlaneInstanceInfo, InstanceProfile, InstanceRegistryState, TransportSecurity,
};
#[cfg(test)]
use crate::instances::{LEGACY_CONTROL_PLANE_SERVICE, WOLLIPOG_CONTROL_PLANE_SERVICE};
use crate::secrets::native_secret_get;
use crate::settings::{read_settings_result, write_settings};

const MAX_REQUEST_META_BYTES: usize = 16 * 1024;
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES: usize = 128 * 1024 * 1024;
const MAX_PROBE_BODY_BYTES: usize = 256 * 1024;
const MAX_PATH_BYTES: usize = 8 * 1024;
const MAX_UI_SEND_BYTES: usize = 64 * 1024;
const MAX_UI_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_RUNTIME_LEASES: usize = 8;
const MAX_SOCKET_ATTEMPTS: usize = 16;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const MAX_RUNTIME_KEY_BYTES: usize = 160;
#[cfg(not(test))]
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg(test)]
const WEBSOCKET_CONNECT_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone)]
struct RuntimeLease {
    profile_id: String,
    profile_origin: CanonicalRemoteOrigin,
    server_instance_id: String,
    client: Client,
    secret: Arc<SecretString>,
    cancel: watch::Sender<bool>,
}

struct SocketEntry {
    runtime_key: String,
    nonce: u64,
    sender: mpsc::Sender<SocketCommand>,
    cancel: watch::Sender<bool>,
}

struct RequestEntry {
    runtime_key: String,
    nonce: u64,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct RemoteTransportInner {
    runtimes: Mutex<HashMap<String, RuntimeLease>>,
    sockets: Mutex<HashMap<String, SocketEntry>>,
    requests: Mutex<HashMap<String, RequestEntry>>,
    next_socket_nonce: Mutex<u64>,
    next_request_nonce: Mutex<u64>,
}

#[derive(Clone, Default)]
pub(crate) struct RemoteTransport {
    inner: Arc<RemoteTransportInner>,
}

impl RemoteTransport {
    fn runtime(&self, runtime_key: &str) -> Result<RuntimeLease, String> {
        self.inner
            .runtimes
            .lock()
            .unwrap()
            .get(runtime_key)
            .cloned()
            .ok_or_else(|| "The remote instance connection is closed.".to_string())
    }

    fn insert_runtime(&self, runtime_key: String, lease: RuntimeLease) -> Result<(), String> {
        let mut runtimes = self.inner.runtimes.lock().unwrap();
        if runtimes.contains_key(&runtime_key) {
            return Err("The remote instance connection identifier is already in use.".into());
        }
        if runtimes.len() >= MAX_RUNTIME_LEASES {
            return Err("Too many remote instance connections are open.".into());
        }
        runtimes.insert(runtime_key, lease);
        Ok(())
    }

    async fn close_runtime(&self, runtime_key: &str) {
        let previous = self.inner.runtimes.lock().unwrap().remove(runtime_key);
        if let Some(previous) = previous {
            previous.cancel.send_replace(true);
        }
        let socket_cancellations = {
            let mut sockets = self.inner.sockets.lock().unwrap();
            let keys: Vec<String> = sockets
                .iter()
                .filter_map(|(key, entry)| {
                    (entry.runtime_key == runtime_key).then_some(key.clone())
                })
                .collect();
            keys.into_iter()
                .filter_map(|key| sockets.remove(&key).map(|entry| entry.cancel))
                .collect::<Vec<_>>()
        };
        for cancel in socket_cancellations {
            cancel.send_replace(true);
        }
        let request_cancellations = {
            let mut requests = self.inner.requests.lock().unwrap();
            let keys = requests
                .iter()
                .filter_map(|(key, entry)| {
                    (entry.runtime_key == runtime_key).then_some(key.clone())
                })
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| requests.remove(&key).map(|entry| entry.cancel))
                .collect::<Vec<_>>()
        };
        for cancel in request_cancellations {
            cancel.send_replace(true);
        }
    }

    pub(crate) async fn close_profile(&self, profile_id: &str) {
        let runtime_keys = {
            let runtimes = self.inner.runtimes.lock().unwrap();
            runtimes
                .iter()
                .filter_map(|(key, lease)| (lease.profile_id == profile_id).then_some(key.clone()))
                .collect::<Vec<_>>()
        };
        for key in runtime_keys {
            self.close_runtime(&key).await;
        }
    }

    pub(crate) async fn close_all(&self) {
        let runtime_keys = self
            .inner
            .runtimes
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for key in runtime_keys {
            self.close_runtime(&key).await;
        }
    }

    fn reserve_socket(
        &self,
        runtime_key: &str,
        socket_id: &str,
        sender: mpsc::Sender<SocketCommand>,
    ) -> Result<(String, u64, watch::Receiver<bool>), String> {
        valid_identifier(socket_id, 100, "socket")?;
        let key = format!("{}:{}:{}", runtime_key.len(), runtime_key, socket_id);
        let mut sockets = self.inner.sockets.lock().unwrap();
        if !sockets.contains_key(&key) && sockets.len() >= MAX_SOCKET_ATTEMPTS {
            return Err("Too many remote socket attempts are open.".into());
        }
        let nonce = {
            let mut next = self.inner.next_socket_nonce.lock().unwrap();
            *next = next.wrapping_add(1);
            *next
        };
        let (cancel, receiver) = watch::channel(false);
        if let Some(previous) = sockets.insert(
            key.clone(),
            SocketEntry {
                runtime_key: runtime_key.to_string(),
                nonce,
                sender,
                cancel,
            },
        ) {
            previous.cancel.send_replace(true);
        }
        Ok((key, nonce, receiver))
    }

    fn remove_socket(&self, key: &str, nonce: u64) {
        let mut sockets = self.inner.sockets.lock().unwrap();
        if sockets.get(key).is_some_and(|entry| entry.nonce == nonce) {
            sockets.remove(key);
        }
    }

    fn reserve_request(
        &self,
        runtime_key: &str,
        request_id: &str,
    ) -> Result<(String, u64, watch::Receiver<bool>), String> {
        let key = format!("{}:{}:{}", runtime_key.len(), runtime_key, request_id);
        let mut requests = self.inner.requests.lock().unwrap();
        if !requests.contains_key(&key) && requests.len() >= MAX_IN_FLIGHT_REQUESTS {
            return Err("Too many remote instance requests are in progress.".into());
        }
        let nonce = {
            let mut next = self.inner.next_request_nonce.lock().unwrap();
            *next = next.wrapping_add(1);
            *next
        };
        let (cancel, receiver) = watch::channel(false);
        if let Some(previous) = requests.insert(
            key.clone(),
            RequestEntry {
                runtime_key: runtime_key.to_string(),
                nonce,
                cancel,
            },
        ) {
            previous.cancel.send_replace(true);
        }
        Ok((key, nonce, receiver))
    }

    fn remove_request(&self, key: &str, nonce: u64) {
        let mut requests = self.inner.requests.lock().unwrap();
        if requests.get(key).is_some_and(|entry| entry.nonce == nonce) {
            requests.remove(key);
        }
    }
}

async fn wait_for_cancel(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    let _ = cancel.changed().await;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRuntimeHandle {
    profile_id: String,
    runtime_key: String,
    public_origin: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteOpenError {
    code: &'static str,
    message: String,
}

impl RemoteOpenError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn probe_open_error(message: String) -> RemoteOpenError {
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("pairing token was rejected") {
        "authentication-required"
    } else if lower.contains("unsupported api version")
        || lower.contains("does not support remote instances")
        || lower.contains("invalid compatibility metadata")
    {
        "incompatible"
    } else {
        "offline"
    };
    RemoteOpenError::new(code, message)
}

fn remote_open_profile_changed() -> RemoteOpenError {
    RemoteOpenError::new(
        "profile-changed",
        "The remote instance changed while it was being opened. Try again.",
    )
}

fn validate_remote_open_fence(
    current: &InstanceProfile,
    expected: &InstanceProfile,
    current_secret: &SecretString,
    probed_secret: &SecretString,
) -> Result<(), RemoteOpenError> {
    if !current.has_same_stable_configuration(expected)
        || current_secret.expose_secret() != probed_secret.expose_secret()
    {
        return Err(remote_open_profile_changed());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHttpRequestMeta {
    runtime_key: String,
    request_id: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body_length: usize,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHttpResponseMeta {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body_length: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum NativeUiEvent {
    Open,
    Message { data: String },
    Error,
    Close { code: u16 },
}

enum SocketCommand {
    Send(String),
}

fn valid_identifier(value: &str, max: usize, kind: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\', '?', '#', '%'])
    {
        return Err(format!("The remote {kind} identifier is invalid."));
    }
    Ok(())
}

fn method(value: &str) -> Result<Method, String> {
    match value {
        "GET" => Ok(Method::GET),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        _ => Err("The remote request method is not allowed.".into()),
    }
}

fn has_encoded_separator_or_dot_segment(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2f")
        || lower.contains("%5c")
        || lower.contains("%00")
        || lower.contains("%252e")
        || lower.contains("%252f")
        || lower.contains("%255c")
    {
        return true;
    }
    lower.split('/').any(|segment| {
        let decoded_dots = segment.replace("%2e", ".");
        decoded_dots == "." || decoded_dots == ".."
    })
}

fn remote_url(origin: &str, path: &str) -> Result<Url, String> {
    if path.len() > MAX_PATH_BYTES
        || !path.starts_with("/api/")
        || path.starts_with("//")
        || path.contains(['#', '\\'])
        || path.chars().any(char::is_control)
        || has_encoded_separator_or_dot_segment(path.split('?').next().unwrap_or(path))
    {
        return Err("The remote API path is not allowed.".into());
    }
    let url = Url::parse(&format!("{origin}{path}"))
        .map_err(|_| "The remote API path is invalid.".to_string())?;
    if url.origin().ascii_serialization() != origin || !url.path().starts_with("/api/") {
        return Err("The remote API path escaped the selected instance.".into());
    }
    Ok(url)
}

fn request_headers(values: &[(String, String)]) -> Result<HeaderMap, String> {
    if values.len() > 8 {
        return Err("The remote request has too many headers.".into());
    }
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = name.to_ascii_lowercase();
        if name != "content-type" && name != "accept" {
            return Err("The remote request header is not allowed.".into());
        }
        if value.len() > 512 || value.chars().any(char::is_control) {
            return Err("The remote request header value is invalid.".into());
        }
        headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "The remote request header is invalid.".to_string())?,
            HeaderValue::from_str(value)
                .map_err(|_| "The remote request header value is invalid.".to_string())?,
        );
    }
    Ok(headers)
}

fn bearer(secret: &SecretString) -> Result<HeaderValue, String> {
    let mut value = HeaderValue::from_str(&format!("Bearer {}", secret.expose_secret()))
        .map_err(|_| "The remote instance credential is invalid.".to_string())?;
    value.set_sensitive(true);
    Ok(value)
}

fn websocket_request(
    endpoint: &CanonicalRemoteOrigin,
    secret: &SecretString,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, String> {
    let mut socket_url = Url::parse(&endpoint.origin)
        .map_err(|_| "The remote UI address is invalid.".to_string())?;
    let scheme = if socket_url.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    socket_url
        .set_scheme(scheme)
        .map_err(|_| "The remote UI address is invalid.".to_string())?;
    socket_url.set_path("/ui");
    let mut request = socket_url
        .as_str()
        .into_client_request()
        .map_err(|_| "The remote UI address is invalid.".to_string())?;
    request.headers_mut().insert(AUTHORIZATION, bearer(secret)?);
    Ok(request)
}

fn contains_secret(bytes: &[u8], secret: &SecretString) -> bool {
    let secret = secret.expose_secret().as_bytes();
    !secret.is_empty() && memchr::memmem::find(bytes, secret).is_some()
}

fn hardened_client(local_address: Option<IpAddr>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .tls_backend_native()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false)
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(2)
        .user_agent(concat!("Wollipog/", env!("CARGO_PKG_VERSION")));
    if let Some(address) = local_address {
        builder = builder.local_address(address);
    }
    builder
        .build()
        .map_err(|_| "The secure remote transport could not be initialized.".to_string())
}

fn tailscale_command() -> Vec<String> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = std::env::var_os(variable) {
                candidates.push(
                    std::path::PathBuf::from(root)
                        .join("Tailscale")
                        .join("tailscale.exe")
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.extend([
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale".to_string(),
            "/opt/homebrew/bin/tailscale".to_string(),
            "/usr/local/bin/tailscale".to_string(),
        ]);
    }
    #[cfg(target_os = "linux")]
    {
        candidates.extend([
            "/usr/bin/tailscale".to_string(),
            "/usr/local/bin/tailscale".to_string(),
        ]);
    }
    candidates
        .into_iter()
        .filter(|candidate| std::path::Path::new(candidate).is_file())
        .collect()
}

fn read_tailscale_status(program: &str) -> Option<Vec<u8>> {
    const LIMIT: usize = 1024 * 1024;
    let mut child = Command::new(program)
        .args(["status", "--json"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(bytes)
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() < Duration::from_secs(3) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    }?;
    let bytes = reader.join().ok()??;
    (status.success() && bytes.len() <= LIMIT).then_some(bytes)
}

fn tailscale_route(target: Ipv4Addr) -> Result<IpAddr, String> {
    let output = tailscale_command()
        .into_iter()
        .find_map(|program| read_tailscale_status(&program))
        .ok_or_else(|| "Tailscale could not verify the cleartext route.".to_string())?;
    let status: serde_json::Value = serde_json::from_slice(&output)
        .map_err(|_| "Tailscale returned an invalid route description.".to_string())?;
    tailscale_route_from_status(&status, target)
}

fn tailscale_route_from_status(
    status: &serde_json::Value,
    target: Ipv4Addr,
) -> Result<IpAddr, String> {
    let local = status
        .get("Self")
        .and_then(|value| value.get("TailscaleIPs"))
        .and_then(serde_json::Value::as_array)
        .and_then(|values| {
            values.iter().find_map(|value| {
                value
                    .as_str()
                    .and_then(|value| value.parse::<Ipv4Addr>().ok())
            })
        })
        .ok_or_else(|| "Tailscale is not connected with an IPv4 address.".to_string())?;
    let target_text = target.to_string();
    let peer_matches = status
        .get("Peer")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|peers| {
            peers.values().any(|peer| {
                peer.get("TailscaleIPs")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|values| {
                        values
                            .iter()
                            .any(|value| value.as_str() == Some(&target_text))
                    })
            })
        });
    if !peer_matches && local != target {
        return Err("The cleartext address is not a verified Tailscale peer.".into());
    }
    Ok(IpAddr::V4(local))
}

async fn client_for_endpoint(endpoint: &CanonicalRemoteOrigin) -> Result<Client, String> {
    let local_address = if endpoint.security == TransportSecurity::TailscaleRouteRequired {
        let target = Url::parse(&endpoint.origin)
            .ok()
            .and_then(|url| url.host_str()?.parse::<Ipv4Addr>().ok())
            .ok_or_else(|| "The cleartext Tailscale address is invalid.".to_string())?;
        Some(
            tokio::task::spawn_blocking(move || tailscale_route(target))
                .await
                .map_err(|_| "Tailscale route verification stopped unexpectedly.".to_string())??,
        )
    } else {
        None
    };
    hardened_client(local_address)
}

type NativeWebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
enum NativeWebSocketError {
    Authentication,
    Connection,
}

async fn connect_bound_tcp(
    local: IpAddr,
    target: SocketAddr,
) -> Result<TcpStream, NativeWebSocketError> {
    let socket = match local {
        IpAddr::V4(_) => TcpSocket::new_v4(),
        IpAddr::V6(_) => TcpSocket::new_v6(),
    }
    .map_err(|_| NativeWebSocketError::Connection)?;
    socket
        .bind(SocketAddr::new(local, 0))
        .map_err(|_| NativeWebSocketError::Connection)?;
    socket
        .connect(target)
        .await
        .map_err(|_| NativeWebSocketError::Connection)
}

fn websocket_connect_error(error: tokio_tungstenite::tungstenite::Error) -> NativeWebSocketError {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response)
            if matches!(
                response.status(),
                StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
            ) =>
        {
            NativeWebSocketError::Authentication
        }
        _ => NativeWebSocketError::Connection,
    }
}

async fn connect_websocket(
    endpoint: &CanonicalRemoteOrigin,
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    config: WebSocketConfig,
) -> Result<NativeWebSocket, NativeWebSocketError> {
    let connect = async {
        if endpoint.security == TransportSecurity::TailscaleRouteRequired {
            let url = Url::parse(&endpoint.origin).map_err(|_| NativeWebSocketError::Connection)?;
            let target = url
                .host_str()
                .and_then(|host| host.parse::<Ipv4Addr>().ok())
                .ok_or(NativeWebSocketError::Connection)?;
            let port = url
                .port_or_known_default()
                .ok_or(NativeWebSocketError::Connection)?;
            let local = tokio::task::spawn_blocking(move || tailscale_route(target))
                .await
                .map_err(|_| NativeWebSocketError::Connection)?
                .map_err(|_| NativeWebSocketError::Connection)?;
            let stream =
                connect_bound_tcp(local, SocketAddr::new(IpAddr::V4(target), port)).await?;
            let (socket, _) = tokio_tungstenite::client_async_with_config(
                request,
                MaybeTlsStream::Plain(stream),
                Some(config),
            )
            .await
            .map_err(websocket_connect_error)?;
            Ok(socket)
        } else {
            let (socket, _) =
                tokio_tungstenite::connect_async_with_config(request, Some(config), false)
                    .await
                    .map_err(websocket_connect_error)?;
            Ok(socket)
        }
    };
    tokio::time::timeout(WEBSOCKET_CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| NativeWebSocketError::Connection)?
}

async fn bounded_response(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("The remote instance returned an oversized response.".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| "The remote instance response was interrupted.".to_string())?;
        let next = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "The remote instance returned an oversized response.".to_string())?;
        if next > limit {
            return Err("The remote instance returned an oversized response.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn probe_request(
    client: &Client,
    endpoint: &CanonicalRemoteOrigin,
    path: &str,
    secret: Option<&SecretString>,
) -> Result<(StatusCode, Vec<u8>), String> {
    let mut request = client.get(format!("{}{path}", endpoint.origin));
    if let Some(secret) = secret {
        request = request.header(AUTHORIZATION, bearer(secret)?);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Could not connect to the remote Wollipog instance.".to_string())?;
    let status = response.status();
    let body = bounded_response(response, MAX_PROBE_BODY_BYTES).await?;
    Ok((status, body))
}

pub(crate) async fn probe_remote_instance(
    endpoint: &CanonicalRemoteOrigin,
    secret: &SecretString,
) -> Result<ControlPlaneInstanceInfo, String> {
    let client = client_for_endpoint(endpoint).await?;
    let (health_status, health_body) = probe_request(&client, endpoint, "/healthz", None).await?;
    let health: serde_json::Value = serde_json::from_slice(&health_body)
        .map_err(|_| "The address did not return a valid Wollipog health response.".to_string())?;
    if !health_status.is_success()
        || !health
            .get("service")
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_control_plane_service)
    {
        return Err("The address is not a Wollipog control plane.".into());
    }
    let (instance_status, instance_body) =
        probe_request(&client, endpoint, "/api/instance", Some(secret)).await?;
    if matches!(
        instance_status,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err("The pairing token was rejected. Generate a new pairing link.".into());
    }
    if !instance_status.is_success() {
        return Err("The remote Wollipog instance could not be paired.".into());
    }
    serde_json::from_slice(&instance_body)
        .map_err(|_| "The remote Wollipog instance returned invalid identity data.".to_string())
}

#[tauri::command]
pub(crate) async fn remote_transport_open(
    app: tauri::AppHandle,
    registry: State<'_, InstanceRegistryState>,
    transport: State<'_, RemoteTransport>,
    profile_id: String,
) -> Result<NativeRuntimeHandle, RemoteOpenError> {
    Uuid::parse_str(&profile_id).map_err(|_| {
        RemoteOpenError::new(
            "missing-profile",
            "The remote instance profile identifier is invalid.",
        )
    })?;
    let profile = {
        let _guard = registry.0.lock().await;
        let settings = read_settings_result(&app)
            .map_err(|message| RemoteOpenError::new("registry-unavailable", message))?;
        remote_profile(&settings, &profile_id)
            .map_err(|message| RemoteOpenError::new("missing-profile", message))?
    };
    let endpoint = canonical_remote_origin(&profile.origin)
        .map_err(|message| RemoteOpenError::new("incompatible", message))?;
    let secret = native_secret_get(profile_id.clone())
        .await
        .map_err(|message| {
            let code = if message.contains("credential is missing") {
                "missing-credential"
            } else {
                "credential-unavailable"
            };
            RemoteOpenError::new(code, message)
        })?;
    let info = probe_remote_instance(&endpoint, &secret)
        .await
        .map_err(probe_open_error)?;
    crate::instances::validate_discovery(&info).map_err(probe_open_error)?;
    if info.instance_id != profile.server_instance_id {
        return Err(RemoteOpenError::new(
            "identity-changed",
            "The address now belongs to a different Wollipog instance.",
        ));
    }
    let client = client_for_endpoint(&endpoint)
        .await
        .map_err(|message| RemoteOpenError::new("offline", message))?;
    let _guard = registry.0.lock().await;
    let mut settings = read_settings_result(&app)
        .map_err(|message| RemoteOpenError::new("registry-unavailable", message))?;
    let current = remote_profile(&settings, &profile_id)
        .map_err(|message| RemoteOpenError::new("missing-profile", message))?;
    let current_secret = native_secret_get(profile_id.clone())
        .await
        .map_err(|message| {
            if message.contains("credential is missing") {
                remote_open_profile_changed()
            } else {
                RemoteOpenError::new("credential-unavailable", message)
            }
        })?;
    validate_remote_open_fence(&current, &profile, &current_secret, &secret)?;
    let (cancel, _) = watch::channel(false);
    let runtime_key = Uuid::new_v4().to_string();
    transport
        .insert_runtime(
            runtime_key.clone(),
            RuntimeLease {
                profile_id: profile_id.clone(),
                profile_origin: endpoint.clone(),
                server_instance_id: profile.server_instance_id,
                client,
                secret: Arc::new(secret),
                cancel,
            },
        )
        .map_err(|message| RemoteOpenError::new("transport-unavailable", message))?;
    let saved = settings
        .remote_instances
        .iter_mut()
        .find(|candidate| candidate.id == profile_id)
        .ok_or_else(|| {
            RemoteOpenError::new(
                "missing-profile",
                "The remote Wollipog instance no longer exists.",
            )
        })?;
    saved.last_connected_at = Some(now());
    if let Err(message) = write_settings(&app, settings) {
        transport.close_runtime(&runtime_key).await;
        return Err(RemoteOpenError::new("registry-unavailable", message));
    }
    Ok(NativeRuntimeHandle {
        profile_id,
        runtime_key,
        public_origin: endpoint.origin,
    })
}

fn decode_http_request(request: &Request<'_>) -> Result<(NativeHttpRequestMeta, Vec<u8>), String> {
    let InvokeBody::Raw(frame) = request.body() else {
        return Err("The remote HTTP command requires a binary request frame.".into());
    };
    if frame.len() < 4 {
        return Err("The remote HTTP request frame is incomplete.".into());
    }
    let meta_length = u32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize;
    if meta_length == 0 || meta_length > MAX_REQUEST_META_BYTES || frame.len() < 4 + meta_length {
        return Err("The remote HTTP request metadata is invalid.".into());
    }
    let meta: NativeHttpRequestMeta = serde_json::from_slice(&frame[4..4 + meta_length])
        .map_err(|_| "The remote HTTP request metadata is invalid.".to_string())?;
    let body = frame[4 + meta_length..].to_vec();
    if body.len() != meta.body_length || body.len() > MAX_REQUEST_BODY_BYTES {
        return Err("The remote HTTP request body is invalid or too large.".into());
    }
    Ok((meta, body))
}

fn encode_http_response_frame(
    meta: &NativeHttpResponseMeta,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    let meta = serde_json::to_vec(meta)
        .map_err(|_| "The remote HTTP response metadata could not be encoded.".to_string())?;
    let meta_length = u32::try_from(meta.len())
        .map_err(|_| "The remote HTTP response metadata is too large.".to_string())?;
    let mut frame = Vec::with_capacity(4 + meta.len() + body.len());
    frame.extend_from_slice(&meta_length.to_le_bytes());
    frame.extend_from_slice(&meta);
    frame.extend_from_slice(body);
    Ok(frame)
}

fn encode_http_response(meta: &NativeHttpResponseMeta, body: &[u8]) -> Result<Response, String> {
    Ok(Response::new(encode_http_response_frame(meta, body)?))
}

#[tauri::command]
pub(crate) async fn remote_http_request(
    transport: State<'_, RemoteTransport>,
    request: Request<'_>,
) -> Result<Response, String> {
    let (meta, body) = decode_http_request(&request)?;
    valid_identifier(&meta.runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    valid_identifier(&meta.request_id, 100, "request")?;
    let lease = transport.runtime(&meta.runtime_key)?;
    let method = method(&meta.method)?;
    let url = remote_url(&lease.profile_origin.origin, &meta.path)?;
    let mut headers = request_headers(&meta.headers)?;
    headers.insert(AUTHORIZATION, bearer(&lease.secret)?);
    let mut cancel = lease.cancel.subscribe();
    if *cancel.borrow() {
        return Err("The remote instance request was cancelled.".into());
    }
    let (request_key, request_nonce, mut request_cancel) =
        transport.reserve_request(&meta.runtime_key, &meta.request_id)?;
    let result = async {
        let request = lease
            .client
            .request(method, url)
            .headers(headers)
            .body(body);
        let response = tokio::select! {
            result = request.send() => result.map_err(|_| "The remote instance request failed.".to_string())?,
            _ = wait_for_cancel(&mut cancel) => return Err("The remote instance request was cancelled.".into()),
            _ = wait_for_cancel(&mut request_cancel) => return Err("The remote instance request was cancelled.".into()),
        };
        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| match name.as_str() {
                "content-type" | "content-disposition" | "cache-control" | "etag"
                | "last-modified" => value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string())),
                _ => None,
            })
            .collect::<Vec<_>>();
        let body = tokio::select! {
            result = bounded_response(response, MAX_RESPONSE_BODY_BYTES) => result?,
            _ = wait_for_cancel(&mut cancel) => return Err("The remote instance request was cancelled.".into()),
            _ = wait_for_cancel(&mut request_cancel) => return Err("The remote instance request was cancelled.".into()),
        };
        if contains_secret(&body, &lease.secret)
            || headers.iter().any(|(name, value)| {
                contains_secret(name.as_bytes(), &lease.secret)
                    || contains_secret(value.as_bytes(), &lease.secret)
            })
        {
            return Err("The remote instance returned unsafe credential data.".into());
        }
        encode_http_response(
            &NativeHttpResponseMeta {
                status: status.as_u16(),
                status_text,
                headers,
                body_length: body.len(),
            },
            &body,
        )
    }
    .await;
    transport.remove_request(&request_key, request_nonce);
    result
}

#[tauri::command]
pub(crate) fn remote_http_cancel(
    transport: State<'_, RemoteTransport>,
    runtime_key: String,
    request_id: String,
) -> Result<(), String> {
    valid_identifier(&runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    valid_identifier(&request_id, 100, "request")?;
    let key = format!("{}:{}:{}", runtime_key.len(), runtime_key, request_id);
    if let Some(entry) = transport.inner.requests.lock().unwrap().remove(&key) {
        entry.cancel.send_replace(true);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_transport_close(
    transport: State<'_, RemoteTransport>,
    runtime_key: String,
) -> Result<(), String> {
    valid_identifier(&runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    transport.close_runtime(&runtime_key).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_ui_open(
    transport: State<'_, RemoteTransport>,
    runtime_key: String,
    socket_id: String,
    on_event: Channel<NativeUiEvent>,
) -> Result<(), String> {
    valid_identifier(&runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    let lease = transport.runtime(&runtime_key)?;
    let (sender, receiver) = mpsc::channel(32);
    let (socket_key, nonce, socket_cancel) =
        transport.reserve_socket(&runtime_key, &socket_id, sender)?;
    let state = transport.inner.clone();
    tauri::async_runtime::spawn(async move {
        run_socket(
            socket_key.clone(),
            nonce,
            lease,
            receiver,
            socket_cancel,
            on_event,
        )
        .await;
        RemoteTransport { inner: state }.remove_socket(&socket_key, nonce);
    });
    Ok(())
}

async fn run_socket(
    _socket_key: String,
    _nonce: u64,
    lease: RuntimeLease,
    mut commands: mpsc::Receiver<SocketCommand>,
    mut socket_cancel: watch::Receiver<bool>,
    on_event: Channel<NativeUiEvent>,
) {
    let mut runtime_cancel = lease.cancel.subscribe();
    if *runtime_cancel.borrow() || *socket_cancel.borrow() {
        return;
    }
    let identity_result = tokio::select! {
        result = probe_request(
            &lease.client,
            &lease.profile_origin,
            "/api/instance",
            Some(&lease.secret),
        ) => result,
        _ = wait_for_cancel(&mut runtime_cancel) => return,
        _ = wait_for_cancel(&mut socket_cancel) => return,
    };
    let identity = match identity_result {
        Ok((status, body)) if status.is_success() => {
            serde_json::from_slice::<ControlPlaneInstanceInfo>(&body)
                .ok()
                .filter(|info| crate::instances::validate_discovery(info).is_ok())
                .filter(|info| info.instance_id == lease.server_instance_id)
        }
        _ => None,
    };
    if identity.is_none() {
        let _ = on_event.send(NativeUiEvent::Close { code: 1008 });
        return;
    }
    let request = match websocket_request(&lease.profile_origin, &lease.secret) {
        Ok(request) => request,
        Err(_) => {
            let _ = on_event.send(NativeUiEvent::Error);
            let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
            return;
        }
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_UI_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_UI_MESSAGE_BYTES));
    let connected = tokio::select! {
        result = connect_websocket(&lease.profile_origin, request, config) => result,
        _ = wait_for_cancel(&mut runtime_cancel) => return,
        _ = wait_for_cancel(&mut socket_cancel) => return,
    };
    let mut socket = match connected {
        Ok(value) => value,
        Err(NativeWebSocketError::Authentication) => {
            let _ = on_event.send(NativeUiEvent::Close { code: 1008 });
            return;
        }
        Err(_) => {
            let _ = on_event.send(NativeUiEvent::Error);
            let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
            return;
        }
    };
    let _ = on_event.send(NativeUiEvent::Open);
    loop {
        tokio::select! {
            _ = wait_for_cancel(&mut runtime_cancel) => {
                let _ = socket.close(None).await;
                let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
                return;
            }
            _ = wait_for_cancel(&mut socket_cancel) => {
                let _ = socket.close(None).await;
                let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
                return;
            }
            command = commands.recv() => match command {
                Some(SocketCommand::Send(data)) => {
                    if data.len() > MAX_UI_SEND_BYTES || socket.send(Message::Text(data.into())).await.is_err() {
                        let _ = on_event.send(NativeUiEvent::Error);
                        let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
                        return;
                    }
                }
                None => {
                    let _ = socket.close(None).await;
                    return;
                }
            },
            message = socket.next() => match message {
                Some(Ok(Message::Text(data))) => {
                    if contains_secret(data.as_bytes(), &lease.secret) {
                        let _ = on_event.send(NativeUiEvent::Close { code: 1008 });
                        let _ = socket.close(None).await;
                        return;
                    }
                    if on_event.send(NativeUiEvent::Message { data: data.to_string() }).is_err() {
                        return;
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    let code = frame.map(|frame| u16::from(frame.code)).unwrap_or(1000);
                    let _ = on_event.send(NativeUiEvent::Close { code });
                    return;
                }
                Some(Ok(Message::Ping(data))) => {
                    if socket.send(Message::Pong(data)).await.is_err() {
                        let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
                        return;
                    }
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(_)) => {
                    let _ = on_event.send(NativeUiEvent::Close { code: 1003 });
                    let _ = socket.close(None).await;
                    return;
                }
                Some(Err(_)) | None => {
                    let _ = on_event.send(NativeUiEvent::Error);
                    let _ = on_event.send(NativeUiEvent::Close { code: 1006 });
                    return;
                }
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn remote_ui_send(
    transport: State<'_, RemoteTransport>,
    runtime_key: String,
    socket_id: String,
    data: String,
) -> Result<(), String> {
    valid_identifier(&runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    valid_identifier(&socket_id, 100, "socket")?;
    if data.len() > MAX_UI_SEND_BYTES {
        return Err("The remote UI message is too large.".into());
    }
    let key = format!("{}:{}:{}", runtime_key.len(), runtime_key, socket_id);
    let sender = transport
        .inner
        .sockets
        .lock()
        .unwrap()
        .get(&key)
        .filter(|entry| entry.runtime_key == runtime_key)
        .map(|entry| entry.sender.clone())
        .ok_or_else(|| "The remote UI socket is closed.".to_string())?;
    sender
        .send(SocketCommand::Send(data))
        .await
        .map_err(|_| "The remote UI socket is closed.".to_string())
}

#[tauri::command]
pub(crate) async fn remote_ui_close(
    transport: State<'_, RemoteTransport>,
    runtime_key: String,
    socket_id: String,
) -> Result<(), String> {
    valid_identifier(&runtime_key, MAX_RUNTIME_KEY_BYTES, "runtime")?;
    valid_identifier(&socket_id, 100, "socket")?;
    let key = format!("{}:{}:{}", runtime_key.len(), runtime_key, socket_id);
    let cancel = transport
        .inner
        .sockets
        .lock()
        .unwrap()
        .remove(&key)
        .filter(|entry| entry.runtime_key == runtime_key)
        .map(|entry| entry.cancel);
    if let Some(cancel) = cancel {
        cancel.send_replace(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    use super::*;

    fn test_lease(profile_id: &str, origin: &str) -> RuntimeLease {
        let (cancel, _) = watch::channel(false);
        RuntimeLease {
            profile_id: profile_id.to_string(),
            profile_origin: canonical_remote_origin(origin).unwrap(),
            server_instance_id: Uuid::new_v4().to_string(),
            client: hardened_client(None).unwrap(),
            secret: Arc::new(SecretString::from("abcdefghijklmnop".to_string())),
            cancel,
        }
    }

    fn http_response(status: &str, body: &str, extra_headers: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra_headers}\r\n{body}",
            body.len()
        )
    }

    fn serve(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0_u8; 1024];
                loop {
                    let count = stream.read(&mut chunk).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                stream.write_all(response.as_bytes()).unwrap();
            }
            requests
        });
        (origin, handle)
    }

    #[test]
    fn remote_paths_and_methods_are_strict() {
        assert_eq!(method("PATCH").unwrap(), Method::PATCH);
        assert!(method("HEAD").is_err());
        assert_eq!(
            remote_url("https://example.test", "/api/sessions?limit=2")
                .unwrap()
                .as_str(),
            "https://example.test/api/sessions?limit=2"
        );
        for path in [
            "api/sessions",
            "//example.test/api/sessions",
            "/healthz",
            "/api/../admin",
            "/api/%2e%2e/admin",
            "/api/a%2fb",
            "/api/a%5cb",
            "/api/sessions#secret",
        ] {
            assert!(remote_url("https://example.test", path).is_err(), "{path}");
        }
    }

    #[test]
    fn request_headers_reject_credential_and_hop_by_hop_input() {
        let accepted = request_headers(&[
            ("content-type".into(), "application/json".into()),
            ("accept".into(), "application/json".into()),
        ])
        .unwrap();
        assert_eq!(accepted.len(), 2);
        for name in [
            "authorization",
            "cookie",
            "host",
            "proxy-authorization",
            "connection",
        ] {
            assert!(
                request_headers(&[(name.into(), "value".into())]).is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn raw_http_frames_round_trip_binary_without_json_arrays() {
        let body = vec![0, 1, 2, 254, 255];
        let response = NativeHttpResponseMeta {
            status: 200,
            status_text: "OK".into(),
            headers: vec![("content-type".into(), "application/octet-stream".into())],
            body_length: body.len(),
        };
        let frame = encode_http_response_frame(&response, &body).unwrap();
        let meta_length = u32::from_le_bytes(frame[0..4].try_into().unwrap()) as usize;
        let decoded: NativeHttpResponseMeta =
            serde_json::from_slice(&frame[4..4 + meta_length]).unwrap();
        assert_eq!(decoded.body_length, body.len());
        assert_eq!(&frame[4 + meta_length..], body);
    }

    #[test]
    fn browser_arguments_cannot_retarget_a_runtime() {
        let transport = RemoteTransport::default();
        let lease = test_lease(&Uuid::new_v4().to_string(), "https://a.example.test");
        transport
            .insert_runtime("runtime-a".into(), lease.clone())
            .unwrap();
        assert!(transport.insert_runtime("runtime-a".into(), lease).is_err());
        assert_eq!(
            transport
                .runtime("runtime-a")
                .unwrap()
                .profile_origin
                .origin,
            "https://a.example.test"
        );
        assert!(transport.runtime("runtime-b").is_err());
    }

    #[tokio::test]
    async fn closing_one_profile_cannot_cancel_or_retarget_another_profile() {
        let transport = RemoteTransport::default();
        let profile_a = Uuid::new_v4().to_string();
        let profile_b = Uuid::new_v4().to_string();
        transport
            .insert_runtime(
                "runtime-a".into(),
                test_lease(&profile_a, "https://a.example.test"),
            )
            .unwrap();
        transport
            .insert_runtime(
                "runtime-b".into(),
                test_lease(&profile_b, "https://b.example.test"),
            )
            .unwrap();
        let (sender_a, _) = mpsc::channel(1);
        let (_, _, socket_cancel_a) = transport
            .reserve_socket("runtime-a", "socket-1", sender_a)
            .unwrap();
        let (sender_b, _) = mpsc::channel(1);
        let (_, _, socket_cancel_b) = transport
            .reserve_socket("runtime-b", "socket-1", sender_b)
            .unwrap();
        let (_, _, request_cancel_a) = transport.reserve_request("runtime-a", "request-1").unwrap();
        let (_, _, request_cancel_b) = transport.reserve_request("runtime-b", "request-1").unwrap();

        transport.close_profile(&profile_a).await;

        assert!(transport.runtime("runtime-a").is_err());
        assert_eq!(
            transport
                .runtime("runtime-b")
                .unwrap()
                .profile_origin
                .origin,
            "https://b.example.test"
        );
        assert!(*socket_cancel_a.borrow());
        assert!(!*socket_cancel_b.borrow());
        assert!(*request_cancel_a.borrow());
        assert!(!*request_cancel_b.borrow());
        assert!(transport
            .inner
            .sockets
            .lock()
            .unwrap()
            .contains_key("9:runtime-b:socket-1"));
        assert!(transport
            .inner
            .requests
            .lock()
            .unwrap()
            .contains_key("9:runtime-b:request-1"));
    }

    #[tokio::test]
    async fn closing_a_profile_notifies_an_already_open_socket() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let instance_id = Uuid::new_v4().to_string();
        let identity = serde_json::json!({
            "service": LEGACY_CONTROL_PLANE_SERVICE,
            "instanceId": instance_id,
            "displayName": "Remote",
            "apiVersion": 1,
            "appVersion": "0.9.0",
            "capabilities": ["remote-instance-v1"]
        })
        .to_string();
        let server_identity = identity.clone();
        let server = tokio::spawn(async move {
            let (mut probe, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 1024];
            loop {
                let count = probe.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            probe
                .write_all(http_response("200 OK", &server_identity, "").as_bytes())
                .await
                .unwrap();
            probe.shutdown().await.unwrap();

            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let _ = socket.next().await;
        });

        let profile_id = Uuid::new_v4().to_string();
        let (cancel, _) = watch::channel(false);
        let lease = RuntimeLease {
            profile_id: profile_id.clone(),
            profile_origin: canonical_remote_origin(&format!("http://{address}")).unwrap(),
            server_instance_id: instance_id,
            client: hardened_client(None).unwrap(),
            secret: Arc::new(SecretString::from("abcdefghijklmnop".to_string())),
            cancel,
        };
        let transport = RemoteTransport::default();
        transport
            .insert_runtime("runtime-open".into(), lease.clone())
            .unwrap();
        let (_commands, receiver) = mpsc::channel(1);
        let (_socket_cancel, socket_cancel) = watch::channel(false);
        let (event_sender, mut events) = tokio::sync::mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            let event: serde_json::Value = body.deserialize()?;
            let _ = event_sender.send(event);
            Ok(())
        });
        let task = tokio::spawn(run_socket(
            "socket-open".into(),
            1,
            lease,
            receiver,
            socket_cancel,
            channel,
        ));

        let opened = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(opened["type"], "open");
        transport.close_profile(&profile_id).await;
        let closed = tokio::time::timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed["type"], "close");
        assert_eq!(closed["code"], 1006);
        task.await.unwrap();
        server.await.unwrap();
    }

    #[test]
    fn tailscale_route_verification_requires_a_connected_local_ip_and_exact_peer() {
        let status = serde_json::json!({
            "Self": { "TailscaleIPs": ["100.70.0.1", "fd7a:115c:a1e0::1"] },
            "Peer": {
                "node": { "TailscaleIPs": ["100.70.0.2"] }
            }
        });
        assert_eq!(
            tailscale_route_from_status(&status, "100.70.0.2".parse().unwrap()).unwrap(),
            "100.70.0.1".parse::<IpAddr>().unwrap()
        );
        assert!(tailscale_route_from_status(&status, "100.70.0.3".parse().unwrap()).is_err());
        assert!(
            tailscale_route_from_status(&serde_json::json!({}), "100.70.0.2".parse().unwrap())
                .is_err()
        );
    }

    #[test]
    fn credential_echo_detection_is_exact_and_content_agnostic() {
        let secret = SecretString::from("sentinel-pairing-token".to_string());
        assert!(contains_secret(
            b"prefix sentinel-pairing-token suffix",
            &secret
        ));
        assert!(!contains_secret(b"ordinary response", &secret));
    }

    #[test]
    fn remote_open_failures_expose_stable_recovery_codes() {
        assert_eq!(
            probe_open_error("The pairing token was rejected. Generate a new pairing link.".into())
                .code,
            "authentication-required"
        );
        assert_eq!(
            probe_open_error("This Wollipog control plane uses unsupported API version 2.".into())
                .code,
            "incompatible"
        );
        assert_eq!(
            probe_open_error("Could not connect to the remote Wollipog instance.".into()).code,
            "offline"
        );
    }

    #[test]
    fn remote_open_fence_rejects_stable_profile_and_credential_changes() {
        let profile = InstanceProfile {
            id: Uuid::new_v4().to_string(),
            server_instance_id: Uuid::new_v4().to_string(),
            kind: crate::instances::InstanceKind::Remote,
            label: "Remote".into(),
            origin: "https://example.test".into(),
            created_at: "2026-07-29T18:00:00.000Z".into(),
            last_connected_at: None,
        };
        let expected = profile.clone();
        let original_secret = SecretString::from("original-pairing-token".to_string());
        let rotated_secret = SecretString::from("rotated-pairing-token".to_string());

        let mut activity_only = profile.clone();
        activity_only.last_connected_at = Some("2026-07-29T18:01:00.000Z".into());
        assert!(validate_remote_open_fence(
            &activity_only,
            &expected,
            &original_secret,
            &original_secret
        )
        .is_ok());

        let credential_error = validate_remote_open_fence(
            &activity_only,
            &expected,
            &rotated_secret,
            &original_secret,
        )
        .unwrap_err();
        assert_eq!(credential_error.code, "profile-changed");

        let mut changed = activity_only;
        changed.origin = "https://changed.example.test".into();
        let profile_error =
            validate_remote_open_fence(&changed, &expected, &original_secret, &original_secret)
                .unwrap_err();
        assert_eq!(profile_error.code, "profile-changed");
    }

    #[test]
    fn websocket_handshake_keeps_the_bearer_out_of_the_url_and_marks_it_sensitive() {
        let endpoint = canonical_remote_origin("https://example.test:4317").unwrap();
        let secret = SecretString::from("sentinel-pairing-token".to_string());
        let request = websocket_request(&endpoint, &secret).unwrap();
        assert_eq!(request.uri().to_string(), "wss://example.test:4317/ui");
        assert!(!request.uri().to_string().contains("sentinel"));
        let authorization = request.headers().get(AUTHORIZATION).unwrap();
        assert_eq!(authorization, "Bearer sentinel-pairing-token");
        assert!(authorization.is_sensitive());
        assert!(!format!("{request:?}").contains("sentinel-pairing-token"));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn websocket_transport_uses_bearer_headers_and_round_trips_text() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (captured, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut captured = Some(captured);
            let mut socket = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                      response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    let authorization = request
                        .headers()
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    captured
                        .take()
                        .unwrap()
                        .send((request.uri().to_string(), authorization))
                        .unwrap();
                    Ok(response)
                },
            )
            .await
            .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().to_text().unwrap(),
                "hello"
            );
            socket.send(Message::Text("world".into())).await.unwrap();
        });
        let endpoint = canonical_remote_origin(&format!("http://{address}")).unwrap();
        let secret = SecretString::from("sentinel-pairing-token".to_string());
        let request = websocket_request(&endpoint, &secret).unwrap();
        let mut socket = connect_websocket(&endpoint, request, WebSocketConfig::default())
            .await
            .unwrap();
        socket.send(Message::Text("hello".into())).await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().to_text().unwrap(),
            "world"
        );
        let (uri, authorization) = received.await.unwrap();
        assert_eq!(uri, "/ui");
        assert_eq!(authorization, "Bearer sentinel-pairing-token");
        assert!(!uri.contains("sentinel"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_handshake_timeout_is_bounded() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let endpoint = canonical_remote_origin(&format!("http://{address}")).unwrap();
        let secret = SecretString::from("sentinel-pairing-token".to_string());
        let started = Instant::now();
        assert!(connect_websocket(
            &endpoint,
            websocket_request(&endpoint, &secret).unwrap(),
            WebSocketConfig::default(),
        )
        .await
        .is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        server.abort();
    }

    #[tokio::test]
    async fn cleartext_socket_connector_enforces_and_binds_the_verified_source_address() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        assert!(connect_bound_tcp("192.0.2.1".parse().unwrap(), target)
            .await
            .is_err());
        let accepted = tokio::spawn(async move { listener.accept().await.unwrap().1 });
        let stream = connect_bound_tcp("127.0.0.1".parse().unwrap(), target)
            .await
            .unwrap();
        assert_eq!(
            stream.local_addr().unwrap().ip(),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
        assert_eq!(
            accepted.await.unwrap().ip(),
            "127.0.0.1".parse::<IpAddr>().unwrap()
        );
    }

    #[test]
    fn native_socket_registry_is_bounded_and_replacement_safe() {
        let transport = RemoteTransport::default();
        let mut first = None;
        for index in 0..MAX_SOCKET_ATTEMPTS {
            let (sender, _receiver) = mpsc::channel(1);
            let reservation = transport
                .reserve_socket("runtime", &format!("socket-{index}"), sender)
                .unwrap();
            if index == 0 {
                first = Some(reservation);
            }
        }
        let (overflow, _receiver) = mpsc::channel(1);
        assert!(transport
            .reserve_socket("runtime", "overflow", overflow)
            .is_err());
        let (replacement, _receiver) = mpsc::channel(1);
        let replacement = transport
            .reserve_socket("runtime", "socket-0", replacement)
            .unwrap();
        let (old_key, old_nonce, old_cancel) = first.unwrap();
        let (new_key, new_nonce, _) = replacement;
        assert_eq!(old_key, new_key);
        assert!(*old_cancel.borrow());
        transport.remove_socket(&old_key, old_nonce);
        assert!(transport
            .inner
            .sockets
            .lock()
            .unwrap()
            .contains_key(&new_key));
        assert_eq!(
            transport.inner.sockets.lock().unwrap().len(),
            MAX_SOCKET_ATTEMPTS
        );
        transport.remove_socket(&new_key, new_nonce);
    }

    #[test]
    fn native_request_registry_is_bounded_and_nonce_fenced() {
        let transport = RemoteTransport::default();
        let mut first = None;
        for index in 0..MAX_IN_FLIGHT_REQUESTS {
            let reservation = transport
                .reserve_request("runtime", &format!("request-{index}"))
                .unwrap();
            if index == 0 {
                first = Some(reservation);
            }
        }
        assert!(transport.reserve_request("runtime", "overflow").is_err());
        let (old_key, old_nonce, _) = first.unwrap();
        let (new_key, new_nonce, _) = transport.reserve_request("runtime", "request-0").unwrap();
        assert_eq!(old_key, new_key);
        transport.remove_request(&old_key, old_nonce);
        assert!(transport
            .inner
            .requests
            .lock()
            .unwrap()
            .contains_key(&new_key));
        transport.remove_request(&new_key, new_nonce);
        assert!(!transport
            .inner
            .requests
            .lock()
            .unwrap()
            .contains_key(&new_key));
    }

    #[test]
    fn late_subscribers_observe_runtime_cancellation() {
        let (cancel, receiver) = watch::channel(false);
        drop(receiver);
        cancel.send_replace(true);
        let mut late = cancel.subscribe();
        assert!(*late.borrow());
        tauri::async_runtime::block_on(wait_for_cancel(&mut late));
    }

    #[test]
    fn pairing_probe_uses_unauthenticated_health_then_bearer_identity_without_redirects() {
        let instance_id = Uuid::new_v4().to_string();
        let health = serde_json::json!({ "ok": true, "service": WOLLIPOG_CONTROL_PLANE_SERVICE })
            .to_string();
        let identity = serde_json::json!({
            "service": WOLLIPOG_CONTROL_PLANE_SERVICE,
            "instanceId": instance_id,
            "displayName": "Remote",
            "apiVersion": 1,
            "appVersion": "0.9.0",
            "capabilities": ["remote-instance-v1"]
        })
        .to_string();
        let (origin, server) = serve(vec![
            http_response("200 OK", &health, ""),
            http_response("200 OK", &identity, ""),
        ]);
        let endpoint = canonical_remote_origin(&origin).unwrap();
        let secret = SecretString::from("sentinel-pairing-token".to_string());
        let info =
            tauri::async_runtime::block_on(probe_remote_instance(&endpoint, &secret)).unwrap();
        assert_eq!(info.instance_id, instance_id);
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /healthz "));
        assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
        assert!(requests[1].starts_with("GET /api/instance "));
        assert!(requests[1].contains("authorization: Bearer sentinel-pairing-token"));

        let (redirect_origin, redirect_server) = serve(vec![http_response(
            "302 Found",
            "",
            "Location: http://127.0.0.1:9/stolen\r\n",
        )]);
        let redirect_endpoint = canonical_remote_origin(&redirect_origin).unwrap();
        assert!(
            tauri::async_runtime::block_on(probe_remote_instance(&redirect_endpoint, &secret))
                .is_err()
        );
        assert_eq!(redirect_server.join().unwrap().len(), 1);
    }
}
