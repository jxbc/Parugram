<script lang="ts">
  import RichText from "$lib/components/RichText.svelte"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import { openPath } from "@tauri-apps/plugin-opener"
  import Icon from "./Icon.svelte"
  import { store, loadAvatar, closeMediaViewer, openMediaItems } from "$lib/stores/app.svelte"
  import { formatDuration, rangeSlider, releaseMedia } from "$lib/utils"
  import { telegramMediaSrc } from "$lib/api/td"

  let dialog: HTMLDialogElement | undefined = $state()
  let canvas: HTMLDivElement | undefined = $state()
  let photo: HTMLImageElement | undefined = $state()
  let video: HTMLVideoElement | undefined = $state()
  let paused = $state(true)
  let buffering = $state(true)
  let duration = $state(0)
  let position = $state(0)
  let volume = $state(1)
  let error = $state("")
  let retry = $state(0)
  let zoom = $state(1)
  let pan = $state({ x: 0, y: 0 })
  let dragging = $state(false)
  let dragStart = { x: 0, y: 0, panX: 0, panY: 0 }
  let dragged = false
  const viewer = $derived(store.mediaViewer)
  const item = $derived(viewer?.items[viewer.index])
  const path = $derived(item?.local_path ?? (item ? store.files.get(item.file_id) : undefined))
  const videoSrc = $derived(item?.kind === "video" && !item.local_path ? `${telegramMediaSrc(item.file_id, item.file_name, "mp4")}?retry=${retry}` : "")
  const src = $derived(videoSrc || (path ? convertFileSrc(path) : ""))
  const transfer = $derived(item && store.mediaTransfer?.fileId === item.file_id ? store.mediaTransfer : null)
  const progress = $derived(transfer?.size ? Math.min(100, Math.floor(transfer.downloaded * 100 / transfer.size)) : null)

  $effect(() => {
    if (!dialog) return
    if (viewer && !dialog.open) dialog.showModal()
    else if (!viewer && dialog.open) {
      if (document.fullscreenElement === dialog) void document.exitFullscreen().catch(() => {})
      dialog.close()
    }
  })

  $effect(() => {
    const current = item
    void retry
    zoom = 1
    pan = { x: 0, y: 0 }
    dragging = false
    error = ""
    paused = true
    buffering = true
    duration = 0
    position = 0
    if (!current || current.local_path || current.kind === "video") return
    let disposed = false
    void loadAvatar(current.file_id).then((loaded) => {
      if (!loaded && !disposed) error = "Не удалось загрузить медиа"
    }).catch(() => { if (!disposed) error = "Не удалось загрузить медиа" })
    return () => { disposed = true }
  })

  function move(direction: number) {
    if (!viewer) return
    const index = viewer.index + direction
    if (index >= 0 && index < viewer.items.length) openMediaItems(viewer.items, index)
  }

  function key(event: KeyboardEvent) {
    if (!viewer) return
    if (event.key === "Escape") {
      event.preventDefault()
      closeMediaViewer()
    } else if (video && item?.kind === "video" && !(event.target instanceof HTMLInputElement) && [" ", "ArrowLeft", "ArrowRight"].includes(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === " " && event.target instanceof HTMLButtonElement) return
      event.preventDefault()
      if (event.key === " ") toggleVideo()
      else seek(position + (event.key === "ArrowRight" ? 5 : -5))
    } else if (!(event.target instanceof HTMLInputElement)) {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault()
        move(event.key === "ArrowLeft" ? -1 : 1)
      }
    }
  }

  $effect(() => { if (video) video.volume = volume })

  function toggleVideo() {
    if (!video) return
    if (video.paused) void video.play().catch(() => {})
    else video.pause()
  }

  function seek(time: number) {
    if (video && duration) video.currentTime = Math.max(0, Math.min(time, duration))
  }

  function videoTime(event: Event) {
    const node = event.currentTarget as HTMLVideoElement
    position = node.currentTime
    duration = Number.isFinite(node.duration) ? node.duration : 0
  }

  function clampPan() {
    if (!canvas || !photo) return
    const limitX = Math.max(0, (photo.clientWidth * zoom - canvas.clientWidth) / 2)
    const limitY = Math.max(0, (photo.clientHeight * zoom - canvas.clientHeight) / 2)
    pan = { x: Math.max(-limitX, Math.min(limitX, pan.x)), y: Math.max(-limitY, Math.min(limitY, pan.y)) }
  }

  function resize(factor: number) {
    zoom = Math.min(5, Math.max(1, zoom * factor))
    clampPan()
  }

  function wheel(event: WheelEvent) {
    if (item?.kind !== "photo" || !src || event.target !== photo) return
    event.preventDefault()
    resize(event.deltaY < 0 ? 1.15 : 1 / 1.15)
  }

  function pointerDown(event: PointerEvent) {
    dragged = false
    if (item?.kind !== "photo" || zoom <= 1 || event.button !== 0 || event.target !== photo) return
    event.preventDefault()
    canvas?.setPointerCapture(event.pointerId)
    dragging = true
    dragStart = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
  }

  function pointerMove(event: PointerEvent) {
    if (!dragging) return
    if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 3) dragged = true
    pan = { x: dragStart.panX + event.clientX - dragStart.x, y: dragStart.panY + event.clientY - dragStart.y }
    clampPan()
  }

  function pointerUp(event: PointerEvent) {
    dragging = false
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  }

  function toggleZoom(event: MouseEvent) {
    if (event.detail > 0 && dragged) return
    if (event.target !== photo) {
      closeMediaViewer()
      return
    }
    zoom = zoom === 1 ? 2 : 1
    pan = { x: 0, y: 0 }
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement === dialog) await document.exitFullscreen()
      else await dialog?.requestFullscreen()
    } catch {
      return
    }
  }

  async function external() {
    if (!item) return
    try {
      const local = path || await loadAvatar(item.file_id)
      if (local) await openPath(local)
    }
    catch { error = "Не удалось открыть файл" }
  }

  function reload() {
    if (item?.kind === "photo" && !item.local_path) store.files.delete(item.file_id)
    error = ""
    retry += 1
  }
</script>

<svelte:window onkeydown={key} onresize={clampPan} />
<dialog class="media-viewer" aria-label="Просмотр медиа" bind:this={dialog} oncancel={(event) => { event.preventDefault()
  closeMediaViewer() }} onclose={closeMediaViewer}>
  {#if viewer && item}
    <button class="viewer-backdrop" aria-label="Закрыть просмотр" onclick={closeMediaViewer}></button>
    <header><div class="viewer-title"><span>{item.file_name || (item.kind === "video" ? "Видео" : "Фото")}</span><small>{viewer.index + 1} из {viewer.items.length}</small></div>
      {#if item.kind === "photo" && src}<button class="icon-button" aria-label="Уменьшить" onclick={() => resize(1 / 1.25)} disabled={zoom <= 1}><Icon name="minus" size={21} /></button><span class="zoom-value">{Math.round(zoom * 100)}%</span><button class="icon-button" aria-label="Увеличить" onclick={() => resize(1.25)} disabled={zoom >= 5}><Icon name="plus" size={21} /></button>{/if}
      <button class="icon-button" aria-label="Полный экран" onclick={fullscreen}><Icon name="expand" size={20} /></button><button class="icon-button" aria-label="Закрыть просмотр" onclick={closeMediaViewer}><Icon name="xmark" size={23} /></button>
    </header>
    <div class="viewer-body">
      {#if viewer.index > 0}<button class="icon-button previous" aria-label="Предыдущее медиа" onclick={() => move(-1)}><Icon name="nav-arrow-left" size={27} /></button>{/if}
      <div class="media-canvas" class:can-pan={item.kind === "photo" && zoom > 1} class:dragging bind:this={canvas} role="group" aria-label={item.kind === "video" ? "Видео" : "Фото"} onwheel={wheel} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp} onpointercancel={pointerUp}>
        {#if error}<div class="viewer-error" role="alert"><span>{error}</span><div><button onclick={reload}>Повторить</button>{#if path || item.kind === "video"}<button onclick={external}>Открыть в приложении</button>{/if}</div></div>
        {:else if !src}<span class="viewer-loading">Загрузка{progress !== null ? ` ${progress}%` : "..."}</span>
        {:else}{#key item.key}{#if item.kind === "photo"}<button class="photo-surface" aria-label={zoom === 1 ? "Увеличить фото" : "Сбросить масштаб"} onclick={toggleZoom}><img bind:this={photo} src={src} alt={item.caption || "Фото"} draggable="false" style:transform={`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`} onerror={() => error = "Не удалось открыть изображение"} /></button>
        {:else}
          {#key retry}<video bind:this={video} use:releaseMedia src={src} autoplay playsinline aria-label={item.caption || "Видео"} onloadedmetadata={videoTime} ontimeupdate={videoTime} onplay={() => paused = false} onpause={() => paused = true} onwaiting={() => buffering = true} onplaying={() => buffering = false} oncanplay={() => buffering = false} onerror={() => error = "Не удалось воспроизвести видео"}><track kind="captions" /></video>{/key}
          <button class="video-surface" aria-label={paused ? "Воспроизвести" : "Пауза"} tabindex="-1" onclick={toggleVideo}>{#if buffering}<span class="viewer-loading">Загрузка…</span>{/if}</button>
          <div class="video-controls glass">
            <button class="icon-button" aria-label={paused ? "Воспроизвести" : "Пауза"} onclick={toggleVideo}><Icon name={paused ? "play" : "pause"} size={20} /></button>
            <span>{formatDuration(position)}</span><input class="video-seek" type="range" aria-label="Перемотка видео" min="0" max={duration || 1} step="0.1" value={position} use:rangeSlider={position} disabled={!duration} oninput={(event) => seek(Number(event.currentTarget.value))} /><span>{formatDuration(duration)}</span>
            <button class="icon-button" aria-label={volume ? "Выключить звук" : "Включить звук"} onclick={() => volume = volume ? 0 : 1}><Icon name={volume ? "sound-high" : "sound-off"} size={18} /></button>
            <input class="video-volume" type="range" aria-label="Громкость видео" min="0" max="1" step="0.01" bind:value={volume} use:rangeSlider={volume} />
            <button class="icon-button" aria-label="Полный экран" onclick={fullscreen}><Icon name="expand" size={19} /></button>
          </div>
        {/if}{/key}{/if}
      </div>
      {#if viewer.index < viewer.items.length - 1}<button class="icon-button next" aria-label="Следующее медиа" onclick={() => move(1)}><Icon name="nav-arrow-right" size={27} /></button>{/if}
    </div>
    {#if item.caption}<footer><RichText text={item.caption} entities={item.entities} /></footer>{/if}
  {/if}
</dialog>

<style>
  .media-viewer { position: fixed; inset: 0; width: 100vw; max-width: none; height: 100dvh; max-height: none; padding: 0; margin: 0; border: 0; color: var(--text-primary); background: rgba(4,6,10,.97); overflow: hidden }
  .media-viewer[open] { display: flex; flex-direction: column }
  .media-viewer::backdrop { background: #04060a }
  .viewer-backdrop { position: absolute; inset: 0; cursor: default }
  header { display: flex; align-items: center; gap: 7px; position: relative; z-index: 2; padding: 14px 20px; flex-shrink: 0 }
  .viewer-title { display: grid; gap: 5px; margin-right: auto; min-width: 0 }
  .viewer-title > span { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  small, .zoom-value { color: var(--text-secondary); font-size: 11px }
  .zoom-value { min-width: 35px; text-align: center }
  .viewer-body { flex: 1; min-height: 0; position: relative; display: flex; align-items: stretch; padding: 0 60px }
  .media-canvas { width: 100%; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; position: relative; touch-action: none }
  .photo-surface { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; padding: 0; cursor: default }
  .photo-surface img { cursor: zoom-in }
  .can-pan .photo-surface { cursor: grab }
  .dragging .photo-surface { cursor: grabbing }
  .photo-surface img { display: block; width: auto; height: auto; max-width: 100%; max-height: 100%; object-fit: contain; user-select: none; transform-origin: center }
  video { display: block; width: 100%; height: 100%; object-fit: contain; background: transparent }
  .video-surface { position: absolute; inset: 0; width: 100%; display: grid; place-items: center }
  .video-surface .viewer-loading { padding: 7px 12px; border-radius: 12px; background: var(--menu-bg) }
  .video-controls { position: absolute; bottom: 10px; inset-inline: 0; display: flex; align-items: center; gap: 8px; max-width: 720px; margin-inline: auto; padding: 4px 8px; border-radius: 16px; font-size: 11px; font-variant-numeric: tabular-nums }
  .video-seek { flex: 1; min-width: 0 }
  .video-volume { width: 62px }
  .previous, .next { position: absolute; top: calc(50% - 22px); z-index: 3; width: 42px; height: 44px; color: white; background: rgba(30,38,53,.55) }
  .previous { left: 9px }
  .next { right: 9px }
  .viewer-error { display: grid; justify-items: center; gap: 14px; color: var(--text-secondary); font-size: 13px }
  .viewer-error button { color: var(--accent-hover); padding: 8px }
  .viewer-loading { color: var(--text-secondary); font-size: 13px }
  footer { position: relative; z-index: 2; padding: 16px 25px 22px; max-height: 20vh; overflow-y: auto; text-align: center; white-space: pre-wrap; font-size: 14px; line-height: 1.5; user-select: text; flex-shrink: 0 }
  @media (max-width: 600px) { header { padding: 12px 10px; gap: 3px } .viewer-body { padding: 0 40px } .previous, .next { width: 32px } .previous { left: 3px } .next { right: 3px } }
</style>
