mod commands;
mod app_lock;
mod message_archive;
mod models;
mod state;
mod td;

use std::path::Path;

use state::AppState;
use tauri::{Emitter, Manager};

fn bundled_credentials() -> Option<models::Credentials> {
    let bytes = std::hint::black_box(include_bytes!(concat!(env!("OUT_DIR"), "/telegram-credentials")));
    let (mask, encoded) = bytes.split_at(bytes.len() / 2);
    let payload: Vec<_> = encoded.iter().zip(mask).map(|(byte, key)| byte ^ key).collect();
    let (id, hash) = payload.split_first_chunk::<4>()?;
    Some(models::Credentials {
        api_id: i32::from_le_bytes(*id),
        api_hash: String::from_utf8(hash.to_vec()).ok()?,
    })
}

fn resolve_credentials(data_dir: &Path) -> Result<models::Credentials, String> {
    if let (Ok(id), Ok(hash)) = (
        std::env::var("TELEGRAM_API_ID"),
        std::env::var("TELEGRAM_API_HASH"),
    ) {
        let hash = hash.trim();
        if let Ok(api_id) = id.trim().parse::<i32>() && api_id > 0 && !hash.is_empty() {
            return Ok(models::Credentials {
                api_id,
                api_hash: hash.to_string(),
            });
        }
    }
    let path = data_dir.join("credentials.json");
    let local = std::fs::read_to_string(&path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))
        .and_then(|text| {
            serde_json::from_str::<models::Credentials>(&text)
                .ok()
                .filter(|creds| creds.api_id > 0 && !creds.api_hash.trim().is_empty())
                .ok_or_else(|| format!("Недействительные данные в {}", path.display()))
        });
    local.or_else(|error| bundled_credentials().ok_or(error))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .register_asynchronous_uri_scheme_protocol("telegram-media", |context, request, responder| {
            let app = context.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(commands::stream_media(&app, request).await);
            });
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("не удалось определить app data dir");
            std::fs::create_dir_all(&data_dir).ok();
            let crash_path = data_dir.join("last-crash.txt");
            std::panic::set_hook(Box::new(move |info| {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&crash_path) {
                    let _ = writeln!(file, "panic at {}\n{}", info.location().map(|location| location.to_string()).unwrap_or_default(), std::backtrace::Backtrace::force_capture());
                }
            }));

            let db_dir = data_dir.join("tdlib-db");
            let files_dir = data_dir.join("tdlib-files");
            std::fs::create_dir_all(&db_dir).ok();
            std::fs::create_dir_all(&files_dir).ok();

            match resolve_credentials(&data_dir) {
                Ok(creds) => {
                    let st = AppState::new(creds.api_id, creds.api_hash, db_dir, files_dir);
                    handle.manage(st);
                    td::worker::start(handle.clone());
                }
                Err(err) => {
                    // Без ключей TDLib не стартует — сообщаем фронтенду.
                    let st = AppState::new(0, String::new(), db_dir, files_dir);
                    st.set_stage("no_credentials");
                    let auth = st.auth_payload();
                    handle.manage(st);
                    let _ = handle.emit("auth-state", auth);
                    eprintln!("[parugram] {err}");
                }
            }
            let archive_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    if let Err(error) = archive_handle.state::<AppState>().archive.lock().unwrap().flush() { eprintln!("[archive] {error}"); }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    tauri::async_runtime::spawn(commands::close_window_chats(window.app_handle().clone(), window.label().into()));
                }
                return;
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                window.app_handle().exit(0);
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle().clone();
                let state = app.state::<AppState>();
                let _ = state.archive.lock().unwrap().flush();
                if state.app_lock.lock().unwrap().session_suspended() {
                    api.prevent_close();
                    if let Err(error) = state.app_lock.lock().unwrap().commit_session_exit() {
                        eprintln!("[session] {error}");
                        return;
                    }
                    if let Ok(status) = state.app_lock.lock().unwrap().status() { let _ = app.emit("app-lock", status); }
                    let cid = state.client_id.load(std::sync::atomic::Ordering::SeqCst);
                    tauri::async_runtime::spawn(async move {
                        if cid != 0 {
                            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                                if tdlib_rs::functions::log_out(cid).await.is_ok() {
                                    while app.state::<AppState>().app_lock.lock().unwrap().logout_pending() {
                                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                    }
                                }
                            }).await;
                        }
                        app.exit(0);
                    });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_snapshot,
            commands::app_lock_status,
            commands::unlock_app,
            commands::set_app_lock,
            commands::acknowledge_lock_logout,
            commands::set_phone,
            commands::request_qr_login,
            commands::cancel_qr_login,
            commands::set_code,
            commands::set_password,
            commands::register_user,
            commands::load_more_chats,
            commands::select_folder,
            commands::private_chat,
            commands::get_profile,
            commands::profile_media,
            commands::search_messages,
            commands::pinned_messages,
            commands::message_thread,
            commands::thread_history,
            commands::resolve_telegram_link,
            commands::compact_chats,
            commands::sticker_catalog,
            commands::sticker_pack,
            commands::send_sticker,
            commands::install_wallpaper,
            commands::profile_photos,
            commands::profile_members,
            commands::mention_members,
            commands::set_skip_read,
            commands::set_chat_privacy,
            commands::send_chat_action,
            commands::set_notifications,
            commands::open_message_content,
            commands::open_chat_window,
            commands::chat_window_chat,
            commands::open_chat,
            commands::close_chat,
            commands::view_messages,
            commands::get_history,
            commands::get_message,
            commands::message_context,
            commands::newer_messages,
            commands::available_reactions,
            commands::reaction_senders,
            commands::set_reaction,
            commands::reaction_sticker,
            commands::set_save_deleted,
            commands::saved_deleted,
            commands::send_text,
            commands::send_file,
            commands::prepare_attachment,
            commands::prepare_clipboard_image,
            commands::prepare_voice,
            commands::send_voice,
            commands::message_actions,
            commands::next_mention,
            commands::forward_targets,
            commands::forward_message,
            commands::message_viewers,
            commands::edit_message,
            commands::delete_message,
            commands::chat_action,
            commands::set_chat_muted,
            commands::download_file,
            commands::download_settings,
            commands::set_download_drive,
            commands::save_message_file,
            commands::logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
