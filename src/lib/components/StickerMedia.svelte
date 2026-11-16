<script lang="ts">
  import { onMount } from "svelte"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import { store, loadAvatar } from "$lib/stores/app.svelte"
  import type { StickerData } from "$lib/api/td"
  import { releaseMedia } from "$lib/utils"

  let { sticker, preview = false, animate = true }: { sticker: StickerData; preview?: boolean; animate?: boolean } = $props()
  let element: HTMLDivElement | undefined = $state()
  let lottieElement: HTMLDivElement | undefined = $state()
  let video: HTMLVideoElement | undefined = $state()
  let visible = $state(false)
  let failed = $state(false)
  const fileId = $derived(preview && sticker.thumbnail_file_id ? sticker.thumbnail_file_id : sticker.file_id)
  const path = $derived(store.files.get(fileId))
  const format = $derived(preview && sticker.thumbnail_file_id ? "webp" : sticker.format)
  const canRenderAnimation = $derived(visible && store.windowVisible)
  const motion = $derived(animate && !preview && store.effects === "full" && canRenderAnimation)

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => visible = entry.isIntersecting, { rootMargin: "80px" })
    if (element) observer.observe(element)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!video) return
    if (motion) void video.play().catch(() => {})
    else video.pause()
  })

  $effect(() => {
    failed = false
    if (!visible || !store.windowVisible || !store.chatsReady || path) return
    let cancelled = false
    void loadAvatar(fileId).then((result) => { if (!cancelled && !result) failed = true })
      .catch(() => { if (!cancelled) failed = true })
    return () => { cancelled = true }
  })

  $effect(() => {
    const container = lottieElement
    const source = path
    const moving = motion
    if (format !== "tgs" || !container || !source) return
    let disposed = false
    let animation: import("lottie-web").AnimationItem | undefined
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(convertFileSrc(source), { signal: controller.signal })
        if (!response.ok || !response.body) throw new Error("sticker")
        const animationData = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json()
        const { default: lottie } = await import("lottie-web/build/player/lottie_light")
        if (disposed) return
        animation = lottie.loadAnimation({ container, renderer: "svg", animationData, autoplay: moving, loop: moving })
        animation.addEventListener("data_failed", () => { if (!disposed) failed = true })
      } catch { if (!disposed) failed = true }
    })()
    return () => {
      disposed = true
      controller.abort()
      animation?.destroy()
    }
  })
</script>

<div class="sticker-media" bind:this={element}>
  {#if path && !failed && (format === "webp" || canRenderAnimation)}
    {#if format === "tgs"}<div class="animation" bind:this={lottieElement} aria-label={sticker.emoji || "Стикер"}></div>
    {:else if format === "webm"}<video bind:this={video} use:releaseMedia src={convertFileSrc(path)} autoplay={motion} loop={motion} muted playsinline preload="auto" aria-label={sticker.emoji || "Стикер"} onerror={() => failed = true}></video>
    {:else}<img src={convertFileSrc(path)} alt={sticker.emoji || "Стикер"} loading="lazy" onerror={() => failed = true} />{/if}
  {:else}<span class="fallback">{sticker.emoji || "◇"}</span>{/if}
</div>

<style>
  .sticker-media { width: 100%; height: 100%; display: grid; place-items: center; overflow: hidden }
  img, video, .animation { display: block; width: 100%; height: 100%; object-fit: contain }
  .fallback { font: 30px/1 var(--emoji-font), sans-serif; opacity: .75 }
</style>
