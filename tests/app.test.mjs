import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { afterEach, test } from "node:test"
import { compileModule } from "svelte/compiler"
import ts from "typescript"

const source = await readFile(new URL("../src/lib/stores/app.svelte.ts", import.meta.url), "utf8")
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
}).outputText
const compiled = compileModule(javascript, { filename: "app.svelte.js", generate: "client", dev: false }).js.code
const utilitySource = await readFile(new URL("../src/lib/utils.ts", import.meta.url), "utf8")
const utilityCode = ts.transpileModule(utilitySource, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
const utilities = await import(`data:text/javascript;base64,${Buffer.from(utilityCode).toString("base64")}`)
const fixtures = new Map()
globalThis.__parugramTests = fixtures
let nextId = 0

const user = { id: 1, first_name: "Test", last_name: "User", username: "test", photo: null, photo_file_id: null }
const message = (id, options = {}) => ({
  id, chat_id: 10, date: id, is_outgoing: false,
  sender: { kind: "user", id: 1, name: "Test User", photo: null, photo_file_id: null },
  content: { kind: "Text", data: { text: `Message ${id}` } },
  sending_state: "sent", error: null, ...options,
})
const chat = (id = 10) => ({
  id, title: `Chat ${id}`, order: 100, is_pinned: false, unread_count: 0,
  is_group: false, photo: null, photo_file_id: null,
  last_read_outbox_message_id: 0, last_message: null,
})
const song = (id, options = {}) => message(id, {
  content: { kind: "Audio", data: { file_id: id, file_name: `track-${id}.mp3`, size: 2048, duration: 180, title: `Track ${id}`, performer: "Artist", mime_type: "audio/mpeg", cover_file_id: 100 + id, caption: "", entities: [] } },
  ...options,
})
const chatList = (options = {}) => ({ folder_id: 0, chats: [chat()], ready: true, has_more: true, error: null, ...options })
const snapshot = (options = {}) => ({
  auth: { stage: "ready", user }, chats: chatList(), connection: "connected", ...options,
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

async function setup({ cached, initial = snapshot(), preferences = {} } = {}) {
  const values = new Map([...Object.entries(preferences), ...(cached === undefined ? [] : [["parugram:chats:v1", cached]])])
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
  globalThis.window = new EventTarget()
  globalThis.document = new EventTarget()
  document.visibilityState = "visible"
  let handlers
  const fixture = {
    api: { snapshot: async () => initial, getHistory: async () => [], loadMoreChats: async () => false, downloadFile: async () => ({ local_path: null }) },
    initTdEvents: async (next) => {
      handlers = next
      return () => {}
    },
  }
  const id = nextId++
  fixtures.set(id, fixture)
  const code = compiled
    .replace(/from (['"])svelte\/internal\/client\1/, `from ${JSON.stringify(import.meta.resolve("svelte/internal/client"))}`)
    .replace(/from (['"])svelte\/reactivity\1/, `from ${JSON.stringify(import.meta.resolve("svelte/reactivity"))}`)
    .replace(/import \{ initTdEvents, api \} from ["']\$lib\/api\/td["'];?/, `const { initTdEvents, api } = globalThis.__parugramTests.get(${id})`)
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${code}\n`).toString("base64")}#${id}`)
  return { ...module, values, api: fixture.api, events: () => handlers }
}

afterEach(() => {
  for (const fixture of fixtures.values()) fixture.handlers?.onAuthState({ stage: "logged_out", user: null })
  fixtures.clear()
})

async function ready(options) {
  const app = await setup(options)
  await app.initStore()
  fixtures.get(nextId - 1).handlers = app.events()
  return app
}

test("deduplicates command responses and live events in either order", async () => {
  const app = await ready()
  const sent = message(20, { is_outgoing: true })
  app.appendMessage(sent)
  app.events().onMessage(sent)
  app.events().onMessage(message(21))
  app.appendMessage(message(21))
  assert.deepEqual(app.store.messages.get(10).map((m) => m.id), [20, 21])
})

test("replaces a temporary ID even when acknowledgement arrives first", async () => {
  const app = await ready()
  const pending = message(900, { date: 20, is_outgoing: true, sending_state: "pending" })
  const sent = message(20, { is_outgoing: true })
  app.events().onMessageReplaced({ old_message_id: 900, message: sent })
  app.appendMessage(pending)
  app.events().onMessage(pending)
  assert.deepEqual(app.store.messages.get(10).map((m) => [m.id, m.sending_state]), [[20, "sent"]])
})

test("replaces pending messages and displays failed sends", async () => {
  const app = await ready()
  app.appendMessage(message(900, { date: 20, sending_state: "pending" }))
  app.replaceMessage({ old_message_id: 900, message: message(20) })
  app.appendMessage(message(901, { date: 21, sending_state: "pending" }))
  app.replaceMessage({ old_message_id: 901, message: message(901, { date: 21, sending_state: "failed", error: "Rejected" }) })
  app.appendMessage(message(901, { date: 21, sending_state: "pending" }))
  assert.deepEqual(app.store.messages.get(10).map((m) => [m.id, m.sending_state]), [[20, "sent"], [901, "failed"]])
})

test("continues after short history batches and stops only at an empty page", async () => {
  const app = await ready()
  const cursors = []
  const batches = [[message(40), message(50)], [message(30), message(40)], []]
  app.api.getHistory = async (chatId, cursor) => {
    cursors.push(cursor)
    return batches.shift()
  }
  await app.loadHistory(10)
  assert.equal(app.store.historyDone.get(10), undefined)
  await app.loadHistory(10, true)
  assert.equal(app.store.historyDone.get(10), undefined)
  await app.loadHistory(10, true)
  assert.equal(app.store.historyDone.get(10), true)
  assert.deepEqual(cursors, [0, 40, 30])
  assert.deepEqual(app.store.messages.get(10).map((m) => m.id), [30, 40, 50])
})

test("merges incoming messages with history and coalesces concurrent history requests", async () => {
  const app = await ready()
  const response = deferred()
  let calls = 0
  app.api.getHistory = async () => {
    calls += 1
    return response.promise
  }
  app.appendMessage(message(60))
  assert.equal(app.store.historyLoaded.get(10), undefined)
  const first = app.loadHistory(10)
  const second = app.loadHistory(10)
  app.appendMessage(message(70))
  response.resolve([message(40), message(60)])
  await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.deepEqual(app.store.messages.get(10).map((m) => m.id), [40, 60, 70])
})

test("does not resurrect edited or deleted messages from an in-flight history page", async () => {
  const app = await ready()
  const response = deferred()
  app.api.getHistory = () => response.promise
  const pending = app.loadHistory(10)
  app.events().onMessageContent({ chat_id: 10, message_id: 40, content: { kind: "Text", data: { text: "Edited" } } })
  app.events().onMessagesDeleted({ chat_id: 10, message_ids: [50] })
  response.resolve([message(40), message(50)])
  await pending
  assert.equal(app.store.messages.get(10).length, 1)
  assert.equal(app.store.messages.get(10)[0].content.data.text, "Edited")
})

test("restores cache immediately but keeps dialogs locked through synchronization", async () => {
  const cached = JSON.stringify({ version: 1, user, chats: [chat(99)] })
  const response = deferred()
  const app = await setup({ cached })
  app.api.snapshot = () => response.promise
  const pending = app.initStore()
  assert.equal(app.store.cached, true)
  assert.equal(app.store.chats[0].id, 99)
  app.store.activeChatId = 99
  assert.equal(app.activeChat(), null)
  response.resolve(snapshot({ chats: chatList({ ready: false }) }))
  await pending
  fixtures.get(nextId - 1).handlers = app.events()
  assert.equal(app.store.cached, true)
  assert.equal(app.store.chats[0].id, 99)
  app.events().onChats(chatList())
  assert.equal(app.store.cached, false)
  assert.equal(app.store.chatsReady, true)
  assert.equal(app.store.chats[0].id, 10)
})

test("saves a refreshed list and clears all account data on logout", async () => {
  const app = await ready()
  window.dispatchEvent(new Event("pagehide"))
  assert.equal(JSON.parse(app.values.get("parugram:chats:v1")).user.id, 1)
  app.appendMessage(message(40))
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.values.has("parugram:chats:v1"), false)
  assert.equal(app.store.chats.length, 0)
  assert.equal(app.store.messages.size, 0)
  assert.equal(app.store.chatsReady, false)
})

test("rejects corrupt cache and discards cache for a different account", async () => {
  const corrupt = await ready({ cached: '{"version":1,"user":{"id":1},"chats":[null]}', initial: snapshot({ auth: { stage: "loading", user: null }, chats: chatList({ ready: false, chats: [] }) }) })
  assert.equal(corrupt.store.cached, false)
  const app = await ready({
    cached: JSON.stringify({ version: 1, user: { ...user, id: 2 }, chats: [chat(99)] }),
    initial: snapshot({ chats: chatList({ ready: false, chats: [] }) }),
  })
  assert.equal(app.store.cached, false)
  assert.equal(app.store.user.id, 1)
  assert.equal(app.store.chats.length, 0)
})

test("ignores history responses that finish after logout", async () => {
  const app = await ready()
  const response = deferred()
  app.api.getHistory = () => response.promise
  const pending = app.loadHistory(10)
  app.events().onAuthState({ stage: "logged_out", user: null })
  response.resolve([message(40)])
  await pending
  assert.equal(app.store.messages.size, 0)
  assert.equal(app.store.historyLoaded.size, 0)
})

test("uses chat exhaustion from TDLib and prevents duplicate page requests", async () => {
  const app = await ready()
  const response = deferred()
  let calls = 0
  app.api.loadMoreChats = () => {
    calls += 1
    return response.promise
  }
  const pending = app.loadMoreChats()
  await app.loadMoreChats()
  assert.equal(calls, 1)
  response.resolve(false)
  await pending
  await app.loadMoreChats()
  assert.equal(calls, 1)
  assert.equal(app.store.hasMoreChats, false)
})

test("does not replace live events with an older startup snapshot", async () => {
  const app = await setup()
  const response = deferred()
  app.api.snapshot = () => response.promise
  const pending = app.initStore()
  await Promise.resolve()
  app.events().onAuthState({ stage: "ready", user })
  app.events().onChats(chatList({ chats: [chat(77)] }))
  response.resolve(snapshot())
  await pending
  fixtures.get(nextId - 1).handlers = app.events()
  assert.equal(app.store.chats[0].id, 77)
})

test("restores and rotates the QR login link in memory, then clears it after scanning", async () => {
  const auth = { stage: "wait_other_device", user: null, qr_login_link: "tg://login?token=first" }
  const app = await ready({ initial: snapshot({ auth }) })
  assert.equal(app.store.stage, auth.stage)
  assert.equal(app.store.qrLoginLink, auth.qr_login_link)

  app.events().onAuthState({ ...auth, qr_login_link: "tg://login?token=second" })
  assert.equal(app.store.qrLoginLink, "tg://login?token=second")
  window.dispatchEvent(new Event("pagehide"))
  assert.equal([...app.values.values()].some((value) => value.includes("tg://login?token=")), false)

  app.events().onAuthState({ stage: "wait_password", user: null })
  assert.equal(app.store.stage, "wait_password")
  assert.equal(app.store.qrLoginLink, null)
})

test("starts with at most 50 cached and refreshed chats without requesting another page", async () => {
  const chats = Array.from({ length: 150 }, (_, index) => chat(index + 1))
  const app = await setup({
    cached: JSON.stringify({ version: 1, user, chats }),
    initial: snapshot({ chats: chatList({ chats }) }),
  })
  let requests = 0
  app.api.loadMoreChats = async () => {
    requests += 1
    return true
  }
  const pending = app.initStore()
  assert.equal(app.store.chats.length, 50)
  await pending
  fixtures.get(nextId - 1).handlers = app.events()
  assert.equal(app.store.chats.length, 50)
  assert.equal(requests, 0)
  window.dispatchEvent(new Event("pagehide"))
  assert.equal(JSON.parse(app.values.get("parugram:chats:v1")).chats.length, 50)
})

test("expands the chat list only when another page is requested", async () => {
  const chats = Array.from({ length: 150 }, (_, index) => chat(index + 1))
  const app = await ready({ initial: snapshot({ chats: chatList({ chats }) }) })
  app.api.loadMoreChats = async () => {
    app.events().onChats(chatList({ chats }))
    return true
  }
  assert.equal(app.store.chats.length, 50)
  await app.loadMoreChats()
  assert.equal(app.store.chats.length, 100)
  assert.equal(app.store.chatLimit, 100)
  app.events().onChats(chatList({ chats }))
  assert.equal(app.store.chats.length, 100)
})

test("updates group authors from user events and retains channel signatures", async () => {
  const app = await ready()
  const groupMessage = message(40)
  app.events().onUser({ ...user, first_name: "Alice", last_name: "", photo_file_id: 7 })
  assert.equal(app.messageSender(groupMessage).name, "Alice")
  assert.equal(app.messageSender(groupMessage).photo_file_id, 7)
  const signed = message(41, { sender: { kind: "chat", id: 10, name: "Admin", photo: null, photo_file_id: null } })
  assert.equal(app.messageSender(signed).name, "Admin")
})

test("shares avatar downloads and saves downloaded avatar paths with the chat cache", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), photo_file_id: 7 }] }) }) })
  const response = deferred()
  let requests = 0
  app.api.downloadFile = async () => {
    requests += 1
    return response.promise
  }
  const first = app.loadAvatar(7)
  const second = app.loadAvatar(7)
  response.resolve({ file_id: 7, local_path: "C:/avatar.jpg" })
  assert.deepEqual(await Promise.all([first, second]), ["C:/avatar.jpg", "C:/avatar.jpg"])
  assert.equal(requests, 1)
  assert.equal(await app.loadAvatar(7), "C:/avatar.jpg")
  assert.equal(requests, 1)
  window.dispatchEvent(new Event("pagehide"))
  assert.equal(JSON.parse(app.values.get("parugram:chats:v1")).chats[0].photo, "C:/avatar.jpg")
})

test("discards avatar downloads and user data after logout", async () => {
  const app = await ready()
  const response = deferred()
  app.api.downloadFile = () => response.promise
  app.events().onUser(user)
  const pending = app.loadAvatar(7)
  app.events().onAuthState({ stage: "logged_out", user: null })
  response.resolve({ file_id: 7, local_path: "C:/old-account.jpg" })
  assert.equal(await pending, null)
  assert.equal(app.store.files.size, 0)
  assert.equal(app.store.users.size, 0)
})

test("persists Performance independently from account data", async () => {
  const app = await setup()
  app.values.set("parugram:effects", "reduced")
  await app.initStore()
  fixtures.get(nextId - 1).handlers = app.events()
  assert.equal(app.store.effects, "reduced")
  app.setEffects("full")
  assert.equal(app.values.get("parugram:effects"), "full")
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.store.effects, "full")
  assert.equal(app.values.get("parugram:effects"), "full")
})

test("rejects chat updates and pagination results from a previously selected folder", async () => {
  const app = await ready()
  const first = deferred()
  const second = deferred()
  app.api.selectFolder = (id) => id === 7 ? first.promise : second.promise
  const requestOne = app.selectFolder(7)
  assert.equal(app.store.chatsReady, false)
  app.events().onChats(chatList({ folder_id: 0, chats: [chat(99)] }))
  assert.equal(app.store.chats[0].id, 10)
  const requestTwo = app.selectFolder(8)
  app.events().onChats(chatList({ folder_id: 7, chats: [chat(77)] }))
  first.resolve(false)
  await requestOne
  assert.equal(app.store.selectedFolder, 8)
  assert.equal(app.store.loadingChats, true)
  app.events().onChats(chatList({ folder_id: 8, chats: [chat(88)] }))
  second.resolve(true)
  await requestTwo
  assert.equal(app.store.chats[0].id, 88)
  assert.equal(app.store.chatsReady, true)
  assert.equal(app.store.chatLimit, 50)
})

test("does not save folder contents over the startup cache", async () => {
  const app = await ready()
  window.dispatchEvent(new Event("pagehide"))
  const saved = app.values.get("parugram:chats:v1")
  app.api.selectFolder = async () => {
    app.events().onChats(chatList({ folder_id: 7, chats: [chat(77)] }))
    return false
  }
  await app.selectFolder(7)
  window.dispatchEvent(new Event("pagehide"))
  assert.equal(app.values.get("parugram:chats:v1"), saved)
})

test("keeps only the latest requested profile and ignores responses after closing", async () => {
  const app = await ready()
  const first = deferred()
  const second = deferred()
  app.api.getProfile = (target) => target.id === 1 ? first.promise : second.promise
  const openingFirst = app.openProfile({ kind: "user", id: 1 })
  const openingSecond = app.openProfile({ kind: "user", id: 2 })
  first.resolve({ id: 1 })
  await openingFirst
  assert.equal(app.store.profile, null)
  second.resolve({ id: 2 })
  await openingSecond
  assert.equal(app.store.profile.id, 2)
  const third = deferred()
  app.api.getProfile = () => third.promise
  const openingThird = app.openProfile({ kind: "user", id: 3 })
  app.closeProfile()
  third.resolve({ id: 3 })
  await openingThird
  assert.equal(app.store.profile, null)
  assert.equal(app.store.profileTarget, null)
})

test("opens a profile conversation outside the current 50 chats without expanding the list", async () => {
  const app = await ready()
  app.openConversation(chat(77))
  assert.equal(app.activeChat().id, 77)
  assert.equal(app.store.chats.length, 1)
  assert.equal(app.store.profileTarget, null)
})

test("recognizes username links and explicit user links without treating invitations as profiles", () => {
  assert.deepEqual(utilities.profileTargetFromUrl("https://t.me/example"), { kind: "username", username: "example" })
  assert.deepEqual(utilities.profileTargetFromUrl("tg://user?id=123"), { kind: "user", id: 123 })
  assert.equal(utilities.profileTargetFromUrl("https://t.me/+invite"), null)
  assert.equal(utilities.profileTargetFromUrl("https://t.me/share"), null)
  assert.equal(utilities.profileTargetFromUrl("javascript:alert(1)"), null)
})

test("preserves UTF-16 mention offsets and rejects unsafe links", () => {
  const text = "😀 @alice hello"
  const parts = utilities.textParts(text, [{ offset: 3, length: 6, kind: "mention", value: "", user_id: null }])
  assert.equal(parts.map((part) => part.text).join(""), text)
  assert.deepEqual(parts[1].target, { kind: "username", username: "alice" })
  const named = utilities.textParts("Alice", [{ offset: 0, length: 5, kind: "user", value: "", user_id: 42 }])
  assert.deepEqual(named[0].target, { kind: "user", id: 42 })
  const unsafe = utilities.textParts("click", [{ offset: 0, length: 5, kind: "url", value: "javascript:alert(1)", user_id: null }])
  assert.equal(unsafe[0].url, undefined)
})

test("renders nested formatting and keeps Telegram URLs inside code literal", () => {
  const text = "😀 Bold italic\nt.me/example"
  const entity = (kind, offset, length) => ({ kind, offset, length, value: "", user_id: null })
  const parts = utilities.textParts(text, [entity("italic", 8, 6), entity("bold", 3, 11), entity("pre", 15, 12), entity("italic", 1, 1)])
  assert.deepEqual(parts, [
    { text: "😀 " },
    { text: "Bold italic", format: "bold", children: [{ text: "Bold " }, { text: "italic", format: "italic" }] },
    { text: "\n" },
    { text: "t.me/example", format: "pre" },
  ])
  assert.deepEqual(utilities.textParts("bold link", [entity("bold", 0, 9), { ...entity("url", 5, 4), value: "https://example.com" }]), [
    { text: "bold link", format: "bold", children: [{ text: "bold " }, { text: "link", url: "https://example.com/" }] },
  ])
})

test("decodes Telegram waveforms and formats voice durations", () => {
  const peaks = utilities.voiceWaveform(btoa(String.fromCharCode(...Array(20).fill(255))))
  assert.equal(peaks.length, 36)
  assert.ok(peaks.every((height) => height === 31))
  assert.equal(utilities.voiceWaveform("!").length, 36)
  assert.equal(utilities.formatDuration(125.9), "2:05")
  assert.equal(utilities.formatDuration(NaN), "0:00")
})

test("restores local draft text by chat and thread and removes it only after a successful send", async () => {
  const app = await ready()
  app.updateDraft(10, { text: "  Черновик\n" })
  app.store.conversations.set(-21, { chat: chat(10), threadId: 50 })
  app.updateDraft(-21, { text: "Комментарий" })
  app.activateChat(10)
  app.editMessage(message(30))
  app.updateDraft(10, { text: "Редактирование" })

  const restored = await ready({ preferences: Object.fromEntries(app.values) })
  restored.store.conversations.set(-22, { chat: chat(10), threadId: 50 })
  assert.equal(restored.draftFor(-22).text, "Комментарий")
  assert.equal(restored.draftFor(10).text, "  Черновик\n")
  assert.equal(restored.draftFor(11).text, "")
  restored.api.sendText = async () => { throw new Error("Failed") }
  await restored.sendDraft(10)
  assert.equal(JSON.parse(restored.values.get("parugram:drafts"))["10"], "  Черновик\n")
  restored.api.sendText = async () => message(40, { is_outgoing: true })
  await restored.sendDraft(10)
  assert.deepEqual(JSON.parse(restored.values.get("parugram:drafts")), { "10:50": "Комментарий" })
  assert.equal(restored.draftFor(-22).text, "Комментарий")
})

test("stages an attachment without sending and sends the draft text as its caption", async () => {
  const app = await ready()
  const attachment = { path: "C:/photo.jpg", file_name: "photo.jpg", kind: "photo", size: 200 }
  let sent = 0
  app.api.prepareAttachment = async () => attachment
  app.api.sendFile = async (...args) => {
    sent += 1
    assert.deepEqual(args, [10, attachment.path, "Caption", null, null])
    return message(50)
  }
  app.updateDraft(10, { text: "Caption" })
  await app.stageAttachment(10, attachment.path)
  assert.equal(sent, 0)
  assert.equal(app.draftFor(10).attachment.path, attachment.path)
  assert.equal(app.draftFor(10).text, "Caption")
  await app.sendDraft(10)
  assert.equal(sent, 1)
  assert.equal(app.draftFor(10).attachment, null)
  assert.equal(app.draftFor(10).text, "")
})

test("keeps attachment drafts separate and retains text when removing a file", async () => {
  const app = await ready()
  app.api.prepareAttachment = async (path) => ({ path, file_name: path, kind: "file", size: 12 })
  app.updateDraft(10, { text: "Draft A" })
  await app.stageAttachment(10, "C:/one.txt")
  app.updateDraft(11, { text: "Draft B" })
  assert.equal(app.draftFor(10).attachment.path, "C:/one.txt")
  assert.equal(app.draftFor(11).attachment, null)
  app.removeAttachment(10)
  assert.equal(app.draftFor(10).text, "Draft A")
  assert.equal(app.draftFor(11).text, "Draft B")
})

test("does not restore a removed or superseded attachment after metadata loads", async () => {
  const app = await ready()
  const first = deferred()
  const second = deferred()
  app.api.prepareAttachment = (path) => path === "one" ? first.promise : second.promise
  const selectingFirst = app.stageAttachment(10, "one")
  const selectingSecond = app.stageAttachment(10, "two")
  second.resolve({ path: "two", kind: "file", file_name: "two", size: 2 })
  await selectingSecond
  first.resolve({ path: "one", kind: "file", file_name: "one", size: 1 })
  await selectingFirst
  assert.equal(app.draftFor(10).attachment.path, "two")
  const third = deferred()
  app.api.prepareAttachment = () => third.promise
  const selectingThird = app.stageAttachment(10, "three")
  app.removeAttachment(10)
  third.resolve({ path: "three", kind: "file", file_name: "three", size: 3 })
  await selectingThird
  assert.equal(app.draftFor(10).attachment, null)
})

test("preserves the attachment and caption on send failure", async () => {
  const app = await ready()
  const attachment = { path: "C:/file.pdf", file_name: "file.pdf", kind: "file", size: 200 }
  app.updateDraft(10, { text: "Caption", attachment })
  app.api.sendFile = async () => { throw new Error("Upload failed") }
  await app.sendDraft(10)
  assert.equal(app.draftFor(10).attachment.path, attachment.path)
  assert.equal(app.draftFor(10).text, "Caption")
  assert.match(app.store.composeErrors.get(10), /Upload failed/)
  assert.equal(app.store.sendingChats.get(10), false)
})

test("coalesces send clicks while preserving text entered during the upload", async () => {
  const app = await ready()
  const response = deferred()
  let calls = 0
  app.api.sendText = async () => {
    calls += 1
    return response.promise
  }
  app.updateDraft(10, { text: "First" })
  const sending = app.sendDraft(10)
  await app.sendDraft(10)
  app.updateDraft(10, { text: "Next draft" })
  response.resolve(message(50))
  await sending
  assert.equal(calls, 1)
  assert.equal(app.draftFor(10).text, "Next draft")
})

test("carries reply targets into the send request and leaves other chat drafts untouched", async () => {
  const app = await ready()
  app.store.activeChatId = 10
  app.replyToMessage(message(40))
  app.updateDraft(10, { text: "Answer" })
  app.updateDraft(11, { text: "Other" })
  app.api.sendText = async (...args) => {
    assert.deepEqual(args, [10, "Answer", 40])
    return message(50)
  }
  await app.sendDraft(10)
  assert.equal(app.draftFor(10).reply, null)
  assert.equal(app.draftFor(11).text, "Other")
})

test("restores the original attachment draft after cancelling or saving an edit", async () => {
  const app = await ready()
  app.store.activeChatId = 10
  const attachment = { path: "C:/draft.jpg", file_name: "draft.jpg", kind: "photo", size: 100 }
  app.updateDraft(10, { text: "Unsent caption", attachment })
  app.editMessage(message(40))
  assert.equal(app.draftFor(10).text, "Message 40")
  app.cancelEditing(10)
  assert.equal(app.draftFor(10).attachment.path, attachment.path)
  app.editMessage(message(40))
  app.updateDraft(10, { text: "Edited" })
  app.api.editMessage = async (...args) => {
    assert.deepEqual(args, [10, 40, "Edited"])
    return message(40, { content: { kind: "Text", data: { text: "Edited" } } })
  }
  await app.sendDraft(10)
  assert.equal(app.draftFor(10).text, "Unsent caption")
  assert.equal(app.draftFor(10).attachment.path, attachment.path)
  assert.equal(app.store.messages.get(10)[0].content.data.text, "Edited")
})

test("includes video metadata and permits sending a file without a caption", async () => {
  const app = await ready()
  const attachment = { path: "C:/clip.mp4", file_name: "clip.mp4", kind: "video", size: 100 }
  const videoInfo = { width: 1920, height: 1080, duration: 12 }
  app.updateDraft(10, { attachment, videoInfo })
  app.api.sendFile = async (...args) => {
    assert.deepEqual(args, [10, attachment.path, "", null, videoInfo])
    return message(50)
  }
  await app.sendDraft(10)
  assert.equal(app.draftFor(10).attachment, null)
})

test("clears drafts and ignores completed attachment and send requests after logout", async () => {
  const app = await ready()
  const fileResponse = deferred()
  const sendResponse = deferred()
  app.api.prepareAttachment = () => fileResponse.promise
  app.api.sendText = () => sendResponse.promise
  app.updateDraft(10, { text: "Unsent" })
  const staging = app.stageAttachment(11, "file")
  const sending = app.sendDraft(10)
  app.events().onAuthState({ stage: "logged_out", user: null })
  fileResponse.resolve({ path: "file", file_name: "file", size: 1, kind: "file" })
  sendResponse.resolve(message(50))
  await Promise.all([staging, sending])
  assert.equal(app.store.drafts.size, 0)
  assert.equal(app.store.messages.size, 0)
  assert.equal(app.store.sendingChats.size, 0)
})

test("focuses the selected group message and closes menus on navigation or deletion", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), is_group: true }] }) }) })
  app.store.activeChatId = 10
  const selected = message(40)
  app.openMessageMenu(selected, 100, 200)
  assert.equal(app.store.contextMenu.kind, "message")
  app.focusMessage(selected)
  assert.equal(app.store.contextMenu, null)
  assert.equal(app.store.focusedMessage.isGroup, true)
  app.deleteMessages({ chat_id: 10, message_ids: [40] })
  assert.equal(app.store.focusedMessage, null)
  app.openChatMenu(chat(), 20, 30)
  assert.equal(app.store.contextMenu.folderId, 0)
  app.activateChat(10)
  assert.equal(app.store.contextMenu, null)
})

test("keeps the open conversation and draft while switching to a folder that does not contain it", async () => {
  const app = await ready()
  app.activateChat(10)
  app.updateDraft(10, { text: "Keep this draft" })
  const response = deferred()
  app.api.selectFolder = () => response.promise
  const switching = app.selectFolder(7)
  assert.equal(app.store.chatsReady, false)
  assert.equal(app.activeChat().id, 10)
  app.events().onChats(chatList({ folder_id: 7, chats: [chat(77)] }))
  response.resolve(false)
  await switching
  assert.equal(app.activeChat().id, 10)
  assert.equal(app.draftFor(10).text, "Keep this draft")
  app.activateChat(77)
  assert.equal(app.activeChat().id, 77)
})

test("stages clipboard image bytes without sending or replacing the caption", async () => {
  const app = await ready()
  app.updateDraft(10, { text: "Clipboard caption" })
  let sent = false
  app.api.sendFile = async () => { sent = true }
  app.api.prepareClipboardImage = async (bytes) => {
    assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3])
    return { path: "clipboard.png", file_name: "clipboard.png", size: 3, kind: "photo" }
  }
  await app.stageAttachment(10, new Blob([new Uint8Array([1, 2, 3])]))
  assert.equal(app.draftFor(10).attachment.path, "clipboard.png")
  assert.equal(app.draftFor(10).text, "Clipboard caption")
  assert.equal(sent, false)
})

test("does not restore clipboard attachments after removal or logout", async () => {
  const app = await ready()
  const response = deferred()
  app.api.prepareClipboardImage = () => response.promise
  const staging = app.stageAttachment(10, new Blob(["image"]))
  app.removeAttachment(10)
  app.events().onAuthState({ stage: "logged_out", user: null })
  response.resolve({ path: "old.png", file_name: "old.png", size: 5, kind: "photo" })
  await staging
  assert.equal(app.store.drafts.size, 0)
})

test("keeps recorded voice notes as drafts and sends them through the voice command with replies", async () => {
  const app = await ready()
  app.store.activeChatId = 10
  app.replyToMessage(message(42))
  app.api.prepareVoice = async () => ({ path: "voice.ogg", file_name: "voice.ogg", size: 5, kind: "voice" })
  await app.stageAttachment(10, new Blob(["OggS"]), "voice", 7)
  assert.equal(app.draftFor(10).attachment.kind, "voice")
  assert.equal(app.store.messages.size, 0)
  app.api.sendVoice = async (...args) => {
    assert.deepEqual(args, [10, "voice.ogg", 7, "", 42])
    return message(50, { content: { kind: "Voice", data: { file_id: 7, duration: 7, waveform: "", mime_type: "audio/ogg", caption: "" } } })
  }
  await app.sendDraft(10)
  assert.equal(app.draftFor(10).attachment, null)
  assert.equal(app.store.messages.get(10)[0].content.kind, "Voice")
})

test("updates online counts and clears them at logout", async () => {
  const app = await ready()
  app.events().onChatOnlineCount({ chat_id: 10, count: 12 })
  assert.equal(app.store.onlineCounts.get(10), 12)
  app.events().onAuthState({ stage: "logged_out", user: null })
  app.events().onChatOnlineCount({ chat_id: 10, count: 20 })
  assert.equal(app.store.onlineCounts.size, 0)
})

test("persists privacy mode without changing the selected chat", async () => {
  const app = await setup()
  app.values.set("parugram:privacy", "true")
  await app.initStore()
  assert.equal(app.store.privacyMode, true)
  app.activateChat(10)
  app.setPrivacyMode(false)
  assert.equal(app.store.activeChatId, 10)
  assert.equal(app.values.get("parugram:privacy"), "false")
})

test("builds the media viewer from photos and videos and starts at the selected item", async () => {
  const app = await ready()
  const photo = message(20, { content: { kind: "Photo", data: { file_id: 7, thumbnail_file_id: 6, width: 3000, height: 2000, caption: "Photo caption" } } })
  const video = message(30, { content: { kind: "Video", data: { file_id: 8, width: 640, height: 360, duration: 15, file_name: "clip.mp4", thumbnail_file_id: 9, caption: "Video caption" } } })
  const file = message(40, { content: { kind: "File", data: { file_id: 10, file_name: "document.pdf", size: 10, caption: "" } } })
  app.store.messages.set(10, [message(10), photo, video, file])
  app.store.playingVoice = "10:15"
  app.openMediaViewer(video)
  assert.deepEqual(app.store.mediaViewer.items.map((item) => item.kind), ["photo", "video"])
  assert.equal(app.store.mediaViewer.index, 1)
  assert.equal(app.store.mediaViewer.items[0].file_id, 7)
  assert.equal(app.store.mediaViewer.items[1].file_id, 8)
  assert.equal(app.store.playingVoice, null)
  assert.equal(app.mediaItem(file), null)
  app.closeMediaViewer()
  assert.equal(app.store.mediaViewer, null)
})

test("reports download progress, deduplicates an active download and keeps completion visible for five seconds", async (context) => {
  const app = await ready()
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const current = message(20, { content: { kind: "Sticker", data: { file_id: 7, format: "webp" } } })
  const file = deferred()
  let calls = 0
  app.api.saveMessageFile = async (chatId, messageId, progress) => {
    assert.deepEqual([chatId, messageId], [10, 20])
    calls += 1
    progress({ stage: "downloading", file_name: "sticker-7.webp", downloaded: 25, size: 100 })
    return file.promise
  }
  const pending = app.downloadMessage(current)
  await app.downloadMessage(current)
  assert.equal(calls, 1)
  assert.equal(app.store.downloads.get("10:20").progress, 25)
  file.resolve({ file_name: "sticker-7.webp", path: "D:/Parugram Downloads/sticker-7.webp" })
  await pending
  assert.deepEqual(app.store.downloads.get("10:20"), { fileName: "sticker-7.webp", stage: "done", path: "D:/Parugram Downloads/sticker-7.webp" })
  context.mock.timers.tick(4999)
  assert.equal(app.store.downloads.size, 1)
  context.mock.timers.tick(1)
  assert.equal(app.store.downloads.size, 0)
})

test("recognizes media sent as documents and opens profile photos without a chat history", async () => {
  const app = await ready()
  const file = message(40, { content: { kind: "File", data: { file_id: 10, file_name: "IMAGE.PNG", size: 10, caption: "Image" } } })
  app.openMediaViewer(file)
  assert.equal(app.store.mediaViewer.items[0].kind, "photo")
  app.openMediaItems([{ key: "profile:20", kind: "photo", file_id: 20, file_name: "Avatar", caption: "" }], 5)
  assert.equal(app.store.mediaViewer.index, 0)
  assert.equal(app.store.mediaViewer.items[0].file_id, 20)
})

test("removes deleted items from the media viewer and closes it when no items remain", async () => {
  const app = await ready()
  const photos = [20, 30].map((id) => message(id, { content: { kind: "Photo", data: { file_id: id, width: 100, height: 100, caption: "" } } }))
  app.store.messages.set(10, photos)
  const file = { file_id: 20, local_path: null, downloaded: 25, size: 100 }
  app.events().onFile(file)
  assert.equal(app.store.mediaTransfer, null)
  app.openMediaViewer(photos[0])
  app.events().onFile(file)
  assert.deepEqual(app.store.mediaTransfer, { fileId: 20, downloaded: 25, size: 100 })
  app.events().onFile({ ...file, file_id: 30 })
  assert.equal(app.store.mediaTransfer.fileId, 20)
  app.deleteMessages({ chat_id: 10, message_ids: [20] })
  assert.equal(app.store.mediaViewer.items[0].file_id, 30)
  assert.equal(app.store.mediaTransfer, null)
  app.deleteMessages({ chat_id: 10, message_ids: [30] })
  assert.equal(app.store.mediaViewer, null)
})

test("clears sensitive state at the fifth lock attempt and ignores stale lock and chat events", async () => {
  const app = await ready()
  app.activateChat(10)
  app.updateDraft(10, { text: "Private draft" })
  app.openMediaItems([{ key: "10:20", kind: "photo", file_id: 7, file_name: "Private", caption: "" }])
  const pending = { revision: 5, configured: true, kind: "pin", locked: true, remaining_attempts: 0, logout_pending: true, logged_out: false }
  assert.equal(app.applyAppLockStatus(pending), true)
  assert.equal(app.store.user, null)
  assert.equal(app.store.drafts.size, 0)
  assert.equal(app.store.mediaViewer, null)
  assert.equal(app.values.has("parugram:chats:v1"), false)
  app.events().onAuthState({ stage: "ready", user })
  app.events().onChats(chatList())
  assert.equal(app.store.chats.length, 0)
  assert.equal(app.store.stage, "logged_out")
  assert.equal(app.applyAppLockStatus({ ...pending, revision: 4, locked: false, logout_pending: false }), false)
  assert.equal(app.store.appLock.locked, true)
  assert.equal(app.applyAppLockStatus(pending), false)
})

test("tracks activity by author and chat and clears it after cancellation, messages, or logout", async () => {
  const app = await ready()
  const activity = { chat_id: 10, sender: { kind: "user", id: 2, name: "Анна", photo: null, photo_file_id: null }, action: "typing" }
  app.events().onChatActivity(activity)
  app.events().onChatActivity({ ...activity, sender: { ...activity.sender, id: 3, name: "Борис" }, action: "uploading_photo" })
  app.events().onChatActivity({ ...activity, sender: { ...activity.sender, id: 1 } })
  assert.equal(app.store.chatActivity.get(10).length, 2)
  app.events().onChatActivity({ ...activity, action: "recording_voice" })
  assert.equal(app.store.chatActivity.get(10).length, 2)
  assert.equal(app.store.chatActivity.get(10).find((item) => item.sender.id === 2).action, "recording_voice")
  app.events().onChatActivity({ ...activity, chat_id: 11 })
  app.events().onChatActivity({ ...activity, action: "cancel" })
  assert.equal(app.store.chatActivity.get(10).length, 1)
  assert.equal(app.store.chatActivity.get(11).length, 1)
  app.appendMessage(message(50, { sender: { ...activity.sender, id: 3 } }))
  assert.equal(app.store.chatActivity.has(10), false)
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.store.chatActivity.size, 0)
})

test("refreshes activity timeouts and expires an action without a cancel event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  const activity = { chat_id: 10, sender: { kind: "user", id: 2, name: "Анна", photo: null, photo_file_id: null }, action: "typing" }
  app.events().onChatActivity(activity)
  t.mock.timers.tick(5000)
  app.events().onChatActivity(activity)
  t.mock.timers.tick(2000)
  assert.equal(app.store.chatActivity.get(10).length, 1)
  t.mock.timers.tick(4001)
  assert.equal(app.store.chatActivity.has(10), false)
})

test("formats group activity for one or several authors and different actions", () => {
  const anna = { chat_id: 10, sender: { kind: "user", id: 2, name: "Анна" }, action: "typing" }
  const boris = { ...anna, sender: { ...anna.sender, id: 3, name: "Борис" } }
  assert.equal(utilities.chatActivityText([], true), "")
  assert.equal(utilities.chatActivityText([anna], false), "печатает")
  assert.equal(utilities.chatActivityText([anna], true), "Анна печатает")
  assert.equal(utilities.chatActivityText([anna, boris], true), "Анна и Борис печатают")
  assert.equal(utilities.chatActivityText([{ ...anna, action: "recording_voice" }, { ...boris, action: "uploading_photo" }], true), "Анна записывает голосовое, Борис отправляет фото")
})

test("retains observed deleted messages only when enabled and never resurrects their content", async () => {
  const app = await ready({ initial: snapshot({ save_deleted: true }) })
  app.appendMessage(message(20))
  app.deleteMessages({ chat_id: 10, message_ids: [20] })
  assert.equal(app.store.messages.get(10)[0].is_deleted, true)
  app.events().onMessageContent({ chat_id: 10, message_id: 20, content: { kind: "Text", data: { text: "stale" } } })
  app.appendMessage(message(20))
  assert.equal(app.store.messages.get(10)[0].content.data.text, "Message 20")
  app.store.saveDeleted = false
  app.appendMessage(message(30))
  app.deleteMessages({ chat_id: 10, message_ids: [30] })
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20])
})

test("merges archived deletions inside history windows and loads older archives without gaps", async () => {
  const app = await ready()
  app.api.savedDeleted = async () => [message(5, { is_deleted: true }), message(25, { is_deleted: true })]
  app.api.getHistory = async (chatId, cursor) => cursor === 0 ? [message(20), message(30)] : cursor === 20 ? [message(10)] : []
  await app.loadHistory(10)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 25, 30])
  await app.loadHistory(10, true)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [10, 20, 25, 30])
  await app.loadHistory(10, true)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [5, 10, 20, 25, 30])
  assert.equal(app.store.historyDone.get(10), true)
})

test("saves the archive preference natively and discards stale preference responses after logout", async () => {
  const app = await ready()
  app.appendMessage(message(20))
  let seen
  app.api.setSaveDeleted = async (enabled, messages) => { seen = messages; return enabled }
  await app.setSaveDeleted(true)
  assert.equal(app.store.saveDeleted, true)
  assert.equal(seen[0].id, 20)
  const pending = deferred()
  app.api.setSaveDeleted = () => pending.promise
  const saving = app.setSaveDeleted(false)
  app.events().onAuthState({ stage: "logged_out", user: null })
  pending.resolve(false)
  await saving
  assert.equal(app.store.saveDeleted, true)
})

test("shares reply preview requests and discards their results after logout", async () => {
  const app = await ready()
  const pending = deferred()
  let requests = 0
  app.api.getMessage = () => { requests += 1; return pending.promise }
  const first = app.loadReplyPreview(10, 5)
  const second = app.loadReplyPreview(10, 5)
  assert.equal(requests, 1)
  pending.resolve(message(5))
  await Promise.all([first, second])
  assert.equal(app.replyPreview(10, 5).id, 5)
  const later = deferred()
  app.api.getMessage = () => later.promise
  const loading = app.loadReplyPreview(10, 6)
  app.events().onAuthState({ stage: "logged_out", user: null })
  later.resolve(message(6))
  await loading
  assert.equal(app.store.replyPreviews.size, 0)
})

test("updates reply snippets after edits and removes deleted snippets when archiving is disabled", async () => {
  const app = await ready()
  app.api.getMessage = async () => message(5)
  await app.loadReplyPreview(10, 5)
  app.updateMessageContent({ chat_id: 10, message_id: 5, content: { kind: "Text", data: { text: "Edited" } } })
  assert.equal(app.replyPreview(10, 5).content.data.text, "Edited")
  app.deleteMessages({ chat_id: 10, message_ids: [5] })
  assert.equal(app.replyPreview(10, 5), null)
})

test("loads reply context without mixing distant history and ignores an older in-flight page", async () => {
  const app = await ready()
  app.activateChat(10)
  app.appendMessage(message(100))
  const oldPage = deferred()
  app.api.getHistory = () => oldPage.promise
  const loading = app.loadHistory(10)
  app.api.messageContext = async () => [message(10), message(20), message(30)]
  await app.jumpToMessage(10, 20)
  oldPage.resolve([message(90), message(100)])
  await loading
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [10, 20, 30])
  assert.equal(app.store.jumpTarget.messageId, 20)
  assert.equal(app.store.historyAtLatest.get(10), false)
  app.appendMessage(message(101))
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [10, 20, 30])
  assert.equal(app.store.chats[0].last_message.id, 101)
  app.api.newerMessages = async () => [message(40), message(50)]
  await app.loadNewerHistory(10)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [10, 20, 30, 40, 50])
  assert.equal(app.store.historyAtLatest.get(10), false)
  app.api.getHistory = async () => [message(100), message(101)]
  await app.returnToLatest(10)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [100, 101])
  assert.equal(app.store.jumpTarget.messageId, 0)
})

test("opens external reply targets and leaves unavailable targets in the current conversation", async () => {
  const app = await ready()
  app.activateChat(10)
  app.api.getProfile = async () => ({ chat: chat(22) })
  app.api.messageContext = async () => [message(20, { chat_id: 22 })]
  await app.jumpToMessage(22, 20)
  assert.equal(app.store.activeChatId, 22)
  assert.equal(app.store.jumpTarget.chatId, 22)
  app.api.messageContext = async () => []
  await assert.rejects(app.jumpToMessage(10, 99), /недоступно/)
  assert.equal(app.store.activeChatId, 22)
})

test("displays live reactions, toggles the own reaction and rolls back only without a newer event", async () => {
  const app = await ready()
  const like = { key: "emoji:👍", emoji: "👍", custom_emoji_id: null, count: 2, chosen: false, can_list_senders: true,
    recent_senders: [2, 3].map((id) => ({ kind: "user", id, name: "Participant", photo: null, photo_file_id: null })) }
  app.appendMessage(message(20, { reactions: [like] }))
  let request
  app.api.setReaction = async (...args) => { request = args }
  await app.toggleReaction(message(20), like)
  assert.deepEqual(request, [10, 20, "emoji:👍", true])
  assert.equal(app.store.messages.get(10)[0].reactions[0].count, 3)
  assert.deepEqual(app.store.messages.get(10)[0].reactions[0].recent_senders.map((sender) => sender.id), [1, 2, 3])
  await app.toggleReaction(message(20), like)
  assert.deepEqual(request, [10, 20, "emoji:👍", false])
  const pending = deferred()
  app.api.setReaction = () => pending.promise
  const setting = app.toggleReaction(message(20), like)
  app.events().onMessageReactions({ chat_id: 10, message_id: 20, reactions: [{ ...like, count: 8, chosen: true }] })
  pending.reject(new Error("offline"))
  await assert.rejects(setting, /offline/)
  assert.equal(app.store.messages.get(10)[0].reactions[0].count, 8)
  app.api.setReaction = async () => { throw new Error("offline") }
  await assert.rejects(app.toggleReaction(message(20), like), /offline/)
  assert.equal(app.store.messages.get(10)[0].reactions[0].count, 8)
})

test("keeps reaction updates received before history and never sends paid reactions", async () => {
  const app = await ready()
  const custom = { key: "custom:9007199254740999", emoji: "", custom_emoji_id: "9007199254740999", count: 4, chosen: false }
  app.events().onMessageReactions({ chat_id: 10, message_id: 20, reactions: [custom] })
  app.api.getHistory = async () => [message(20)]
  await app.loadHistory(10)
  assert.equal(app.store.messages.get(10)[0].reactions[0].custom_emoji_id, "9007199254740999")
  app.openReactionMenu(app.store.messages.get(10)[0], custom, 20, 30)
  assert.equal(app.store.contextMenu.kind, "reaction")
  assert.equal(app.store.contextMenu.reaction.key, custom.key)
  app.deleteMessages({ chat_id: 10, message_ids: [20] })
  assert.equal(app.store.contextMenu, null)
  app.api.setReaction = async () => assert.fail("paid reaction must not be sent")
  await app.toggleReaction(message(20), { ...custom, key: "paid" })
})

test("can inspect a single private reaction without a sender list or while a toggle is pending", async () => {
  const app = await ready()
  const reaction = { key: "emoji:👍", emoji: "👍", custom_emoji_id: null, count: 1, chosen: false, can_list_senders: false }
  const current = message(20, { reactions: [reaction] })
  assert.deepEqual(app.recentReactionSenders(current, reaction).map((sender) => sender.id), [10])
  assert.deepEqual(app.recentReactionSenders(current, { ...reaction, chosen: true }).map((sender) => sender.id), [user.id])
  assert.deepEqual(app.recentReactionSenders({ ...current, chat_id: -10 }, reaction), [])
  const sender = { kind: "chat", id: -20, name: "Author", photo: null, photo_file_id: null }
  assert.deepEqual(app.recentReactionSenders(current, { ...reaction, recent_senders: [sender] }), [sender])
  app.store.reactionBusy.set("10:20", true)
  app.openReactionMenu(current, reaction, 25, 50)
  assert.equal(app.store.contextMenu.kind, "reaction")
  assert.equal(app.store.contextMenu.reaction.key, reaction.key)
})

test("suspends the interface without deleting the session and resumes from a fresh snapshot", async () => {
  const app = await ready()
  app.activateChat(10)
  app.appendMessage(message(20))
  app.updateDraft(10, { text: "keep me" })
  const suspended = { revision: 1, configured: false, kind: null, locked: false, remaining_attempts: 5, logout_pending: false, logged_out: false, session_suspended: true }
  app.applyAppLockStatus(suspended)
  assert.equal(app.store.stage, "wait_phone")
  assert.equal(app.store.chatsReady, false)
  assert.equal(app.store.user.id, 1)
  assert.equal(app.draftFor(10).text, "keep me")
  app.events().onAuthState({ stage: "ready", user })
  app.events().onChats(chatList())
  assert.equal(app.store.stage, "wait_phone")
  app.events().onMessage(message(21))
  app.events().onMessageContent({ chat_id: 10, message_id: 20, content: { kind: "Text", data: { text: "Changed while suspended" } } })
  app.applyAppLockStatus({ ...suspended, revision: 2, locked: true, configured: true, kind: "pin" })
  assert.equal(app.store.appLock.locked, true)
  app.applyAppLockStatus({ ...suspended, revision: 3, session_suspended: false })
  await Promise.resolve()
  assert.equal(app.store.stage, "ready")
  assert.equal(app.store.chatsReady, true)
  assert.equal(app.store.messages.get(10)[0].id, 20)
  assert.equal(app.store.messages.get(10)[0].content.data.text, "Changed while suspended")
  assert.equal(app.store.messages.get(10)[1].id, 21)
  assert.equal(app.draftFor(10).text, "keep me")
})

test("formats service notices with the actor and affected members", () => {
  const event = (action, members = [], text = "") => message(20, { sender: { kind: "user", id: 2, name: "Павел" }, content: { kind: "Event", data: { action, members, text, message_id: 0 } } })
  assert.equal(utilities.chatEventText(event("pin")), "Павел закрепил сообщение")
  assert.equal(utilities.chatEventText(event("add_members", [{ id: 3, name: "Борис" } ])), "Павел добавил Борис")
  assert.equal(utilities.chatEventText(event("add_members", [{ id: 2, name: "Павел" } ])), "Павел вступил в группу")
  assert.equal(utilities.chatEventText(event("remove_member", [{ id: 2, name: "Павел" } ])), "Павел вышел из группы")
  assert.equal(utilities.chatEventText(event("photo")), "Павел изменил фото группы")
})

test("finds mention queries at the caret without matching email addresses or the middle of a username", () => {
  const text = "Привет, @ann"
  assert.deepEqual(utilities.mentionQuery(text, text.length), { start: 8, end: 12, query: "ann" })
  assert.equal(utilities.mentionQuery("me@example.com", 5), null)
  assert.equal(utilities.mentionQuery("@alice", 3), null)
  assert.deepEqual(utilities.mentionQuery("😀 @Ан", 6), { start: 3, end: 6, query: "Ан" })
  assert.deepEqual(utilities.mentionQuery("(@", 2), { start: 1, end: 2, query: "" })
})

test("inserts a selected user and sends the mention with UTF-16 offsets after trimming", async () => {
  const app = await ready()
  app.updateDraft(10, { text: "  😀 @al" })
  const person = { ...user, id: 2, username: "alice", first_name: "Alice" }
  const draft = app.draftFor(10)
  const caret = app.insertMention(10, draft.text.indexOf("@"), draft.text.length, person)
  assert.equal(app.draftFor(10).text, "  😀 @alice ")
  assert.equal(caret, app.draftFor(10).text.length)
  let sent
  app.api.sendText = async (...args) => { sent = args; return message(20) }
  await app.sendDraft(10)
  assert.equal(sent[1], "😀 @alice")
  assert.deepEqual(sent[3], [{ kind: "user", user_id: 2, offset: 3, length: 6, value: "" }])
  assert.deepEqual(app.draftFor(10).entities, [])
})

test("keeps users without usernames mentionable and adjusts or drops their entities while editing", async () => {
  const app = await ready()
  app.updateDraft(10, { text: "@a" })
  app.insertMention(10, 0, 2, { ...user, id: 2, first_name: "Anna", last_name: "", username: "" })
  assert.equal(app.draftFor(10).text, "Anna ")
  app.updateDraft(10, { text: "😀 Anna " })
  assert.equal(app.draftFor(10).entities[0].offset, 3)
  app.updateDraft(10, { text: "😀 Anna !" })
  assert.equal(app.draftFor(10).entities[0].user_id, 2)
  app.updateDraft(10, { text: "😀 Ann !" })
  assert.deepEqual(app.draftFor(10).entities, [])
})

test("preserves mention entities in file and voice captions and restores them after cancelling edits", async () => {
  const app = await ready()
  const entity = { kind: "user", user_id: 2, offset: 0, length: 4, value: "" }
  const file = { path: "C:/file.pdf", file_name: "file.pdf", kind: "file", size: 10 }
  app.updateDraft(10, { text: "Anna", entities: [entity], attachment: file })
  let sent
  app.api.sendFile = async (...args) => { sent = args; return message(20) }
  await app.sendDraft(10)
  assert.deepEqual(sent.at(-1), [entity])
  app.updateDraft(10, { text: "Anna", entities: [entity], attachment: { ...file, kind: "voice" }, videoInfo: { width: 0, height: 0, duration: 2 } })
  app.api.sendVoice = async (...args) => { sent = args; return message(21) }
  await app.sendDraft(10)
  assert.deepEqual(sent.at(-1), [entity])
  app.activateChat(10)
  app.updateDraft(10, { text: "Anna draft", entities: [entity] })
  app.editMessage(message(30))
  assert.deepEqual(app.draftFor(10).entities, [])
  app.cancelEditing(10)
  assert.deepEqual(app.draftFor(10).entities, [entity])
})

test("read privacy comes from native settings and prevents read requests until disabled", async () => {
  const app = await ready({ initial: snapshot({ skip_read: true }) })
  let requests = 0
  app.api.viewMessages = async () => { requests += 1 }
  assert.equal(await app.markMessagesRead(10, [20]), false)
  assert.equal(requests, 0)
  app.api.setSkipRead = async (enabled) => enabled
  await app.setSkipRead(false)
  assert.equal(await app.markMessagesRead(10, [20]), true)
  assert.equal(requests, 1)
  app.api.viewMessages = async () => false
  assert.equal(await app.markMessagesRead(10, [20]), false)
  app.store.chatsReady = false
  assert.equal(await app.markMessagesRead(10, [21]), false)
  assert.equal(requests, 1)
})

test("keeps a message render key when the temporary sending ID is acknowledged or failed", async () => {
  const app = await ready()
  const pending = message(900, { sending_state: "pending", date: 20, is_outgoing: true })
  const sent = message(20, { is_outgoing: true })
  app.appendMessage(pending)
  const key = app.messageRenderKey(app.store.messages.get(10)[0])
  app.replaceMessage({ old_message_id: 900, message: sent })
  app.appendMessage(sent)
  assert.equal(app.store.messages.get(10).length, 1)
  assert.equal(app.messageRenderKey(app.store.messages.get(10)[0]), key)
  const other = message(901, { sending_state: "pending", date: 21, is_outgoing: true })
  app.appendMessage(other)
  const otherKey = app.messageRenderKey(other)
  app.replaceMessage({ old_message_id: 901, message: message(21, { sending_state: "failed", is_outgoing: true }) })
  assert.equal(app.messageRenderKey(app.store.messages.get(10).find((item) => item.id === 21)), otherKey)
})

test("retains the first rendered key when acknowledgements arrive before or after command responses", async () => {
  const app = await ready()
  const sent = message(20, { is_outgoing: true })
  app.replaceMessage({ old_message_id: 900, message: sent })
  const key = app.messageRenderKey(app.store.messages.get(10)[0])
  app.appendMessage(message(900, { sending_state: "pending", date: 20, is_outgoing: true }))
  assert.equal(app.messageRenderKey(app.store.messages.get(10)[0]), key)
  const second = message(21, { is_outgoing: true })
  app.appendMessage(second)
  const secondKey = app.messageRenderKey(second)
  app.replaceMessage({ old_message_id: 901, message: second })
  assert.equal(app.messageRenderKey(app.store.messages.get(10).find((item) => item.id === 21)), secondKey)
})

test("preserves inherited chat notification settings and applies chat overrides from Telegram", async () => {
  const group = { ...chat(), notification_scope: "group", notifications_muted: null }
  const channel = { ...chat(20), notification_scope: "channel", notifications_muted: true }
  const chats = [group, channel]
  const app = await ready({ initial: snapshot({ chats: chatList({ chats, muted_scopes: { group: true } }) }) })
  assert.equal(app.chatMuted(group), true)
  assert.equal(app.chatMuted(channel), true)

  const request = deferred()
  const calls = []
  app.api.setChatMuted = (id, muted) => {
    calls.push([id, muted])
    return request.promise
  }
  const updating = app.setChatMuted(group.id, false)
  await app.setChatMuted(group.id, false)
  assert.deepEqual(calls, [[group.id, false]])
  app.events().onChatNotifications({ chat_id: group.id, muted: false })
  request.resolve()
  await updating
  assert.equal(app.chatMuted(group), false)
  assert.equal(app.store.chatMutePending.has(group.id), false)

  app.events().onChatNotifications({ chat_id: group.id, muted: null })
  assert.equal(app.chatMuted(group), true)
  app.events().onChats(chatList({ chats, muted_scopes: { group: false } }))
  assert.equal(app.chatMuted(group), false)
  assert.equal(app.chatMuted(channel), true)
})

test("persists custom themes independently from account data and restores the Next wallpaper", async () => {
  const app = await ready()
  app.updateCustomization({ theme: "next", fontFamily: "Fixel Display", layout: "panels", fontSize: 16, bubbleRadius: 22, panelOpacity: 70, dynamicGlow: false })
  assert.match(app.customizationStyles(), /--chat-wallpaper:url\("\/themes\/next.png"\)/)
  assert.match(app.customizationStyles(), /--interface-font:"Fixel Display"/)
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.store.customization.theme, "next")
  app.store.customization = app.normalizeCustomization(null)
  app.restoreCustomization()
  assert.equal(app.store.customization.theme, "next")
  assert.equal(app.store.customization.fontFamily, "Fixel Display")
  assert.equal(app.store.customization.layout, "panels")
  assert.equal(app.store.customization.fontSize, 16)
  assert.equal(app.store.customization.bubbleRadius, 22)
  assert.equal(app.store.customization.dynamicGlow, false)
  app.resetCustomization()
  assert.equal(app.store.customization.theme, "default")
  assert.equal(app.store.customization.fontFamily, "Open Sans")
  assert.equal(app.store.customization.layout, "classic")
  assert.equal(app.store.customization.fontSize, 13)
  assert.equal(app.store.customization.bubbleRadius, 19)
  assert.equal(app.store.customization.panelOpacity, 78)
  assert.equal(app.store.customization.dynamicGlow, true)
})

test("reads app notification filters from the snapshot and saves only the selected change", async () => {
  const notifications = { enabled: true, private: false, group: true, channel: false, group_mentions: true }
  const app = await ready({ initial: snapshot({ notifications }) })
  assert.deepEqual(app.store.notifications, notifications)
  app.api.setNotifications = async (preferences) => ({ ...preferences })
  await app.setNotificationPreference("group_mentions", false)
  assert.deepEqual(app.store.notifications, { ...notifications, group_mentions: false })
  await app.setNotificationPreference("enabled", false)
  assert.deepEqual(app.store.notifications, { ...notifications, enabled: false, group_mentions: false })
})

test("shares voice playback and seek state across chats and releases it when music starts", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [chat(), chat(20)] }) }) })
  app.activateChat(10)
  app.store.files.set(7, "voice.ogg")
  app.playMusic(song(40))
  await app.playVoice(10, 20, 7, 35, 1.5)
  assert.equal(app.store.voice.path, "voice.ogg")
  assert.equal(app.store.voice.speed, 1.5)
  assert.equal(app.store.music.playing, false)
  app.activateChat(20)
  assert.equal(app.store.activeChatId, 20)
  assert.equal(app.store.voice.playing, true)
  app.seekVoice(75)
  assert.equal(app.store.voice.seekTo, 35)
  await app.playVoice(10, 20, 7, 35, 1.5)
  assert.equal(app.store.voice.playing, false)
  assert.equal(app.store.playingVoice, null)
  await app.playVoice(10, 20, 7, 35, 1.5)
  assert.equal(app.store.playingVoice, "10:20")
  app.playMusic(song(40))
  assert.equal(app.store.voice, null)
  assert.equal(app.store.music.playing, true)
})

test("ignores a voice download that completes after another voice has been selected", async () => {
  const app = await ready()
  const download = deferred()
  app.api.downloadFile = async () => download.promise
  const first = app.playVoice(10, 20, 7, 35, 1)
  app.store.files.set(8, "second.ogg")
  await app.playVoice(10, 21, 8, 20, 1)
  download.resolve({ local_path: "first.ogg" })
  await first
  assert.equal(app.store.playingVoice, "10:21")
  assert.equal(app.store.voice.path, "second.ogg")
  app.deleteMessages({ chat_id: 10, message_ids: [21] })
  assert.equal(app.store.voice, null)
  assert.equal(app.store.playingVoice, null)
})

test("validates custom colors, local image paths, and slider ranges before generating theme styles", async () => {
  const app = await ready()
  const normalized = app.normalizeCustomization({ theme: "unknown", accent: "red; color:red", background: "#ffffff", wallpaper: "javascript:alert(1)", fontFamily: "unknown", fontSize: 100, bubbleRadius: -5, panelOpacity: NaN, wallpaperOpacity: Infinity, softEdges: false })
  assert.equal(normalized.theme, "default")
  assert.equal(normalized.accent, "#347fff")
  assert.equal(normalized.wallpaper, null)
  assert.equal(normalized.fontFamily, "Open Sans")
  assert.equal(app.normalizeCustomization({ fontFamily: "Verdana" }).fontFamily, "Geist Sans")
  for (const fontFamily of ["Geist Mono", "Onest", "Consolas", "Courier New"]) {
    assert.equal(app.normalizeCustomization({ fontFamily }).fontFamily, fontFamily)
  }
  assert.equal(normalized.fontSize, 20)
  assert.equal(normalized.bubbleRadius, 8)
  assert.equal(normalized.panelOpacity, 78)
  assert.equal(normalized.wallpaperOpacity, 80)
  app.updateCustomization({ theme: "custom", background: "#ffffff", accent: "#ffdd44", wallpaper: "C:/theme/photo.png" })
  const styles = app.customizationStyles("asset://localhost/photo.png")
  assert.match(styles, /--text-primary:#152033/)
  assert.match(styles, /--text-on-accent:#101b2e/)
  assert.match(styles, /--chat-wallpaper:url\("asset:\/\/localhost\/photo.png"\)/)
  app.setEffects("reduced")
  assert.match(app.customizationStyles(), /--surface:rgba\([^)]*,1\)/)
})

test("preserves a saved custom palette when switching presets and seeds new custom edits from the active preset", async () => {
  const app = await ready()
  app.updateCustomization({ theme: "custom", accent: "#cc5588", background: "#160b12" })
  app.updateCustomization({ theme: "forest" })
  app.updateCustomization({ theme: "custom" })
  assert.equal(app.store.customization.accent, "#cc5588")
  app.updateCustomization({ theme: "forest" })
  app.updateCustomization({ theme: "custom", accent: "#3355ee" })
  assert.equal(app.store.customization.background, "#071310")
  assert.equal(app.store.customization.accent, "#3355ee")
})

const sticker = (id) => ({ file_id: id, set_id: "9007199254740999", width: 512, height: 512, emoji: "🙂", format: "webp", thumbnail_file_id: null })

test("shows more than 50 recent stickers and persists only supported recent counts", async () => {
  const app = await ready({ preferences: { "parugram:recent-sticker-limit": "100" } })
  app.api.stickerCatalog = async () => ({ recent: Array.from({ length: 120 }, (_, index) => sticker(index + 1)), sets: [] })
  await app.loadStickerCatalog()
  assert.equal(app.visibleRecentStickers().length, 100)
  app.setRecentStickerLimit(75)
  assert.equal(app.visibleRecentStickers().length, 75)
  assert.equal(app.values.get("parugram:recent-sticker-limit"), "75")
  app.setRecentStickerLimit(50)
  assert.equal(app.visibleRecentStickers().length, 50)
  app.setRecentStickerLimit(25)
  assert.equal(app.visibleRecentStickers().length, 25)
  app.setRecentStickerLimit(200)
  assert.equal(app.store.recentStickerLimit, 25)
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.values.get("parugram:recent-sticker-limit"), "25")
})

test("shares catalog requests and reloads when Telegram changes recents during a request", async () => {
  const app = await ready()
  const pending = deferred()
  let requests = 0
  app.api.stickerCatalog = () => { requests += 1; return requests === 1 ? pending.promise : Promise.resolve({ recent: [sticker(2)], sets: [] }) }
  const first = app.loadStickerCatalog()
  const second = app.loadStickerCatalog()
  assert.equal(requests, 1)
  app.events().onStickersChanged("recent")
  pending.resolve({ recent: [sticker(1)], sets: [] })
  await Promise.all([first, second])
  assert.equal(app.store.stickerCatalog.recent[0].file_id, 2)
  assert.equal(requests, 2)
  await app.loadStickerCatalog()
  assert.equal(requests, 2)
})

test("caches sticker sets with exact IDs and accepts updates from Telegram", async () => {
  const app = await ready()
  const id = "9007199254740999"
  let requests = 0
  app.api.stickerPack = async (setId) => { assert.equal(setId, id); requests += 1; return [sticker(1)] }
  await Promise.all([app.loadStickerPack(id), app.loadStickerPack(id)])
  assert.equal(requests, 1)
  app.events().onStickerPack({ id, stickers: [sticker(2)] })
  assert.equal(app.store.stickerPacks.get(id)[0].file_id, 2)
  await app.loadStickerPack(id)
  assert.equal(requests, 1)
  app.events().onStickersChanged("sets")
  await app.loadStickerPack(id)
  assert.equal(requests, 2)
})

test("sends stickers as replies while preserving text and attachments and preventing duplicate clicks", async () => {
  const app = await ready()
  const attachment = { path: "C:/photo.jpg", file_name: "photo.jpg", kind: "photo", size: 10 }
  app.updateDraft(10, { text: "Keep my text", attachment, reply: message(5) })
  app.store.stickerCatalog = { recent: [sticker(2), sticker(1)], sets: [] }
  const pending = deferred()
  let sent
  app.api.sendSticker = (...args) => { sent = args; return pending.promise }
  const sending = app.sendSticker(10, sticker(1))
  assert.equal(await app.sendSticker(10, sticker(1)), false)
  const result = message(20, { is_outgoing: true, content: { kind: "Sticker", data: sticker(1) } })
  pending.resolve(result)
  assert.equal(await sending, true)
  app.events().onMessage(result)
  assert.equal(sent[0], 10)
  assert.equal(sent[2], 5)
  assert.equal(app.store.messages.get(10).length, 1)
  assert.equal(app.draftFor(10).text, "Keep my text")
  assert.equal(app.draftFor(10).attachment.path, attachment.path)
  assert.equal(app.draftFor(10).reply, null)
  assert.deepEqual(app.store.stickerCatalog.recent.map((item) => item.file_id), [1, 2])
})

test("retains sticker drafts and reply targets on failure and ignores completed requests after logout", async () => {
  const app = await ready()
  app.updateDraft(10, { text: "Keep me", reply: message(5) })
  app.api.sendSticker = async () => { throw new Error("offline") }
  assert.equal(await app.sendSticker(10, sticker(1)), false)
  assert.equal(app.draftFor(10).text, "Keep me")
  assert.equal(app.draftFor(10).reply.id, 5)
  assert.match(app.store.composeErrors.get(10), /offline/)
  const pending = deferred()
  app.api.sendSticker = () => pending.promise
  const sending = app.sendSticker(10, sticker(1))
  app.events().onAuthState({ stage: "logged_out", user: null })
  pending.resolve(message(20, { content: { kind: "Sticker", data: sticker(1) } }))
  assert.equal(await sending, false)
  assert.equal(app.store.messages.size, 0)
  assert.equal(app.store.stickerCatalog, null)
})

test("drops sticker catalog and set responses from an account that has logged out", async () => {
  const app = await ready()
  const catalog = deferred()
  const pack = deferred()
  app.api.stickerCatalog = () => catalog.promise
  app.api.stickerPack = () => pack.promise
  const loading = Promise.all([app.loadStickerCatalog(), app.loadStickerPack("99")])
  app.events().onAuthState({ stage: "logged_out", user: null })
  catalog.resolve({ recent: [sticker(1)], sets: [] })
  pack.resolve([sticker(1)])
  await loading
  assert.equal(app.store.stickerCatalog, null)
  assert.equal(app.store.stickerPacks.size, 0)
})

test("keeps Next secondary labels neutral and preserves bubble blur preferences", async () => {
  const app = await ready()
  app.updateCustomization({ theme: "next", bubbleBlur: false })
  assert.match(app.customizationStyles(), /--text-secondary:#a0a5af/)
  assert.match(app.customizationStyles(), /--folder-active:#173f66/)
  const restored = await ready({ preferences: { "parugram:customization:v1": app.values.get("parugram:customization:v1") } })
  assert.equal(restored.store.customization.bubbleBlur, false)
  const sender = message(1).sender
  assert.equal(app.senderColor(sender), app.senderColor({ ...sender, name: "Renamed" }))
  assert.match(app.senderColor(sender), /^#[0-9a-f]{6}$/)
})

test("opens a split chat only at sufficient width and restores it after pinning stickers", async () => {
  const app = await ready()
  app.activateChat(10)
  app.store.viewportWidth = 1199
  assert.equal(app.openSplitChat(chat(20)), false)
  app.store.viewportWidth = 1400
  assert.equal(app.openSplitChat(chat(20)), true)
  assert.equal(app.store.activeChatId, 10)
  assert.equal(app.activeChat(20).id, 20)
  app.openStickerPanel(10)
  assert.equal(app.store.rightPanel.kind, "stickers")
  app.closeRightPanel()
  assert.deepEqual(app.store.rightPanel, { kind: "chat", key: 20 })
  app.store.viewportWidth = 740
  assert.equal(app.visibleRightPanel(), null)
  assert.equal(app.visibleChat(20), false)
  assert.equal(app.visibleChat(10), true)
  app.store.viewportWidth = 1400
  assert.deepEqual(app.visibleRightPanel(), { kind: "chat", key: 20 })
  app.closeRightPanel()
  assert.equal(app.store.rightPanel, null)
})

test("returns from a compact conversation to the chat list and reopens the selected chat", async () => {
  const app = await ready()
  app.store.viewportWidth = 320
  app.activateChat(10)
  app.openConversation(chat(20))
  app.goBackChat()
  assert.equal(app.store.showChatList, true)
  assert.equal(app.isConversationVisible(20), false)
  assert.equal(app.store.chatBackStack.length, 0)
  app.activateChat(10)
  assert.equal(app.store.showChatList, false)
  assert.equal(app.isConversationVisible(10), true)
})

test("starts a standalone chat from a shared session without loading the main chat list", async () => {
  const app = await setup({ initial: snapshot({ chats: chatList({ folder_id: -1 }) }) })
  app.store.chatWindowId = 20
  app.store.viewportWidth = 320
  await app.initStore()
  assert.equal(app.store.chatsReady, true)
  assert.equal(app.compactView(), false)
  assert.deepEqual(app.store.chats, [])
  app.openConversation(chat(20))
  app.appendMessage(message(1))
  app.appendMessage(message(2, { chat_id: 20 }))
  assert.equal(app.store.chatBackStack.length, 0)
  assert.equal(app.store.messages.has(10), false)
  assert.equal(app.store.messages.get(20)[0].id, 2)
})

test("routes comment history, drafts and live updates through their thread", async () => {
  const app = await ready()
  app.activateChat(10)
  app.api.messageThread = async () => ({ chat: chat(20), thread_id: 500, roots: [], reply_count: 2 })
  await app.openComments(message(50))
  const key = app.store.rightPanel.key
  const calls = []
  app.api.threadHistory = async (...args) => { calls.push(args); return [message(501, { chat_id: 20, thread_id: 500 })] }
  await app.loadHistory(key)
  assert.deepEqual(calls, [[20, 500, 0]])
  app.appendMessage(message(502, { chat_id: 20, thread_id: 600 }))
  app.appendMessage(message(503, { chat_id: 20, thread_id: 500 }))
  assert.deepEqual(app.store.messages.get(key).map((item) => item.id), [501, 503])
  app.updateDraft(key, { text: "Comment" })
  app.api.sendText = async (...args) => { calls.push(args); return message(504, { chat_id: 20, thread_id: 500, is_outgoing: true }) }
  await app.sendDraft(key)
  assert.deepEqual(calls[1], [20, "Comment", null, [], 500])
  assert.equal(app.store.activeChatId, 10)
  app.replyToMessage(app.store.messages.get(key)[0], key)
  app.deleteMessages({ chat_id: 20, message_ids: [501] })
  assert.equal(app.draftFor(key).reply, null)
})

test("coalesces chat subscriptions shared by a group and its comment thread", async () => {
  const app = await ready()
  app.store.conversations.set(-123, { chat: chat(10), threadId: 500 })
  const calls = []
  app.api.openChat = async (id) => calls.push(["open", id])
  app.api.closeChat = async (id) => calls.push(["close", id])
  await Promise.all([app.openChatFeed(10), app.openChatFeed(-123)])
  await app.closeChatFeed(10)
  assert.deepEqual(calls, [["open", 10]])
  await app.closeChatFeed(-123)
  assert.deepEqual(calls, [["open", 10], ["close", 10]])
})

test("counts new messages once and trims older history only after returning to the bottom", async () => {
  const app = await ready()
  app.store.messages.set(10, Array.from({ length: 150 }, (_, index) => message(index + 1)))
  app.store.atBottom.set(10, false)
  app.appendMessage(message(151))
  app.appendMessage(message(151))
  assert.equal(app.store.newMessageCounts.get(10), 1)
  app.trimHistory(10)
  assert.equal(app.store.messages.get(10).length, 151)
  app.store.atBottom.set(10, true)
  app.trimHistory(10)
  assert.equal(app.store.messages.get(10).length, 100)
  assert.equal(app.store.messages.get(10)[0].id, 52)
  app.store.historyLoaded.set(10, true)
  await app.returnToLatest(10)
  assert.equal(app.store.newMessageCounts.has(10), false)
  assert.equal(app.store.jumpTarget.messageId, 0)
})

test("resolves Telegram post links internally and preserves punctuation in plain text", async () => {
  const app = await ready()
  app.api.resolveTelegramLink = async () => ({ chat: chat(20), message_id: 42 })
  app.api.messageContext = async () => [message(42, { chat_id: 20 })]
  await app.openTelegramLink("https://t.me/example/42")
  assert.equal(app.store.activeChatId, 20)
  assert.equal(app.store.jumpTarget.messageId, 42)
  assert.deepEqual(utilities.textParts("See t.me/example/42!"), [{ text: "See " }, { text: "t.me/example/42", url: "https://t.me/example/42" }, { text: "!" }])
  assert.equal(utilities.isTelegramUrl("https://t.me.evil.com/example"), false)
  assert.equal(utilities.isTelegramUrl("tg://resolve?domain=example"), true)
})

test("releases inactive history after 15 seconds and cancels release when reopened", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  app.store.messages.set(20, [message(1, { chat_id: 20 })])
  app.store.historyLoaded.set(20, true)
  app.updateDraft(20, { text: "Keep this draft" })
  app.releaseHistory(20)
  context.mock.timers.tick(14999)
  assert.equal(app.store.messages.has(20), true)
  app.retainHistory(20)
  context.mock.timers.tick(1)
  assert.equal(app.store.messages.has(20), true)
  app.releaseHistory(20)
  context.mock.timers.tick(15000)
  assert.equal(app.store.messages.has(20), false)
  assert.equal(app.store.historyLoaded.has(20), false)
  assert.equal(app.draftFor(20).text, "Keep this draft")
  app.appendMessage(message(2, { chat_id: 20, is_outgoing: true, sending_state: "failed" }))
  app.appendMessage(message(3, { chat_id: 20 }))
  context.mock.timers.tick(15000)
  assert.deepEqual(app.store.messages.get(20).map(({ id }) => id), [2])
})

test("ignores comments resolved after a newer right panel action", async () => {
  const app = await ready()
  const pending = deferred()
  app.api.messageThread = () => pending.promise
  const request = app.openComments(message(1))
  app.openStickerPanel(10)
  pending.resolve({ chat: chat(20), thread_id: 500, roots: [], reply_count: 2 })
  await request
  assert.deepEqual(app.store.rightPanel, { kind: "stickers", key: 10 })
})

test("opens Telegram MP4 and image GIF animations with their correct viewer type", async () => {
  const app = await ready()
  const animation = { file_id: 44, width: 320, height: 240, duration: 3, file_name: "animation.mp4", mime_type: "video/mp4", caption: "GIF caption", entities: [] }
  const mp4 = message(44, { content: { kind: "Animation", data: animation } })
  const gif = message(45, { content: { kind: "Animation", data: { ...animation, file_name: "animation.gif", mime_type: "image/gif" } } })
  app.openMediaViewer(mp4, [mp4, gif])
  assert.deepEqual(app.store.mediaViewer.items.map((item) => item.kind), ["video", "photo"])
  assert.equal(utilities.messagePreview(mp4.content), "GIF")
  assert.equal(app.store.mediaViewer.items[0].caption, "GIF caption")
})

test("bounds and expires new background history without truncating an open conversation", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  app.activateChat(10)
  for (let id = 1; id <= 130; id += 1) {
    app.appendMessage(message(id))
    app.appendMessage(message(id, { chat_id: 20 }))
  }
  assert.equal(app.store.messages.get(10).length, 130)
  assert.equal(app.store.messages.get(20).length, 100)
  assert.equal(app.store.messages.get(20)[0].id, 31)
  context.mock.timers.tick(14999)
  app.appendMessage(message(131, { chat_id: 20 }))
  context.mock.timers.tick(1)
  assert.equal(app.store.messages.has(20), false)
  assert.equal(app.store.messages.get(10).length, 130)
})

test("opens unread history at the read boundary and blocks receipts until scrolling resumes reading", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), unread_count: 3, last_read_inbox_message_id: 90 }] }) }) })
  app.store.messages.set(10, [message(1), message(1000)])
  app.store.historyLoaded.set(10, true)
  app.store.historyDone.set(10, true)
  const calls = []
  app.api.messageContext = async (...args) => { calls.push(args); return [message(89), message(90), message(91), message(92)] }
  app.api.viewMessages = async (...args) => calls.push(args)
  const position = await app.prepareHistory(10)
  assert.deepEqual(position, { unreadCount: 3, readThrough: 90, positioned: true })
  assert.deepEqual(calls, [[10, 90, false]])
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [89, 90, 91, 92])
  assert.equal(app.store.historyAtLatest.get(10), false)
  assert.equal(await app.markMessagesRead(10, [91, 92]), false)
  assert.equal(calls.length, 1)
  app.resumeReading(10)
  assert.equal(await app.markMessagesRead(10, [91, 92]), true)
  assert.deepEqual(calls[1], [10, [91, 92]])
  assert.equal(app.store.newMessageCounts.get(10), 1)
  await app.markMessagesRead(10, [92])
  assert.equal(app.store.newMessageCounts.get(10), 1)
})

test("uses the comment thread read boundary instead of the discussion group boundary", async () => {
  const app = await ready()
  app.api.messageThread = async () => ({ chat: { ...chat(20), unread_count: 500, last_read_inbox_message_id: 9000 }, thread_id: 500, roots: [], reply_count: 20, unread_count: 15, last_read_inbox_message_id: 600 })
  await app.openComments(message(50))
  const key = app.store.rightPanel.key
  const calls = []
  app.api.threadHistory = async (...args) => { calls.push(args); return [599, 600, 601, 602].map((id) => message(id, { chat_id: 20, thread_id: 500 })) }
  app.api.viewMessages = async (...args) => calls.push(args)
  const position = await app.prepareHistory(key)
  assert.equal(position.readThrough, 600)
  assert.deepEqual(calls, [[20, 500, 600, "around"]])
  assert.equal(await app.markMessagesRead(key, [601]), false)
  app.resumeReading(key)
  assert.equal(await app.markMessagesRead(key, [601]), true)
  assert.deepEqual(calls[1], [20, [601]])
  assert.equal(app.store.conversations.get(key).lastReadInboxMessageId, 601)
  assert.equal(app.store.conversations.get(key).unreadCount, 14)
})

test("opens the beginning when no message has been read and keeps empty anchors optional", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), unread_count: 2, last_read_inbox_message_id: 0 }] }) }) })
  const calls = []
  app.api.messageContext = async (...args) => { calls.push(args); return [message(10), message(11)] }
  const position = await app.prepareHistory(10)
  assert.deepEqual(calls, [[10, 1, false]])
  assert.equal(position.readThrough, 0)
  assert.equal(app.store.readPaused.get(10), true)
})

test("keeps normal live reading for chats without unread history", async () => {
  const app = await ready()
  app.api.getHistory = async () => [message(10)]
  const position = await app.prepareHistory(10)
  assert.equal(position.unreadCount, 0)
  assert.equal(app.store.readPaused.has(10), false)
  app.api.viewMessages = async () => true
  assert.equal(await app.markMessagesRead(10, [10]), true)
})

test("does not resume reading in a new session after an old history request completes", async () => {
  const app = await ready()
  const pending = deferred()
  app.api.getHistory = () => pending.promise
  const request = app.prepareHistory(10)
  app.events().onAuthState({ stage: "logged_out", user: null })
  app.store.readPaused.set(10, true)
  pending.resolve([message(10)])
  const position = await request
  assert.equal(position.positioned, false)
  assert.equal(app.store.readPaused.get(10), true)
  assert.equal(app.store.messages.has(10), false)
})

test("does not unlock a reopened unread chat when its previous history request completes", async () => {
  const app = await ready()
  const pending = deferred()
  app.api.getHistory = () => pending.promise
  const oldRequest = app.prepareHistory(10)
  app.store.chats[0].unread_count = 2
  app.store.chats[0].last_read_inbox_message_id = 90
  app.api.messageContext = async () => [message(90), message(91)]
  await app.prepareHistory(10)
  pending.resolve([message(999)])
  const oldPosition = await oldRequest
  assert.equal(oldPosition.positioned, false)
  assert.equal(app.store.readPaused.get(10), true)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [90, 91])
})

test("waits for chat synchronization after unlocking before preparing the conversation", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ ready: false }) }) })
  const calls = []
  app.api.getHistory = async (...args) => { calls.push(args); return [message(10), message(20)] }
  assert.equal(await app.prepareHistory(10), null)
  assert.equal(app.store.historyLoaded.has(10), false)
  app.events().onChats(chatList())
  const position = await app.prepareHistory(10)
  assert.equal(position.positioned, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [10, 20])
})

test("falls back from an empty unread window without losing history or enabling receipts", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), unread_count: 2, last_read_inbox_message_id: 90, last_message: message(100) }] }) }) })
  const calls = []
  app.api.messageContext = async () => []
  app.api.getHistory = async (...args) => { calls.push(args); return [message(80), message(90), message(100)] }
  await app.prepareHistory(10)
  assert.deepEqual(calls, [[10, 0, 50]])
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [80, 90, 100])
  assert.notEqual(app.store.historyDone.get(10), true)
  assert.equal(app.store.readPaused.get(10), true)
})

test("retries an empty initial page when the chat is known to have messages", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), last_message: message(30) }] }) }) })
  let calls = 0
  app.api.getHistory = async () => ++calls === 1 ? [] : [message(20), message(30)]
  app.appendMessage(message(31))
  await app.prepareHistory(10)
  assert.equal(calls, 2)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 30, 31])
  assert.notEqual(app.store.historyDone.get(10), true)
})

test("keeps a failed cold history load retryable instead of treating live messages as complete history", async () => {
  const app = await ready({ initial: snapshot({ chats: chatList({ chats: [{ ...chat(), last_message: message(30) }] }) }) })
  app.appendMessage(message(31))
  app.api.getHistory = async () => []
  await assert.rejects(app.prepareHistory(10), /Не удалось загрузить историю/)
  assert.notEqual(app.store.historyLoaded.get(10), true)
  assert.notEqual(app.store.historyDone.get(10), true)
  assert.equal(app.store.readPaused.get(10), true)
  app.api.getHistory = async () => [message(20), message(30)]
  await app.prepareHistory(10)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 30, 31])
  assert.equal(app.store.historyError.has(10), false)
})

test("recovers an empty comment window through thread history while keeping reading paused", async () => {
  const app = await ready()
  app.api.messageThread = async () => ({ chat: chat(20), thread_id: 500, roots: [], reply_count: 2, unread_count: 1, last_read_inbox_message_id: 500 })
  await app.openComments(message(50))
  const key = app.store.rightPanel.key
  const calls = []
  app.api.threadHistory = async (...args) => {
    calls.push(args)
    return calls.length === 1 ? [] : [message(500, { chat_id: 20, thread_id: 500 }), message(501, { chat_id: 20, thread_id: 500 })]
  }
  await app.prepareHistory(key)
  assert.deepEqual(calls, [[20, 500, 500, "around"], [20, 500, 0]])
  assert.equal(app.store.messages.get(key).length, 2)
  assert.equal(app.store.readPaused.get(key), true)
  assert.notEqual(app.store.historyDone.get(key), true)
})

test("does not close pagination after an empty cold start without last-message metadata", async () => {
  const app = await ready()
  app.api.getHistory = async () => []
  await app.prepareHistory(10)
  assert.notEqual(app.store.historyDone.get(10), true)
  app.appendMessage(message(31))
  app.api.getHistory = async () => [message(20), message(30)]
  await app.loadHistory(10, true)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 30, 31])
})

test("reloads a conversation whose only cached messages came from live events after an empty load", async () => {
  const app = await ready()
  app.store.historyLoaded.set(10, true)
  app.store.historyDone.set(10, true)
  app.appendMessage(message(31))
  const calls = []
  app.api.getHistory = async (...args) => { calls.push(args); return [message(20), message(30)] }
  await app.prepareHistory(10)
  assert.deepEqual(calls, [[10, 0, 50]])
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 30, 31])
  assert.notEqual(app.store.historyDone.get(10), true)
})

test("recognizes music metadata and common audio documents without treating other files as songs", async () => {
  const app = await ready()
  assert.equal(app.musicTrack(song(20)).title, "Track 20")
  assert.equal(app.musicTrack(song(20)).performer, "Artist")
  assert.equal(app.musicTrack(song(20)).coverFileId, 120)
  assert.equal(app.musicTrack(message(30, { content: { kind: "File", data: { file_id: 30, file_name: "Concert.FLAC", size: 4096, caption: "" } } })).title, "Concert.FLAC")
  assert.equal(app.musicTrack(message(31, { content: { kind: "File", data: { file_id: 31, file_name: "notes.pdf", size: 4096, caption: "" } } })), null)
  assert.equal(app.musicTrack(song(32, { is_deleted: true })), null)
  assert.equal(utilities.messagePreview(song(20).content), "Track 20")
})

test("starts a unique music queue, pauses voices and preserves playback while navigating chats", async () => {
  const app = await ready()
  app.store.playingVoice = "10:99"
  app.store.messages.set(10, [song(30), song(10), song(20), song(20), message(40)])
  app.playMusic(song(20))
  assert.deepEqual(app.store.music.queue.map((track) => track.messageId), [10, 20, 30])
  assert.equal(app.store.playingVoice, null)
  app.store.music.position = 45
  app.playMusic(song(20))
  assert.equal(app.store.music.playing, false)
  assert.equal(app.store.music.position, 45)
  app.playMusic(song(20))
  app.activateChat(30)
  assert.equal(app.store.music.playing, true)
  assert.equal(app.store.music.track.messageId, 20)
})

test("advances music, restarts the current track and implements repeat modes", async () => {
  const app = await ready()
  app.playMusic(song(10), [song(10), song(20)])
  assert.equal(app.stepMusic(1), true)
  assert.equal(app.store.music.track.messageId, 20)
  app.store.music.position = 30
  app.stepMusic(-1)
  assert.equal(app.store.music.track.messageId, 20)
  assert.equal(app.store.music.position, 0)
  app.store.musicRepeat = "one"
  app.stepMusic(1, true)
  assert.equal(app.store.music.track.messageId, 20)
  app.store.musicRepeat = "all"
  app.stepMusic(1, true)
  assert.equal(app.store.music.track.messageId, 10)
  app.store.musicRepeat = "off"
  app.stepMusic(1)
  assert.equal(app.stepMusic(1, true), false)
  assert.equal(app.store.music.playing, false)
})

test("shuffles without repeating tracks and restores chronological order when disabled", async () => {
  const app = await ready()
  app.playMusic(song(20), [song(10), song(20), song(30), song(40)])
  app.setMusicShuffle(true)
  assert.equal(app.store.music.queue[0].messageId, 20)
  const played = [app.store.music.track.key]
  while (app.stepMusic(1)) played.push(app.store.music.track.key)
  assert.equal(played.length, 4)
  assert.equal(new Set(played).size, 4)
  const selected = app.store.music.track.key
  app.setMusicShuffle(false)
  assert.deepEqual(app.store.music.queue.map((track) => track.messageId), [10, 20, 30, 40])
  assert.equal(app.store.music.track.key, selected)
})

test("removes deleted tracks and clears music and pinned revisions when leaving the account", async () => {
  const app = await ready()
  app.playMusic(song(10), [song(10), song(20)])
  app.deleteMessages({ chat_id: 10, message_ids: [20] })
  assert.equal(app.store.music.queue.length, 1)
  app.deleteMessages({ chat_id: 10, message_ids: [10] })
  assert.equal(app.store.music, null)
  app.playMusic(song(30))
  app.events().onPinnedMessagesChanged(10)
  app.events().onAuthState({ stage: "logged_out", user: null })
  assert.equal(app.store.music, null)
  assert.equal(app.store.pinnedRevisions.size, 0)
})

test("keeps music through photo viewing and pauses it for video playback", async () => {
  const app = await ready()
  app.playMusic(song(20))
  app.openMediaItems([{ key: "10:30", kind: "photo", file_id: 30, caption: "", file_name: "Photo" }])
  assert.equal(app.store.music.playing, true)
  app.openMediaItems([{ key: "10:40", kind: "video", file_id: 40, caption: "", file_name: "Video" }])
  assert.equal(app.store.music.playing, false)
})

test("updates cached pinned previews after edits and invalidates them after deletion", async () => {
  const app = await ready()
  app.store.replyPreviews.set("10:20", message(20))
  app.events().onPinnedMessagesChanged(10)
  assert.equal(app.store.pinnedRevisions.get(10), 1)
  app.events().onMessageContent({ chat_id: 10, message_id: 20, content: { kind: "Text", data: { text: "Edited pin" } } })
  assert.equal(app.replyPreview(10, 20).content.data.text, "Edited pin")
  app.deleteMessages({ chat_id: 10, message_ids: [20] })
  assert.equal(app.store.pinnedRevisions.get(10), 2)
  assert.equal(app.replyPreview(10, 20), null)
})

test("retries a timed out history request and ignores its late response", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  const stalled = deferred()
  let calls = 0
  app.api.getHistory = () => ++calls === 1 ? stalled.promise : Promise.resolve([message(20)])
  const request = app.loadHistory(10)
  context.mock.timers.tick(12000)
  await request
  assert.equal(calls, 2)
  assert.equal(app.store.historyLoading.get(10), false)
  stalled.resolve([message(1)])
  await Promise.resolve()
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20])
})

test("releases history loading after both timeout attempts and allows a later retry", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  let calls = 0
  app.api.getHistory = () => { calls += 1; return new Promise(() => {}) }
  const request = app.loadHistory(10)
  const failed = assert.rejects(request, /Не удалось дождаться сообщений/)
  context.mock.timers.tick(12000)
  await Promise.resolve()
  await Promise.resolve()
  context.mock.timers.tick(12000)
  await failed
  assert.equal(calls, 2)
  assert.equal(app.store.historyLoading.get(10), false)
  app.api.getHistory = async () => [message(30)]
  await app.loadHistory(10)
  assert.equal(app.store.historyError.has(10), false)
  assert.equal(app.store.messages.get(10)[0].id, 30)
})

test("does not retry timed out messages after logout or retry server rejections", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  let calls = 0
  const pending = app.requestMessages(() => { calls += 1; return new Promise(() => {}) })
  const failed = assert.rejects(pending, /Не удалось дождаться сообщений/)
  app.events().onAuthState({ stage: "logged_out", user: null })
  context.mock.timers.tick(12000)
  await failed
  assert.equal(calls, 1)
  const fresh = await ready()
  let rejected = 0
  await assert.rejects(fresh.requestMessages(async () => { rejected += 1; throw new Error("Access denied") }), /Access denied/)
  assert.equal(rejected, 1)
})

test("retries a stalled request for newer messages and clears its previous error", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  const app = await ready()
  app.store.messages.set(10, [message(20)])
  app.store.historyAtLatest.set(10, false)
  app.store.historyError.set(10, "Previous timeout")
  const calls = []
  app.api.newerMessages = (...args) => {
    calls.push(args)
    return calls.length === 1 ? new Promise(() => {}) : Promise.resolve([message(21)])
  }
  const request = app.loadNewerHistory(10)
  context.mock.timers.tick(12000)
  await request
  assert.deepEqual(calls, [[10, 20], [10, 20]])
  assert.equal(app.store.historyError.has(10), false)
  assert.deepEqual(app.store.messages.get(10).map((item) => item.id), [20, 21])
})
