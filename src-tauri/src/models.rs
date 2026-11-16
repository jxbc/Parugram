// Модели, сериализуемые во фронтенд. Зеркальные TS-типы лежат в src/lib/api/td.ts
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug)]
pub struct UserPayload {
    pub id: i64,
    pub first_name: String,
    pub last_name: String,
    pub username: String,
    pub photo: Option<String>,
    pub photo_file_id: Option<i32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AuthStatePayload {
    pub stage: String,
    pub user: Option<UserPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_login_link: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChatListPayload {
    pub folder_id: i32,
    pub chats: Vec<ChatSummary>,
    pub muted_scopes: std::collections::HashMap<&'static str, bool>,
    pub ready: bool,
    pub has_more: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct AppSnapshot {
    pub auth: AuthStatePayload,
    pub chats: ChatListPayload,
    pub connection: String,
    pub folders: Vec<FolderData>,
    pub save_deleted: bool,
    pub skip_read: bool,
    pub chat_privacy: ChatPrivacy,
    pub notifications: NotificationPreferences,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(default)]
pub struct ChatPrivacy {
    pub hide_video_views: bool,
    pub hide_voice_listens: bool,
    pub hide_typing: bool,
}

impl Default for ChatPrivacy {
    fn default() -> Self {
        Self { hide_video_views: false, hide_voice_listens: false, hide_typing: true }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlaybackKind {
    VideoNote,
    Voice,
}

impl ChatPrivacy {
    pub fn hides_playback(self, kind: PlaybackKind) -> bool {
        match kind {
            PlaybackKind::VideoNote => self.hide_video_views,
            PlaybackKind::Voice => self.hide_voice_listens,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct NotificationPreferences {
    pub enabled: bool,
    pub private: bool,
    pub group: bool,
    pub channel: bool,
    pub group_mentions: bool,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self { enabled: true, private: true, group: true, channel: true, group_mentions: true }
    }
}

impl NotificationPreferences {
    pub fn allows(self, scope: &tdlib_rs::enums::NotificationSettingsScope, mentioned: bool) -> bool {
        use tdlib_rs::enums::NotificationSettingsScope::*;
        self.enabled && match scope {
            PrivateChats => self.private,
            GroupChats => self.group && (!mentioned || self.group_mentions),
            ChannelChats => self.channel,
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct MessageReplacement {
    pub old_message_id: i64,
    pub message: MsgData,
}

#[derive(Serialize, Clone, Debug)]
pub struct MessageContentPayload {
    pub chat_id: i64,
    pub message_id: i64,
    pub content: MsgContent,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeletedMessagesPayload {
    pub chat_id: i64,
    pub message_ids: Vec<i64>,
    pub saved_messages: Vec<MsgData>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MessageReactionsPayload {
    pub chat_id: i64,
    pub message_id: i64,
    pub reactions: Vec<ReactionData>,
    pub comment_count: Option<i32>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct ChatSummary {
    pub id: i64,
    pub title: String,
    pub is_group: bool,
    pub notification_scope: &'static str,
    pub notifications_muted: Option<bool>,
    pub photo: Option<String>,
    pub photo_file_id: Option<i32>,
    pub order: i64,
    pub is_pinned: bool,
    pub positions: Vec<ChatPositionData>,
    pub unread_count: i32,
    pub is_marked_as_unread: bool,
    pub unread_mention_count: i32,
    pub last_read_inbox_message_id: i64,
    pub last_read_outbox_message_id: i64,
    pub last_message: Option<MsgData>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MsgData {
    pub id: i64,
    pub chat_id: i64,
    pub is_outgoing: bool,
    pub sender: SenderData,
    pub date: i32,
    pub content: MsgContent,
    pub sending_state: String,
    pub error: Option<String>,
    #[serde(default)]
    pub forward_from: Option<ForwardOrigin>,
    #[serde(default)]
    pub reply_to: Option<ReplyData>,
    #[serde(default)]
    pub reactions: Vec<ReactionData>,
    #[serde(default)]
    pub is_deleted: bool,
    #[serde(default)]
    pub thread_id: Option<i64>,
    #[serde(default)]
    pub is_channel_post: bool,
    #[serde(default)]
    pub comment_count: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SenderData {
    pub kind: String,
    pub id: i64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    pub photo: Option<String>,
    pub photo_file_id: Option<i32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ForwardOrigin {
    pub kind: String,
    pub id: Option<i64>,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReplyData {
    pub chat_id: i64,
    pub message_id: i64,
    pub author: String,
    pub preview: String,
    pub quote: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ReactionData {
    pub key: String,
    pub emoji: String,
    pub custom_emoji_id: Option<String>,
    pub count: i32,
    pub chosen: bool,
    #[serde(default)]
    pub needs_premium: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_senders: Vec<SenderData>,
    #[serde(default)]
    pub can_list_senders: bool,
}

#[derive(Serialize)]
pub struct ReactionSendersPage {
    pub senders: Vec<SenderData>,
    pub next_offset: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChatActivityData {
    pub chat_id: i64,
    pub sender: SenderData,
    pub action: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", content = "data")]
pub enum MsgContent {
    Text { text: String, entities: Vec<TextEntityData> },
    Photo { file_id: i32, #[serde(default)] thumbnail_file_id: Option<i32>, width: i32, height: i32, caption: String, entities: Vec<TextEntityData> },
    Video { file_id: i32, width: i32, height: i32, duration: i32, file_name: String, thumbnail_file_id: Option<i32>, caption: String, entities: Vec<TextEntityData> },
    VideoNote { file_id: i32, duration: i32, thumbnail_file_id: Option<i32> },
    Animation { file_id: i32, width: i32, height: i32, duration: i32, file_name: String, mime_type: String, caption: String, entities: Vec<TextEntityData> },
    File { file_id: i32, file_name: String, size: i64, caption: String, entities: Vec<TextEntityData> },
    Audio { file_id: i32, file_name: String, size: i64, duration: i32, title: String, performer: String, mime_type: String, cover_file_id: Option<i32>, caption: String, entities: Vec<TextEntityData> },
    Voice { file_id: i32, duration: i32, waveform: String, mime_type: String, caption: String, entities: Vec<TextEntityData> },
    Sticker { file_id: i32, width: i32, height: i32, emoji: String, format: String },
    Event { action: String, members: Vec<SenderData>, text: String, message_id: i64 },
    Unsupported { label: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TextEntityData {
    pub offset: i32,
    pub length: i32,
    pub kind: String,
    pub value: String,
    pub user_id: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FolderData {
    pub id: i32,
    pub title: String,
    pub unread_count: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct ChatPositionData {
    pub folder_id: i32,
    pub order: i64,
    pub is_pinned: bool,
}

#[derive(Deserialize)]
pub struct ProfileTarget {
    pub kind: String,
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub username: String,
}

#[derive(Serialize, Default)]
pub struct ProfileData {
    pub kind: String,
    pub id: i64,
    pub title: String,
    pub status: String,
    pub last_seen: Option<i32>,
    pub photo: Option<String>,
    pub photo_file_id: Option<i32>,
    pub bio: String,
    pub bio_entities: Vec<TextEntityData>,
    pub usernames: Vec<String>,
    pub phone: String,
    pub birthdate: Option<tdlib_rs::types::Birthdate>,
    pub is_premium: bool,
    pub is_verified: bool,
    pub member_count: i32,
    pub common_groups: i32,
    pub can_view_members: bool,
    pub chat: ChatSummary,
}

#[derive(Serialize)]
pub struct ProfileMedia {
    pub messages: Vec<MsgData>,
    pub next_from_message_id: i64,
    pub total_count: i32,
}

#[derive(Serialize)]
pub struct ThreadData {
    pub chat: ChatSummary,
    pub thread_id: i64,
    pub roots: Vec<MsgData>,
    pub reply_count: i32,
    pub unread_count: i32,
    pub last_read_inbox_message_id: i64,
}

#[derive(Serialize)]
pub struct TelegramLinkData {
    pub chat: ChatSummary,
    pub message_id: Option<i64>,
}

#[derive(Serialize)]
pub struct ProfilePhotos {
    pub photos: Vec<FileData>,
    pub total_count: i32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StickerData {
    pub file_id: i32,
    pub set_id: String,
    pub width: i32,
    pub height: i32,
    pub emoji: String,
    pub format: String,
    pub thumbnail_file_id: Option<i32>,
}

#[derive(Serialize)]
pub struct StickerSetData {
    pub id: String,
    pub title: String,
    pub cover: Option<StickerData>,
}

#[derive(Serialize)]
pub struct StickerCatalog {
    pub recent: Vec<StickerData>,
    pub sets: Vec<StickerSetData>,
}

#[derive(Serialize, Clone, Debug)]
pub struct FileData {
    pub file_id: i32,
    pub local_path: Option<String>,
    pub downloaded: i64,
    pub size: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct AttachmentData {
    pub path: String,
    pub file_name: String,
    pub size: u64,
    pub kind: String,
}

#[derive(Deserialize, Default)]
pub struct VideoInfo {
    pub width: i32,
    pub height: i32,
    pub duration: i32,
}

#[derive(Serialize)]
pub struct MessageActions {
    pub can_reply: bool,
    pub can_copy: bool,
    pub can_edit: bool,
    pub can_delete_for_self: bool,
    pub can_delete_for_all: bool,
    pub can_get_viewers: bool,
    pub can_forward: bool,
    pub can_save: bool,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Credentials {
    pub api_id: i32,
    pub api_hash: String,
}
