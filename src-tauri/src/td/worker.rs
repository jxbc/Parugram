// Фоновый TDLib-воркер: receive-цикл в отдельном потоке + асинхронная обработка.
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;

use crate::models::{ChatListPayload, DeletedMessagesPayload, MessageContentPayload, MessageReplacement, MsgData};
use crate::state::AppState;

use super::convert;

pub(crate) enum WorkerEvent {
    Update(i32, tdlib_rs::enums::Update),
    CancelQrLogin(i32, tokio::sync::oneshot::Sender<Result<(), String>>),
    ChatsLoaded(i32, Result<bool, String>, tokio::sync::oneshot::Sender<Result<bool, String>>),
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut client_id = tdlib_rs::create_client();
        app.state::<AppState>().client_id.store(client_id, Ordering::SeqCst);
        eprintln!("[td] client created: {client_id}");

        let (tx, mut rx) = mpsc::unbounded_channel::<WorkerEvent>();
        *app.state::<AppState>().worker_tx.lock().unwrap() = Some(tx.clone());
        let updates_tx = tx.clone();
        std::thread::spawn(move || {
            loop {
                if let Some((update, cid)) = tdlib_rs::receive() {
                    if updates_tx.send(WorkerEvent::Update(cid, update)).is_err() {
                        break;
                    }
                }
            }
        });

        let _ = tdlib_rs::functions::set_log_verbosity_level(0, client_id).await;

        let mut restarting_login = false;
        while let Some(event) = rx.recv().await {
            match event {
                WorkerEvent::Update(cid, update) => {
                    if cid != client_id { continue; }
                    if restarting_login {
                        if matches!(&update, tdlib_rs::enums::Update::AuthorizationState(u)
                            if matches!(u.authorization_state, tdlib_rs::enums::AuthorizationState::Closed)) {
                            restarting_login = false;
                            client_id = tdlib_rs::create_client();
                            app.state::<AppState>().client_id.store(client_id, Ordering::SeqCst);
                            let _ = tdlib_rs::functions::get_authorization_state(client_id).await;
                        }
                        continue;
                    }
                    let ready = matches!(&update, tdlib_rs::enums::Update::AuthorizationState(u)
                        if matches!(u.authorization_state, tdlib_rs::enums::AuthorizationState::Ready));
                    if let Err(err) = handle_update(&app, client_id, update).await {
                        eprintln!("[td] update error: {err}");
                    }
                    if ready && !app.state::<AppState>().app_lock.lock().unwrap().logout_pending() {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = refresh_chats(&handle, false).await;
                        });
                    }
                }
                WorkerEvent::CancelQrLogin(cid, reply) => {
                    let state = app.state::<AppState>();
                    let result = if cid == client_id && state.is_stage("wait_other_device") && state.app_lock.lock().unwrap().is_unlocked() {
                        cancel_qr_login(client_id).await
                    } else {
                        Err("Вход по QR-коду уже завершён".into())
                    };
                    if result.is_ok() {
                        restarting_login = true;
                        state.set_stage("loading");
                        let _ = app.emit("auth-state", state.auth_payload());
                    }
                    let _ = reply.send(result);
                }
                WorkerEvent::ChatsLoaded(folder_id, result, reply) => {
                    let state = app.state::<AppState>();
                    if !state.is_stage("ready") || state.active_folder.load(Ordering::SeqCst) != folder_id {
                        let _ = reply.send(Err("Войдите в аккаунт".into()));
                        continue;
                    }
                    match &result {
                        Ok(has_more) => {
                            state.chats_loaded.store(true, Ordering::SeqCst);
                            state.has_more_chats.store(*has_more, Ordering::SeqCst);
                            *state.chats_error.lock().unwrap() = None;
                        }
                        Err(err) => *state.chats_error.lock().unwrap() = Some(err.clone()),
                    }
                    emit_chats(&app);
                    let _ = reply.send(result.map(|_| chat_list(&app).has_more));
                }
            }
        }
    });
}

async fn cancel_qr_login(client_id: i32) -> Result<(), String> {
    use tdlib_rs::{enums::AuthorizationState, functions};
    let auth = functions::get_authorization_state(client_id).await.map_err(|error| error.message)?;
    if !matches!(auth, AuthorizationState::WaitOtherDeviceConfirmation(_)) {
        return Err("Вход по QR-коду уже завершён".into());
    }
    functions::log_out(client_id).await.map_err(|error| error.message)
}

async fn handle_update(
    app: &AppHandle,
    client_id: i32,
    update: tdlib_rs::enums::Update,
) -> Result<(), String> {
    use tdlib_rs::enums::Update;
    match update {
        Update::AuthorizationState(u) => handle_auth(app, client_id, u.authorization_state).await,
        Update::MessageIsPinned(u) => {
            let _ = app.emit("pinned-messages-changed", u.chat_id);
            Ok(())
        }
        Update::NewChat(u) => {
            let summary = convert::chat_to_summary(&u.chat);
            upsert_chat(app, summary);
            Ok(())
        }
        Update::ChatTitle(u) => {
            let state = app.state::<AppState>();
            let mut chats = state.chats.lock().unwrap();
            if let Some(c) = chats.get_mut(&u.chat_id) {
                c.title = u.title;
            }
            drop(chats);
            emit_chats(app);
            Ok(())
        }
        Update::ChatPhoto(u) => {
            {
                let state = app.state::<AppState>();
                let mut chats = state.chats.lock().unwrap();
                if let Some(chat) = chats.get_mut(&u.chat_id) {
                    chat.photo_file_id = u.photo.as_ref().map(|photo| photo.small.id);
                    chat.photo = u.photo.as_ref().and_then(|photo| convert::file_to_data(&photo.small).local_path);
                }
            }
            emit_chats(app);
            Ok(())
        }
        Update::User(u) => {
            cache_user(app, &u.user);
            Ok(())
        }
        Update::ChatFolders(u) => {
            let mut folders: Vec<_> = u.chat_folders.iter().map(|folder| crate::models::FolderData {
                id: folder.id, title: folder.name.text.text.clone(), unread_count: 0,
            }).collect();
            let main_position = (u.main_chat_list_position.max(0) as usize).min(folders.len());
            folders.insert(main_position, crate::models::FolderData { id: 0, title: "Все".into(), unread_count: 0 });
            folders.push(crate::models::FolderData { id: -1, title: "Архив".into(), unread_count: 0 });
            let state = app.state::<AppState>();
            let active_folder = state.active_folder.load(Ordering::SeqCst);
            let reset = !folders.iter().any(|folder| folder.id == active_folder);
            *state.folders.lock().unwrap() = folders;
            app.emit("folders", state.folder_list()).map_err(|e| e.to_string())?;
            if reset {
                state.active_folder.store(0, Ordering::SeqCst);
                state.chat_limit.store(50, Ordering::SeqCst);
                state.chats_loaded.store(false, Ordering::SeqCst);
                state.has_more_chats.store(true, Ordering::SeqCst);
                emit_chats(app);
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { let _ = refresh_chats(&handle, false).await; });
            }
            Ok(())
        }
        Update::UnreadChatCount(u) => {
            let state = app.state::<AppState>();
            let id = convert::folder_id(&u.chat_list);
            let count = u.unread_count.max(0);
            let previous = state.folder_unread.lock().unwrap().insert(id, count).unwrap_or(0);
            if previous != count && state.folders.lock().unwrap().iter().any(|folder| folder.id == id) {
                app.emit("folders", state.folder_list()).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Update::ChatPosition(u) => {
            let state = app.state::<AppState>();
            let mut chats = state.chats.lock().unwrap();
            if let Some(c) = chats.get_mut(&u.chat_id) {
                let position = convert::position_to_data(&u.position);
                if position.folder_id == 0 {
                    c.order = position.order;
                    c.is_pinned = position.is_pinned;
                }
                c.positions.retain(|p| p.folder_id != position.folder_id);
                c.positions.push(position);
            }
            drop(chats);
            emit_chats(app);
            Ok(())
        }
        Update::ChatLastMessage(u) => {
            let data = u.last_message.as_ref().map(convert::message_to_data);
            let state = app.state::<AppState>();
            let mut chats = state.chats.lock().unwrap();
            if let Some(c) = chats.get_mut(&u.chat_id) {
                c.last_message = data;
                let position = u.positions.iter().find(|p| matches!(p.list, tdlib_rs::enums::ChatList::Main));
                c.order = position.map_or(0, |p| p.order);
                c.is_pinned = position.is_some_and(|p| p.is_pinned);
                c.positions = u.positions.iter().map(convert::position_to_data).collect();
            }
            drop(chats);
            emit_chats(app);
            Ok(())
        }
        Update::ChatNotificationSettings(u) => {
            let muted = convert::notifications_muted(&u.notification_settings);
            let state = app.state::<AppState>();
            if let Some(chat) = state.chats.lock().unwrap().get_mut(&u.chat_id) {
                chat.notifications_muted = muted;
            }
            let _ = app.emit("chat-notifications", serde_json::json!({ "chat_id": u.chat_id, "muted": muted }));
            Ok(())
        }
        Update::ScopeNotificationSettings(u) => {
            let state = app.state::<AppState>();
            let key = convert::notification_scope_key(u.scope);
            let muted = u.notification_settings.mute_for > 0;
            let previous = state.muted_scopes.lock().unwrap().insert(key, muted);
            if previous.unwrap_or(false) != muted { emit_chats(app); }
            Ok(())
        }
        Update::ChatReadInbox(u) => {
            let state = app.state::<AppState>();
            let mut chats = state.chats.lock().unwrap();
            if let Some(c) = chats.get_mut(&u.chat_id) {
                c.unread_count = u.unread_count;
                c.last_read_inbox_message_id = u.last_read_inbox_message_id;
            }
            drop(chats);
            emit_chats(app);
            Ok(())
        }
        Update::ChatUnreadMentionCount(u) => {
            update_mentions(app, u.chat_id, u.unread_mention_count);
            Ok(())
        }
        Update::MessageMentionRead(u) => {
            update_mentions(app, u.chat_id, u.unread_mention_count);
            Ok(())
        }
        Update::ChatIsMarkedAsUnread(u) => {
            {
                let state = app.state::<AppState>();
                let mut chats = state.chats.lock().unwrap();
                if let Some(chat) = chats.get_mut(&u.chat_id) { chat.is_marked_as_unread = u.is_marked_as_unread; }
            }
            emit_chats(app);
            Ok(())
        }
        Update::NewMessage(u) => {
            let data: MsgData = message_of(app, &u.message);
            let enrich = data.sender.name.is_empty() || data.forward_from.as_ref().is_some_and(|origin| origin.id.is_some())
                || data.reply_to.is_some() || matches!(&data.content, crate::models::MsgContent::Event { members, .. } if members.iter().any(|member| member.name.is_empty()));
            app.emit("message", data).map_err(|e| e.to_string())?;
            if enrich {
                let handle = app.clone();
                let account = app.state::<AppState>().user.lock().unwrap().as_ref().map(|user| user.id);
                tauri::async_runtime::spawn(async move {
                    ensure_senders(&handle, &[&u.message]).await;
                    let state = handle.state::<AppState>();
                    let owner = state.user.lock().unwrap().as_ref().map(|user| user.id);
                    if owner != account || state.client_id.load(Ordering::SeqCst) != client_id || !state.is_stage("ready") { return; }
                    let _ = handle.emit("message", message_of(&handle, &u.message));
                });
            }
            Ok(())
        }
        Update::NotificationGroup(group) => {
            if group.added_notifications.is_empty() { return Ok(()); }
            let handle = app.clone();
            tauri::async_runtime::spawn(async move { show_message_notification(&handle, client_id, group).await });
            Ok(())
        }
        Update::ChatOnlineMemberCount(u) => {
            app.emit("chat-online-count", serde_json::json!({ "chat_id": u.chat_id, "count": u.online_member_count })).map_err(|e| e.to_string())
        }
        Update::ChatAction(u) => {
            let state = app.state::<AppState>();
            if !state.app_lock.lock().unwrap().is_unlocked() { return Ok(()); }
            let action = convert::chat_action_name(&u.action);
            let (kind, id) = match u.sender_id {
                tdlib_rs::enums::MessageSender::User(sender) => ("user", sender.user_id),
                tdlib_rs::enums::MessageSender::Chat(sender) => ("chat", sender.chat_id),
            };
            let mut sender = crate::models::SenderData { kind: kind.into(), id, name: String::new(), first_name: None, photo: None, photo_file_id: None };
            if action != "cancel" && kind == "user" {
                let cached = state.users.lock().unwrap().get(&id).cloned();
                let user = if let Some(user) = cached { Some(user) }
                    else if let Ok(Ok(tdlib_rs::enums::User::User(user))) = tokio::time::timeout(std::time::Duration::from_secs(4), tdlib_rs::functions::get_user(id, client_id)).await {
                        let user = convert::user_to_payload(&user);
                        state.users.lock().unwrap().insert(id, user.clone());
                        Some(user)
                    } else { None };
                if let Some(user) = user {
                    sender.name = format!("{} {}", user.first_name, user.last_name).trim().into();
                    sender.photo = user.photo;
                    sender.photo_file_id = user.photo_file_id;
                }
            } else if kind == "chat" {
                if let Some(chat) = state.chats.lock().unwrap().get(&id) {
                    sender.name = chat.title.clone();
                    sender.photo = chat.photo.clone();
                    sender.photo_file_id = chat.photo_file_id;
                }
            }
            app.emit("chat-activity", crate::models::ChatActivityData { chat_id: u.chat_id, sender, action: action.into() }).map_err(|e| e.to_string())
        }
        Update::MessageSendSucceeded(u) => {
            app.emit("message-replaced", MessageReplacement {
                old_message_id: u.old_message_id,
                message: message_of(app, &u.message),
            }).map_err(|e| e.to_string())
        }
        Update::MessageSendFailed(u) => {
            let mut message = message_of(app, &u.message);
            message.sending_state = "failed".into();
            message.error = Some(u.error.message);
            app.emit("message-replaced", MessageReplacement {
                old_message_id: u.old_message_id,
                message,
            }).map_err(|e| e.to_string())
        }
        Update::MessageContent(u) => {
            let content = convert::content_to_data(&u.new_content);
            app.state::<AppState>().archive.lock().unwrap().update_content(u.chat_id, u.message_id, content.clone());
            {
                let state = app.state::<AppState>();
                let mut chats = state.chats.lock().unwrap();
                if let Some(message) = chats.get_mut(&u.chat_id).and_then(|c| c.last_message.as_mut()) {
                    if message.id == u.message_id {
                        message.content = content.clone();
                    }
                }
            }
            app.emit("message-content", MessageContentPayload {
                chat_id: u.chat_id,
                message_id: u.message_id,
                content,
            }).map_err(|e| e.to_string())?;
            emit_chats(app);
            Ok(())
        }
        Update::DeleteMessages(u) => {
            if !u.is_permanent || u.from_cache {
                return Ok(());
            }
            let saved_messages = {
                let state = app.state::<AppState>();
                let mut archive = state.archive.lock().unwrap();
                let messages = archive.mark_deleted(u.chat_id, &u.message_ids);
                if let Err(error) = archive.flush() { eprintln!("[archive] {error}"); }
                messages
            };
            {
                let state = app.state::<AppState>();
                let mut chats = state.chats.lock().unwrap();
                if let Some(chat) = chats.get_mut(&u.chat_id) {
                    if chat.last_message.as_ref().is_some_and(|m| u.message_ids.contains(&m.id)) {
                        chat.last_message = None;
                    }
                }
            }
            app.emit("messages-deleted", DeletedMessagesPayload {
                chat_id: u.chat_id,
                message_ids: u.message_ids,
                saved_messages,
            }).map_err(|e| e.to_string())?;
            emit_chats(app);
            Ok(())
        }
        Update::ChatReadOutbox(u) => {
            let state = app.state::<AppState>();
            if let Some(chat) = state.chats.lock().unwrap().get_mut(&u.chat_id) {
                chat.last_read_outbox_message_id = u.last_read_outbox_message_id;
            }
            emit_chats(app);
            Ok(())
        }
        Update::MessageInteractionInfo(u) => {
            let mut reactions = convert::reactions_to_data(u.interaction_info.as_ref());
            let comment_count = u.interaction_info.as_ref().and_then(|info| info.reply_info.as_ref()).map(|info| info.reply_count);
            let state = app.state::<AppState>();
            for sender in reactions.iter_mut().flat_map(|reaction| &mut reaction.recent_senders) { enrich_sender(&state, sender); }
            state.archive.lock().unwrap().update_reactions(u.chat_id, u.message_id, reactions.clone());
            {
                let mut chats = state.chats.lock().unwrap();
                if let Some(message) = chats.get_mut(&u.chat_id).and_then(|chat| chat.last_message.as_mut()).filter(|message| message.id == u.message_id) { message.reactions = reactions.clone(); }
            }
            app.emit("message-reactions", crate::models::MessageReactionsPayload { chat_id: u.chat_id, message_id: u.message_id, reactions, comment_count }).map_err(|error| error.to_string())
        }
        Update::File(u) => {
            let data = convert::file_to_data(&u.file);
            app.emit("file", data).map_err(|e| e.to_string())
        }
        Update::RecentStickers(u) => {
            if !u.is_attached { let _ = app.emit("stickers-changed", "recent"); }
            Ok(())
        }
        Update::InstalledStickerSets(u) => {
            if matches!(u.sticker_type, tdlib_rs::enums::StickerType::Regular) { let _ = app.emit("stickers-changed", "sets"); }
            Ok(())
        }
        Update::StickerSet(u) => {
            if matches!(u.sticker_set.sticker_type, tdlib_rs::enums::StickerType::Regular) {
                let stickers: Vec<_> = u.sticker_set.stickers.iter().map(convert::sticker_to_data).collect();
                let _ = app.emit("sticker-pack", serde_json::json!({ "id": u.sticker_set.id.to_string(), "stickers": stickers }));
            }
            Ok(())
        }
        Update::ConnectionState(u) => {
            use tdlib_rs::enums::ConnectionState as C;
            let label = match u.state {
                C::Ready => "connected",
                C::Connecting | C::ConnectingToProxy | C::WaitingForNetwork | C::Updating => {
                    "connecting"
                }
            };
            *app.state::<AppState>().connection.lock().unwrap() = label.into();
            app.emit("connection", label).map_err(|e| e.to_string())?;
            emit_chats(app);
            Ok(())
        }
        _ => Ok(()),
    }
}

fn upsert_chat(app: &AppHandle, summary: crate::models::ChatSummary) {
    let state = app.state::<AppState>();
    let mut chats = state.chats.lock().unwrap();
    let entry = chats.entry(summary.id).or_default();
    *entry = summary;
    let needs_title = entry.title.is_empty();
    let chat_id = entry.id;
    drop(chats);

    emit_chats(app);
    if needs_title {
        tauri::async_runtime::spawn(resolve_chat_title(app.clone(), chat_id));
    }
}

/// Приватные чаты приходят с пустым title — подтягиваем имя юзера.
async fn resolve_chat_title(app: AppHandle, chat_id: i64) {
    let client_id = app.state::<AppState>().client_id.load(Ordering::SeqCst);
    let Ok(tdlib_rs::enums::Chat::Chat(chat)) =
        tdlib_rs::functions::get_chat(chat_id, client_id).await
    else {
        return;
    };
    let tdlib_rs::enums::ChatType::Private(p) = chat.r#type else {
        return;
    };
    let user_id = p.user_id;

    {
        let state = app.state::<AppState>();
        let users = state.users.lock().unwrap();
        if let Some(user) = users.get(&user_id) {
            let mut chats = state.chats.lock().unwrap();
            if let Some(c) = chats.get_mut(&chat_id) {
                if c.title.is_empty() {
                    c.title = format!("{} {}", user.first_name, user.last_name).trim().into();
                }
            }
            drop(chats);
            drop(users);
            emit_chats(&app);
            return;
        }
    }

    let Ok(tdlib_rs::enums::User::User(user)) =
        tdlib_rs::functions::get_user(user_id, client_id).await
    else {
        return;
    };
    let name = format!("{} {}", user.first_name, user.last_name)
        .trim()
        .to_string();

    let state = app.state::<AppState>();
    state.users.lock().unwrap().insert(user_id, convert::user_to_payload(&user));
    let mut chats = state.chats.lock().unwrap();
    if let Some(c) = chats.get_mut(&chat_id) {
        if c.title.is_empty() {
            c.title = name;
        }
    }
    drop(chats);
    emit_chats(&app);
}

async fn handle_auth(
    app: &AppHandle,
    client_id: i32,
    state_enum: tdlib_rs::enums::AuthorizationState,
) -> Result<(), String> {
    use tdlib_rs::enums::AuthorizationState as A;
    let state = app.state::<AppState>();
    match state_enum {
        A::WaitTdlibParameters => {
            state.set_stage("loading");
            tdlib_rs::functions::set_tdlib_parameters(
                false,
                state.db_dir.to_string_lossy().into_owned(),
                state.files_dir.to_string_lossy().into_owned(),
                String::new(), // database_encryption_key
                true,          // use_file_database
                true,          // use_chat_info_database
                true,          // use_message_database
                false,         // use_secret_chats
                state.api_id,
                state.api_hash.clone(),
                "ru".into(),
                "Parugram".into(),
                "Windows".into(),
                "0.1.0".into(),
                client_id,
            )
            .await
            .map_err(|e| format!("setTdlibParameters: {}: {}", e.code, e.message))?;
        }
        A::WaitPhoneNumber => {
            state.set_stage("wait_phone");
            let mut lock = state.app_lock.lock().unwrap();
            if lock.logout_pending() {
                lock.complete_logout()?;
                let _ = app.emit("app-lock", lock.status()?);
            }
        }
        A::WaitCode(_) => state.set_stage("wait_code"),
        A::WaitPassword(_) => state.set_stage("wait_password"),
        A::WaitRegistration(_) => state.set_stage("wait_registration"),
        A::WaitOtherDeviceConfirmation(confirmation) => state.set_qr_login_link(confirmation.link),
        A::WaitEmailAddress(_) | A::WaitEmailCode(_) | A::WaitPremiumPurchase(_) => {
            state.set_stage("wait_email");
        }
        A::Ready => {
            if state.app_lock.lock().unwrap().logout_pending() {
                state.set_stage("logging_out");
                crate::commands::request_lock_logout(app);
            } else {
                state.set_stage("ready");
                if let Err(error) = fetch_user(app, client_id).await {
                    *state.chats_error.lock().unwrap() = Some(error);
                }
                let count = tdlib_rs::enums::OptionValue::Integer(tdlib_rs::types::OptionValueInteger { value: 10 });
                let _ = tdlib_rs::functions::set_option("notification_group_count_max".into(), Some(count), client_id).await;
            }
        }
        A::LoggingOut | A::Closing | A::Closed => {
            let logging_out = matches!(state_enum, A::LoggingOut);
            let closed = matches!(state_enum, A::Closed);
            state.set_stage("logged_out");
            if let Err(error) = state.archive.lock().unwrap().flush() { eprintln!("[archive] {error}"); }
            {
                let mut lock = state.app_lock.lock().unwrap();
                if logging_out { lock.logout_started = true; }
                if closed && lock.logout_started && lock.logout_pending() {
                    lock.complete_logout()?;
                    let _ = app.emit("app-lock", lock.status()?);
                }
            }
            state.chats_loaded.store(false, Ordering::SeqCst);
            state.has_more_chats.store(true, Ordering::SeqCst);
            state.chat_limit.store(50, Ordering::SeqCst);
            state.active_folder.store(0, Ordering::SeqCst);
            state.folders.lock().unwrap().clear();
            state.folder_unread.lock().unwrap().clear();
            state.chats.lock().unwrap().clear();
            state.muted_scopes.lock().unwrap().clear();
            state.users.lock().unwrap().clear();
            *state.user.lock().unwrap() = None;
        }
    }
    app.emit("auth-state", state.auth_payload()).map_err(|e| e.to_string())
}

async fn show_message_notification(app: &AppHandle, client_id: i32, group: tdlib_rs::types::UpdateNotificationGroup) {
    use tdlib_rs::{enums::{Chat, NotificationType, ScopeNotificationSettings}, functions};
    let state = app.state::<AppState>();
    if !state.notifications.lock().unwrap().enabled || !state.is_stage("ready") || !state.app_lock.lock().unwrap().is_unlocked() { return; }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let mut messages = group.added_notifications.into_iter().rev().filter_map(|notification| {
        if notification.is_silent || now.saturating_sub(i64::from(notification.date)) > 120 { return None; }
        match notification.r#type { NotificationType::NewMessage(message) => Some(message), _ => None }
    }).peekable();
    if messages.peek().is_none() { return; }
    let Ok(Chat::Chat(chat)) = functions::get_chat(group.chat_id, client_id).await else { return; };
    let scope = convert::notification_scope(&chat.r#type);
    let settings = &chat.notification_settings;
    let mut show_preview = settings.show_preview;
    if settings.use_default_mute_for || settings.use_default_show_preview {
        let Ok(ScopeNotificationSettings::ScopeNotificationSettings(defaults)) = functions::get_scope_notification_settings(scope.clone(), client_id).await else { return; };
        if settings.use_default_mute_for && defaults.mute_for > 0 { return; }
        if settings.use_default_show_preview { show_preview = defaults.show_preview; }
    }
    if !settings.use_default_mute_for && settings.mute_for > 0 { return; }
    if state.client_id.load(Ordering::SeqCst) != client_id || !state.is_stage("ready") || !state.app_lock.lock().unwrap().is_unlocked() { return; }
    let preferences = *state.notifications.lock().unwrap();
    let Some(message) = messages.find(|message| preferences.allows(&scope, message.message.contains_unread_mention)) else { return; };
    let body: String = if show_preview && message.show_preview {
        convert::content_preview(&convert::content_to_data(&message.message.content)).chars().take(160).collect()
    } else { "Новое сообщение".into() };
    let _ = app.notification().builder().title(chat.title).body(body).show();
}

async fn fetch_user(app: &AppHandle, client_id: i32) -> Result<(), String> {
    let tdlib_rs::enums::User::User(user) = tdlib_rs::functions::get_me(client_id)
        .await.map_err(|e| format!("TDLib error {}: {}", e.code, e.message))?;

    let payload = convert::user_to_payload(&user);
    let state = app.state::<AppState>();
    if let Err(error) = state.archive.lock().unwrap().select_user(user.id) { eprintln!("[archive] {error}"); }
    state
        .users
        .lock()
        .unwrap()
        .insert(user.id, payload.clone());
    *state.user.lock().unwrap() = Some(payload);
    Ok(())
}

pub async fn load_chats(client_id: i32, folder_id: i32) -> Result<bool, String> {
    match tdlib_rs::functions::load_chats(Some(convert::chat_list(folder_id)), 50, client_id).await {
        Ok(()) => Ok(true),
        Err(e) if e.code == 404 => Ok(false),
        Err(e) => Err(format!("TDLib error {}: {}", e.code, e.message)),
    }
}

pub async fn refresh_chats(app: &AppHandle, extend: bool) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let folder_id = state.active_folder.load(Ordering::SeqCst);
    if extend && state.chats_loaded.load(Ordering::SeqCst) {
        let limit = state.chat_limit.fetch_add(50, Ordering::SeqCst) + 50;
        let known = state.chats.lock().unwrap().values().filter(|chat| position_of(chat, folder_id).0 > 0).count();
        if known >= limit || !state.has_more_chats.load(Ordering::SeqCst) {
            emit_chats(app);
            return Ok(chat_list(app).has_more);
        }
    }
    let client_id = state.client_id.load(Ordering::SeqCst);
    let tx = state.worker_tx.lock().unwrap().clone().ok_or("TDLib ещё не запущен")?;
    let needs_user = state.user.lock().unwrap().is_none();
    let result = async {
        if needs_user {
            fetch_user(app, client_id).await?;
            app.emit("auth-state", state.auth_payload())
                .map_err(|e| e.to_string())?;
        }
        load_chats(client_id, folder_id).await
    }.await;
    let (reply, received) = tokio::sync::oneshot::channel();
    tx.send(WorkerEvent::ChatsLoaded(folder_id, result, reply)).map_err(|_| "TDLib остановлен")?;
    received.await.map_err(|_| "TDLib остановлен")?
}

pub fn sorted_chats(app: &AppHandle) -> Vec<crate::models::ChatSummary> {
    let state = app.state::<AppState>();
    let mut page = sorted_page(&state.chats.lock().unwrap(), state.chat_limit.load(Ordering::SeqCst), state.active_folder.load(Ordering::SeqCst));
    for message in page.iter_mut().filter_map(|chat| chat.last_message.as_mut()) {
        enrich_sender(&state, &mut message.sender);
    }
    page
}

fn position_of(chat: &crate::models::ChatSummary, folder_id: i32) -> (i64, bool) {
    chat.positions.iter().find(|p| p.folder_id == folder_id)
        .map(|p| (p.order, p.is_pinned)).unwrap_or_else(|| if folder_id == 0 { (chat.order, chat.is_pinned) } else { (0, false) })
}

fn sorted_page(chats: &std::collections::HashMap<i64, crate::models::ChatSummary>, limit: usize, folder_id: i32) -> Vec<crate::models::ChatSummary> {
    let mut chats: Vec<_> = chats.values().filter_map(|chat| {
        let (order, pinned) = position_of(chat, folder_id);
        (order > 0).then_some((chat, order, pinned))
    }).collect();
    chats.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.id.cmp(&a.0.id)));
    chats.into_iter().take(limit).map(|(chat, order, pinned)| {
        let mut chat = chat.clone();
        chat.order = order;
        chat.is_pinned = pinned;
        chat
    }).collect()
}

pub fn emit_chats(app: &AppHandle) {
    let _ = app.emit("chats", chat_list(app));
}

fn update_mentions(app: &AppHandle, chat_id: i64, count: i32) {
    let state = app.state::<AppState>();
    if let Some(chat) = state.chats.lock().unwrap().get_mut(&chat_id) {
        chat.unread_mention_count = count;
    }
    let _ = app.emit("chat-mentions", serde_json::json!({ "chat_id": chat_id, "count": count }));
}

pub fn chat_list(app: &AppHandle) -> ChatListPayload {
    let state = app.state::<AppState>();
    let folder_id = state.active_folder.load(Ordering::SeqCst);
    let known = state.chats.lock().unwrap().values().filter(|chat| position_of(chat, folder_id).0 > 0).count();
    ChatListPayload {
        folder_id,
        chats: sorted_chats(app),
        muted_scopes: state.muted_scopes.lock().unwrap().clone(),
        ready: state.chats_ready(),
        has_more: state.has_more_chats.load(Ordering::SeqCst) || known > state.chat_limit.load(Ordering::SeqCst),
        error: state.chats_error.lock().unwrap().clone(),
    }
}

fn cache_user(app: &AppHandle, user: &tdlib_rs::types::User) {
    let payload = convert::user_to_payload(user);
    app.state::<AppState>().users.lock().unwrap().insert(user.id, payload.clone());
    let _ = app.emit("user", payload);
}

pub async fn ensure_senders(app: &AppHandle, messages: &[&tdlib_rs::types::Message]) {
    let state = app.state::<AppState>();
    let client_id = state.client_id.load(Ordering::SeqCst);
    let account = state.user.lock().unwrap().as_ref().map(|user| user.id);
    let same_session = || state.client_id.load(Ordering::SeqCst) == client_id && state.user.lock().unwrap().as_ref().map(|user| user.id) == account;
    let mut senders = std::collections::HashSet::new();
    for message in messages {
        let reply_origin = match &message.reply_to {
            Some(tdlib_rs::enums::MessageReplyTo::Message(reply)) => reply.origin.as_ref(),
            _ => None,
        };
        let forward_origin = message.forward_info.as_ref().map(|forward| &forward.origin);
        for origin in reply_origin.into_iter().chain(forward_origin) {
            use tdlib_rs::enums::MessageOrigin::*;
            match origin {
                User(origin) => { senders.insert((true, origin.sender_user_id)); }
                Chat(origin) => { senders.insert((false, origin.sender_chat_id)); }
                Channel(origin) => { senders.insert((false, origin.chat_id)); }
                HiddenUser(_) => {},
            }
        }
        match &message.content {
            tdlib_rs::enums::MessageContent::MessageChatAddMembers(event) => { for id in &event.member_user_ids { senders.insert((true, *id)); } }
            tdlib_rs::enums::MessageContent::MessageChatDeleteMember(event) => { senders.insert((true, event.user_id)); }
            _ => {},
        }
        match &message.sender_id {
            tdlib_rs::enums::MessageSender::User(sender) => { senders.insert((true, sender.user_id)); }
            tdlib_rs::enums::MessageSender::Chat(sender) => { senders.insert((false, sender.chat_id)); }
        }
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    for (is_user, id) in senders {
        if is_user {
            if state.users.lock().unwrap().contains_key(&id) { continue; }
            match tokio::time::timeout_at(deadline, tdlib_rs::functions::get_user(id, client_id)).await {
                Ok(Ok(tdlib_rs::enums::User::User(user))) if same_session() => cache_user(app, &user),
                Err(_) => break,
                _ => {},
            }
        } else {
            if state.chats.lock().unwrap().contains_key(&id) { continue; }
            match tokio::time::timeout_at(deadline, tdlib_rs::functions::get_chat(id, client_id)).await {
                Ok(Ok(tdlib_rs::enums::Chat::Chat(chat))) if same_session() => upsert_chat(app, convert::chat_to_summary(&chat)),
                Err(_) => break,
                _ => {},
            }
        }
    }
}

pub(crate) fn enrich_sender(state: &AppState, sender: &mut crate::models::SenderData) {
    if sender.kind == "user" {
        if let Some(user) = state.users.lock().unwrap().get(&sender.id) {
            sender.name = format!("{} {}", user.first_name, user.last_name).trim().into();
            sender.first_name = Some(user.first_name.clone());
            sender.photo = user.photo.clone();
            sender.photo_file_id = user.photo_file_id;
        }
    } else if let Some(chat) = state.chats.lock().unwrap().get(&sender.id) {
        if sender.name.is_empty() { sender.name = chat.title.clone(); }
        sender.photo = chat.photo.clone();
        sender.photo_file_id = chat.photo_file_id;
    }
}

pub fn message_of(app: &AppHandle, message: &tdlib_rs::types::Message) -> crate::models::MsgData {
    let mut data = convert::message_to_data(message);
    let state = app.state::<AppState>();
    enrich_sender(&state, &mut data.sender);
    for sender in data.reactions.iter_mut().flat_map(|reaction| &mut reaction.recent_senders) { enrich_sender(&state, sender); }
    if let Some(origin) = data.forward_from.as_mut() && let Some(id) = origin.id {
        let name = if origin.kind == "user" {
            state.users.lock().unwrap().get(&id).map(|user| format!("{} {}", user.first_name, user.last_name).trim().to_owned())
        } else {
            state.chats.lock().unwrap().get(&id).map(|chat| chat.title.clone())
        };
        if let Some(name) = name.filter(|name| !name.is_empty()) { origin.name = name; }
    }
    if let crate::models::MsgContent::Event { members, .. } = &mut data.content {
        let users = state.users.lock().unwrap();
        for member in members {
            if let Some(user) = users.get(&member.id) {
                member.name = format!("{} {}", user.first_name, user.last_name).trim().into();
                member.photo = user.photo.clone();
                member.photo_file_id = user.photo_file_id;
            }
        }
    }
    if let (Some(reply_data), Some(tdlib_rs::enums::MessageReplyTo::Message(reply))) = (&mut data.reply_to, &message.reply_to) {
        match &reply.origin {
            Some(tdlib_rs::enums::MessageOrigin::User(origin)) => {
                if let Some(user) = state.users.lock().unwrap().get(&origin.sender_user_id) { reply_data.author = format!("{} {}", user.first_name, user.last_name).trim().into(); }
            }
            Some(tdlib_rs::enums::MessageOrigin::Chat(origin)) => {
                reply_data.author = origin.author_signature.clone();
                if reply_data.author.is_empty() { if let Some(chat) = state.chats.lock().unwrap().get(&origin.sender_chat_id) { reply_data.author = chat.title.clone(); } }
            }
            Some(tdlib_rs::enums::MessageOrigin::Channel(origin)) => {
                reply_data.author = origin.author_signature.clone();
                if reply_data.author.is_empty() { if let Some(chat) = state.chats.lock().unwrap().get(&origin.chat_id) { reply_data.author = chat.title.clone(); } }
            }
            _ => {},
        }
    }
    state.archive.lock().unwrap().remember(data.clone());
    data
}

#[cfg(test)]
mod tests {
    use super::sorted_page;
    use crate::models::ChatSummary;

    #[test]
    fn limits_cached_chats_and_keeps_telegram_order() {
        let chats = (1..=151).map(|id| (id, ChatSummary {
            id, order: id, ..Default::default()
        })).collect();
        let first = sorted_page(&chats, 50, 0);
        assert_eq!(first.len(), 50);
        assert_eq!(first.first().unwrap().id, 151);
        assert_eq!(first.last().unwrap().id, 102);
        assert_eq!(sorted_page(&chats, 100, 0).len(), 100);
    }

    #[test]
    fn excludes_chats_outside_the_main_list_and_breaks_ties_by_id() {
        let chats = [
            (1, ChatSummary { id: 1, order: 10, ..Default::default() }),
            (2, ChatSummary { id: 2, order: 10, ..Default::default() }),
            (3, ChatSummary { id: 3, order: 0, ..Default::default() }),
        ].into_iter().collect();
        let ids: Vec<_> = sorted_page(&chats, 50, 0).iter().map(|chat| chat.id).collect();
        assert_eq!(ids, vec![2, 1]);
    }

    #[test]
    fn uses_folder_positions_instead_of_main_list_positions() {
        use crate::models::ChatPositionData;
        let chats = [
            (1, ChatSummary { id: 1, order: 100, positions: vec![ChatPositionData { folder_id: 7, order: 10, is_pinned: false }], ..Default::default() }),
            (2, ChatSummary { id: 2, order: 1, positions: vec![ChatPositionData { folder_id: 7, order: 20, is_pinned: true }], ..Default::default() }),
            (3, ChatSummary { id: 3, order: 200, ..Default::default() }),
        ].into_iter().collect();
        let page = sorted_page(&chats, 50, 7);
        assert_eq!(page.iter().map(|chat| chat.id).collect::<Vec<_>>(), vec![2, 1]);
        assert_eq!(page[0].order, 20);
        assert!(page[0].is_pinned);
    }
}
