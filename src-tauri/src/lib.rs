mod supervisor;

use std::path::PathBuf;
use supervisor::{AppState, OpenDocumentResult};
use tauri::{Manager, RunEvent};

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_pdf,
            render_page,
            cancel_render,
            close_pdf
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
