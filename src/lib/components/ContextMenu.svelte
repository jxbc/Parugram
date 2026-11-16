<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import { tick } from "svelte"
  import MessageBubble from "$lib/components/chat/MessageBubble.svelte"
  import { store, api, appendMessage, messageText, replyToMessage, editMessage, focusMessage, closeMessageOverlays, openProfile, openConversation, deleteMessages, canSplitView, openSplitChat, visibleChat } from "$lib/stores/app.svelte"
  import type { ChatSummary, ContextTarget, MessageActions, MsgData, ReactionData, SenderData, UserPayload } from "$lib/api/td"
  import Avatar from "$lib/components/Avatar.svelte"
  import ReactionIcon from "$lib/components/ReactionIcon.svelte"
  import { canDownloadMessage, downloadMessage, recentReactionSenders, senderDetails, toggleReaction } from "$lib/stores/app.svelte"

  let popup: HTMLDivElement | undefined = $state()
  let reactionPicker: HTMLDivElement | undefined = $state()
  let focusPanel: HTMLDivElement | undefined = $state()
  let focusCard: HTMLDivElement | undefined = $state()
  let focusActions: HTMLDivElement | undefined = $state()
  let focusPreview: HTMLDivElement | undefined = $state()
  let focusContent: HTMLDivElement | undefined = $state()
  let focusFitted = $state(false)
  let confirmation: HTMLDialogElement | undefined = $state()
  let permissions = $state<MessageActions | null>(null)
  let permissionError = $state("")
  let error = $state("")
  let busy = $state(false)
  let menuPosition = $state({ x: 0, y: 0 })
  let focusBox = $state({ left: 0, top: 0, width: 0, height: 0 })
  let pendingDelete = $state<{ message: MsgData; permissions: MessageActions } | null>(null)
  let revoke = $state(false)
  let deleteError = $state("")
  let deleting = $state(false)
  let forwardDialog: HTMLDialogElement | undefined = $state()
  let forwardSource = $state<MsgData | null>(null)
  let forwardQuery = $state("")
  let forwardChats = $state<ChatSummary[]>([])
  let forwardLoading = $state(false)
  let forwardSending = $state(false)
  let forwardError = $state("")
  let capabilitiesRequest = 0
  let availableReactions = $state<ReactionData[]>([])
  let reactionsError = $state("")
  let viewers = $state<UserPayload[] | null>(null)
  let viewersError = $state("")
  let viewersOpen = $state(false)
  let viewersButton: HTMLButtonElement | undefined = $state()
  let viewersPanel: HTMLDivElement | undefined = $state()
  let viewersPosition = $state({ x: 0, y: 0, width: 216 })
  let reactionSenders = $state<SenderData[]>([])
  let reactionOffset = $state("")
  let reactionListBusy = $state(false)
  let reactionListError = $state(false)
  const plurals = new Intl.PluralRules("ru")
  const target = $derived(store.contextMenu)
  const focused = $derived(store.focusedMessage)
  const message = $derived(target?.kind === "message" ? target.message : focused?.message ?? null)
  const focusedMessage = $derived(focused ? store.messages.get(focused.message.chat_id)?.find((item) => item.id === focused.message.id) ?? focused.message : null)
  const requestViewers = $derived(target?.kind === "message" && target.message.is_outgoing && target.message.sending_state === "sent")
  const showViewerRow = $derived(requestViewers && permissions?.can_get_viewers)
  const viewerCount = $derived(viewers?.length ?? 0)
  const viewerPlural = $derived(plurals.select(viewerCount))
  const viewersLabel = $derived(viewers ? `${viewerCount} ${viewerPlural === "one" ? "просмотр" : viewerPlural === "few" ? "просмотра" : "просмотров"}` : "Загрузка просмотров…")

  $effect(() => {
    const current = target
    const known = current?.kind === "reaction" ? recentReactionSenders(current.message, current.reaction) : []
    reactionSenders = known
    reactionOffset = ""
    reactionListBusy = false
    reactionListError = false
    if (current?.kind === "reaction" && current.reaction.can_list_senders && known.length < current.reaction.count) void loadReactionPage(current, "")
  })

  async function loadReactionPage(current: Extract<ContextTarget, { kind: "reaction" }>, offset: string) {
    reactionListBusy = true
    reactionListError = false
    try {
      const page = await api.reactionSenders(current.message.chat_id, current.message.id, current.reaction.key, offset)
      if (store.contextMenu !== current) return
      const senders = offset ? [...reactionSenders, ...page.senders] : page.senders.length ? page.senders : reactionSenders
      reactionSenders = [...new Map(senders.map((sender) => [`${sender.kind}:${sender.id}`, sender])).values()]
      reactionOffset = page.next_offset === offset ? "" : page.next_offset
    } catch {
      if (store.contextMenu === current) reactionListError = true
    } finally {
      if (store.contextMenu === current) reactionListBusy = false
    }
  }

  $effect(() => {
    const element = reactionPicker
    if (!element) return
    const scroll = (event: WheelEvent) => {
      if (event.ctrlKey || element.scrollWidth <= element.clientWidth) return
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (!delta) return
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? element.clientWidth : 1
      element.scrollLeft += delta * unit
    }
    element.addEventListener("wheel", scroll, { passive: false })
    return () => element.removeEventListener("wheel", scroll)
  })

  function reactionKeys(event: KeyboardEvent) {
    if (!reactionPicker || !["ArrowLeft", "ArrowRight"].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    const buttons = [...reactionPicker.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = buttons[(index + (event.key === "ArrowLeft" ? -1 : 1) + buttons.length) % buttons.length]
    next?.focus({ preventScroll: true })
    next?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  $effect(() => {
    const current = message
    const loadViewers = requestViewers
    const request = ++capabilitiesRequest
    permissions = null
    permissionError = ""
    error = ""
    busy = false
    availableReactions = []
    reactionsError = ""
    viewers = null
    viewersError = ""
    viewersOpen = false
    if (!current || !store.chatsReady) return
    if (current.is_deleted) {
      permissions = { can_copy: true, can_reply: false, can_edit: false, can_delete_for_self: false, can_delete_for_all: false, can_get_viewers: false }
      return
    }
    void api.messageActions(current.chat_id, current.id).then((value) => {
      if (request !== capabilitiesRequest) return
      permissions = value
      if (!loadViewers || !value.can_get_viewers) return
      void api.messageViewers(current.chat_id, current.id).then((list) => {
        if (request === capabilitiesRequest) viewers = list
      }).catch(() => {
        if (request === capabilitiesRequest) viewersError = "Не удалось загрузить просмотры"
      })
    }).catch(() => {
      if (request === capabilitiesRequest) permissionError = "Не удалось загрузить действия"
    })
    void api.availableReactions(current.chat_id, current.id).then((value) => {
      if (request === capabilitiesRequest) availableReactions = value
    }).catch(() => { if (request === capabilitiesRequest) reactionsError = "Не удалось загрузить реакции" })
  })

  $effect(() => {
    void menuPosition
    const menu = popup
    const button = viewersButton
    const panel = viewersPanel
    if (!menu || !button || !panel) return
    const place = () => {
      const box = menu.getBoundingClientRect()
      const leftSpace = box.left - 8
      const rightSpace = window.innerWidth - box.right - 8
      const openLeft = rightSpace < 216 && leftSpace > rightSpace
      const width = Math.min(216, Math.max(144, openLeft ? leftSpace : rightSpace))
      const left = Math.max(8, Math.min(openLeft ? box.left - width : box.right, window.innerWidth - width - 8))
      const top = Math.max(8, Math.min(button.getBoundingClientRect().top, window.innerHeight - panel.offsetHeight - 8))
      viewersPosition = { x: left - box.left, y: top - box.top, width }
    }
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    place()
    return () => observer.disconnect()
  })

  $effect(() => {
    const current = target
    const element = popup
    if (!current || !element) return
    const place = () => {
      const box = element.getBoundingClientRect()
      menuPosition = {
        x: Math.max(8, Math.min(current.x, window.innerWidth - box.width - 8)),
        y: Math.max(8, Math.min(current.y, window.innerHeight - box.height - 8)),
      }
    }
    const observer = new ResizeObserver(place)
    observer.observe(element)
    place()
    void tick().then(() => {
      if (popup !== element || store.contextMenu !== current) return
      const first = element.querySelector<HTMLButtonElement>("button:not(:disabled)")
      if (first) first.focus()
      else element.focus()
    })
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!focused) return
    const view = document.querySelector(`[data-conversation-key="${store.focusedConversation ?? focused.message.chat_id}"]`)
    if (!view) return
    const place = () => {
      const box = view.getBoundingClientRect()
      focusBox = { left: box.left, top: box.top, width: box.width, height: box.height }
    }
    const observer = new ResizeObserver(place)
    observer.observe(view)
    place()
    void tick().then(() => focusPanel?.focus())
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!confirmation) return
    if (pendingDelete && !confirmation.open) confirmation.showModal()
    else if (!pendingDelete && confirmation.open) confirmation.close()
  })

  $effect(() => {
    if (!forwardDialog) return
    if (forwardSource && !forwardDialog.open) forwardDialog.showModal()
    else if (!forwardSource && forwardDialog.open) forwardDialog.close()
  })

  $effect(() => {
    if (!forwardSource) return
    const query = forwardQuery
    forwardChats = []
    forwardError = ""
    forwardLoading = true
    let disposed = false
    const timer = setTimeout(() => {
      void api.forwardTargets(query).then((chats) => {
        if (!disposed) forwardChats = chats
      }).catch(() => {
        if (!disposed) forwardError = "Не удалось загрузить чаты"
      }).finally(() => { if (!disposed) forwardLoading = false })
    }, query ? 180 : 0)
    return () => { disposed = true; clearTimeout(timer) }
  })

  function startForward(current: MsgData) {
    forwardQuery = ""
    forwardSource = current
    closeMessageOverlays()
  }

  async function forwardTo(chat: ChatSummary) {
    const source = forwardSource
    if (!source || forwardSending || !store.chatsReady) return
    forwardSending = true
    forwardError = ""
    const account = store.user?.id
    try {
      const sent = await api.forwardMessage(chat.id, source.chat_id, source.id)
      if (forwardSource === source && store.chatsReady && store.user?.id === account) {
        appendMessage(sent)
        forwardSource = null
        openConversation(chat)
      }
    } catch { if (forwardSource === source) forwardError = "Не удалось переслать в этот чат" }
    finally { forwardSending = false }
  }

  $effect(() => {
    const card = focusCard
    const actions = focusActions
    const preview = focusPreview
    const content = focusContent
    void focusedMessage
    void error
    void permissionError
    focusFitted = false
    if (!focused || !card || !actions || !preview || !content) return
    let frame = 0
    let disposed = false
    const fit = () => {
      if (disposed) return
      const width = card.clientWidth
      const notice = card.querySelector<HTMLElement>(":scope > .menu-error")
      const gap = parseFloat(getComputedStyle(card).rowGap) || 0
      const height = card.clientHeight - actions.offsetHeight - (notice?.offsetHeight ?? 0) - gap * (notice ? 2 : 1)
      if (width <= 0 || height <= 0) return
      const measure = (scale: number) => {
        content.style.maxWidth = `${width / scale}px`
        return {
          width: Math.max(content.offsetWidth, content.scrollWidth),
          height: Math.max(content.offsetHeight, content.scrollHeight),
        }
      }
      let scale = 1.75
      let size = measure(scale)
      if (size.width * scale > width || size.height * scale > height) {
        let lower = .1
        let upper = scale
        for (let step = 0; step < 9; step += 1) {
          const candidate = (lower + upper) / 2
          const measured = measure(candidate)
          if (measured.width * candidate <= width && measured.height * candidate <= height) lower = candidate
          else upper = candidate
        }
        scale = lower
        size = measure(scale)
      }
      scale = Math.min(scale, width / Math.max(1, size.width), height / Math.max(1, size.height))
      content.style.transform = `translate(-50%, -50%) scale(${scale})`
      preview.style.height = `${size.height * scale}px`
      focusFitted = true
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(card)
    observer.observe(actions)
    observer.observe(content)
    void tick().then(schedule)
    return () => {
      disposed = true
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  })

  function dismissMenu() { store.contextMenu = null }

  function escape(event: KeyboardEvent) {
    if (event.key !== "Escape" || pendingDelete) return
    closeMessageOverlays()
  }

  function menuKeys(event: KeyboardEvent) {
    if (target?.kind === "reaction" && popup && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const items = Array.from(popup.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
      if (!items.length) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : event.key === "ArrowDown" ? (index + 1) % items.length : (index < 1 ? items.length - 1 : index - 1)
      items[next].focus()
      return
    }
    if (event.key === "ArrowRight" && viewerCount && event.target === viewersButton) {
      event.preventDefault()
      viewersOpen = true
      void tick().then(() => viewersPanel?.querySelector("button")?.focus())
      return
    }
    if (event.key === "ArrowLeft" && event.target instanceof Node && viewersPanel?.contains(event.target)) {
      event.preventDefault()
      viewersOpen = false
      viewersButton?.focus()
      return
    }
    if (!popup || !["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) return
    event.preventDefault()
    const buttons = [...popup.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowUp" || event.key === "Tab" && event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  async function copyText(current: MsgData) {
    try {
      await navigator.clipboard.writeText(messageText(current))
      dismissMenu()
    } catch {
      error = "Не удалось скопировать текст"
    }
  }

  async function react(current: MsgData, reaction: ReactionData) {
    if (busy) return
    busy = true
    error = ""
    try {
      await toggleReaction(current, reaction)
      dismissMenu()
    } catch { error = "Не удалось изменить реакцию" }
    finally { busy = false }
  }

  function requestDelete(current: MsgData) {
    if (!permissions) return
    pendingDelete = { message: current, permissions }
    revoke = !permissions.can_delete_for_self && permissions.can_delete_for_all
    deleteError = ""
    dismissMenu()
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return
    const current = pendingDelete
    deleting = true
    deleteError = ""
    try {
      await api.deleteMessage(current.message.chat_id, current.message.id, revoke)
      deleteMessages({ chat_id: current.message.chat_id, message_ids: [current.message.id] })
      pendingDelete = null
      closeMessageOverlays()
    } catch (failure) {
      deleteError = String(failure)
    } finally {
      deleting = false
    }
  }

  function cancelDelete(event?: Event) {
    event?.preventDefault()
    if (!deleting) pendingDelete = null
  }

  async function chatAction(action: "pin" | "archive" | "unread") {
    if (target?.kind !== "chat" || busy) return
    const current = target
    busy = true
    error = ""
    try {
      await api.chatAction(current.chat.id, current.folderId, action)
      if (store.contextMenu === current) dismissMenu()
    } catch (failure) {
      if (store.contextMenu === current) error = String(failure)
    } finally {
      busy = false
    }
  }

  async function openChatWindow(chatId: number) {
    if (busy) return
    const current = target
    busy = true
    error = ""
    try {
      await api.openChatWindow(chatId)
      if (store.contextMenu === current) dismissMenu()
    } catch (failure) {
      if (store.contextMenu === current) error = String(failure)
    } finally {
      busy = false
    }
  }
</script>

<svelte:window onkeydown={escape} onresize={dismissMenu} onblur={dismissMenu} />

{#snippet messageActions(current: MsgData, compact: boolean)}
  {#if permissions?.can_reply && visibleChat(current.chat_id)}
    <button class:compact role={compact ? undefined : "menuitem"} onclick={() => replyToMessage(current)}><Icon name="reply" size={17} strokeWidth={1.5} /><span>Ответить</span></button>
  {/if}
  {#if permissions?.can_forward}
    <button class:compact role={compact ? undefined : "menuitem"} onclick={() => startForward(current)}><Icon name="arrow-right" size={17} /><span>Переслать</span></button>
  {/if}
  {#if permissions?.can_save && canDownloadMessage(current)}
    <button class:compact role={compact ? undefined : "menuitem"} onclick={() => {
      const message = current
      closeMessageOverlays()
      void downloadMessage(message)
    }}><Icon name="download" size={17} /><span>Скачать</span></button>
  {/if}
  {#if messageText(current) && permissions?.can_copy}
    <button class:compact role={compact ? undefined : "menuitem"} onclick={() => copyText(current)}><Icon name="copy" size={17} strokeWidth={1.5} /><span>Копировать текст</span></button>
  {/if}
  {#if !compact && visibleChat(current.chat_id)}
    <button role="menuitem" onclick={() => focusMessage(current)}><Icon name="frame" size={17} strokeWidth={1.5} /><span>Выделить сообщение</span></button>
  {/if}
  <button class:compact role={compact ? undefined : "menuitem"} onclick={() => openProfile({ kind: current.sender.kind, id: current.sender.id })}><Icon name="user" size={17} strokeWidth={1.5} /><span>Профиль автора</span></button>
  {#if permissions?.can_edit && visibleChat(current.chat_id) && ["Text", "Photo", "Video", "File", "Voice"].includes(current.content.kind)}
    <button class:compact role={compact ? undefined : "menuitem"} onclick={() => editMessage(current)}><Icon name="edit-pencil" size={17} strokeWidth={1.5} /><span>Редактировать</span></button>
  {/if}
  {#if permissions?.can_delete_for_self || permissions?.can_delete_for_all}
    <button class:compact class="danger" role={compact ? undefined : "menuitem"} onclick={() => requestDelete(current)}><Icon name="trash" size={17} strokeWidth={1.5} /><span>Удалить</span></button>
  {/if}
{/snippet}

{#snippet reactionToolbar(current: MsgData)}
  <div class="reaction-picker glass" role="toolbar" tabindex="-1" aria-label="Реакции" bind:this={reactionPicker} onkeydown={reactionKeys}>
    {#each availableReactions as reaction (reaction.key)}
      <button title={reaction.needs_premium ? "Нужен Telegram Premium" : reaction.emoji || "Реакция"} aria-label={reaction.emoji || "Реакция"} disabled={busy || reaction.needs_premium} onclick={() => react(current, reaction)}><ReactionIcon {reaction} /></button>
    {/each}
  </div>
{/snippet}

{#snippet personRow(kind: SenderData["kind"], id: number, name: string, fileId: number | null, path: string | null)}
  <button role="menuitem" onclick={() => openProfile({ kind, id })}><Avatar {id} title={name} {fileId} {path} size={25} /><span>{name}</span></button>
{/snippet}

{#if target}
  <button class="menu-dismiss" aria-label="Закрыть меню" onclick={dismissMenu} oncontextmenu={(event) => {
    event.preventDefault()
    dismissMenu()
  }}></button>
  <div class="context-popover" class:with-reactions={target.kind === "message" && availableReactions.length > 0} role="dialog" aria-modal="false" tabindex="-1" aria-label={target.kind === "message" ? "Действия с сообщением" : target.kind === "reaction" ? "Кто поставил реакцию" : "Действия с диалогом"} bind:this={popup} style:left={`${menuPosition.x}px`} style:top={`${menuPosition.y}px`} onkeydown={menuKeys} onpointerleave={(event) => { if (event.pointerType === "mouse") viewersOpen = false }}>
    {#if target.kind === "message" && availableReactions.length && !showViewerRow}{@render reactionToolbar(target.message)}{/if}
    <div class="context-menu glass" class:reaction-people={target.kind === "reaction"} role="menu" tabindex="-1" onscroll={() => viewersOpen = false} onpointerover={(event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null
      if (event.pointerType === "mouse" && button && button !== viewersButton) viewersOpen = false
    }}>
    {#if target.kind === "message"}
      {#if showViewerRow}
        {#if viewersError}<div class="menu-error" role="alert">{viewersError}</div>
        {:else}
          <button class="viewers-trigger" class:open={viewersOpen} role="menuitem" aria-haspopup={viewerCount ? "menu" : undefined} aria-expanded={viewerCount ? viewersOpen : undefined} aria-controls={viewersOpen ? "message-viewers" : undefined} disabled={!viewerCount} bind:this={viewersButton} onpointerenter={(event) => { if (event.pointerType === "mouse" && viewerCount) viewersOpen = true }} onclick={() => viewersOpen = !viewersOpen}>
            <Icon name="eye" size={17} /><span>{viewersLabel}</span>{#if viewerCount}<Icon name="nav-arrow-right" size={14} />{/if}
          </button>
        {/if}
        {#if availableReactions.length}{@render reactionToolbar(target.message)}{/if}
      {/if}
      {#if reactionsError}<div class="menu-error" role="alert">{reactionsError}</div>{/if}
      {@render messageActions(target.message, false)}
      {#if permissionError}<div class="menu-error" role="alert">{permissionError}</div>{/if}
    {:else if target.kind === "reaction"}
      {@const current = target}
      {#each reactionSenders as sender (`${sender.kind}:${sender.id}`)}
        {@const person = senderDetails(sender)}
        {@render personRow(person.kind, person.id, person.name || (person.kind === "chat" ? "Чат" : "Пользователь"), person.photo_file_id, person.photo)}
      {/each}
      {#if reactionListBusy}
        <div class="reaction-list-status" role="status">Загрузка…</div>
      {:else if reactionListError}
        <div class="menu-error" role="alert">Не удалось загрузить реакции</div>
        <button role="menuitem" onclick={() => loadReactionPage(current, reactionOffset)}>Повторить</button>
      {:else if reactionOffset}
        <button role="menuitem" onclick={() => loadReactionPage(current, reactionOffset)}>Показать ещё</button>
      {:else if !reactionSenders.length}
        <div class="reaction-list-status">Список недоступен</div>
      {/if}
    {:else}
      {@const current = target}
      <button role="menuitem" onclick={() => openConversation(current.chat)}><Icon name="chat-bubble" size={17} /><span>Открыть</span></button>
      {#if !canSplitView()}
        <button role="menuitem" disabled={busy} onclick={() => openChatWindow(current.chat.id)}><Icon name="arrow-up-right" size={17} /><span>Открыть в новом окне</span></button>
      {:else if current.chat.id !== store.activeChatId}
        <button role="menuitem" onclick={() => openSplitChat(current.chat)}><Icon name="view-columns-2" size={17} /><span>Открыть в Split View</span></button>
      {/if}
      <button role="menuitem" onclick={() => openProfile({ kind: "chat", id: current.chat.id })}><Icon name="user" size={17} /><span>Профиль</span></button>
      <button role="menuitem" disabled={busy} onclick={() => chatAction("pin")}><Icon name="pin" size={17} /><span>{current.chat.is_pinned ? "Открепить" : "Закрепить"}</span></button>
      <button role="menuitem" disabled={busy} onclick={() => chatAction("unread")}><Icon name="mail" size={17} /><span>{current.chat.is_marked_as_unread ? "Убрать отметку непрочитанного" : "Отметить непрочитанным"}</span></button>
      <button role="menuitem" disabled={busy} onclick={() => chatAction("archive")}><Icon name="archive" size={17} /><span>{current.chat.positions?.some((position) => position.folder_id === -1 && position.order > 0) ? "Вернуть из архива" : "В архив"}</span></button>
    {/if}
    {#if error}<div class="menu-error" role="alert">{error}</div>{/if}
    </div>
    {#if viewersOpen && viewers?.length}
      <div id="message-viewers" class="viewer-popover glass" role="menu" aria-label="Просмотревшие сообщение" bind:this={viewersPanel} style:left={`${viewersPosition.x}px`} style:top={`${viewersPosition.y}px`} style:width={`${viewersPosition.width}px`}>
        {#each viewers as viewer (viewer.id)}
          {@const name = `${viewer.first_name} ${viewer.last_name}`.trim() || viewer.username || "Пользователь"}
          {@render personRow("user", viewer.id, name, viewer.photo_file_id, viewer.photo)}
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if focused && focusedMessage}
  <div class="focus-stage" role="dialog" aria-label="Выделенное сообщение" aria-modal="false" bind:this={focusPanel} tabindex="-1" style:left={`${focusBox.left}px`} style:top={`${focusBox.top}px`} style:width={`${focusBox.width}px`} style:height={`${focusBox.height}px`}>
    <button class="focus-backdrop" aria-label="Закрыть выделение" onclick={closeMessageOverlays}></button>
    <button class="icon-button focus-close" aria-label="Закрыть выделение" onclick={closeMessageOverlays}><Icon name="xmark" size={20} /></button>
    <div class="focus-card" bind:this={focusCard}>
      <div class="focus-preview" class:ready={focusFitted} bind:this={focusPreview}>
        <div class="focus-message" bind:this={focusContent}><MessageBubble msg={focusedMessage} presentation actions={false} showAuthor={focused.isGroup} /></div>
      </div>
      <div class="focus-actions" bind:this={focusActions}>{@render messageActions(focusedMessage, true)}</div>
      {#if error || permissionError}<div class="menu-error" role="alert">{error || permissionError}</div>{/if}
    </div>
  </div>
{/if}

<dialog class="delete-confirmation glass" aria-label="Удалить сообщение" bind:this={confirmation} oncancel={cancelDelete} onclose={() => pendingDelete = null}>
  {#if pendingDelete}
    <h2>Удалить сообщение?</h2>
    <p>{store.saveDeleted ? revoke ? "Сообщение удалится у всех и останется в вашем архиве." : "Сообщение останется в вашем архиве." : revoke ? "Сообщение исчезнет у всех участников." : "Сообщение исчезнет только у вас."}</p>
    {#if pendingDelete.permissions.can_delete_for_all && pendingDelete.permissions.can_delete_for_self}<label><input type="checkbox" bind:checked={revoke} disabled={deleting} />Удалить для всех</label>{/if}
    {#if deleteError}<div class="menu-error" role="alert">{deleteError}</div>{/if}
    <div class="confirmation-actions"><button onclick={() => cancelDelete()} disabled={deleting}>Отмена</button><button class="delete-button" onclick={confirmDelete} disabled={deleting}>Удалить</button></div>
  {/if}
</dialog>

<dialog class="delete-confirmation forward-dialog glass" aria-label="Куда переслать" bind:this={forwardDialog} oncancel={(event) => { if (forwardSending) event.preventDefault() }} onclose={() => forwardSource = null}>
  {#if forwardSource}
    <header><h2>Куда переслать</h2><button class="icon-button" aria-label="Закрыть" disabled={forwardSending} onclick={() => forwardSource = null}><Icon name="xmark" size={18} /></button></header>
    <input class="text-input" aria-label="Поиск чатов" placeholder="Поиск чатов" bind:value={forwardQuery} disabled={forwardSending} />
    {#if forwardError}<div class="menu-error" role="alert">{forwardError}</div>{/if}
    <div class="forward-chats">
      {#each forwardChats as chat (chat.id)}
        <button disabled={forwardSending} onclick={() => forwardTo(chat)}><Avatar id={chat.id} title={chat.title} fileId={chat.photo_file_id} path={chat.photo} size={32} /><span>{chat.id === store.user?.id ? "Избранное" : chat.title || "Без названия"}</span></button>
      {:else}{#if !forwardError}<p>{forwardLoading ? "Загрузка…" : "Чаты не найдены"}</p>{/if}{/each}
    </div>
  {/if}
</dialog>

<style>
  .reaction-picker { display: flex; flex-wrap: nowrap; gap: 3px; padding: 6px; width: 100%; min-width: 0; flex-shrink: 0; border-radius: 24px; background: var(--menu-bg); overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none }
  .reaction-picker::-webkit-scrollbar { display: none }
  .reaction-picker button { display: grid; place-items: center; flex: 0 0 34px; width: 34px; height: 34px; padding: 4px; border-radius: 50%; transition: background .15s, transform .15s }
  .reaction-picker button:hover { background: var(--accent-soft); transform: scale(1.12) }
  .reaction-picker button:disabled { opacity: .45 }
  .menu-dismiss { position: fixed; inset: 0; z-index: 100; background: transparent; cursor: default }
  .context-popover { position: fixed; z-index: 101; display: flex; flex-direction: column; gap: 8px; width: max-content; max-width: min(290px, calc(100vw - 16px)); min-width: min(215px, calc(100vw - 16px)); max-height: calc(100vh - 16px); animation: appear .14s ease-out }
  .context-popover.with-reactions { width: min(290px, calc(100vw - 16px)) }
  .context-menu { width: 100%; min-height: 0; overflow-y: auto; padding: 6px; border-radius: 17px; background: var(--menu-bg) }
  .context-menu .reaction-picker { border: 0; padding: 3px 4px; background: transparent; box-shadow: none; backdrop-filter: none }
  .context-menu > button, .viewer-popover button, .focus-actions button { display: flex; align-items: center; gap: 10px; padding: 10px 12px; width: 100%; text-align: left; font-size: 12px; border-radius: 11px; white-space: nowrap }
  .context-menu > button:hover, .context-menu > button.open, .viewer-popover button:hover, .focus-actions button:hover { background: var(--accent-soft) }
  .viewers-trigger span { flex: 1 }
  .viewer-popover { position: absolute; max-width: calc(100vw - 16px); max-height: min(250px, calc(100vh - 16px)); overflow-y: auto; overscroll-behavior: contain; padding: 5px; border-radius: 15px; background: var(--menu-bg) }
  .viewer-popover button, .reaction-people > button { padding: 6px 8px }
  .viewer-popover button span, .reaction-people > button span { overflow: hidden; text-overflow: ellipsis }
  .reaction-people { max-height: min(250px, calc(100vh - 16px)); overscroll-behavior: contain }
  .reaction-list-status { padding: 7px 8px; color: var(--text-secondary); font-size: 12px }
  .context-menu button:disabled { opacity: .45 }
  .context-menu button:global(:focus-visible) { outline-offset: -2px }
  .danger { color: var(--danger) }
  .menu-error { color: var(--danger); font-size: 11px; line-height: 1.5; padding: 7px 11px; overflow-wrap: anywhere; max-width: 300px }
  .focus-stage { position: fixed; z-index: 80; display: flex; align-items: center; justify-content: center; border-radius: 24px; overflow: hidden; outline: none; padding: 54px clamp(12px, 2vw, 24px) 20px }
  .focus-backdrop { position: absolute; inset: 0; background: rgba(3,8,18,.4); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); cursor: default }
  .focus-close { position: absolute; right: 16px; top: 13px; z-index: 2; background: rgba(20,39,68,.6); color: var(--text-primary) }
  .focus-card { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; width: 100%; height: 100%; min-width: 0; min-height: 0; pointer-events: none; animation: focus-in .2s ease-out }
  .focus-preview { position: relative; width: 100%; height: 0; flex-shrink: 0; min-height: 0 }
  .focus-message { position: absolute; top: 50%; left: 50%; width: max-content; padding: 8px; transform-origin: center; pointer-events: auto; visibility: hidden }
  .focus-preview.ready .focus-message { visibility: visible }
  .focus-message :global(.bubble-row) { max-width: 100%; margin: 0; min-width: 0; align-self: auto }
  .focus-message :global(.bubble) { min-width: 0; max-width: 100%; box-shadow: 0 20px 65px rgba(0,0,0,.2) }
  .focus-actions { display: flex; justify-content: center; gap: 6px; flex-wrap: wrap; max-width: 100%; flex-shrink: 0; pointer-events: auto }
  .focus-card > .menu-error { flex-shrink: 0; pointer-events: auto }
  .focus-actions .compact { width: auto; flex-direction: row; gap: 7px; min-height: 34px; padding: 7px 12px; border-radius: 999px; font-size: 11px; line-height: 1.2; background: rgba(33,53,84,.58); -webkit-backdrop-filter: blur(var(--glass-blur)) brightness(1.15); backdrop-filter: blur(var(--glass-blur)) brightness(1.15) }
  .delete-confirmation { width: 340px; max-width: calc(100vw - 36px); border-radius: 23px; padding: 25px; color: var(--text-primary); background: var(--menu-bg) }
  .delete-confirmation::backdrop { background: rgba(3,8,18,.58); backdrop-filter: blur(5px) }
  .forward-dialog header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px }
  .forward-dialog header h2 { margin: 0 }
  .forward-chats { max-height: min(50vh, 360px); overflow-y: auto; margin-top: 9px }
  .forward-chats button { display: flex; align-items: center; gap: 9px; text-align: left; width: 100%; padding: 6px 8px; border-radius: 10px }
  .forward-chats button:hover { background: var(--hover) }
  .forward-chats button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  h2 { margin: 0 0 13px; font-size: 18px; font-weight: 550 }
  p { color: var(--text-secondary); font-size: 12px; line-height: 1.6; margin: 0 0 18px }
  label { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 12px }
  input { accent-color: var(--accent) }
  .confirmation-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px }
  .confirmation-actions button { font-size: 12px; padding: 9px 13px; border-radius: 11px }
  .delete-button { background: rgba(255,67,104,.17); color: var(--danger) }
  @keyframes focus-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
</style>
