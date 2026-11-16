<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core"
  import { store, loadReactionSticker, loadAvatar } from "$lib/stores/app.svelte"
  import type { ReactionData } from "$lib/api/td"

  let { reaction }: { reaction: ReactionData } = $props()
  const sticker = $derived(reaction.custom_emoji_id ? store.reactionStickers.get(reaction.custom_emoji_id) : null)
  const path = $derived(sticker?.file_id ? store.files.get(sticker.file_id) : null)
  let failed = $state(false)

  $effect(() => {
    if (reaction.custom_emoji_id) void loadReactionSticker(reaction.custom_emoji_id)
  })

  $effect(() => {
    const id = sticker?.file_id
    if (id && !path) void loadAvatar(id).catch(() => {})
  })
</script>

<span class="reaction-icon" aria-hidden="true">{#if path && !failed}<img src={convertFileSrc(path)} alt="" onerror={() => failed = true} />{:else}{reaction.emoji || sticker?.emoji || "◇"}{/if}</span>

<style>
  .reaction-icon { display: inline-grid; place-items: center; width: 21px; height: 21px; font: 18px/1 var(--emoji-font), sans-serif; flex-shrink: 0 }
  img { width: 100%; height: 100%; object-fit: contain }
</style>
