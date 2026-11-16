<script lang="ts">
  import { onMount, tick, untrack } from "svelte"
  import { SvelteMap } from "svelte/reactivity"
  import Icon from "$lib/components/Icon.svelte"
  import { store, api, loadHistory, loadNewerHistory, returnToLatest, jumpToMessage, messageSender, markMessagesRead, messageRenderKey, openChatFeed, closeChatFeed, trimHistory, retainHistory, releaseHistory, prepareHistory, resumeReading } from "$lib/stores/app.svelte"
  import { chatEventText } from "$lib/utils"
  import MessageBubble from "./MessageBubble.svelte"
  import { activeChat, isLiveMessage, isConversationVisible, updateUnreadCounter } from "$lib/stores/app.svelte"
  import type { MsgData } from "$lib/api/td"

  let { chatId, headerHeight, composerHeight }: { chatId: number; headerHeight: number; composerHeight: number } = $props()
  let container: HTMLDivElement | undefined = $state()
  let loadingOlder = $state(false)
  let stickToBottom = false
  let entryReady = $state(false)
  let unreadBoundary = $state<number | null>(null)
  let visibleDay = $state<string | null>(null)
  let touchY: number | null = null
  let awayFromBottom = $state(false)
  let trimTimer: ReturnType<typeof setTimeout> | undefined
  let mounted = $state(false)
  let initializing = $state(false)
  let subscribed = false
  const messages = $derived(store.messages.get(chatId) ?? [])
  const days = $derived.by(() => {
    const groups: { key: string; date: number; entries: { msg: MsgData; index: number }[] }[] = []
    messages.forEach((msg, index) => {
      const key = new Date(msg.date * 1000).toDateString()
      if (groups.at(-1)?.key !== key) groups.push({ key, date: msg.date, entries: [] })
      groups[groups.length - 1].entries.push({ msg, index })
    })
    return groups
  })
  const floatingDay = $derived(days.find((day) => day.key === visibleDay) ?? days[0])
  const firstUnread = $derived(unreadBoundary === null ? null : messages.find((message) => !message.is_outgoing && message.id > unreadBoundary! && !message.is_deleted)?.id)
  const group = $derived(activeChat(chatId)?.is_group ?? false)
  const historyError = $derived(store.historyError.get(chatId))
  const mentionCount = $derived(store.conversations.get(chatId)?.threadId ? 0 : store.mentionCounts.get(chatId) ?? activeChat(chatId)?.unread_mention_count ?? 0)
  let mentionBusy = $state(false)
  let lastMention: number | null = null
  const read = new Set<number>()
  const visible = new Set<number>()
  let readTimer: ReturnType<typeof setTimeout> | undefined
  let handledJump = 0
  let jumping = false
  let viewportAnchor: ReturnType<typeof scrollAnchor> = null
  let anchoredScrollTop = 0
  let noticeError = $state("")
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  let focusedRow = $state<string | undefined>()
  let playingRow = $state<string | undefined>()
  const parkedRows = new SvelteMap<string, number>()
  const observedRows = new Set<HTMLElement>()
  let rowObserver: IntersectionObserver | undefined

  function observeRow(element: HTMLElement, key: string) {
    observedRows.add(element)
    rowObserver?.observe(element)
    return {
      destroy() {
        rowObserver?.unobserve(element)
        observedRows.delete(element)
        parkedRows.delete(key)
      },
    }
  }

  function rowKey(target: EventTarget | null) {
    return target instanceof Element ? (target.closest<HTMLElement>("[data-render-key]"))?.dataset.renderKey : undefined
  }

  function onMediaPlayback(event: Event) {
    if (!(event.target instanceof HTMLMediaElement) || event.target.loop) return
    const key = rowKey(event.target)
    if (event.type === "play") playingRow = key
    else if (playingRow === key) playingRow = undefined
  }

  $effect(() => {
    const target = store.jumpTarget
    void messages
    if (!target || target.chatId !== chatId || target.token === handledJump) return
    handledJump = target.token
    jumping = true
    stickToBottom = target.messageId === 0
    awayFromBottom = !stickToBottom
    store.atBottom.set(chatId, stickToBottom)
    void tick().then(() => {
      if (!mounted || !container || store.jumpTarget?.token !== target.token) {
        if (handledJump === target.token) jumping = false
        return
      }
      if (!target.messageId) container.scrollTop = container.scrollHeight
      else {
        const element = container.querySelector<HTMLElement>(`[data-message-id="${target.messageId}"]`)
        if (element) {
          const box = element.getBoundingClientRect()
          const bounds = container.getBoundingClientRect()
          const center = headerHeight + (container.clientHeight - headerHeight - composerHeight) / 2
          container.scrollTop += box.top - bounds.top + box.height / 2 - center
          container.querySelector(".jump-highlight")?.classList.remove("jump-highlight")
          element.classList.add("jump-highlight")
          clearTimeout(highlightTimer)
          highlightTimer = setTimeout(() => element.classList.remove("jump-highlight"), 3000)
        }
      }
      rememberViewport()
      requestAnimationFrame(() => { if (handledJump === target.token) jumping = false })
    })
  })

  function sameAuthor(first: MsgData | null, second: MsgData | null) {
    return !!first && !!second && first.sender.kind === second.sender.kind && first.sender.id === second.sender.id
      && first.content.kind !== "Event" && second.content.kind !== "Event"
      && first.is_outgoing === second.is_outgoing && Math.abs(first.date - second.date) <= 300
      && new Date(first.date * 1000).toDateString() === new Date(second.date * 1000).toDateString()
  }

  function markVisibleRead() {
    if (!mounted || !entryReady || !isConversationVisible(chatId) || container?.closest("[inert]") || store.readPaused.get(chatId) || !document.hasFocus() || document.visibilityState !== "visible" || !store.chatsReady || store.profileTarget || store.focusedMessage || store.mediaViewer) return
    updateUnreadCounter(chatId, [...visible])
    if (store.skipRead) return
    const ids = [...visible].filter((id) => !read.has(id))
    if (!ids.length) return
    ids.forEach((id) => read.add(id))
    void markMessagesRead(chatId, ids).then((marked) => { if (!marked) ids.forEach((id) => read.delete(id)) }).catch(() => ids.forEach((id) => read.delete(id)))
  }

  function scheduleRead() {
    clearTimeout(readTimer)
    readTimer = setTimeout(markVisibleRead, 100)
  }

  function scrollAnchor() {
    if (!container) return null
    const top = container.getBoundingClientRect().top + headerHeight
    const readingLine = top + Math.min(80, Math.max(0, (container.clientHeight - headerHeight - composerHeight) / 3))
    const rows = container.querySelectorAll<HTMLElement>("[data-message-id]")
    let left = 0
    let right = rows.length
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      if (rows[middle].getBoundingClientRect().bottom > readingLine) right = middle
      else left = middle + 1
    }
    const anchor = rows[left] ?? rows[rows.length - 1]
    if (!anchor) return null
    const bounds = anchor.getBoundingClientRect()
    return bounds.bottom > top ? { id: Number(anchor.dataset.messageId), offset: bounds.top - top } : null
  }

  function restoreAnchor(anchor: { id: number; offset: number }) {
    const element = container?.querySelector<HTMLElement>(`[data-message-id="${anchor.id}"]`)
    if (!container || !element) return false
    container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - headerHeight - anchor.offset
    return true
  }

  function rememberViewport() {
    if (!container) return
    viewportAnchor = stickToBottom ? null : scrollAnchor()
    anchoredScrollTop = container.scrollTop
  }

  function keepViewport() {
    if (!mounted || !entryReady || !container || jumping) return
    const clampedTop = Math.min(anchoredScrollTop, Math.max(0, container.scrollHeight - container.clientHeight))
    if (Math.abs(container.scrollTop - clampedTop) > 1) return
    if (stickToBottom) container.scrollTop = container.scrollHeight
    else if (viewportAnchor) restoreAnchor(viewportAnchor)
    rememberViewport()
    updateFloatingDay()
  }

  async function openMention() {
    if (mentionBusy) return
    mentionBusy = true
    noticeError = ""
    try {
      const id = await api.nextMention(chatId, lastMention)
      if (!mounted) return
      if (id === null) {
        if (!lastMention) store.mentionCounts.set(chatId, 0)
        lastMention = null
        return
      }
      await jumpToMessage(chatId, id, chatId)
      if (mounted) {
        lastMention = id
        beginReading()
      }
    } catch { if (mounted) noticeError = "Не удалось открыть упоминание" }
    finally { mentionBusy = false }
  }

  function updateFloatingDay() {
    if (!container) return
    const top = container.getBoundingClientRect().top + headerHeight
    const sections = container.querySelectorAll<HTMLElement>("[data-message-day]")
    for (const section of sections) {
      if (section.getBoundingClientRect().bottom > top) {
        visibleDay = section.dataset.messageDay ?? null
        return
      }
    }
    visibleDay = sections[sections.length - 1]?.dataset.messageDay ?? null
  }

  function scheduleTrim() {
    if (awayFromBottom || store.historyAtLatest.get(chatId) === false) {
      clearTimeout(trimTimer)
      trimTimer = undefined
      return
    }
    if (trimTimer !== undefined) return
    trimTimer = setTimeout(() => {
      trimTimer = undefined
      trimHistory(chatId)
      const known = new Set((store.messages.get(chatId) ?? []).map((message) => message.id))
      for (const id of read) if (!known.has(id)) read.delete(id)
    }, 15000)
  }

  $effect(() => { if (!store.skipRead && !store.readPaused.get(chatId)) scheduleRead() })

  $effect(() => {
    if (!mounted || initializing || entryReady || historyError || !store.chatsReady || store.stage !== "ready" || store.appLock?.locked || store.appLock?.session_suspended) return
    untrack(() => void initialize())
  })

  async function initialize() {
    if (initializing || !mounted || !store.chatsReady) return
    initializing = true
    entryReady = false
    store.readPaused.set(chatId, true)
    try {
      if (!subscribed) {
        subscribed = true
        try { await openChatFeed(chatId) }
        catch (error) {
          if (subscribed) {
            subscribed = false
            await closeChatFeed(chatId).catch(() => {})
          }
          throw error
        }
      }
      if (!mounted) return
      const saved = store.scrollPositions.get(chatId)
      const restore = saved && store.messages.get(chatId)?.some((message) => message.id === saved.id) && store.jumpTarget?.chatId !== chatId
      const position = restore ? { unreadCount: 0, readThrough: 0, positioned: true } : await prepareHistory(chatId)
      if (!mounted || !position) return
      unreadBoundary = position.unreadCount > 0 ? position.readThrough : null
      await tick()
      if (!mounted || !container) return
      if (position.positioned) {
        stickToBottom = !restore && !position.unreadCount && store.historyAtLatest.get(chatId) !== false
        if (stickToBottom) container.scrollTop = container.scrollHeight
        else if (restore) {
          restoreAnchor(saved)
          if (!saved.readPaused) resumeReading(chatId)
        }
        else {
          const boundary = container.querySelector<HTMLElement>("[data-unread-boundary]")
          if (boundary) container.scrollTop += boundary.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight + composerHeight + 28
        }
        awayFromBottom = !stickToBottom
        store.atBottom.set(chatId, stickToBottom)
      }
      entryReady = true
      rememberViewport()
      scheduleRead()
      if (position.unreadCount > 0 && container.scrollTop < 80) void loadOlder()
    } catch (error) {
      if (mounted && store.chatsReady) store.historyError.set(chatId, String(error))
    } finally {
      initializing = false
    }
  }

  async function loadOlder() {
    if (!container || !entryReady || loadingOlder || store.historyLoading.get(chatId) || store.historyDone.get(chatId)) return
    loadingOlder = true
    try {
      await loadHistory(chatId, true)
    } catch {
      return
    } finally {
      loadingOlder = false
    }
  }

  onMount(() => {
    mounted = true
    if (container) {
      rowObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const element = entry.target as HTMLElement
          if (!observedRows.has(element) || element.dataset.renderKey === undefined) continue
          const key = element.dataset.renderKey
          if (entry.isIntersecting) parkedRows.delete(key)
          else if (!parkedRows.has(key) && entry.boundingClientRect.height > 0) parkedRows.set(key, entry.boundingClientRect.height)
        }
      }, { root: container, rootMargin: "900px 0px" })
      observedRows.forEach((element) => rowObserver?.observe(element))
    }
    retainHistory(chatId)
    store.historyError.delete(chatId)
    store.readPaused.set(chatId, true)
    store.atBottom.set(chatId, false)
    window.addEventListener("focus", scheduleRead)
    document.addEventListener("visibilitychange", scheduleRead)
    return () => {
      if (entryReady && store.stage === "ready" && awayFromBottom) {
        const anchor = scrollAnchor()
        if (anchor) store.scrollPositions.set(chatId, { ...anchor, readPaused: store.readPaused.get(chatId) ?? false })
      } else store.scrollPositions.delete(chatId)
      mounted = false
      clearTimeout(readTimer)
      clearTimeout(highlightTimer)
      clearTimeout(trimTimer)
      rowObserver?.disconnect()
      store.atBottom.delete(chatId)
      store.readPaused.delete(chatId)
      if (store.jumpTarget?.chatId === chatId && store.jumpTarget.token === handledJump) store.jumpTarget = null
      window.removeEventListener("focus", scheduleRead)
      document.removeEventListener("visibilitychange", scheduleRead)
      if (subscribed) {
        subscribed = false
        void closeChatFeed(chatId).catch(() => {})
      }
      releaseHistory(chatId)
    }
  })

  $effect(() => {
    void messages.length
    void entryReady
    void headerHeight
    void composerHeight
    void store.historyLoaded.get(chatId)
    void store.historyLoading.get(chatId)
    void loadingOlder
    if (historyError) return
    void tick().then(() => {
      if (!mounted || !entryReady || !container) return
      keepViewport()
      if (messages.length && store.historyLoaded.get(chatId) && container.scrollHeight <= container.clientHeight + 1) void loadOlder()
    })
  })

  $effect(() => {
    const list = messages
    void composerHeight
    if (!container) return
    const observer = new ResizeObserver(keepViewport)
    observer.observe(container)
    let disposed = false
    void tick().then(() => {
      if (disposed || !container) return
      for (const element of container.querySelectorAll<HTMLElement>("[data-message-id]")) observer.observe(element)
      if (stickToBottom && list.length > 100) untrack(scheduleTrim)
    })
    return () => {
      disposed = true
      observer.disconnect()
    }
  })

  $effect(() => {
    void messages
    if (!container) return
    visible.clear()
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.messageId)
        if (entry.isIntersecting) visible.add(id)
        else visible.delete(id)
      }
      scheduleRead()
    }, { root: container, rootMargin: `-${headerHeight}px 0px -${composerHeight}px 0px`, threshold: 0 })
    let disposed = false
    void tick().then(() => {
      if (!disposed && container) {
        container.querySelectorAll('[data-message-id][data-incoming="true"]').forEach((element) => observer.observe(element))
      }
    })
    return () => {
      disposed = true
      observer.disconnect()
    }
  })

  function onScroll() {
    updateFloatingDay()
    if (!container || !entryReady || jumping) return
    const bottomGap = container.scrollHeight - container.scrollTop - container.clientHeight
    stickToBottom = bottomGap <= 2 && store.historyAtLatest.get(chatId) !== false
    awayFromBottom = !stickToBottom
    store.atBottom.set(chatId, stickToBottom)
    rememberViewport()
    scheduleTrim()
    if (bottomGap < 60 && store.historyAtLatest.get(chatId) === false && !historyError) void loadNewerHistory(chatId)
    if (container.scrollTop < 80 && !historyError && store.historyLoaded.get(chatId)) void loadOlder()
  }

  function retryHistory() {
    if (!entryReady) void initialize()
    else if (container && store.historyAtLatest.get(chatId) === false && container.scrollHeight - container.scrollTop - container.clientHeight < 60) void loadNewerHistory(chatId)
    else void loadOlder()
  }

  function onWheel(event: WheelEvent) {
    if (event.deltaY > 0) {
      beginReading()
      if (container && store.historyAtLatest.get(chatId) === false && container.scrollHeight - container.scrollTop - container.clientHeight < 60 && !historyError) void loadNewerHistory(chatId)
    }
    if (event.deltaY >= 0) return
    clearTimeout(trimTimer)
    trimTimer = undefined
    stickToBottom = false
    scheduleTrim()
    if (container && container.scrollTop < 80 && !historyError) void loadOlder()
  }

  function beginReading() {
    if (!entryReady) return
    resumeReading(chatId)
    scheduleRead()
  }

  function pointerDown(event: PointerEvent) {
    touchY = event.pointerType === "touch" ? event.clientY : null
    if (event.target instanceof HTMLElement && !event.target.closest("button,a,input,textarea,video,audio")) container?.focus({ preventScroll: true })
    if (container && event.target === container && event.offsetX >= container.clientWidth) beginReading()
  }

  function pointerMove(event: PointerEvent) {
    if (event.pointerType === "touch" && touchY !== null && event.clientY < touchY - 4) {
      beginReading()
      touchY = null
    }
  }

  function scrollKey(event: KeyboardEvent) {
    if (event.target === container && !event.shiftKey && ["ArrowDown", "PageDown", "End", " "].includes(event.key)) beginReading()
  }
</script>

<svelte:window onkeydown={scrollKey} />

<div class="messages" role="region" aria-label="Сообщения" tabindex="-1" bind:this={container} style:--header-height={`${headerHeight}px`} style:--composer-height={`${composerHeight}px`} onscroll={onScroll} onwheel={onWheel} onpointerdown={pointerDown} onpointermove={pointerMove} onfocusin={(event) => focusedRow = rowKey(event.target)} onfocusout={(event) => focusedRow = rowKey(event.relatedTarget)} onplaycapture={onMediaPlayback} onpausecapture={onMediaPlayback} onendedcapture={onMediaPlayback}>
  {#if historyError}
    <div class="history-error" role="alert">{historyError}</div>
    <button class="retry" onclick={retryHistory}>Повторить</button>
  {/if}
  {#if messages.length === 0 && !store.historyLoading.get(chatId) && !historyError}
    <div class="empty">Сообщений пока нет — напиши первым!</div>
  {:else}
    {#each days as day (day.key)}
      <section class="message-day" data-message-day={day.key} aria-label={new Date(day.date * 1000).toLocaleDateString("ru")}>
        <div class="date-divider glass" class:current-day={day.key === floatingDay?.key}>{new Date(day.date * 1000).toLocaleDateString("ru", { day: "numeric", month: "long" })}</div>
    {#each day.entries as { msg, index: i } (messageRenderKey(msg))}
      {@const key = messageRenderKey(msg)}
      {@const target = store.jumpTarget}
      {@const parkedHeight = key === playingRow || key === focusedRow || target?.chatId === chatId && target.messageId === msg.id ? undefined : parkedRows.get(key)}
      {#if msg.id === firstUnread}<div class="unread-divider" data-unread-boundary>Новые сообщения</div>{/if}
      <div class="message-row" data-message-id={msg.id} data-render-key={key} data-incoming={!msg.is_outgoing} use:observeRow={key} style:height={parkedHeight === undefined ? undefined : `${parkedHeight}px`}>
        {#if parkedHeight === undefined}
          {#if msg.content.kind === "Event"}
            <div class="service-event">
              {#if msg.content.data.message_id > 0}
                <button onclick={() => {
                  noticeError = ""
                  if (msg.content.kind === "Event") void jumpToMessage(msg.chat_id, msg.content.data.message_id, chatId).catch(() => noticeError = "Сообщение недоступно")
                }}>{chatEventText(msg, messageSender(msg))}</button>
              {:else}{chatEventText(msg, messageSender(msg))}{/if}
            </div>
          {:else}
            {@const groupedBefore = sameAuthor(messages[i - 1] ?? null, msg)}
            {@const groupedAfter = sameAuthor(msg, messages[i + 1] ?? null)}
            <MessageBubble {msg} {groupedBefore} {groupedAfter} conversationKey={chatId} animateEntry={entryReady && isLiveMessage(msg) && store.historyAtLatest.get(chatId) !== false} showAuthor={group && !msg.is_outgoing && !groupedBefore} showAvatar={group && !msg.is_outgoing ? !groupedAfter : undefined} />
          {/if}
        {/if}
      </div>
    {/each}
      </section>
    {/each}
  {/if}
</div>
{#if floatingDay}
  <div class="date-divider floating-date glass">{new Date(floatingDay.date * 1000).toLocaleDateString("ru", { day: "numeric", month: "long" })}</div>
{/if}
{#if awayFromBottom || store.historyAtLatest.get(chatId) === false}
  <button class="latest" aria-label="К последним сообщениям" onclick={() => {
    beginReading()
    stickToBottom = true
    awayFromBottom = false
    store.atBottom.set(chatId, true)
    void returnToLatest(chatId).then(() => {
      scheduleTrim()
    }).catch(() => {
      stickToBottom = false
      awayFromBottom = true
      store.atBottom.set(chatId, false)
    })
  }}><Icon name="nav-arrow-down" size={23} />{#if store.newMessageCounts.get(chatId)}<span class="new-count">{store.newMessageCounts.get(chatId)}</span>{/if}</button>
{/if}
{#if mentionCount > 0}
  <button class="latest mention-jump" class:above-latest={awayFromBottom || store.historyAtLatest.get(chatId) === false} aria-label={`Упоминания: ${mentionCount}`} disabled={mentionBusy} onclick={openMention}>@<span class="new-count">{mentionCount}</span></button>
{/if}
{#if noticeError}<div class="latest notice-error" role="alert">{noticeError}<button aria-label="Скрыть ошибку" onclick={() => noticeError = ""}>×</button></div>{/if}

<style>
  .message-day { position: relative; display: flex; flex-direction: column; align-self: stretch; flex-shrink: 0; min-width: 0 }
  .message-row { display: flex; flex-direction: column; flex-shrink: 0; min-width: 0 }
  .unread-divider { align-self: stretch; margin: 10px 0; padding: 5px; text-align: center; color: var(--accent-hover); background: var(--accent-soft); border-radius: 8px; font-size: 11px }
  .service-event { align-self: center; max-width: 85%; padding: 5px 12px; margin: 8px 0; color: var(--text-secondary); font-size: 12px; text-align: center; line-height: 1.5; border-radius: 14px; background: rgba(18,28,43,.64) }
  .service-event button { padding: 0; font: inherit; color: inherit }
  .service-event button:hover { color: var(--accent-hover) }
  .latest { position: relative; grid-area: 2 / 1; align-self: end; justify-self: end; z-index: 2; margin: 0 20px 12px 0; border-radius: 50%; display: grid; place-items: center; width: 43px; height: 43px; font-size: 12px; color: var(--text-secondary); background: var(--menu-bg); box-shadow: 0 3px 18px rgba(0,0,0,.3); backdrop-filter: blur(var(--glass-blur)) }
  .new-count { position: absolute; top: -7px; right: -4px; min-width: 19px; padding: 3px 5px; border-radius: 10px; background: var(--accent); color: var(--text-on-accent); font-size: 10px }
  .mention-jump { color: var(--accent-hover); font-size: 23px }
  .mention-jump.above-latest { margin-bottom: 65px }
  .notice-error { color: var(--danger); width: auto; height: auto; padding: 10px 14px; border-radius: 16px; display: flex }
  .notice-error button { margin-left: 8px; color: inherit }
  .message-row:global(.jump-highlight) :global(.bubble), .message-row:global(.jump-highlight) .service-event { filter: brightness(1.3); box-shadow: 0 0 24px rgba(77,153,255,.42) !important; transition: filter .15s, box-shadow .15s }
  .messages {
    grid-area: 1 / 1 / -1 / 2;
    min-height: 0;
    z-index: 0;
    overflow-y: auto;
    overflow-anchor: none;
    padding: calc(var(--header-height) + 22px) 22px calc(var(--composer-height) + 12px);
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .history-error {
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
    align-self: center;
  }
  .retry {
    align-self: center;
    color: var(--accent);
    padding: 6px 12px;
  }
  .date-divider {
    flex-shrink: 0;
    align-self: center;
    background: rgba(25,30,40,.6);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 10px;
    padding: 6px 13px;
    border-radius: 20px;
    margin: 2px 0 14px;
  }
  .date-divider.current-day { visibility: hidden }
  .floating-date { position: relative; grid-area: 2 / 1; align-self: start; justify-self: center; z-index: 1; margin: 7px 0 0; pointer-events: none }
  .empty {
    margin: auto;
    color: var(--text-secondary);
  }
</style>
