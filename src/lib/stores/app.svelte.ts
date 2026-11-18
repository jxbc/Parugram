import { SvelteMap } from "svelte/reactivity"
import type {
  AuthStatePayload, ChatListPayload, ChatSummary, DeletedMessagesPayload,
  MessageContentPayload, MessageReplacement, MsgContent, MsgData, SenderData, UserPayload,
  FolderData, ProfileData, ProfileTarget,
  ChatPrivacy, NotificationPreferences,
  ComposeDraft, ContextTarget, AppLockStatus, MediaItem, MusicTrack, ChatActivityData, ReactionData, MessageReactionsPayload, TextEntityData, StickerCatalog, StickerData, ConversationData, RightPanel,
} from "$lib/api/td"
import { initTdEvents, api } from "$lib/api/td"

export { api }

export const themePresets = [
  { id: "default", name: "Parugram", accent: "#347fff", background: "#090d15", surface: "#12161e", incoming: "#1b3151", wallpaper: "none" },
  { id: "next", name: "Next", accent: "#668fff", background: "#05070b", surface: "#10131c", incoming: "#1b2740", wallpaper: 'url("/themes/next.png")' },
  { id: "telegram", name: "Telegram", accent: "#5faee7", background: "#0e1621", surface: "#17212b", incoming: "#182533", outgoing: "#2b5278", wallpaper: "none" },
  { id: "graphite", name: "Графит", accent: "#a1a9bb", background: "#101113", surface: "#1b1c20", incoming: "#303139", wallpaper: "none" },
  { id: "forest", name: "Лес", accent: "#34b99a", background: "#071310", surface: "#11231e", incoming: "#173e33", wallpaper: "radial-gradient(ellipse at 15% 20%, #154e40, transparent 65%), radial-gradient(ellipse at 90% 80%, #182c25, transparent 60%)" },
  { id: "dusk", name: "Сумерки", accent: "#a780ff", background: "#100b1a", surface: "#1b1429", incoming: "#35234e", wallpaper: "radial-gradient(ellipse at 80% 20%, #35234f, transparent 65%), radial-gradient(ellipse at 10% 85%, #36203b, transparent 60%)" },
  { id: "ember", name: "Закат", accent: "#ef9965", background: "#170e0c", surface: "#261b17", incoming: "#493027", wallpaper: "radial-gradient(ellipse at 20% 75%, #4b2720, transparent 65%), radial-gradient(ellipse at 85% 20%, #39261a, transparent 60%)" },
  { id: "custom", name: "Своя", accent: "#347fff", background: "#090d15", surface: "#12161e", incoming: "#1b3151", wallpaper: "none" },
]

export const interfaceFontGroups = [
  { label: "Встроенные", fonts: ["Inter", "Geist Sans", "Onest", "Fixel Display", "Open Sans", "Geist Mono"] },
  { label: "Системные", fonts: ["Segoe UI", "Arial", "Georgia", "Consolas", "Courier New"] },
]

const interfaceFonts = interfaceFontGroups.flatMap(({ fonts }) => fonts)
const defaultNotifications: NotificationPreferences = { enabled: true, private: true, group: true, channel: true, group_mentions: true }

type DownloadNotice = { fileName: string; stage: "downloading" | "saving" | "done" | "error"; progress?: number; path?: string; error?: string }

export const store = $state({
  stage: "loading",
  qrLoginLink: null as string | null,
  viewportWidth: 0,
  chatWindowId: null as number | null,
  showChatList: false,
  windowVisible: true,
  rightPanel: null as RightPanel,
  previousRightPanel: null as RightPanel,
  conversations: new SvelteMap<number, ConversationData>(),
  focusedConversation: null as number | null,
  composeFocusChatId: null as number | null,
  atBottom: new SvelteMap<number, boolean>(),
  readPaused: new SvelteMap<number, boolean>(),
  newMessageCounts: new SvelteMap<number, number>(),
  mentionCounts: new SvelteMap<number, number>(),
  chatMuteOverrides: new SvelteMap<number, boolean | null>(),
  chatMutePending: new SvelteMap<number, boolean>(),
  mutedScopes: {} as NonNullable<ChatListPayload["muted_scopes"]>,
  scrollPositions: new Map<number, { id: number; offset: number; readPaused: boolean }>(),
  chatBackStack: [] as (ChatSummary | null)[],
  appLock: null as AppLockStatus | null,
  privacyMode: false,
  saveDeleted: false,
  skipRead: false,
  scrollOnReply: false,
  chatPrivacy: chatPrivacyDefaults(false),
  notifications: { ...defaultNotifications },
  recentStickerLimit: 75,
  stickerCatalog: null as StickerCatalog | null,
  stickerPacks: new SvelteMap<string, StickerData[]>(),
  stickersRevision: 0,
  customization: {
    theme: "default", accent: "#347fff", background: "#090d15", wallpaper: null as string | null,
    fontFamily: "Open Sans", layout: "classic" as "classic" | "panels",
    fontSize: 13, bubbleRadius: 19, panelOpacity: 78, wallpaperOpacity: 80, softEdges: true, bubbleBlur: true, dynamicGlow: true,
  },
  replyPreviews: new SvelteMap<string, MsgData | null>(),
  reactionStickers: new SvelteMap<string, { file_id: number | null; emoji: string }>(),
  reactionBusy: new SvelteMap<string, boolean>(),
  historyAtLatest: new SvelteMap<number, boolean>(),
  jumpTarget: null as { chatId: number; messageId: number; token: number } | null,
  mediaViewer: null as { items: MediaItem[]; index: number } | null,
  user: null as UserPayload | null,
  chats: [] as ChatSummary[],
  chatLimit: 50,
  selectedFolder: 0,
  folders: [{ id: 0, title: "Все" }, { id: -1, title: "Архив" }] as FolderData[],
  effects: "full" as "full" | "reduced",
  openedChat: null as ChatSummary | null,
  profileTarget: null as ProfileTarget | null,
  profile: null as ProfileData | null,
  profileLoading: false,
  profileError: "",
  playingVoice: null as string | null,
  voice: null as { key: string; chatId: number; messageId: number; conversationKey?: number; fileId: number; path: string | null; playing: boolean; loading: boolean; position: number; duration: number; speed: number; seekTo: number | null; error: string; opened: boolean } | null,
  music: null as { track: MusicTrack; queue: MusicTrack[]; playing: boolean; loading: boolean; position: number; duration: number; error: string } | null,
  musicVolume: .8,
  musicRepeat: "off" as "off" | "all" | "one",
  musicShuffle: false,
  pinnedRevisions: new SvelteMap<number, number>(),
  contextMenu: null as ContextTarget | null,
  focusedMessage: null as { message: MsgData; isGroup: boolean } | null,
  composeFocus: 0,
  drafts: new SvelteMap<number, ComposeDraft>(),
  sendingChats: new SvelteMap<number, boolean>(),
  composeErrors: new SvelteMap<number, string>(),
  connection: "connecting",
  cached: false,
  chatsReady: false,
  hasMoreChats: true,
  loadingChats: false,
  chatsError: "",
  startupError: "",
  activeChatId: null as number | null,
  messages: new SvelteMap<number, MsgData[]>(),
  files: new SvelteMap<number, string>(),
  mediaTransfer: null as { fileId: number; downloaded: number; size: number } | null,
  downloads: new SvelteMap<string, DownloadNotice>(),
  users: new SvelteMap<number, UserPayload>(),
  onlineCounts: new SvelteMap<number, number>(),
  chatActivity: new SvelteMap<number, ChatActivityData[]>(),
  historyDone: new SvelteMap<number, boolean>(),
  historyLoaded: new SvelteMap<number, boolean>(),
  historyLoading: new SvelteMap<number, boolean>(),
  historyError: new SvelteMap<number, string>(),
})

function chatPrivacyDefaults(skipRead: boolean): ChatPrivacy {
  return { hide_video_views: skipRead, hide_voice_listens: skipRead, hide_typing: true }
}

const cacheKey = "parugram:chats:v1"
const replacements = new Map<string, MsgData>()
const messageKeys = new Map<string, string>()
const senderColors = new Map<string, string>()
const nicknamePalette = ["#f6a35c", "#f17483", "#76c68e", "#73b9f1", "#bd9af5", "#65c8c3"]

export function senderColor(sender: SenderData) {
  const key = `${sender.kind}:${sender.id}`
  let color = senderColors.get(key)
  if (!color) {
    color = nicknamePalette[Math.floor(Math.random() * nicknamePalette.length)]
    senderColors.set(key, color)
  }
  return color
}
let stickerCatalogRequest: Promise<void> | undefined
let stickerCatalogRevision = -1
let stickerSetsRevision = 0
const stickerPackRequests = new Map<string, Promise<void>>()
const deleted = new Set<string>()
const contentUpdates = new Map<string, MsgContent>()
const savedDeleted = new Map<string, MsgData>()
const reactionUpdates = new Map<string, ReactionData[]>()
const reactionRevisions = new Map<string, number>()
const replyRequests = new Map<string, Promise<void>>()
const reactionStickerRequests = new Map<string, Promise<void>>()
const historyEpoch = new Map<number, number>()
const newerRequests = new Map<number, Promise<void>>()
let jumpRequest = 0
const historyCursor = new Map<number, number>()
const historyRequests = new Map<number, Promise<void>>()
const historyReleaseTimers = new Map<number, ReturnType<typeof setTimeout>>()
const downloadTimers = new Map<string, ReturnType<typeof setTimeout>>()
const activeDownloads = new Set<number>()
const avatarRequests = new Map<number, Promise<string | null>>()
const attachmentRequests = new Map<number, number>()
const editBackups = new Map<number, ComposeDraft>()
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>()
let initialized = false
let session = 0
let cacheTimer: ReturnType<typeof setTimeout> | undefined
let profileRequest = 0
let folderRequest = 0
let rightRequest = 0
let nextThreadKey = -8000000000000000
const liveMessages = new Set<string>()
const counterReadThrough = new Map<number, number>()
const feedCounts = new Map<number, number>()
const feedRequests = new Map<number, Promise<void>>()

export function conversationTarget(key: number) {
  const conversation = store.conversations.get(key)
  return { chatId: conversation?.chat.id ?? key, threadId: conversation?.threadId }
}

export function isConversationVisible(key: number) {
  return (store.activeChatId === key && (!compactView() || !store.showChatList)) || visibleRightPanel()?.key === key
}

export function visibleChat(chatId: number) {
  const panel = visibleRightPanel()
  return isConversationVisible(chatId) || !!panel && conversationTarget(panel.key).chatId === chatId
}

function keyForMessage(message: MsgData, preferred?: number | null) {
  const focused = preferred ?? store.focusedConversation
  if (focused !== null && focused !== undefined) {
    const target = conversationTarget(focused)
    if (target.chatId === message.chat_id && (!target.threadId || target.threadId === message.thread_id)) return focused
  }
  return message.chat_id
}

function messageViewKeys(message: MsgData) {
  return [message.chat_id, ...[...store.conversations].filter(([key, view]) => key !== message.chat_id && view.chat.id === message.chat_id && (!view.threadId || view.threadId === message.thread_id)).map(([key]) => key)]
}

function refreshMessageViews(chatId: number) {
  for (const [key, list] of store.messages) if (conversationTarget(key).chatId === chatId) store.messages.set(key, mergeMessages(list))
}

export function compactView() {
  return store.chatWindowId === null && store.viewportWidth > 0 && store.viewportWidth < 760
}

export function canSplitView() {
  return store.chatWindowId === null && store.viewportWidth >= 1200
}

export function visibleRightPanel() {
  const panel = store.rightPanel
  if (panel?.kind === "chat" && !store.conversations.get(panel.key)?.threadId && !canSplitView()) return null
  return panel
}

export function openSplitChat(chat: ChatSummary) {
  if (!store.chatsReady || !canSplitView() || chat.id === store.activeChatId) return false
  rightRequest += 1
  store.conversations.set(chat.id, { chat })
  store.rightPanel = { kind: "chat", key: chat.id }
  store.previousRightPanel = null
  closeMessageOverlays()
  return true
}

export function openStickerPanel(key: number) {
  if (!store.chatsReady) return
  rightRequest += 1
  if (store.rightPanel?.kind === "stickers" && store.rightPanel.key === key) {
    closeRightPanel()
    return
  }
  if (store.rightPanel?.kind !== "stickers") store.previousRightPanel = store.rightPanel
  store.rightPanel = { kind: "stickers", key }
}

export function closeRightPanel() {
  rightRequest += 1
  const previous = store.rightPanel?.kind === "stickers" ? store.previousRightPanel : null
  store.rightPanel = previous
  store.previousRightPanel = null
  store.focusedConversation = previous?.key ?? store.activeChatId
  closeMessageOverlays()
}

export async function openComments(message: MsgData) {
  if (!store.chatsReady) return
  const token = ++rightRequest
  const currentSession = session
  const data = await api.messageThread(message.chat_id, message.id)
  if (token !== rightRequest || currentSession !== session) return
  let key = [...store.conversations].find(([, view]) => view.chat.id === data.chat.id && view.threadId === data.thread_id)?.[0]
  if (key === undefined) key = nextThreadKey++
  store.conversations.set(key, { chat: data.chat, threadId: data.thread_id, title: "Комментарии", replyCount: data.reply_count, unreadCount: data.unread_count, lastReadInboxMessageId: data.last_read_inbox_message_id })
  store.rightPanel = { kind: "chat", key }
  store.previousRightPanel = null
  store.focusedConversation = key
  closeMessageOverlays()
}

export async function openTelegramLink(url: string) {
  const currentSession = session
  const target = await api.resolveTelegramLink(url)
  if (currentSession !== session) return
  openConversation(target.chat)
  if (target.message_id) await jumpToMessage(target.chat.id, target.message_id)
}

export async function openChatFeed(key: number) {
  const id = conversationTarget(key).chatId
  feedCounts.set(id, (feedCounts.get(id) ?? 0) + 1)
  const pending = feedRequests.get(id)
  if (pending) return pending
  if ((feedCounts.get(id) ?? 0) > 1) return
  const request = requestMessages(() => api.openChat(id), false).finally(() => feedRequests.delete(id))
  feedRequests.set(id, request)
  return request
}

export async function closeChatFeed(key: number) {
  const id = conversationTarget(key).chatId
  const count = (feedCounts.get(id) ?? 1) - 1
  if (count > 0) {
    feedCounts.set(id, count)
    return
  }
  feedCounts.delete(id)
  await feedRequests.get(id)?.catch(() => {})
  if (!feedCounts.has(id)) await api.closeChat(id)
}

export function trimHistory(key: number, keep = 100) {
  if (store.atBottom.get(key) === false || store.historyAtLatest.get(key) === false || store.historyLoading.get(key)) return
  const messages = store.messages.get(key) ?? []
  if (messages.length <= keep) return
  const retained = messages.filter((message, index) => index >= messages.length - keep || message.sending_state !== "sent")
  store.messages.set(key, retained)
  historyCursor.set(key, Math.min(...retained.map((message) => message.id)))
  store.historyDone.set(key, false)
}

export function retainHistory(key: number) {
  clearTimeout(historyReleaseTimers.get(key))
  historyReleaseTimers.delete(key)
}

export function releaseHistory(key: number) {
  retainHistory(key)
  const currentSession = session
  historyReleaseTimers.set(key, setTimeout(() => {
    historyReleaseTimers.delete(key)
    if (currentSession !== session || isConversationVisible(key)) return
    historyEpoch.set(key, (historyEpoch.get(key) ?? 0) + 1)
    historyRequests.delete(key)
    newerRequests.delete(key)
    historyCursor.delete(key)
    const unsent = store.messages.get(key)?.filter((message) => message.sending_state !== "sent")
    if (unsent?.length) store.messages.set(key, unsent)
    else store.messages.delete(key)
    store.historyLoaded.delete(key)
    store.historyLoading.delete(key)
    store.historyDone.delete(key)
    store.historyError.delete(key)
    store.historyAtLatest.delete(key)
    store.newMessageCounts.delete(key)
    counterReadThrough.delete(key)
    store.readPaused.delete(key)
  }, 15000))
}

export async function compactChats() {
  if (!store.chatsReady || store.chatLimit <= 50) return
  store.chatLimit = 50
  await api.compactChats()
}

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`
}

export function isLiveMessage(message: MsgData) {
  return liveMessages.has(messageKey(message.chat_id, message.id))
}

export async function playVoice(chatId: number, messageId: number, fileId: number, duration: number, speed: number, conversationKey?: number) {
  if (!store.chatsReady || store.appLock?.locked) return
  const key = messageKey(chatId, messageId)
  if (store.voice?.key !== key || store.voice.fileId !== fileId) {
    store.voice = { key, chatId, messageId, conversationKey, fileId, path: null, playing: false, loading: false, position: 0, duration, speed, seekTo: null, error: "", opened: false }
  }
  const voice = store.voice
  if (voice.loading) return
  if (voice.playing && store.playingVoice === key) {
    voice.playing = false
    store.playingVoice = null
    return
  }
  if (store.music) store.music.playing = false
  store.playingVoice = key
  voice.error = ""
  voice.playing = true
  if (voice.path) return
  const path = store.files.get(fileId)
  if (path) {
    voice.path = path
    return
  }
  voice.loading = true
  try {
    voice.path = await loadAvatar(fileId)
    if (!voice.path) throw new Error()
  } catch {
    if (store.voice !== voice) return
    voice.error = "Не удалось загрузить голосовое"
    voice.playing = false
    if (store.playingVoice === key) store.playingVoice = null
  } finally { voice.loading = false }
}

export function seekVoice(position: number) {
  const voice = store.voice
  if (!voice?.path || voice.duration <= 0 || !Number.isFinite(position)) return
  voice.seekTo = Math.max(0, Math.min(voice.duration, position))
  voice.position = voice.seekTo
}

export function stopVoice() {
  if (store.voice && store.playingVoice === store.voice.key) store.playingVoice = null
  store.voice = null
}

export function musicTrack(message: MsgData): MusicTrack | null {
  const content = message.content
  if (message.is_deleted || content.kind !== "Audio" && !(content.kind === "File" && /\.(mp3|m4a|flac|wav|ogg|opus|aac|aiff|alac)$/i.test(content.data.file_name))) return null
  const data = content.data
  return {
    key: messageKey(message.chat_id, message.id), chatId: message.chat_id, messageId: message.id, fileId: data.file_id,
    title: content.kind === "Audio" ? content.data.title || data.file_name || "Музыка" : data.file_name,
    performer: content.kind === "Audio" ? content.data.performer : "",
    fileName: data.file_name, duration: content.kind === "Audio" ? content.data.duration : 0, date: message.date,
    coverFileId: content.kind === "Audio" ? content.data.cover_file_id : null,
  }
}

function selectMusicTrack(track: MusicTrack, queue: MusicTrack[]) {
  stopVoice()
  store.playingVoice = null
  store.music = { track, queue, playing: true, loading: false, position: 0, duration: track.duration, error: "" }
}

export function playMusic(message: MsgData, collection = store.messages.get(message.chat_id) ?? []) {
  if (!store.chatsReady || store.appLock?.locked) return
  const track = musicTrack(message)
  if (!track) return
  if (store.music?.track.key === track.key) {
    store.music.error = ""
    store.music.playing = !store.music.playing
    if (store.music.playing) {
      stopVoice()
      store.playingVoice = null
    }
    return
  }
  const tracks = collection.map(musicTrack).filter((item): item is MusicTrack => item !== null)
  const queue = [...new Map([...tracks, track].map((item) => [item.key, item])).values()].sort((a, b) => a.date - b.date || a.messageId - b.messageId)
  selectMusicTrack(track, queue)
  if (store.musicShuffle) setMusicShuffle(true)
}

export function setMusicShuffle(enabled: boolean) {
  store.musicShuffle = enabled
  const music = store.music
  if (!music) return
  if (!enabled) {
    music.queue = [...music.queue].sort((a, b) => a.date - b.date || a.messageId - b.messageId)
    return
  }
  const others = music.queue.filter((track) => track.key !== music.track.key)
  for (let index = others.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.random() * (index + 1))
    const track = others[index]
    others[index] = others[next]
    others[next] = track
  }
  music.queue = [music.track, ...others]
}

export function stepMusic(direction: number, ended = false) {
  const music = store.music
  if (!music) return false
  if (ended && store.musicRepeat === "one" || direction < 0 && music.position > 3) {
    selectMusicTrack(music.track, music.queue)
    return true
  }
  const index = music.queue.findIndex((track) => track.key === music.track.key)
  let next = index + direction
  if (next < 0 || next >= music.queue.length) {
    if (store.musicRepeat !== "all") {
      if (ended) music.playing = false
      return false
    }
    next = (next + music.queue.length) % music.queue.length
  }
  selectMusicTrack(music.queue[next], music.queue)
  return true
}

export function stopMusic() { store.music = null }

export function chatMuted(chat: ChatSummary) {
  const override = store.chatMuteOverrides.get(chat.id)
  const muted = override === undefined ? chat.notifications_muted : override
  return muted ?? store.mutedScopes[chat.notification_scope ?? (chat.is_group ? "group" : "private")] ?? false
}

export async function setChatMuted(chatId: number, muted: boolean) {
  if (!store.chatsReady || store.chatMutePending.has(chatId)) return
  const currentSession = session
  store.chatMutePending.set(chatId, true)
  try {
    await api.setChatMuted(chatId, muted)
  } finally {
    if (currentSession === session) store.chatMutePending.delete(chatId)
  }
}

export function messageRenderKey(message: MsgData) {
  const key = messageKey(message.chat_id, message.id)
  return messageKeys.get(key) ?? key
}

function acceptsMessages() {
  return store.stage === "ready" || !!store.appLock?.session_suspended && !store.appLock.logout_pending && !store.appLock.logged_out
}

function receivesChatUpdates(chatId: number) {
  return store.chatWindowId === null || visibleChat(chatId)
}

const customizationKey = "parugram:customization:v1"
const scrollOnReplyKey = "parugram:scroll-on-reply"
const defaultCustomization = { ...store.customization }

export function normalizeCustomization(value: unknown): typeof store.customization {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const color = (name: "accent" | "background") => typeof data[name] === "string" && /^#[0-9a-f]{6}$/i.test(data[name]) ? data[name] : defaultCustomization[name]
  const range = (name: "fontSize" | "bubbleRadius" | "panelOpacity" | "wallpaperOpacity", minimum: number, maximum: number) => typeof data[name] === "number" && Number.isFinite(data[name]) ? Math.round(Math.max(minimum, Math.min(maximum, data[name]))) : defaultCustomization[name]
  return {
    theme: typeof data.theme === "string" && themePresets.some((theme) => theme.id === data.theme) ? data.theme : "default",
    accent: color("accent"), background: color("background"),
    wallpaper: typeof data.wallpaper === "string" && data.wallpaper.length < 4096 && /^(?:[a-z]:[\\/]|\/)/i.test(data.wallpaper) ? data.wallpaper : null,
    fontFamily: data.fontFamily === "Verdana" ? "Geist Sans" : interfaceFonts.find((font) => font === data.fontFamily) ?? defaultCustomization.fontFamily,
    layout: data.layout === "panels" ? "panels" : defaultCustomization.layout,
    fontSize: range("fontSize", 12, 20), bubbleRadius: range("bubbleRadius", 8, 28),
    panelOpacity: range("panelOpacity", 50, 100), wallpaperOpacity: range("wallpaperOpacity", 0, 100),
    softEdges: typeof data.softEdges === "boolean" ? data.softEdges : true,
    bubbleBlur: typeof data.bubbleBlur === "boolean" ? data.bubbleBlur : true,
    dynamicGlow: typeof data.dynamicGlow === "boolean" ? data.dynamicGlow : true,
  }
}

export function restoreCustomization() {
  try { store.customization = normalizeCustomization(JSON.parse(localStorage.getItem(customizationKey) ?? "null")) }
  catch { store.customization = { ...defaultCustomization } }
}

export function updateCustomization(patch: Partial<typeof store.customization>) {
  let current = store.customization
  if (patch.theme === "custom" && current.theme !== "custom" && (patch.accent || patch.background || patch.wallpaper !== undefined)) {
    const preset = themePresets.find((theme) => theme.id === current.theme) ?? themePresets[0]
    current = { ...current, accent: preset.accent, background: preset.background }
  }
  store.customization = normalizeCustomization({ ...current, ...patch })
  try { localStorage.setItem(customizationKey, JSON.stringify(store.customization)) }
  catch { return }
}

export function resetCustomization() {
  updateCustomization({ ...defaultCustomization })
}

function mixColor(base: string, tint: string, amount: number) {
  const values = [1, 3, 5].map((offset) => Math.round(parseInt(base.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(tint.slice(offset, offset + 2), 16) * amount))
  return `#${values.map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

function rgbaColor(color: string, alpha: number) {
  return `rgba(${[1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)).join(",")},${alpha})`
}

function lightColor(color: string) {
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
  return red * .2126 + green * .7152 + blue * .0722 > .6
}

export function customizationStyles(wallpaperUrl: string | null = null) {
  const settings = store.customization
  const preset = themePresets.find((theme) => theme.id === settings.theme) ?? themePresets[0]
  const custom = settings.theme === "custom"
  const telegram = settings.theme === "telegram"
  const background = custom ? settings.background : preset.background
  const accent = custom ? settings.accent : preset.accent
  const light = lightColor(background)
  const text = telegram ? "#f5f5f5" : light ? "#152033" : "#f0f5ff"
  const secondary = light ? "#526178" : "#97abc8"
  const surface = custom ? mixColor(background, light ? "#ffffff" : "#8797b2", .08) : preset.surface
  const menu = settings.theme === "default" ? "#0e131c" : surface
  const incoming = custom ? mixColor(background, accent, light ? .12 : .2) : preset.incoming
  const outgoing = preset.outgoing ?? (settings.theme === "default" ? "#1d63ef" : accent)
  const outgoingText = telegram ? "#e4ecf2" : lightColor(outgoing) ? "#101b2e" : "#ffffff"
  const opacity = store.effects === "reduced" ? 1 : settings.panelOpacity / 100
  const wallpaper = custom ? wallpaperUrl ? `url(${JSON.stringify(wallpaperUrl)})` : "none" : preset.wallpaper
  return Object.entries({
    "--bg-main": background, "--bg-sidebar": surface, "--bg-input": rgbaColor(light ? "#ffffff" : "#080b10", .5),
    "--surface": rgbaColor(surface, opacity), "--menu-bg": rgbaColor(menu, Math.min(1, opacity + .06)),
    "--accent": accent,
    "--accent-soft": settings.theme === "next" ? "rgba(36,107,170,.28)" : rgbaColor(accent, .24), "--hover": rgbaColor(accent, .1), "--border": rgbaColor(light ? "#253b5c" : "#7daeff", .14),
    "--folder-active": settings.theme === "next" ? "#173f66" : accent, "--folder-active-text": settings.theme === "next" ? "#a3d9ff" : lightColor(accent) ? "#101b2e" : "#ffffff",
    "--text-primary": text, "--text-secondary": settings.theme === "next" ? "#a0a5af" : secondary, "--text-tertiary": settings.theme === "next" ? "#737b88" : light ? "#66778d" : "#697f9f", "--text-on-accent": lightColor(accent) ? "#101b2e" : "#ffffff",
    "--bubble-in": telegram ? incoming : rgbaColor(incoming, store.effects === "reduced" ? 1 : settings.theme === "default" ? .6 : .72),
    "--bubble-out": telegram ? outgoing : rgbaColor(outgoing, store.effects === "reduced" ? 1 : settings.theme === "default" ? .82 : .88),
    "--bubble-out-text": outgoingText, "--bubble-out-meta": telegram ? "#7da8d3" : rgbaColor(outgoingText, .76),
    "--composer-bg": telegram ? surface : rgbaColor(mixColor(background, menu, .45), opacity),
    "--panel-glow": rgbaColor(accent, .12),
    "--interface-font": JSON.stringify(settings.fontFamily), "--message-font-size": `${settings.fontSize}px`, "--bubble-radius": `${settings.bubbleRadius}px`,
    "--chat-wallpaper": wallpaper, "--wallpaper-opacity": String(settings.wallpaperOpacity / 100),
  }).map(([name, value]) => `${name}:${value}`).join(";")
}

function restoreCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(cacheKey) ?? "null")
    if (saved?.version !== 1 || !Number.isSafeInteger(saved.user?.id)
      || typeof saved.user.first_name !== "string" || typeof saved.user.last_name !== "string"
      || typeof saved.user.username !== "string"
      || (saved.user.photo !== null && typeof saved.user.photo !== "string")
      || !Array.isArray(saved.chats)) return

    const chats: ChatSummary[] = saved.chats
    if (!chats.every((chat) => chat && Number.isSafeInteger(chat.id) && typeof chat.title === "string"
      && typeof chat.order === "number" && typeof chat.is_pinned === "boolean"
      && typeof chat.unread_count === "number" && typeof chat.last_read_outbox_message_id === "number"
      && (chat.last_message === null || validMessage(chat.last_message)))) return

    store.user = saved.user
    if (Array.isArray(saved.folders) && saved.folders.every((folder: FolderData) => Number.isInteger(folder.id) && typeof folder.title === "string")) {
      store.folders = saved.folders
    }
    store.chats = chats.slice(0, 50).map((chat) => ({
      ...chat,
      is_group: chat.is_group ?? false,
      photo: typeof chat.photo === "string" ? chat.photo : null,
      photo_file_id: chat.photo_file_id ?? null,
    }))
    if (saved.mutedScopes && typeof saved.mutedScopes === "object") {
      store.mutedScopes = { private: saved.mutedScopes.private === true, group: saved.mutedScopes.group === true, channel: saved.mutedScopes.channel === true }
    }
    store.cached = true
  } catch {
    return
  }
}

function validMessage(message: MsgData): boolean {
  if (!message || !Number.isSafeInteger(message.id) || !Number.isSafeInteger(message.chat_id)
    || typeof message.date !== "number" || typeof message.is_outgoing !== "boolean") return false
  const content = message.content
  if (!content?.data) return false
  switch (content.kind) {
    case "Text": return typeof content.data.text === "string"
    case "Photo": return typeof content.data.file_id === "number" && typeof content.data.caption === "string"
    case "Video": return typeof content.data.file_id === "number" && typeof content.data.caption === "string" && typeof content.data.duration === "number"
    case "Animation": return typeof content.data.file_id === "number" && typeof content.data.caption === "string" && typeof content.data.mime_type === "string"
    case "File": return typeof content.data.file_id === "number" && typeof content.data.file_name === "string"
      && typeof content.data.size === "number" && typeof content.data.caption === "string"
    case "Audio": return typeof content.data.file_id === "number" && typeof content.data.file_name === "string" && typeof content.data.title === "string" && typeof content.data.duration === "number" && typeof content.data.caption === "string"
    case "Unsupported": return typeof content.data.label === "string"
    case "Event": return typeof content.data.action === "string" && Array.isArray(content.data.members)
    case "VideoNote": return typeof content.data.file_id === "number" && typeof content.data.duration === "number"
      && (content.data.thumbnail_file_id === null || typeof content.data.thumbnail_file_id === "number")
    case "Voice": return typeof content.data.file_id === "number" && typeof content.data.duration === "number"
      && typeof content.data.waveform === "string" && typeof content.data.caption === "string"
    case "Sticker": return typeof content.data.file_id === "number" && ["webp", "tgs", "webm"].includes(content.data.format)
    default: return false
  }
}

function saveCache() {
  clearTimeout(cacheTimer)
  cacheTimer = undefined
  if (store.chatWindowId !== null || !store.chatsReady || !store.user || store.stage !== "ready" || store.selectedFolder !== 0 || store.appLock?.locked) return
  try {
    const user = {
      ...store.user,
      photo: store.files.get(store.user.photo_file_id ?? 0) ?? store.user.photo,
    }
    const chats = store.chats.slice(0, 50).map((chat) => ({
      ...chat,
      photo: store.files.get(chat.photo_file_id ?? 0) ?? chat.photo,
      notifications_muted: store.chatMuteOverrides.has(chat.id) ? store.chatMuteOverrides.get(chat.id) : chat.notifications_muted,
    }))
    localStorage.setItem(cacheKey, JSON.stringify({ version: 1, user, chats, folders: store.folders, mutedScopes: store.mutedScopes }))
  } catch {
    return
  }
}

function scheduleCache() {
  if (store.chatWindowId === null && cacheTimer === undefined) cacheTimer = setTimeout(saveCache, 300)
}

function clearSession() {
  downloadTimers.forEach(clearTimeout)
  downloadTimers.clear()
  activeDownloads.clear()
  store.downloads.clear()
  session += 1
  store.qrLoginLink = null
  rightRequest += 1
  store.rightPanel = null
  store.previousRightPanel = null
  store.conversations.clear()
  store.focusedConversation = null
  store.composeFocusChatId = null
  store.atBottom.clear()
  store.readPaused.clear()
  store.newMessageCounts.clear()
  counterReadThrough.clear()
  store.mentionCounts.clear()
  store.chatMuteOverrides.clear()
  store.chatMutePending.clear()
  store.mutedScopes = {}
  store.scrollPositions.clear()
  store.chatBackStack = []
  store.showChatList = false
  liveMessages.clear()
  feedCounts.clear()
  feedRequests.clear()
  clearTimeout(cacheTimer)
  cacheTimer = undefined
  store.user = null
  store.stickerCatalog = null
  store.stickerPacks.clear()
  store.stickersRevision += 1
  stickerCatalogRequest = undefined
  stickerCatalogRevision = -1
  stickerSetsRevision += 1
  stickerPackRequests.clear()
  store.replyPreviews.clear()
  store.reactionStickers.clear()
  store.reactionBusy.clear()
  store.historyAtLatest.clear()
  store.jumpTarget = null
  jumpRequest += 1
  savedDeleted.clear()
  reactionUpdates.clear()
  reactionRevisions.clear()
  replyRequests.clear()
  reactionStickerRequests.clear()
  historyEpoch.clear()
  newerRequests.clear()
  store.chats = []
  store.chatLimit = 50
  store.selectedFolder = 0
  store.folders = [{ id: 0, title: "Все" }, { id: -1, title: "Архив" }]
  store.openedChat = null
  stopVoice()
  store.playingVoice = null
  store.music = null
  store.pinnedRevisions.clear()
  closeMediaViewer()
  closeMessageOverlays()
  store.drafts.clear()
  store.sendingChats.clear()
  store.composeErrors.clear()
  attachmentRequests.clear()
  editBackups.clear()
  closeProfile()
  store.cached = false
  store.chatsReady = false
  store.hasMoreChats = true
  store.loadingChats = false
  store.chatsError = ""
  store.activeChatId = null
  store.messages.clear()
  store.files.clear()
  store.users.clear()
  store.onlineCounts.clear()
  store.chatActivity.clear()
  activityTimers.forEach((timer) => clearTimeout(timer))
  activityTimers.clear()
  store.historyDone.clear()
  store.historyLoaded.clear()
  store.historyLoading.clear()
  store.historyError.clear()
  historyCursor.clear()
  historyRequests.clear()
  historyReleaseTimers.forEach((timer) => clearTimeout(timer))
  historyReleaseTimers.clear()
  avatarRequests.clear()
  replacements.clear()
  messageKeys.clear()
  deleted.clear()
  contentUpdates.clear()
  try {
    localStorage.removeItem(cacheKey)
  } catch {
    return
  }
}

function applyAuth(payload: AuthStatePayload) {
  if (store.appLock?.locked || store.appLock?.session_suspended) return
  if (payload.stage === "wait_other_device" && store.stage === "wait_other_device") {
    store.qrLoginLink = payload.qr_login_link ?? null
    return
  }
  if ((payload.user && store.user && payload.user.id !== store.user.id)
    || !["loading", "ready"].includes(payload.stage)) clearSession()
  store.stage = payload.stage
  store.qrLoginLink = payload.stage === "wait_other_device" ? payload.qr_login_link ?? null : null
  if (payload.user || !store.cached) store.user = payload.user
  scheduleCache()
}

function applyChats(payload: ChatListPayload) {
  if (store.appLock?.locked || store.appLock?.session_suspended) return
  if (store.chatWindowId !== null) {
    if (payload.muted_scopes) store.mutedScopes = payload.muted_scopes
    store.chatsReady = payload.ready && store.stage === "ready"
    const opened = payload.chats.find((chat) => chat.id === store.activeChatId)
    if (opened) store.openedChat = opened
    return
  }
  if ((payload.folder_id ?? 0) !== store.selectedFolder) return
  if (payload.muted_scopes) store.mutedScopes = payload.muted_scopes
  store.chatsReady = payload.ready && store.stage === "ready"
  store.hasMoreChats = payload.has_more || payload.chats.length > store.chatLimit
  store.chatsError = payload.error ?? ""
  if (!store.cached || store.chatsReady) store.chats = payload.chats.slice(0, store.chatLimit)
  const opened = store.chats.find((chat) => chat.id === store.openedChat?.id)
  if (opened) store.openedChat = opened
  if (store.chatsReady) {
    for (const chat of payload.chats) {
      if (chat.unread_mention_count !== undefined) store.mentionCounts.set(chat.id, chat.unread_mention_count)
      if (!store.newMessageCounts.has(chat.id)) continue
      if (chat.unread_count === 0 && chat.last_read_inbox_message_id >= (counterReadThrough.get(chat.id) ?? 0)) store.newMessageCounts.delete(chat.id)
      else if (chat.last_read_inbox_message_id > (counterReadThrough.get(chat.id) ?? 0)) {
        counterReadThrough.set(chat.id, chat.last_read_inbox_message_id)
        store.newMessageCounts.set(chat.id, chat.unread_count)
      }
    }
    store.cached = false
    scheduleCache()
  }
}

export async function initStore(): Promise<void> {
  if (initialized) return
  initialized = true
  try {
    store.privacyMode = localStorage.getItem("parugram:privacy") === "true"
    store.scrollOnReply = localStorage.getItem(scrollOnReplyKey) === "true"
    const recentLimit = Number(localStorage.getItem("parugram:recent-sticker-limit"))
    store.recentStickerLimit = [25, 50, 75, 100].includes(recentLimit) ? recentLimit : 75
    const appearance = localStorage.getItem("parugram:effects")
    store.effects = appearance === "reduced" ? "reduced" : "full"
  } catch {
    store.effects = "full"
  }
  if (store.chatWindowId === null) restoreCache()
  restoreCustomization()
  const revisions = { auth: 0, chats: 0, connection: 0, folders: 0 }

  try {
    await initTdEvents({
      onPinnedMessagesChanged: (id) => { if (acceptsMessages() && receivesChatUpdates(id)) store.pinnedRevisions.set(id, (store.pinnedRevisions.get(id) ?? 0) + 1) },
      onStickerPack: (pack) => { if (acceptsMessages()) store.stickerPacks.set(pack.id, pack.stickers) },
      onStickersChanged: invalidateStickers,
      onMessageReactions: updateMessageReactions,
      onChatActivity: updateChatActivity,
      onChatOnlineCount: (p) => { if (store.stage === "ready" && receivesChatUpdates(p.chat_id)) store.onlineCounts.set(p.chat_id, p.count) },
      onChatMentions: ({ chat_id, count }) => { if (acceptsMessages() && receivesChatUpdates(chat_id)) store.mentionCounts.set(chat_id, count) },
      onChatNotifications: ({ chat_id, muted }) => {
        if (!acceptsMessages() || !receivesChatUpdates(chat_id)) return
        store.chatMuteOverrides.set(chat_id, muted)
        scheduleCache()
      },
      onAuthState: (p) => {
        revisions.auth += 1
        applyAuth(p)
      },
      onChats: (p) => {
        revisions.chats += 1
        applyChats(p)
      },
      onMessage: appendMessage,
      onMessageReplaced: replaceMessage,
      onMessageContent: updateMessageContent,
      onMessagesDeleted: deleteMessages,
      onFile: (p) => {
        if (store.stage === "ready") {
          const viewer = store.mediaViewer
          if (viewer?.items[viewer.index]?.file_id === p.file_id) {
            store.mediaTransfer = p.local_path ? null : { fileId: p.file_id, downloaded: p.downloaded, size: p.size }
          }
          if (p.local_path) {
            store.files.set(p.file_id, p.local_path)
            scheduleCache()
          }
        }
      },
      onUser: (user) => {
        if (!acceptsMessages()) return
        store.users.set(user.id, user)
        if (store.user?.id === user.id) {
          store.user = user
          scheduleCache()
        }
      },
      onFolders: (folders) => {
        if (store.appLock?.locked || store.appLock?.session_suspended) return
        revisions.folders += 1
        store.folders = folders
        if (!folders.some((folder) => folder.id === store.selectedFolder)) {
          store.selectedFolder = 0
          store.chatLimit = 50
          store.chatsReady = false
        }
        scheduleCache()
      },
      onConnection: (p) => {
        revisions.connection += 1
        store.connection = p
      },
    })

    window.addEventListener("pagehide", saveCache)
    window.addEventListener("storage", syncWindowPreferences)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") saveCache()
    })
    const before = { ...revisions }
    const snapshotSession = session
    const snapshot = await api.snapshot()
    if (snapshotSession !== session) return
    store.saveDeleted = snapshot.save_deleted ?? false
    store.skipRead = snapshot.skip_read ?? false
    store.chatPrivacy = snapshot.chat_privacy ?? chatPrivacyDefaults(store.skipRead)
    store.notifications = snapshot.notifications ?? { ...defaultNotifications }
    if (before.auth === revisions.auth) applyAuth(snapshot.auth)
    if (before.chats === revisions.chats) applyChats(snapshot.chats)
    if (before.connection === revisions.connection) store.connection = snapshot.connection
    if (before.folders === revisions.folders && snapshot.folders?.length) store.folders = snapshot.folders
  } catch (error) {
    store.startupError = String(error)
    store.stage = "error"
    store.chatsReady = false
  }
}

export function applyAppLockStatus(status: AppLockStatus) {
  if (store.appLock && status.revision < store.appLock.revision) return false
  if (store.appLock && status.revision === store.appLock.revision
    && status.locked === store.appLock.locked && status.configured === store.appLock.configured
    && status.kind === store.appLock.kind && status.remaining_attempts === store.appLock.remaining_attempts
    && status.logout_pending === store.appLock.logout_pending && status.logged_out === store.appLock.logged_out
    && status.session_suspended === store.appLock.session_suspended) return false
  const wasSuspended = store.appLock?.session_suspended
  if (status.logout_pending || status.logged_out) {
    clearSession()
    store.stage = "logged_out"
  }
  store.appLock = status
  if (status.session_suspended && !status.logout_pending) {
    store.stage = "wait_phone"
    store.qrLoginLink = null
    store.cached = false
    store.chatsReady = false
    stopVoice()
    store.playingVoice = null
    store.music = null
    closeMediaViewer()
    closeMessageOverlays()
    closeProfile()
  } else if (wasSuspended && !status.locked && !status.logged_out && !status.logout_pending && initialized) {
    const currentSession = session
    void api.snapshot().then((snapshot) => {
      if (currentSession !== session || store.appLock?.session_suspended || store.appLock?.locked) return
      applyAuth(snapshot.auth)
      store.selectedFolder = snapshot.chats.folder_id ?? 0
      applyChats(snapshot.chats)
      store.connection = snapshot.connection
      store.saveDeleted = snapshot.save_deleted ?? false
      store.skipRead = snapshot.skip_read ?? false
      store.chatPrivacy = snapshot.chat_privacy ?? chatPrivacyDefaults(store.skipRead)
      store.notifications = snapshot.notifications ?? { ...defaultNotifications }
      if (snapshot.folders?.length) store.folders = snapshot.folders
    }).catch((error) => { if (currentSession === session) store.startupError = String(error) })
  }
  return true
}

export function updateChatActivity(payload: ChatActivityData) {
  if (store.stage !== "ready" || store.appLock?.locked || !receivesChatUpdates(payload.chat_id) || payload.sender.kind === "user" && payload.sender.id === store.user?.id) return
  const key = `${payload.chat_id}:${payload.sender.kind}:${payload.sender.id}`
  clearTimeout(activityTimers.get(key))
  activityTimers.delete(key)
  const remove = () => {
    const items = (store.chatActivity.get(payload.chat_id) ?? []).filter((item) => item.sender.kind !== payload.sender.kind || item.sender.id !== payload.sender.id)
    if (items.length) store.chatActivity.set(payload.chat_id, items)
    else store.chatActivity.delete(payload.chat_id)
    activityTimers.delete(key)
  }
  if (payload.action === "cancel") {
    remove()
    return
  }
  const items = (store.chatActivity.get(payload.chat_id) ?? []).filter((item) => item.sender.kind !== payload.sender.kind || item.sender.id !== payload.sender.id)
  store.chatActivity.set(payload.chat_id, [...items, payload])
  activityTimers.set(key, setTimeout(remove, 6000))
}

export function setPrivacyMode(enabled: boolean) {
  store.privacyMode = enabled
  try {
    localStorage.setItem("parugram:privacy", String(enabled))
  } catch {
    return
  }
}

export function setRecentStickerLimit(limit: number) {
  if (![25, 50, 75, 100].includes(limit)) return
  store.recentStickerLimit = limit
  try { localStorage.setItem("parugram:recent-sticker-limit", String(limit)) }
  catch { return }
}

export function setScrollOnReply(enabled: boolean) {
  store.scrollOnReply = enabled
  try { localStorage.setItem(scrollOnReplyKey, String(enabled)) }
  catch {}
}

export function visibleRecentStickers() {
  return (store.stickerCatalog?.recent ?? []).slice(0, store.recentStickerLimit)
}

export function invalidateStickers(kind: "recent" | "sets") {
  if (!acceptsMessages()) return
  store.stickersRevision += 1
  if (kind === "sets") {
    stickerSetsRevision += 1
    store.stickerPacks.clear()
  }
}

export async function loadStickerCatalog(): Promise<void> {
  if (!store.chatsReady) return
  if (stickerCatalogRequest) {
    await stickerCatalogRequest
    if (stickerCatalogRevision !== store.stickersRevision) return loadStickerCatalog()
    return
  }
  if (store.stickerCatalog && stickerCatalogRevision === store.stickersRevision) return
  const currentSession = session
  const revision = store.stickersRevision
  const request = api.stickerCatalog().then((catalog) => {
    if (currentSession === session && revision === store.stickersRevision) {
      store.stickerCatalog = catalog
      stickerCatalogRevision = revision
    }
  }).finally(() => { if (currentSession === session) stickerCatalogRequest = undefined })
  stickerCatalogRequest = request
  await request
  if (currentSession === session && revision !== store.stickersRevision) return loadStickerCatalog()
}

export async function loadStickerPack(id: string): Promise<void> {
  if (!store.chatsReady || store.stickerPacks.has(id)) return
  const pending = stickerPackRequests.get(id)
  if (pending) return pending
  const currentSession = session
  const revision = stickerSetsRevision
  const request = api.stickerPack(id).then((stickers) => {
    if (currentSession === session && revision === stickerSetsRevision) store.stickerPacks.set(id, stickers)
  }).finally(() => { if (currentSession === session) stickerPackRequests.delete(id) })
  stickerPackRequests.set(id, request)
  await request
  if (currentSession === session && revision !== stickerSetsRevision) return loadStickerPack(id)
}

export async function sendSticker(chatId: number, sticker: StickerData): Promise<boolean> {
  if (!store.chatsReady || store.sendingChats.get(chatId) || draftFor(chatId).editing) return false
  const currentSession = session
  const reply = draftFor(chatId).reply
  const target = conversationTarget(chatId)
  store.sendingChats.set(chatId, true)
  store.composeErrors.delete(chatId)
  try {
    const message = target.threadId ? await api.sendSticker(target.chatId, sticker, reply?.id ?? null, target.threadId) : await api.sendSticker(target.chatId, sticker, reply?.id ?? null)
    if (currentSession !== session) return false
    await scrollAfterSend(chatId, !!reply)
    if (currentSession !== session) return false
    appendMessage(message)
    if (reply && draftFor(chatId).reply?.id === reply.id) updateDraft(chatId, { reply: null })
    if (store.stickerCatalog) store.stickerCatalog = { ...store.stickerCatalog, recent: [sticker, ...store.stickerCatalog.recent.filter((item) => item.file_id !== sticker.file_id)].slice(0, 200) }
    return true
  } catch (error) {
    if (currentSession === session) store.composeErrors.set(chatId, String(error))
    return false
  } finally {
    if (currentSession === session) store.sendingChats.set(chatId, false)
  }
}

export function mediaItem(message: MsgData): MediaItem | null {
  const content = message.content
  if (content.kind === "Photo" || content.kind === "Video") return {
    key: messageKey(message.chat_id, message.id), kind: content.kind === "Photo" ? "photo" : "video",
    file_id: content.data.file_id, caption: content.data.caption, entities: content.data.entities,
    file_name: content.kind === "Video" ? content.data.file_name : "Фото",
  }
  if (content.kind === "Animation") return {
    key: messageKey(message.chat_id, message.id), kind: content.data.mime_type === "image/gif" ? "photo" : "video",
    file_id: content.data.file_id, caption: content.data.caption, entities: content.data.entities, file_name: content.data.file_name || "GIF",
  }
  if (content.kind !== "File") return null
  const name = content.data.file_name.toLowerCase()
  const kind = /\.(png|jpe?g|webp|gif|bmp|avif)$/.test(name) ? "photo"
    : /\.(mp4|m4v|mov|webm|mkv|avi)$/.test(name) ? "video" : null
  return kind ? { key: messageKey(message.chat_id, message.id), kind, file_id: content.data.file_id, caption: content.data.caption, entities: content.data.entities, file_name: content.data.file_name } : null
}

export function canDownloadMessage(message: MsgData) {
  return !message.is_deleted && message.sending_state === "sent" && "file_id" in message.content.data && message.content.data.file_id > 0
}

export async function downloadMessage(message: MsgData) {
  const content = message.content.data
  if (!canDownloadMessage(message) || !store.chatsReady || !("file_id" in content) || activeDownloads.has(content.file_id)) return
  const key = messageKey(message.chat_id, message.id)
  const stage = store.downloads.get(key)?.stage
  if (stage === "downloading" || stage === "saving") return
  const fileId = content.file_id
  activeDownloads.add(fileId)
  clearTimeout(downloadTimers.get(key))
  downloadTimers.delete(key)
  const currentSession = session
  let fileName = "file_name" in content && content.file_name ? content.file_name : message.content.kind === "Photo" ? "Фото" : "Файл"
  store.downloads.set(key, { fileName, stage: "downloading" })
  try {
    const saved = await api.saveMessageFile(message.chat_id, message.id, (update) => {
      if (currentSession !== session || !activeDownloads.has(fileId)) return
      fileName = update.file_name
      const progress = update.stage === "downloading" && update.size > 0 ? Math.min(100, Math.floor(update.downloaded * 100 / update.size)) : undefined
      store.downloads.set(key, { fileName, stage: update.stage, progress })
    })
    if (currentSession !== session) return
    store.downloads.set(key, { fileName: saved.file_name, stage: "done", path: saved.path })
  } catch (error) {
    if (currentSession !== session) return
    store.downloads.set(key, { fileName, stage: "error", error: String(error) })
  } finally {
    if (currentSession === session) activeDownloads.delete(fileId)
  }
  downloadTimers.set(key, setTimeout(() => {
    store.downloads.delete(key)
    downloadTimers.delete(key)
  }, 5000))
}

export function openMediaItems(items: MediaItem[], index = 0) {
  if (!items.length || store.stage !== "ready" || store.appLock?.locked) return
  const selectedIndex = Math.max(0, Math.min(index, items.length - 1))
  const selected = items[selectedIndex]
  closeMessageOverlays()
  if (store.voice?.playing) store.voice.playing = false
  store.playingVoice = null
  if (store.music && selected?.kind === "video") store.music.playing = false
  if (store.mediaTransfer?.fileId !== selected?.file_id) store.mediaTransfer = null
  store.mediaViewer = { items, index: selectedIndex }
}

export function openMediaViewer(message: MsgData, collection?: MsgData[]) {
  const selected = mediaItem(message)
  if (!selected) return
  const items = (collection ?? store.messages.get(message.chat_id) ?? []).map(mediaItem).filter((item): item is MediaItem => item !== null)
  const index = items.findIndex((item) => item.key === selected.key)
  openMediaItems(index < 0 ? [selected] : items, index < 0 ? 0 : index)
}

export function closeMediaViewer() {
  store.mediaViewer = null
  store.mediaTransfer = null
}

function normalizeMessage(message: MsgData): MsgData | null {
  const replacement = replacements.get(messageKey(message.chat_id, message.id))
  const resolved = replacement ?? message
  const key = messageKey(resolved.chat_id, resolved.id)
  const saved = savedDeleted.get(key)
  if (saved) return saved
  if (resolved.is_deleted) { savedDeleted.set(key, resolved); return resolved }
  if (deleted.has(key)) return null
  const content = contentUpdates.get(key)
  const reactions = reactionUpdates.get(key)
  return { ...resolved, ...(content ? { content } : {}), ...(reactions ? { reactions } : {}) }
}

function mergeMessages(messages: MsgData[]): MsgData[] {
  const merged = new Map<number, MsgData>()
  for (const message of messages) {
    const resolved = normalizeMessage(message)
    if (!resolved) continue
    const previous = merged.get(resolved.id)
    if (previous && previous.sending_state !== "pending" && resolved.sending_state === "pending") continue
    merged.set(resolved.id, resolved)
  }
  return [...merged.values()].sort((a, b) => a.date - b.date || a.id - b.id)
}

export function appendMessage(message: MsgData) {
  if (!acceptsMessages() || !receivesChatUpdates(message.chat_id)) return
  const resolved = normalizeMessage(message)
  if (!resolved) return
  updateChatActivity({ chat_id: resolved.chat_id, sender: resolved.sender, action: "cancel" })
  const key = messageKey(resolved.chat_id, resolved.id)
  const fresh = !liveMessages.has(key)
  liveMessages.add(key)
  if (liveMessages.size > 5000) liveMessages.delete(liveMessages.values().next().value!)
  for (const viewKey of messageViewKeys(resolved)) {
    const list = store.messages.get(viewKey) ?? []
    if (fresh && !resolved.is_outgoing && store.atBottom.get(viewKey) === false && !list.some((item) => item.id === resolved.id)) store.newMessageCounts.set(viewKey, (store.newMessageCounts.get(viewKey) ?? 0) + 1)
    if (store.historyAtLatest.get(viewKey) !== false || list.some((item) => item.id === resolved.id)) store.messages.set(viewKey, mergeMessages([...list, resolved]))
    if (!isConversationVisible(viewKey) && !store.atBottom.has(viewKey)) {
      if (!store.historyLoaded.get(viewKey)) trimHistory(viewKey)
      if (!historyReleaseTimers.has(viewKey)) releaseHistory(viewKey)
    }
  }
  const chat = store.chats.find((c) => c.id === resolved.chat_id)
  if (chat && (!chat.last_message || chat.last_message.id === message.id
    || resolved.date > chat.last_message.date
    || (resolved.date === chat.last_message.date && resolved.id >= chat.last_message.id))) {
    chat.last_message = resolved
    scheduleCache()
  }
}

export function replaceMessage(payload: MessageReplacement) {
  if (!acceptsMessages() || !receivesChatUpdates(payload.message.chat_id)) return
  const { message, old_message_id: oldId } = payload
  const list = store.messages.get(message.chat_id) ?? []
  const key = messageKey(message.chat_id, message.id)
  const oldKey = messageKey(message.chat_id, oldId)
  const stableKey = messageKeys.get(key) ?? (list.some((item) => item.id === message.id) ? key : messageKeys.get(oldKey) ?? oldKey)
  messageKeys.set(key, stableKey)
  messageKeys.set(oldKey, stableKey)
  if (store.focusedMessage?.message.chat_id === message.chat_id && store.focusedMessage.message.id === oldId) {
    store.focusedMessage = { ...store.focusedMessage, message }
  }
  if (store.contextMenu && store.contextMenu.kind !== "chat" && store.contextMenu.message.chat_id === message.chat_id && store.contextMenu.message.id === oldId) {
    store.contextMenu = { ...store.contextMenu, message }
  }
  replacements.set(messageKey(message.chat_id, oldId), message)
  store.messages.set(message.chat_id, mergeMessages([...list.filter((m) => m.id !== oldId), message]))
  for (const [viewKey, messages] of store.messages) {
    if (viewKey !== message.chat_id && conversationTarget(viewKey).chatId === message.chat_id && messages.some((item) => item.id === oldId)) store.messages.set(viewKey, mergeMessages([...messages.filter((item) => item.id !== oldId), message]))
  }
  const chat = store.chats.find((c) => c.id === message.chat_id)
  if (chat?.last_message?.id === oldId) chat.last_message = normalizeMessage(message)
  appendMessage(message)
}

export function updateMessageContent(payload: MessageContentPayload) {
  if (!acceptsMessages() || !receivesChatUpdates(payload.chat_id)) return
  const key = messageKey(payload.chat_id, payload.message_id)
  contentUpdates.set(key, payload.content)
  const preview = store.replyPreviews.get(key)
  if (preview && !preview.is_deleted) store.replyPreviews.set(key, { ...preview, content: payload.content })
  refreshMessageViews(payload.chat_id)
  const chat = store.chats.find((c) => c.id === payload.chat_id)
  if (chat?.last_message?.id === payload.message_id) {
    chat.last_message = { ...chat.last_message, content: payload.content }
    scheduleCache()
  }
}

export function deleteMessages(payload: DeletedMessagesPayload) {
  if (!acceptsMessages() || !receivesChatUpdates(payload.chat_id)) return
  if (store.voice?.chatId === payload.chat_id && payload.message_ids.includes(store.voice.messageId)) stopVoice()
  store.pinnedRevisions.set(payload.chat_id, (store.pinnedRevisions.get(payload.chat_id) ?? 0) + 1)
  if (store.music?.track.chatId === payload.chat_id && payload.message_ids.includes(store.music.track.messageId)) stopMusic()
  else if (store.music) store.music.queue = store.music.queue.filter((track) => track.chatId !== payload.chat_id || !payload.message_ids.includes(track.messageId))
  for (const message of payload.saved_messages ?? []) savedDeleted.set(messageKey(message.chat_id, message.id), { ...message, is_deleted: true })
  if (store.saveDeleted) {
    for (const message of store.messages.get(payload.chat_id) ?? []) {
      if (payload.message_ids.includes(message.id)) savedDeleted.set(messageKey(message.chat_id, message.id), { ...message, is_deleted: true })
    }
  }
  for (const id of payload.message_ids) {
    const key = messageKey(payload.chat_id, id)
    deleted.add(key)
    if (store.replyPreviews.has(key)) store.replyPreviews.set(key, savedDeleted.get(key) ?? null)
  }
  const focused = store.focusedMessage?.message
  const context = store.contextMenu
  if (focused?.chat_id === payload.chat_id && payload.message_ids.includes(focused.id)) store.focusedMessage = null
  if (context && context.kind !== "chat" && context.message.chat_id === payload.chat_id && payload.message_ids.includes(context.message.id)) store.contextMenu = null
  const viewer = store.mediaViewer
  if (viewer) {
    const removed = new Set(payload.message_ids.map((id) => messageKey(payload.chat_id, id)))
    const currentKey = viewer.items[viewer.index]?.key
    const items = viewer.items.filter((item) => !removed.has(item.key))
    if (items.length !== viewer.items.length) {
      const selected = items.findIndex((item) => item.key === currentKey)
      const index = selected >= 0 ? selected : Math.min(viewer.index, items.length - 1)
      if (items.length) {
        if (store.mediaTransfer?.fileId !== items[index].file_id) store.mediaTransfer = null
        store.mediaViewer = { items, index }
      } else closeMediaViewer()
    }
  }
  for (const [key, draft] of store.drafts) {
    if (conversationTarget(key).chatId !== payload.chat_id) continue
    if (draft.reply && payload.message_ids.includes(draft.reply.id)) updateDraft(key, { reply: null })
    if (draft.editing && payload.message_ids.includes(draft.editing.id)) cancelEditing(key)
  }
  const list = store.messages.get(payload.chat_id)
  if (list) store.messages.set(payload.chat_id, mergeMessages([...list, ...(payload.saved_messages ?? [])]))
  refreshMessageViews(payload.chat_id)
  const chat = store.chats.find((c) => c.id === payload.chat_id)
  if (chat?.last_message && payload.message_ids.includes(chat.last_message.id)) {
    chat.last_message = null
    scheduleCache()
  }
}

export async function prepareHistory(key: number) {
  if (!store.chatsReady || store.stage !== "ready" || store.appLock?.locked || store.appLock?.session_suspended) return null
  store.readPaused.set(key, true)
  const currentSession = session
  const currentJump = jumpRequest
  const target = conversationTarget(key)
  const conversation = store.conversations.get(key)
  const chat = store.chats.find((item) => item.id === target.chatId) ?? activeChat(key)
  const unreadCount = target.threadId ? conversation?.unreadCount ?? 0 : chat?.unread_count ?? 0
  const readThrough = target.threadId ? conversation?.lastReadInboxMessageId ?? 0 : chat?.last_read_inbox_message_id ?? 0
  counterReadThrough.set(key, Math.max(readThrough, counterReadThrough.get(key) ?? 0))
  if (store.jumpTarget?.chatId === key) return { unreadCount, readThrough, positioned: false }
  if (!unreadCount) {
    const epoch = historyEpoch.get(key) ?? 0
    if (!historyCursor.has(key)) {
      store.historyDone.delete(key)
      if (store.messages.get(key)?.length) store.historyLoaded.delete(key)
    }
    if (!store.historyLoaded.get(key)) await loadHistory(key)
    const positioned = currentSession === session && currentJump === jumpRequest && epoch === (historyEpoch.get(key) ?? 0)
    if (positioned) store.readPaused.delete(key)
    return { unreadCount, readThrough, positioned }
  }
  historyEpoch.set(key, (historyEpoch.get(key) ?? 0) + 1)
  const epoch = historyEpoch.get(key)
  historyRequests.delete(key)
  newerRequests.delete(key)
  historyCursor.delete(key)
  store.historyDone.delete(key)
  store.historyLoading.set(key, false)
  store.historyLoaded.delete(key)
  store.historyAtLatest.set(key, false)
  store.messages.delete(key)
  store.newMessageCounts.set(key, unreadCount)
  await loadHistory(key, false, Math.max(1, readThrough))
  return { unreadCount, readThrough, positioned: currentSession === session && currentJump === jumpRequest && historyEpoch.get(key) === epoch }
}

export function resumeReading(key: number) {
  store.readPaused.delete(key)
}

export async function requestMessages<T>(request: () => Promise<T>, retry = true, active: () => boolean = () => true): Promise<T> {
  const currentSession = session
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  try {
    return await Promise.race([
      request(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error("Не удалось дождаться сообщений"))
        }, 12000)
      }),
    ])
  } catch (error) {
    if (expired && retry && currentSession === session && active() && store.chatsReady && !store.appLock?.locked && !store.appLock?.session_suspended) return requestMessages(request, false, active)
    throw error
  } finally { clearTimeout(timer) }
}

export async function loadHistory(chatId: number, older = false, around?: number): Promise<void> {
  if (!store.chatsReady || store.historyDone.get(chatId)) return
  const pending = historyRequests.get(chatId)
  if (pending) return pending
  const currentSession = session
  const epoch = historyEpoch.get(chatId) ?? 0
  const cursor = older ? historyCursor.get(chatId) ?? 0 : around ?? 0
  const target = conversationTarget(chatId)
  store.historyLoading.set(chatId, true)
  store.historyError.delete(chatId)
  const request = (async () => {
    try {
      let batch = await requestMessages(() => around !== undefined
        ? target.threadId ? api.threadHistory(target.chatId, target.threadId, cursor, "around") : api.messageContext(target.chatId, cursor, false)
        : target.threadId ? api.threadHistory(target.chatId, target.threadId, cursor) : api.getHistory(target.chatId, cursor, 50), true, () => epoch === (historyEpoch.get(chatId) ?? 0))
      if (currentSession !== session || epoch !== (historyEpoch.get(chatId) ?? 0)) return
      const hasHistory = (store.messages.get(chatId)?.length ?? 0) > 0 || (target.threadId ? (store.conversations.get(chatId)?.replyCount ?? 0) > 0 : !!activeChat(chatId)?.last_message)
      if (!batch.length && (around !== undefined || !cursor)) {
        batch = await requestMessages(() => target.threadId ? api.threadHistory(target.chatId, target.threadId, 0) : api.getHistory(target.chatId, 0, 50), true, () => epoch === (historyEpoch.get(chatId) ?? 0))
        if (currentSession !== session || epoch !== (historyEpoch.get(chatId) ?? 0)) return
        if (!batch.length && (around !== undefined || hasHistory)) throw new Error("Не удалось загрузить историю")
      }
      const archived = !older && api.savedDeleted ? (await requestMessages(() => api.savedDeleted(target.chatId), true, () => epoch === (historyEpoch.get(chatId) ?? 0))).filter((message) => !target.threadId || message.thread_id === target.threadId) : []
      if (currentSession !== session || epoch !== (historyEpoch.get(chatId) ?? 0)) return
      for (const message of archived) savedDeleted.set(messageKey(target.chatId, message.id), message)
      const olderMessages = cursor && around === undefined ? batch.filter((m) => m.id < cursor) : batch
      const oldest = olderMessages.length ? Math.min(...olderMessages.map((message) => message.id)) : 0
      const retained = [...savedDeleted.values()].filter((message) => message.chat_id === target.chatId && (!target.threadId || message.thread_id === target.threadId) && message.id >= oldest && (around !== undefined ? message.id <= Math.max(0, ...batch.map((item) => item.id)) : !cursor || message.id < cursor))
      store.messages.set(chatId, mergeMessages([...olderMessages, ...retained, ...(store.messages.get(chatId) ?? [])]))
      store.historyLoaded.set(chatId, true)
      if (olderMessages.length === 0) {
        if (cursor > 0 && around === undefined) store.historyDone.set(chatId, true)
      } else historyCursor.set(chatId, Math.min(...olderMessages.map((m) => m.id)))
    } catch (error) {
      if (currentSession === session && epoch === (historyEpoch.get(chatId) ?? 0)) store.historyError.set(chatId, String(error))
      throw error
    } finally {
      if (currentSession === session && epoch === (historyEpoch.get(chatId) ?? 0)) {
        store.historyLoading.set(chatId, false)
        historyRequests.delete(chatId)
      }
    }
  })()
  historyRequests.set(chatId, request)
  return request
}

export async function loadMoreChats(): Promise<void> {
  if (store.loadingChats || store.stage !== "ready" || !store.hasMoreChats) return
  const currentSession = session
  const currentFolder = store.selectedFolder
  store.loadingChats = true
  if (store.chatsReady) store.chatLimit += 50
  store.chatsError = ""
  try {
    const hasMore = await api.loadMoreChats()
    if (currentSession === session && currentFolder === store.selectedFolder) store.hasMoreChats = hasMore
  } catch (error) {
    if (currentSession === session && currentFolder === store.selectedFolder) store.chatsError = String(error)
  } finally {
    if (currentSession === session && currentFolder === store.selectedFolder) store.loadingChats = false
  }
}

export async function setSaveDeleted(enabled: boolean) {
  const currentSession = session
  const value = await api.setSaveDeleted(enabled, [...store.messages.values()].flat())
  if (currentSession === session) store.saveDeleted = value
}

export async function setSkipRead(enabled: boolean) {
  const currentSession = session
  const value = await api.setSkipRead(enabled)
  if (currentSession === session) store.skipRead = value
}

export async function setChatPrivacy(key: keyof ChatPrivacy, enabled: boolean) {
  const currentSession = session
  const preferences = await api.setChatPrivacy({ ...store.chatPrivacy, [key]: enabled })
  if (currentSession === session) store.chatPrivacy = preferences
}

export async function setNotificationPreference(key: keyof NotificationPreferences, enabled: boolean) {
  const currentSession = session
  const preferences = await api.setNotifications({ ...store.notifications, [key]: enabled })
  if (currentSession === session) store.notifications = preferences
}

export async function markMessagesRead(chatId: number, ids: number[]) {
  if (store.skipRead || store.readPaused.get(chatId) || !store.chatsReady || store.appLock?.locked || store.appLock?.session_suspended) return false
  const currentSession = session
  const marked = await api.viewMessages(conversationTarget(chatId).chatId, ids) !== false
  if (marked && currentSession === session) updateUnreadCounter(chatId, ids, true)
  return marked
}

export function updateUnreadCounter(chatId: number, ids: number[], marked = false) {
  const view = store.conversations.get(chatId)
  const readThrough = counterReadThrough.get(chatId) ?? view?.lastReadInboxMessageId ?? 0
  const newest = Math.max(readThrough, ...ids)
  const messages = store.messages.get(chatId) ?? []
  if (newest > readThrough) {
    const count = messages.filter((message) => !message.is_outgoing && !message.is_deleted && message.id > readThrough && message.id <= newest).length
    counterReadThrough.set(chatId, newest)
    const remaining = Math.max(0, (store.newMessageCounts.get(chatId) ?? 0) - count)
    if (remaining) store.newMessageCounts.set(chatId, remaining)
    else store.newMessageCounts.delete(chatId)
  }
  if (marked && view?.threadId) {
    const threadReadThrough = view.lastReadInboxMessageId ?? 0
    const threadNewest = Math.max(threadReadThrough, ...ids)
    const threadCount = messages.filter((message) => !message.is_outgoing && !message.is_deleted && message.id > threadReadThrough && message.id <= threadNewest).length
    store.conversations.set(chatId, { ...view, lastReadInboxMessageId: threadNewest, unreadCount: Math.max(0, (view.unreadCount ?? 0) - threadCount) })
  }
}

export function replyPreview(chatId: number, messageId: number) {
  return store.messages.get(chatId)?.find((message) => message.id === messageId)
    ?? savedDeleted.get(messageKey(chatId, messageId)) ?? store.replyPreviews.get(messageKey(chatId, messageId))
}

export async function loadReplyPreview(chatId: number, messageId: number): Promise<void> {
  const key = messageKey(chatId, messageId)
  if (replyPreview(chatId, messageId) || store.replyPreviews.has(key) || !store.chatsReady) return
  const pending = replyRequests.get(key)
  if (pending) return pending
  const currentSession = session
  const request = api.getMessage(chatId, messageId).then((message) => {
    if (currentSession === session) store.replyPreviews.set(key, normalizeMessage(message))
  }).catch(() => {
    if (currentSession === session) store.replyPreviews.set(key, null)
  }).finally(() => { if (currentSession === session) replyRequests.delete(key) })
  replyRequests.set(key, request)
  return request
}

export async function jumpToMessage(chatId: number, messageId: number, preferredKey?: number) {
  if (!store.chatsReady || messageId <= 0) return
  const viewKey = preferredKey !== undefined && conversationTarget(preferredKey).chatId === chatId ? preferredKey : chatId
  const target = conversationTarget(viewKey)
  const request = ++jumpRequest
  const currentSession = session
  const chat = activeChat(viewKey) ?? (await api.getProfile({ kind: "chat", id: chatId })).chat
  if (!chat || currentSession !== session || request !== jumpRequest) return
  if (!store.messages.get(viewKey)?.some((message) => message.id === messageId)) {
    const batch = await requestMessages(() => target.threadId ? api.threadHistory(chatId, target.threadId, messageId, "around") : api.messageContext(chatId, messageId), true, () => request === jumpRequest)
    if (currentSession !== session || request !== jumpRequest) return
    if (!batch.some((message) => message.id === messageId)) throw new Error("Сообщение недоступно")
    historyEpoch.set(viewKey, (historyEpoch.get(viewKey) ?? 0) + 1)
    historyRequests.delete(viewKey)
    newerRequests.delete(viewKey)
    store.historyLoading.set(viewKey, false)
    store.historyError.delete(viewKey)
    store.messages.set(viewKey, mergeMessages(batch))
    historyCursor.set(viewKey, Math.min(...batch.map((message) => message.id)))
    store.historyDone.set(viewKey, false)
    store.historyLoaded.set(viewKey, true)
    store.historyAtLatest.set(viewKey, false)
  }
  if (!isConversationVisible(viewKey)) openConversation(chat, false)
  closeMessageOverlays()
  store.jumpTarget = { chatId: viewKey, messageId, token: request }
}

export async function loadNewerHistory(chatId: number): Promise<void> {
  if (!store.chatsReady || store.historyAtLatest.get(chatId) !== false) return
  const pending = newerRequests.get(chatId)
  if (pending) return pending
  const list = store.messages.get(chatId) ?? []
  const cursor = Math.max(0, ...list.filter((message) => !message.is_deleted).map((message) => message.id))
  const currentSession = session
  const epoch = historyEpoch.get(chatId) ?? 0
  const target = conversationTarget(chatId)
  store.historyError.delete(chatId)
  const request = (async () => {
    try {
      const batch = (await requestMessages(() => target.threadId ? api.threadHistory(target.chatId, target.threadId, cursor, "newer") : api.newerMessages(target.chatId, cursor), true, () => epoch === (historyEpoch.get(chatId) ?? 0))).filter((message) => message.id > cursor)
      if (currentSession !== session || epoch !== (historyEpoch.get(chatId) ?? 0)) return
      store.messages.set(chatId, mergeMessages([...(store.messages.get(chatId) ?? []), ...batch]))
      if (!batch.length) store.historyAtLatest.set(chatId, true)
    } catch (error) {
      if (currentSession === session && epoch === (historyEpoch.get(chatId) ?? 0)) store.historyError.set(chatId, String(error))
    } finally {
      if (currentSession === session && epoch === (historyEpoch.get(chatId) ?? 0)) newerRequests.delete(chatId)
    }
  })()
  newerRequests.set(chatId, request)
  return request
}

export async function returnToLatest(chatId: number) {
  const token = ++jumpRequest
  if (store.historyAtLatest.get(chatId) !== false && store.historyLoaded.get(chatId)) {
    store.newMessageCounts.delete(chatId)
    store.jumpTarget = { chatId, messageId: 0, token }
    return
  }
  historyEpoch.set(chatId, (historyEpoch.get(chatId) ?? 0) + 1)
  historyRequests.delete(chatId)
  newerRequests.delete(chatId)
  historyCursor.delete(chatId)
  store.historyDone.delete(chatId)
  store.historyAtLatest.set(chatId, true)
  store.historyLoading.set(chatId, false)
  store.messages.delete(chatId)
  store.historyLoaded.delete(chatId)
  await loadHistory(chatId)
  if (token !== jumpRequest) return
  store.newMessageCounts.delete(chatId)
  store.jumpTarget = { chatId, messageId: 0, token }
}

function scrollAfterSend(chatId: number, isReply: boolean) {
  const olderHistory = store.historyAtLatest.get(chatId) === false
  if (isReply ? store.scrollOnReply && isConversationVisible(chatId) && (olderHistory || store.atBottom.get(chatId) === false) : olderHistory) {
    return returnToLatest(chatId).catch(() => {})
  }
}

export function updateMessageReactions(payload: MessageReactionsPayload) {
  if (!acceptsMessages() || !receivesChatUpdates(payload.chat_id)) return
  const key = messageKey(payload.chat_id, payload.message_id)
  reactionRevisions.set(key, (reactionRevisions.get(key) ?? 0) + 1)
  reactionUpdates.set(key, payload.reactions)
  refreshMessageViews(payload.chat_id)
  if (payload.comment_count !== undefined) for (const [key, list] of store.messages) if (conversationTarget(key).chatId === payload.chat_id) store.messages.set(key, list.map((message) => message.id === payload.message_id && message.is_channel_post ? { ...message, comment_count: payload.comment_count } : message))
  const preview = store.replyPreviews.get(key)
  if (preview && !preview.is_deleted) store.replyPreviews.set(key, { ...preview, reactions: payload.reactions })
  const chat = store.chats.find((item) => item.id === payload.chat_id)
  if (chat?.last_message?.id === payload.message_id && !chat.last_message.is_deleted) chat.last_message = { ...chat.last_message, reactions: payload.reactions }
}

export async function toggleReaction(message: MsgData, reaction: ReactionData) {
  if (!store.chatsReady || message.is_deleted || reaction.key === "paid") return
  const key = messageKey(message.chat_id, message.id)
  if (store.reactionBusy.get(key)) return
  const current = store.messages.get(message.chat_id)?.find((item) => item.id === message.id) ?? message
  const previous = current.reactions ?? []
  const existing = previous.find((item) => item.key === reaction.key)
  const add = !existing?.chosen
  const next = previous.filter((item) => item.key !== reaction.key)
  const count = (existing?.count ?? 0) + (add ? 1 : -1)
  if (count > 0) {
    const recentSenders = add ? [...(existing?.recent_senders ?? [])] : []
    if (add && message.chat_id > 0 && store.user && !recentSenders.some((sender) => sender.kind === "user" && sender.id === store.user?.id)) {
      const { id, photo, photo_file_id, first_name, last_name } = store.user
      recentSenders.unshift({ kind: "user", id, name: `${first_name} ${last_name}`.trim(), photo, photo_file_id })
    }
    next.push({ ...(existing ?? reaction), count, chosen: add, recent_senders: count <= 3 ? recentSenders : [] })
  }
  const currentSession = session
  updateMessageReactions({ chat_id: message.chat_id, message_id: message.id, reactions: next })
  const revision = reactionRevisions.get(key)
  store.reactionBusy.set(key, true)
  try {
    await api.setReaction(message.chat_id, message.id, reaction.key, add)
  } catch (error) {
    if (currentSession === session && revision === reactionRevisions.get(key)) updateMessageReactions({ chat_id: message.chat_id, message_id: message.id, reactions: previous })
    throw error
  } finally {
    if (currentSession === session) store.reactionBusy.delete(key)
  }
}

export async function loadReactionSticker(id: string): Promise<void> {
  if (store.reactionStickers.has(id) || !store.chatsReady) return
  const pending = reactionStickerRequests.get(id)
  if (pending) return pending
  const currentSession = session
  const request = api.reactionSticker(id).then((sticker) => {
    if (currentSession === session) store.reactionStickers.set(id, sticker)
  }).catch(() => {
    if (currentSession === session) store.reactionStickers.set(id, { file_id: null, emoji: "◇" })
  }).finally(() => { if (currentSession === session) reactionStickerRequests.delete(id) })
  reactionStickerRequests.set(id, request)
  return request
}

export function messageSender(message: MsgData): SenderData {
  return senderDetails(message.sender)
}

export function recentReactionSenders(message: MsgData, reaction: ReactionData): SenderData[] {
  if (reaction.recent_senders?.length) return reaction.recent_senders
  const accountId = store.user?.id
  if (reaction.key === "paid" || reaction.count !== 1 || !accountId || message.chat_id <= 0) return []
  if (!reaction.chosen && message.chat_id === accountId) return []
  const id = reaction.chosen ? accountId : message.chat_id
  if (message.sender.kind === "user" && message.sender.id === id) return [message.sender]
  return [{ kind: "user", id, name: "", photo: null, photo_file_id: null }]
}

export function senderDetails(sender: SenderData): SenderData {
  if (sender.kind === "user") {
    const user = store.users.get(sender.id) ?? (store.user?.id === sender.id ? store.user : null)
    if (user) return {
      ...sender,
      name: `${user.first_name} ${user.last_name}`.trim() || user.username || sender.name,
      first_name: user.first_name,
      photo: user.photo,
      photo_file_id: user.photo_file_id,
    }
    const chat = activeChat(sender.id)
    if (!sender.name && chat) return { ...sender, name: chat.title, photo: chat.photo, photo_file_id: chat.photo_file_id }
  } else {
    const chat = store.chats.find((item) => item.id === sender.id)
    if (chat) return {
      ...sender,
      name: sender.name || chat.title,
      photo: chat.photo,
      photo_file_id: chat.photo_file_id,
    }
  }
  return sender
}

export async function loadAvatar(fileId: number): Promise<string | null> {
  const cached = store.files.get(fileId)
  if (cached) return cached
  const pending = avatarRequests.get(fileId)
  if (pending) return pending
  const currentSession = session
  const request = api.downloadFile(fileId).then((file) => {
    if (currentSession !== session) return null
    if (file.local_path) {
      store.files.set(fileId, file.local_path)
      scheduleCache()
    }
    return file.local_path
  }).finally(() => {
    if (currentSession === session) avatarRequests.delete(fileId)
  })
  avatarRequests.set(fileId, request)
  return request
}

export function activeChat(key: number | null = store.activeChatId): ChatSummary | null {
  if (store.stage !== "ready") return null
  return key !== null ? store.conversations.get(key)?.chat ?? store.chats.find((c) => c.id === key)
    ?? (store.openedChat?.id === key ? store.openedChat : null) : null
}

export function setEffects(effects: "full" | "reduced") {
  store.effects = effects
  try {
    localStorage.setItem("parugram:effects", effects)
  } catch {
    return
  }
}

export async function selectFolder(id: number) {
  if (id === store.selectedFolder || store.stage !== "ready") return
  const request = ++folderRequest
  closeMessageOverlays()
  const currentSession = session
  const currentChat = activeChat()
  if (currentChat) store.openedChat = currentChat
  store.selectedFolder = id
  store.chatLimit = 50
  store.chatsReady = false
  store.cached = false
  store.hasMoreChats = true
  store.chatsError = ""
  store.loadingChats = true
  try {
    const hasMore = await api.selectFolder(id)
    if (currentSession === session && request === folderRequest) store.hasMoreChats = hasMore
  } catch (error) {
    if (currentSession === session && request === folderRequest) store.chatsError = String(error)
  } finally {
    if (currentSession === session && request === folderRequest) store.loadingChats = false
  }
}

export async function openProfile(target: ProfileTarget) {
  if (!store.chatsReady) return
  closeMessageOverlays()
  const request = ++profileRequest
  const currentSession = session
  store.profileTarget = target
  store.profile = null
  store.profileError = ""
  store.profileLoading = true
  try {
    const profile = await api.getProfile(target)
    if (request === profileRequest && currentSession === session) store.profile = profile
  } catch (error) {
    if (request === profileRequest && currentSession === session) store.profileError = String(error)
  } finally {
    if (request === profileRequest && currentSession === session) store.profileLoading = false
  }
}

export function closeProfile() {
  profileRequest += 1
  store.profileTarget = null
  store.profile = null
  store.profileLoading = false
  store.profileError = ""
}

export function openConversation(chat: ChatSummary, invalidateJump = true) {
  if (!store.chatsReady) return
  if (store.activeChatId !== chat.id) {
    if (store.chatWindowId === null || store.activeChatId !== null) {
      store.chatBackStack.push(activeChat())
      if (store.chatBackStack.length > 100) store.chatBackStack.shift()
    }
    if (invalidateJump) {
      jumpRequest += 1
      store.jumpTarget = null
    }
  }
  closeMessageOverlays()
  store.openedChat = chat
  store.activeChatId = chat.id
  store.showChatList = false
  store.focusedConversation = chat.id
  if (store.rightPanel?.kind === "chat" && store.rightPanel.key === chat.id) closeRightPanel()
  closeProfile()
}

export function goBackChat() {
  if (compactView() && store.activeChatId !== null && !store.showChatList) {
    if (visibleRightPanel()) {
      closeRightPanel()
      return
    }
    jumpRequest += 1
    store.jumpTarget = null
    store.showChatList = true
    store.chatBackStack = []
    store.focusedConversation = null
    closeProfile()
    closeMessageOverlays()
    return
  }
  if (!store.chatsReady || !store.chatBackStack.length) return
  const previous = store.chatBackStack.pop()
  jumpRequest += 1
  store.jumpTarget = null
  closeProfile()
  closeMessageOverlays()
  store.activeChatId = previous?.id ?? null
  store.openedChat = previous ?? null
  store.focusedConversation = store.activeChatId
  if (store.rightPanel?.kind === "chat" && store.rightPanel.key === store.activeChatId) closeRightPanel()
}

export async function openPrivateChat(userId: number) {
  const currentSession = session
  const chat = await api.privateChat(userId)
  if (currentSession === session) openConversation(chat)
}

const draftsStorageKey = "parugram:drafts"

function draftStorageId(key: number) {
  const { chatId, threadId } = conversationTarget(key)
  return threadId ? `${chatId}:${threadId}` : String(chatId)
}

function storedDrafts(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(draftsStorageKey) ?? "{}")
    if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved
  } catch {}
  return {}
}

function syncWindowPreferences(event: StorageEvent) {
  if (event.key === customizationKey) restoreCustomization()
  if (event.key === "parugram:effects") store.effects = event.newValue === "reduced" ? "reduced" : "full"
  if (event.key === scrollOnReplyKey) store.scrollOnReply = event.newValue === "true"
  if (event.key !== draftsStorageKey || !store.drafts.size) return
  const saved = storedDrafts()
  for (const [key, draft] of store.drafts) {
    if (draft.editing) continue
    const value = saved[draftStorageId(key)]
    const text = typeof value === "string" ? value : ""
    if (text !== draft.text) store.drafts.set(key, { ...draft, text, entities: undefined })
  }
}

export function draftFor(chatId: number): ComposeDraft {
  const draft = store.drafts.get(chatId)
  if (draft) return draft
  const text = storedDrafts()[draftStorageId(chatId)]
  return { text: typeof text === "string" ? text : "", attachment: null, videoInfo: null, reply: null, editing: null }
}

export function updateDraft(chatId: number, patch: Partial<ComposeDraft>) {
  const draft = draftFor(chatId)
  if (patch.text !== undefined && patch.entities === undefined && draft.entities?.length && patch.text !== draft.text) {
    const next = patch.text
    let prefix = 0
    while (prefix < draft.text.length && prefix < next.length && draft.text[prefix] === next[prefix]) prefix += 1
    let end = draft.text.length
    let nextEnd = next.length
    while (end > prefix && nextEnd > prefix && draft.text[end - 1] === next[nextEnd - 1]) {
      end -= 1
      nextEnd -= 1
    }
    patch = { ...patch, entities: draft.entities.filter((entity) => entity.offset + entity.length <= prefix || entity.offset >= end)
      .map((entity) => entity.offset >= end ? { ...entity, offset: entity.offset + nextEnd - end } : entity) }
  }
  const next = { ...draft, ...patch }
  store.drafts.set(chatId, next)
  store.composeErrors.delete(chatId)
  if (next.editing || (next.text === draft.text && !draft.editing)) return
  try {
    const saved = storedDrafts()
    const id = draftStorageId(chatId)
    if (next.text) saved[id] = next.text
    else delete saved[id]
    localStorage.setItem(draftsStorageKey, JSON.stringify(saved))
  } catch {}
}

export function insertMention(chatId: number, start: number, end: number, user: UserPayload) {
  const draft = draftFor(chatId)
  if (start < 0 || end < start || end > draft.text.length) return null
  const name = user.username ? `@${user.username}` : `${user.first_name} ${user.last_name}`.trim().replace(/\s+/g, " ") || "Участник"
  const suffix = draft.text.slice(end)
  const space = /^\s/.test(suffix) ? "" : " "
  updateDraft(chatId, { text: `${draft.text.slice(0, start)}${name}${space}${suffix}` })
  updateDraft(chatId, { entities: [...(draftFor(chatId).entities ?? []).filter((entity) => entity.offset + entity.length <= start || entity.offset >= start + name.length), { kind: "user", user_id: user.id, offset: start, length: name.length, value: "" }] })
  store.users.set(user.id, user)
  return start + name.length + space.length
}

export async function stageAttachment(chatId: number, source: string | Blob, kind: "photo" | "voice" = "photo", duration = 0) {
  if (!store.chatsReady || store.sendingChats.get(chatId) || draftFor(chatId).editing) return
  const currentSession = session
  const request = (attachmentRequests.get(chatId) ?? 0) + 1
  attachmentRequests.set(chatId, request)
  const attachment = typeof source === "string" ? await api.prepareAttachment(source)
    : kind === "voice" ? await api.prepareVoice(await source.arrayBuffer()) : await api.prepareClipboardImage(await source.arrayBuffer())
  if (currentSession === session && attachmentRequests.get(chatId) === request) updateDraft(chatId, {
    attachment, videoInfo: kind === "voice" ? { width: 0, height: 0, duration } : null,
  })
}

export function removeAttachment(chatId: number) {
  attachmentRequests.set(chatId, (attachmentRequests.get(chatId) ?? 0) + 1)
  updateDraft(chatId, { attachment: null, videoInfo: null })
}

export function messageText(message: MsgData): string {
  return message.content.kind === "Text" ? message.content.data.text
    : "caption" in message.content.data ? message.content.data.caption : ""
}

export function replyToMessage(message: MsgData, preferredKey?: number) {
  if (!store.chatsReady) return
  const key = keyForMessage(message, preferredKey)
  if (!isConversationVisible(key)) return
  cancelEditing(key)
  updateDraft(key, { reply: message, editing: null })
  closeMessageOverlays()
  closeProfile()
  store.composeFocus += 1
  store.composeFocusChatId = key
}

export function canEditMessageContent(message: MsgData) {
  return ["Text", "Photo", "Video", "File", "Voice"].includes(message.content.kind)
}

export async function editLastMessage(chatId: number, hasFocus: () => boolean) {
  const currentSession = session
  const currentDraft = store.drafts.get(chatId)
  const active = () => currentSession === session && store.chatsReady && isConversationVisible(chatId)
    && !store.sendingChats.get(chatId) && store.drafts.get(chatId) === currentDraft && hasFocus()
  const draft = draftFor(chatId)
  if (!active() || draft.text || draft.attachment || draft.reply || draft.editing) return

  const target = conversationTarget(chatId)
  const eligible = (message: MsgData) => message.is_outgoing && message.sending_state === "sent"
    && !message.is_deleted && !deleted.has(messageKey(message.chat_id, message.id)) && canEditMessageContent(message)
  let message = store.historyLoaded.get(chatId) && store.historyAtLatest.get(chatId) !== false
    ? store.messages.get(chatId)?.findLast(eligible) : undefined
  try {
    let cursor = 0
    while (!message && active()) {
      const page = await requestMessages(() => api.searchMessages(target.chatId, "", cursor, true, target.threadId), true, active)
      if (!active()) return
      message = page.messages.find(eligible)
      if (!page.next_from_message_id || page.next_from_message_id === cursor) break
      cursor = page.next_from_message_id
    }
    if (!message) return
    const id = message.id
    const permissions = await requestMessages(() => api.messageActions(target.chatId, id), true, active)
    const current = normalizeMessage(message)
    if (permissions.can_edit && active() && current && eligible(current)) editMessage(current, chatId)
  } catch {}
}

export function editMessage(message: MsgData, preferredKey?: number) {
  const key = keyForMessage(message, preferredKey)
  if (!store.chatsReady || !isConversationVisible(key)) return
  if (!draftFor(key).editing) editBackups.set(key, draftFor(key))
  updateDraft(key, { text: messageText(message), entities: "entities" in message.content.data ? message.content.data.entities : [], editing: message, reply: null, attachment: null, videoInfo: null })
  closeMessageOverlays()
  closeProfile()
  store.composeFocus += 1
  store.composeFocusChatId = key
}

export function cancelEditing(chatId: number) {
  if (!draftFor(chatId).editing) return
  const original = editBackups.get(chatId)
  editBackups.delete(chatId)
  updateDraft(chatId, { ...original, text: original?.text ?? "", editing: original?.editing ?? null, entities: original?.entities ?? [] })
}

export async function sendDraft(chatId: number): Promise<void> {
  const draft = draftFor(chatId)
  const text = draft.text.trim()
  const trim = draft.text.length - draft.text.trimStart().length
  const entities = (draft.entities ?? []).filter((entity) => entity.offset >= trim && entity.offset + entity.length <= trim + text.length).map((entity) => ({ ...entity, offset: entity.offset - trim }))
  const entityArgs: [TextEntityData[]] | [] = entities.length ? [entities] : []
  const target = conversationTarget(chatId)
  const sendArgs: [TextEntityData[]?, number?] = target.threadId ? [entities, target.threadId] : entityArgs
  if (!store.chatsReady || store.sendingChats.get(chatId) || (!text && !draft.attachment && !draft.editing)) return
  if (draft.editing?.content.kind === "Text" && !text) return
  if (draft.editing && text === messageText(draft.editing).trim()) {
    cancelEditing(chatId)
    return
  }
  const currentSession = session
  store.sendingChats.set(chatId, true)
  store.composeErrors.delete(chatId)
  try {
    const message = draft.editing ? await api.editMessage(target.chatId, draft.editing.id, text, ...entityArgs)
      : draft.attachment?.kind === "voice" ? await api.sendVoice(target.chatId, draft.attachment.path, draft.videoInfo?.duration ?? 0, text, draft.reply?.id ?? null, ...sendArgs)
      : draft.attachment ? await api.sendFile(target.chatId, draft.attachment.path, text, draft.reply?.id ?? null, draft.videoInfo, ...sendArgs)
      : await api.sendText(target.chatId, text, draft.reply?.id ?? null, ...sendArgs)
    if (currentSession !== session) return
    if (draft.editing) updateMessageContent({ chat_id: target.chatId, message_id: message.id, content: message.content })
    if (!draft.editing) await scrollAfterSend(chatId, !!draft.reply)
    if (currentSession !== session) return
    appendMessage(message)
    const latest = draftFor(chatId)
    if (draft.editing && latest.editing?.id === draft.editing.id) {
      cancelEditing(chatId)
      return
    }
    updateDraft(chatId, {
      text: latest.text === draft.text ? "" : latest.text,
      attachment: latest.attachment?.path === draft.attachment?.path ? null : latest.attachment,
      videoInfo: latest.attachment?.path === draft.attachment?.path ? null : latest.videoInfo,
      reply: latest.reply?.id === draft.reply?.id ? null : latest.reply,
      editing: latest.editing?.id === draft.editing?.id ? null : latest.editing,
    })
  } catch (error) {
    if (currentSession === session) store.composeErrors.set(chatId, String(error))
  } finally {
    if (currentSession === session) store.sendingChats.set(chatId, false)
  }
}

export function openMessageMenu(message: MsgData, x: number, y: number) {
  if (!store.chatsReady) return
  store.contextMenu = { kind: "message", message, x, y }
}

export function openReactionMenu(message: MsgData, reaction: ReactionData, x: number, y: number) {
  if (!store.chatsReady || message.is_deleted || reaction.key === "paid") return
  store.contextMenu = { kind: "reaction", message, reaction, x, y }
}

export function openChatMenu(chat: ChatSummary, x: number, y: number) {
  if (!store.chatsReady) return
  store.focusedMessage = null
  store.contextMenu = { kind: "chat", chat, folderId: store.selectedFolder, x, y }
}

export function focusMessage(message: MsgData) {
  const key = keyForMessage(message)
  if (!store.chatsReady || !isConversationVisible(key)) return
  const chat = activeChat(key)
  store.focusedMessage = { message, isGroup: chat?.is_group ?? false }
  store.contextMenu = null
}

export function closeMessageOverlays() {
  store.contextMenu = null
  store.focusedMessage = null
}

export function activateChat(chatId: number) {
  const chat = activeChat(chatId)
  if (chat) openConversation(chat)
}
