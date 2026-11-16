<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import Avatar from "$lib/components/Avatar.svelte"
  import RichText from "$lib/components/RichText.svelte"
  import MessageBubble from "$lib/components/chat/MessageBubble.svelte"
  import { openPath } from "@tauri-apps/plugin-opener"
  import { formatFileSize } from "$lib/utils"
  import { store, api, openProfile, closeProfile, openConversation, openMediaItems, openMediaViewer, mediaItem } from "$lib/stores/app.svelte"
  import type { FileData, MsgData, SenderData, ProfileData } from "$lib/api/td"

  let { embedded = false, details = null, detailsLoading = false, detailsError = "" }: {
    embedded?: boolean; details?: ProfileData | null; detailsLoading?: boolean; detailsError?: string
  } = $props()
  let panel: HTMLElement | undefined = $state()
  const dialog = $derived(!embedded ? panel as HTMLDialogElement | undefined : undefined)
  let tab = $state("info")
  let photos = $state<FileData[]>([])
  let messages = $state<MsgData[]>([])
  let members = $state<SenderData[]>([])
  let busy = $state(false)
  let error = $state("")
  let more = $state(false)
  let cursor = 0
  let offset = 0
  let request = 0
  let sharedPhotos = $state<MsgData[]>([])
  let sharedFiles = $state<MsgData[]>([])
  let sharedLoading = $state(false)
  let photosError = $state("")
  let filesError = $state("")
  let fileError = $state("")
  let openingFile = $state<number | null>(null)
  let sharedRequest = 0
  const profile = $derived(embedded ? details : store.profile)
  const profileLoading = $derived(embedded ? detailsLoading : store.profileLoading)
  const profileError = $derived(embedded ? detailsError : store.profileError)
  const tabs = $derived(profile ? [
    { id: "info", title: "Информация" },
    ...(profile.kind === "user" ? [{ id: "photos", title: "Фото профиля" }] : []),
    { id: "media", title: "Медиа" }, { id: "files", title: "Файлы" },
    { id: "voice", title: "Голосовые" }, { id: "links", title: "Ссылки" },
    ...(profile.can_view_members ? [{ id: "members", title: "Участники" }] : []),
  ] : [])
  const status = $derived(profile?.last_seen ? `был(а) ${new Date(profile.last_seen * 1000).toLocaleString("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : profile?.status ?? "")

  $effect(() => {
    const chatId = profile?.chat.id
    sharedRequest += 1
    sharedPhotos = []
    sharedFiles = []
    sharedLoading = false
    photosError = ""
    filesError = ""
    fileError = ""
    if (embedded && chatId && store.chatsReady) void loadShared(chatId)
    return () => { sharedRequest += 1 }
  })

  async function loadShared(chatId: number) {
    const token = ++sharedRequest
    const account = store.user?.id
    sharedLoading = true
    photosError = ""
    filesError = ""
    const [photosResult, filesResult] = await Promise.allSettled([
      api.profileMedia(chatId, "photos", 0, 6), api.profileMedia(chatId, "files", 0, 6),
    ])
    if (token !== sharedRequest || store.user?.id !== account) return
    if (photosResult.status === "fulfilled") sharedPhotos = photosResult.value.messages.filter((message) => message.content.kind === "Photo").slice(0, 6)
    else photosError = "Не удалось загрузить фото"
    if (filesResult.status === "fulfilled") sharedFiles = filesResult.value.messages.filter((message) => message.content.kind === "File").slice(0, 6)
    else filesError = "Не удалось загрузить файлы"
    sharedLoading = false
  }

  async function openSharedFile(message: MsgData) {
    if (message.content.kind !== "File" || openingFile !== null) return
    if (mediaItem(message)) {
      openMediaViewer(message, sharedFiles)
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
    void (embedded ? details?.id : store.profileTarget)
    request += 1
    tab = "info"
    photos = []
    messages = []
    members = []
    busy = false
    error = ""
    more = false
    cursor = 0
    offset = 0
  })

  async function load(reset = false) {
    if (!profile || (busy && !reset)) return
    const currentProfile = profile
    const currentTab = tab
    const token = ++request
    if (reset) {
      photos = []
      messages = []
      members = []
      cursor = 0
      offset = 0
      more = false
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
      } else if (currentTab === "members") {
        const page = await api.profileMembers(currentProfile.chat.id, offset)
        if (token !== request) return
        const known = new Set(members.map((member) => `${member.kind}:${member.id}`))
        members = [...members, ...page.filter((member) => !known.has(`${member.kind}:${member.id}`))]
        offset += page.length
        more = page.length > 0
      } else if (currentTab !== "info") {
        const page = await api.profileMedia(currentProfile.chat.id, currentTab, cursor)
        if (token !== request) return
        const known = new Set(messages.map((message) => message.id))
        messages = [...messages, ...page.messages.filter((message) => !known.has(message.id))]
        more = page.next_from_message_id !== 0 && page.next_from_message_id !== cursor
        cursor = page.next_from_message_id
      }
    } catch (failure) {
      if (token === request) error = String(failure)
    } finally {
      if (token === request) busy = false
    }
  }

  function selectTab(id: string) {
    tab = id
    void load(true)
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

<svelte:element this={embedded ? "aside" : "dialog"} role={embedded ? "complementary" : "dialog"} bind:this={panel} class="profile-panel glass" class:embedded aria-label="Профиль" onclick={backdrop} oncancel={cancel} onclose={closeProfile}>
  <div class="panel-top"><span>{embedded ? "Информация" : "Профиль"}</span>{#if !embedded}<button class="icon-button" aria-label="Закрыть профиль" onclick={closeProfile}><Icon name="xmark" size={19} strokeWidth={1.5} /></button>{/if}</div>
  <div class="panel-scroll">
    {#if profileLoading}
      <div class="loading-profile"><div class="skeleton avatar-skeleton"></div><div class="skeleton name-skeleton"></div><span>Загрузка...</span></div>
    {:else if profileError}
      <div class="inline-error" role="alert">{profileError}</div>{#if !embedded}<button class="retry" onclick={() => { if (store.profileTarget) void openProfile(store.profileTarget) }}>Повторить</button>{/if}
    {:else if profile}
      <div class="profile-hero">
        <button class="hero-photo" aria-label="Открыть фотографию профиля" disabled={!profile.photo_file_id} onclick={() => showPhoto(profile.photo_file_id)}><Avatar id={profile.id} title={profile.title} fileId={profile.photo_file_id} path={profile.photo} size={64} /></button>
        <div class="profile-heading">
          <h2>{profile.title}{#if profile.is_verified}<Icon name="badge-check" size={17} />{/if}{#if profile.is_premium}<Icon name="sparks" size={15} />{/if}</h2>
          {#if status || profile.member_count > 0}
            <div class="profile-status">{#if status}<span>{status}</span>{/if}{#if profile.member_count > 0}<span>{profile.member_count.toLocaleString("ru")} участников</span>{/if}</div>
          {/if}
          {#if !embedded}<button class="btn-accent conversation" onclick={() => openConversation(profile.chat)}>{profile.kind === "user" && profile.id !== store.user?.id ? "Написать" : "Открыть чат"}<Icon name="arrow-up-right" size={14} /></button>{/if}
        </div>
      </div>
      <nav class="profile-tabs" aria-label="Содержимое профиля">{#each tabs as item (item.id)}<button class:active={tab === item.id} aria-pressed={tab === item.id} onclick={() => selectTab(item.id)}>{item.title}</button>{/each}</nav>
      {#if tab === "info"}
        <dl class="profile-details">
          {#if profile.bio}<div class="profile-bio"><dt>О себе</dt><dd><RichText text={profile.bio} entities={profile.bio_entities} /></dd></div>{/if}
          {#if profile.usernames.length}<div><dt>Имя пользователя</dt><dd>{#each profile.usernames as username}<span class="username">@{username}</span>{/each}</dd></div>{/if}
          {#if profile.phone}<div><dt>Телефон</dt><dd>+{profile.phone.replace(/^\+/, "")}</dd></div>{/if}
          {#if profile.birthdate}<div><dt>День рождения</dt><dd>{new Date(profile.birthdate.year || 2000, profile.birthdate.month - 1, profile.birthdate.day).toLocaleDateString("ru", { day: "numeric", month: "long", ...(profile.birthdate.year ? { year: "numeric" } : {}) })}</dd></div>{/if}
          {#if profile.common_groups > 0}<div><dt>Общие группы</dt><dd>{profile.common_groups}</dd></div>{/if}
        </dl>
        {#if embedded}
          <section class="shared-section" aria-label="Фото чата">
            <header><button onclick={() => selectTab("media")}><span>Фото</span><Icon name="nav-arrow-right" size={15} /></button></header>
            {#if sharedPhotos.length}
              <div class="shared-photo-grid">{#each sharedPhotos as message (message.id)}{#if message.content.kind === "Photo"}<button aria-label="Открыть фото" onclick={() => openMediaViewer(message, sharedPhotos)}><Avatar id={message.id} title="Фото" fileId={message.content.data.file_id} size={100} /></button>{/if}{/each}</div>
            {:else if sharedLoading}<div class="shared-photo-grid" aria-label="Загрузка фото">{#each Array(6) as _}<span class="shared-photo-skeleton"></span>{/each}</div>
            {:else if photosError}<button class="shared-empty" onclick={() => loadShared(profile.chat.id)}>{photosError}. Повторить</button>
            {:else}<span class="shared-empty">Нет фото</span>{/if}
          </section>
          <section class="shared-section" aria-label="Файлы чата">
            <header><button onclick={() => selectTab("files")}><span>Файлы</span><Icon name="nav-arrow-right" size={15} /></button></header>
            <div class="shared-file-grid">{#each sharedFiles as message (message.id)}{#if message.content.kind === "File"}<button class="file-tile" title={message.content.data.file_name} disabled={openingFile !== null} onclick={() => openSharedFile(message)}><Icon name="page" size={25} /><strong>{message.content.data.file_name}</strong><span>{openingFile === message.content.data.file_id ? "Загрузка..." : formatFileSize(message.content.data.size)}</span></button>{/if}{/each}</div>
            {#if sharedLoading}<span class="shared-empty">Загрузка...</span>{:else if filesError}<button class="shared-empty" onclick={() => loadShared(profile.chat.id)}>{filesError}. Повторить</button>{:else if !sharedFiles.length}<span class="shared-empty">Нет файлов</span>{/if}
            {#if fileError}<div class="inline-error" role="alert">{fileError}</div>{/if}
          </section>
        {/if}
      {:else if tab === "photos"}
        <div class="photo-grid">{#each photos as photo (photo.file_id)}<button aria-label="Открыть фотографию" onclick={() => showPhoto(photo.file_id)}><Avatar id={photo.file_id} title={profile.title} fileId={photo.file_id} path={photo.local_path} size={102} /></button>{/each}</div>
      {:else if tab === "members"}
        <div class="member-list">{#each members as member (`${member.kind}:${member.id}`)}<button onclick={() => openProfile({ kind: member.kind, id: member.id })}><Avatar id={member.id} title={member.name} fileId={member.photo_file_id} path={member.photo} size={37} /><span>{member.name}</span><Icon name="arrow-up-right" size={15} /></button>{/each}</div>
      {:else}
        <div class="shared-messages">{#each messages as message (message.id)}<MessageBubble msg={message} actions={false} mediaMessages={messages} />{/each}</div>
      {/if}
      {#if error}<div class="inline-error" role="alert">{error}</div><button class="retry" onclick={() => load()}>Повторить</button>
      {:else if busy}<div class="empty">Загрузка...</div>
      {:else if tab !== "info" && !photos.length && !messages.length && !members.length}<div class="empty">Пока пусто</div>
      {:else if more}<button class="retry" onclick={() => load()}>Ещё</button>{/if}
    {/if}
  </div>
</svelte:element>

<style>
  .profile-panel { position: fixed; inset: 14px; width: 420px; height: fit-content; max-width: calc(100vw - 28px); max-height: calc(100vh - 28px); margin: auto; padding: 0; border-radius: 22px; color: var(--text-primary); overflow: hidden; background: var(--menu-bg) }
  .profile-panel:global([open]), .profile-panel.embedded { display: flex; flex-direction: column }
  .profile-panel.embedded { position: relative; inset: auto; width: clamp(320px, 25vw, 460px); min-width: 320px; max-height: 100%; height: 100%; margin: 0; flex-shrink: 0; background: var(--surface); container-type: inline-size }
  .profile-panel::backdrop { background: rgba(4,7,12,.42); backdrop-filter: blur(3px) }
  @media (prefers-reduced-motion: no-preference) {
    .profile-panel:global([open]) { animation: appear .26s ease-out }
  }
  .panel-top { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 4px 20px; flex-shrink: 0; min-height: 44px; font-size: 12px; color: var(--text-secondary) }
  .panel-top .icon-button { width: 30px; height: 30px }
  .panel-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 20px 16px }
  .profile-hero { display: flex; align-items: flex-start; gap: 14px; padding: 5px 0 14px }
  .hero-photo { flex-shrink: 0; padding: 0; border-radius: 50% }
  .profile-heading { min-width: 0; align-self: center }
  h2 { margin: 0; font-size: 19px; line-height: 1.22; letter-spacing: -.35px; font-weight: 600; overflow-wrap: anywhere }
  h2 :global(svg) { margin-inline-start: 5px; vertical-align: -.15em; color: var(--accent-hover) }
  .profile-status { display: flex; flex-wrap: wrap; gap: 2px 9px; margin-top: 5px; color: var(--text-secondary); font-size: 11px; line-height: 1.5 }
  .conversation { gap: 6px; margin-top: 8px; padding: 7px 11px; border-radius: 9px; font-size: 12px; text-align: left }
  .profile-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; padding-bottom: 9px; border-bottom: 1px solid var(--border) }
  .profile-tabs button { min-width: 0; padding: 7px 4px; border-radius: 8px; color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere }
  .profile-tabs button:hover { background: var(--hover); color: var(--text-primary) }
  .profile-tabs button:focus-visible { outline-offset: -2px }
  .profile-tabs .active { background: var(--accent-soft); color: var(--accent-hover) }
  .profile-details { margin: 0 }
  .profile-details > div { display: grid; grid-template-columns: minmax(0, 105px) minmax(0, 1fr); align-items: baseline; gap: 4px 12px; padding: 10px 0 }
  .profile-details > div + div { border-top: 1px solid var(--border) }
  .profile-details > .profile-bio { grid-template-columns: minmax(0, 1fr) }
  .profile-details > div:last-child { padding-bottom: 2px }
  dt { color: var(--text-secondary); font-size: 11px }
  dd { margin: 0; font-size: 13px; line-height: 1.5; user-select: text; overflow-wrap: anywhere }
  .username { display: block; color: var(--accent-hover) }
  .retry { display: block; margin: 15px auto 0; padding: 8px 16px; color: var(--accent-hover); font-size: 12px; border-radius: 15px }
  .retry:hover { background: var(--hover) }
  .empty { text-align: center; color: var(--text-secondary); padding: 30px 0; font-size: 12px }
  .photo-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding-top: 17px }
  .photo-grid button { padding: 0; border-radius: 17px; overflow: hidden; display: flex; justify-content: center }
  .photo-grid :global(.avatar) { border-radius: 17px; width: 100% !important }
  .member-list { display: grid; gap: 4px; padding-top: 10px }
  .member-list button { display: flex; align-items: center; gap: 11px; text-align: left; width: 100%; padding: 10px 5px; border-radius: 14px; font-size: 12px }
  .member-list button:hover { background: var(--hover) }
  .member-list span { flex: 1 }
  .member-list :global(svg) { color: var(--text-tertiary) }
  .shared-messages { display: grid; gap: 12px; padding-top: 17px }
  .shared-messages :global(.bubble-row) { max-width: 100%; justify-self: start }
  .shared-messages :global(.bubble-row.out) { justify-self: end }
  .loading-profile { display: grid; grid-template-columns: 64px minmax(0, 1fr); grid-template-rows: auto auto; align-items: center; gap: 5px 14px; padding: 5px 0 14px; color: var(--text-secondary); font-size: 11px }
  .skeleton { background: var(--hover); border-radius: 10px }
  .avatar-skeleton { grid-row: span 2; width: 64px; height: 64px; border-radius: 50% }
  .name-skeleton { align-self: end; width: min(150px, 100%); height: 17px }
  .loading-profile span { align-self: start }
  .shared-section { border-top: 1px solid var(--border); margin-top: 18px; padding-top: 16px }
  .shared-section header button { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0 0 12px; color: var(--text-secondary); font-size: 12px; text-align: left }
  .shared-section header button:hover { color: var(--accent-hover) }
  .shared-photo-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px }
  .shared-photo-grid button { aspect-ratio: 1; padding: 0; border-radius: 13px; overflow: hidden }
  .shared-photo-grid :global(.avatar) { width: 100% !important; height: 100% !important; border-radius: 0; object-fit: cover }
  .shared-photo-skeleton { aspect-ratio: 1; border-radius: 13px; background: var(--hover) }
  .shared-file-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px }
  .file-tile { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; gap: 7px; padding: 12px; border-radius: 14px; background: rgba(92,125,177,.08); text-align: left }
  .file-tile:hover { background: var(--hover) }
  .file-tile :global(.icon) { color: var(--accent-hover) }
  .file-tile strong { font-size: 12px; font-weight: 500; line-height: 1.35; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden }
  .file-tile > span { color: var(--text-secondary); font-size: 10px }
  .shared-empty { display: block; padding: 6px 0; color: var(--text-tertiary); font-size: 11px; text-align: left }
  @container (min-width: 420px) { .shared-photo-grid { grid-template-columns: repeat(4, minmax(0, 1fr)) } }
</style>
