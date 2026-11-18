<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import { crossfade, fly } from "svelte/transition"
  import { onDestroy } from "svelte"
  import appConfig from "../../../../src-tauri/tauri.conf.json"
  import { open } from "@tauri-apps/plugin-dialog"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import Avatar from "$lib/components/Avatar.svelte"
  import SecretInput from "$lib/components/auth/SecretInput.svelte"
  import { store, api, loadMoreChats, selectFolder, openProfile, openPrivateChat, setEffects, openChatMenu, activateChat, setPrivacyMode, applyAppLockStatus, setSaveDeleted, setSkipRead, setChatPrivacy, setNotificationPreference, themePresets, interfaceFontGroups, updateCustomization, resetCustomization, setRecentStickerLimit, setScrollOnReply, canSplitView, openSplitChat, compactChats, compactView, messageSender, chatMuted } from "$lib/stores/app.svelte"
  import type { ChatPrivacy, ChatSummary, DownloadSettings, NotificationPreferences } from "$lib/api/td"
  import { formatTime, messagePreview, horizontalWheel, rangeSlider } from "$lib/utils"

  let search = $state("")
  let list: HTMLDivElement | undefined = $state()
  let previousListScrollTop = 0
  let menu: HTMLDivElement | undefined = $state()
  let menuOpen = $state(false)
  let settingsOpen = $state(false)
  let settingsDialog: HTMLDialogElement | undefined = $state()
  let menuError = $state("")
  let compactTimer: ReturnType<typeof setTimeout> | undefined
  const loadedChatCount = $derived(store.chats.length)
  const delivery = {
    failed: { icon: "warning-circle", label: "Не отправлено" },
    pending: { icon: "clock", label: "Отправляется" },
    sent: { icon: "check", label: "Отправлено" },
    read: { icon: "double-check", label: "Прочитано" },
  }

  function previewAuthor(chat: ChatSummary) {
    const message = chat.last_message
    if (!message || message.is_channel_post || message.content.kind === "Event") return ""
    if (message.is_outgoing || (message.sender.kind === "user" && message.sender.id === store.user?.id)) return "Вы"
    const sender = messageSender(message)
    const name = sender.name || (chat.is_group ? "" : chat.title)
    return (sender.kind === "user" ? (sender.first_name ?? name.trim().split(/\s+/, 1)[0]) : name) || "Участник"
  }

  function scheduleCompact() {
    clearTimeout(compactTimer)
    if (!list || list.scrollTop > 80 || search.trim() || loadedChatCount <= 50) return
    compactTimer = setTimeout(() => void compactChats().catch(() => {}), 15000)
  }

  $effect(() => {
    void search
    void loadedChatCount
    scheduleCompact()
  })

  onDestroy(() => clearTimeout(compactTimer))
  let lockForm = $state<"pin" | "password" | "disable" | null>(null)
  let currentSecret = $state("")
  let newSecret = $state("")
  let confirmSecret = $state("")
  let lockBusy = $state(false)
  let lockError = $state("")
  let archiveBusy = $state(false)
  let archiveError = $state("")
  let privacyBusy = $state(false)
  let privacyError = $state("")
  const privacyOptions: { key: keyof ChatPrivacy | "read"; label: string }[] = [
    { key: "hide_video_views", label: "Просматривать видеосообщения анонимно" },
    { key: "hide_voice_listens", label: "Прослушивать голосовые анонимно" },
    { key: "read", label: "Скрывать статус прочтения" },
    { key: "hide_typing", label: "Скрывать статус набора текста" },
  ]
  const settingsTitles = { appearance: "Кастомизация", chats: "Чаты", notifications: "Уведомления", security: "Безопасность", downloads: "Загрузки" }
  const settingsAvatarSize = 52
  let settingsCategory = $state<keyof typeof settingsTitles | null>(null)
  let downloads = $state<DownloadSettings | null>(null)
  let downloadsBusy = $state(false)
  let downloadsError = $state("")
  let settingsDirection = $state(1)
  let wallpaperBusy = $state(false)
  let wallpaperError = $state("")
  const categoryTitle = $derived(settingsCategory ? settingsTitles[settingsCategory] : "Настройки")
  let notificationBusy = $state(false)
  let notificationError = $state("")
  const notificationOptions: { key: keyof NotificationPreferences; label: string }[] = [
    { key: "enabled", label: "Уведомления приложения" },
    { key: "private", label: "Личные чаты" },
    { key: "group", label: "Группы" },
    { key: "group_mentions", label: "Упоминания в группах" },
    { key: "channel", label: "Каналы" },
  ]
  const selectedTheme = $derived(themePresets.find((theme) => theme.id === store.customization.theme) ?? themePresets[0])
  const customAccent = $derived(store.customization.theme === "custom" ? store.customization.accent : selectedTheme.accent)
  const customBackground = $derived(store.customization.theme === "custom" ? store.customization.background : selectedTheme.background)

  async function changeNotifications(key: keyof NotificationPreferences, input: HTMLInputElement) {
    if (notificationBusy) return
    notificationBusy = true
    notificationError = ""
    try { await setNotificationPreference(key, input.checked) }
    catch {
      input.checked = store.notifications[key]
      notificationError = "Не удалось сохранить настройки уведомлений"
    } finally { notificationBusy = false }
  }

  async function chooseWallpaper() {
    if (wallpaperBusy) return
    const account = store.user?.id
    wallpaperBusy = true
    wallpaperError = ""
    try {
      const path = await open({ multiple: false, filters: [{ name: "Изображения", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] })
      if (typeof path !== "string" || store.user?.id !== account) return
      const installed = await api.installWallpaper(path)
      if (store.user?.id === account && store.stage === "ready") updateCustomization({ theme: "custom", wallpaper: installed })
    } catch (error) { wallpaperError = String(error) }
    finally { wallpaperBusy = false }
  }

  function themeWallpaper(id: string, background: string) {
    return id === "custom" && store.customization.wallpaper ? `url(${JSON.stringify(convertFileSrc(store.customization.wallpaper))})` : background
  }

  function chooseCategory(category: typeof settingsCategory) {
    if (lockBusy) return
    settingsDirection = category ? 1 : -1
    chooseLock(null)
    currentSecret = ""
    settingsCategory = category
    if (category === "downloads") void changeDownloadDrive()
  }

  async function changeDownloadDrive(input?: HTMLSelectElement) {
    if (downloadsBusy) return
    downloadsBusy = true
    downloadsError = ""
    try { downloads = input ? await api.setDownloadDrive(input.value) : await api.downloadSettings() }
    catch (error) {
      if (input && downloads) input.value = downloads.drive
      downloadsError = String(error)
    } finally { downloadsBusy = false }
  }

  async function changeChatPrivacy(key: keyof ChatPrivacy | "read", input: HTMLInputElement) {
    if (privacyBusy) return
    privacyBusy = true
    privacyError = ""
    try {
      if (key === "read") await setSkipRead(input.checked)
      else await setChatPrivacy(key, input.checked)
    } catch {
      input.checked = key === "read" ? store.skipRead : store.chatPrivacy[key]
      privacyError = "Не удалось сохранить настройку"
    } finally { privacyBusy = false }
  }

  async function changeArchive(enabled: boolean) {
    if (archiveBusy) return
    archiveBusy = true
    archiveError = ""
    try { await setSaveDeleted(enabled) }
    catch { archiveError = "Не удалось сохранить настройку" }
    finally { archiveBusy = false }
  }
  const lockCanSave = $derived(!!lockForm && (!store.appLock?.configured || (store.appLock.kind === "pin" ? currentSecret.length === 4 : currentSecret.length > 0))
    && (lockForm === "disable" || (lockForm === "pin" ? /^\d{4}$/.test(newSecret) : [...newSecret].length >= 4) && newSecret === confirmSecret))
  const filtered = $derived(store.chats.filter((chat) => chat.title.toLowerCase().includes(search.trim().toLowerCase())))
  const userTitle = $derived(store.user ? `${store.user.first_name} ${store.user.last_name}`.trim() : "Parugram")
  const flatSidebar = $derived(store.customization.layout === "panels")
  const folderRail = $derived(flatSidebar && !compactView())
  $effect(() => {
    void folderRail
    previousListScrollTop = list?.scrollTop ?? 0
  })
  const [pillOut, pillIn] = crossfade({ duration: 180 })

  $effect(() => {
    if (!settingsDialog) return
    if (settingsOpen && !settingsDialog.open) settingsDialog.showModal()
    else if (!settingsOpen && settingsDialog.open) settingsDialog.close()
  })

  $effect(() => {
    if (settingsOpen) return
    settingsCategory = null
    lockForm = null
    currentSecret = ""
    newSecret = ""
    confirmSecret = ""
    lockError = ""
  })

  function chooseLock(kind: "pin" | "password" | "disable" | null) {
    lockForm = kind
    newSecret = ""
    confirmSecret = ""
    lockError = ""
  }

  async function saveLock(event: SubmitEvent) {
    event.preventDefault()
    if (lockBusy || !lockCanSave || !lockForm) return
    lockBusy = true
    lockError = ""
    try {
      const result = await api.setAppLock(currentSecret, lockForm === "disable" ? null : lockForm, newSecret)
      applyAppLockStatus(result.status)
      if (!result.accepted) {
        lockError = `Неверный текущий ${store.appLock?.kind === "pin" ? "код" : "пароль"}. Осталось попыток: ${result.status.remaining_attempts}`
        currentSecret = ""
      } else {
        chooseLock(null)
        currentSecret = ""
      }
    } catch (error) {
      lockError = String(error)
    } finally {
      lockBusy = false
    }
  }

  function loadNearBottom() {
    scheduleCompact()
    if (!list) return
    const scrollTop = list.scrollTop
    const scrollingDown = scrollTop > previousListScrollTop
    previousListScrollTop = scrollTop
    if (!scrollingDown || !store.chatsReady || search.trim() || store.chatsError || store.loadingChats) return
    if (list.scrollHeight - scrollTop - list.clientHeight < 160) void loadMoreChats()
  }

  function leaveMenu() {
    if (!menu?.contains(document.activeElement)) menuOpen = false
  }

  function blurMenu(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !menu?.contains(event.relatedTarget)) menuOpen = false
  }

  async function savedMessages() {
    if (!store.user) return
    menuError = ""
    try {
      await openPrivateChat(store.user.id)
      menuOpen = false
    } catch (error) {
      menuError = String(error)
    }
  }

  function myProfile() {
    if (store.user) void openProfile({ kind: "user", id: store.user.id })
    menuOpen = false
  }

  function changeFolder(id: number) {
    search = ""
    void selectFolder(id)
  }
</script>

<svelte:window onkeydown={(event) => { if (event.key === "Escape") menuOpen = false }} />
<aside class="sidebar" class:folder-rail={folderRail} class:flat-sidebar={flatSidebar}>
  {#if !flatSidebar}<div class="sidebar-surface glass" aria-hidden="true"></div>{/if}
  <div class="sidebar-top">
    <div class="profile-control" role="group" aria-label="Аккаунт" bind:this={menu} onpointerenter={() => menuOpen = true} onpointerleave={leaveMenu} onfocusout={blurMenu}>
      <button class="profile-trigger" aria-expanded={menuOpen} aria-haspopup="true" onclick={() => menuOpen = true} disabled={store.stage !== "ready"}>
        <Avatar id={store.user?.id ?? 0} title={userTitle} fileId={store.user?.photo_file_id} path={store.user?.photo} size={folderRail ? 32 : 42} />
        <span class="profile-text"><strong>{userTitle}</strong><span class="connection">Parugram</span></span>
        <Icon name="nav-arrow-down" size={16} strokeWidth={1.5} />
      </button>
      <div class="profile-dropdown glass" class:open={menuOpen}>
        <button onclick={myProfile}><Icon name="user" size={18} />Мой профиль</button>
        <button onclick={savedMessages}><Icon name="bookmark" size={18} />Избранное</button>
        <label class="privacy-toggle"><Icon name="eye-closed" size={18} /><span>Privacy mode</span><input class="switch" type="checkbox" role="switch" checked={store.privacyMode} onchange={(event) => setPrivacyMode(event.currentTarget.checked)} /></label>
        <button onclick={() => {
          menuOpen = false
          settingsOpen = true
        }}><Icon name="settings" size={18} />Настройки</button>
        <button class="logout" onclick={() => api.logout().catch((error) => menuError = String(error))}><Icon name="log-out" size={18} />Выйти</button>
        {#if menuError}<div class="inline-error" role="alert">{menuError}</div>{/if}
      </div>
    </div>
    <label class="search"><Icon name="search" size={17} strokeWidth={1.5} /><input placeholder="Поиск" aria-label="Поиск чатов" bind:value={search} disabled={!store.chatsReady} /></label>
  </div>
  <nav class="folders" aria-label="Папки" use:horizontalWheel>
    {#each store.folders as folder (folder.id)}
      {@const unread = folder.unread_count ?? 0}
      <button class:active={store.selectedFolder === folder.id} aria-pressed={store.selectedFolder === folder.id} aria-label={unread > 0 ? `${folder.title}, непрочитанных чатов ${unread}` : undefined} title={folderRail ? folder.title : undefined} disabled={store.stage !== "ready"} onclick={() => changeFolder(folder.id)}>
        {#if store.selectedFolder === folder.id}<span class="pill-active" in:pillIn={{ key: "folder", duration: store.effects === "full" ? 180 : 0 }} out:pillOut={{ key: "folder", duration: store.effects === "full" ? 180 : 0 }}></span>{/if}
        {#if folderRail}<Icon name={folder.id === 0 ? "chat-bubble" : folder.id === -1 ? "archive" : "folder"} size={19} />{/if}
        <span class="folder-label">{folder.title}</span>{#if unread > 0}<span class="folder-count">{unread}</span>{/if}
      </button>
    {/each}
  </nav>
  <div class="list" class:stale={!store.chatsReady} aria-busy={!store.chatsReady} bind:this={list} onscroll={loadNearBottom}>
    {#each filtered as chat, index (chat.id)}
      {@const author = previewAuthor(chat)}
      {@const last = chat.last_message}
      {@const muted = chatMuted(chat)}
      {#if !chat.is_pinned && filtered[index - 1]?.is_pinned}<hr class="pinned-divider" />{/if}
      <button class="chat-item" class:active={store.activeChatId === chat.id} class:muted class:privacy-hidden={store.privacyMode && store.activeChatId !== chat.id} aria-label={store.privacyMode && store.activeChatId !== chat.id ? "Скрытый чат" : undefined} onclick={(event) => {
        if (event.altKey && openSplitChat(chat)) return
        if (event.altKey && !canSplitView()) {
          void api.openChatWindow(chat.id).catch(console.error)
          return
        }
        activateChat(chat.id)
      }} oncontextmenu={(event) => {
        event.preventDefault()
        openChatMenu(chat, event.clientX, event.clientY)
      }} disabled={!store.chatsReady}>
        <span class="chat-avatar">
          <Avatar id={chat.id} title={chat.title} fileId={chat.photo_file_id} path={chat.photo} size={folderRail ? 36 : 48} />
          {#if muted}<span class="mute-icon" role="img" aria-label="Уведомления выключены" title="Уведомления выключены"><Icon name="bell-off" size={11} strokeWidth={1.8} /></span>{/if}
        </span>
        <span class="chat-info">
          <span class="row1">
            <strong>{chat.title || "Без названия"}</strong>
            {#if last}
              <span class="chat-meta">
                {#if last.is_outgoing && !last.is_channel_post && last.content.kind !== "Event"}
                  {@const status = last.sending_state === "pending" || last.sending_state === "failed" ? last.sending_state : last.id <= chat.last_read_outbox_message_id ? "read" : "sent"}
                  {@const { icon, label } = delivery[status]}
                  <span class="preview-delivery" class:read={status === "read"} class:failed={status === "failed"} role="img" aria-label={label} title={label}><Icon name={icon} size={14} /></span>
                {/if}
                <span class="time">{formatTime(last.date)}</span>
              </span>
            {/if}
          </span>
          <span class="row2"><span class="preview">
            {#if author}<span class="preview-author">{author}:</span>{/if}
            <span class="preview-text">
              {#if chat.last_message?.content.kind === "Photo"}<Icon name="mynaui:image" size={13} />
              {:else if chat.last_message?.content.kind === "Video" || chat.last_message?.content.kind === "VideoNote"}<Icon name="play" size={13} />
              {:else if chat.last_message?.content.kind === "Audio"}<Icon name="music-note" size={13} />
              {:else if chat.last_message?.content.kind === "File"}<Icon name="page" size={13} strokeWidth={1.5} />
              {:else if chat.last_message?.content.kind === "Voice"}<Icon name="microphone" size={13} strokeWidth={1.5} />{/if}
              {chat.last_message ? messagePreview(chat.last_message.content) : "Нет сообщений"}
            </span>
          </span>
          {#if chat.unread_count > 0}<span class="badge">{chat.unread_count}</span>{:else if chat.is_marked_as_unread}<span class="unread-dot" aria-label="Непрочитано"></span>{:else if chat.is_pinned}<Icon name="pin" size={12} strokeWidth={1.5} />{/if}</span>
        </span>
      </button>
    {:else}
      <div class="empty">{search ? "Ничего не найдено" : "Чатов пока нет"}</div>
    {/each}
    {#if store.chatsError}<div class="inline-error" role="alert">{store.chatsError}</div><button class="load-more" onclick={loadMoreChats} disabled={store.loadingChats}>Повторить</button>
    {:else if store.chatsReady && store.hasMoreChats && !search}<button class="load-more" onclick={loadMoreChats} disabled={store.loadingChats}>{store.loadingChats ? "Загрузка..." : "Ещё чаты"}</button>{/if}
  </div>
  {#if folderRail}
    <button class="rail-settings" onclick={() => {
      menuOpen = false
      settingsOpen = true
    }}><Icon name="settings" size={19} />Настройки</button>
  {/if}
</aside>

<dialog class="settings-dialog glass" aria-label="Настройки" bind:this={settingsDialog} oncancel={() => settingsOpen = false} onclose={() => settingsOpen = false}>
  <header>{#if settingsCategory}<button class="icon-button settings-back" aria-label="Назад" disabled={lockBusy} onclick={() => chooseCategory(null)}><Icon name="nav-arrow-left" size={21} /></button>{/if}<h2>{categoryTitle}</h2><button class="icon-button" aria-label="Закрыть настройки" onclick={() => settingsOpen = false}><Icon name="xmark" size={20} /></button></header>
  <div class="settings-pages">
  {#key settingsCategory}
  <div class="settings-page" in:fly={{ x: settingsDirection * 28, duration: store.effects === "full" ? 180 : 0 }} out:fly={{ x: settingsDirection * -28, duration: store.effects === "full" ? 140 : 0 }}>
  {#if !settingsCategory}
  <div class="settings-account"><Avatar id={store.user?.id ?? 0} title={userTitle} fileId={store.user?.photo_file_id} path={store.user?.photo} size={settingsAvatarSize} /><span><strong>{userTitle}</strong><span>Parugram</span></span></div>
  <nav class="settings-categories" aria-label="Категории настроек" style:--settings-avatar-size={`${settingsAvatarSize}px`}>
    <button onclick={() => chooseCategory("appearance")}><Icon name="sparks" size={20} /><span>Кастомизация</span><Icon name="nav-arrow-right" size={17} /></button>
    <button onclick={() => chooseCategory("chats")}><Icon name="chat-bubble" size={20} /><span>Чаты</span><Icon name="nav-arrow-right" size={17} /></button>
    <button onclick={() => chooseCategory("notifications")}><Icon name="bell" size={20} /><span>Уведомления</span><Icon name="nav-arrow-right" size={17} /></button>
    <button onclick={() => chooseCategory("downloads")}><Icon name="download" size={20} /><span>Загрузки</span><Icon name="nav-arrow-right" size={17} /></button>
    <button onclick={() => chooseCategory("security")}><Icon name="shield-check" size={20} /><span>Безопасность</span><Icon name="nav-arrow-right" size={17} /></button>
  </nav>
  {:else if settingsCategory === "appearance"}
  <label class="settings-row"><span>Схема интерфейса</span><select class="drive-select layout-select" value={store.customization.layout} onchange={(event) => updateCustomization({ layout: event.currentTarget.value === "panels" ? "panels" : "classic" })}>
    <option value="classic">Классическая</option>
    <option value="panels">Боковые панели</option>
  </select></label>
  <h3>Темы</h3>
  <div class="theme-grid" role="group" aria-label="Темы">
    {#each themePresets as theme (theme.id)}
      <button class="theme-choice" class:chosen={store.customization.theme === theme.id} aria-pressed={store.customization.theme === theme.id} onclick={() => updateCustomization({ theme: theme.id })}>
        <span class="theme-swatch" style:background-color={theme.id === "custom" ? store.customization.background : theme.background} style:background-image={themeWallpaper(theme.id, theme.wallpaper)} style:--preview-in={theme.id === "custom" ? store.customization.accent : theme.incoming} style:--preview-out={theme.id === "custom" ? store.customization.accent : theme.outgoing ?? theme.accent}><i></i><i></i>{#if store.customization.theme === theme.id}<span class="theme-check"><Icon name="check" size={13} /></span>{/if}</span><span>{theme.name}</span>
      </button>
    {/each}
  </div>
  <h3>Цвета и фон</h3>
  <div class="theme-colors">
    <label><span>Акцент</span><input type="color" aria-label="Цвет акцента" value={customAccent} oninput={(event) => updateCustomization({ theme: "custom", accent: event.currentTarget.value })} /></label>
    <label><span>Фон</span><input type="color" aria-label="Цвет фона" value={customBackground} oninput={(event) => updateCustomization({ theme: "custom", background: event.currentTarget.value })} /></label>
  </div>
  <div class="wallpaper-actions"><button onclick={chooseWallpaper} disabled={wallpaperBusy}><Icon name="media-image" size={17} />{wallpaperBusy ? "Загрузка..." : "Свой фон"}</button>{#if store.customization.theme === "custom" && store.customization.wallpaper}<button onclick={() => updateCustomization({ wallpaper: null })} disabled={wallpaperBusy}>Убрать</button>{/if}</div>
  {#if wallpaperError}<div class="inline-error" role="alert">{wallpaperError}</div>{/if}
  <h3>Сообщения и панели</h3>
  <label class="settings-row"><span>Шрифт</span><select class="font-select" value={store.customization.fontFamily} onchange={(event) => updateCustomization({ fontFamily: event.currentTarget.value })}>
    {#each interfaceFontGroups as group}
      <optgroup label={group.label}>
        {#each group.fonts as font}<option value={font} style:font-family={JSON.stringify(font)}>{font}</option>{/each}
      </optgroup>
    {/each}
  </select></label>
  <label class="custom-slider"><span>Размер сообщений<output>{store.customization.fontSize} px</output></span><input type="range" min="12" max="20" value={store.customization.fontSize} use:rangeSlider={store.customization.fontSize} oninput={(event) => updateCustomization({ fontSize: Number(event.currentTarget.value) })} /></label>
  <label class="custom-slider"><span>Скругление сообщений<output>{store.customization.bubbleRadius} px</output></span><input type="range" min="8" max="28" value={store.customization.bubbleRadius} use:rangeSlider={store.customization.bubbleRadius} oninput={(event) => updateCustomization({ bubbleRadius: Number(event.currentTarget.value) })} /></label>
  <label class="custom-slider"><span>Непрозрачность панелей<output>{store.customization.panelOpacity}%</output></span><input type="range" min="50" max="100" value={store.customization.panelOpacity} use:rangeSlider={store.customization.panelOpacity} oninput={(event) => updateCustomization({ panelOpacity: Number(event.currentTarget.value) })} /></label>
  {#if selectedTheme.wallpaper !== "none" || store.customization.theme === "custom" && store.customization.wallpaper}
    <label class="custom-slider"><span>Яркость фона<output>{store.customization.wallpaperOpacity}%</output></span><input type="range" min="0" max="100" value={store.customization.wallpaperOpacity} use:rangeSlider={store.customization.wallpaperOpacity} oninput={(event) => updateCustomization({ wallpaperOpacity: Number(event.currentTarget.value) })} /></label>
  {/if}
  <h3>Производительность</h3>
  <label class="settings-row"><span>Мягкие края фона</span><input class="switch" type="checkbox" role="switch" checked={store.customization.softEdges} onchange={(event) => updateCustomization({ softEdges: event.currentTarget.checked })} /></label>
  <label class="settings-row"><span>Анимации и блюр</span><input class="switch" type="checkbox" role="switch" checked={store.effects === "full"} onchange={(event) => setEffects(event.currentTarget.checked ? "full" : "reduced")} /></label>
  {#if selectedTheme.id !== "telegram"}
    <label class="settings-row"><span>Динамическое свечение</span><input class="switch" type="checkbox" role="switch" checked={store.customization.dynamicGlow} onchange={(event) => updateCustomization({ dynamicGlow: event.currentTarget.checked })} /></label>
  {/if}
  <label class="settings-row"><span>Выключить блюр сообщений</span><input class="switch" type="checkbox" role="switch" checked={!store.customization.bubbleBlur} onchange={(event) => updateCustomization({ bubbleBlur: !event.currentTarget.checked })} /></label>
  <button class="reset-customization" onclick={resetCustomization}>Сбросить оформление</button>
  {:else if settingsCategory === "chats"}
  <h3>Поведение интерфейса</h3>
  <div class="settings-row">
    <div class="setting-help">
      <label for="scroll-on-reply">Скроллить вниз при ответе на сообщение</label>
      <button class="help-button" type="button" aria-label="Подробнее о прокрутке при ответе" aria-describedby="scroll-on-reply-help"><Icon name="help-circle" size={16} /></button>
      <span id="scroll-on-reply-help" class="settings-tooltip" role="tooltip">Если вы ответите на любое сообщение, которое находится выше по истории, то вы будете перемещены сразу к последним сообщениям. Это стандартное поведение Telegram. Не включайте, если хотите читать историю сообщений и отвечать на них последовательно</span>
    </div>
    <input id="scroll-on-reply" class="switch" type="checkbox" role="switch" checked={store.scrollOnReply} onchange={(event) => setScrollOnReply(event.currentTarget.checked)} />
  </div>
  <h3>Анонимность</h3>
  {#each privacyOptions as { key, label } (key)}
    <label class="settings-row"><span>{label}</span><input class="switch" type="checkbox" role="switch" checked={key === "read" ? store.skipRead : store.chatPrivacy[key]} disabled={privacyBusy} onchange={(event) => void changeChatPrivacy(key, event.currentTarget)} /></label>
  {/each}
  {#if privacyError}<div class="inline-error" role="alert">{privacyError}</div>{/if}
  <h3>Сообщения</h3>
  <label class="settings-row"><span>Сохранять удалённые сообщения</span><input class="switch" type="checkbox" role="switch" checked={store.saveDeleted} disabled={archiveBusy} onchange={(event) => void changeArchive(event.currentTarget.checked)} /></label>
  {#if archiveError}<div class="inline-error" role="alert">{archiveError}</div>{/if}
  <h3>Стикеры</h3>
  <div class="settings-row recent-stickers-row"><span>Последних стикеров</span><div class="sticker-limits" role="group" aria-label="Количество последних стикеров">{#each [25, 50, 75, 100] as limit}<button class:active={store.recentStickerLimit === limit} aria-pressed={store.recentStickerLimit === limit} onclick={() => setRecentStickerLimit(limit)}>{limit}</button>{/each}</div></div>
  {:else if settingsCategory === "notifications"}
  {#each notificationOptions as { key, label } (key)}
    {@const disabled = notificationBusy || key !== "enabled" && !store.notifications.enabled || key === "group_mentions" && !store.notifications.group}
    <label class="settings-row" class:notification-child={key === "group_mentions"} class:notification-disabled={disabled}><span>{label}</span><input class="switch" type="checkbox" role="switch" checked={store.notifications[key]} {disabled} onchange={(event) => void changeNotifications(key, event.currentTarget)} /></label>
  {/each}
  {#if notificationError}<div class="inline-error" role="alert">{notificationError}</div>{/if}
  {:else if settingsCategory === "downloads"}
  {#if downloads}
    <label class="settings-row"><span>Диск для загрузок</span><select class="drive-select" value={downloads.drive} disabled={downloadsBusy} onchange={(event) => void changeDownloadDrive(event.currentTarget)}>
      {#each downloads.drives as drive (drive)}<option value={drive}>{drive}</option>{/each}
    </select></label>
    <div class="download-directory" title={downloads.directory}>{downloads.directory}</div>
  {:else if downloadsBusy}
    <div class="download-directory" role="status">Загрузка…</div>
  {:else}
    <button class="reset-customization" onclick={() => void changeDownloadDrive()}>Повторить</button>
  {/if}
  {#if downloadsError}<div class="inline-error" role="alert">{downloadsError}</div>{/if}
  {:else}
  <h3>Код-пароль приложения</h3>
  {#if !lockForm}
    <div class="lock-actions"><span>{store.appLock?.configured ? store.appLock.kind === "pin" ? "Код установлен" : "Пароль установлен" : "Не установлен"}</span><button onclick={() => chooseLock(store.appLock?.kind ?? "pin")}>{store.appLock?.configured ? "Изменить" : "Установить"}</button>{#if store.appLock?.configured}<button onclick={() => chooseLock("disable")}>Отключить</button>{/if}</div>
  {:else}
    <form class="lock-settings" onsubmit={saveLock}>
      {#if store.appLock?.configured}<SecretInput kind={store.appLock.kind ?? "password"} bind:value={currentSecret} label={store.appLock.kind === "pin" ? "Текущий код" : "Текущий пароль"} disabled={lockBusy} />{/if}
      {#if lockForm !== "disable"}
        <div class="lock-kind"><button type="button" class:chosen={lockForm === "pin"} onclick={() => chooseLock("pin")} disabled={lockBusy}>Код из 4 цифр</button><button type="button" class:chosen={lockForm === "password"} onclick={() => chooseLock("password")} disabled={lockBusy}>Пароль</button></div>
        {#key lockForm}<SecretInput kind={lockForm} bind:value={newSecret} label={lockForm === "pin" ? "Новый код" : "Новый пароль"} disabled={lockBusy} fresh /><SecretInput kind={lockForm} bind:value={confirmSecret} label={lockForm === "pin" ? "Повторите код" : "Повторите пароль"} disabled={lockBusy} fresh />{/key}
      {/if}
      <p class="lock-note">После 5 ошибок приложение выйдет из аккаунта.</p>
      {#if lockError}<div class="inline-error" role="alert">{lockError}</div>{/if}
      <div class="lock-actions"><button type="button" onclick={() => chooseLock(null)} disabled={lockBusy}>Отмена</button><button class="btn-accent" type="submit" disabled={lockBusy || !lockCanSave}>{lockForm === "disable" ? "Отключить" : "Сохранить"}</button></div>
    </form>
  {/if}
  {/if}
  </div>
  {/key}
  </div>
  <footer class="settings-version"><span>{appConfig.productName}</span><span>{appConfig.version}</span></footer>
</dialog>

<style>
  .sidebar { width: 310px; min-width: 260px; flex-shrink: 0; display: flex; flex-direction: column; border: 1px solid transparent; border-radius: 26px; min-height: 0; position: relative; z-index: 3 }
  .sidebar-surface { position: absolute; inset: -1px; z-index: -1; border-radius: inherit; pointer-events: none }
  .sidebar-top { padding: 18px 14px 0 }
  .profile-control { position: relative; margin-bottom: 20px }
  .profile-trigger { display: flex; width: 100%; align-items: center; gap: 12px; text-align: left; padding: 2px 4px }
  .profile-trigger > :global(.icon) { color: var(--text-secondary); margin-left: auto }
  .profile-text { min-width: 0; display: flex; flex-direction: column; gap: 5px }
  .profile-text strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 175px }
  .connection { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-secondary) }
  .profile-dropdown { position: absolute; top: calc(100% + 8px); left: -3px; right: -3px; z-index: 20; padding: 5px 5px; border-radius: 9px; opacity: 0; visibility: hidden; transform: translateY(-7px) scale(.97); transform-origin: top center; transition: opacity .18s, transform .2s, visibility .18s; background: var(--menu-bg) }
  .profile-control::after { content: ""; position: absolute; top: 100%; left: 0; right: 0; height: 12px }
  .profile-dropdown.open { opacity: 1; visibility: visible; transform: translateY(0) scale(1) }
  .profile-dropdown > button { display: flex; align-items: center; gap: 11px; width: 100%; padding: 11px 12px; border-radius: 12px; text-align: left; font-size: 13px }
  .profile-dropdown > button:hover { background: var(--hover) }
  .profile-dropdown .logout { color: var(--danger); margin-top: 3px }
  .privacy-toggle { display: flex; align-items: center; gap: 11px; padding: 9px 12px; font-size: 13px; cursor: pointer }
  .privacy-toggle .switch { margin-left: auto }
  .settings-dialog { --settings-inset: 24px; --settings-gap: 13px; width: 420px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow-y: auto; padding: 24px 0; border-radius: 26px; color: var(--text-primary); background: var(--menu-bg) }
  .settings-dialog::backdrop { background: rgba(0,0,0,.5); backdrop-filter: blur(8px) }
  .settings-dialog header { display: flex; align-items: center; justify-content: space-between; padding-inline: var(--settings-inset) }
  .settings-dialog header h2 { flex: 1 }
  .settings-back { margin-left: -8px; margin-right: 6px }
  .settings-pages { display: grid; overflow: hidden; padding-top: 12px }
  .settings-page { grid-area: 1 / 1; min-width: 0; padding-inline: var(--settings-inset) }
  .settings-categories { --category-inset: 8px; display: grid; gap: 3px; margin: 18px calc(var(--category-inset) - var(--settings-inset)) 0 }
  .settings-categories button { display: grid; grid-template-columns: calc((var(--settings-avatar-size) + 20px) / 2) minmax(0, 1fr) 17px; align-items: center; gap: var(--settings-gap); width: 100%; padding: 12px calc(var(--settings-inset) - var(--category-inset)); border-radius: 12px; text-align: left; font-size: 14px }
  .settings-categories button:hover { background: var(--hover) }
  .settings-categories button:focus-visible { outline-offset: -2px }
  .settings-categories :global(.icon) { justify-self: end; color: var(--text-secondary) }
  .settings-version { display: grid; justify-items: center; gap: 3px; padding-top: 24px; color: var(--text-tertiary); font-size: 11px }
  .settings-version span + span { font-size: 10px }
  .theme-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px 10px; padding: 6px 2px 16px }
  .theme-choice { display: grid; gap: 7px; min-width: 0; padding: 0; font-size: 11px; color: var(--text-secondary); text-align: center }
  .theme-choice.chosen { color: var(--accent-hover) }
  .theme-swatch { position: relative; display: flex; flex-direction: column; justify-content: center; gap: 5px; height: 62px; padding: 12px; border-radius: 14px; background-size: cover; background-position: center }
  .chosen .theme-swatch { outline: 2px solid var(--accent); outline-offset: 2px }
  .theme-swatch i { width: 62%; height: 11px; background: var(--preview-in); border-radius: 7px 7px 7px 2px }
  .theme-swatch i + i { align-self: flex-end; width: 72%; background: var(--preview-out); border-radius: 7px 7px 2px 7px }
  .theme-check { position: absolute; bottom: 4px; right: 4px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: var(--text-on-accent) }
  .theme-colors { display: flex; gap: 24px; padding: 6px 0 13px }
  .theme-colors label { display: flex; align-items: center; gap: 9px; font-size: 13px }
  .theme-colors input { width: 28px; height: 28px; padding: 0; border-radius: 50%; overflow: hidden; background: transparent; cursor: pointer }
  .theme-colors input::-webkit-color-swatch-wrapper { padding: 0 }
  .theme-colors input::-webkit-color-swatch { border: 0; border-radius: 50% }
  .wallpaper-actions { display: flex; align-items: center; gap: 18px; padding: 5px 0 9px }
  .wallpaper-actions button { display: flex; align-items: center; gap: 7px; padding: 5px 0; color: var(--accent-hover); font-size: 12px }
  .custom-slider { display: grid; gap: 8px; padding: 11px 0; font-size: 12px }
  .custom-slider > span { display: flex; align-items: center; justify-content: space-between; gap: 10px }
  .custom-slider output { color: var(--text-secondary); font-size: 11px }
  .custom-slider input { width: 100%; margin: 0; accent-color: var(--accent); cursor: pointer }
  .reset-customization { margin-top: 8px; padding: 5px 0; color: var(--text-secondary); font-size: 11px }
  .reset-customization:hover { color: var(--accent-hover) }
  .settings-dialog h2 { margin: 0; font-size: 21px; font-weight: 550 }
  .settings-dialog h3 { margin: 22px 0 8px; font-size: 18px; color: var(--text-primary); font-weight: 600 }
  .settings-page > h3:first-child { margin-top: 4px }
  .settings-account { display: flex; align-items: center; gap: var(--settings-gap); margin-top: 6px }
  .settings-account > span { display: grid; gap: 5px }
  .settings-account strong { font-size: 16px; font-weight: 500 }
  .settings-account span span { font-size: 12px; color: var(--text-secondary) }
  .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 9px 0; font-size: 14px; cursor: pointer }
  .setting-help { position: relative; display: flex; align-items: center; gap: 6px; min-width: 0 }
  .setting-help label { cursor: pointer }
  .help-button { display: grid; place-items: center; flex-shrink: 0; padding: 3px; border-radius: 50%; color: var(--text-secondary) }
  .help-button:hover, .help-button:focus-visible { color: var(--text-primary) }
  .settings-tooltip { display: none; position: absolute; z-index: 2; top: calc(100% + 6px); inset-inline-start: 0; width: min(285px, calc(100vw - 84px)); padding: 9px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg-sidebar); color: var(--text-primary); font-size: 12px; line-height: 1.5; pointer-events: none }
  .help-button:is(:hover, :focus-visible) + .settings-tooltip { display: block }
  .download-directory { padding-bottom: 8px; color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; user-select: text }
  .notification-child { padding-inline-start: 14px; font-size: 13px }
  .notification-disabled { color: var(--text-secondary); cursor: default }
  .font-select, .drive-select { max-width: 100%; padding: 6px 9px; color: var(--text-primary); background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 8px; font-size: 13px; cursor: pointer }
  .font-select { min-width: min(150px, 100%) }
  .layout-select { min-width: 0; max-width: 55% }
  @supports (appearance: base-select) {
    .font-select, .font-select::picker(select) { appearance: base-select }
    .font-select::picker(select) { margin-block: 5px; min-width: 246px; padding: 4px; color: var(--text-primary); background: var(--bg-sidebar); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 10px 28px rgba(0,0,0,.28) }
    .font-select::picker-icon { color: var(--text-secondary) }
    .font-select optgroup { font-size: 11px; color: var(--text-secondary) }
    .font-select optgroup + optgroup { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px }
    .font-select option { min-height: 30px; padding: 5px 7px; border-radius: 5px; font-size: 14px; font-weight: 400; color: var(--text-primary); cursor: pointer }
    .font-select option::after { content: "Привет 123" / ""; margin-inline-start: auto; padding-inline-start: 12px; color: var(--text-secondary); font-size: 12px }
    .font-select option:hover, .font-select option:focus-visible { background: var(--hover) }
    .font-select option:checked { background: var(--accent-soft) }
    .font-select option::checkmark { color: var(--accent-hover) }
  }
  .recent-stickers-row { gap: 10px; flex-wrap: wrap; cursor: default }
  .sticker-limits { display: flex; gap: 3px }
  .sticker-limits button { padding: 6px 9px; border-radius: 18px; color: var(--text-secondary); font-size: 12px }
  .sticker-limits button:hover { background: var(--hover) }
  .sticker-limits .active { background: var(--accent); color: var(--text-on-accent) }
  .switch { appearance: none; width: 40px; height: 24px; border-radius: 20px; background: #303744; padding: 3px; margin: 0; flex-shrink: 0; cursor: pointer; transition: background .18s }
  .switch::before { content: ""; display: block; width: 18px; height: 18px; border-radius: 50%; background: white; transition: transform .18s }
  .switch:checked { background: var(--accent) }
  .switch:checked::before { transform: translateX(16px) }
  .lock-actions { display: flex; align-items: center; gap: 12px; padding: 12px 0 0; font-size: 13px }
  .settings-page > .lock-actions { padding-top: 4px }
  .lock-actions > span { margin-right: auto; color: var(--text-secondary); font-size: 12px }
  .lock-actions > button { color: var(--accent-hover); padding: 6px 0 }
  .lock-actions > .btn-accent { margin-left: auto; padding: 9px 16px; color: var(--text-on-accent) }
  .lock-settings { display: grid; gap: 14px; padding-top: 8px }
  .lock-kind { display: flex; gap: 7px }
  .lock-kind button { padding: 7px 11px; border-radius: 20px; font-size: 12px; color: var(--text-secondary) }
  .lock-kind .chosen { background: var(--accent); color: white }
  .lock-note { margin: 0; color: var(--text-secondary); font-size: 11px; line-height: 1.5 }
  .search { display: flex; align-items: center; gap: 9px; height: 40px; padding: 0 14px; border-radius: 22px; color: var(--text-secondary); background: var(--bg-input) }
  .search input { width: 100%; min-width: 0; padding: 0; background: transparent; font-size: 12px }
  .folders { display: flex; gap: 6px; overflow-x: auto; margin: 0 14px 10px; padding: 13px 0 3px; scrollbar-width: none }
  .folders button { position: relative; z-index: 0; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; padding: 7px 12px; border-radius: 20px; font-size: 12px; color: var(--text-secondary); flex-shrink: 0; transition: background .18s, color .18s }
  .folder-count { min-width: 19px; padding: 1px 5px; border-radius: 10px; background: color-mix(in srgb, currentColor 15%, transparent); font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; text-align: center }
  .folders button:hover { background: var(--hover); color: var(--text-primary) }
  .folders button.active { color: var(--folder-active-text, var(--text-on-accent)) }
  .pill-active { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: var(--folder-active, var(--accent)); pointer-events: none }
  .flat-sidebar { border: 0; border-radius: 0 }
  .folder-rail { --folder-rail-width: 64px; display: grid; grid-template-columns: var(--folder-rail-width) minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; width: clamp(265px, 25vw, 310px); border-inline-end: 1px solid var(--border) }
  .folder-rail::before { position: absolute; inset: 0 auto 0 0; z-index: -1; width: var(--folder-rail-width); background: color-mix(in srgb, var(--bg-sidebar) 55%, transparent); content: ""; pointer-events: none }
  .folder-rail .sidebar-top { grid-area: 1 / 2; padding: 12px 9px 7px }
  .folder-rail .profile-control { margin-bottom: 9px }
  .folder-rail .search { height: 34px; padding-inline: 10px }
  .folder-rail .folders { grid-area: 1 / 1 / 3 / 2; flex-direction: column; overflow: auto; margin: 0; padding: 10px 5px 4px }
  .folder-rail .folders button { display: grid; justify-items: center; gap: 4px; padding: 7px 3px; border-radius: 10px; font-size: 10px }
  .folder-rail .folder-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis }
  .folder-rail .folder-count { position: absolute; right: 2px; top: 1px; min-width: 14px; padding: 0 3px; background: var(--accent); color: var(--text-on-accent); font-size: 9px; line-height: 14px }
  .folder-rail .list { grid-area: 2 / 2 / 4 / 3; padding-inline: 5px }
  .folder-rail .chat-item { gap: 7px; padding: 7px 5px; border-radius: 11px }
  .folder-rail .row1 strong { font-size: 12px }
  .folder-rail .preview { font-size: 11px }
  .rail-settings { grid-area: 3 / 1; display: grid; justify-items: center; gap: 4px; margin: 3px 5px 8px; padding: 7px 2px; border-radius: 10px; color: var(--text-secondary); font-size: 10px }
  .rail-settings:hover { background: var(--hover); color: var(--text-primary) }
  .list { overflow-y: auto; flex: 1; min-height: 0; padding: 0 8px 10px; scrollbar-gutter: stable }
  .pinned-divider { margin: 5px 8px 7px; border: 0; border-top: 1px solid var(--border) }
  .chat-item { width: 100%; display: flex; align-items: center; gap: 9px; padding: 10px 8px; border-radius: 17px; text-align: left; margin-bottom: 2px; transition: background .16s }
  .chat-item:hover { background: var(--hover) }
  .chat-item.active { background: var(--accent-soft) }
  .chat-info { flex: 1; min-width: 0; display: grid; gap: 3px }
  .chat-info, .chat-avatar { transition: filter .18s, opacity .18s }
  .privacy-hidden .chat-info, .privacy-hidden .chat-avatar { filter: blur(5px) grayscale(1); opacity: .5 }
  .chat-avatar { position: relative; display: flex; flex-shrink: 0 }
  .mute-icon { position: absolute; right: -2px; bottom: -2px; display: grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--bg-sidebar); border-radius: 50%; background: #626872; color: #fff }
  .chat-item.privacy-hidden:hover { background: rgba(135,140,150,.08) }
  .row1, .row2 { display: flex; align-items: center; justify-content: space-between; gap: 7px; min-width: 0 }
  .row1 strong { font-size: 14px; font-weight: 550; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .chat-meta { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; color: var(--text-tertiary) }
  .preview-delivery { display: inline-flex }
  .preview-delivery.read { color: var(--accent-hover) }
  .preview-delivery.failed { color: var(--danger) }
  .time { font-size: 11px; color: var(--text-tertiary); flex-shrink: 0 }
  .preview { display: flex; align-items: baseline; gap: 4px; min-width: 0; font-size: 13px; color: var(--text-secondary) }
  .preview-author, .preview-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .preview-author { color: var(--accent-hover); max-width: 50%; flex-shrink: 0 }
  .preview :global(svg) { display: inline; vertical-align: -2px; margin-right: 3px }
  .row2 > :global(svg) { flex-shrink: 0; color: var(--text-tertiary) }
  .badge { min-width: 18px; border-radius: 8px; padding: 2px 5px; background: #5a5e64a8; color: #ffffffb0; font-size: 9px; font-weight: 500; text-align: center; flex-shrink: 0 }
  .unread-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex-shrink: 0 }
  .muted .unread-dot { background: #626872; color: #fff }
  .stale .chat-item { filter: blur(5px); pointer-events: none; cursor: default }
  .load-more { color: var(--text-secondary); font-size: 11px; padding: 13px; width: 100%; border-radius: 14px }
  .load-more:hover { color: var(--accent); background: var(--hover) }
  .empty { color: var(--text-secondary); text-align: center; padding: 35px 10px; font-size: 12px }
  @media (max-width: 820px) { .sidebar { width: 280px; min-width: 230px } .sidebar-top { padding: 15px 11px 0 } .folders { margin: 0 11px 8px } }
</style>
