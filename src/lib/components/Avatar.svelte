<script lang="ts">
  import { onMount } from "svelte"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import { store, loadAvatar } from "$lib/stores/app.svelte"
  import { initials, avatarClass } from "$lib/utils"

  let { id, title, fileId = null, path = null, size = 40 }: {
    id: number
    title: string
    fileId?: number | null
    path?: string | null
    size?: number
  } = $props()

  let element: HTMLDivElement | undefined = $state()
  let visible = $state(false)
  let brokenPath = $state<string | null>(null)
  let attemptedId = $state<number | null>(null)
  const localPath = $derived((fileId ? store.files.get(fileId) : null) ?? path)
  const imagePath = $derived(localPath && localPath !== brokenPath ? localPath : null)

  onMount(() => {
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
    })
    if (element) observer.observe(element)
    return () => observer.disconnect()
  })

  $effect(() => {
    if (!visible || !store.chatsReady || !fileId || imagePath || attemptedId === fileId) return
    const requestedId = fileId
    attemptedId = requestedId
    void loadAvatar(requestedId).then((downloaded) => {
      if (downloaded && fileId === requestedId) brokenPath = null
    }).catch(() => {})
  })

  function failed() {
    brokenPath = localPath
    if (fileId && store.files.get(fileId) === localPath) store.files.delete(fileId)
  }
</script>

<div class="avatar {avatarClass(id, title)}" style:width={`${size}px`} style:height={`${size}px`} style:font-size={`${Math.round(size * 0.36)}px`} bind:this={element}>
  {#if imagePath}
    <img src={convertFileSrc(imagePath)} alt="" loading="lazy" decoding="async" onerror={failed} />
  {:else}
    {initials(title)}
  {/if}
</div>

<style>
  .avatar {
    overflow: hidden;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
