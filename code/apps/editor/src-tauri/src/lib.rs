mod mcp;
mod startup;
#[cfg(windows)]
mod webview_shortcuts;

#[tauri::command]
fn restart_app(
    app: tauri::AppHandle,
    sessions: tauri::State<'_, mcp::McpSessions>,
) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Err("Full process restart is unavailable in development. Stop the dev process and start it again.".into());
    }

    mcp::session::mcp_stop_session(sessions)?;
    app.restart();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(mcp::McpSessions::default())
        .setup(|app| {
            #[cfg(windows)]
            {
                use tauri::Manager;
                let editor = app
                    .get_webview_window("main")
                    .ok_or("ClavierDesk editor window is missing")?;
                editor.with_webview(|webview| {
                    if let Err(error) =
                        webview_shortcuts::disable_browser_reload(webview.controller())
                    {
                        eprintln!("Failed to disable WebView2 reload shortcuts: {error}");
                    }
                })?;
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup::finish_startup,
            restart_app,
            mcp::session::mcp_start_session,
            mcp::session::mcp_stop_session,
            mcp::session::mcp_probe_session,
            mcp::bridge::mcp_respond
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ClavierDesk")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;
                if let Err(error) = mcp::session::mcp_stop_session(app.state()) {
                    eprintln!("Failed to stop MCP session on exit: {error}");
                }
            }
        });
}
