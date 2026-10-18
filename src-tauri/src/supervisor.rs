use pdfium_protocol::{
    encode, read_u32, read_u64, validate_bitmap, Decoder, Frame, Kind, MAX_IMAGE_BYTES,
    MAX_RESULT_METADATA, OPEN_ACK_LEN,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use tauri::AppHandle;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::{oneshot, Mutex, Notify, Semaphore};

const RENDER_TIMEOUT_DEFAULT_MS: u64 = 30_000;
const SHUTDOWN_GRACE: Duration = Duration::from_millis(2_000);
const MAX_RESTARTS: u8 = 3;

#[derive(Clone)]
pub struct AppState(Arc<Supervisor>);

struct Supervisor {
    app: AppHandle,
    pdfium_path: PathBuf,
    connection: Mutex<Option<Arc<Connection>>>,
    operation: Mutex<()>,
    pending_render_slots: Semaphore,
    active: Mutex<Option<ActiveDocument>>,
    render_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    next_generation: AtomicU64,
    next_request: AtomicU64,
    restart_budget: StdMutex<RestartBudget>,
    exit_started: AtomicBool,
    allow_exit: AtomicBool,
}

#[derive(Clone)]
struct ActiveDocument {
    id: String,
    tab: [u8; 16],
    generation: u64,
    page_count: u32,
}

#[derive(Serialize)]
pub struct OpenDocumentResult {
    pub document_id: String,
    pub generation: u64,
    pub page_count: u32,
    pub page_width_points: f64,
    pub page_height_points: f64,
}

struct Connection {
    child: Arc<StdMutex<Option<Box<dyn ProcessControl>>>>,
    pending: Mutex<HashMap<u64, PendingRequest>>,
    ready: StdMutex<Option<oneshot::Sender<Result<(), String>>>>,
    alive: AtomicBool,
    reaped: ReapGate,
    diagnostics: StdMutex<String>,
}

trait ProcessControl: Send {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String>;
    fn terminate(self: Box<Self>) -> Result<(), String>;
}

struct ShellProcess(CommandChild);
impl ProcessControl for ShellProcess {
    fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
        self.0.write(bytes).map_err(|e| e.to_string())
    }
    fn terminate(self: Box<Self>) -> Result<(), String> {
        self.0.kill().map_err(|e| e.to_string())
    }
}

#[derive(Default)]
struct ReapGate {
    reaped: AtomicBool,
    notify: Notify,
}
impl ReapGate {
    fn mark_reaped(&self) {
        self.reaped.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }
    async fn wait(&self) {
        while !self.reaped.load(Ordering::SeqCst) {
            self.notify.notified().await;
        }
    }
}

struct PendingRequest {
    request_id: u64,
    expected: Kind,
    sender: oneshot::Sender<Result<Frame, String>>,
}

impl AppState {
    pub fn new(app: AppHandle, pdfium_path: PathBuf) -> Self {
        Self(Arc::new(Supervisor {
            app,
            pdfium_path,
            connection: Mutex::new(None),
            operation: Mutex::new(()),
            pending_render_slots: Semaphore::new(2),
            active: Mutex::new(None),
            render_cancellations: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(0),
            next_request: AtomicU64::new(1),
            restart_budget: StdMutex::new(RestartBudget::default()),
            exit_started: AtomicBool::new(false),
            allow_exit: AtomicBool::new(false),
        }))
    }

    pub fn allow_exit(&self) -> bool {
        self.0.allow_exit.load(Ordering::SeqCst)
    }
    pub fn begin_exit(&self) -> bool {
        !self.0.exit_started.swap(true, Ordering::SeqCst)
    }

    pub async fn open_pdf(&self, id: String, path: String) -> Result<OpenDocumentResult, String> {
        let document_path = PathBuf::from(&path);
        validate_local_pdf(&document_path)?;
        let tab = parse_document_id(&id)?;
        self.cancel_all_renders().await;
        let _operation = self.0.operation.lock().await;
        let generation = self
            .0
            .next_generation
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| "document generation exhausted")?
            + 1;
        if let Some(old) = self.0.active.lock().await.take() {
            let mut payload = old.tab.to_vec();
            payload.extend_from_slice(&old.generation.to_be_bytes());
            if let Some(conn) = self.0.connection.lock().await.clone() {
                if conn.alive.load(Ordering::SeqCst) {
                    match conn
                        .request(self.request(Kind::Close, payload)?, Duration::from_secs(2))
                        .await
                    {
                        Ok(reply)
                            if reply.kind == Kind::Ack
                                && reply.payload
                                    == [old.tab.as_slice(), &old.generation.to_be_bytes()]
                                        .concat() => {}
                        Ok(_) => {
                            conn.fail("invalid CLOSE acknowledgement".into()).await;
                            return Err("Worker returned an invalid close acknowledgement".into());
                        }
                        Err(_) if !conn.alive.load(Ordering::SeqCst) => conn.reaped.wait().await,
                        Err(e) => return Err(format!("Could not close previous document: {e}")),
                    }
                } else {
                    conn.reaped.wait().await;
                }
            }
        }
        let conn = self.connection().await?;
        let path_bytes = document_path
            .to_str()
            .ok_or("PDF path is not representable as UTF-8")?
            .as_bytes();
        if path_bytes.len() > 65_536 - 28 {
            return Err("PDF path exceeds the worker protocol limit".into());
        }
        let mut payload = Vec::with_capacity(28 + path_bytes.len());
        payload.extend_from_slice(&tab);
        payload.extend_from_slice(&generation.to_be_bytes());
        payload.extend_from_slice(&(path_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(path_bytes);
        let reply = conn
            .request(self.request(Kind::Open, payload)?, Duration::from_secs(30))
            .await?;
        if reply.kind != Kind::Ack || reply.payload.len() != OPEN_ACK_LEN {
            conn.fail("malformed OPEN acknowledgement".into()).await;
            return Err("Worker returned malformed document metadata".into());
        }
        let reply_tab: [u8; 16] = reply.payload[..16]
            .try_into()
            .map_err(|_| "invalid worker tab id")?;
        let reply_gen = read_u64(&reply.payload, 16).map_err(|e| e.to_string())?;
        let page_count = read_u32(&reply.payload, 24).map_err(|e| e.to_string())?;
        let width = f64::from_be_bytes(
            reply.payload[28..36]
                .try_into()
                .map_err(|_| "invalid page width")?,
        );
        let height = f64::from_be_bytes(
            reply.payload[36..44]
                .try_into()
                .map_err(|_| "invalid page height")?,
        );
        if reply_tab != tab
            || reply_gen != generation
            || page_count == 0
            || !width.is_finite()
            || !height.is_finite()
            || width <= 0.0
            || height <= 0.0
        {
            conn.fail("invalid OPEN metadata fields".into()).await;
            return Err("Worker returned invalid document metadata".into());
        }
        *self.0.active.lock().await = Some(ActiveDocument {
            id: id.clone(),
            tab,
            generation,
            page_count,
        });
        Ok(OpenDocumentResult {
            document_id: id,
            generation,
            page_count,
            page_width_points: width,
            page_height_points: height,
        })
    }

    pub async fn render(
        &self,
        request_token: String,
        id: String,
        generation: u64,
        page_index: u32,
        width: u32,
        height: u32,
        zoom: f64,
    ) -> Result<Vec<u8>, String> {
        if request_token.is_empty() || request_token.len() > 128 {
            return Err("Invalid render cancellation token".into());
        }
        let admission = self
            .0
            .pending_render_slots
            .try_acquire()
            .map_err(|_| "Render queue is full; try again shortly".to_string())?;
        let cancellation = Arc::new(AtomicBool::new(false));
        {
            let mut pending = self.0.render_cancellations.lock().await;
            if pending.contains_key(&request_token) {
                return Err("Duplicate render request token".into());
            }
            pending.insert(request_token.clone(), cancellation.clone());
        }
        let _registration = RenderRegistration {
            state: self.0.clone(),
            token: request_token.clone(),
        };
        let _operation = self.0.operation.lock().await;
        if cancellation.load(Ordering::SeqCst) {
            return Err("Render request was cancelled before dispatch".into());
        }
        let active = self.0.active.lock().await.clone().ok_or("No PDF is open")?;
        if !active_document_matches(Some(&active), &id, generation) {
            return Err("Document changed; render request is stale".into());
        }
        if page_index >= active.page_count {
            return Err("Page index is out of range".into());
        }
        validate_bitmap(width, height).map_err(|e| e.to_string())?;
        if !zoom.is_finite() || !(0.25..=5.0).contains(&zoom) {
            return Err("Zoom must be between 0.25 and 5.0".into());
        }
        let mut payload = Vec::with_capacity(48);
        payload.extend_from_slice(&active.tab);
        payload.extend_from_slice(&generation.to_be_bytes());
        payload.extend_from_slice(&page_index.to_be_bytes());
        payload.extend_from_slice(&zoom.to_be_bytes());
        payload.extend_from_slice(&width.to_be_bytes());
        payload.extend_from_slice(&height.to_be_bytes());
        payload.push(0);
        payload.extend_from_slice(&[0, 0, 0]);
        let conn = self.connection().await?;
        if !active_document_matches(self.0.active.lock().await.as_ref(), &id, generation) {
            return Err("Document changed before render dispatch".into());
        }
        drop(admission);
        let timeout = render_timeout();
        let reply = match conn
            .request(self.request(Kind::Render, payload)?, timeout)
            .await
        {
            Ok(reply) => reply,
            Err(error) => {
                if !conn.alive.load(Ordering::SeqCst) {
                    self.0.active.lock().await.take();
                }
                return Err(error);
            }
        };
        if cancellation.load(Ordering::SeqCst) {
            return Err("Render result arrived after cancellation and was discarded".into());
        }
        if reply.kind != Kind::Page
            || reply.payload.len() < 42
            || reply.payload.len() > MAX_IMAGE_BYTES + MAX_RESULT_METADATA
        {
            conn.fail("malformed or oversized PAGE response".into())
                .await;
            return Err("Worker returned an invalid page response".into());
        }
        let response_tab: [u8; 16] = reply.payload[..16]
            .try_into()
            .map_err(|_| "invalid page tab id")?;
        let response_generation = read_u64(&reply.payload, 16).map_err(|e| e.to_string())?;
        let response_page = read_u32(&reply.payload, 24).map_err(|e| e.to_string())?;
        let bitmap_width = read_u32(&reply.payload, 28).map_err(|e| e.to_string())?;
        let bitmap_height = read_u32(&reply.payload, 32).map_err(|e| e.to_string())?;
        let content_type = u16::from_be_bytes(
            reply.payload[36..38]
                .try_into()
                .map_err(|_| "invalid page content type")?,
        );
        let image_len = read_u32(&reply.payload, 38).map_err(|e| e.to_string())? as usize;
        validate_bitmap(bitmap_width, bitmap_height).map_err(|e| e.to_string())?;
        if response_tab != active.tab
            || response_generation != generation
            || response_page != page_index
            || content_type != 1
            || image_len == 0
            || image_len > MAX_IMAGE_BYTES
            || reply.payload.len()
                != 42usize
                    .checked_add(image_len)
                    .ok_or("response length overflow")?
            || reply.payload.get(42..46) != Some(&[0x89, 0x50, 0x4e, 0x47])
        {
            conn.fail("PAGE metadata did not match the request".into())
                .await;
            return Err("Worker page metadata did not match the current document".into());
        }
        let still_active = self
            .0
            .active
            .lock()
            .await
            .as_ref()
            .is_some_and(|d| d.id == id && d.generation == generation);
        if !still_active {
            return Err("Document changed while rendering; result discarded".into());
        }
        encode(&reply).map_err(|e| format!("could not encode bounded IPC response: {e}"))
    }

    pub async fn cancel_render(&self, request_token: String) -> bool {
        if request_token.is_empty() || request_token.len() > 128 {
            return false;
        }
        if let Some(token) = self.0.render_cancellations.lock().await.get(&request_token) {
            token.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub async fn close_document(&self, id: String, generation: u64) -> Result<(), String> {
        self.cancel_all_renders().await;
        let _operation = self.0.operation.lock().await;
        let Some(active) = self.0.active.lock().await.take() else {
            return Ok(());
        };
        if active.id != id || active.generation != generation {
            *self.0.active.lock().await = Some(active);
            return Ok(());
        }
        let mut payload = active.tab.to_vec();
        payload.extend_from_slice(&generation.to_be_bytes());
        let Some(conn) = self.0.connection.lock().await.clone() else {
            return Ok(());
        };
        if !conn.alive.load(Ordering::SeqCst) {
            conn.reaped.wait().await;
            return Ok(());
        }
        let reply = conn
            .request(
                self.request(Kind::Close, payload.clone())?,
                Duration::from_secs(2),
            )
            .await?;
        if reply.kind != Kind::Ack || reply.payload != payload {
            conn.fail("invalid CLOSE acknowledgement".into()).await;
            return Err("Worker did not acknowledge document closure".into());
        }
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.cancel_all_renders().await;
        let _operation = self.0.operation.lock().await;
        if let Some(active) = self.0.active.lock().await.take() {
            let mut payload = active.tab.to_vec();
            payload.extend_from_slice(&active.generation.to_be_bytes());
            if let Some(conn) = self
                .0
                .connection
                .lock()
                .await
                .clone()
                .filter(|conn| conn.alive.load(Ordering::SeqCst))
            {
                let _ = conn
                    .request(
                        self.request(Kind::Close, payload).unwrap(),
                        Duration::from_millis(500),
                    )
                    .await;
            }
        }
        let conn = self.0.connection.lock().await.take();
        if let Some(conn) = conn {
            let start = tokio::time::Instant::now();
            if conn.alive.load(Ordering::SeqCst) {
                if let Ok(frame) = self.request(Kind::Shutdown, Vec::new()) {
                    let _ = conn.request(frame, Duration::from_millis(1_200)).await;
                }
                let remaining = SHUTDOWN_GRACE.saturating_sub(start.elapsed());
                if tokio::time::timeout(remaining, conn.reaped.wait())
                    .await
                    .is_err()
                {
                    conn.kill().await;
                }
            } else {
                conn.reaped.wait().await;
            }
        }
        self.0.allow_exit.store(true, Ordering::SeqCst);
    }

    fn request(&self, kind: Kind, payload: Vec<u8>) -> Result<Frame, String> {
        let id = self
            .0
            .next_request
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .map_err(|_| "Worker request id space exhausted")?;
        Ok(Frame {
            kind,
            request_id: id,
            payload,
        })
    }

    async fn cancel_all_renders(&self) {
        for token in self.0.render_cancellations.lock().await.values() {
            token.store(true, Ordering::SeqCst);
        }
    }

    async fn connection(&self) -> Result<Arc<Connection>, String> {
        let mut guard = self.0.connection.lock().await;
        if let Some(conn) = guard.as_ref() {
            if conn.alive.load(Ordering::SeqCst) {
                return Ok(conn.clone());
            }
            let old = conn.clone();
            old.reaped.wait().await;
            *guard = None;
            self.0.active.lock().await.take();
        }
        if !self
            .0
            .restart_budget
            .lock()
            .map_err(|_| "worker restart budget lock poisoned")?
            .reserve_start()
        {
            return Err(
                "PDF worker restart limit reached; close and reopen the application".into(),
            );
        }
        let app = self.0.app.clone();
        let dll_path = self.0.pdfium_path.clone();
        let (mut receiver, child) = tauri::async_runtime::spawn_blocking(move || {
            app.shell()
                .sidecar("pdfium-worker")
                .map_err(|e| format!("Could not locate the packaged PDF worker: {e}"))?
                .args(["--serve", "--pdfium-path"])
                .arg(dll_path.as_os_str())
                .set_raw_out(true)
                .spawn()
                .map_err(|e| format!("Could not start PDF worker sidecar: {e}"))
        })
        .await
        .map_err(|e| format!("worker startup task failed: {e}"))??;
        let (ready_tx, ready_rx) = oneshot::channel();
        let conn = Arc::new(Connection {
            child: Arc::new(StdMutex::new(Some(Box::new(ShellProcess(child))))),
            pending: Mutex::new(HashMap::new()),
            ready: StdMutex::new(Some(ready_tx)),
            alive: AtomicBool::new(true),
            reaped: ReapGate::default(),
            diagnostics: StdMutex::new(String::new()),
        });
        let reader_conn = conn.clone();
        tauri::async_runtime::spawn(async move {
            let mut decoder = Decoder::new();
            while let Some(event) = receiver.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => match decoder.push(&bytes) {
                        Ok(frames) => {
                            for frame in frames {
                                if frame.kind == Kind::Ready && frame.request_id == 0 {
                                    if let Some(tx) =
                                        reader_conn.ready.lock().ok().and_then(|mut x| x.take())
                                    {
                                        let _ = tx.send(Ok(()));
                                    } else {
                                        reader_conn
                                            .fail("worker sent duplicate READY frame".into())
                                            .await;
                                        break;
                                    }
                                    continue;
                                }
                                let pending =
                                    reader_conn.pending.lock().await.remove(&frame.request_id);
                                if let Some(pending) = pending {
                                    if reply_matches(pending.request_id, pending.expected, &frame) {
                                        let _ = pending.sender.send(Ok(frame));
                                    } else {
                                        let _ = pending.sender.send(Err(
                                            "worker response kind did not match the request".into(),
                                        ));
                                        reader_conn
                                            .fail(
                                                "worker response kind did not match the request"
                                                    .into(),
                                            )
                                            .await;
                                        break;
                                    }
                                } else {
                                    reader_conn
                                        .fail(
                                            "worker sent an unknown or duplicate request id".into(),
                                        )
                                        .await;
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            reader_conn.fail(format!("invalid worker frame: {e}")).await;
                            break;
                        }
                    },
                    CommandEvent::Stderr(bytes) => {
                        let message = String::from_utf8_lossy(&bytes);
                        if let Ok(mut log) = reader_conn.diagnostics.lock() {
                            log.push_str(&message);
                            if log.len() > 4096 {
                                let excess = log.len() - 4096;
                                log.drain(..excess);
                            }
                        }
                    }
                    CommandEvent::Error(error) => {
                        reader_conn
                            .fail(format!("worker pipe error: {error}"))
                            .await;
                        break;
                    }
                    CommandEvent::Terminated(payload) => {
                        reader_conn.alive.store(false, Ordering::SeqCst);
                        let details = reader_conn
                            .diagnostics
                            .lock()
                            .map(|s| s.clone())
                            .unwrap_or_default();
                        reader_conn
                            .fail(format!(
                                "worker exited with code {:?}; {}",
                                payload.code, details
                            ))
                            .await;
                        reader_conn.reaped.mark_reaped();
                        if let Some(tx) = reader_conn.ready.lock().ok().and_then(|mut x| x.take()) {
                            let _ = tx.send(Err("worker exited before READY".into()));
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        match tokio::time::timeout(Duration::from_secs(10), ready_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => return Err("worker startup channel closed".into()),
            Err(_) => {
                conn.kill().await;
                return Err("worker startup timed out waiting for READY".into());
            }
        }
        *guard = Some(conn.clone());
        Ok(conn)
    }
}

struct RenderRegistration {
    state: Arc<Supervisor>,
    token: String,
}
impl Drop for RenderRegistration {
    fn drop(&mut self) {
        let state = self.state.clone();
        let token = self.token.clone();
        tauri::async_runtime::spawn(async move {
            state.render_cancellations.lock().await.remove(&token);
        });
    }
}

impl Connection {
    async fn request(self: &Arc<Self>, frame: Frame, timeout: Duration) -> Result<Frame, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("PDF worker is not running".into());
        }
        let id = frame.request_id;
        let (tx, rx) = oneshot::channel();
        let expected =
            expected_reply(frame.kind).ok_or_else(|| "invalid host request kind".to_string())?;
        self.pending.lock().await.insert(
            id,
            PendingRequest {
                request_id: id,
                expected,
                sender: tx,
            },
        );
        let bytes = encode(&frame).map_err(|e| e.to_string())?;
        let child = self.child.clone();
        let write_result = tauri::async_runtime::spawn_blocking(move || {
            let mut child = child.lock().map_err(|_| "worker child lock poisoned")?;
            child
                .as_mut()
                .ok_or("worker child was already reaped")?
                .write(&bytes)
        })
        .await
        .map_err(|e| format!("worker write task failed: {e}"))?;
        if let Err(error) = write_result {
            self.pending.lock().await.remove(&id);
            self.fail(format!("worker stdin write failed: {error}"))
                .await;
            return Err(error);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(frame))) => {
                if frame.request_id == id {
                    if frame.kind == Kind::Error {
                        Err(decode_worker_error(&frame.payload))
                    } else {
                        Ok(frame)
                    }
                } else {
                    self.fail("worker response correlation mismatch".into())
                        .await;
                    Err("worker response correlation mismatch".into())
                }
            }
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err("worker response channel closed".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                self.fail("worker request timed out; terminating worker".into())
                    .await;
                Err("PDF worker request timed out".into())
            }
        }
    }

    async fn fail(&self, error: String) {
        self.alive.store(false, Ordering::SeqCst);
        if let Ok(mut ready) = self.ready.lock() {
            if let Some(tx) = ready.take() {
                let _ = tx.send(Err(error.clone()));
            }
        }
        let mut pending = self.pending.lock().await;
        for (_, request) in pending.drain() {
            let _ = request.sender.send(Err(error.clone()));
        }
        drop(pending);
        self.kill().await;
    }

    async fn kill(&self) {
        let child = self.child.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let child = child.lock().ok().and_then(|mut slot| slot.take());
            if let Some(child) = child {
                child.terminate()
            } else {
                Ok(())
            }
        })
        .await;
        if let Err(error) = result {
            eprintln!("worker termination task failed: {error}");
        }
        self.alive.store(false, Ordering::SeqCst);
        self.reaped.mark_reaped();
    }
}

fn expected_reply(kind: Kind) -> Option<Kind> {
    match kind {
        Kind::Open | Kind::Close | Kind::Shutdown => Some(Kind::Ack),
        Kind::Render => Some(Kind::Page),
        _ => None,
    }
}

fn reply_matches(request_id: u64, expected: Kind, frame: &Frame) -> bool {
    frame.request_id == request_id && (frame.kind == expected || frame.kind == Kind::Error)
}

fn active_document_matches(active: Option<&ActiveDocument>, id: &str, generation: u64) -> bool {
    active.is_some_and(|active| active.id == id && active.generation == generation)
}

#[derive(Default)]
struct RestartBudget {
    started: bool,
    restarts: u8,
}
impl RestartBudget {
    fn reserve_start(&mut self) -> bool {
        if !self.started {
            self.started = true;
            return true;
        }
        if self.restarts >= MAX_RESTARTS {
            return false;
        }
        self.restarts += 1;
        true
    }
}

fn decode_worker_error(payload: &[u8]) -> String {
    if payload.len() < 4 {
        return "PDF worker returned a malformed error response".into();
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    let length = u16::from_be_bytes([payload[2], payload[3]]) as usize;
    if length > 4096 || payload.len() != 4 + length {
        return "PDF worker returned a malformed error response".into();
    }
    let detail =
        std::str::from_utf8(&payload[4..]).unwrap_or("Worker error text was not valid UTF-8");
    format!("PDF worker error {code}: {detail}")
}

fn render_timeout() -> Duration {
    let value = std::env::var("PDFIUM_RENDER_TIMEOUT_MS")
        .ok()
        .and_then(|x| x.parse::<u64>().ok())
        .unwrap_or(RENDER_TIMEOUT_DEFAULT_MS)
        .clamp(1_000, 120_000);
    Duration::from_millis(value)
}

fn parse_document_id(value: &str) -> Result<[u8; 16], String> {
    if value.len() != 32 || !value.is_ascii() {
        return Err("document id must be a 32-character hexadecimal UUID without dashes".into());
    }
    let mut id = [0u8; 16];
    for (i, byte) in id.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|_| "document id is not hexadecimal")?;
    }
    if id == [0; 16] {
        return Err("document id must not be zero".into());
    }
    Ok(id)
}

fn validate_local_pdf(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("PDF path must be absolute".into());
    }
    if !path.is_file() {
        return Err(format!("Selected PDF does not exist: {}", path.display()));
    }
    if path
        .extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| !x.eq_ignore_ascii_case("pdf"))
    {
        return Err("Selected file must have a .pdf extension".into());
    }
    if path.to_str().is_none() {
        return Err("PDF path cannot be represented in the worker protocol".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        active_document_matches, expected_reply, parse_document_id, render_timeout, reply_matches,
        ActiveDocument, Connection, PendingRequest, ProcessControl, ReapGate, RestartBudget,
        MAX_RESTARTS,
    };
    use pdfium_protocol::{Frame, Kind};
    use std::collections::HashMap;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex,
    };
    use std::time::Duration;
    use tokio::sync::{Mutex, Semaphore};

    struct FakeProcess {
        killed: Arc<AtomicBool>,
        delay: Duration,
    }
    impl ProcessControl for FakeProcess {
        fn write(&mut self, _bytes: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn terminate(self: Box<Self>) -> Result<(), String> {
            std::thread::sleep(self.delay);
            self.killed.store(true, Ordering::SeqCst);
            Ok(())
        }
    }

    fn fake_connection(delay: Duration) -> (Arc<Connection>, Arc<AtomicBool>) {
        let killed = Arc::new(AtomicBool::new(false));
        let connection = Arc::new(Connection {
            child: Arc::new(StdMutex::new(Some(Box::new(FakeProcess {
                killed: killed.clone(),
                delay,
            })))),
            pending: Mutex::new(HashMap::<u64, PendingRequest>::new()),
            ready: StdMutex::new(None),
            alive: AtomicBool::new(true),
            reaped: ReapGate::default(),
            diagnostics: StdMutex::new(String::new()),
        });
        (connection, killed)
    }
    #[test]
    fn accepts_uuid_hex_and_rejects_bad_identity() {
        assert!(parse_document_id("00112233445566778899aabbccddeeff").is_ok());
        assert!(parse_document_id("00000000000000000000000000000000").is_err());
        assert!(parse_document_id("bad").is_err());
    }
    #[test]
    fn render_timeout_is_clamped_to_documented_range() {
        std::env::set_var("PDFIUM_RENDER_TIMEOUT_MS", "12");
        assert_eq!(render_timeout(), Duration::from_millis(1000));
        std::env::remove_var("PDFIUM_RENDER_TIMEOUT_MS");
        assert_eq!(render_timeout(), Duration::from_millis(30_000));
    }

    #[test]
    fn only_acknowledged_protocol_shapes_are_correlated() {
        assert_eq!(expected_reply(Kind::Open), Some(Kind::Ack));
        assert_eq!(expected_reply(Kind::Render), Some(Kind::Page));
        assert_eq!(expected_reply(Kind::Shutdown), Some(Kind::Ack));
        assert_eq!(expected_reply(Kind::Ready), None);
    }

    #[test]
    fn request_id_and_reply_kind_must_match() {
        let page = Frame {
            kind: Kind::Page,
            request_id: 22,
            payload: vec![],
        };
        assert!(reply_matches(22, Kind::Page, &page));
        assert!(!reply_matches(23, Kind::Page, &page));
        assert!(!reply_matches(22, Kind::Ack, &page));
        let error = Frame {
            kind: Kind::Error,
            request_id: 22,
            payload: vec![],
        };
        assert!(reply_matches(22, Kind::Page, &error));
    }

    #[test]
    fn stale_document_generations_are_rejected() {
        let active = ActiveDocument {
            id: "doc-a".into(),
            tab: [1; 16],
            generation: 8,
            page_count: 2,
        };
        assert!(active_document_matches(Some(&active), "doc-a", 8));
        assert!(!active_document_matches(Some(&active), "doc-b", 8));
        assert!(!active_document_matches(Some(&active), "doc-a", 7));
        assert!(!active_document_matches(None, "doc-a", 8));
    }

    #[test]
    fn worker_restart_is_bounded_and_each_new_start_consumes_budget() {
        let mut budget = RestartBudget::default();
        assert!(budget.reserve_start());
        assert!(budget.reserve_start());
        assert!(budget.reserve_start());
        assert!(budget.reserve_start());
        assert!(!budget.reserve_start());
    }

    #[test]
    fn replacement_waits_until_child_exit_is_observed() {
        let gate = std::sync::Arc::new(ReapGate::default());
        let child_exit = gate.clone();
        let started = std::time::Instant::now();
        let fake_child = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            child_exit.mark_reaped();
        });
        tauri::async_runtime::block_on(gate.wait());
        fake_child.join().unwrap();
        assert!(started.elapsed() >= Duration::from_millis(30));
    }

    #[test]
    fn crash_termination_is_off_thread_and_restart_waits_for_reap() {
        let (connection, killed) = fake_connection(Duration::from_millis(40));
        let mut budget = RestartBudget::default();
        assert!(budget.reserve_start());
        let started = std::time::Instant::now();
        tauri::async_runtime::block_on(connection.fail("simulated worker crash".into()));
        assert!(killed.load(Ordering::SeqCst));
        assert!(connection.reaped.reaped.load(Ordering::SeqCst));
        assert!(started.elapsed() >= Duration::from_millis(30));
        assert!(budget.reserve_start());
        for _ in 1..MAX_RESTARTS {
            assert!(budget.reserve_start());
        }
        assert!(!budget.reserve_start());
    }

    #[test]
    fn render_timeout_terminates_and_reaps_fake_worker_before_returning() {
        let (connection, killed) = fake_connection(Duration::from_millis(20));
        let frame = Frame {
            kind: Kind::Shutdown,
            request_id: 77,
            payload: vec![],
        };
        let result =
            tauri::async_runtime::block_on(connection.request(frame, Duration::from_millis(5)));
        assert!(result.unwrap_err().contains("timed out"));
        assert!(killed.load(Ordering::SeqCst));
        assert!(connection.reaped.reaped.load(Ordering::SeqCst));
    }

    #[test]
    fn render_admission_allows_one_active_and_two_pending_and_releases_cancelled_slots() {
        let semaphore = Semaphore::new(2);
        let queued_one = semaphore.try_acquire().unwrap();
        let cancelled = semaphore.try_acquire().unwrap();
        assert!(semaphore.try_acquire().is_err());
        drop(cancelled);
        assert!(semaphore.try_acquire().is_ok());
        drop(queued_one);
    }
}
