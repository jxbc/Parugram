<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import { tick } from "svelte"
  import { store, api, activeChat, chatMuted, setChatMuted, goBackChat, compactView, canSplitView, openProfile, jumpToMessage, messageSender, messageText, closeRightPanel, replyPreview, requestMessages } from "$lib/stores/app.svelte"
  import Avatar from "$lib/components/Avatar.svelte"
  import ProfilePanel from "$lib/components/ProfilePanel.svelte"
  import type { ProfileData, SenderData, MsgData } from "$lib/api/td"
  import MessageList from "./MessageList.svelte"
  import Composer from "./Composer.svelte"
  import { chatActivityText, formatTime, messagePreview } from "$lib/utils"

  let { conversationKey = null, secondary = false }: { conversationKey?: number | null; secondary?: boolean } = $props()
  const viewKey = $derived(conversationKey ?? store.activeChatId)
  const conversation = $derived(viewKey !== null ? store.conversations.get(viewKey) : null)
  const threadId = $derived(conversation?.threadId)
  const chat = $derived(activeChat(viewKey))
  const chatId = $derived(chat?.id)
  const muted = $derived(chat ? chatMuted(chat) : false)
  let actionsControl: HTMLDivElement | undefined = $state()
  let actionsTrigger: HTMLButtonElement | undefined = $state()
  let actionsChatId = $state<number>()
  let actionsError = $state("")
  const actionsOpen = $derived(actionsChatId !== undefined && actionsChatId === chatId)
  let headerHeight = $state(52)
  let composerHeight = $state(59)
  let windowWidth = $state(0)
  let details = $state<ProfileData | null>(null)
  let detailsLoading = $state(false)
  let detailsError = $state("")
  let onlineOpen = $state(false)
  let onlineLoading = $state(false)
  let onlineError = $state("")
  let onlineMembers = $state<SenderData[]>([])
  let onlineRequest = 0
  let searchControl: HTMLDivElement | undefined = $state()
  let searchInput: HTMLInputElement | undefined = $state()
  let searchOpen = $state(false)
  let searchQuery = $state("")
  let searchResults = $state<MsgData[]>([])
  let searchTotal = $state(0)
  let searchLoading = $state(false)
  let searchError = $state("")
  let searchMore = $state(false)
  let searchCursor = 0
  let searchRequest = 0
  let pins = $state<MsgData[]>([])
  let pinIndex = $state(0)
  let pinTotal = $state(0)
  let pinCursor = 0
  let pinBusy = $state(false)
  let pinError = $state("")
  let pinRequest = 0
  const pinned = $derived(pins[pinIndex] ? replyPreview(pins[pinIndex].chat_id, pins[pinIndex].id) ?? pins[pinIndex] : null)
  const plurals = new Intl.PluralRules("ru")
  const count = $derived(chatId ? store.onlineCounts.get(chatId) : undefined)
  const activity = $derived(chatActivityText(chatId ? store.chatActivity.get(chatId) ?? [] : [], chat?.is_group ?? false))
  const status = $derived(chat?.is_group
    ? details ? `${details.member_count.toLocaleString("ru")} ${plurals.select(details.member_count) === "one" ? "участник" : plurals.select(details.member_count) === "few" ? "участника" : "участников"} (${count || "…"} в сети)` : "Загрузка..."
    : details?.status === "канал" ? `${details.member_count.toLocaleString("ru")} подписчиков` : details?.status ?? "")

  $effect(() => {
    const id = chatId
    const thread = threadId
    const account = store.user?.id
    void (id ? store.pinnedRevisions.get(id) : undefined)
    const request = ++pinRequest
    pins = []
    pinIndex = 0
    pinTotal = 0
    pinCursor = 0
    pinBusy = false
    pinError = ""
    if (!id || !store.chatsReady) return
    pinBusy = true
    void requestMessages(() => api.pinnedMessages(id, thread), true, () => request === pinRequest).then((data) => {
      if (request !== pinRequest || store.user?.id !== account) return
      pins = data.messages.filter((message) => !message.is_deleted)
      for (const message of pins) store.replyPreviews.set(`${message.chat_id}:${message.id}`, message)
      pinTotal = Math.max(data.total_count, pins.length)
      pinCursor = data.next_from_message_id
    }).catch(() => { if (request === pinRequest) pinError = "Не удалось загрузить закреплённые" })
      .finally(() => { if (request === pinRequest) pinBusy = false })
    return () => { pinRequest += 1 }
  })

  async function nextPin() {
    if (pinBusy || !chatId) return
    if (pinIndex + 1 < pins.length) { pinIndex += 1; return }
    if (!pinCursor) { pinIndex = 0; return }
    const request = pinRequest
    const cursor = pinCursor
    pinBusy = true
    pinError = ""
    try {
      const id = chatId
      const thread = threadId
      const data = await requestMessages(() => api.pinnedMessages(id, thread, cursor), true, () => request === pinRequest)
      if (request !== pinRequest) return
      const known = new Set(pins.map((message) => message.id))
      const added = data.messages.filter((message) => !message.is_deleted && !known.has(message.id))
      for (const message of added) store.replyPreviews.set(`${message.chat_id}:${message.id}`, message)
      pins = [...pins, ...added]
      pinCursor = added.length && data.next_from_message_id !== cursor ? data.next_from_message_id : 0
      pinTotal = Math.max(data.total_count, pins.length)
      pinIndex = added.length ? pinIndex + 1 : 0
    } catch { if (request === pinRequest) pinError = "Не удалось загрузить закреплённые" }
    finally { if (request === pinRequest) pinBusy = false }
  }

  function openPin() {
    if (!pinned) return
    pinError = ""
    void jumpToMessage(pinned.chat_id, pinned.id, viewKey ?? undefined).catch(() => pinError = "Сообщение недоступно")
  }

  $effect(() => {
    const id = chatId
    let disposed = false
    details = null
    detailsError = ""
    onlineOpen = false
    onlineLoading = false
    onlineError = ""
    onlineMembers = []
    onlineRequest += 1
    if (!id) return
    detailsLoading = true
    void api.getProfile({ kind: "chat", id }).then((profile) => {
      if (!disposed) details = profile
    }).catch((failure) => {
      if (!disposed) detailsError = String(failure)
    }).finally(() => { if (!disposed) detailsLoading = false })
    return () => { disposed = true }
  })

  $effect(() => {
    void chatId
    searchOpen = false
    searchQuery = ""
    actionsChatId = undefined
    actionsError = ""
  })

  $effect(() => {
    const id = chatId
    const query = searchQuery.trim()
    searchRequest += 1
    searchResults = []
    searchTotal = 0
    searchCursor = 0
    searchMore = false
    searchError = ""
    searchLoading = false
    if (!searchOpen || !id || !query || !store.chatsReady) return
    searchLoading = true
    const timer = setTimeout(() => void findMessages(true), 250)
    return () => {
      clearTimeout(timer)
      searchRequest += 1
    }
  })

  async function findMessages(reset = false) {
    const id = chatId
    const query = searchQuery.trim()
    if (!id || !query || !searchOpen || !store.chatsReady || searchLoading && !reset) return
    const token = ++searchRequest
    const account = store.user?.id
    const cursor = reset ? 0 : searchCursor
    searchLoading = true
    searchError = ""
    try {
      const result = await api.searchMessages(id, query, cursor)
      if (token !== searchRequest || chatId !== id || store.user?.id !== account) return
      const current = reset ? [] : searchResults
      const known = new Set(current.map((message) => message.id))
      searchResults = [...current, ...result.messages.filter((message) => !known.has(message.id))]
      searchTotal = result.total_count
      searchMore = result.messages.length > 0 && result.next_from_message_id !== 0 && result.next_from_message_id !== cursor
      searchCursor = result.next_from_message_id
    } catch {
      if (token === searchRequest) searchError = "Не удалось выполнить поиск"
    } finally {
      if (token === searchRequest) searchLoading = false
    }
  }

  function toggleSearch() {
    searchOpen = !searchOpen
    if (searchOpen) void tick().then(() => searchInput?.focus())
  }

  function headerOutside(event: PointerEvent) {
    if (!(event.target instanceof Node)) return
    if (searchOpen && !searchControl?.contains(event.target)) searchOpen = false
    if (actionsOpen && !actionsControl?.contains(event.target)) actionsChatId = undefined
  }

  function headerKeys(event: KeyboardEvent) {
    if (event.key === "Escape" && (searchOpen || actionsOpen)) {
      event.preventDefault()
      searchOpen = false
      if (actionsOpen) {
        actionsChatId = undefined
        actionsTrigger?.focus()
      }
    }
  }

  async function toggleNotifications() {
    const id = chatId
    if (id === undefined || store.chatMutePending.has(id)) return
    actionsError = ""
    try {
      await setChatMuted(id, !muted)
      if (actionsChatId === id) {
        actionsChatId = undefined
        actionsTrigger?.focus()
      }
    } catch {
      if (actionsChatId === id) actionsError = "Не удалось изменить уведомления"
    }
  }

  async function openSearchResult(message: MsgData) {
    searchError = ""
    try {
      await jumpToMessage(message.chat_id, message.id)
      searchOpen = false
    } catch { searchError = "Сообщение недоступно" }
  }

  async function showOnline() {
    const id = chatId
    if (!id || !chat?.is_group) return
    onlineOpen = true
    if (onlineLoading) return
    onlineError = ""
    onlineLoading = true
    const request = ++onlineRequest
    try {
      const members = await api.profileMembers(id, 0, true)
      if (request === onlineRequest && chatId === id) onlineMembers = members
    } catch {
      if (request === onlineRequest && chatId === id) onlineError = "Список участников недоступен"
    } finally {
      if (request === onlineRequest && chatId === id) onlineLoading = false
    }
  }
</script>

<svelte:window bind:innerWidth={windowWidth} onpointerdown={headerOutside} onkeydown={headerKeys} />

<main class="chat-view" class:main-view={!secondary} data-conversation-key={viewKey}>
  {#if chat}
    <div class="chat-wallpaper" class:soft-edges={store.customization.softEdges} aria-hidden="true"></div>
    <div class="chat-header" bind:offsetHeight={headerHeight}>
    <div class="header-row">
    <header class="header">
      <div class="header-surface glass glowing-panel" aria-hidden="true"></div>
      {#if !secondary && (compactView() || store.chatBackStack.length)}<button class="icon-button" aria-label="Назад" title="Назад (Alt+←)" onclick={goBackChat}><Icon name="nav-arrow-left" size={20} /></button>{/if}
      <button class="chat-avatar" aria-label="Открыть профиль чата" onclick={() => openProfile({ kind: "chat", id: chat.id })}><Avatar id={chat.id} title={chat.title} fileId={chat.photo_file_id} path={chat.photo} size={36} /></button>
      <div class="chat-title">
        <button class="name" onclick={() => openProfile({ kind: "chat", id: chat.id })}>{conversation?.title || chat.title || "Без названия"}</button>
        <div class="presence-control" role="group" aria-label="Участники в сети" onpointerenter={() => void showOnline()} onpointerleave={() => onlineOpen = false} onfocusout={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) onlineOpen = false }}>
          <button class="status" class:has-activity={!!activity} aria-expanded={chat.is_group ? onlineOpen : undefined} onclick={() => chat.is_group ? void showOnline() : void openProfile({ kind: "chat", id: chat.id })} onfocus={() => void showOnline()}>{#if activity}<span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span>{activity}{:else}{status}{/if}</button>
          {#if onlineOpen && chat.is_group}
            <div class="online-dropdown glass">
              {#if onlineLoading}<span class="presence-empty">Загрузка...</span>
              {:else if onlineError}<span class="presence-empty">{onlineError}</span>
              {:else}{#each onlineMembers as member (member.id)}<button onclick={() => openProfile({ kind: member.kind, id: member.id })}><Avatar id={member.id} title={member.name} fileId={member.photo_file_id} path={member.photo} size={28} /><span>{member.name}</span></button>{:else}<span class="presence-empty">Нет доступных участников в сети</span>{/each}{/if}
            </div>
          {/if}
        </div>
      </div>
      <button class="icon-button header-open" aria-label="Информация о чате" onclick={() => openProfile({ kind: "chat", id: chat.id })}><Icon name="nav-arrow-right" size={17} /></button>
      {#if secondary}<button class="icon-button" aria-label="Закрыть правый чат" onclick={closeRightPanel}><Icon name="xmark" size={20} /></button>{:else}
      <div class="search-control" bind:this={searchControl}>
        <button class="icon-button" class:search-active={searchOpen} aria-label={searchOpen ? "Закрыть поиск" : "Поиск по сообщениям"} aria-expanded={searchOpen} aria-controls="chat-message-search" onclick={toggleSearch}><Icon name={searchOpen ? "xmark" : "search"} size={20} /></button>
        {#if searchOpen}
          <section id="chat-message-search" class="chat-search glass" aria-label="Поиск по сообщениям">
            <form class="chat-search-field" onsubmit={(event) => {
              event.preventDefault()
              void findMessages(true)
            }}><Icon name="search" size={17} /><input bind:this={searchInput} bind:value={searchQuery} placeholder="Поиск по сообщениям" aria-label="Поиск по сообщениям" maxlength={512} /></form>
            {#if searchResults.length}<span class="search-count">Найдено: {searchTotal}</span>{/if}
            <div class="search-results">
              {#each searchResults as message (message.id)}
                <button class="search-result" onclick={() => openSearchResult(message)}><span><strong>{messageSender(message).name || chat.title}</strong><time>{formatTime(message.date)}</time></span><span class="result-preview">{messageText(message) || messagePreview(message.content)}</span></button>
              {/each}
              {#if searchLoading}<span class="search-empty">Поиск...</span>
              {:else if searchError}<button class="search-empty" onclick={() => findMessages(searchResults.length === 0)}>{searchError}. Повторить</button>
              {:else if searchQuery.trim() && !searchResults.length}<span class="search-empty">Ничего не найдено</span>
              {:else if searchMore}<button class="search-more" onclick={() => findMessages()}>Ещё</button>{/if}
            </div>
          </section>
        {/if}
      </div>
      {/if}
    </header>
      <div class="actions-control" bind:this={actionsControl}>
        <button class="icon-button actions-trigger" class:search-active={actionsOpen} bind:this={actionsTrigger} aria-label="Действия чата" aria-expanded={actionsOpen} onclick={() => {
          actionsError = ""
          actionsChatId = actionsOpen ? undefined : chatId
        }}>
          <span class="header-surface glass glowing-panel" aria-hidden="true"></span>
          <svg width="19" height="19" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="2.1" /><circle cx="10" cy="10" r="2.1" /><circle cx="16" cy="10" r="2.1" /></svg>
        </button>
        {#if actionsOpen}
          <div class="chat-actions glass">
            {#if store.chatWindowId === null && !canSplitView() && !secondary}
              <button disabled={!store.chatsReady} onclick={async () => {
                try {
                  await api.openChatWindow(chat.id)
                  actionsChatId = undefined
                } catch (error) {
                  actionsError = String(error)
                }
              }}><Icon name="arrow-up-right" size={17} />Открыть в новом окне</button>
            {/if}
            <button disabled={!store.chatsReady || store.chatMutePending.has(chat.id)} onclick={toggleNotifications}><Icon name={muted ? "bell" : "bell-off"} size={17} />{muted ? "Включить уведомления" : "Выключить уведомления"}</button>
            {#if actionsError}<span role="status">{actionsError}</span>{/if}
          </div>
        {/if}
      </div>
    </div>
    {#if pinned || pinError}
      <div class="pinned-bar glass glowing-panel">
        <Icon name="pin" size={16} />
        {#if pinned}
          <button class="pin-preview" onclick={openPin}><span class="pin-label" class:error={!!pinError}>{pinError || "Закреплённое сообщение"}{#if !pinError && pinTotal > 1}<span>{pinIndex + 1} / {pinTotal}</span>{/if}</span><span class="pin-text">{messageText(pinned) || messagePreview(pinned.content)}</span></button>
          {#if pinTotal > 1}<button class="icon-button pin-nav" aria-label="Предыдущее закреплённое" disabled={pinBusy || pinIndex === 0} onclick={() => pinIndex -= 1}><Icon name="nav-arrow-left" size={15} /></button><button class="icon-button pin-nav" aria-label="Следующее закреплённое" disabled={pinBusy} onclick={nextPin}><Icon name="nav-arrow-right" size={15} /></button>{/if}
        {:else}<span class="pin-failure">{pinError}</span><button class="pin-retry" onclick={() => { if (chatId) store.pinnedRevisions.set(chatId, (store.pinnedRevisions.get(chatId) ?? 0) + 1) }}>Повторить</button>{/if}
      </div>
    {/if}
    </div>

    {#key viewKey}
      <MessageList chatId={viewKey ?? chat.id} {headerHeight} {composerHeight} />
      <div class="compose-area" bind:offsetHeight={composerHeight}>
        <Composer chatId={viewKey ?? chat.id} />
      </div>
    {/key}
  {:else}
    <div class="placeholder">
      <img class="placeholder-art" src="/chat-placeholder.png" alt="" width="192" height="192" draggable="false" />
      <h2>Parugram</h2>
      <p>Выберите диалог</p>
    </div>
  {/if}
</main>

{#if store.chatWindowId === null && !secondary && !store.rightPanel && chat && windowWidth >= 1360}<ProfilePanel embedded {details} {detailsLoading} {detailsError} />{/if}

<style>
  .chat-header { grid-area: 1 / 1; z-index: 2; display: flex; flex-direction: column; gap: 6px; min-width: 0 }
  .header-row { display: flex; align-items: center; gap: 6px; min-width: 0 }
  .pinned-bar { display: flex; align-items: center; gap: 9px; min-height: 38px; padding: 4px 13px; border-radius: 20px; color: var(--accent-hover) }
  .pin-preview { flex: 1; min-width: 0; padding: 0; text-align: left; display: grid; gap: 2px }
  .pin-label { display: flex; gap: 8px; align-items: center; font-size: 10px; color: var(--accent-hover) }
  .pin-label > span { color: var(--text-secondary); font-size: 9px }
  .pin-label.error, .pin-failure { color: var(--danger) }
  .pin-text { color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; line-height: 1.2 }
  .pin-nav { width: 25px; height: 25px }
  .pin-nav:disabled { opacity: .35 }
  .pin-failure { flex: 1; font-size: 11px }
  .pin-retry { color: var(--accent-hover); font-size: 11px; padding: 0 }
  .chat-view {
    --glass-filter: blur(var(--glass-blur)) brightness(1.05) saturate(1.65);
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr) auto;
    overflow: hidden;
    min-width: 0;
    position: relative;
    isolation: isolate;
    container-type: inline-size;
  }
  .chat-wallpaper { position: absolute; inset: 0; z-index: -1; opacity: var(--wallpaper-opacity, .8); pointer-events: none; overflow: hidden; border-radius: 26px }
  .chat-wallpaper::before, .chat-wallpaper::after { content: ""; position: absolute; inset: 0; background-image: var(--chat-wallpaper, none); background-size: cover; background-position: center }
  .chat-wallpaper::before { display: none }
  .chat-wallpaper.soft-edges::before { display: block; filter: blur(24px); opacity: .5; mask-image: radial-gradient(ellipse at center, #000 35%, transparent 75%) }
  .chat-wallpaper.soft-edges::after { -webkit-mask-image: linear-gradient(to right, transparent, #000 9%, #000 91%, transparent), linear-gradient(to bottom, transparent, #000 8%, #000 92%, transparent); mask-image: linear-gradient(to right, transparent, #000 9%, #000 91%, transparent), linear-gradient(to bottom, transparent, #000 8%, #000 92%, transparent); -webkit-mask-composite: source-in; mask-composite: intersect }
  :global(.app[data-effects="reduced"]) .chat-wallpaper::before { display: none }
  .search-control, .actions-control { position: relative; flex-shrink: 0 }
  .actions-control { z-index: 3 }
  .actions-trigger { position: relative; isolation: isolate; width: 44px; height: 44px }
  .actions-trigger .header-surface { inset: 2px }
  .actions-trigger:hover, .actions-trigger.search-active { background: transparent; color: var(--text-primary) }
  .chat-actions { position: absolute; top: calc(100% + 9px); right: 0; z-index: 6; width: max-content; max-width: calc(100vw - 40px); padding: 5px; border-radius: 14px; background: var(--menu-bg); animation: appear .16s ease-out }
  .chat-actions button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border-radius: 9px; text-align: left; font-size: 13px }
  .chat-actions button:hover { background: var(--hover) }
  .chat-actions span[role="status"] { display: block; padding: 3px 8px; color: var(--danger); font-size: 11px }
  .search-active { color: var(--accent-hover); background: var(--accent-soft) }
  .chat-search { position: absolute; right: 0; top: calc(100% + 13px); width: min(360px, calc(100cqw - 24px)); max-height: min(500px, 65vh); display: flex; flex-direction: column; gap: 9px; padding: 10px; border-radius: 22px; background: var(--menu-bg); box-shadow: 0 16px 45px rgba(0,0,0,.3); animation: appear .15s ease-out }
  .chat-search-field { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px; border-radius: 22px; color: var(--text-secondary); background: var(--bg-input) }
  .chat-search-field input { width: 100%; min-width: 0; padding: 9px 0; font-size: 13px; background: transparent }
  .search-count { color: var(--text-secondary); font-size: 11px; padding: 0 6px }
  .search-results { min-height: 0; overflow-y: auto }
  .search-result { display: grid; gap: 5px; padding: 10px; width: 100%; border-radius: 13px; text-align: left }
  .search-result:hover { background: var(--hover) }
  .search-result > span:first-child { display: flex; align-items: center; justify-content: space-between; gap: 8px }
  .search-result strong { min-width: 0; font-size: 12px; font-weight: 500; color: var(--accent-hover); overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .search-result time { font-size: 10px; color: var(--text-tertiary); white-space: nowrap }
  .result-preview { font-size: 12px; line-height: 1.4; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere }
  .search-empty { display: block; padding: 12px 6px; font-size: 12px; color: var(--text-secondary); text-align: left }
  .search-more { display: block; margin: 5px auto; padding: 7px 12px; font-size: 12px; color: var(--accent-hover) }
  .header {
    z-index: 2;
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
    gap: 10px;
    padding: 7px 14px;
    border-radius: 30px;
    border: 1px solid transparent;
  }
  .header-surface { position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none }
  .compose-area { grid-area: 3 / 1; z-index: 2; min-width: 0 }
  .chat-avatar { padding: 0; border-radius: 50% }
  .chat-title { min-width: 0; flex: 1 }
  .header-open { margin-left: auto }
  @container (max-width: 480px) {
    .header { gap: 6px; padding-inline: 8px }
    .header-open { display: none }
    .online-dropdown { left: auto; right: 0; width: min(260px, 76cqw) }
  }
  .presence-control { position: relative; width: fit-content; max-width: 100% }
  .presence-control::after { content: ""; position: absolute; top: 100%; left: 0; right: 0; height: 12px }
  .online-dropdown { position: absolute; top: calc(100% + 9px); left: -10px; z-index: 5; width: 260px; max-height: 310px; overflow-y: auto; padding: 6px; border-radius: 17px; background: var(--menu-bg); animation: appear .16s ease-out }
  .online-dropdown button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px; border-radius: 12px; text-align: left; font-size: 13px }
  .online-dropdown button:hover { background: var(--hover) }
  .presence-empty { display: block; padding: 10px; font-size: 12px; color: var(--text-secondary) }
  .name {
    display: block;
    max-width: 100%;
    padding: 0;
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    display: block;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0;
    font-size: 11px;
    color: var(--text-secondary);
    margin-top: 3px;
  }
  .status.has-activity { color: var(--accent-hover) }
  .activity-dots { display: inline-flex; align-items: center; gap: 2px; height: 9px; margin-right: 6px; vertical-align: middle }
  .activity-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; animation: activity-bounce .8s ease-in-out infinite alternate }
  .activity-dots i:nth-child(2) { animation-delay: .16s }
  .activity-dots i:nth-child(3) { animation-delay: .32s }
  @keyframes activity-bounce { to { transform: translateY(-3px); opacity: .4 } }
  .placeholder {
    grid-area: 1 / 1 / -1 / 2;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-secondary);
  }
  .placeholder-art { display: block; width: 160px; max-width: 50%; height: auto; object-fit: contain }
  .placeholder h2 { color: var(--text-primary); font-size: 22px; font-weight: 500; margin: 16px 0 0; letter-spacing: -.5px }
  .placeholder p { font-size: 12px; margin: 2px 0 }
</style>
