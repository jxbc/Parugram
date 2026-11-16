<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import Avatar from "$lib/components/Avatar.svelte"
  import RichText from "$lib/components/RichText.svelte"
  import MessageBubble from "$lib/components/chat/MessageBubble.svelte"
  import { untrack } from "svelte"
  import { slide } from "svelte/transition"
  import { openPath } from "@tauri-apps/plugin-opener"
  import { formatDuration, formatFileSize } from "$lib/utils"
  import { store, api, openProfile, closeProfile, openConversation, openMediaItems, openMediaViewer, mediaItem, chatMuted, setChatMuted } from "$lib/stores/app.svelte"
  import type { FileData, MsgData, SenderData, ProfileData } from "$lib/api/td"

  let { embedded = false, compact = false, details = null, detailsLoading = false, detailsError = "", onclose }: {
    embedded?: boolean; compact?: boolean; details?: ProfileData | null; detailsLoading?: boolean; detailsError?: string; onclose?: () => void
  } = $props()
  const panelId = $props.id()
  const mediaTabs = [
    { id: "media", title: "Медиа" }, { id: "links", title: "Ссылки" },
    { id: "files", title: "Файлы" }, { id: "voice", title: "Голосовые" },
  ] as const
  type Tab = (typeof mediaTabs)[number]["id"] | "photos"
  type MemberView = "all" | "online"

  let panel: HTMLElement | undefined = $state()
  const dialog = $derived(!embedded ? panel as HTMLDialogElement | undefined : undefined)
  let tab = $state<Tab>("media")
  let photos = $state<FileData[]>([])
  let messages = $state<MsgData[]>([])
  let busy = $state(false)
  let error = $state("")
  let more = $state(false)
  let cursor = 0
  let offset = 0
  let request = 0
  let memberView = $state<MemberView | null>(null)
  let members = $state<SenderData[]>([])
  let membersLoading = $state(false)
  let membersError = $state(false)
  let membersMore = $state(false)
  let memberOffset = 0
  let memberRequest = 0
  let fileError = $state("")
  let openingFile = $state<number | null>(null)
  let muteError = $state("")
  let detailsOpen = $state(false)
  const profile = $derived(embedded ? details : store.profile)
  const profileLoading = $derived(embedded ? detailsLoading : store.profileLoading)
  const profileError = $derived(embedded ? detailsError : store.profileError)
  const tabs = $derived(profile?.kind === "user" ? [...mediaTabs, { id: "photos", title: "Фото" } as const] : mediaTabs)
  const muted = $derived(profile ? chatMuted(profile.chat) : false)
  const muteLabel = $derived(muted ? "Включить звук" : "Выключить звук")
  const onlineCount = $derived(profile?.chat.is_group ? store.onlineCounts.get(profile.chat.id) : undefined)
  const openingMembers = $derived(membersLoading && !members.length)
  const membersExpanded = $derived(!!memberView && !openingMembers)
  const hasDetails = $derived(!!profile && !!(profile.bio || profile.usernames.length || profile.phone || profile.birthdate || profile.common_groups))
  const status = $derived(profile?.last_seen ? `был(а) ${new Date(profile.last_seen * 1000).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : profile?.status ?? "")

  async function openSharedFile(message: MsgData) {
    if (message.content.kind !== "File" || openingFile !== null) return
    if (mediaItem(message)) {
      openMediaViewer(message, messages)
      return
    }
    const account = store.user?.id
    const fileId = message.content.data.file_id
    openingFile = fileId
    fileError = ""
    try {
      const path = store.files.get(fileId) ?? (await api.downloadFile(fileId)).local_path
      if (store.user?.id !== account || store.stage !== "ready" || store.appLock?.locked) return
      if (!path) throw new Error("download")
      store.files.set(fileId, path)
      await openPath(path)
    } catch { fileError = "Не удалось открыть файл" }
    finally { openingFile = null }
  }

  $effect(() => {
    if (!dialog) return
    if (store.profileTarget && !dialog.open) dialog.showModal()
    else if (!store.profileTarget && dialog.open) dialog.close()
  })

  $effect(() => {
    const current = profile
    request += 1
    memberRequest += 1
    tab = "media"
    photos = []
    messages = []
    memberView = null
    members = []
    membersLoading = false
    membersError = false
    membersMore = false
    memberOffset = 0
    busy = false
    error = ""
    fileError = ""
    muteError = ""
    detailsOpen = false
    more = false
    cursor = 0
    offset = 0
    if (current && store.chatsReady) untrack(() => void load())
    return () => {
      request += 1
      memberRequest += 1
    }
  })

  async function load(reset = false) {
    if (!profile || (busy && !reset)) return
    const currentProfile = profile
    const currentTab = tab
    const token = ++request
    if (reset) {
      photos = []
      messages = []
      cursor = 0
      offset = 0
      more = false
      fileError = ""
    }
    busy = true
    error = ""
    try {
      if (currentTab === "photos") {
        const page = await api.profilePhotos(currentProfile.id, offset)
        if (token !== request) return
        const known = new Set(photos.map((photo) => photo.file_id))
        photos = [...photos, ...page.photos.filter((photo) => !known.has(photo.file_id))]
        offset += page.photos.length
        more = page.photos.length > 0 && offset < page.total_count
      } else {
        const page = await api.profileMedia(currentProfile.chat.id, currentTab, cursor)
        if (token !== request) return
        const known = new Set(messages.map((message) => message.id))
        messages = [...messages, ...page.messages.filter((message) => !known.has(message.id))]
        more = page.next_from_message_id !== 0 && page.next_from_message_id !== cursor
        cursor = page.next_from_message_id
      }
    } catch {
      if (token === request) error = "Не удалось загрузить"
    } finally {
      if (token === request) busy = false
    }
  }

  function selectTab(id: Tab) {
    if (tab === id) return
    tab = id
    void load(true)
  }

  function toggleMembers(view: MemberView) {
    memberRequest += 1
    membersLoading = false
    memberView = memberView === view ? null : view
    if (!memberView) return
    members = []
    membersMore = false
    memberOffset = 0
    void loadMembers()
  }

  async function loadMembers() {
    const current = profile
    const view = memberView
    if (!current || !view || membersLoading) return
    const token = ++memberRequest
    membersLoading = true
    membersError = false
    try {
      const page = await api.profileMembers(current.chat.id, memberOffset, view === "online")
      if (token !== memberRequest) return
      const known = new Set(members.map((member) => `${member.kind}:${member.id}`))
      const added = page.filter((member) => !known.has(`${member.kind}:${member.id}`))
      members = [...members, ...added]
      memberOffset += page.length
      membersMore = view === "all" && added.length > 0 && (!current.member_count || memberOffset < current.member_count)
    } catch {
      if (token === memberRequest) membersError = true
    } finally {
      if (token === memberRequest) membersLoading = false
    }
  }

  async function toggleNotifications() {
    const current = profile
    if (!current) return
    muteError = ""
    try { await setChatMuted(current.chat.id, !muted) }
    catch { if (profile === current) muteError = "Не удалось изменить уведомления" }
  }

  function showPhoto(fileId: number | null) {
    if (!fileId || !profile) return
    const ids = photos.map((photo) => photo.file_id)
    if (!ids.includes(fileId)) ids.unshift(fileId)
    openMediaItems(ids.map((id) => ({ key: `profile:${id}`, kind: "photo", file_id: id, caption: profile?.title ?? "", file_name: "Фото профиля" })), ids.indexOf(fileId))
  }

  function backdrop(event: MouseEvent) {
    if (event.target !== dialog || !dialog) return
    const box = dialog.getBoundingClientRect()
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeProfile()
  }

  function cancel(event: Event) {
    event.preventDefault()
    closeProfile()
  }
</script>

<svelte:element this={embedded ? "aside" : "dialog"} role={embedded ? "complementary" : "dialog"} bind:this={panel} class="profile-panel glass" class:embedded class:compact-panel={compact} aria-label="Профиль" onclick={backdrop} oncancel={cancel}>
  {#if profile || !embedded || onclose}
    <div class="panel-tools">
      {#if profile}
        {#if !embedded}
          {@const chatLabel = profile.kind === "user" && profile.id !== store.user?.id ? "Написать" : "Открыть чат"}
          <button class="icon-button" aria-label={chatLabel} title={chatLabel} onclick={() => openConversation(profile.chat)}><Icon name="chat-bubble" size={18} /></button>
        {/if}
        <button class="icon-button" aria-label={muteLabel} title={muteLabel} aria-pressed={muted} disabled={!store.chatsReady || store.chatMutePending.has(profile.chat.id)} onclick={toggleNotifications}><Icon name={muted ? "bell" : "bell-off"} size={18} /></button>
        {#if hasDetails}
          <button class="icon-button" aria-label="Информация" title="Информация" aria-expanded={detailsOpen} aria-controls={detailsOpen ? panelId + "-info" : undefined} onclick={() => detailsOpen = !detailsOpen}><Icon name="info-circle" size={18} /></button>
        {/if}
      {/if}
      {#if !embedded || onclose}
        <button class="icon-button panel-close" aria-label="Закрыть профиль" title="Закрыть профиль" onclick={onclose ?? closeProfile}><Icon name="xmark" size={18} /></button>
      {/if}
    </div>
  {/if}
  <div class="panel-scroll">
    {#if profileLoading}
      <div class="loading-profile"><div class="skeleton avatar-skeleton"></div><div class="skeleton name-skeleton"></div><span>Загрузка...</span></div>
    {:else if profileError}
      <div class="inline-error" role="alert">{profileError}</div>{#if !embedded}<button class="retry" onclick={() => { if (store.profileTarget) void openProfile(store.profileTarget) }}>Повторить</button>{/if}
    {:else if profile}
      <div class="profile-hero">
        <button class="hero-photo" aria-label="Открыть фотографию профиля" disabled={!profile.photo_file_id} onclick={() => showPhoto(profile.photo_file_id)}><Avatar id={profile.id} title={profile.title} fileId={profile.photo_file_id} path={profile.photo} size={80} /></button>
        <h2>{profile.title}{#if profile.is_verified}<Icon name="badge-check" size={17} />{/if}{#if profile.is_premium}<Icon name="sparks" size={15} />{/if}</h2>
        {#if !profile.can_view_members && (status || profile.member_count > 0)}
          <div class="profile-status">{#if status}<span>{status}</span>{/if}{#if profile.member_count > 0}<span>{profile.member_count.toLocaleString("ru")} участников</span>{/if}</div>
        {/if}
        {#if muteError}<span class="inline-error" role="alert">{muteError}</span>{/if}
      </div>

      {#if hasDetails && detailsOpen}
        <dl id={panelId + "-info"} class="profile-details">
          {#if profile.bio}<div class="profile-bio"><dt>О себе</dt><dd><RichText text={profile.bio} entities={profile.bio_entities} /></dd></div>{/if}
          {#if profile.usernames.length}<div><dt>Имя пользователя</dt><dd>{#each profile.usernames as username}<span class="username">@{username}</span>{/each}</dd></div>{/if}
          {#if profile.phone}<div><dt>Телефон</dt><dd>+{profile.phone.replace(/^\+/, "")}</dd></div>{/if}
          {#if profile.birthdate}<div><dt>День рождения</dt><dd>{new Date(profile.birthdate.year || 2000, profile.birthdate.month - 1, profile.birthdate.day).toLocaleDateString("ru", { day: "numeric", month: "long", ...(profile.birthdate.year ? { year: "numeric" } : {}) })}</dd></div>{/if}
          {#if profile.common_groups > 0}<div><dt>Общие группы</dt><dd>{profile.common_groups}</dd></div>{/if}
        </dl>
      {/if}

      {#if profile.can_view_members}
        <div class="profile-members">
          <button class="member-trigger" aria-expanded={membersExpanded && memberView === "all"} aria-busy={openingMembers && memberView === "all"} aria-controls={membersExpanded && memberView === "all" ? panelId + "-members" : undefined} onclick={() => toggleMembers("all")}>
            <Icon name="group" size={18} /><span>Участники</span><small>{profile.member_count.toLocaleString("ru")}</small><Icon name={openingMembers && memberView === "all" ? "clock" : "nav-arrow-down"} size={15} />
          </button>
          {#if (onlineCount ?? 0) > 0 || memberView === "online"}
            <button class="member-trigger" aria-expanded={membersExpanded && memberView === "online"} aria-busy={openingMembers && memberView === "online"} aria-controls={membersExpanded && memberView === "online" ? panelId + "-members" : undefined} onclick={() => toggleMembers("online")}>
              <Icon name="user" size={18} /><span>В сети</span><small>{(onlineCount ?? 0).toLocaleString("ru")}</small><Icon name={openingMembers && memberView === "online" ? "clock" : "nav-arrow-down"} size={15} />
            </button>
          {/if}
          {#if membersExpanded}
            <div id={panelId + "-members"} class="member-panel" transition:slide={{ duration: store.effects === "full" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 200 : 0 }}>
              <div class="member-list" aria-busy={membersLoading}>
                {#each members as member (`${member.kind}:${member.id}`)}
                  <button onclick={() => openProfile({ kind: member.kind, id: member.id })}><Avatar id={member.id} title={member.name} fileId={member.photo_file_id} path={member.photo} size={32} /><span>{member.name || "Пользователь"}</span><Icon name="nav-arrow-right" size={15} /></button>
                {/each}
                {#if membersLoading}<span class="empty">Загрузка...</span>
                {:else if membersError}<button class="retry" onclick={() => loadMembers()}>Повторить загрузку</button>
                {:else if !members.length}<span class="empty">Никого нет</span>
                {:else if membersMore}<button class="retry" onclick={() => loadMembers()}>Ещё</button>{/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <nav class="profile-tabs" aria-label="Содержимое профиля">
        {#each tabs as item (item.id)}
          <button class:active={tab === item.id} aria-pressed={tab === item.id} onclick={() => selectTab(item.id)}>{item.title}</button>
        {/each}
      </nav>
      {#if tab === "photos"}
        <div class="media-grid">{#each photos as photo (photo.file_id)}<button aria-label="Открыть фотографию" onclick={() => showPhoto(photo.file_id)}><Avatar id={photo.file_id} title={profile.title} fileId={photo.file_id} path={photo.local_path} size={96} /></button>{/each}</div>
      {:else if tab === "media"}
        <div class="media-grid">
          {#each messages as message (message.id)}
            {@const content = message.content}
            {#if content.kind === "Photo" || content.kind === "Video"}
              <button aria-label={content.kind === "Video" ? "Открыть видео" : "Открыть фото"} onclick={() => openMediaViewer(message, messages)}>
                {#if content.kind === "Photo"}
                  <Avatar id={message.id} title="Фото" fileId={content.data.thumbnail_file_id || content.data.file_id} size={96} />
                {:else}
                  {#if content.data.thumbnail_file_id}<Avatar id={message.id} title="Видео" fileId={content.data.thumbnail_file_id} size={96} />{:else}<Icon name="play" size={23} />{/if}
                  <span class="media-duration">{formatDuration(content.data.duration)}</span>
                {/if}
              </button>
            {/if}
          {/each}
        </div>
      {:else if tab === "files"}
        <div class="profile-files">
          {#each messages as message (message.id)}
            {#if message.content.kind === "File"}
              {@const file = message.content.data}
              <button class="file-row" title={file.file_name} disabled={openingFile !== null} onclick={() => openSharedFile(message)}>
                <Icon name="page" size={23} /><span><strong>{file.file_name}</strong><small>{openingFile === file.file_id ? "Загрузка..." : formatFileSize(file.size)}</small></span>
              </button>
            {/if}
          {/each}
        </div>
        {#if fileError}<div class="inline-error" role="alert">{fileError}</div>{/if}
      {:else}
        <div class="shared-messages">{#each messages as message (message.id)}<MessageBubble msg={message} actions={false} mediaMessages={messages} />{/each}</div>
      {/if}
      {#if error}<div class="inline-error" role="alert">{error}</div><button class="retry" onclick={() => load()}>Повторить</button>
      {:else if busy}<div class="empty">Загрузка...</div>
      {:else if !photos.length && !messages.length}<div class="empty">Пока пусто</div>
      {:else if more}<button class="retry" onclick={() => load()}>Ещё</button>{/if}
    {/if}
  </div>
</svelte:element>
<style>
  .profile-panel { position: fixed; inset: 14px; width: 360px; height: fit-content; max-width: calc(100vw - 28px); max-height: calc(100vh - 28px); margin: auto; padding: 0; border-radius: 20px; color: var(--text-primary); overflow: hidden; background: var(--menu-bg) }
  .profile-panel:global([open]), .profile-panel.embedded { display: flex; flex-direction: column }
  .profile-panel.embedded { position: relative; inset: auto; width: clamp(245px, 23vw, 320px); min-width: 0; max-height: 100%; height: 100%; margin: 0; flex-shrink: 0; background: var(--surface) }
  .profile-panel.compact-panel { width: clamp(244px, 21vw, 310px); border: 0; border-inline-start: 1px solid var(--border); border-radius: 0; background: transparent; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none }
  .profile-panel::backdrop { background: rgba(4,7,12,.42); backdrop-filter: blur(3px) }
  @media (prefers-reduced-motion: no-preference) {
    .profile-panel:global([open]) { animation: appear .22s ease-out }
  }
  .panel-tools { display: flex; justify-content: flex-end; flex-shrink: 0; gap: 2px; padding: 5px 8px 0 }
  .panel-tools .icon-button { width: 27px; height: 27px }
  .panel-tools [aria-pressed="true"] { color: var(--accent-hover) }
  .panel-tools button:disabled { opacity: .5 }
  .panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 5px 14px 14px }
  .profile-hero { display: grid; justify-items: center; gap: 9px; padding: 4px 8px 24px; text-align: center }
  .hero-photo { padding: 0; border-radius: 50% }
  h2 { margin: 0; font-size: 15px; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere }
  h2 :global(svg) { margin-inline-start: 5px; vertical-align: -.15em; color: var(--accent-hover) }
  .profile-status { display: flex; justify-content: center; flex-wrap: wrap; gap: 2px 8px; color: var(--text-secondary); font-size: 11px }
  .profile-members { display: grid; gap: 4px }
  .member-trigger { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 5px; border-radius: 8px; color: var(--text-primary); text-align: left; font-size: 12px }
  .member-trigger:hover, .member-trigger[aria-expanded="true"] { background: var(--hover) }
  .member-trigger > span:nth-child(2) { flex: 1 }
  .member-trigger :global(.icon), .member-trigger small { color: var(--text-secondary) }
  .member-trigger small { font-size: 11px; font-variant-numeric: tabular-nums }
  .member-trigger :global(.icon:last-child) { transition: transform .2s ease }
  .member-trigger[aria-expanded="true"] :global(.icon:last-child) { transform: rotate(180deg) }
  @media (prefers-reduced-motion: reduce) { .member-trigger :global(.icon:last-child) { transition: none } }
  .member-list { display: grid; gap: 2px; max-height: 216px; overflow-y: auto; overscroll-behavior: contain; padding: 1px 0 }
  .member-list > button:not(.retry) { display: flex; align-items: center; gap: 8px; text-align: left; width: 100%; padding: 4px 8px; border-radius: 9px; font-size: 12px }
  .member-list > button:hover { background: var(--hover) }
  .member-list > button > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .member-list :global(.icon) { color: var(--text-secondary) }
  .profile-details { margin: 0 0 4px; padding-inline: 5px }
  .profile-details > div { display: grid; grid-template-columns: minmax(0, 100px) minmax(0, 1fr); align-items: baseline; gap: 4px 8px; padding: 6px 0 }
  .profile-details > .profile-bio { grid-template-columns: minmax(0, 1fr) }
  dt { color: var(--text-secondary); font-size: 11px }
  dd { margin: 0; font-size: 12px; line-height: 1.5; user-select: text; overflow-wrap: anywhere }
  .username { display: block; color: var(--accent-hover) }
  .profile-tabs { display: flex; gap: 2px; margin-top: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none }
  .profile-tabs button { flex: 1 0 auto; padding: 5px 4px; border-radius: 8px; color: var(--text-secondary); font-size: 11px; white-space: nowrap }
  .profile-tabs button:hover { background: var(--hover); color: var(--text-primary) }
  .profile-tabs button:focus-visible, .member-trigger:focus-visible, .media-grid button:focus-visible { outline-offset: -2px }
  .profile-tabs .active { background: var(--hover); color: var(--text-primary) }
  .media-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; margin-top: 6px }
  .media-grid button { display: grid; place-items: center; position: relative; min-width: 0; aspect-ratio: 1; padding: 0; border-radius: 6px; overflow: hidden; background: var(--bg-input); color: var(--accent-hover) }
  .media-grid :global(.avatar) { width: 100% !important; height: 100% !important; border-radius: 0 }
  .media-duration { position: absolute; right: 4px; bottom: 4px; padding: 2px 5px; border-radius: 6px; background: #000a; color: #fff; font-size: 10px }
  .profile-files { display: grid; gap: 4px; margin-top: 7px }
  .file-row { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 7px 8px; border-radius: 9px; text-align: left }
  .file-row:hover { background: var(--hover) }
  .file-row :global(.icon) { color: var(--accent-hover) }
  .file-row > span:nth-child(2) { display: grid; gap: 2px; min-width: 0 }
  .file-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500 }
  .file-row small { color: var(--text-secondary); font-size: 10px }
  .shared-messages { display: grid; gap: 5px; margin-top: 5px }
  .shared-messages :global(.bubble-row) { max-width: 100%; justify-self: start }
  .shared-messages :global(.bubble-row.out) { justify-self: end }
  .retry { margin: 5px auto; display: block; padding: 6px 10px; color: var(--accent-hover); font-size: 12px; border-radius: 9px }
  .retry:hover { background: var(--hover) }
  .empty { display: block; text-align: center; color: var(--text-secondary); padding: 10px 0; font-size: 11px }
  .loading-profile { display: grid; justify-items: center; gap: 8px; padding: 8px 0; color: var(--text-secondary); font-size: 11px }
  .skeleton { background: var(--hover); border-radius: 10px }
  .avatar-skeleton { width: 80px; height: 80px; border-radius: 50% }
  .name-skeleton { width: 115px; height: 14px }
</style>
