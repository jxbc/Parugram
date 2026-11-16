<script lang="ts">
  import { tick, untrack, onMount } from "svelte"
  import Icon from "$lib/components/Icon.svelte"
  import StickerMedia from "$lib/components/StickerMedia.svelte"
  import { store, loadStickerCatalog, loadStickerPack, visibleRecentStickers, sendSticker } from "$lib/stores/app.svelte"
  import type { StickerData } from "$lib/api/td"
  import { horizontalWheel } from "$lib/utils"

  let { chatId, onclose, embedded = false }: { chatId: number; onclose: () => void; embedded?: boolean } = $props()
  let selected = $state("recent")
  let catalogLoading = $state(false)
  let packLoading = $state(false)
  let catalogError = $state("")
  let packError = $state("")
  let sendError = $state("")
  let retry = $state(0)
  let grid: HTMLDivElement | undefined = $state()
  let gridWidth = $state(320)
  let gridHeight = $state(320)
  let scrollTop = $state(0)
  const sets = $derived(store.stickerCatalog?.sets ?? [])
  const stickers = $derived(selected === "recent" ? visibleRecentStickers() : store.stickerPacks.get(selected) ?? [])
  const busy = $derived(store.sendingChats.get(chatId) ?? false)
  const loading = $derived(catalogLoading || packLoading)
  const error = $derived(catalogError || packError)
  const columns = $derived(Math.max(3, Math.floor(gridWidth / 68)))
  const cellSize = $derived(Math.max(36, Math.floor((gridWidth - (columns - 1) * 8) / columns)))
  const stride = $derived(cellSize + 8)
  const rows = $derived(Math.ceil(stickers.length / columns))
  const firstRow = $derived(Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor(scrollTop / stride) - 1)))
  const endRow = $derived(Math.min(rows, firstRow + Math.ceil(gridHeight / stride) + 3))
  const visibleStickers = $derived(stickers.slice(firstRow * columns, endRow * columns))

  onMount(() => {
    if (!grid) return
    const measure = () => {
      if (!grid) return
      gridWidth = Math.max(0, grid.clientWidth - 8)
      gridHeight = grid.clientHeight
    }
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    measure()
    return () => observer.disconnect()
  })

  $effect(() => {
    void store.recentStickerLimit
    if (selected === "recent" && grid) grid.scrollTop = 0
  })

  $effect(() => {
    void store.stickersRevision
    void retry
    if (!store.chatsReady) return
    let cancelled = false
    catalogLoading = true
    catalogError = ""
    void untrack(loadStickerCatalog).catch(() => { if (!cancelled) catalogError = "Не удалось загрузить стикеры" })
      .finally(() => { if (!cancelled) catalogLoading = false })
    return () => { cancelled = true }
  })

  $effect(() => {
    const id = selected
    void store.stickersRevision
    void retry
    packError = ""
    packLoading = false
    if (id === "recent" || !store.chatsReady) return
    let cancelled = false
    packLoading = true
    void untrack(() => loadStickerPack(id)).catch(() => { if (!cancelled) packError = "Не удалось загрузить набор" })
      .finally(() => { if (!cancelled) packLoading = false })
    return () => { cancelled = true }
  })

  $effect(() => {
    if (store.stickerCatalog && selected !== "recent" && !sets.some((set) => set.id === selected)) selected = "recent"
  })

  function selectTab(id: string) {
    selected = id
    void tick().then(() => { if (grid) grid.scrollTop = 0 })
  }

  async function send(sticker: StickerData) {
    sendError = ""
    if (await sendSticker(chatId, sticker)) { if (!embedded) onclose() }
    else sendError = store.composeErrors.get(chatId) ?? ""
  }

  function gridKeys(event: KeyboardEvent) {
    if (!grid || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    if (!stickers.length || busy) return
    event.preventDefault()
    const index = Number((document.activeElement as HTMLElement)?.dataset.stickerIndex ?? 0)
    const next = Math.max(0, Math.min(stickers.length - 1, event.key === "Home" ? 0 : event.key === "End" ? stickers.length - 1 : index + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns)))
    const top = Math.floor(next / columns) * stride
    if (top < grid.scrollTop) grid.scrollTop = top
    else if (top + cellSize > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + cellSize - grid.clientHeight
    scrollTop = grid.scrollTop
    void tick().then(() => grid?.querySelector<HTMLButtonElement>(`[data-sticker-index="${next}"]`)?.focus({ preventScroll: true }))
  }
</script>

<div class="sticker-picker glass" class:embedded role={embedded ? "complementary" : "dialog"} aria-label="Стикеры" aria-modal={embedded ? undefined : "false"} tabindex="-1">
  <header><span>Стикеры</span><button class="icon-button" aria-label="Закрыть стикеры" onclick={onclose}><Icon name="xmark" size={18} /></button></header>
  <nav class="sticker-tabs" aria-label="Наборы стикеров" use:horizontalWheel>
    <button class="recent-tab" class:active={selected === "recent"} aria-pressed={selected === "recent"} onclick={() => selectTab("recent")}><Icon name="clock" size={20} /><span>Последние {visibleRecentStickers().length}</span></button>
    {#each sets as set (set.id)}<button class:active={selected === set.id} aria-pressed={selected === set.id} aria-label={set.title} title={set.title} onclick={() => selectTab(set.id)}>{#if set.cover}<StickerMedia sticker={set.cover} preview />{:else}<span>{set.title.slice(0, 1)}</span>{/if}</button>{/each}
  </nav>
  <div class="sticker-scroll" role="toolbar" aria-label={selected === "recent" ? "Последние стикеры" : sets.find((set) => set.id === selected)?.title || "Стикеры набора"} tabindex="-1" bind:this={grid} onkeydown={gridKeys} onscroll={() => scrollTop = grid?.scrollTop ?? 0}>
    <div class="sticker-space" style:height={`${rows * stride}px`}>
      <div class="sticker-grid" style:top={`${firstRow * stride}px`} style:grid-template-columns={`repeat(${columns}, minmax(0, 1fr))`} style:grid-auto-rows={`${cellSize}px`}>
        {#each visibleStickers as sticker, index (sticker.file_id)}<button class="sticker-tile" data-sticker-index={firstRow * columns + index} aria-label={`Отправить стикер ${sticker.emoji}`} title={sticker.emoji || "Стикер"} disabled={busy || !store.chatsReady} onclick={() => send(sticker)}><StickerMedia {sticker} preview /></button>{/each}
      </div>
    </div>
  </div>
  {#if error}<div class="picker-status" role="alert">{error}<button onclick={() => retry += 1}>Повторить</button></div>
  {:else if sendError}<div class="picker-status" role="alert">{sendError}</div>
  {:else if loading && !stickers.length}<div class="picker-status">Загрузка...</div>
  {:else if !stickers.length}<div class="picker-status">{selected === "recent" ? "Пока нет последних стикеров" : "Набор пуст"}</div>{/if}
</div>

<style>
  .sticker-picker { position: absolute; right: 16px; bottom: calc(100% + 8px); z-index: 4; width: min(360px, calc(100cqw - 32px)); height: min(430px, 60vh); display: flex; flex-direction: column; border-radius: 23px; padding: 8px; background: var(--menu-bg); box-shadow: 0 16px 45px rgba(0,0,0,.3); animation: appear .16s ease-out }
  .sticker-picker.embedded { position: relative; right: auto; bottom: auto; width: 100%; height: 100%; min-width: 0; border-radius: 26px; box-shadow: none; background: var(--surface) }
  header { display: flex; align-items: center; justify-content: space-between; padding: 0 2px 3px 8px; color: var(--text-secondary); font-size: 13px; flex-shrink: 0 }
  .sticker-tabs { display: flex; gap: 4px; overflow-x: auto; flex-shrink: 0; padding: 4px 1px 8px; scrollbar-width: none }
  .sticker-tabs button { display: flex; align-items: center; justify-content: center; flex: 0 0 36px; height: 36px; padding: 3px; border-radius: 12px; color: var(--text-secondary) }
  .sticker-tabs .recent-tab { flex-basis: auto; gap: 6px; padding-inline: 9px; font-size: 11px }
  .sticker-tabs .active { color: var(--accent-hover); background: var(--accent-soft) }
  .sticker-tabs button:hover { background: var(--hover) }
  .sticker-scroll { min-height: 0; overflow-y: auto; overflow-x: hidden; flex: 1; padding: 0 4px; overscroll-behavior-y: contain }
  .sticker-space { position: relative; width: 100% }
  .sticker-grid { position: absolute; left: 0; right: 0; display: grid; gap: 8px; align-content: start }
  .sticker-tile { width: 100%; height: 100%; min-width: 0; min-height: 0; padding: 5px; border-radius: 13px; overflow: hidden }
  .sticker-tile:hover { background: var(--hover) }
  .sticker-tile:disabled { opacity: .5 }
  .picker-status { padding: 12px 8px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere }
  .picker-status button { color: var(--accent-hover); padding: 4px 8px }
</style>
