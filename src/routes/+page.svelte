<script lang="ts">
  import { onMount } from "svelte"
  import { fly, slide } from "svelte/transition"
  import { listen } from "@tauri-apps/api/event"
  import { convertFileSrc, isTauri } from "@tauri-apps/api/core"
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window"
  import { store, api, initStore, applyAppLockStatus, restoreCustomization, customizationStyles, closeRightPanel, goBackChat, compactView, visibleRightPanel, openConversation } from "$lib/stores/app.svelte"
  import type { AppLockStatus } from "$lib/api/td"
  import AppLockScreen from "$lib/components/auth/AppLockScreen.svelte"
  import AuthScreen from "$lib/components/auth/AuthScreen.svelte";
  import Sidebar from "$lib/components/layout/Sidebar.svelte";
  import ChatView from "$lib/components/chat/ChatView.svelte";
  import ProfilePanel from "$lib/components/ProfilePanel.svelte"
  import ContextMenu from "$lib/components/ContextMenu.svelte"
  import MediaViewer from "$lib/components/MediaViewer.svelte"
  import StickerPicker from "$lib/components/chat/StickerPicker.svelte"
  import MusicPlayer from "$lib/components/chat/MusicPlayer.svelte"
  import Icon from "$lib/components/Icon.svelte"

  let lockError = $state("")
  let acknowledging = false
  let glowTarget = $state({ x: "24%", y: "10%" })
  let appWindow = $state.raw<Window | null>(null)
  let maximized = $state(false)
  let loadingChatWindow = $state(false)
  let chatWindowError = $state("")
  const maximizeLabel = $derived(maximized ? "Восстановить окно" : "Развернуть окно")
  const compact = $derived(compactView())
  const showWorkspace = $derived(!compact || !store.showChatList && store.activeChatId !== null)
  const rightPanel = $derived(visibleRightPanel())

  function windowAction(action: "minimize" | "toggleMaximize" | "close") {
    void appWindow?.[action]().catch((error) => console.error(error))
  }

  async function refreshLock() {
    try {
      applyAppLockStatus(await api.appLockStatus())
      lockError = ""
    } catch (error) {
      lockError = String(error)
    }
  }

  async function loadChatWindow() {
    loadingChatWindow = true
    chatWindowError = ""
    try {
      const chat = await api.chatWindowChat()
      if (store.appLock?.logged_out || store.appLock?.session_suspended) return
      openConversation(chat)
    } catch (error) {
      chatWindowError = String(error)
    } finally {
      loadingChatWindow = false
    }
  }

  onMount(() => {
    restoreCustomization()
    const updateVisibility = () => { store.windowVisible = !document.hidden }
    updateVisibility()
    document.addEventListener("visibilitychange", updateVisibility)
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let unsubscribeResize: (() => void) | undefined
    if (isTauri()) {
      const current = getCurrentWindow()
      appWindow = current
      const chatWindow = /^chat-(-?\d+)_\d+$/.exec(current.label)
      if (chatWindow) store.chatWindowId = Number(chatWindow[1])
      let resizeRequest = 0
      const syncMaximized = async () => {
        const request = ++resizeRequest
        const value = await current.isMaximized()
        if (!disposed && request === resizeRequest) maximized = value
      }
      void current.onResized(() => { void syncMaximized().catch(console.error) }).then((stop) => {
        if (disposed) stop()
        else {
          unsubscribeResize = stop
          return syncMaximized()
        }
      }).catch(console.error)
    }
    void listen<AppLockStatus>("app-lock", (event) => applyAppLockStatus(event.payload)).then((stop) => {
      if (disposed) stop()
      else {
        unsubscribe = stop
        void refreshLock()
      }
    }).catch((error) => lockError = String(error))
    return () => {
      disposed = true
      unsubscribe?.()
      unsubscribeResize?.()
      document.removeEventListener("visibilitychange", updateVisibility)
    }
  })

  $effect(() => {
    if (!store.appLock || store.appLock.locked || store.appLock.logged_out || store.appLock.session_suspended || lockError) return
    void initStore()
  })

  $effect(() => {
    if (!store.appLock?.logged_out || acknowledging) return
    acknowledging = true
    void api.acknowledgeLockLogout().then(applyAppLockStatus).catch((error) => lockError = String(error)).finally(() => acknowledging = false)
  })

  $effect(() => {
    if (!store.appLock?.logout_pending) return
    const timer = setInterval(() => void refreshLock(), 1000)
    return () => clearInterval(timer)
  })

  const ready = $derived(store.stage === "ready" || store.cached)

  $effect(() => {
    if (store.chatWindowId === null) return
    if (store.appLock?.logged_out || store.appLock?.session_suspended || (store.appLock && !store.appLock.locked && !["ready", "loading", "error"].includes(store.stage))) {
      windowAction("close")
      return
    }
    if (store.chatsReady && !store.appLock?.locked && store.activeChatId === null && !loadingChatWindow && !chatWindowError) void loadChatWindow()
  })

  $effect(() => {
    if (!ready || store.appLock?.locked || store.appLock?.logged_out || lockError || !store.customization.dynamicGlow || store.effects !== "full") return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let angle = 4.15
    const moveGlow = () => {
      if (document.hidden || reducedMotion.matches) return
      angle += (70 + Math.random() * 220) * Math.PI / 180
      glowTarget = {
        x: `${(50 + 48 * Math.cos(angle)).toFixed(1)}%`,
        y: `${(50 + 48 * Math.sin(angle)).toFixed(1)}%`,
      }
    }
    moveGlow()
    const timer = setInterval(moveGlow, 10_500)
    return () => clearInterval(timer)
  })

  function navigationKey(event: KeyboardEvent) {
    if (event.altKey && event.key === "ArrowLeft" && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
      event.preventDefault()
      goBackChat()
    }
  }
</script>

<svelte:window bind:innerWidth={store.viewportWidth} onkeydown={navigationKey} />

<div class="app" class:custom-titlebar={!!appWindow} class:compact data-effects={store.effects} data-theme={store.customization.theme} data-bubble-blur={store.customization.bubbleBlur && store.effects === "full"} data-dynamic-glow={store.customization.dynamicGlow} style={customizationStyles(store.customization.wallpaper ? convertFileSrc(store.customization.wallpaper) : null)} style:--panel-glow-target-x={glowTarget.x} style:--panel-glow-target-y={glowTarget.y}>
  {#if appWindow}
    <header class="titlebar" aria-label="Управление окном">
      <div class="titlebar-drag" data-tauri-drag-region></div>
      <button type="button" title="Свернуть окно" aria-label="Свернуть окно" onclick={() => windowAction("minimize")}><Icon name="minus" size={15} /></button>
      <button type="button" title={maximizeLabel} aria-label={maximizeLabel} onclick={() => windowAction("toggleMaximize")}><Icon name={maximized ? "copy" : "square"} size={14} /></button>
      <button type="button" class="titlebar-close" title="Закрыть окно" aria-label="Закрыть окно" onclick={() => windowAction("close")}><Icon name="xmark" size={16} /></button>
    </header>
  {/if}
  {#if !store.appLock || store.appLock.locked || store.appLock.logged_out || lockError}
    <AppLockScreen startupError={lockError} retry={() => void refreshLock()} />
  {:else if ready || store.chatWindowId !== null}
    <div class="app-content">
      {#if store.chatWindowId === null}
        <div class="sidebar-slot" class:sidebar-inactive={compact && showWorkspace} inert={compact && showWorkspace}><Sidebar /></div>
      {/if}
      {#if store.chatWindowId !== null && store.activeChatId === null}
        <div class="chat-window-status" role="status">
          {#if chatWindowError || store.startupError}
            <span>{chatWindowError || store.startupError}</span>
            {#if store.chatsReady}<button class="btn-accent" onclick={loadChatWindow}>Повторить</button>{/if}
          {:else}
            Загрузка…
          {/if}
        </div>
      {:else if showWorkspace}
        <div class="workspace" transition:fly={{ x: "100%", opacity: 1, duration: compact && store.effects === "full" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 230 : 0 }}>
          <MusicPlayer />
          <div class="conversation-layout" class:side-open={!!rightPanel}>
            <ChatView />
            {#if rightPanel}
              <div class="right-pane" class:sticker-pane={rightPanel.kind === "stickers"} in:slide={{ axis: "x", duration: store.effects === "full" ? 220 : 0 }} out:slide={{ axis: "x", duration: store.effects === "full" ? 180 : 0 }}>
                {#if rightPanel.kind === "chat"}<ChatView conversationKey={rightPanel.key} secondary />
                {:else}<StickerPicker chatId={rightPanel.key} embedded onclose={closeRightPanel} />{/if}
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    <ProfilePanel />
    <ContextMenu />
    <MediaViewer />
    {#if store.downloads.size}
      <div class="download-notices" role="region" aria-label="Загрузки">
        {#each [...store.downloads].reverse() as [key, download] (key)}
          <div class="download-notice glass" role="status">
            <Icon name={download.stage === "done" ? "check" : download.stage === "error" ? "warning-circle" : "download"} size={18} />
            <div class="download-info">
              <div class="download-heading"><strong title={download.fileName}>{download.fileName}</strong>{#if download.progress !== undefined}<span>{download.progress}%</span>{/if}</div>
              {#if download.stage === "done"}
                <span>Загрузка завершена</span>
                <span class="download-path" title={download.path}>{download.path}</span>
              {:else if download.stage === "error"}
                <span class="download-error">{download.error}</span>
              {:else}
                <span>{download.stage === "saving" ? "Сохранение…" : "Загрузка…"}</span>
                <progress aria-label={`Загрузка ${download.fileName}`} value={download.stage === "saving" ? undefined : download.progress} max="100"></progress>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else}
    <AuthScreen />
  {/if}
</div>

<style>
  .download-notices { position: fixed; right: 16px; bottom: 74px; z-index: 130; display: grid; gap: 8px; width: min(350px, calc(100vw - 32px)); max-height: min(380px, 45vh); overflow-y: auto; padding: 3px }
  .download-notice { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: start; gap: 10px; padding: 11px 12px; border-radius: 13px; background: var(--menu-bg); color: var(--accent-hover) }
  .download-info { display: grid; gap: 5px; min-width: 0; color: var(--text-secondary); font-size: 11px }
  .download-heading { display: flex; align-items: baseline; gap: 7px; justify-content: space-between }
  .download-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); font-size: 12px }
  .download-path, .download-error { overflow-wrap: anywhere; user-select: text }
  .download-error { color: var(--danger) }
  .download-info progress { width: 100%; height: 5px; accent-color: var(--accent) }
  .app-content { display: flex; flex: 1; min-width: 0; min-height: 0; gap: var(--app-inset) }
  .sidebar-slot { display: flex; min-width: 0; flex-shrink: 0 }
  .workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; height: 100% }
  .chat-window-status { margin: auto; display: grid; justify-items: center; gap: 12px; text-align: center; color: var(--text-secondary); overflow-wrap: anywhere }
  .conversation-layout { flex: 1; min-width: 0; min-height: 0; display: flex; gap: 14px }
  .right-pane { display: flex; flex-shrink: 0; width: clamp(340px, 44%, 650px); min-width: 0; height: 100%; overflow: hidden; border-radius: 26px }
  .right-pane.sticker-pane { width: clamp(320px, 25vw, 460px) }
  @media (max-width: 1199px) { .conversation-layout.side-open > :global(.main-view) { display: none } .right-pane, .right-pane.sticker-pane { flex: 1; width: 100% } }
  .app {
    --app-inset: 14px;
    position: relative;
    display: flex;
    width: 100vw;
    height: 100vh;
    padding: var(--app-inset);
    gap: var(--app-inset);
    background: var(--bg-main);
  }
  .app.custom-titlebar { --titlebar-height: 32px; padding-top: calc(var(--titlebar-height) + var(--app-inset)) }
  .app.compact { --app-inset: 6px }
  .compact .app-content { position: relative; display: block; overflow: clip }
  .compact .sidebar-slot { height: 100% }
  .compact .sidebar-slot :global(.sidebar) { width: 100%; min-width: 0 }
  .compact .sidebar-inactive { transform: translateX(-18%) }
  .compact .workspace { position: absolute; inset: 0; background: var(--bg-main) }
  @media (prefers-reduced-motion: no-preference) {
    .compact .sidebar-slot { transition: transform 230ms cubic-bezier(.2,.7,.3,1) }
  }
  .titlebar { position: absolute; inset: 0 0 auto; z-index: 4; display: flex; height: var(--titlebar-height); background: transparent }
  .titlebar-drag { flex: 1; min-width: 0; touch-action: none }
  .titlebar button { display: grid; place-items: center; width: 44px; padding: 0; color: var(--text-secondary); transition: background .15s, color .15s }
  .titlebar button:hover { color: var(--text-primary); background: var(--hover) }
  .titlebar .titlebar-close:hover { color: #fff; background: #c42b1c }
  .titlebar button:focus-visible { outline-offset: -3px }
  @media (max-width: 820px) { .app { --app-inset: 9px } }
</style>
