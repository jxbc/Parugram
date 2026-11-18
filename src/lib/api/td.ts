import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface UserPayload {
  id: number
  first_name: string
  last_name: string
  username: string
  photo: string | null
  photo_file_id: number | null
}

export interface AuthStatePayload {
  stage: string
  user: UserPayload | null
  qr_login_link?: string
}

export interface AppLockStatus {
  revision: number
  configured: boolean
  kind: "pin" | "password" | null
  locked: boolean
  remaining_attempts: number
  logout_pending: boolean
  logged_out: boolean
  session_suspended: boolean
}

export interface AppLockResult {
  accepted: boolean
  status: AppLockStatus
}

export interface MediaItem {
  key: string
  kind: "photo" | "video"
  file_id: number
  local_path?: string
  caption: string
  entities?: TextEntityData[]
  file_name: string
}

export interface DownloadSettings {
  drive: string
  drives: string[]
  directory: string
}

export type DownloadProgress =
  | { stage: "downloading"; file_name: string; downloaded: number; size: number }
  | { stage: "saving"; file_name: string }

export function telegramMediaSrc(id: number, fileName: string, fallback: string) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1]?.toLowerCase() ?? fallback
  return convertFileSrc(`${id}.${extension}`, "telegram-media")
}

export interface MusicTrack {
  key: string
  chatId: number
  messageId: number
  fileId: number
  title: string
  performer: string
  fileName: string
  duration: number
  date: number
  coverFileId: number | null
}

type NotificationScope = "private" | "group" | "channel"
export type NotificationPreferences = Record<NotificationScope | "enabled" | "group_mentions", boolean>
export type ChatPrivacy = Record<"hide_video_views" | "hide_voice_listens" | "hide_typing", boolean>
type ChatNotificationUpdate = { chat_id: number; muted: boolean | null }

export interface ChatSummary {
  id: number
  title: string
  is_group: boolean
  notification_scope?: NotificationScope
  notifications_muted?: boolean | null
  photo: string | null
  photo_file_id: number | null
  order: number
  is_pinned: boolean
  positions: { folder_id: number; order: number; is_pinned: boolean }[]
  unread_count: number
  unread_mention_count?: number
  is_marked_as_unread: boolean
  last_read_inbox_message_id: number
  last_read_outbox_message_id: number
  last_message: MsgData | null
}

export interface ChatListPayload {
  folder_id: number
  chats: ChatSummary[]
  muted_scopes?: Partial<Record<NotificationScope, boolean>>
  ready: boolean
  has_more: boolean
  error: string | null
}

export interface AppSnapshot {
  auth: AuthStatePayload
  chats: ChatListPayload
  connection: string
  folders: FolderData[]
  save_deleted?: boolean
  skip_read?: boolean
  chat_privacy?: ChatPrivacy
  notifications?: NotificationPreferences
}

export interface FolderData {
  id: number
  title: string
  unread_count?: number
}

export interface TextEntityData {
  offset: number
  length: number
  kind: "mention" | "user" | "url" | "bold" | "italic" | "underline" | "strikethrough" | "spoiler" | "code" | "pre" | "quote" | "expandable_quote"
  value: string
  user_id: number | null
}

export type ProfileTarget = { kind: "user" | "chat"; id: number } | { kind: "username"; username: string }

export interface ProfileData {
  kind: "user" | "chat"
  id: number
  title: string
  status: string
  last_seen: number | null
  photo: string | null
  photo_file_id: number | null
  bio: string
  bio_entities: TextEntityData[]
  usernames: string[]
  phone: string
  birthdate: { day: number; month: number; year: number } | null
  is_premium: boolean
  is_verified: boolean
  member_count: number
  common_groups: number
  can_view_members: boolean
  chat: ChatSummary
}

export interface ProfileMedia {
  messages: MsgData[]
  next_from_message_id: number
  total_count: number
}

export interface ProfilePhotos {
  photos: FileData[]
  total_count: number
}

export interface MsgData {
  id: number
  chat_id: number
  is_outgoing: boolean
  sender: SenderData
  date: number
  content: MsgContent
  sending_state: "pending" | "sent" | "failed"
  error: string | null
  forward_from?: { kind: "user" | "chat" | "hidden"; id: number | null; name: string } | null
  reply_to?: ReplyData | null
  reactions?: ReactionData[]
  is_deleted?: boolean
  thread_id?: number | null
  is_channel_post?: boolean
  comment_count?: number | null
}

export interface ReplyData {
  chat_id: number
  message_id: number
  author: string
  preview: string
  quote: string
}

export interface ReactionData {
  key: string
  emoji: string
  custom_emoji_id: string | null
  count: number
  chosen: boolean
  needs_premium?: boolean
  recent_senders?: SenderData[]
  can_list_senders?: boolean
}

export interface MessageReactionsPayload {
  chat_id: number
  message_id: number
  reactions: ReactionData[]
  comment_count?: number | null
}

export interface SenderData {
  kind: "user" | "chat"
  id: number
  name: string
  first_name?: string
  photo: string | null
  photo_file_id: number | null
}

export type ChatActivityKind = "typing" | "recording_video" | "uploading_video" | "recording_voice" | "uploading_voice"
  | "uploading_photo" | "uploading_file" | "choosing_sticker" | "choosing_location" | "choosing_contact"
  | "playing_game" | "recording_video_note" | "uploading_video_note" | "watching_animation" | "cancel"

export type ComposerStatus = Extract<ChatActivityKind, "typing" | "uploading_file" | "uploading_photo" | "uploading_video" | "recording_voice" | "recording_video_note" | "choosing_sticker">

export interface ChatActivityData {
  chat_id: number
  sender: SenderData
  action: ChatActivityKind
}

export type MsgContent =
  | { kind: "Event"; data: { action: string; members: SenderData[]; text: string; message_id: number } }
  | { kind: "Text"; data: { text: string; entities?: TextEntityData[] } }
  | { kind: "Photo"; data: { file_id: number; thumbnail_file_id?: number | null; width: number; height: number; caption: string; entities?: TextEntityData[] } }
  | { kind: "Animation"; data: { file_id: number; width: number; height: number; duration: number; file_name: string; mime_type: string; caption: string; entities?: TextEntityData[] } }
  | { kind: "Video"; data: { file_id: number; width: number; height: number; duration: number; file_name: string; thumbnail_file_id: number | null; caption: string; entities?: TextEntityData[] } }
  | { kind: "VideoNote"; data: { file_id: number; duration: number; thumbnail_file_id: number | null } }
  | { kind: "File"; data: { file_id: number; file_name: string; size: number; caption: string; entities?: TextEntityData[] } }
  | { kind: "Audio"; data: { file_id: number; file_name: string; size: number; duration: number; title: string; performer: string; mime_type: string; cover_file_id: number | null; caption: string; entities?: TextEntityData[] } }
  | { kind: "Voice"; data: { file_id: number; duration: number; waveform: string; mime_type: string; caption: string; entities?: TextEntityData[] } }
  | { kind: "Sticker"; data: { file_id: number; width: number; height: number; emoji: string; format: "webp" | "tgs" | "webm" } }
  | { kind: "Unsupported"; data: { label: string } }

export interface MessageReplacement {
  old_message_id: number
  message: MsgData
}

export interface MessageContentPayload {
  chat_id: number
  message_id: number
  content: MsgContent
}

export interface DeletedMessagesPayload {
  chat_id: number
  message_ids: number[]
  saved_messages?: MsgData[]
}

export interface FileData {
  file_id: number
  local_path: string | null
  downloaded: number
  size: number
}

export interface AttachmentData {
  path: string
  file_name: string
  size: number
  kind: "photo" | "video" | "file" | "voice"
}

export interface VideoInfo {
  width: number
  height: number
  duration: number
}

export interface MessageActions {
  can_reply: boolean
  can_copy: boolean
  can_edit: boolean
  can_delete_for_self: boolean
  can_delete_for_all: boolean
  can_get_viewers: boolean
  can_forward?: boolean
  can_save?: boolean
}

export interface ComposeDraft {
  text: string
  entities?: TextEntityData[]
  attachment: AttachmentData | null
  videoInfo: VideoInfo | null
  reply: MsgData | null
  editing: MsgData | null
}

export interface StickerData {
  file_id: number
  set_id?: string
  width: number
  height: number
  emoji: string
  format: "webp" | "tgs" | "webm"
  thumbnail_file_id?: number | null
}

export interface StickerSetData {
  id: string
  title: string
  cover: StickerData | null
}

export interface StickerCatalog {
  recent: StickerData[]
  sets: StickerSetData[]
}

export interface ConversationData {
  chat: ChatSummary
  threadId?: number
  title?: string
  replyCount?: number
  unreadCount?: number
  lastReadInboxMessageId?: number
}

export type RightPanel = { kind: "chat"; key: number } | { kind: "stickers"; key: number } | null

export type ContextTarget =
  | { kind: "message"; message: MsgData; x: number; y: number }
  | { kind: "reaction"; message: MsgData; reaction: ReactionData; x: number; y: number }
  | { kind: "chat"; chat: ChatSummary; folderId: number; x: number; y: number }

export const api = {
  downloadSettings: () => invoke<DownloadSettings>("download_settings"),
  setDownloadDrive: (drive: string) => invoke<DownloadSettings>("set_download_drive", { drive }),
  saveMessageFile: (chatId: number, messageId: number, onMessage: (progress: DownloadProgress) => void) => {
    const onProgress = new Channel(onMessage)
    return invoke<{ file_name: string; path: string }>("save_message_file", { chatId, messageId, onProgress })
  },
  pinnedMessages: (chatId: number, threadId?: number, fromMessageId = 0) => invoke<ProfileMedia>("pinned_messages", { chatId, threadId, fromMessageId }),
  messageThread: (chatId: number, messageId: number) => invoke<{ chat: ChatSummary; thread_id: number; roots: MsgData[]; reply_count: number; unread_count: number; last_read_inbox_message_id: number }>("message_thread", { chatId, messageId }),
  threadHistory: (chatId: number, threadId: number, fromMessageId = 0, direction: "older" | "newer" | "around" = "older") => invoke<MsgData[]>("thread_history", { chatId, threadId, fromMessageId, direction }),
  resolveTelegramLink: (url: string) => invoke<{ chat: ChatSummary; message_id: number | null }>("resolve_telegram_link", { url }),
  compactChats: () => invoke<void>("compact_chats"),
  stickerCatalog: () => invoke<StickerCatalog>("sticker_catalog"),
  stickerPack: (setId: string) => invoke<StickerData[]>("sticker_pack", { setId }),
  sendSticker: (chatId: number, sticker: StickerData, replyToMessageId: number | null = null, threadId?: number) => invoke<MsgData>("send_sticker", { chatId, sticker, replyToMessageId, threadId }),
  searchMessages: (chatId: number, query: string, fromMessageId = 0, own?: boolean, threadId?: number) =>
    invoke<ProfileMedia>("search_messages", { chatId, query, fromMessageId, own, threadId }),
  installWallpaper: (path: string) => invoke<string>("install_wallpaper", { path }),
  setSkipRead: (enabled: boolean) => invoke<boolean>("set_skip_read", { enabled }),
  setChatPrivacy: (preferences: ChatPrivacy) => invoke<ChatPrivacy>("set_chat_privacy", { preferences }),
  sendChatAction: (chatId: number, threadId: number | undefined, action: ComposerStatus | "cancel", manual: boolean) => invoke<void>("send_chat_action", { chatId, threadId, action, manual }),
  setNotifications: (preferences: NotificationPreferences) => invoke<NotificationPreferences>("set_notifications", { preferences }),
  mentionMembers: (chatId: number, query: string) => invoke<UserPayload[]>("mention_members", { chatId, query }),
  getMessage: (chatId: number, messageId: number) => invoke<MsgData>("get_message", { chatId, messageId }),
  messageContext: (chatId: number, messageId: number, includeTarget = true) => invoke<MsgData[]>("message_context", { chatId, messageId, includeTarget }),
  newerMessages: (chatId: number, fromMessageId: number) => invoke<MsgData[]>("newer_messages", { chatId, fromMessageId }),
  availableReactions: (chatId: number, messageId: number) => invoke<ReactionData[]>("available_reactions", { chatId, messageId }),
  reactionSenders: (chatId: number, messageId: number, key: string, offset = "") => invoke<{ senders: SenderData[]; next_offset: string }>("reaction_senders", { chatId, messageId, key, offset }),
  setReaction: (chatId: number, messageId: number, key: string, add: boolean) => invoke<void>("set_reaction", { chatId, messageId, key, add }),
  reactionSticker: (customEmojiId: string) => invoke<{ file_id: number | null; emoji: string }>("reaction_sticker", { customEmojiId }),
  setSaveDeleted: (enabled: boolean, seen: MsgData[]) => invoke<boolean>("set_save_deleted", { enabled, seen }),
  savedDeleted: (chatId: number) => invoke<MsgData[]>("saved_deleted", { chatId }),
  appLockStatus: () => invoke<AppLockStatus>("app_lock_status"),
  unlockApp: (secret: string) => invoke<AppLockResult>("unlock_app", { secret }),
  setAppLock: (current: string, kind: "pin" | "password" | null, secret: string) => invoke<AppLockResult>("set_app_lock", { current, kind, secret }),
  acknowledgeLockLogout: () => invoke<AppLockStatus>("acknowledge_lock_logout"),
  snapshot: () => invoke<AppSnapshot>("app_snapshot"),
  setPhone: (phone: string) => invoke<void>("set_phone", { phone }),
  requestQrLogin: () => invoke<void>("request_qr_login"),
  cancelQrLogin: () => invoke<void>("cancel_qr_login"),
  setCode: (code: string) => invoke<void>("set_code", { code }),
  setPassword: (password: string) => invoke<void>("set_password", { password }),
  registerUser: (firstName: string, lastName: string) =>
    invoke<void>("register_user", { firstName, lastName }),
  loadMoreChats: () => invoke<boolean>("load_more_chats"),
  selectFolder: (folderId: number) => invoke<boolean>("select_folder", { folderId }),
  privateChat: (userId: number) => invoke<ChatSummary>("private_chat", { userId }),
  getProfile: (target: ProfileTarget) => invoke<ProfileData>("get_profile", { target }),
  profileMedia: (chatId: number, category: string, fromMessageId = 0, limit = 20) =>
    invoke<ProfileMedia>("profile_media", { chatId, category, fromMessageId, limit }),
  profilePhotos: (userId: number, offset = 0) => invoke<ProfilePhotos>("profile_photos", { userId, offset }),
  profileMembers: (chatId: number, offset = 0, onlineOnly = false) => invoke<SenderData[]>("profile_members", { chatId, offset, onlineOnly }),
  openMessageContent: (chatId: number, messageId: number, kind: "video_note" | "voice") => invoke<void>("open_message_content", { chatId, messageId, kind }),
  openChat: (chatId: number) => invoke<void>("open_chat", { chatId }),
  openChatWindow: (chatId: number) => invoke<void>("open_chat_window", { chatId }),
  chatWindowChat: () => invoke<ChatSummary>("chat_window_chat"),
  closeChat: (chatId: number) => invoke<void>("close_chat", { chatId }),
  viewMessages: (chatId: number, messageIds: number[]) =>
    invoke<boolean>("view_messages", { chatId, messageIds }),
  getHistory: (chatId: number, fromMessageId: number, limit: number) =>
    invoke<MsgData[]>("get_history", { chatId, fromMessageId, limit }),
  sendText: (chatId: number, text: string, replyToMessageId: number | null = null, entities?: TextEntityData[], threadId?: number) =>
    invoke<MsgData>("send_text", { chatId, text, replyToMessageId, entities, threadId }),
  sendFile: (chatId: number, path: string, caption: string, replyToMessageId: number | null = null, videoInfo: VideoInfo | null = null, entities?: TextEntityData[], threadId?: number) =>
    invoke<MsgData>("send_file", { chatId, path, caption, replyToMessageId, videoInfo, entities, threadId }),
  prepareAttachment: (path: string) => invoke<AttachmentData>("prepare_attachment", { path }),
  prepareClipboardImage: (bytes: ArrayBuffer) => invoke<AttachmentData>("prepare_clipboard_image", bytes),
  prepareVoice: (bytes: ArrayBuffer) => invoke<AttachmentData>("prepare_voice", bytes),
  sendVoice: (chatId: number, path: string, duration: number, caption: string, replyToMessageId: number | null = null, entities?: TextEntityData[], threadId?: number) =>
    invoke<MsgData>("send_voice", { chatId, path, duration, caption, replyToMessageId, entities, threadId }),
  messageActions: (chatId: number, messageId: number) => invoke<MessageActions>("message_actions", { chatId, messageId }),
  nextMention: (chatId: number, after: number | null) => invoke<number | null>("next_mention", { chatId, after }),
  forwardTargets: (query: string) => invoke<ChatSummary[]>("forward_targets", { query }),
  forwardMessage: (chatId: number, fromChatId: number, messageId: number) => invoke<MsgData>("forward_message", { chatId, fromChatId, messageId }),
  messageViewers: (chatId: number, messageId: number) => invoke<UserPayload[]>("message_viewers", { chatId, messageId }),
  editMessage: (chatId: number, messageId: number, text: string, entities?: TextEntityData[]) => invoke<MsgData>("edit_message", { chatId, messageId, text, entities }),
  deleteMessage: (chatId: number, messageId: number, revoke: boolean) => invoke<void>("delete_message", { chatId, messageId, revoke }),
  chatAction: (chatId: number, folderId: number, action: "pin" | "archive" | "unread") => invoke<ChatSummary>("chat_action", { chatId, folderId, action }),
  setChatMuted: (chatId: number, muted: boolean) => invoke<void>("set_chat_muted", { chatId, muted }),
  downloadFile: (fileId: number) => invoke<FileData>("download_file", { fileId }),
  logout: () => invoke<void>("logout"),
}

type Handlers = {
  onPinnedMessagesChanged: (chatId: number) => void
  onStickerPack: (pack: { id: string; stickers: StickerData[] }) => void
  onStickersChanged: (kind: "recent" | "sets") => void
  onMessageReactions: (p: MessageReactionsPayload) => void
  onAuthState: (p: AuthStatePayload) => void
  onChats: (p: ChatListPayload) => void
  onMessage: (p: MsgData) => void
  onMessageReplaced: (p: MessageReplacement) => void
  onMessageContent: (p: MessageContentPayload) => void
  onMessagesDeleted: (p: DeletedMessagesPayload) => void
  onFile: (p: FileData) => void
  onConnection: (p: string) => void
  onUser: (p: UserPayload) => void
  onFolders: (p: FolderData[]) => void
  onChatOnlineCount: (p: { chat_id: number; count: number }) => void
  onChatMentions: (p: { chat_id: number; count: number }) => void
  onChatNotifications: (p: ChatNotificationUpdate) => void
  onChatActivity: (p: ChatActivityData) => void
}

export async function initTdEvents(h: Handlers): Promise<() => void> {
  const unsubs = await Promise.all([
    listen<number>("pinned-messages-changed", (e) => h.onPinnedMessagesChanged(e.payload)),
    listen<{ id: string; stickers: StickerData[] }>("sticker-pack", (e) => h.onStickerPack(e.payload)),
    listen<"recent" | "sets">("stickers-changed", (e) => h.onStickersChanged(e.payload)),
    listen<MessageReactionsPayload>("message-reactions", (e) => h.onMessageReactions(e.payload)),
    listen<AuthStatePayload>("auth-state", (e) => h.onAuthState(e.payload)),
    listen<ChatListPayload>("chats", (e) => h.onChats(e.payload)),
    listen<MsgData>("message", (e) => h.onMessage(e.payload)),
    listen<MessageReplacement>("message-replaced", (e) => h.onMessageReplaced(e.payload)),
    listen<MessageContentPayload>("message-content", (e) => h.onMessageContent(e.payload)),
    listen<DeletedMessagesPayload>("messages-deleted", (e) => h.onMessagesDeleted(e.payload)),
    listen<FileData>("file", (e) => h.onFile(e.payload)),
    listen<string>("connection", (e) => h.onConnection(e.payload)),
    listen<UserPayload>("user", (e) => h.onUser(e.payload)),
    listen<FolderData[]>("folders", (e) => h.onFolders(e.payload)),
    listen<{ chat_id: number; count: number }>("chat-online-count", (e) => h.onChatOnlineCount(e.payload)),
    listen<{ chat_id: number; count: number }>("chat-mentions", (e) => h.onChatMentions(e.payload)),
    listen<ChatNotificationUpdate>("chat-notifications", (e) => h.onChatNotifications(e.payload)),
    listen<ChatActivityData>("chat-activity", (e) => h.onChatActivity(e.payload)),
  ])
  return () => unsubs.forEach((u) => u())
}
