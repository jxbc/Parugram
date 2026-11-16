<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import Avatar from "$lib/components/Avatar.svelte"
  import StickerPicker from "./StickerPicker.svelte"
  import type { ComposerStatus, UserPayload } from "$lib/api/td"
  import Paperclip from "@lucide/svelte/icons/paperclip"
  import { onDestroy, onMount, tick } from "svelte"
  import { open } from "@tauri-apps/plugin-dialog"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import encoderPath from "opus-recorder/dist/encoderWorker.min.js?url"
  import { store, api, activeChat, draftFor, updateDraft, stageAttachment, removeAttachment, sendDraft, messageSender, cancelEditing, insertMention, conversationTarget, openStickerPanel, openMediaItems } from "$lib/stores/app.svelte"
  import { formatFileSize, formatDuration, messagePreview, mentionQuery, releaseMedia } from "$lib/utils"

  let { chatId }: { chatId: number } = $props()
  let input: HTMLTextAreaElement | undefined = $state()
  let stickerControl: HTMLDivElement | undefined = $state()
  let stickersOpen = $state(false)
  let stickerHoverTimer: ReturnType<typeof setTimeout> | undefined
  let statusControl: HTMLDivElement | undefined = $state()
  let statusButton: HTMLButtonElement | undefined = $state()
  let statusOpen = $state(false)
  let manualStatus = $state<ComposerStatus | null>(null)
  let statusError = $state("")
  let statusTimer: ReturnType<typeof setInterval> | undefined
  let statusRequest: Promise<void> | undefined
  let lastTyping = 0
  let typingActive = $state(false)
  const statuses: { action: ComposerStatus; label: string }[] = [
    { action: "typing", label: "Набор текста" },
    { action: "uploading_file", label: "Отправка файла" },
    { action: "uploading_photo", label: "Отправка фото" },
    { action: "uploading_video", label: "Отправка видео" },
    { action: "recording_voice", label: "Запись голосового" },
    { action: "recording_video_note", label: "Запись кружка" },
    { action: "choosing_sticker", label: "Выбор стикера" },
  ]
  const stickerPinned = $derived(store.rightPanel?.kind === "stickers" && store.rightPanel.key === chatId)
  const target = $derived(conversationTarget(chatId))
  let choosing = $state(false)
  let attachmentError = $state("")
  let failedPreview = $state<string | null>(null)
  let recording = $state(false)
  let recordingStarting = $state(false)
  let seconds = $state(0)
  let recorder: import("opus-recorder").default | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let discarded = false
  let disposed = false
  let caret = $state(0)
  let mentionOptions = $state<UserPayload[]>([])
  let mentionIndex = $state(0)
  let mentionLoading = $state(false)
  let mentionError = $state("")
  let dismissedMention = $state("")
  const draft = $derived(draftFor(chatId))
  const mention = $derived(activeChat(chatId)?.is_group && !recording ? mentionQuery(draft.text, caret) : null)
  const mentionKey = $derived(mention ? `${mention.start}:${mention.end}:${mention.query}` : "")
  const mentionOpen = $derived(!!mention && mentionKey !== dismissedMention && store.chatsReady && !stickersOpen && !statusOpen)

  $effect(() => {
    if (!store.chatsReady || draft.editing || recording || recordingStarting || choosing || store.profileTarget || store.contextMenu || store.focusedMessage || store.mediaViewer) stickersOpen = false
    if (!store.chatsReady || !store.windowVisible || sending || recording || draft.editing) {
      statusOpen = false
      if (manualStatus || typingActive) stopStatus()
    } else if (store.chatPrivacy.hide_typing && typingActive) stopStatus()
  })

  function closeStickers() {
    stickersOpen = false
    void tick().then(() => input?.focus())
  }

  function toggleStickers() {
    statusOpen = false
    stickersOpen = false
    openStickerPanel(chatId)
  }

  function hoverStickers() {
    clearTimeout(stickerHoverTimer)
    if (!statusOpen && !stickerPinned && !sending && !choosing && !recording && !draft.editing && store.chatsReady) stickersOpen = true
  }

  function leaveStickers() {
    clearTimeout(stickerHoverTimer)
    stickerHoverTimer = setTimeout(() => stickersOpen = false, 180)
  }

  function closePopoversOutside(event: PointerEvent) {
    if (!(event.target instanceof Node)) return
    if (stickersOpen && !stickerControl?.contains(event.target)) stickersOpen = false
    if (statusOpen && !statusControl?.contains(event.target)) statusOpen = false
  }

  function popoverKeys(event: KeyboardEvent) {
    if (event.key !== "Escape" || event.defaultPrevented) return
    if (statusOpen) {
      event.preventDefault()
      statusOpen = false
      statusButton?.focus()
    } else if (stickersOpen) {
      event.preventDefault()
      closeStickers()
    }
  }

  function stopStatus() {
    const active = manualStatus || typingActive
    const { chatId: destination, threadId } = target
    clearInterval(statusTimer)
    manualStatus = null
    typingActive = false
    lastTyping = 0
    if (active) {
      const cancel = () => api.sendChatAction(destination, threadId, "cancel", true).catch(() => {})
      const pending = statusRequest ? statusRequest.then(cancel, cancel) : cancel()
      trackStatus(pending)
    }
  }

  function trackStatus(pending: Promise<void>) {
    statusRequest = pending
    const clear = () => { if (statusRequest === pending) statusRequest = undefined }
    void pending.then(clear, clear)
  }

  function sendStatus(action: ComposerStatus, manual: boolean) {
    if (statusRequest) return
    trackStatus(api.sendChatAction(target.chatId, target.threadId, action, manual).catch(() => {
      if (disposed || !manual || manualStatus !== action) return
      clearInterval(statusTimer)
      manualStatus = null
      statusError = "Не удалось отправить статус"
      statusOpen = true
    }))
  }

  function selectStatus(action: ComposerStatus) {
    statusError = ""
    if (manualStatus === action) {
      stopStatus()
      return
    }
    clearInterval(statusTimer)
    typingActive = false
    manualStatus = action
    const send = () => { if (!disposed && manualStatus === action) sendStatus(action, true) }
    if (statusRequest) void statusRequest.then(send, send)
    else send()
    statusTimer = setInterval(send, 4000)
  }

  $effect(() => {
    const query = mention
    const account = store.user?.id
    mentionOptions = []
    mentionIndex = 0
    mentionError = ""
    mentionLoading = false
    if (!query || !mentionOpen) return
    let cancelled = false
    mentionLoading = true
    const timeout = setTimeout(() => {
      void api.mentionMembers(target.chatId, query.query).then((users) => {
        if (!cancelled && store.user?.id === account) mentionOptions = users
      }).catch(() => { if (!cancelled) mentionError = "Не удалось найти участников" })
        .finally(() => { if (!cancelled) mentionLoading = false })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  })

  function updateCaret() { if (input) caret = input.selectionStart }

  function chooseMention(user: UserPayload) {
    if (!mention) return
    const position = insertMention(chatId, mention.start, mention.end, user)
    dismissedMention = mentionKey
    void tick().then(() => {
      input?.focus()
      if (position !== null) input?.setSelectionRange(position, position)
      updateCaret()
    })
  }

  function inputKeys(event: KeyboardEvent) {
    if (event.isComposing) return
    if (mentionOpen) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        dismissedMention = mentionKey
        return
      }
      if (mentionOptions.length && ["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key) && !(event.key === "Enter" && event.shiftKey)) {
        event.preventDefault()
        if (event.key === "Enter" || event.key === "Tab") chooseMention(mentionOptions[mentionIndex])
        else {
          mentionIndex = (mentionIndex + (event.key === "ArrowUp" ? -1 : 1) + mentionOptions.length) % mentionOptions.length
          document.getElementById(`mention-${chatId}-${mentionIndex}`)?.scrollIntoView({ block: "nearest" })
        }
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      if (!choosing && !recording && !recordingStarting) void sendDraft(chatId)
    }
  }
  const sending = $derived(store.sendingChats.get(chatId) ?? false)
  const error = $derived(attachmentError || store.composeErrors.get(chatId))
  const attachment = $derived(draft.attachment)
  const preview = $derived(attachment && attachment.kind !== "file" ? convertFileSrc(attachment.path) : null)

  function previewAttachment() {
    if (attachment?.kind !== "photo" && attachment?.kind !== "video") return
    openMediaItems([{ key: `draft:${attachment.path}`, kind: attachment.kind, file_id: 0, local_path: attachment.path, caption: draft.text, file_name: attachment.file_name }])
  }
  const reference = $derived(draft.editing ?? draft.reply)
  const canSend = $derived(!!draft.text.trim() || !!attachment || !!draft.editing && draft.editing.content.kind !== "Text")

  function cancelRecording() {
    discarded = true
    clearInterval(timer)
    recording = false
    recordingStarting = false
    choosing = false
    const current = recorder
    recorder = null
    if (current) void current.close().catch(() => {})
  }

  onDestroy(() => {
    disposed = true
    clearTimeout(stickerHoverTimer)
    stopStatus()
    cancelRecording()
  })

  function stopRecording() {
    if (!recorder || !recording || choosing) return
    choosing = true
    void recorder.stop().catch(() => {
      if (!disposed) {
        cancelRecording()
        attachmentError = "Не удалось завершить запись"
      }
    })
  }

  async function startRecording() {
    if (recordingStarting || recording || choosing || sending || !store.chatsReady || draft.editing) return
    const accountId = store.user?.id
    const destination = chatId
    recordingStarting = true
    attachmentError = ""
    discarded = false
    try {
      const { default: Recorder } = await import("opus-recorder")
      if (disposed || discarded) return
      const current = new Recorder({
        encoderPath, numberOfChannels: 1, encoderApplication: 2048,
        encoderSampleRate: 48000, encoderBitRate: 32000,
        mediaTrackConstraints: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      recorder = current
      current.onstop = () => {
        clearInterval(timer)
        recording = false
      }
      current.ondataavailable = (data) => {
        const duration = Math.max(1, seconds)
        if (discarded || disposed || store.user?.id !== accountId) return
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data)
        void stageAttachment(destination, new Blob([bytes], { type: "audio/ogg" }), "voice", duration)
          .catch((failure) => { if (!disposed) attachmentError = String(failure) })
          .finally(() => {
            if (!disposed) choosing = false
            if (recorder === current) recorder = null
            void current.close().catch(() => {})
          })
      }
      await current.start()
      if (disposed || discarded || store.user?.id !== accountId) {
        void current.close().catch(() => {})
        return
      }
      seconds = 0
      recording = true
      const started = Date.now()
      timer = setInterval(() => seconds = Math.floor((Date.now() - started) / 1000), 250)
    } catch (failure) {
      if (!disposed) {
        cancelRecording()
        attachmentError = failure instanceof Error && failure.name === "NotAllowedError" ? "Нет доступа к микрофону" : "Не удалось начать запись"
      }
    } finally {
      if (!disposed) recordingStarting = false
    }
  }

  async function paste(event: ClipboardEvent) {
    if (event.defaultPrevented || store.profileTarget || store.focusedMessage || store.contextMenu || store.mediaViewer || document.querySelector("dialog[open]")) return
    if ((store.focusedConversation ?? store.activeChatId) !== chatId) return
    const target = event.target
    if (target instanceof HTMLElement && target !== input && target.closest("input,textarea,[contenteditable]")) return
    const file = [...(event.clipboardData?.items ?? [])].find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile()
    if (!file) return
    event.preventDefault()
    if (choosing || sending || recording || recordingStarting || draft.editing || !store.chatsReady) return
    if (file.size > 20 * 1024 * 1024) {
      attachmentError = "Фото должно быть не больше 20 МБ"
      return
    }
    choosing = true
    attachmentError = ""
    try {
      await stageAttachment(chatId, file)
      input?.focus()
    } catch (failure) {
      attachmentError = String(failure)
    } finally {
      choosing = false
    }
  }

  function primaryAction() {
    if (recording) stopRecording()
    else if (canSend) void sendDraft(chatId)
    else void startRecording()
  }

  function resizeInput() {
    if (!input) return
    input.style.height = "32px"
    if (input.value) input.style.height = `${Math.max(32, Math.min(input.scrollHeight, 150))}px`
  }

  onMount(() => {
    if (!input) return
    let width = 0
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      resizeInput()
    })
    observer.observe(input)
    return () => observer.disconnect()
  })

  $effect(() => {
    void draft.text
    void tick().then(resizeInput)
  })

  $effect(() => {
    void store.composeFocus
    if (store.composeFocusChatId === chatId) void tick().then(() => input?.focus())
  })

  async function attach() {
    if (choosing || sending || recording || recordingStarting || draft.editing || !store.chatsReady) return
    const accountId = store.user?.id
    choosing = true
    attachmentError = ""
    try {
      const path = await open({ multiple: false })
      if (!path || typeof path !== "string" || store.user?.id !== accountId || !store.chatsReady) return
      await stageAttachment(chatId, path)
      input?.focus()
    } catch (failure) {
      attachmentError = String(failure)
    } finally {
      choosing = false
    }
  }

  function updateText(event: Event) {
    const text = (event.currentTarget as HTMLTextAreaElement).value
    updateDraft(chatId, { text })
    if (!manualStatus && !store.chatPrivacy.hide_typing && store.chatsReady && !draft.editing && !attachment) {
      if (!text.trim() && typingActive) stopStatus()
      else if (text.trim() && !statusRequest && Date.now() - lastTyping >= 4000) {
        lastTyping = Date.now()
        typingActive = true
        sendStatus("typing", false)
      }
    }
    updateCaret()
    dismissedMention = ""
  }

  function cancelReference() {
    if (draft.editing) cancelEditing(chatId)
    else updateDraft(chatId, { reply: null })
    input?.focus()
  }

  function videoMetadata(event: Event) {
    const video = event.currentTarget as HTMLVideoElement
    if (!attachment || video.dataset.path !== attachment.path) return
    updateDraft(chatId, { videoInfo: {
      width: video.videoWidth, height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? Math.ceil(video.duration) : 0,
    } })
    if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Math.min(.1, video.duration / 2)
  }

  function previewFailed(event: Event) {
    failedPreview = (event.currentTarget as HTMLElement).dataset.path ?? null
  }
</script>

<svelte:window onpaste={paste} onpointerdown={closePopoversOutside} onkeydown={popoverKeys} />

<footer class="composer">
  {#if mentionOpen}
    <div class="mention-list glass" id={`mentions-${chatId}`} role="listbox" aria-label="Участники">
      {#each mentionOptions as user, index (user.id)}
        <button id={`mention-${chatId}-${index}`} role="option" aria-selected={index === mentionIndex} class:selected={index === mentionIndex} onpointerdown={(event) => event.preventDefault()} onclick={() => chooseMention(user)}><Avatar id={user.id} title={`${user.first_name} ${user.last_name}`.trim()} fileId={user.photo_file_id} path={user.photo} size={34} /><span><strong>{user.first_name} {user.last_name}</strong>{#if user.username}<span>@{user.username}</span>{/if}</span></button>
      {:else}<span class="mention-empty">{mentionLoading ? "Поиск..." : mentionError || "Никого не найдено"}</span>{/each}
    </div>
  {/if}
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if reference}
    <div class="reference">
      {#if draft.editing}<Icon name="edit-pencil" size={16} />{:else}<Icon name="reply" size={16} />{/if}
      <span><strong>{draft.editing ? "Редактирование" : messageSender(reference).name || "Ответ"}</strong><span>{messagePreview(reference.content)}</span></span>
      <button class="icon-button" aria-label={draft.editing ? "Отменить редактирование" : "Отменить ответ"} onclick={cancelReference} disabled={sending}><Icon name="xmark" size={16} /></button>
    </div>
  {/if}
  {#if attachment}
    <div class="attachment">
      {#snippet thumbnail()}
        {#key attachment.path}
        {#if attachment.kind === "voice"}<Icon name="microphone" size={25} />
        {:else if preview && failedPreview !== attachment.path}
          {#if attachment.kind === "video"}<video use:releaseMedia src={preview} data-path={attachment.path} muted playsinline preload="metadata" onloadedmetadata={videoMetadata} onerror={previewFailed} aria-label={attachment.file_name}></video>
          {:else}<img src={preview} data-path={attachment.path} alt={attachment.file_name} onerror={previewFailed} />{/if}
        {:else}<Icon name="page" size={25} strokeWidth={1.5} />{/if}
        {/key}
      {/snippet}
      {#if attachment.kind === "photo" || attachment.kind === "video"}
        <button type="button" class="thumbnail" aria-label={attachment.kind === "video" ? "Просмотреть прикреплённое видео" : "Просмотреть прикреплённое фото"} onclick={previewAttachment}>{@render thumbnail()}</button>
      {:else}<div class="thumbnail">{@render thumbnail()}</div>{/if}
      <span class="attachment-info"><strong>{attachment.file_name}</strong><span>{formatFileSize(attachment.size)}{#if failedPreview === attachment.path}<span class="preview-error">Превью недоступно</span>{/if}</span></span>
      <button class="icon-button" aria-label="Убрать вложение" onclick={() => removeAttachment(chatId)} disabled={sending}><Icon name="xmark" size={17} /></button>
    </div>
  {/if}
  {#if attachment?.kind === "voice" && preview}{#key preview}<audio class="recorded-voice" use:releaseMedia src={preview} controls preload="metadata"></audio>{/key}{/if}
  <div class="row">
    <div class="row-surface glass glowing-panel" aria-hidden="true"></div>
    {#if recording}<button class="attach recording-cancel" aria-label="Отменить запись" onclick={cancelRecording}><Icon name="trash" size={21} /></button><span class="recording-time"><i></i>{formatDuration(seconds)}</span>{:else}<button class="attach" title="Прикрепить файл" onclick={attach} disabled={sending || choosing || recordingStarting || !!draft.editing || !store.chatsReady}><Paperclip size={22} strokeWidth={1.5} /></button>{/if}
    <textarea bind:this={input} class="input" placeholder={recording ? "Запись..." : attachment ? "Подпись..." : "Напиши сообщение..."} aria-label={attachment ? "Подпись к вложению" : "Сообщение"} aria-controls={mentionOpen ? `mentions-${chatId}` : undefined} aria-activedescendant={mentionOpen && mentionOptions.length ? `mention-${chatId}-${mentionIndex}` : undefined} rows="1" value={draft.text} disabled={recording || recordingStarting} onfocus={() => store.focusedConversation = chatId} onblur={() => { if (typingActive) stopStatus() }} oninput={updateText} onkeydown={inputKeys} onkeyup={updateCaret} onclick={updateCaret} onselect={updateCaret}></textarea>
    <div class="sticker-control" role="group" aria-label="Стикеры" bind:this={stickerControl} onpointerenter={hoverStickers} onpointerleave={leaveStickers}>
      <button class="attach sticker-toggle" class:active={stickerPinned} title="Стикеры" aria-label="Стикеры" aria-expanded={stickersOpen || stickerPinned} onclick={toggleStickers} disabled={sending || choosing || recording || recordingStarting || !!draft.editing || !store.chatsReady}><Icon name="ph:sticker" size={22} /></button>
      {#if stickersOpen}<StickerPicker {chatId} onclose={closeStickers} />{/if}
    </div>
    <div class="status-control" bind:this={statusControl}>
      <button class="attach" class:active={!!manualStatus || statusOpen} title="Статусы активности" aria-label="Статусы активности" aria-expanded={statusOpen} bind:this={statusButton} disabled={sending || choosing || recording || recordingStarting || !!draft.editing || !store.chatsReady} onclick={() => { stickersOpen = false; statusOpen = !statusOpen }}><Icon name="sparks" size={21} /></button>
      {#if statusOpen}
        <div class="status-popover glass" role="group" aria-label="Статусы активности">
          {#each statuses as { action, label } (action)}
            <button aria-pressed={manualStatus === action} onclick={() => selectStatus(action)}>{label}{#if manualStatus === action}<Icon name="check" size={14} />{/if}</button>
          {/each}
          {#if statusError}<div class="inline-error" role="alert">{statusError}</div>{/if}
        </div>
      {/if}
    </div>
    <button class="send" class:send-mode={canSend} title={recording ? "Завершить запись" : draft.editing ? "Сохранить" : canSend ? "Отправить" : "Записать голосовое"} aria-label={recording ? "Завершить запись" : canSend ? "Отправить" : "Записать голосовое"} onclick={primaryAction} disabled={sending || choosing || recordingStarting || !!draft.editing && !canSend || !store.chatsReady}>{#if recording}<Icon name="square" size={22} />{:else}<span class="microphone-icon"><Icon name="microphone" size={23} /></span><span class="send-icon"><Icon name="send-solid" size={22} /></span>{/if}</button>
  </div>
</footer>

<style>
  .composer { position: relative; padding: 8px 16px 3px }
  .mention-list { position: absolute; bottom: calc(100% + 6px); left: 16px; right: 16px; z-index: 3; max-height: 260px; overflow-y: auto; padding: 5px; border-radius: 19px; background: var(--menu-bg); box-shadow: 0 12px 35px rgba(0,0,0,.25); animation: appear .15s ease-out }
  .mention-list button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 9px; text-align: left; border-radius: 14px }
  .mention-list button:hover, .mention-list .selected { background: var(--accent-soft) }
  .mention-list button > span { display: grid; gap: 2px; min-width: 0 }
  .mention-list strong { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .mention-list button > span > span { font-size: 11px; color: var(--text-secondary) }
  .mention-empty { display: block; padding: 12px; font-size: 12px; color: var(--text-secondary) }
  .row { --composer-icon: color-mix(in srgb, var(--text-secondary) 50%, #92969c); position: relative; isolation: isolate; display: flex; align-items: center; gap: 10px; padding: 5px 10px; border: 1px solid transparent; border-radius: 26px; min-height: 48px }
  .row-surface { position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none }
  @container (max-width: 480px) {
    .composer { padding-inline: 4px }
    .row { gap: 4px; padding-inline: 6px }
  }
  .attach { display: flex; align-items: center; justify-content: center; color: var(--composer-icon); padding: 6px; border-radius: 50% }
  .attach:hover, .attach.active { color: var(--text-primary); background: var(--hover) }
  .sticker-control { display: flex; align-items: center; flex-shrink: 0 }
  .sticker-toggle.active { color: var(--accent-hover); background: var(--accent-soft) }
  .status-control { position: relative; display: flex; flex-shrink: 0 }
  .status-control .active { color: var(--accent-hover); background: var(--accent-soft) }
  .status-popover { position: absolute; z-index: 5; bottom: calc(100% + 10px); right: 0; width: 184px; max-height: min(320px, 65vh); overflow-y: auto; padding: 5px; border-radius: 14px; background: var(--menu-bg) }
  .status-popover button { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; padding: 7px 8px; border-radius: 8px; text-align: left; font-size: 12px }
  .status-popover button:hover { background: var(--hover) }
  .status-popover button[aria-pressed="true"] { color: var(--accent-hover); background: var(--accent-soft) }
  .input { flex: 1; min-width: 0; resize: none; border-radius: 0; padding: 6px 0; font-size: 13px; background: transparent; max-height: 150px; line-height: 1.4; user-select: text }
  .send { position: relative; width: 36px; height: 36px; flex-shrink: 0; color: var(--composer-icon); background: transparent; padding: 6px; border-radius: 50%; display: grid; place-items: center; transition: background .15s, opacity .15s }
  .send:hover:not(:disabled) { color: var(--text-primary); background: var(--hover) }
  .send:not(.send-mode):has(.microphone-icon) { color: var(--text-on-accent); background: var(--accent) }
  .send:not(.send-mode):has(.microphone-icon):hover:not(:disabled) { background: var(--accent-hover) }
  .send:disabled { opacity: .4; cursor: default }
  .send-icon, .microphone-icon { position: absolute; display: flex; transition: opacity .18s, transform .22s }
  .send-icon { opacity: 0; transform: translateY(6px) scale(.55) rotate(-25deg) }
  .send-mode .send-icon { opacity: 1; transform: translateY(0) scale(1) rotate(0) }
  .send-mode .microphone-icon { opacity: 0; transform: translateY(-6px) scale(.55) rotate(25deg) }
  .recording-cancel, .recording-time { color: var(--danger) }
  .recording-time { display: flex; align-items: center; gap: 7px; font-size: 13px; white-space: nowrap }
  .recording-time i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: recording-pulse 1s infinite alternate }
  .recorded-voice { display: block; width: min(100%, 360px); height: 34px; margin: 0 17px 10px }
  @keyframes recording-pulse { to { opacity: .3 } }
  .error { color: var(--danger); font-size: 12px; padding: 0 12px 8px; overflow-wrap: anywhere }
  .attachment, .reference { display: flex; align-items: center; gap: 12px; margin: 0 17px 10px; min-width: 0; padding: 10px 12px; border-radius: 14px; background: rgba(14,23,37,.9); -webkit-backdrop-filter: blur(var(--glass-blur)); backdrop-filter: blur(var(--glass-blur)) }
  .thumbnail { width: 66px; height: 52px; padding: 0; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: grid; place-items: center; color: var(--accent-hover); background: var(--accent-soft); flex-shrink: 0 }
  .thumbnail img, .thumbnail video { width: 100%; height: 100%; object-fit: cover }
  .attachment-info, .reference > span { display: grid; gap: 5px; flex: 1; min-width: 0 }
  .attachment-info strong, .reference strong { font-size: 12px; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .attachment-info > span, .reference > span > span { font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .preview-error { display: block; color: var(--danger); margin-top: 4px }
  .reference { border-left: 2px solid var(--accent); border-radius: 12px; padding: 10px 12px; background: rgba(20,32,50,.86); -webkit-backdrop-filter: blur(var(--glass-blur)); backdrop-filter: blur(var(--glass-blur)) }
  .reference > span { gap: 1px }
  .reference > :global(.icon), .reference strong { color: var(--accent-hover) }
</style>
