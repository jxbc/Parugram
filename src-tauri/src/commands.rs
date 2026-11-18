// Tauri-команды: то, что вызывает фронтенд через invoke().
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::models::{AppSnapshot, ChatPrivacy, ChatSummary, FileData, MsgData, NotificationPreferences, PlaybackKind, ProfileData, ProfileMedia, ProfilePhotos, ProfileTarget, SenderData};
use crate::state::AppState;
use crate::td::worker;
use crate::models::{AttachmentData, MessageActions, VideoInfo};

fn client_id(state: &State<AppState>) -> Result<i32, String> {
    if !state.app_lock.lock().unwrap().is_unlocked() { return Err("Приложение заблокировано".into()); }
    let id = state.client_id.load(Ordering::SeqCst);
    if id == 0 {
        Err("TDLib ещё не запущен".into())
    } else {
        Ok(id)
    }
}

/// У tdlib-rs Error не реализует Display — форматируем вручную.
fn tderr(e: tdlib_rs::types::Error) -> String {
    format!("TDLib error {}: {}", e.code, e.message)
}

fn ready_client_id(state: &State<AppState>) -> Result<i32, String> {
    if !state.chats_ready() {
        return Err("Дождитесь обновления чатов".into());
    }
    client_id(state)
}

#[tauri::command]
pub fn app_snapshot(app: AppHandle, state: State<AppState>) -> Result<AppSnapshot, String> {
    if !state.app_lock.lock().unwrap().is_unlocked() { return Err("Приложение заблокировано".into()); }
    Ok(AppSnapshot {
        auth: state.auth_payload(),
        chats: worker::chat_list(&app),
        connection: state.connection.lock().unwrap().clone(),
        folders: state.folder_list(),
        save_deleted: state.archive.lock().unwrap().enabled(),
        skip_read: state.skip_read.load(Ordering::SeqCst),
        chat_privacy: *state.chat_privacy.lock().unwrap(),
        notifications: *state.notifications.lock().unwrap(),
    })
}

#[tauri::command]
pub fn app_lock_status(state: State<AppState>) -> Result<crate::app_lock::LockStatus, String> {
    state.app_lock.lock().unwrap().status()
}

pub(crate) fn request_lock_logout(app: &AppHandle) {
    let cid = app.state::<AppState>().client_id.load(Ordering::SeqCst);
    if cid == 0 { return; }
    tauri::async_runtime::spawn(async move {
        let _ = tdlib_rs::functions::log_out(cid).await;
    });
}

#[tauri::command]
pub async fn unlock_app(app: AppHandle, secret: String) -> Result<crate::app_lock::LockResult, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut lock = state.app_lock.lock().unwrap();
        let accepted = lock.unlock(&secret)?;
        Ok::<_, String>(crate::app_lock::LockResult { accepted, status: lock.status()? })
    }).await.map_err(|_| "Не удалось разблокировать приложение")??;
    let _ = app.emit("app-lock", &result.status);
    if result.status.logout_pending { request_lock_logout(&app); }
    Ok(result)
}

#[tauri::command]
pub async fn set_app_lock(app: AppHandle, current: String, kind: Option<String>, secret: String) -> Result<crate::app_lock::LockResult, String> {
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut lock = state.app_lock.lock().unwrap();
        let accepted = lock.set_secret(&current, kind.as_deref(), &secret)?;
        Ok::<_, String>(crate::app_lock::LockResult { accepted, status: lock.status()? })
    }).await.map_err(|_| "Не удалось сохранить пароль")??;
    let _ = app.emit("app-lock", &result.status);
    if result.status.logout_pending { request_lock_logout(&app); }
    Ok(result)
}

#[tauri::command]
pub fn acknowledge_lock_logout(state: State<AppState>) -> Result<crate::app_lock::LockStatus, String> {
    let mut lock = state.app_lock.lock().unwrap();
    lock.acknowledge_logout()?;
    lock.status()
}

#[tauri::command]
pub async fn set_phone(app: AppHandle, state: State<'_, AppState>, phone: String) -> Result<(), String> {
    let suspended = state.app_lock.lock().unwrap().session_suspended();
    if suspended {
        let cid = state.client_id.load(Ordering::SeqCst);
        if cid == 0 { return Err("Сессия недоступна".into()); }
        let tdlib_rs::enums::User::User(user) = tdlib_rs::functions::get_me(cid).await.map_err(tderr)?;
        let supplied: String = phone.chars().filter(|character| character.is_ascii_digit()).collect();
        let actual: String = user.phone_number.chars().filter(|character| character.is_ascii_digit()).collect();
        if supplied.is_empty() || supplied != actual { return Err("Для входа в другой аккаунт полностью закройте приложение".into()); }
        let mut lock = state.app_lock.lock().unwrap();
        lock.request_session_resume()?;
        let _ = app.emit("app-lock", lock.status()?);
        return Ok(());
    }
    let cid = client_id(&state)?;
    tdlib_rs::functions::set_authentication_phone_number(phone, None, cid)
        .await
        .map_err(tderr)
}

#[tauri::command]
pub async fn set_code(state: State<'_, AppState>, code: String) -> Result<(), String> {
    let cid = client_id(&state)?;
    tdlib_rs::functions::check_authentication_code(code, cid)
        .await
        .map_err(tderr)
}

#[tauri::command]
pub async fn request_qr_login(state: State<'_, AppState>) -> Result<(), String> {
    let cid = client_id(&state)?;
    if !state.is_stage("wait_phone") { return Err("Не удалось начать вход по QR-коду".into()); }
    tdlib_rs::functions::request_qr_code_authentication(Vec::new(), cid).await.map_err(tderr)
}

#[tauri::command]
pub async fn cancel_qr_login(state: State<'_, AppState>) -> Result<(), String> {
    let cid = client_id(&state)?;
    let tx = state.worker_tx.lock().unwrap().clone().ok_or("TDLib ещё не запущен")?;
    let (reply, received) = tokio::sync::oneshot::channel();
    tx.send(worker::WorkerEvent::CancelQrLogin(cid, reply)).map_err(|_| "TDLib остановлен")?;
    received.await.map_err(|_| "TDLib остановлен")?
}

#[tauri::command]
pub async fn set_password(state: State<'_, AppState>, password: String) -> Result<(), String> {
    let cid = client_id(&state)?;
    tdlib_rs::functions::check_authentication_password(password, cid)
        .await
        .map_err(tderr)
}

#[tauri::command]
pub async fn register_user(
    state: State<'_, AppState>,
    first_name: String,
    last_name: String,
) -> Result<(), String> {
    let cid = client_id(&state)?;
    tdlib_rs::functions::register_user(first_name, last_name, false, cid)
        .await
        .map_err(tderr)
}

#[tauri::command]
pub async fn load_more_chats(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    client_id(&state)?;
    if !state.is_stage("ready") {
        return Err("Войдите в аккаунт".into());
    }
    worker::refresh_chats(&app, true).await
}

#[tauri::command]
pub async fn select_folder(app: AppHandle, state: State<'_, AppState>, folder_id: i32) -> Result<bool, String> {
    client_id(&state)?;
    if !state.is_stage("ready") { return Err("Войдите в аккаунт".into()); }
    if folder_id != 0 && folder_id != -1 && !state.folders.lock().unwrap().iter().any(|folder| folder.id == folder_id) {
        return Err("Папка недоступна".into());
    }
    state.active_folder.store(folder_id, Ordering::SeqCst);
    state.chat_limit.store(50, Ordering::SeqCst);
    state.chats_loaded.store(false, Ordering::SeqCst);
    state.has_more_chats.store(true, Ordering::SeqCst);
    *state.chats_error.lock().unwrap() = None;
    worker::emit_chats(&app);
    worker::refresh_chats(&app, false).await
}

#[tauri::command]
pub async fn private_chat(state: State<'_, AppState>, user_id: i64) -> Result<ChatSummary, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::create_private_chat(user_id, false, cid).await.map_err(tderr)?;
    Ok(crate::td::convert::chat_to_summary(&chat))
}

#[tauri::command]
pub async fn open_message_content(state: State<'_, AppState>, chat_id: i64, message_id: i64, kind: PlaybackKind) -> Result<(), String> {
    let cid = ready_client_id(&state)?;
    if state.chat_privacy.lock().unwrap().hides_playback(kind) { return Ok(()); }
    tdlib_rs::functions::open_message_content(chat_id, message_id, cid).await.map_err(tderr)
}

#[tauri::command]
pub async fn send_chat_action(state: State<'_, AppState>, chat_id: i64, thread_id: Option<i64>, action: String, manual: bool) -> Result<(), String> {
    use tdlib_rs::{enums::ChatAction as Action, types};
    let cid = ready_client_id(&state)?;
    if action == "typing" && !manual && state.chat_privacy.lock().unwrap().hide_typing { return Ok(()); }
    let action = match action.as_str() {
        "typing" => Some(Action::Typing),
        "uploading_file" => Some(Action::UploadingDocument(types::ChatActionUploadingDocument { progress: 0 })),
        "uploading_photo" => Some(Action::UploadingPhoto(types::ChatActionUploadingPhoto { progress: 0 })),
        "uploading_video" => Some(Action::UploadingVideo(types::ChatActionUploadingVideo { progress: 0 })),
        "recording_voice" => Some(Action::RecordingVoiceNote),
        "recording_video_note" => Some(Action::RecordingVideoNote),
        "choosing_sticker" => Some(Action::ChoosingSticker),
        "cancel" => None,
        _ => return Err("Статус недоступен".into()),
    };
    tdlib_rs::functions::send_chat_action(chat_id, message_topic(thread_id), action, cid).await.map_err(tderr)
}

#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>, target: ProfileTarget) -> Result<ProfileData, String> {
    let cid = ready_client_id(&state)?;
    let mut user_id = if target.kind == "user" { Some(target.id) } else { None };
    let mut chat = if target.kind == "username" {
        let username = target.username.trim().trim_start_matches('@').to_string();
        let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::search_public_chat(username, cid).await.map_err(tderr)?;
        Some(chat)
    } else if target.kind == "chat" {
        let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(target.id, cid).await.map_err(tderr)?;
        Some(chat)
    } else if target.kind == "user" { None } else { return Err("Профиль недоступен".into()); };
    if let Some(chat) = &chat {
        match &chat.r#type {
            tdlib_rs::enums::ChatType::Private(private) => user_id = Some(private.user_id),
            tdlib_rs::enums::ChatType::Secret(secret) => user_id = Some(secret.user_id),
            _ => {},
        }
    }
    if let Some(id) = user_id {
        let tdlib_rs::enums::User::User(user) = tdlib_rs::functions::get_user(id, cid).await.map_err(tderr)?;
        let tdlib_rs::enums::UserFullInfo::UserFullInfo(full) = tdlib_rs::functions::get_user_full_info(id, cid).await.map_err(tderr)?;
        if chat.is_none() {
            let tdlib_rs::enums::Chat::Chat(private) = tdlib_rs::functions::create_private_chat(id, false, cid).await.map_err(tderr)?;
            chat = Some(private);
        }
        let payload = crate::td::convert::user_to_payload(&user);
        state.users.lock().unwrap().insert(id, payload.clone());
        let (status, last_seen) = match &user.status {
            tdlib_rs::enums::UserStatus::Online(_) => ("в сети", None),
            tdlib_rs::enums::UserStatus::Offline(offline) => ("", Some(offline.was_online)),
            tdlib_rs::enums::UserStatus::Recently(_) => ("был(а) недавно", None),
            tdlib_rs::enums::UserStatus::LastWeek(_) => ("был(а) на этой неделе", None),
            tdlib_rs::enums::UserStatus::LastMonth(_) => ("был(а) в этом месяце", None),
            _ => ("был(а) давно", None),
        };
        let bio = full.bio.as_ref().map(|bio| bio.text.clone())
            .or_else(|| full.bot_info.as_ref().map(|bot| bot.description.clone())).unwrap_or_default();
        let bio_entities = full.bio.as_ref().map(crate::td::convert::entities_to_data).unwrap_or_default();
        let is_bot = matches!(user.r#type, tdlib_rs::enums::UserType::Bot(_));
        return Ok(ProfileData {
            kind: "user".into(), id, title: format!("{} {}", user.first_name, user.last_name).trim().into(),
            status: if is_bot { "бот".into() } else { status.into() }, last_seen,
            photo: user.profile_photo.as_ref().and_then(|photo| crate::td::convert::file_to_data(&photo.big).local_path), photo_file_id: user.profile_photo.as_ref().map(|photo| photo.big.id),
            bio, bio_entities, usernames: user.usernames.map(|names| names.active_usernames).unwrap_or_default(),
            phone: user.phone_number, birthdate: full.birthdate, is_premium: user.is_premium,
            is_verified: user.verification_status.is_some_and(|status| status.is_verified),
            common_groups: full.group_in_common_count,
            chat: crate::td::convert::chat_to_summary(&chat.unwrap()), ..Default::default()
        });
    }
    let chat = chat.ok_or("Профиль недоступен")?;
    let mut profile = ProfileData {
        kind: "chat".into(), id: chat.id, title: chat.title.clone(),
        photo: chat.photo.as_ref().and_then(|photo| crate::td::convert::file_to_data(&photo.big).local_path),
        photo_file_id: chat.photo.as_ref().map(|photo| photo.big.id),
        chat: crate::td::convert::chat_to_summary(&chat), ..Default::default()
    };
    match &chat.r#type {
        tdlib_rs::enums::ChatType::BasicGroup(group) => {
            let tdlib_rs::enums::BasicGroupFullInfo::BasicGroupFullInfo(full) = tdlib_rs::functions::get_basic_group_full_info(group.basic_group_id, cid).await.map_err(tderr)?;
            profile.bio = full.description;
            profile.member_count = full.members.len() as i32;
            profile.can_view_members = true;
            profile.status = "группа".into();
        }
        tdlib_rs::enums::ChatType::Supergroup(group) => {
            let (info, full) = tokio::try_join!(
                tdlib_rs::functions::get_supergroup(group.supergroup_id, cid),
                tdlib_rs::functions::get_supergroup_full_info(group.supergroup_id, cid)
            ).map_err(tderr)?;
            let tdlib_rs::enums::Supergroup::Supergroup(info) = info;
            let tdlib_rs::enums::SupergroupFullInfo::SupergroupFullInfo(full) = full;
            profile.bio = full.description;
            profile.member_count = full.member_count;
            profile.can_view_members = full.can_get_members;
            profile.usernames = info.usernames.map(|names| names.active_usernames).unwrap_or_default();
            profile.is_verified = info.verification_status.is_some_and(|status| status.is_verified);
            profile.status = if group.is_channel { "канал" } else { "группа" }.into();
        }
        _ => {},
    }
    Ok(profile)
}

#[tauri::command]
pub async fn profile_media(app: AppHandle, state: State<'_, AppState>, chat_id: i64, category: String, from_message_id: i64, limit: Option<i32>) -> Result<ProfileMedia, String> {
    let cid = ready_client_id(&state)?;
    use tdlib_rs::enums::SearchMessagesFilter as F;
    let filter = match category.as_str() {
        "media" => F::PhotoAndVideo, "photos" => F::Photo, "files" => F::Document, "voice" => F::VoiceNote, "links" => F::Url,
        _ => return Err("Неизвестная категория".into()),
    };
    let tdlib_rs::enums::FoundChatMessages::FoundChatMessages(found) = tdlib_rs::functions::search_chat_messages(
        chat_id, None, String::new(), None, from_message_id, 0, limit.unwrap_or(20).clamp(1, 50), Some(filter), cid
    ).await.map_err(tderr)?;
    let refs: Vec<_> = found.messages.iter().collect();
    worker::ensure_senders(&app, &refs).await;
    Ok(ProfileMedia {
        messages: found.messages.iter().map(|message| worker::message_of(&app, message)).collect(),
        next_from_message_id: found.next_from_message_id, total_count: found.total_count,
    })
}

#[tauri::command]
pub async fn message_thread(app: AppHandle, state: State<'_, AppState>, chat_id: i64, message_id: i64) -> Result<crate::models::ThreadData, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::MessageThreadInfo::MessageThreadInfo(info) = tdlib_rs::functions::get_message_thread(chat_id, message_id, cid).await.map_err(tderr)?;
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(info.chat_id, cid).await.map_err(tderr)?;
    worker::ensure_senders(&app, &info.messages.iter().collect::<Vec<_>>()).await;
    Ok(crate::models::ThreadData {
        chat: crate::td::convert::chat_to_summary(&chat), thread_id: info.message_thread_id,
        roots: info.messages.iter().map(|message| worker::message_of(&app, message)).collect(),
        reply_count: info.reply_info.as_ref().map_or(0, |info| info.reply_count),
        unread_count: info.unread_message_count,
        last_read_inbox_message_id: info.reply_info.as_ref().map_or(0, |info| info.last_read_inbox_message_id),
    })
}

#[tauri::command]
pub async fn thread_history(app: AppHandle, state: State<'_, AppState>, chat_id: i64, thread_id: i64, from_message_id: i64, direction: String) -> Result<Vec<MsgData>, String> {
    let cid = ready_client_id(&state)?;
    let offset = match direction.as_str() { "older" => 0, "newer" => -49, "around" => -20, _ => return Err("История недоступна".into()) };
    let tdlib_rs::enums::Messages::Messages(page) = tdlib_rs::functions::get_message_thread_history(chat_id, thread_id, from_message_id, offset, 50, cid).await.map_err(tderr)?;
    let refs: Vec<_> = page.messages.iter().flatten().collect();
    worker::ensure_senders(&app, &refs).await;
    let mut messages: Vec<_> = refs.into_iter().filter(|message| from_message_id == 0 || direction == "around" || if direction == "newer" { message.id > from_message_id } else { message.id < from_message_id }).map(|message| worker::message_of(&app, message)).collect();
    messages.sort_by_key(|message| (message.date, message.id));
    Ok(messages)
}

#[tauri::command]
pub async fn resolve_telegram_link(state: State<'_, AppState>, url: String) -> Result<crate::models::TelegramLinkData, String> {
    let cid = ready_client_id(&state)?;
    let link = tdlib_rs::functions::get_internal_link_type(url, cid).await.map_err(tderr)?;
    let (chat_id, message_id) = match link {
        tdlib_rs::enums::InternalLinkType::Message(link) => {
            let tdlib_rs::enums::MessageLinkInfo::MessageLinkInfo(info) = tdlib_rs::functions::get_message_link_info(link.url, cid).await.map_err(tderr)?;
            if info.chat_id == 0 { return Err("Ссылка недоступна".into()); }
            (info.chat_id, info.message.map(|message| message.id))
        }
        tdlib_rs::enums::InternalLinkType::PublicChat(link) => {
            let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::search_public_chat(link.chat_username, cid).await.map_err(tderr)?;
            (chat.id, None)
        }
        _ => return Err("Ссылка не поддерживается".into()),
    };
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    Ok(crate::models::TelegramLinkData { chat: crate::td::convert::chat_to_summary(&chat), message_id })
}

#[tauri::command]
pub fn compact_chats(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    ready_client_id(&state)?;
    state.chat_limit.store(50, Ordering::SeqCst);
    worker::emit_chats(&app);
    Ok(())
}

#[tauri::command]
pub async fn sticker_catalog(state: State<'_, AppState>) -> Result<crate::models::StickerCatalog, String> {
    let cid = ready_client_id(&state)?;
    let (recent, sets) = tokio::try_join!(tdlib_rs::functions::get_recent_stickers(false, cid), tdlib_rs::functions::get_installed_sticker_sets(tdlib_rs::enums::StickerType::Regular, cid)).map_err(tderr)?;
    let tdlib_rs::enums::Stickers::Stickers(recent) = recent;
    let tdlib_rs::enums::StickerSets::StickerSets(sets) = sets;
    Ok(crate::models::StickerCatalog {
        recent: recent.stickers.iter().map(crate::td::convert::sticker_to_data).collect(),
        sets: sets.sets.iter().map(|set| crate::models::StickerSetData { id: set.id.to_string(), title: set.title.clone(), cover: set.covers.first().map(crate::td::convert::sticker_to_data) }).collect(),
    })
}

#[tauri::command]
pub async fn sticker_pack(state: State<'_, AppState>, set_id: String) -> Result<Vec<crate::models::StickerData>, String> {
    let cid = ready_client_id(&state)?;
    let id = set_id.parse::<i64>().ok().filter(|id| *id > 0).ok_or("Набор недоступен")?;
    let tdlib_rs::enums::StickerSet::StickerSet(set) = tdlib_rs::functions::get_sticker_set(id, cid).await.map_err(tderr)?;
    if !matches!(set.sticker_type, tdlib_rs::enums::StickerType::Regular) { return Err("Набор недоступен".into()); }
    Ok(set.stickers.iter().map(crate::td::convert::sticker_to_data).collect())
}

#[tauri::command]
pub async fn send_sticker(app: AppHandle, state: State<'_, AppState>, chat_id: i64, sticker: crate::models::StickerData, reply_to_message_id: Option<i64>, thread_id: Option<i64>) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    if sticker.file_id <= 0 { return Err("Стикер недоступен".into()); }
    let file = tdlib_rs::enums::InputFile::Id(tdlib_rs::types::InputFileId { id: sticker.file_id });
    let content = tdlib_rs::enums::InputMessageContent::InputMessageSticker(tdlib_rs::types::InputMessageSticker {
        sticker: file.clone(), thumbnail: None, width: sticker.width.clamp(0, 1024), height: sticker.height.clamp(0, 1024), emoji: sticker.emoji.chars().take(32).collect(),
    });
    let result = tauri::async_runtime::spawn(async move { tdlib_rs::functions::send_message(chat_id, message_topic(thread_id), reply_to(reply_to_message_id), None, content, cid).await }).await.map_err(|_| "Не удалось обработать ответ Telegram")?.map_err(tderr)?;
    let tdlib_rs::enums::Message::Message(message) = result;
    tauri::async_runtime::spawn(async move { let _ = tdlib_rs::functions::add_recent_sticker(false, file, cid).await; });
    Ok(worker::message_of(&app, &message))
}

#[tauri::command]
pub async fn pinned_messages(app: AppHandle, state: State<'_, AppState>, chat_id: i64, thread_id: Option<i64>, from_message_id: i64) -> Result<ProfileMedia, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::FoundChatMessages::FoundChatMessages(found) = tdlib_rs::functions::search_chat_messages(chat_id, message_topic(thread_id), String::new(), None, from_message_id, 0, 20, Some(tdlib_rs::enums::SearchMessagesFilter::Pinned), cid).await.map_err(tderr)?;
    worker::ensure_senders(&app, &found.messages.iter().collect::<Vec<_>>()).await;
    Ok(ProfileMedia { messages: found.messages.iter().map(|message| worker::message_of(&app, message)).collect(), next_from_message_id: found.next_from_message_id, total_count: found.total_count })
}

#[tauri::command]
pub async fn search_messages(app: AppHandle, state: State<'_, AppState>, chat_id: i64, query: String, from_message_id: i64, own: Option<bool>, thread_id: Option<i64>) -> Result<ProfileMedia, String> {
    let cid = ready_client_id(&state)?;
    let query = query.trim().chars().take(512).collect::<String>();
    let sender = if own == Some(true) {
        let user_id = state.user.lock().unwrap().as_ref().ok_or("Войдите в аккаунт")?.id;
        Some(tdlib_rs::enums::MessageSender::User(tdlib_rs::types::MessageSenderUser { user_id }))
    } else {
        None
    };
    if query.is_empty() && sender.is_none() { return Ok(ProfileMedia { messages: vec![], next_from_message_id: 0, total_count: 0 }); }
    let search = tdlib_rs::functions::search_chat_messages(chat_id, message_topic(thread_id), query, sender, from_message_id, 0, 30, None, cid).await;
    let tdlib_rs::enums::FoundChatMessages::FoundChatMessages(found) = match search {
        Ok(found) => found,
        Err(error) if own == Some(true) && thread_id.is_none() => {
            let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
            if !matches!(chat.r#type, tdlib_rs::enums::ChatType::Secret(_)) {
                return Err(tderr(error));
            }
            let mut messages = get_history(app, state, chat_id, from_message_id, 30).await?;
            let next_from_message_id = messages.first().map_or(0, |message| message.id);
            messages.reverse();
            return Ok(ProfileMedia { total_count: messages.len() as i32, messages, next_from_message_id });
        }
        Err(error) => return Err(tderr(error)),
    };
    worker::ensure_senders(&app, &found.messages.iter().collect::<Vec<_>>()).await;
    Ok(ProfileMedia { messages: found.messages.iter().map(|message| worker::message_of(&app, message)).collect(), next_from_message_id: found.next_from_message_id, total_count: found.total_count })
}

#[tauri::command]
pub async fn profile_photos(state: State<'_, AppState>, user_id: i64, offset: i32) -> Result<ProfilePhotos, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::ChatPhotos::ChatPhotos(photos) = tdlib_rs::functions::get_user_profile_photos(user_id, offset.max(0), 20, cid).await.map_err(tderr)?;
    Ok(ProfilePhotos {
        photos: photos.photos.iter().filter_map(|photo| photo.sizes.iter().max_by_key(|size| size.width * size.height))
            .map(|size| crate::td::convert::file_to_data(&size.photo)).collect(),
        total_count: photos.total_count,
    })
}

#[tauri::command]
pub async fn profile_members(state: State<'_, AppState>, chat_id: i64, offset: i32, online_only: Option<bool>) -> Result<Vec<SenderData>, String> {
    let cid = ready_client_id(&state)?;
    let online_only = online_only.unwrap_or(false);
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    let members = match chat.r#type {
        tdlib_rs::enums::ChatType::BasicGroup(group) => {
            let tdlib_rs::enums::BasicGroupFullInfo::BasicGroupFullInfo(full) = tdlib_rs::functions::get_basic_group_full_info(group.basic_group_id, cid).await.map_err(tderr)?;
            full.members.into_iter().skip(offset.max(0) as usize).take(if online_only { 200 } else { 50 }).collect()
        }
        tdlib_rs::enums::ChatType::Supergroup(group) => {
            let tdlib_rs::enums::ChatMembers::ChatMembers(members) = tdlib_rs::functions::get_supergroup_members(group.supergroup_id, Some(tdlib_rs::enums::SupergroupMembersFilter::Recent), offset.max(0), if online_only { 200 } else { 50 }, cid).await.map_err(tderr)?;
            members.members
        }
        _ => return Err("Участники недоступны".into()),
    };
    let mut result = Vec::new();
    for member in members {
        if let tdlib_rs::enums::MessageSender::User(sender) = member.member_id {
            let tdlib_rs::enums::User::User(user) = tdlib_rs::functions::get_user(sender.user_id, cid).await.map_err(tderr)?;
            if online_only && !matches!(user.status, tdlib_rs::enums::UserStatus::Online(_)) { continue; }
            let user = crate::td::convert::user_to_payload(&user);
            result.push(SenderData {
                kind: "user".into(), id: user.id, name: format!("{} {}", user.first_name, user.last_name).trim().into(),
                first_name: Some(user.first_name),
                photo: user.photo, photo_file_id: user.photo_file_id,
            });
        }
    }
    Ok(result)
}

#[tauri::command]
pub fn set_skip_read(state: State<AppState>, enabled: bool) -> Result<bool, String> {
    client_id(&state)?;
    state.set_skip_read(enabled)
}

#[tauri::command]
pub fn set_chat_privacy(state: State<AppState>, preferences: ChatPrivacy) -> Result<ChatPrivacy, String> {
    client_id(&state)?;
    state.set_chat_privacy(preferences)
}

#[tauri::command]
pub fn set_notifications(state: State<AppState>, preferences: NotificationPreferences) -> Result<NotificationPreferences, String> {
    client_id(&state)?;
    state.set_notifications(preferences)
}

#[tauri::command]
pub async fn mention_members(state: State<'_, AppState>, chat_id: i64, query: String) -> Result<Vec<crate::models::UserPayload>, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::ChatMembers::ChatMembers(found) = tdlib_rs::functions::search_chat_members(chat_id, query.trim_start_matches('@').chars().take(64).collect(), 20,
        Some(tdlib_rs::enums::ChatMembersFilter::Mention(tdlib_rs::types::ChatMembersFilterMention { topic_id: None })), cid).await.map_err(tderr)?;
    let mut users = Vec::new();
    for member in found.members {
        if let tdlib_rs::enums::MessageSender::User(sender) = member.member_id {
            let tdlib_rs::enums::User::User(user) = tdlib_rs::functions::get_user(sender.user_id, cid).await.map_err(tderr)?;
            let user = crate::td::convert::user_to_payload(&user);
            state.users.lock().unwrap().insert(user.id, user.clone());
            users.push(user);
        }
    }
    Ok(users)
}

#[tauri::command]
pub async fn open_chat_window(app: AppHandle, state: State<'_, AppState>, chat_id: i64) -> Result<(), String> {
    let mut sequence = state.chat_windows.lock().await;
    let cid = ready_client_id(&state)?;
    let prefix = format!("chat-{chat_id}_");
    if let Some((_, window)) = app.webview_windows().into_iter().find(|(label, _)| label.starts_with(&prefix)) {
        window.unminimize().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    *sequence += 1;
    WebviewWindowBuilder::new(&app, format!("{prefix}{sequence}"), WebviewUrl::App("index.html".into()))
        .title(chat.title)
        .decorations(false)
        .inner_size(480.0, 680.0)
        .min_inner_size(320.0, 420.0)
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn chat_window_chat(window: WebviewWindow, state: State<'_, AppState>) -> Result<ChatSummary, String> {
    let chat_id = window.label().strip_prefix("chat-")
        .and_then(|label| label.split_once('_'))
        .and_then(|(id, _)| id.parse().ok())
        .ok_or("Чат для окна не найден")?;
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    Ok(crate::td::convert::chat_to_summary(&chat))
}

#[tauri::command]
pub async fn open_chat(window: WebviewWindow, state: State<'_, AppState>, chat_id: i64) -> Result<(), String> {
    let mut open_chats = state.open_chats.lock().await;
    let cid = ready_client_id(&state)?;
    let label = window.label();
    if window.app_handle().get_webview_window(label).is_none() { return Err("Окно закрыто".into()); }
    let chats = open_chats.entry(label.into()).or_default();
    if chats.get(&chat_id) != Some(&cid) {
        tdlib_rs::functions::open_chat(chat_id, cid).await.map_err(tderr)?;
        chats.insert(chat_id, cid);
    }
    Ok(())
}

#[tauri::command]
pub async fn close_chat(window: WebviewWindow, state: State<'_, AppState>, chat_id: i64) -> Result<(), String> {
    let mut open_chats = state.open_chats.lock().await;
    let cid = state.client_id.load(Ordering::SeqCst);
    if open_chats.get_mut(window.label()).and_then(|chats| chats.remove(&chat_id)) == Some(cid) && cid != 0 {
        tdlib_rs::functions::close_chat(chat_id, cid).await.map_err(tderr)?;
    }
    Ok(())
}

pub(crate) async fn close_window_chats(app: AppHandle, label: String) {
    let state = app.state::<AppState>();
    let mut open_chats = state.open_chats.lock().await;
    if let Some(chats) = open_chats.remove(&label) {
        for (chat_id, cid) in chats {
            if cid == state.client_id.load(Ordering::SeqCst) {
                let _ = tdlib_rs::functions::close_chat(chat_id, cid).await;
            }
        }
    }
}

#[tauri::command]
pub async fn view_messages(state: State<'_, AppState>, chat_id: i64, message_ids: Vec<i64>) -> Result<bool, String> {
    let cid = ready_client_id(&state)?;
    if state.skip_read.load(Ordering::SeqCst) { return Ok(false); }
    tdlib_rs::functions::view_messages(chat_id, message_ids, Some(tdlib_rs::enums::MessageSource::ChatHistory), false, cid)
        .await.map_err(tderr)?;
    Ok(true)
}

#[tauri::command]
pub async fn get_history(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: i64,
    from_message_id: i64,
    limit: i32,
) -> Result<Vec<MsgData>, String> {
    let cid = ready_client_id(&state)?;
    let limit = (limit + i32::from(from_message_id != 0)).clamp(1, 100);
    let result = tdlib_rs::functions::get_chat_history(chat_id, from_message_id, 0, limit, false, cid)
        .await
        .map_err(tderr)?;

    let tdlib_rs::enums::Messages::Messages(messages) = result;
    let references: Vec<_> = messages.messages.iter().flatten().collect();
    worker::ensure_senders(&app, &references).await;

    // TDLib отдаёт историю «новые первыми» — разворачиваем в хронологический порядок.
    let mut data: Vec<MsgData> = messages
        .messages
        .iter()
        .flatten()
        .filter(|m| from_message_id == 0 || m.id < from_message_id)
        .map(|message| worker::message_of(&app, message))
        .collect();
    data.reverse();
    Ok(data)
}

#[tauri::command]
pub async fn get_message(app: AppHandle, state: State<'_, AppState>, chat_id: i64, message_id: i64) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    if let Some(message) = state.archive.lock().unwrap().find_deleted(chat_id, message_id) { return Ok(message); }
    let tdlib_rs::enums::Message::Message(message) = tdlib_rs::functions::get_message(chat_id, message_id, cid).await.map_err(tderr)?;
    worker::ensure_senders(&app, &[&message]).await;
    Ok(worker::message_of(&app, &message))
}

#[tauri::command]
pub async fn message_context(app: AppHandle, state: State<'_, AppState>, chat_id: i64, message_id: i64, include_target: Option<bool>) -> Result<Vec<MsgData>, String> {
    let cid = ready_client_id(&state)?;
    let saved = state.archive.lock().unwrap().find_deleted(chat_id, message_id);
    let tdlib_rs::enums::Messages::Messages(messages) = tdlib_rs::functions::get_chat_history(chat_id, message_id, -20, 50, false, cid).await.map_err(tderr)?;
    let references: Vec<_> = messages.messages.iter().flatten().collect();
    worker::ensure_senders(&app, &references).await;
    let mut data: Vec<_> = references.into_iter().map(|message| worker::message_of(&app, message)).collect();
    if let Some(saved) = saved { data.retain(|message| message.id != message_id); data.push(saved); }
    if include_target.unwrap_or(true) && !data.iter().any(|message| message.id == message_id) {
        let tdlib_rs::enums::Message::Message(message) = tdlib_rs::functions::get_message(chat_id, message_id, cid).await.map_err(tderr)?;
        worker::ensure_senders(&app, &[&message]).await;
        data.push(worker::message_of(&app, &message));
    }
    data.sort_by_key(|message| (message.date, message.id));
    Ok(data)
}

#[tauri::command]
pub async fn newer_messages(app: AppHandle, state: State<'_, AppState>, chat_id: i64, from_message_id: i64) -> Result<Vec<MsgData>, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Messages::Messages(messages) = tdlib_rs::functions::get_chat_history(chat_id, from_message_id, -49, 50, false, cid).await.map_err(tderr)?;
    let references: Vec<_> = messages.messages.iter().flatten().filter(|message| message.id > from_message_id).collect();
    worker::ensure_senders(&app, &references).await;
    let mut data: Vec<_> = references.into_iter().map(|message| worker::message_of(&app, message)).collect();
    data.sort_by_key(|message| (message.date, message.id));
    Ok(data)
}

#[tauri::command]
pub async fn available_reactions(state: State<'_, AppState>, chat_id: i64, message_id: i64) -> Result<Vec<crate::models::ReactionData>, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::AvailableReactions::AvailableReactions(available) = tdlib_rs::functions::get_message_available_reactions(chat_id, message_id, 8, cid).await.map_err(tderr)?;
    if available.unavailability_reason.is_some() { return Ok(Vec::new()); }
    let mut keys = std::collections::HashSet::new();
    Ok(available.top_reactions.into_iter().chain(available.recent_reactions).chain(available.popular_reactions).filter_map(|reaction| {
        let mut data = crate::td::convert::reaction_to_data(&reaction.r#type);
        data.needs_premium = reaction.needs_premium;
        if data.key == "paid" || !keys.insert(data.key.clone()) { None } else { Some(data) }
    }).collect())
}

#[tauri::command]
pub async fn reaction_senders(state: State<'_, AppState>, chat_id: i64, message_id: i64, key: String, offset: String) -> Result<crate::models::ReactionSendersPage, String> {
    use tdlib_rs::{enums::{AddedReactions, Chat, User}, functions};
    let cid = ready_client_id(&state)?;
    let reaction = parse_reaction_key(&key)?;
    let AddedReactions::AddedReactions(page) = functions::get_message_added_reactions(chat_id, message_id, Some(reaction), offset, 30, cid).await.map_err(tderr)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
    let mut senders = Vec::with_capacity(page.reactions.len());
    for reaction in page.reactions {
        let mut sender = crate::td::convert::sender_to_data(&reaction.sender_id, "");
        worker::enrich_sender(&state, &mut sender);
        if sender.name.is_empty() && sender.kind == "user" {
            if let Ok(Ok(User::User(user))) = tokio::time::timeout_at(deadline, functions::get_user(sender.id, cid)).await {
                let user = crate::td::convert::user_to_payload(&user);
                sender.name = format!("{} {}", user.first_name, user.last_name).trim().to_owned();
                sender.photo = user.photo;
                sender.photo_file_id = user.photo_file_id;
            }
        } else if sender.name.is_empty() {
            if let Ok(Ok(Chat::Chat(chat))) = tokio::time::timeout_at(deadline, functions::get_chat(sender.id, cid)).await {
                let chat = crate::td::convert::chat_to_summary(&chat);
                sender.name = chat.title;
                sender.photo = chat.photo;
                sender.photo_file_id = chat.photo_file_id;
            }
        }
        senders.push(sender);
    }
    Ok(crate::models::ReactionSendersPage { senders, next_offset: page.next_offset })
}

fn parse_reaction_key(key: &str) -> Result<tdlib_rs::enums::ReactionType, String> {
    Ok(if let Some(emoji) = key.strip_prefix("emoji:").filter(|value| !value.is_empty()) {
        tdlib_rs::enums::ReactionType::Emoji(tdlib_rs::types::ReactionTypeEmoji { emoji: emoji.into() })
    } else if let Some(id) = key.strip_prefix("custom:").and_then(|value| value.parse::<i64>().ok()).filter(|id| *id != 0) {
        tdlib_rs::enums::ReactionType::CustomEmoji(tdlib_rs::types::ReactionTypeCustomEmoji { custom_emoji_id: id })
    } else { return Err("Реакция недоступна".into()); })
}

#[tauri::command]
pub async fn set_reaction(state: State<'_, AppState>, chat_id: i64, message_id: i64, key: String, add: bool) -> Result<(), String> {
    let cid = ready_client_id(&state)?;
    let reaction = parse_reaction_key(&key)?;
    if add { tdlib_rs::functions::add_message_reaction(chat_id, message_id, reaction, false, true, cid).await.map_err(tderr) }
    else { tdlib_rs::functions::remove_message_reaction(chat_id, message_id, reaction, cid).await.map_err(tderr) }
}

#[tauri::command]
pub async fn reaction_sticker(state: State<'_, AppState>, custom_emoji_id: String) -> Result<serde_json::Value, String> {
    let cid = ready_client_id(&state)?;
    let id = custom_emoji_id.parse::<i64>().map_err(|_| "Эмодзи недоступен")?;
    let tdlib_rs::enums::Stickers::Stickers(stickers) = tdlib_rs::functions::get_custom_emoji_stickers(vec![id], cid).await.map_err(tderr)?;
    let sticker = stickers.stickers.first().ok_or("Эмодзи недоступен")?;
    let file_id = if matches!(sticker.format, tdlib_rs::enums::StickerFormat::Webp) { Some(sticker.sticker.id) } else { sticker.thumbnail.as_ref().map(|thumbnail| thumbnail.file.id) };
    Ok(serde_json::json!({ "file_id": file_id, "emoji": sticker.emoji }))
}

#[tauri::command]
pub fn set_save_deleted(state: State<AppState>, enabled: bool, seen: Vec<MsgData>) -> Result<bool, String> {
    ready_client_id(&state)?;
    let user_id = state.user.lock().unwrap().as_ref().ok_or("Войдите в аккаунт")?.id;
    let mut archive = state.archive.lock().unwrap();
    archive.select_user(user_id)?;
    for message in seen { archive.remember(message); }
    archive.configure(enabled)?;
    Ok(archive.enabled())
}

#[tauri::command]
pub fn saved_deleted(state: State<AppState>, chat_id: i64) -> Result<Vec<MsgData>, String> {
    ready_client_id(&state)?;
    Ok(state.archive.lock().unwrap().deleted(chat_id))
}

#[tauri::command]
pub async fn send_text(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: i64,
    text: String,
    reply_to_message_id: Option<i64>,
    entities: Option<Vec<crate::models::TextEntityData>>,
    thread_id: Option<i64>,
) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    let content = tdlib_rs::enums::InputMessageContent::InputMessageText(
        tdlib_rs::types::InputMessageText {
            text: formatted_text(text, entities),
            link_preview_options: None,
            clear_draft: false,
        },
    );
    let result = tdlib_rs::functions::send_message(chat_id, message_topic(thread_id), reply_to(reply_to_message_id), None, content, cid)
        .await
        .map_err(tderr)?;
    let tdlib_rs::enums::Message::Message(message) = result;
    Ok(worker::message_of(&app, &message))
}

#[tauri::command]
pub async fn send_file(
    app: AppHandle,
    state: State<'_, AppState>,
    chat_id: i64,
    path: String,
    caption: Option<String>,
    reply_to_message_id: Option<i64>,
    video_info: Option<VideoInfo>,
    entities: Option<Vec<crate::models::TextEntityData>>,
    thread_id: Option<i64>,
) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    let attachment = attachment_data(&path)?;
    let content = attachment_content(&attachment, formatted_text(caption.unwrap_or_default(), entities), video_info.unwrap_or_default());
    let result = tdlib_rs::functions::send_message(chat_id, message_topic(thread_id), reply_to(reply_to_message_id), None, content, cid)
        .await
        .map_err(tderr)?;
    let tdlib_rs::enums::Message::Message(message) = result;
    Ok(worker::message_of(&app, &message))
}

fn reply_to(message_id: Option<i64>) -> Option<tdlib_rs::enums::InputMessageReplyTo> {
    message_id.filter(|id| *id > 0).map(|message_id| tdlib_rs::enums::InputMessageReplyTo::Message(
        tdlib_rs::types::InputMessageReplyToMessage { message_id, quote: None, checklist_task_id: 0 }
    ))
}

fn message_topic(thread_id: Option<i64>) -> Option<tdlib_rs::enums::MessageTopic> {
    thread_id.filter(|id| *id > 0).map(|message_thread_id| tdlib_rs::enums::MessageTopic::Thread(tdlib_rs::types::MessageTopicThread { message_thread_id }))
}

fn attachment_data(path: &str) -> Result<AttachmentData, String> {
    let path = std::fs::canonicalize(path).map_err(|_| "Файл недоступен")?;
    let metadata = std::fs::metadata(&path).map_err(|_| "Не удалось прочитать файл")?;
    if !metadata.is_file() { return Err("Выберите файл".into()); }
    let extension = path.extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default();
    let kind = if ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].contains(&extension.as_str()) { "photo" }
        else if ["mp4", "mov", "m4v", "webm", "mkv", "avi"].contains(&extension.as_str()) { "video" } else { "file" };
    let display_path = path.to_string_lossy();
    let file_path = if let Some(unc) = display_path.strip_prefix("\\\\?\\UNC\\") { format!("\\\\{unc}") }
        else { display_path.strip_prefix("\\\\?\\").unwrap_or(&display_path).to_string() };
    Ok(AttachmentData {
        file_name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        path: file_path, size: metadata.len(), kind: kind.into(),
    })
}

#[tauri::command]
pub fn install_wallpaper(app: AppHandle, state: State<AppState>, path: String) -> Result<String, String> {
    client_id(&state)?;
    let attachment = attachment_data(&path)?;
    if attachment.size > 20 * 1024 * 1024 { return Err("Фон должен быть не больше 20 МБ".into()); }
    let bytes = std::fs::read(&attachment.path).map_err(|_| "Не удалось прочитать изображение")?;
    let extension = clipboard_image_extension(&bytes)?;
    let directory = app.path().app_data_dir().map_err(|_| "Папка приложения недоступна")?.join("themes");
    std::fs::create_dir_all(&directory).map_err(|_| "Не удалось сохранить фон")?;
    let mut id = [0_u8; 8];
    getrandom::fill(&mut id).map_err(|_| "Не удалось сохранить фон")?;
    let target = directory.join(format!("wallpaper-{}.{extension}", u64::from_le_bytes(id)));
    std::fs::write(&target, bytes).map_err(|_| "Не удалось сохранить фон")?;
    app.asset_protocol_scope().allow_file(&target).map_err(|_| "Не удалось открыть фон")?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn prepare_attachment(app: AppHandle, path: String) -> Result<AttachmentData, String> {
    let attachment = attachment_data(&path)?;
    if attachment.kind != "file" {
        app.asset_protocol_scope().allow_file(&attachment.path).map_err(|_| "Не удалось открыть превью")?;
    }
    Ok(attachment)
}

fn clipboard_image_extension(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 { return Err("Фото должно быть не больше 20 МБ".into()); }
    let extension = match imagesize::image_type(bytes).map_err(|_| "Не удалось прочитать фото")? {
        imagesize::ImageType::Png => "png",
        imagesize::ImageType::Jpeg => "jpg",
        imagesize::ImageType::Webp => "webp",
        imagesize::ImageType::Gif => "gif",
        imagesize::ImageType::Bmp => "bmp",
        _ => return Err("Формат фото не поддерживается".into()),
    };
    let size = imagesize::blob_size(bytes).map_err(|_| "Не удалось прочитать фото")?;
    if size.width == 0 || size.height == 0 { return Err("Фото пустое".into()); }
    Ok(extension)
}

fn save_upload(app: AppHandle, bytes: &[u8], extension: &str, folder: &str) -> Result<AttachmentData, String> {
    use std::io::Write;
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let directory = app.path().app_data_dir().map_err(|_| "Папка приложения недоступна")?.join("tcache").join(folder);
    std::fs::create_dir_all(&directory).map_err(|_| "Не удалось сохранить вложение")?;
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "Не удалось сохранить вложение")?.as_nanos();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = directory.join(format!("{timestamp}-{sequence}.{extension}"));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "Не удалось сохранить вложение")?;
    if file.write_all(bytes).is_err() {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err("Не удалось сохранить вложение".into());
    }
    prepare_attachment(app, path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn prepare_clipboard_image(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<AttachmentData, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Фото недоступно".into()); };
    let extension = clipboard_image_extension(bytes)?;
    save_upload(app, bytes, extension, "photo")
}

#[tauri::command]
pub fn prepare_voice(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<AttachmentData, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Запись недоступна".into()); };
    if bytes.len() > 20 * 1024 * 1024 || !bytes.starts_with(b"OggS") || !bytes.windows(8).take(256).any(|part| part == b"OpusHead") {
        return Err("Не удалось прочитать голосовое сообщение".into());
    }
    let mut attachment = save_upload(app, bytes, "ogg", "audio")?;
    attachment.kind = "voice".into();
    Ok(attachment)
}

#[tauri::command]
pub async fn send_voice(app: AppHandle, state: State<'_, AppState>, chat_id: i64, path: String, duration: i32, caption: String, reply_to_message_id: Option<i64>, entities: Option<Vec<crate::models::TextEntityData>>, thread_id: Option<i64>) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    let attachment = attachment_data(&path)?;
    let content = tdlib_rs::enums::InputMessageContent::InputMessageVoiceNote(tdlib_rs::types::InputMessageVoiceNote {
        voice_note: tdlib_rs::enums::InputFile::Local(tdlib_rs::types::InputFileLocal { path: attachment.path }),
        duration: duration.max(1), waveform: String::new(),
        caption: (!caption.is_empty()).then(|| formatted_text(caption, entities)), self_destruct_type: None,
    });
    let tdlib_rs::enums::Message::Message(message) = tdlib_rs::functions::send_message(chat_id, message_topic(thread_id), reply_to(reply_to_message_id), None, content, cid).await.map_err(tderr)?;
    Ok(worker::message_of(&app, &message))
}

fn formatted_text(text: String, entities: Option<Vec<crate::models::TextEntityData>>) -> tdlib_rs::types::FormattedText {
    use tdlib_rs::{enums::TextEntityType as T, types};
    let mut boundaries = std::collections::HashSet::from([0_i32]);
    let mut offset = 0_i32;
    for character in text.chars() { offset += character.len_utf16() as i32; boundaries.insert(offset); }
    let mut supplied = entities.unwrap_or_default();
    supplied.sort_by_key(|entity| entity.offset);
    let mut link_end = 0;
    let entities = supplied.into_iter().filter_map(|entity| {
        let next = entity.offset.checked_add(entity.length)?;
        if entity.length <= 0 || !boundaries.contains(&entity.offset) || !boundaries.contains(&next) { return None; }
        let entity_type = match entity.kind.as_str() {
            "user" => T::MentionName(types::TextEntityTypeMentionName { user_id: entity.user_id.filter(|id| *id > 0)? }),
            "mention" => T::Mention,
            "url" if entity.value.is_empty() => T::Url,
            "url" => T::TextUrl(types::TextEntityTypeTextUrl { url: entity.value }),
            "bold" => T::Bold,
            "italic" => T::Italic,
            "underline" => T::Underline,
            "strikethrough" => T::Strikethrough,
            "spoiler" => T::Spoiler,
            "code" => T::Code,
            "pre" if entity.value.is_empty() => T::Pre,
            "pre" => T::PreCode(types::TextEntityTypePreCode { language: entity.value }),
            "quote" => T::BlockQuote,
            "expandable_quote" => T::ExpandableBlockQuote,
            _ => return None,
        };
        if matches!(entity_type, T::MentionName(_) | T::Mention | T::Url | T::TextUrl(_)) {
            if entity.offset < link_end { return None; }
            link_end = next;
        }
        Some(types::TextEntity { offset: entity.offset, length: entity.length, r#type: entity_type })
    }).collect();
    tdlib_rs::types::FormattedText { text, entities }
}

fn attachment_content(attachment: &AttachmentData, caption: tdlib_rs::types::FormattedText, info: VideoInfo) -> tdlib_rs::enums::InputMessageContent {
    use tdlib_rs::enums::{InputFile, InputMessageContent as C};
    let file = InputFile::Local(tdlib_rs::types::InputFileLocal { path: attachment.path.clone() });
    let caption = (!caption.text.is_empty()).then_some(caption);
    let extension = std::path::Path::new(&attachment.path).extension().map(|ext| ext.to_string_lossy().to_lowercase()).unwrap_or_default();
    if attachment.kind == "photo" && extension == "gif" {
        let (width, height) = imagesize::size(&attachment.path).map(|size| (size.width as i32, size.height as i32)).unwrap_or((0, 0));
        C::InputMessageAnimation(tdlib_rs::types::InputMessageAnimation {
            animation: file, thumbnail: None, added_sticker_file_ids: vec![], duration: 0, width, height, caption,
            show_caption_above_media: false, has_spoiler: false,
        })
    } else if attachment.kind == "photo" {
        let (width, height) = imagesize::size(&attachment.path).map(|size| (size.width as i32, size.height as i32)).unwrap_or((0, 0));
        C::InputMessagePhoto(tdlib_rs::types::InputMessagePhoto {
            photo: file, thumbnail: None, added_sticker_file_ids: vec![], width, height, caption,
            show_caption_above_media: false, self_destruct_type: None, has_spoiler: false,
        })
    } else if attachment.kind == "video" && ["mp4", "m4v", "mov"].contains(&extension.as_str()) {
        C::InputMessageVideo(tdlib_rs::types::InputMessageVideo {
            video: file, thumbnail: None, cover: None, start_timestamp: 0, added_sticker_file_ids: vec![],
            duration: info.duration.max(0), width: info.width.max(0), height: info.height.max(0), supports_streaming: true,
            caption, show_caption_above_media: false, self_destruct_type: None, has_spoiler: false,
        })
    } else {
        C::InputMessageDocument(tdlib_rs::types::InputMessageDocument {
            document: file, thumbnail: None, disable_content_type_detection: false, caption,
        })
    }
}

#[tauri::command]
pub async fn message_actions(state: State<'_, AppState>, chat_id: i64, message_id: i64) -> Result<MessageActions, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::MessageProperties::MessageProperties(properties) = tdlib_rs::functions::get_message_properties(chat_id, message_id, cid).await.map_err(tderr)?;
    Ok(MessageActions {
        can_reply: properties.can_be_replied, can_copy: properties.can_be_copied,
        can_edit: properties.can_be_edited, can_delete_for_self: properties.can_be_deleted_only_for_self,
        can_delete_for_all: properties.can_be_deleted_for_all_users,
        can_get_viewers: properties.can_get_viewers,
        can_forward: properties.can_be_forwarded,
        can_save: properties.can_be_saved,
    })
}

#[tauri::command]
pub async fn next_mention(state: State<'_, AppState>, chat_id: i64, after: Option<i64>) -> Result<Option<i64>, String> {
    let cid = ready_client_id(&state)?;
    use tdlib_rs::{enums::{FoundChatMessages, SearchMessagesFilter}, functions::search_chat_messages};
    for from in [after.unwrap_or(0), 0] {
        let FoundChatMessages::FoundChatMessages(found) = search_chat_messages(chat_id, None, String::new(), None, from, 0, 20, Some(SearchMessagesFilter::UnreadMention), cid).await.map_err(tderr)?;
        if let Some(message) = found.messages.iter().find(|message| message.id != from) { return Ok(Some(message.id)); }
        if from == 0 { break; }
    }
    Ok(None)
}

#[tauri::command]
pub async fn forward_targets(state: State<'_, AppState>, query: String) -> Result<Vec<ChatSummary>, String> {
    let cid = ready_client_id(&state)?;
    use tdlib_rs::{enums::{Chat, Chats, ChatType, ChatMemberStatus, Supergroup, BasicGroup}, functions};
    let Chats::Chats(found) = if query.trim().is_empty() {
        functions::get_chats(None, 50, cid).await
    } else {
        functions::search_chats(query.trim().chars().take(128).collect(), 50, cid).await
    }.map_err(tderr)?;
    let mut ids = found.chat_ids;
    let own_id = state.user.lock().unwrap().as_ref().map(|user| user.id);
    if (query.trim().is_empty() || "избранное".contains(&query.trim().to_lowercase()))
        && let Some(id) = own_id
        && let Ok(Chat::Chat(saved)) = functions::create_private_chat(id, false, cid).await {
        ids.retain(|id| *id != saved.id);
        ids.insert(0, saved.id);
    }
    let mut chats = Vec::new();
    for id in ids {
        if let Ok(Chat::Chat(chat)) = functions::get_chat(id, cid).await {
            let status = match &chat.r#type {
                ChatType::Supergroup(group) => functions::get_supergroup(group.supergroup_id, cid).await.ok().map(|Supergroup::Supergroup(group)| group.status),
                ChatType::BasicGroup(group) => functions::get_basic_group(group.basic_group_id, cid).await.ok().map(|BasicGroup::BasicGroup(group)| group.status),
                _ => None,
            };
            if matches!(status, Some(ChatMemberStatus::Left | ChatMemberStatus::Banned(_))) { continue; }
            if matches!(&chat.r#type, ChatType::Supergroup(group) if group.is_channel) {
                match status {
                    Some(ChatMemberStatus::Creator(_)) => {},
                    Some(ChatMemberStatus::Administrator(admin)) if admin.rights.can_post_messages => {},
                    _ => continue,
                }
            }
            chats.push(crate::td::convert::chat_to_summary(&chat));
        }
    }
    Ok(chats)
}

#[tauri::command]
pub async fn forward_message(app: AppHandle, state: State<'_, AppState>, chat_id: i64, from_chat_id: i64, message_id: i64) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Messages::Messages(result) = tdlib_rs::functions::forward_messages(chat_id, None, from_chat_id, vec![message_id], None, false, false, cid).await.map_err(tderr)?;
    let message = result.messages.into_iter().flatten().next().ok_or("Не удалось переслать сообщение")?;
    Ok(worker::message_of(&app, &message))
}

#[tauri::command]
pub async fn message_viewers(state: State<'_, AppState>, chat_id: i64, message_id: i64) -> Result<Vec<crate::models::UserPayload>, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::MessageViewers::MessageViewers(result) = tdlib_rs::functions::get_message_viewers(chat_id, message_id, cid).await.map_err(tderr)?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(4);
    let mut users = Vec::with_capacity(result.viewers.len());
    for viewer in result.viewers {
        let id = viewer.user_id;
        let cached = state.users.lock().unwrap().get(&id).cloned();
        let user = if let Some(user) = cached {
            user
        } else if let Ok(Ok(tdlib_rs::enums::User::User(user))) = tokio::time::timeout_at(deadline, tdlib_rs::functions::get_user(id, cid)).await {
            crate::td::convert::user_to_payload(&user)
        } else {
            crate::models::UserPayload { id, first_name: String::new(), last_name: String::new(), username: String::new(), photo: None, photo_file_id: None }
        };
        users.push(user);
    }
    Ok(users)
}

#[tauri::command]
pub async fn edit_message(app: AppHandle, state: State<'_, AppState>, chat_id: i64, message_id: i64, text: String, entities: Option<Vec<crate::models::TextEntityData>>) -> Result<MsgData, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Message::Message(original) = tdlib_rs::functions::get_message(chat_id, message_id, cid).await.map_err(tderr)?;
    let text = formatted_text(text, entities);
    let result = if matches!(original.content, tdlib_rs::enums::MessageContent::MessageText(_) | tdlib_rs::enums::MessageContent::MessageAnimatedEmoji(_)) {
        tdlib_rs::functions::edit_message_text(chat_id, message_id, tdlib_rs::enums::InputMessageContent::InputMessageText(tdlib_rs::types::InputMessageText {
            text, link_preview_options: None, clear_draft: false,
        }), cid).await
    } else {
        tdlib_rs::functions::edit_message_caption(chat_id, message_id, Some(text), false, cid).await
    }.map_err(tderr)?;
    let tdlib_rs::enums::Message::Message(message) = result;
    Ok(worker::message_of(&app, &message))
}

#[tauri::command]
pub async fn delete_message(state: State<'_, AppState>, chat_id: i64, message_id: i64, revoke: bool) -> Result<(), String> {
    let cid = ready_client_id(&state)?;
    tdlib_rs::functions::delete_messages(chat_id, vec![message_id], revoke, cid).await.map_err(tderr)
}

#[tauri::command]
pub async fn set_chat_muted(state: State<'_, AppState>, chat_id: i64, muted: bool) -> Result<(), String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    let mut settings = chat.notification_settings;
    settings.use_default_mute_for = false;
    settings.mute_for = if muted { i32::MAX } else { 0 };
    tdlib_rs::functions::set_chat_notification_settings(chat_id, settings, cid).await.map_err(tderr)
}

#[tauri::command]
pub async fn chat_action(app: AppHandle, state: State<'_, AppState>, chat_id: i64, folder_id: i32, action: String) -> Result<ChatSummary, String> {
    let cid = ready_client_id(&state)?;
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    match action.as_str() {
        "pin" => {
            let pinned = chat.positions.iter().any(|position| crate::td::convert::folder_id(&position.list) == folder_id && position.is_pinned);
            tdlib_rs::functions::toggle_chat_is_pinned(crate::td::convert::chat_list(folder_id), chat_id, !pinned, cid).await.map_err(tderr)?;
        }
        "archive" => {
            let archived = chat.positions.iter().any(|position| matches!(position.list, tdlib_rs::enums::ChatList::Archive) && position.order > 0);
            tdlib_rs::functions::add_chat_to_list(chat_id, crate::td::convert::chat_list(if archived { 0 } else { -1 }), cid).await.map_err(tderr)?;
        }
        "unread" => tdlib_rs::functions::toggle_chat_is_marked_as_unread(chat_id, !chat.is_marked_as_unread, cid).await.map_err(tderr)?,
        _ => return Err("Действие недоступно".into()),
    }
    let tdlib_rs::enums::Chat::Chat(chat) = tdlib_rs::functions::get_chat(chat_id, cid).await.map_err(tderr)?;
    let summary = crate::td::convert::chat_to_summary(&chat);
    state.chats.lock().unwrap().insert(chat_id, summary.clone());
    worker::emit_chats(&app);
    Ok(summary)
}

#[tauri::command]
pub async fn download_file(state: State<'_, AppState>, file_id: i32) -> Result<FileData, String> {
    let cid = client_id(&state)?;
    let result = tdlib_rs::functions::download_file(file_id, 1, 0, 0, true, cid)
        .await
        .map_err(tderr)?;
    let tdlib_rs::enums::File::File(file) = result;
    Ok(crate::td::convert::file_to_data(&file))
}

#[derive(serde::Serialize)]
pub struct DownloadSettings {
    drive: String,
    drives: Vec<String>,
    directory: String,
}

fn system_drive() -> String {
    std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_ascii_uppercase()
}

fn download_directory(app: &AppHandle, drive: Option<&str>) -> Result<std::path::PathBuf, String> {
    let directory = match drive {
        Some(drive) if matches!(drive.as_bytes(), [b'A'..=b'Z', b':']) => std::path::PathBuf::from(format!("{drive}\\")),
        Some(_) => return Err("Диск недоступен".into()),
        None => app.path().download_dir().map_err(|_| "Не найдена папка «Загрузки»")?,
    };
    Ok(directory.join("Parugram Downloads"))
}

#[tauri::command]
pub fn download_settings(app: AppHandle, state: State<'_, AppState>) -> Result<DownloadSettings, String> {
    let saved = state.download_drive.lock().unwrap();
    let system = system_drive();
    let drive = saved.clone().unwrap_or_else(|| system.clone());
    let mut drives: Vec<_> = (b'A'..=b'Z').map(|letter| format!("{}:", char::from(letter)))
        .filter(|candidate| candidate == &drive || candidate == &system || std::path::Path::new(&format!("{candidate}\\")).is_dir()).collect();
    drives.sort_unstable();
    let directory = download_directory(&app, saved.as_deref())?.to_string_lossy().into_owned();
    Ok(DownloadSettings { drive, drives, directory })
}

#[tauri::command]
pub fn set_download_drive(app: AppHandle, state: State<'_, AppState>, drive: String) -> Result<DownloadSettings, String> {
    if !state.app_lock.lock().unwrap().is_unlocked() { return Err("Приложение заблокировано".into()); }
    let drive = drive.to_ascii_uppercase();
    if !matches!(drive.as_bytes(), [b'A'..=b'Z', b':']) { return Err("Выберите диск".into()); }
    let selected = (drive != system_drive()).then_some(drive);
    if selected.as_ref().is_some_and(|disk| !std::path::Path::new(&format!("{disk}\\")).is_dir()) { return Err("Диск недоступен".into()); }
    let directory = download_directory(&app, selected.as_deref())?;
    std::fs::create_dir_all(&directory).map_err(|error| format!("Не удалось создать папку загрузок: {error}"))?;
    {
        let mut saved = state.download_drive.lock().unwrap();
        state.save_settings("download-settings.json", &selected).map_err(|_| "Не удалось сохранить диск загрузок")?;
        *saved = selected;
    }
    download_settings(app, state)
}

fn message_download(content: &crate::models::MsgContent) -> Option<(i32, String)> {
    use crate::models::MsgContent::*;
    let (file_id, name, fallback) = match content {
        Photo { file_id, .. } => (*file_id, "", format!("photo-{file_id}.jpg")),
        VideoNote { file_id, .. } => (*file_id, "", format!("video-note-{file_id}.mp4")),
        Voice { file_id, mime_type, .. } => {
            let ext = if mime_type == "audio/mpeg" { "mp3" } else if mime_type == "audio/mp4" { "m4a" } else { "ogg" };
            (*file_id, "", format!("voice-{file_id}.{ext}"))
        }
        Sticker { file_id, format, .. } => (*file_id, "", format!("sticker-{file_id}.{format}")),
        Video { file_id, file_name, .. } => (*file_id, file_name.as_str(), format!("video-{file_id}.mp4")),
        Animation { file_id, file_name, mime_type, .. } => {
            let ext = if mime_type == "image/gif" { "gif" } else { "mp4" };
            (*file_id, file_name.as_str(), format!("animation-{file_id}.{ext}"))
        }
        File { file_id, file_name, .. } | Audio { file_id, file_name, .. } => (*file_id, file_name.as_str(), format!("file-{file_id}")),
        _ => return None,
    };
    (file_id > 0).then(|| (file_id, download_name(name, &fallback)))
}

fn download_name(name: &str, fallback: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = name.chars().map(|ch| if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { ch }).collect();
    let clean = clean.trim().trim_end_matches(['.', ' ']);
    if clean.is_empty() { return fallback.into(); }
    let (stem, ext) = clean.rsplit_once('.').filter(|(stem, ext)| !stem.is_empty() && ext.chars().count() <= 16).unwrap_or((clean, ""));
    let mut stem: String = stem.chars().take(100).collect();
    let device = stem.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    if matches!(device.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
        || ["COM", "LPT"].iter().any(|prefix| device.strip_prefix(prefix).is_some_and(|suffix| matches!(suffix, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"))) {
        stem.insert(0, '_');
    }
    if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
}

#[derive(serde::Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum DownloadProgress {
    Downloading { file_name: String, downloaded: i64, size: i64 },
    Saving { file_name: String },
}

#[derive(serde::Serialize)]
pub struct SavedDownload {
    file_name: String,
    path: String,
}

#[tauri::command]
pub async fn save_message_file(app: AppHandle, state: State<'_, AppState>, chat_id: i64, message_id: i64, on_progress: tauri::ipc::Channel<DownloadProgress>) -> Result<SavedDownload, String> {
    use tdlib_rs::{enums::{File, Message}, functions};
    let cid = ready_client_id(&state)?;
    let drive = state.download_drive.lock().unwrap().clone();
    let directory = download_directory(&app, drive.as_deref())?;
    let Message::Message(message) = functions::get_message(chat_id, message_id, cid).await.map_err(tderr)?;
    if !message.can_be_saved { return Err("Сохранение этого сообщения недоступно".into()); }
    let (file_id, mut file_name) = message_download(&crate::td::convert::content_to_data(&message.content)).ok_or("Файл недоступен")?;
    std::fs::create_dir_all(&directory).map_err(|error| format!("Не удалось создать папку загрузок: {error}"))?;
    let File::File(mut file) = functions::get_file(file_id, cid).await.map_err(tderr)?;
    if !file.local.is_downloading_completed {
        if !file.local.can_be_downloaded { return Err("Файл недоступен для загрузки".into()); }
        let File::File(queued) = functions::add_file_to_downloads(file_id, chat_id, message_id, 16, cid).await.map_err(tderr)?;
        file = queued;
        let result = async {
            let mut progress = -1;
            let mut last_progress = tokio::time::Instant::now();
            while !file.local.is_downloading_completed {
                if client_id(&state).ok() != Some(cid) { return Err("Загрузка прервана".into()); }
                let downloaded = file.local.downloaded_size;
                if downloaded != progress {
                    progress = downloaded;
                    last_progress = tokio::time::Instant::now();
                    let size = if file.size > 0 { file.size } else { file.expected_size };
                    let _ = on_progress.send(DownloadProgress::Downloading { file_name: file_name.clone(), downloaded, size });
                }
                if last_progress.elapsed() > std::time::Duration::from_secs(120) { return Err("Загрузка остановилась".into()); }
                tokio::time::sleep(std::time::Duration::from_millis(450)).await;
                let File::File(current) = functions::get_file(file_id, cid).await.map_err(tderr)?;
                file = current;
            }
            Ok::<(), String>(())
        }.await;
        if client_id(&state).ok() == Some(cid) { let _ = functions::remove_file_from_downloads(file_id, false, cid).await; }
        result?;
    }
    if client_id(&state).ok() != Some(cid) || file.local.path.is_empty() { return Err("Файл недоступен".into()); }
    if std::path::Path::new(&file_name).extension().is_none()
        && let Some(ext) = std::path::Path::new(&file.local.path).extension().and_then(|ext| ext.to_str())
        && ext.len() <= 16 && ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        file_name.push('.');
        file_name.push_str(ext);
    }
    let _ = on_progress.send(DownloadProgress::Saving { file_name: file_name.clone() });
    let result = tauri::async_runtime::spawn_blocking(move || copy_download(&file.local.path, &directory, &file_name))
        .await.map_err(|_| "Не удалось сохранить файл")?.map_err(|error| format!("Не удалось сохранить файл: {error}"))?;
    Ok(result)
}

fn copy_download(source: &str, directory: &std::path::Path, name: &str) -> std::io::Result<SavedDownload> {
    use std::{fs::{File, OpenOptions}, io::{self, ErrorKind}};
    let mut source = File::open(source)?;
    let (stem, ext) = name.rsplit_once('.').filter(|(stem, _)| !stem.is_empty()).unwrap_or((name, ""));
    for index in 0..10_000 {
        let file_name = match (index, ext.is_empty()) {
            (0, _) => name.into(),
            (_, true) => format!("{stem} ({index})"),
            _ => format!("{stem} ({index}).{ext}"),
        };
        let path = directory.join(&file_name);
        let mut destination = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let copied = io::copy(&mut source, &mut destination).and_then(|_| destination.sync_all());
        drop(destination);
        if let Err(error) = copied {
            let _ = std::fs::remove_file(&path);
            return Err(error);
        }
        return Ok(SavedDownload { file_name, path: path.to_string_lossy().into_owned() });
    }
    Err(io::Error::new(ErrorKind::AlreadyExists, "Нет свободного имени файла"))
}

fn media_range(range: Option<&str>, size: i64) -> Option<(i64, i64)> {
    let (start, end) = match range {
        Some(value) => {
            let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
            if start.is_empty() {
                let tail = end.parse::<i64>().ok()?.clamp(0, size);
                (size - tail, size - 1)
            } else {
                (start.parse().ok()?, if end.is_empty() { size - 1 } else { end.parse().ok()? })
            }
        }
        None => (0, size - 1),
    };
    if start < 0 || start >= size || end < start { return None; }
    Some((start, end.min(size - 1).min(start + 1024 * 1024 - 1)))
}

pub(crate) async fn stream_media(app: &AppHandle, request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{header, Method, Response, StatusCode};
    use tdlib_rs::{enums::{File, FileDownloadedPrefixSize}, functions};

    let reject = |status| Response::builder().status(status).header(header::CACHE_CONTROL, "no-store").body(Vec::new()).unwrap();
    let state = app.state::<AppState>();
    if !state.is_stage("ready") { return reject(StatusCode::FORBIDDEN); }
    let Ok(cid) = client_id(&state) else { return reject(StatusCode::FORBIDDEN); };
    if request.method() != Method::GET && request.method() != Method::HEAD { return reject(StatusCode::METHOD_NOT_ALLOWED); }
    let Some((id, format)) = request.uri().path().trim_start_matches('/').split_once('.') else { return reject(StatusCode::BAD_REQUEST); };
    let Ok(id) = id.parse::<i32>() else { return reject(StatusCode::BAD_REQUEST); };
    let mime = match format {
        "mp4" | "m4v" => "video/mp4", "mov" => "video/quicktime", "webm" => "video/webm",
        "mkv" => "video/x-matroska", "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg", "m4a" | "alac" => "audio/mp4", "aac" => "audio/aac", "ogg" | "oga" | "opus" => "audio/ogg",
        "flac" => "audio/flac", "wav" => "audio/wav", "aiff" => "audio/aiff", _ => "application/octet-stream",
    };
    let Ok(File::File(mut file)) = functions::get_file(id, cid).await else { return reject(StatusCode::NOT_FOUND); };
    let size = if file.size > 0 { file.size } else if file.local.is_downloading_completed {
        std::fs::metadata(&file.local.path).map(|metadata| metadata.len() as i64).unwrap_or(0)
    } else { 0 };
    if size <= 0 { return reject(StatusCode::NOT_FOUND); }
    let range = request.headers().get(header::RANGE).and_then(|value| value.to_str().ok());
    let bounds = if request.method() == Method::HEAD && range.is_none() { Some((0, size - 1)) } else { media_range(range, size) };
    let Some((start, end)) = bounds else {
        return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{size}")).body(Vec::new()).unwrap();
    };
    let count = end - start + 1;
    let mut bytes = Vec::new();
    if request.method() == Method::GET {
        let result = tokio::time::timeout(std::time::Duration::from_secs(25), async {
            let _download = state.media_download.lock().await;
            let Ok(File::File(current)) = functions::get_file(id, cid).await else { return None; };
            file = current;
            if !file.local.is_downloading_completed {
                let available = functions::get_file_downloaded_prefix_size(id, start, cid).await.ok();
                if !matches!(available, Some(FileDownloadedPrefixSize::FileDownloadedPrefixSize(prefix)) if prefix.size >= count) {
                    let File::File(part) = functions::download_file(id, 24, start, (count + 2 * 1024 * 1024).min(size - start), false, cid).await.ok()?;
                    file = part;
                    loop {
                        if file.local.is_downloading_completed { break; }
                        let FileDownloadedPrefixSize::FileDownloadedPrefixSize(prefix) = functions::get_file_downloaded_prefix_size(id, start, cid).await.ok()?;
                        if prefix.size >= count && !file.local.path.is_empty() { break; }
                        tokio::time::sleep(std::time::Duration::from_millis(90)).await;
                        let File::File(current) = functions::get_file(id, cid).await.ok()?;
                        file = current;
                    }
                }
            }
            if !state.is_stage("ready") || client_id(&state).ok()? != cid { return None; }
            let path = std::path::Path::new(&file.local.path).canonicalize().ok()?;
            let directory = state.files_dir.canonicalize().ok()?;
            if !path.starts_with(directory) && !app.asset_protocol_scope().is_allowed(&path) { return None; }
            let mut source = std::fs::File::open(path).ok()?;
            source.seek(SeekFrom::Start(start as u64)).ok()?;
            let mut data = vec![0; count as usize];
            source.read_exact(&mut data).ok()?;
            Some(data)
        }).await;
        let Ok(Some(data)) = result else { return reject(StatusCode::SERVICE_UNAVAILABLE); };
        bytes = data;
    }
    let partial = range.is_some() || count < size;
    let mut response = Response::builder().status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, mime).header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, count).header(header::CACHE_CONTROL, "no-store");
    if partial { response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}")); }
    response.body(bytes).unwrap()
}

#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    client_id(&state)?;
    state.archive.lock().unwrap().flush()?;
    let mut lock = state.app_lock.lock().unwrap();
    lock.suspend_session()?;
    let _ = app.emit("app-lock", lock.status()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_download_copies_without_overwriting_and_sanitizes_names() {
        assert_eq!(download_name("../a/bad:name?.mp4", "fallback"), "bad_name_.mp4");
        assert_eq!(download_name("CON.txt", "fallback"), "_CON.txt");
        assert_eq!(download_name("..", "fallback"), "fallback");
        let mut id = [0_u8; 8];
        getrandom::fill(&mut id).unwrap();
        let directory = std::path::Path::new("target").join(format!("download-test-{}", u64::from_le_bytes(id)));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("source");
        std::fs::write(&source, b"data").unwrap();
        let existing = directory.join("clip.mp4");
        std::fs::write(&existing, b"existing").unwrap();
        let saved = copy_download(source.to_str().unwrap(), &directory, "clip.mp4").unwrap();
        assert_eq!(saved.file_name, "clip (1).mp4");
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"data");
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing");
        std::fs::remove_file(saved.path).unwrap();
        std::fs::remove_file(existing).unwrap();
        std::fs::remove_file(source).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn limits_stream_ranges_and_supports_seeks_and_suffix_requests() {
        assert_eq!(media_range(Some("bytes=0-"), 9_000_000), Some((0, 1_048_575)));
        assert_eq!(media_range(Some("bytes=450-699"), 1_000), Some((450, 699)));
        assert_eq!(media_range(Some("bytes=-32"), 1_000), Some((968, 999)));
        assert_eq!(media_range(Some("bytes=990-1500"), 1_000), Some((990, 999)));
        assert_eq!(media_range(Some("bytes=1000-"), 1_000), None);
        assert_eq!(media_range(Some("bytes=10-5"), 1_000), None);
    }

    #[test]
    fn preserves_valid_mentions_and_rejects_overlapping_or_broken_utf16_ranges() {
        let entity = |offset, length| crate::models::TextEntityData { offset, length, kind: "user".into(), user_id: Some(42), value: String::new() };
        let text = formatted_text("😀 Anna".into(), Some(vec![entity(1, 1), entity(3, 4), entity(4, 2), entity(20, 2)]));
        assert_eq!(text.entities.len(), 1);
        assert_eq!((text.entities[0].offset, text.entities[0].length), (3, 4));
        assert!(matches!(text.entities[0].r#type, tdlib_rs::enums::TextEntityType::MentionName(ref mention) if mention.user_id == 42));
        let file = AttachmentData { path: "file.pdf".into(), file_name: "file.pdf".into(), size: 10, kind: "file".into() };
        let content = attachment_content(&file, text, VideoInfo::default());
        assert!(matches!(content, tdlib_rs::enums::InputMessageContent::InputMessageDocument(document) if document.caption.as_ref().unwrap().entities.len() == 1));
    }

    #[test]
    fn formatted_text_round_trips_nested_styles_and_code_language() {
        use tdlib_rs::{enums::TextEntityType as T, types};
        let original = types::FormattedText {
            text: "😀 Bold italic\nlet x = 1;".into(),
            entities: vec![
                types::TextEntity { offset: 3, length: 11, r#type: T::Bold },
                types::TextEntity { offset: 8, length: 6, r#type: T::Italic },
                types::TextEntity { offset: 15, length: 10, r#type: T::PreCode(types::TextEntityTypePreCode { language: "rust".into() }) },
            ],
        };
        let entities = crate::td::convert::entities_to_data(&original);
        assert_eq!(formatted_text(original.text.clone(), Some(entities)), original);
    }

    fn attachment(path: &str, kind: &str) -> AttachmentData {
        AttachmentData { path: path.into(), file_name: path.into(), size: 100, kind: kind.into() }
    }

    #[test]
    fn preserves_captions_for_photos_documents_and_videos() {
        use tdlib_rs::enums::InputMessageContent as C;
        let inputs = [
            attachment_content(&attachment("photo.jpg", "photo"), formatted_text("Photo caption".into(), None), VideoInfo::default()),
            attachment_content(&attachment("file.pdf", "file"), formatted_text("File caption".into(), None), VideoInfo::default()),
            attachment_content(&attachment("clip.mp4", "video"), formatted_text("Video caption".into(), None), VideoInfo { width: 1920, height: 1080, duration: 12 }),
        ];
        assert!(matches!(&inputs[0], C::InputMessagePhoto(photo) if photo.caption.as_ref().unwrap().text == "Photo caption"));
        assert!(matches!(&inputs[1], C::InputMessageDocument(file) if file.caption.as_ref().unwrap().text == "File caption"));
        assert!(matches!(&inputs[2], C::InputMessageVideo(video) if video.caption.as_ref().unwrap().text == "Video caption" && video.width == 1920 && video.duration == 12));
    }

    #[test]
    fn accepts_empty_captions_and_preserves_gif_files() {
        let content = attachment_content(&attachment("animation.gif", "photo"), formatted_text(String::new(), None), VideoInfo::default());
        assert!(matches!(content, tdlib_rs::enums::InputMessageContent::InputMessageAnimation(animation) if animation.caption.is_none()));
    }

    #[test]
    fn prepares_only_real_files_and_normalizes_windows_paths() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let data = attachment_data(root.join("static/favicon.png").to_str().unwrap()).unwrap();
        assert_eq!(data.kind, "photo");
        assert!(data.size > 0);
        assert!(!data.path.starts_with("\\\\?\\"));
        assert!(attachment_data(root.to_str().unwrap()).is_err());
    }

    #[test]
    fn includes_reply_targets_only_for_valid_message_ids() {
        assert!(reply_to(None).is_none());
        assert!(reply_to(Some(0)).is_none());
        assert!(matches!(reply_to(Some(42)), Some(tdlib_rs::enums::InputMessageReplyTo::Message(reply)) if reply.message_id == 42));
    }

    #[test]
    fn validates_clipboard_images_before_saving() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let bytes = std::fs::read(root.join("static/favicon.png")).unwrap();
        assert_eq!(clipboard_image_extension(&bytes).unwrap(), "png");
        assert!(clipboard_image_extension(b"not an image").is_err());
        assert!(clipboard_image_extension(&bytes[..12]).is_err());
        assert!(clipboard_image_extension(&[]).is_err());
    }
}
