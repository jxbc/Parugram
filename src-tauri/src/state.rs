use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::models::{AuthStatePayload, ChatPrivacy, ChatSummary, FolderData, NotificationPreferences, UserPayload};

pub struct AppState {
    pub skip_read: AtomicBool,
    pub chat_privacy: Mutex<ChatPrivacy>,
    pub notifications: Mutex<NotificationPreferences>,
    pub download_drive: Mutex<Option<String>>,
    pub app_lock: Mutex<crate::app_lock::AppLock>,
    pub archive: Mutex<crate::message_archive::MessageArchive>,
    /// TDLib client id. Заполняется в td::worker::start().
    pub client_id: AtomicI32,
    pub api_id: i32,
    pub api_hash: String,
    pub db_dir: PathBuf,
    pub files_dir: PathBuf,
    pub media_download: tokio::sync::Mutex<()>,
    pub chat_windows: tokio::sync::Mutex<usize>,
    pub open_chats: tokio::sync::Mutex<HashMap<String, HashMap<i64, i32>>>,
    auth_stage: Mutex<(&'static str, Option<String>)>,
    pub user: Mutex<Option<UserPayload>>,
    pub chats: Mutex<std::collections::HashMap<i64, ChatSummary>>,
    pub muted_scopes: Mutex<HashMap<&'static str, bool>>,
    pub users: Mutex<HashMap<i64, UserPayload>>,
    pub connection: Mutex<String>,
    pub chats_loaded: AtomicBool,
    pub has_more_chats: AtomicBool,
    pub chat_limit: AtomicUsize,
    pub active_folder: AtomicI32,
    pub folders: Mutex<Vec<FolderData>>,
    pub folder_unread: Mutex<HashMap<i32, i32>>,
    pub chats_error: Mutex<Option<String>>,
    pub worker_tx: Mutex<Option<tokio::sync::mpsc::UnboundedSender<crate::td::worker::WorkerEvent>>>,
}

impl AppState {
    pub fn new(
        api_id: i32,
        api_hash: String,
        db_dir: PathBuf,
        files_dir: PathBuf,
    ) -> Self {
        let skip_read = match std::fs::read(db_dir.parent().unwrap_or(&db_dir).join("read-settings.json")) {
            Ok(bytes) => serde_json::from_slice::<bool>(&bytes).unwrap_or(true),
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        };
        let notifications = std::fs::read(db_dir.parent().unwrap_or(&db_dir).join("notification-settings.json")).ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let chat_privacy = std::fs::read(db_dir.parent().unwrap_or(&db_dir).join("chat-privacy.json")).ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(ChatPrivacy { hide_video_views: skip_read, hide_voice_listens: skip_read, ..ChatPrivacy::default() });
        let download_drive = std::fs::read(db_dir.parent().unwrap_or(&db_dir).join("download-settings.json")).ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).flatten();
        Self {
            skip_read: AtomicBool::new(skip_read),
            chat_privacy: Mutex::new(chat_privacy),
            notifications: Mutex::new(notifications),
            download_drive: Mutex::new(download_drive),
            app_lock: Mutex::new(crate::app_lock::AppLock::load(db_dir.parent().unwrap_or(&db_dir).join("app-lock.json"))),
            archive: Mutex::new(crate::message_archive::MessageArchive::new(db_dir.parent().unwrap_or(&db_dir).to_path_buf())),
            client_id: AtomicI32::new(0),
            api_id,
            api_hash,
            db_dir,
            files_dir,
            media_download: tokio::sync::Mutex::new(()),
            chat_windows: tokio::sync::Mutex::new(0),
            open_chats: tokio::sync::Mutex::new(HashMap::new()),
            auth_stage: Mutex::new(("loading", None)),
            user: Mutex::new(None),
            chats: Mutex::new(HashMap::new()),
            muted_scopes: Mutex::new(HashMap::new()),
            users: Mutex::new(HashMap::new()),
            connection: Mutex::new("connecting".into()),
            chats_loaded: AtomicBool::new(false),
            has_more_chats: AtomicBool::new(true),
            chat_limit: AtomicUsize::new(50),
            active_folder: AtomicI32::new(0),
            folders: Mutex::new(Vec::new()),
            folder_unread: Mutex::new(HashMap::new()),
            chats_error: Mutex::new(None),
            worker_tx: Mutex::new(None),
        }
    }

    pub fn set_stage(&self, stage: &'static str) {
        *self.auth_stage.lock().unwrap() = (stage, None);
    }

    pub fn set_qr_login_link(&self, link: String) {
        *self.auth_stage.lock().unwrap() = ("wait_other_device", Some(link));
    }

    pub fn is_stage(&self, stage: &str) -> bool {
        self.auth_stage.lock().unwrap().0 == stage
    }

    pub fn auth_payload(&self) -> AuthStatePayload {
        let (stage, qr_login_link) = self.auth_stage.lock().unwrap().clone();
        AuthStatePayload { stage: stage.into(), user: self.user.lock().unwrap().clone(), qr_login_link }
    }

    pub fn folder_list(&self) -> Vec<FolderData> {
        let mut folders = self.folders.lock().unwrap().clone();
        let counts = self.folder_unread.lock().unwrap();
        for folder in &mut folders {
            folder.unread_count = counts.get(&folder.id).copied().unwrap_or(0);
        }
        folders
    }

    pub fn set_skip_read(&self, enabled: bool) -> Result<bool, String> {
        let privacy = self.chat_privacy.lock().unwrap();
        self.save_settings("chat-privacy.json", &*privacy).map_err(|_| "Не удалось сохранить настройку")?;
        self.save_settings("read-settings.json", &enabled).map_err(|_| "Не удалось сохранить настройку")?;
        self.skip_read.store(enabled, Ordering::SeqCst);
        Ok(enabled)
    }

    pub fn set_chat_privacy(&self, preferences: ChatPrivacy) -> Result<ChatPrivacy, String> {
        let mut current = self.chat_privacy.lock().unwrap();
        self.save_settings("chat-privacy.json", &preferences).map_err(|_| "Не удалось сохранить настройку")?;
        *current = preferences;
        Ok(preferences)
    }

    pub fn set_notifications(&self, preferences: NotificationPreferences) -> Result<NotificationPreferences, String> {
        let mut current = self.notifications.lock().unwrap();
        self.save_settings("notification-settings.json", &preferences).map_err(|_| "Не удалось сохранить уведомления")?;
        *current = preferences;
        Ok(preferences)
    }

    pub(crate) fn save_settings(&self, name: &str, settings: &impl serde::Serialize) -> std::io::Result<()> {
        use std::io::Write;
        let path = self.db_dir.parent().unwrap_or(&self.db_dir).join(name);
        let temporary = path.with_extension("tmp");
        let mut file = std::fs::File::create(&temporary)?;
        serde_json::to_writer(&mut file, settings)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(temporary, path)
    }

    pub fn chats_ready(&self) -> bool {
        self.app_lock.lock().unwrap().is_unlocked()
            && self.chats_loaded.load(Ordering::SeqCst)
            && self.is_stage("ready")
            && self.user.lock().unwrap().is_some()
            && *self.connection.lock().unwrap() == "connected"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attaches_unread_counts_that_arrived_before_the_folder_list() {
        let directory = PathBuf::from("target/folder-count-test");
        let state = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        *state.folder_unread.lock().unwrap() = HashMap::from([(0, 112), (7, 63), (12, 9)]);
        assert!(state.folder_list().is_empty());

        *state.folders.lock().unwrap() = vec![
            FolderData { id: 7, title: "Личные".into(), unread_count: 0 },
            FolderData { id: 0, title: "Все".into(), unread_count: 0 },
            FolderData { id: -1, title: "Архив".into(), unread_count: 0 },
        ];
        let counts: Vec<_> = state.folder_list().into_iter().map(|folder| (folder.id, folder.unread_count)).collect();
        assert_eq!(counts, [(7, 63), (0, 112), (-1, 0)]);
    }

    #[test]
    fn preserves_read_privacy_after_restart_and_keeps_it_on_for_invalid_settings() {
        let mut id = [0_u8; 8];
        getrandom::fill(&mut id).unwrap();
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("read-test-{}", u64::from_le_bytes(id)));
        std::fs::create_dir(&directory).unwrap();
        let state = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        assert!(!state.skip_read.load(Ordering::SeqCst));
        assert!(state.set_skip_read(true).unwrap());
        let restarted = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        assert!(restarted.skip_read.load(Ordering::SeqCst));
        assert!(!restarted.chat_privacy.lock().unwrap().hides_playback(crate::models::PlaybackKind::Voice));
        assert!(!restarted.set_skip_read(false).unwrap());
        assert!(!AppState::new(0, String::new(), directory.join("db"), directory.join("files")).skip_read.load(Ordering::SeqCst));
        std::fs::write(directory.join("read-settings.json"), b"broken").unwrap();
        assert!(AppState::new(0, String::new(), directory.join("db"), directory.join("files")).skip_read.load(Ordering::SeqCst));
        std::fs::remove_file(directory.join("chat-privacy.json")).unwrap();
        let legacy = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        assert!(legacy.chat_privacy.lock().unwrap().hides_playback(crate::models::PlaybackKind::Voice));
        let custom = ChatPrivacy { hide_video_views: true, hide_voice_listens: false, hide_typing: false };
        legacy.set_chat_privacy(custom).unwrap();
        let restored = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        let privacy = *restored.chat_privacy.lock().unwrap();
        assert!(privacy.hides_playback(crate::models::PlaybackKind::VideoNote));
        assert!(!privacy.hides_playback(crate::models::PlaybackKind::Voice));
        assert!(!privacy.hide_typing);
        std::fs::remove_file(directory.join("read-settings.json")).unwrap();
        std::fs::remove_file(directory.join("chat-privacy.json")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn persists_notification_filters_and_leaves_subsettings_intact_when_disabled() {
        use tdlib_rs::enums::NotificationSettingsScope::*;
        let mut id = [0_u8; 8];
        getrandom::fill(&mut id).unwrap();
        let directory = PathBuf::from("target").join(format!("notification-test-{}", u64::from_le_bytes(id)));
        std::fs::create_dir(&directory).unwrap();
        let state = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        let mut settings = *state.notifications.lock().unwrap();
        assert!(settings.allows(&GroupChats, true));
        settings.group_mentions = false;
        settings.channel = false;
        settings.enabled = false;
        state.set_notifications(settings).unwrap();
        let restarted = AppState::new(0, String::new(), directory.join("db"), directory.join("files"));
        let mut restored = *restarted.notifications.lock().unwrap();
        assert_eq!(settings, restored);
        assert!(!restored.allows(&PrivateChats, false));
        restored.enabled = true;
        assert!(restored.allows(&PrivateChats, false));
        assert!(restored.allows(&GroupChats, false));
        assert!(!restored.allows(&GroupChats, true));
        assert!(!restored.allows(&ChannelChats, false));
        restored.group = false;
        assert!(!restored.allows(&GroupChats, false));
        restarted.set_notifications(restored).unwrap();
        std::fs::remove_file(directory.join("notification-settings.json")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
