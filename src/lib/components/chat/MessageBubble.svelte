<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import { onDestroy, untrack } from "svelte"
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { openPath } from "@tauri-apps/plugin-opener";
  import { store, api, messageSender, senderDetails, recentReactionSenders, openProfile, openMessageMenu, openReactionMenu, focusMessage, loadAvatar, activeChat, replyToMessage, mediaItem, openMediaViewer } from "$lib/stores/app.svelte"
  import Avatar from "$lib/components/Avatar.svelte"
  import RichText from "$lib/components/RichText.svelte"
  import VoicePlayer from "./VoicePlayer.svelte"
  import ReactionIcon from "$lib/components/ReactionIcon.svelte"
  import StickerMedia from "$lib/components/StickerMedia.svelte"
  import { replyPreview, loadReplyPreview, jumpToMessage, toggleReaction, senderColor, openComments, musicTrack, playMusic, stopVoice } from "$lib/stores/app.svelte"
  import { messagePreview } from "$lib/utils"
  import { telegramMediaSrc, type MsgData } from "$lib/api/td"
  import { formatTime, formatFileSize, formatDuration, releaseMedia } from "$lib/utils"

  let { msg, presentation = false, actions = true, showAuthor, showAvatar, groupedBefore = false, groupedAfter = false, mediaMessages, conversationKey, animateEntry = true }: {
    msg: MsgData; presentation?: boolean; actions?: boolean; showAuthor?: boolean; showAvatar?: boolean; groupedBefore?: boolean; groupedAfter?: boolean; mediaMessages?: MsgData[]; conversationKey?: number; animateEntry?: boolean
  } = $props()

  const animateOnMount = untrack(() => animateEntry && !presentation)

  const content = $derived(msg.content);
  const isOut = $derived(msg.is_outgoing);
  const sender = $derived(messageSender(msg))
  const forward = $derived(msg.forward_from)
  const track = $derived(musicTrack(msg))
  const currentMusic = $derived(track && store.music?.track.key === track.key ? store.music : null)
  const showSender = $derived(showAuthor ?? (!isOut && (store.chats.find((chat) => chat.id === msg.chat_id)?.is_group ?? (activeChat()?.id === msg.chat_id && activeChat()?.is_group))))
  const avatarVisible = $derived(showAvatar ?? showSender)
  let failedPreviewId = $state<number | null>(null)
  const previewId = $derived(content.kind === "Photo" || content.kind === "Video" || content.kind === "VideoNote" ? content.data.thumbnail_file_id ?? null : null)
  const previewPath = $derived(previewId ? store.files.get(previewId) ?? null : null)
  const previewFailed = $derived(previewId !== null && failedPreviewId === previewId)
  const read = $derived(msg.id <= (store.chats.find((chat) => chat.id === msg.chat_id)?.last_read_outbox_message_id ?? 0))
  let holdTimer: ReturnType<typeof setTimeout> | undefined
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let held = false
  let actionError = $state("")
  let bubbleElement: HTMLDivElement | undefined = $state()
  let animationVisible = $state(false)
  let previewVisible = $state(false)
  let noteError = $state(false)
  const animationPath = $derived(content.kind === "Animation" ? store.files.get(content.data.file_id) : null)
  const showAnimation = $derived(animationVisible && store.windowVisible && (presentation || !store.mediaViewer && !store.focusedMessage))
  const mediaRatio = $derived(content.kind === "Photo" || content.kind === "Video" || content.kind === "Animation"
    ? Math.max(1, content.data.width) / Math.max(1, content.data.height) : null)
  const visualMedia = $derived(mediaRatio !== null || content.kind === "VideoNote")
  const mediaHeading = $derived(visualMedia && !!(showSender || forward || msg.reply_to))
  const hasComments = $derived(msg.is_channel_post && msg.comment_count !== null && msg.comment_count !== undefined && !presentation)
  const mediaFooter = $derived(visualMedia && (("caption" in content.data && !!content.data.caption)
    || !!msg.reactions?.length || hasComments || !!actionError && !presentation || content.kind === "VideoNote" && noteError))
  const videoNoteKey = $props.id()
  let noteVideo: HTMLVideoElement | undefined = $state()
  let noteStarted = $state(false)
  let notePlaying = $state(false)
  let notePosition = $state(0)
  let noteOpened = false

  $effect(() => {
    const node = noteVideo
    if (!node) return
    noteStarted = false
    notePlaying = false
    notePosition = 0
    noteError = false
    noteOpened = false
    return () => {
      if (store.playingVoice === videoNoteKey) store.playingVoice = null
    }
  })

  $effect(() => {
    if (store.playingVoice !== videoNoteKey) noteVideo?.pause()
  })

  function stopVideoNote() {
    notePlaying = false
    if (store.playingVoice === videoNoteKey) store.playingVoice = null
  }

  function failVideoNote(node: HTMLVideoElement) {
    if (noteVideo !== node) return
    stopVideoNote()
    noteStarted = false
    notePosition = 0
    noteError = true
  }

  function toggleVideoNote(fileId: number) {
    const node = noteVideo
    if (!node || presentation) return
    if (!node.paused) {
      node.pause()
      return
    }
    if (!node.hasAttribute("src") || noteError) node.src = telegramMediaSrc(fileId, "video-note.mp4", "mp4")
    noteError = false
    stopVoice()
    if (store.music) store.music.playing = false
    store.playingVoice = videoNoteKey
    void node.play().catch((error) => {
      if (error?.name !== "AbortError") failVideoNote(node)
    })
  }

  function startVideoNote() {
    if (store.playingVoice !== videoNoteKey) {
      noteVideo?.pause()
      return
    }
    notePlaying = true
    noteStarted = true
    if (!noteOpened && !msg.is_outgoing && !msg.is_deleted) {
      noteOpened = true
      void api.openMessageContent(msg.chat_id, msg.id, "video_note").catch(() => {})
    }
  }

  $effect(() => {
    if (content.kind !== "Animation" || !bubbleElement) return
    const observer = new IntersectionObserver(([entry]) => animationVisible = entry.isIntersecting)
    observer.observe(bubbleElement)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!previewId || !bubbleElement) return
    const root = bubbleElement.closest(".messages")
    const observer = new IntersectionObserver(([entry]) => previewVisible = entry.isIntersecting, { root, rootMargin: "240px 0px" })
    observer.observe(bubbleElement)
    return () => {
      observer.disconnect()
      previewVisible = false
    }
  })

  $effect(() => {
    if (content.kind === "Animation" && showAnimation && !animationPath && store.chatsReady) void loadAvatar(content.data.file_id).catch(() => {})
  })

  const repliedMessage = $derived(msg.reply_to ? replyPreview(msg.reply_to.chat_id, msg.reply_to.message_id) : null)
  const replyAuthor = $derived(repliedMessage ? messageSender(repliedMessage).name || "Участник" : msg.reply_to?.author || "Сообщение")
  const replyText = $derived(msg.reply_to?.quote || (repliedMessage ? messagePreview(repliedMessage.content) : msg.reply_to?.preview) || "Сообщение недоступно")

  $effect(() => {
    if (msg.reply_to && msg.reply_to.message_id > 0) void loadReplyPreview(msg.reply_to.chat_id, msg.reply_to.message_id)
  })

  async function followReply() {
    if (!msg.reply_to || presentation) return
    actionError = ""
    try { await jumpToMessage(msg.reply_to.chat_id, msg.reply_to.message_id, conversationKey) }
    catch { actionError = "Сообщение недоступно" }
  }

  function cancelHold() {
    clearTimeout(holdTimer)
    holdTimer = undefined
    pointerId = null
  }

  onDestroy(cancelHold)

  function pointerDown(event: PointerEvent) {
    if (presentation || !actions || event.button !== 0 || !event.isPrimary) return
    store.focusedConversation = conversationKey ?? msg.chat_id
    if ((event.target as HTMLElement).closest("button,a,input,textarea,video,audio,[contenteditable]")) return
    cancelHold()
    held = false
    startX = event.clientX
    startY = event.clientY
    pointerId = event.pointerId
    holdTimer = setTimeout(() => {
      held = true
      window.getSelection()?.removeAllRanges()
      focusMessage(msg)
    }, 500)
  }

  function pointerMove(event: PointerEvent) {
    if (pointerId === event.pointerId && Math.hypot(event.clientX - startX, event.clientY - startY) > 9) cancelHold()
  }

  function pointerUp(event: PointerEvent) {
    if (held) event.preventDefault()
    cancelHold()
  }

  function contextMenu(event: MouseEvent) {
    if (presentation || !actions) return
    store.focusedConversation = conversationKey ?? msg.chat_id
    event.preventDefault()
    event.stopPropagation()
    cancelHold()
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-reaction-key]") : null
    const reaction = button && msg.reactions?.find((item) => item.key === button.dataset.reactionKey)
    if (button && reaction) {
      const box = button.getBoundingClientRect()
      openReactionMenu(msg, reaction, event.clientX || box.left, event.clientY || box.bottom)
      return
    }
    if (store.focusedMessage?.message.id === msg.id && store.focusedMessage.message.chat_id === msg.chat_id) return
    openMessageMenu(msg, event.clientX, event.clientY)
  }

  function doubleClick(event: MouseEvent) {
    if (presentation || !actions || (event.target as HTMLElement).closest("button,a,input,textarea,video,audio")) return
    event.preventDefault()
    window.getSelection()?.removeAllRanges()
    replyToMessage(msg, conversationKey)
  }

  function menuButton(event: MouseEvent) {
    store.focusedConversation = conversationKey ?? msg.chat_id
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    openMessageMenu(msg, box.right, box.bottom + 5)
  }

  $effect(() => {
    const fileId = previewId
    if (fileId && previewVisible && store.windowVisible && !previewPath && store.chatsReady) {
      let disposed = false
      const accountId = store.user?.id
      failedPreviewId = null
      void loadAvatar(fileId)
        .then((path) => {
          if (disposed || store.user?.id !== accountId) return
          if (!path) failedPreviewId = fileId
        })
        .catch(() => {
          if (!disposed) failedPreviewId = fileId
        })
      return () => { disposed = true }
    }
  });

  function fileSrc(path: string): string {
    return convertFileSrc(path.replace(/\\/g, "/"));
  }

  async function openFile(fileId: number) {
    if (mediaItem(msg)) {
      openMediaViewer(msg, mediaMessages)
      return
    }
    const path = await loadAvatar(fileId)
    if (path) {
      try {
        await openPath(path);
      } catch (e) {
        console.error("open", e);
      }
    }
  }
</script>

<div class="bubble-row" class:out={isOut} class:presentation class:animate-entry={animateOnMount} class:grouped-before={groupedBefore} class:grouped-after={groupedAfter} inert={presentation} role="group" aria-label="Сообщение" ondblclick={doubleClick} oncontextmenu={contextMenu} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={cancelHold} onpointerleave={cancelHold}>
  {#if avatarVisible}
    <button class="sender-avatar" aria-label={`Профиль ${sender.name || "участника"}`} onclick={() => openProfile({ kind: sender.kind, id: sender.id })}><Avatar id={sender.id} title={sender.name || "Участник"} fileId={sender.photo_file_id} path={sender.photo} size={32} /></button>
  {:else if showAvatar === false && !isOut}<span class="avatar-spacer"></span>{/if}
  <div class="bubble" bind:this={bubbleElement} class:sticker-bubble={content.kind === "Sticker"} class:media-bubble={visualMedia} class:round-bubble={content.kind === "VideoNote"} class:note-expanded={notePlaying} class:media-heading={mediaHeading} class:media-footer={mediaFooter} style:--media-ratio={mediaRatio ?? undefined}>
    {#if actions && !presentation}<button class="message-more icon-button" aria-label="Действия с сообщением" onclick={menuButton}><Icon name="more-horiz" size={17} /></button>{/if}
    {#if showSender}
      <button class="sender-name" style:color={senderColor(sender)} onclick={() => openProfile({ kind: sender.kind, id: sender.id })}>{sender.name || "Участник"}</button>
    {/if}
    {#if forward}
      <div class="forward-origin">
        Переслано от
        {#if forward.kind !== "hidden" && forward.id !== null}
          {@const target = { kind: forward.kind, id: forward.id }}
          <button onclick={() => openProfile(target)}>{forward.name || (forward.kind === "user" ? "пользователя" : "чата")}</button>
        {:else}
          <strong>{forward.name || "пользователя"}</strong>
        {/if}
      </div>
    {/if}
    {#if msg.reply_to}
      <button class="reply-preview" disabled={msg.reply_to.message_id <= 0} onclick={followReply}><strong>{replyAuthor}</strong><span>{replyText}</span></button>
    {/if}
    {#if content.kind === "Text"}
      <div class="text"><RichText text={content.data.text} entities={content.data.entities} /></div>
    {:else if content.kind === "Photo"}
      <button class="media-open" aria-label="Открыть фото" disabled={content.data.file_id <= 0} onclick={() => openMediaViewer(msg, mediaMessages)}>
        {#if previewVisible && previewPath && !previewFailed}<img src={fileSrc(previewPath)} alt="фото" decoding="async" onerror={() => failedPreviewId = previewId} />{:else}<span class="photo-loading"><Icon name="mynaui:image" size={22} /></span>{/if}
      </button>
      {#if content.data.caption}
        <div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>
      {/if}
    {:else if content.kind === "Video"}
      <button class="media-open" aria-label="Открыть видео" onclick={() => openMediaViewer(msg, mediaMessages)}>
        {#if previewVisible && previewPath && !previewFailed}<img src={fileSrc(previewPath)} alt="" decoding="async" onerror={() => failedPreviewId = previewId} />{/if}
        <span class="video-play"><Icon name="play" size={27} /></span><span class="video-duration">{formatDuration(content.data.duration)}</span>
      </button>
      {#if content.data.caption}<div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>{/if}
    {:else if content.kind === "VideoNote"}
      {@const { file_id, duration } = content.data}
      {#key file_id}
        <button class="video-note" class:note-playing={notePlaying} aria-label={noteError ? "Повторить воспроизведение кружка" : notePlaying ? "Поставить кружок на паузу" : "Воспроизвести кружок"} disabled={presentation} onclick={() => toggleVideoNote(file_id)}>
          {#if !noteStarted && previewVisible && previewPath && !previewFailed}<img src={fileSrc(previewPath)} alt="" decoding="async" onerror={() => failedPreviewId = previewId} />{/if}
          {#if !presentation}
            <video bind:this={noteVideo} use:releaseMedia class:note-started={noteStarted} playsinline preload="none" aria-label="Кружок" onplaying={startVideoNote} onpause={stopVideoNote} onended={() => { stopVideoNote(); notePosition = 0 }} ontimeupdate={(event) => { notePosition = event.currentTarget.ended ? 0 : event.currentTarget.currentTime }} onerror={(event) => {
              if (event.currentTarget instanceof HTMLVideoElement) failVideoNote(event.currentTarget)
            }}><track kind="captions" /></video>
          {/if}
          <span class="video-play"><Icon name={notePlaying ? "pause" : "play"} size={25} /></span>
          <span class="note-duration">{formatDuration(Math.max(0, Math.ceil(duration - notePosition)))}</span>
        </button>
      {/key}
      {#if noteError}<div class="note-error" role="alert">Не удалось воспроизвести кружок</div>{/if}
    {:else if content.kind === "Animation"}
      <button class="media-open" aria-label="Открыть GIF" onclick={() => openMediaViewer(msg, mediaMessages)}>
        {#if animationPath && showAnimation}
          {#if content.data.mime_type === "image/gif"}<img src={fileSrc(animationPath)} alt="GIF" decoding="async" />
          {:else}<video use:releaseMedia src={fileSrc(animationPath)} autoplay={!presentation} loop muted playsinline preload={presentation ? "metadata" : "auto"} aria-label="GIF"></video>{/if}
        {:else}<span class="photo-loading">GIF</span>{/if}
      </button>
      {#if content.data.caption}<div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>{/if}
    {:else if content.kind === "Sticker"}
      <div class="sticker" style:aspect-ratio={`${Math.max(1, content.data.width)} / ${Math.max(1, content.data.height)}`}>
        <StickerMedia sticker={content.data} animate={!presentation} />
      </div>
    {:else if content.kind === "Voice"}
      <VoicePlayer fileId={content.data.file_id} duration={content.data.duration} waveform={content.data.waveform} chatId={msg.chat_id} messageId={msg.id} {conversationKey} {presentation} />
      {#if content.data.caption}<div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>{/if}
    {:else if track}
      <button class="audio-message" disabled={presentation} aria-label={`${currentMusic?.playing ? "Пауза" : "Воспроизвести"}: ${track.title}`} onclick={() => playMusic(msg, mediaMessages ?? store.messages.get(conversationKey ?? msg.chat_id))}>
        <span class="audio-play"><Icon name={currentMusic?.playing ? "pause" : "play"} size={21} /></span>
        <span class="audio-info"><strong>{track.title}</strong>{#if currentMusic?.loading || track.performer || track.title !== track.fileName}<span>{currentMusic?.loading ? "Загрузка..." : track.performer || track.fileName}</span>{/if}<span>{formatDuration(currentMusic?.position || track.duration)}</span></span>
      </button>
      {#if "caption" in content.data && content.data.caption}<div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>{/if}
    {:else if content.kind === "File"}
      <button class="file" onclick={() => openFile(content.data.file_id)}>
        <div class="file-icon"><Icon name="page" size={28} strokeWidth={1.5} /></div>
        <div class="file-info">
          <div class="file-name">{content.data.file_name}</div>
          <div class="file-size">{formatFileSize(content.data.size)}</div>
        </div>
      </button>
      {#if content.data.caption}
        <div class="text"><RichText text={content.data.caption} entities={content.data.entities} /></div>
      {/if}
    {:else if content.kind === "Unsupported"}
      <div class="unsupported">{content.data.label}</div>
    {/if}
    {#if msg.reactions?.length}
      <div class="reactions">
        {#each msg.reactions as reaction (reaction.key)}
          {@const authors = recentReactionSenders(msg, reaction)}
          {#snippet reactionContent()}
            <ReactionIcon {reaction} />
            {#if reaction.count <= 3 && authors.length === reaction.count}
              <span class="reaction-avatars" aria-hidden="true">
                {#each authors as reactor (`${reactor.kind}:${reactor.id}`)}
                  {@const author = senderDetails(reactor)}
                  <span><Avatar id={author.id} title={author.name || "Участник"} fileId={author.photo_file_id} path={author.photo} size={17} /></span>
                {/each}
              </span>
            {:else}{reaction.count}{/if}
          {/snippet}
          {#if reaction.key === "paid" || msg.is_deleted || presentation}
            <span class="reaction" class:chosen={reaction.chosen}>{@render reactionContent()}</span>
          {:else}
            <button class="reaction" class:chosen={reaction.chosen} data-reaction-key={reaction.key} aria-label={`${reaction.emoji || "Реакция"}: ${reaction.count}`} aria-pressed={reaction.chosen} aria-disabled={store.reactionBusy.get(`${msg.chat_id}:${msg.id}`) || undefined} onclick={() => {
              if (store.reactionBusy.get(`${msg.chat_id}:${msg.id}`)) return
              actionError = ""
              void toggleReaction(msg, reaction).catch(() => actionError = "Не удалось изменить реакцию")
            }}>{@render reactionContent()}</button>
          {/if}
        {/each}
      </div>
    {/if}
    {#if actionError && !presentation}<div class="action-error" role="alert">{actionError}</div>{/if}
    {#if hasComments}
      <button class="comments-button" onclick={() => {
        actionError = ""
        void openComments(msg).catch(() => actionError = "Комментарии недоступны")
      }}><Icon name="chat-bubble" size={16} /><span>{msg.comment_count ? `${msg.comment_count} комментариев` : "Комментарии"}</span><Icon name="nav-arrow-right" size={15} /></button>
    {/if}
    <div class="meta">
      {#if msg.is_deleted}<span>Удалено</span>{/if}
      {formatTime(msg.date, true)}
      {#if isOut}
        {#if msg.sending_state === "failed"}
          <span class="failed" title={msg.error ?? "Не отправлено"}>Не отправлено</span>
        {:else if msg.sending_state === "pending"}
          <span class="delivery" aria-label="Отправляется"><Icon name="clock" size={12} strokeWidth={1.5} /></span>
        {:else}
          <span class="delivery" aria-label={read ? "Прочитано" : "Отправлено"}>
            {#if read}<Icon name="double-check" size={14} strokeWidth={1.5} />{:else}<Icon name="check" size={14} strokeWidth={1.5} />{/if}
          </span>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .audio-message { display: flex; align-items: center; gap: 11px; width: 280px; max-width: 100%; padding: 5px 0; text-align: left }
  .audio-play { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 50%; background: var(--accent-soft); color: var(--accent-hover) }
  .audio-info { display: grid; gap: 3px; min-width: 0 }
  .audio-info strong, .audio-info > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .audio-info strong { font-size: 13px; font-weight: 550 }
  .audio-info > span { color: var(--text-secondary); font-size: 11px }
  .out .audio-play { background: rgba(255,255,255,.16); color: var(--bubble-out-text) }
  .out .audio-info > span { color: var(--bubble-out-meta) }
  .comments-button { display: flex; align-items: center; gap: 7px; width: 100%; padding: 8px 0 2px; margin-top: 5px; font-size: 12px; color: var(--accent-hover); clear: both }
  .comments-button span { flex: 1; text-align: left }
  .forward-origin { margin: 2px 0 5px; color: var(--accent-hover); font-size: 12px }
  .out .forward-origin { color: var(--bubble-out-text, #d5ecff) }
  .forward-origin button, .forward-origin strong { display: inline; padding: 0; font-weight: 600; text-align: left; overflow-wrap: anywhere }
  .forward-origin button:hover { text-decoration: underline; text-underline-offset: 3px }
  .reply-preview { display: grid; gap: 0; width: 100%; min-width: 0; max-width: 100%; padding: 5px 9px; margin: 7px 0 4px; border-radius: 5px; border-left: 3px solid var(--accent); background: rgba(4,12,25,.37); text-align: left; color: var(--text-primary) }
  .reply-preview strong { color: var(--accent-hover); font-size: 11px; line-height: 1.2; font-weight: 600; opacity: .8 }
  .reply-preview span { font-size: 11px; line-height: 1.2; opacity: .8; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere }
  .reply-preview:disabled { cursor: default }
  .reactions { display: flex; flex-wrap: wrap; gap: 4px; clear: both; padding-top: 6px }
  .reaction { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border-radius: 14px; background: rgba(6,14,27,.38); color: var(--text-primary); font-size: 11px; line-height: 21px }
  .reaction.chosen { background: #000; color: #deecff }
  .reaction:not(.chosen):hover { background: rgba(55,132,255,.25) }
  .reaction-avatars { display: inline-flex; align-items: center }
  .reaction-avatars > span { display: block; border: 1px solid var(--menu-bg); border-radius: 50% }
  .reaction-avatars > span + span { margin-inline-start: -5px }
  .action-error { font-size: 11px; color: var(--danger); margin-top: 5px }
  .bubble-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    max-width: min(78%, 670px);
    align-self: flex-start;
    margin-top: 6px;
  }
  .animate-entry { animation: message-appear .18s ease-out }
  @keyframes message-appear { from { opacity: 0 } }
  .bubble-row.out {
    align-self: flex-end;
  }
  .presentation { pointer-events: none; max-width: 100%; animation: none; user-select: none }
  .out .sender-avatar { order: 1 }
  .bubble {
    display: flow-root;
    background: var(--bubble-in);
    border-radius: var(--bubble-radius, 17px);
    padding: 8px 12px 7px;
    font-size: var(--message-font-size, 14px);
    line-height: 1.3;
    position: relative;
    min-width: 64px;
    word-break: break-word;
  }
  .sender-avatar { padding: 0; border-radius: 50%; flex-shrink: 0 }
  .avatar-spacer { width: 32px; flex-shrink: 0 }
  .grouped-before { margin-top: 1px }
  .grouped-before .bubble { border-top-left-radius: 5px }
  .grouped-after .bubble { border-bottom-left-radius: 5px }
  .out.grouped-before .bubble { border-top-left-radius: var(--bubble-radius, 17px); border-top-right-radius: 5px }
  .out.grouped-after .bubble { border-bottom-left-radius: var(--bubble-radius, 17px); border-bottom-right-radius: 5px }
  .message-more { position: absolute; right: -33px; top: 2px; width: 27px; height: 27px; opacity: 0; background: var(--menu-bg); color: var(--accent-hover); transition: opacity .15s }
  .out .message-more { right: auto; left: -33px }
  .bubble-row:hover .message-more, .bubble-row:focus-within .message-more, .message-more:focus-visible { opacity: 1 }
  .out .sender-name { color: var(--bubble-out-text, #d2e8ff) }
  .out .meta { color: var(--bubble-out-meta, rgba(255,255,255,.76)) }
  .out :global(.mention), .out :global(.rich-text a) { color: var(--bubble-out-text, #d5ecff) }
  .sender-name {
    color: var(--accent-hover);
    font-size: 12px;
    line-height: 1.1;
    font-weight: 600;
    margin-bottom: 0;
    padding: 0;
    text-align: left;
    display: block;
  }
  .sender-name:hover { text-decoration: underline; text-underline-offset: 3px }
  .out .bubble {
    background: var(--bubble-out);
    color: var(--bubble-out-text, #fff);
  }
  :global(.app[data-theme="next"][data-effects="full"]) .bubble:not(.sticker-bubble, .round-bubble, .media-bubble:not(.media-heading, .media-footer)) { background: radial-gradient(ellipse at 15% 0%, rgba(174,195,232,.08), transparent 62%), linear-gradient(125deg, rgba(55,70,96,.38), rgba(48,61,85,.22)); -webkit-backdrop-filter: blur(16px) saturate(1.2); backdrop-filter: blur(16px) saturate(1.2); box-shadow: inset 0 8px 20px rgba(170,193,231,.02) }
  :global(.app[data-theme="next"][data-effects="full"]) .out .bubble:not(.sticker-bubble, .round-bubble, .media-bubble:not(.media-heading, .media-footer)) { background: radial-gradient(ellipse at 12% 0%, rgba(184,204,249,.1), transparent 64%), linear-gradient(125deg, rgba(79,116,198,.46), rgba(68,95,157,.28)) }
  :global(.app[data-theme="next"][data-bubble-blur="false"]) .bubble:not(.sticker-bubble, .round-bubble, .media-bubble:not(.media-heading, .media-footer)) { background: rgba(38,55,78,.8); -webkit-backdrop-filter: none; backdrop-filter: none }
  :global(.app[data-theme="next"][data-bubble-blur="false"]) .out .bubble:not(.sticker-bubble, .round-bubble, .media-bubble:not(.media-heading, .media-footer)) { background: rgba(58,91,163,.84) }
  .bubble.sticker-bubble { background: transparent; padding: 4px; box-shadow: none }
  .bubble:not(.sticker-bubble, .media-bubble):has(.reactions) { padding-bottom: 5px }
  .bubble.media-bubble { width: min(360px, max(72px, min(44vh, 380px) * var(--media-ratio))); max-width: 100%; min-width: 0; padding: 0 }
  .bubble.media-bubble.round-bubble { width: 208px; transition: width .25s ease }
  .bubble.media-bubble.round-bubble.note-expanded { width: 416px }
  .bubble.media-bubble:not(.media-heading, .media-footer), .bubble.round-bubble { background: transparent }
  .media-heading > .sender-name, .media-heading > .forward-origin, .media-heading > .reply-preview { margin: 0 10px 5px }
  .media-heading > .reply-preview { width: calc(100% - 20px) }
  .bubble.media-heading { padding-top: 7px }
  .bubble.media-footer { padding-bottom: 6px }
  .media-footer > .text, .media-footer > .reactions, .media-footer > .comments-button, .media-footer > .note-error, .media-footer > .action-error { margin-inline: 10px }
  .media-footer > .text { display: block; margin-top: 6px }
  .media-footer > .comments-button { width: calc(100% - 20px) }
  .media-footer > .meta { margin-right: 8px }
  .media-bubble:not(.media-footer) > .meta { position: absolute; bottom: 6px; right: 6px; margin: 0; padding: 2px 5px; border-radius: 7px; color: #fff; background: rgba(3,8,16,.7); pointer-events: none }
  .round-bubble:not(.media-footer) > .meta { left: 94%; right: auto; bottom: 4px }
  .out .round-bubble:not(.media-footer) > .meta { left: auto; right: 94% }
  .media-bubble .message-more { z-index: 1 }
  .sticker { width: 180px; max-width: 100%; display: grid; place-items: center }
  .sticker-bubble .meta { border-radius: 8px; padding: 1px 5px; background: rgba(8,12,20,.68) }
  .text {
    display: inline;
    white-space: pre-wrap;
    line-height: 1.3;
    font-size: var(--message-font-size, 14px);
    font-weight: 300;
    user-select: text;
  }
  .media-open { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: var(--media-ratio); max-height: min(44vh, 380px); overflow: hidden; padding: 0; border-radius: inherit; background: #101725 }
  .media-heading .media-open { border-top-left-radius: 0; border-top-right-radius: 0 }
  .media-footer .media-open { border-bottom-left-radius: 0; border-bottom-right-radius: 0 }
  .media-open > img, .media-open > video, .video-note > img, .video-note > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; pointer-events: none }
  .video-play { display: grid; place-items: center; position: relative; width: 50px; height: 50px; border-radius: 50%; background: rgba(3,8,16,.65); color: white }
  .video-duration { position: absolute; left: 8px; bottom: 8px; padding: 3px 6px; border-radius: 7px; background: rgba(3,8,16,.7); color: white; font-size: 11px }
  .video-note { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: 1; overflow: hidden; border-radius: 50%; padding: 0; background: #101725 }
  .video-note > video:not(.note-started) { visibility: hidden }
  .video-note:focus-visible { outline: 2px solid var(--accent-hover); outline-offset: 2px }
  .video-note.note-playing:not(:hover):not(:focus-visible) .video-play { opacity: 0 }
  .note-duration { position: absolute; bottom: 13px; border-radius: 9px; padding: 2px 6px; color: #fff; background: rgba(3,8,16,.7); font-size: 11px; opacity: 0; transition: opacity .18s ease }
  .video-note:hover .note-duration, .video-note:focus-visible .note-duration { opacity: 1 }
  @media (hover: none) { .note-duration { opacity: 1 } }
  @media (prefers-reduced-motion: reduce) { .bubble.media-bubble.round-bubble, .note-duration { transition: none } }
  .note-error { margin-top: 5px; color: var(--danger); font-size: 11px }
  .photo-loading {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 12px;
    color: var(--text-secondary);
    font-size: 14px;
    text-align: center;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 0;
    text-align: left;
  }
  .file:disabled {
    cursor: default;
  }
  .file-icon {
    display: flex;
  }
  .file-name {
    font-size: 14px;
    font-weight: 500;
  }
  .file-size {
    font-size: 11px;
    color: var(--text-secondary);
  }
  .unsupported {
    font-size: 14px;
    font-style: italic;
    color: rgba(255, 255, 255, 0.55);
  }
  .meta {
    display: inline-flex;
    float: right;
    justify-content: flex-end;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    line-height: 14px;
    color: var(--text-secondary);
    text-align: right;
    margin: 4px 0 -1px 8px;
    white-space: nowrap;
    user-select: none;
  }
  .delivery {
    display: inline-flex;
  }
  .reactions + .meta { margin-top: 1px }
  .failed {
    color: var(--danger);
  }
</style>
