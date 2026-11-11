mod supervisor;

use std::path::PathBuf;
use std::sync::Mutex;
use supervisor::{AppState, OpenDocumentResult, PrintJobResult, TextSearchResult};
use tauri::{Manager, RunEvent};

struct StartupPdfPath(Mutex<Option<String>>);

fn pdf_path_from_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Option<String> {
    args.into_iter().find_map(|arg| {
        let path = PathBuf::from(arg);
        path.extension()
            .and_then(|extension| extension.to_str())
            .filter(|extension| extension.eq_ignore_ascii_case("pdf"))
            .map(|_| path.to_string_lossy().into_owned())
    })
}

fn startup_pdf_path() -> Option<String> {
    pdf_path_from_args(std::env::args_os().skip(1))
}

#[tauri::command]
async fn take_startup_pdf_path(state: tauri::State<'_, StartupPdfPath>) -> Result<Option<String>, String> {
    state
        .0
        .lock()
        .map(|mut path| path.take())
        .map_err(|_| "Could not read the PDF file passed to LitheXPDF".to_string())
}

#[cfg(windows)]
#[tauri::command]
async fn open_default_pdf_settings() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let operation: Vec<u16> = "open".encode_utf16().chain(std::iter::once(0)).collect();
        let uri: Vec<u16> = "ms-settings:defaultapps?registeredAppMachine=LitheXPDF"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            windows_sys::Win32::UI::Shell::ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                uri.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
            )
        };
        if (result as isize) > 32 {
            Ok(())
        } else {
            Err(format!("Windows could not open Default apps (ShellExecuteW returned {})", result as isize))
        }
    })
    .await
    .map_err(|error| format!("Could not start the Windows settings request: {error}"))?
}

#[cfg(not(windows))]
#[tauri::command]
async fn open_default_pdf_settings() -> Result<(), String> {
    Err("Default PDF app settings are currently supported on Windows only".into())
}

#[tauri::command]
async fn open_pdf(
    state: tauri::State<'_, AppState>,
    document_id: String,
    path: String,
) -> Result<OpenDocumentResult, String> {
    state.open_pdf(document_id, path).await
}

#[tauri::command]
async fn render_page(
    state: tauri::State<'_, AppState>,
    request_token: String,
    document_id: String,
    generation: u64,
    page_index: u32,
    width: u32,
    height: u32,
    zoom: f64,
) -> Result<tauri::ipc::Response, String> {
    state
        .render(
            request_token,
            document_id,
            generation,
            page_index,
            width,
            height,
            zoom,
        )
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
async fn search_text(
    state: tauri::State<'_, AppState>,
    document_id: String,
    generation: u64,
    query: String,
    match_case: bool,
    whole_word: bool,
) -> Result<TextSearchResult, String> {
    state
        .search_text(document_id, generation, query, match_case, whole_word)
        .await
}

#[cfg(windows)]
#[tauri::command]
async fn print_pdf(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    document_id: String,
    generation: u64,
    current_page: u32,
    page_selection: u8,
    range_start: u32,
    range_end: u32,
) -> Result<PrintJobResult, String> {
    let hwnd = window
        .hwnd()
        .map_err(|error| format!("Could not access the LitheXPDF window: {error}"))?;
    state
        .print_document(
            document_id,
            generation,
            current_page,
            page_selection,
            range_start,
            range_end,
            hwnd.0 as usize as u64,
        )
        .await
}

#[cfg(not(windows))]
#[tauri::command]
async fn print_pdf(
    state: tauri::State<'_, AppState>,
    document_id: String,
    generation: u64,
    current_page: u32,
    page_selection: u8,
    range_start: u32,
    range_end: u32,
) -> Result<PrintJobResult, String> {
    let _ = (
        state,
        document_id,
        generation,
        current_page,
        page_selection,
        range_start,
        range_end,
    );
    Err("Native PDF printing is currently supported on Windows only".into())
}

#[tauri::command]
async fn cancel_render(
    state: tauri::State<'_, AppState>,
    request_token: String,
) -> Result<bool, String> {
    Ok(state.cancel_render(request_token).await)
}

#[tauri::command]
async fn close_pdf(
    state: tauri::State<'_, AppState>,
    document_id: String,
    generation: u64,
) -> Result<(), String> {
    state.close_document(document_id, generation).await
}


#[tauri::command]
async fn get_text_layer(
    state: tauri::State<'_, AppState>,
    document_id: String,
    generation: u64,
    page_index: u32,
) -> Result<tauri::ipc::Response, String> {
    state
        .get_text_layer(document_id, generation, page_index)
        .await
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
fn show_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer")
        .args(["/select,", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}
fn resolve_pdfium_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    let path = {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium/pdfium.dll")
    };
    #[cfg(not(debug_assertions))]
    let path = app
        .path()
        .resolve("pdfium/pdfium.dll", tauri::path::BaseDirectory::Resource)?;
    Ok(path.canonicalize()?)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let pdfium_path = resolve_pdfium_path(app.handle())?;
            app.manage(AppState::new(app.handle().clone(), pdfium_path));
            app.manage(StartupPdfPath(Mutex::new(startup_pdf_path())));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_startup_pdf_path,
            open_default_pdf_settings,
            open_pdf,
            render_page,
            search_text,
            print_pdf,
            cancel_render,
            close_pdf,
            get_text_layer,
            show_in_explorer
        ])
        .build(tauri::generate_context!())
        .expect("failed to build LitheXPDF desktop host");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<AppState>().inner().clone();
            if !state.allow_exit() {
                api.prevent_exit();
                if state.begin_exit() {
                    let handle = handle.clone();
                    tauri::async_runtime::spawn(async move {
                        state.shutdown().await;
                        handle.exit(0);
                    });
                }
            }
        }
    });
}
