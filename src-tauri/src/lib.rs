pub mod api;
pub mod assets;
pub mod clip;
pub mod config;
pub mod converter;
pub mod domain;
pub mod generate;
pub mod imaging;
pub mod metadata;
pub mod project;
pub mod prompts;
pub mod server;
pub mod story;
pub mod telemetry;
pub mod workflow;

use std::{error::Error, sync::Arc};

use config::RuntimeMode;
use server::LocalServer;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub fn run() {
    telemetry::init_app();
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app: &mut tauri::App| -> Result<(), Box<dyn Error>> {
            // A failure here is answered on the spot rather than returned:
            // Tauri raises a setup error as a panic inside
            // `did_finish_launching`, which crosses a frame that cannot
            // unwind, so returning Err aborts the process before a window or
            // a message exists — the reason reaches nobody but a crash report.
            if let Err(error) = start(app) {
                report_startup_failure(app, &error);
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            // A startup that fails has to say so somewhere a reader will look:
            // the file telemetry opened, not a console a windowed program does
            // not have.
            tracing::error!("failed to build Moka Canvas: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            // The server is absent exactly when startup failed and the reason
            // is still on screen; there is nothing to shut down then.
            if let Some(server) = app.try_state::<Arc<LocalServer>>() {
                server.shutdown();
            }
        }
    });
}

/// Everything the window needs, from the metadata directory down to the
/// embedded server, ending in the window itself.
fn start(app: &mut tauri::App) -> anyhow::Result<()> {
    // The metadata directory is keyed to the product name, not to
    // the bundle identifier Tauri's `app_data_dir()` is derived from:
    // the server binary and the desktop app must land in the same
    // place, and the server has no bundle identifier to ask.
    let app_data = metadata::paths::platform_default()?;
    std::fs::create_dir_all(&app_data)?;
    let resource_dir = app.path().resource_dir()?;
    let config = config::load_native_config(&app_data, &resource_dir)?;
    let metadata_root = config::validate_startup(&config, RuntimeMode::Native, Some(&app_data))?;
    let server = Arc::new(tauri::async_runtime::block_on(LocalServer::start(
        config,
        RuntimeMode::Native,
        &metadata_root,
    ))?);
    let url = WebviewUrl::External(server.url().parse()?);

    WebviewWindowBuilder::new(app, "main", url)
        .title("Moka Canvas")
        .inner_size(1280.0, 840.0)
        .min_inner_size(960.0, 640.0)
        // Every drag in the app is the page's own: a file comes off
        // the shelf and lands on the timeline. Tauri's native drag
        // handler takes that session away from the webview — macOS
        // answers internal drags itself and never delivers the drop,
        // and Windows turns HTML5 drag and drop off outright — so it
        // is left unset and files dropped in from the desktop are the
        // page's own file drops again.
        .disable_drag_drop_handler()
        .build()?;
    app.manage(server);
    Ok(())
}

/// Says why the app could not start — in the log file and in a dialog, since a
/// double-clicked program has nobody watching its stderr — and ends the
/// process once the dialog is dismissed.
///
/// The dialog is app-modal and drawn by the event loop, so this only asks for
/// it; it appears once setup returns and the loop runs.
fn report_startup_failure(app: &tauri::App, error: &anyhow::Error) {
    let reason = format!("{error:#}");
    tracing::error!("Moka Canvas could not start: {reason}");
    app.dialog()
        .message(reason)
        .title("Moka Canvas")
        .kind(MessageDialogKind::Error)
        .show(|_| std::process::exit(1));
}
