<script lang="ts">
  import { openUrl } from "@tauri-apps/plugin-opener"
  import { SvelteSet } from "svelte/reactivity"
  import { openProfile, openTelegramLink } from "$lib/stores/app.svelte"
  import { textParts, isTelegramUrl, type TextPart } from "$lib/utils"
  import type { TextEntityData } from "$lib/api/td"

  let { text, entities = [] }: { text: string; entities?: TextEntityData[] } = $props()
  const parts = $derived(textParts(text, entities))
  const revealed = new SvelteSet<TextPart>()
  let error = $state("")

  $effect(() => {
    void parts
    revealed.clear()
  })

  async function follow(event: MouseEvent, url: string | undefined) {
    event.preventDefault()
    error = ""
    if (!url) return
    if (isTelegramUrl(url)) {
      try {
        await openTelegramLink(url)
        return
      } catch {}
    }
    await openUrl(url).catch(() => error = "Не удалось открыть ссылку")
  }
</script>

{#snippet contents(part: TextPart)}{#if part.children}{@render renderParts(part.children)}{:else}{part.text}{/if}{/snippet}

{#snippet renderParts(items: TextPart[])}
  {#each items as part}
    {#if part.target}<button class="mention" onclick={() => { if (part.target) void openProfile(part.target) }}>{@render contents(part)}</button>
    {:else if part.url}<a href={part.url} onclick={(event) => follow(event, part.url)}>{@render contents(part)}</a>
    {:else if part.format === "bold"}<strong>{@render contents(part)}</strong>
    {:else if part.format === "italic"}<em>{@render contents(part)}</em>
    {:else if part.format === "underline"}<u>{@render contents(part)}</u>
    {:else if part.format === "strikethrough"}<s>{@render contents(part)}</s>
    {:else if part.format === "code"}<code>{part.text}</code>
    {:else if part.format === "pre"}<pre><code>{part.text}</code></pre>
    {:else if part.format === "quote"}<blockquote>{@render contents(part)}</blockquote>
    {:else if part.format === "expandable_quote"}
      <blockquote>
        <div class:collapsed={!revealed.has(part)} inert={!revealed.has(part)}>{@render contents(part)}</div>
        <button class="quote-toggle" aria-expanded={revealed.has(part)} onclick={() => { if (!revealed.delete(part)) revealed.add(part) }}>{revealed.has(part) ? "Свернуть цитату" : "Развернуть цитату"}</button>
      </blockquote>
    {:else if part.format === "spoiler" && !revealed.has(part)}
      <button class="spoiler" aria-label="Показать спойлер" onclick={() => revealed.add(part)}><span aria-hidden="true">{part.text}</span></button>
    {:else}{@render contents(part)}{/if}
  {/each}
{/snippet}

<div class="rich-text">{@render renderParts(parts)}</div>
{#if error}<span class="link-error" role="alert">{error}</span>{/if}

<style>
  .rich-text { display: inline; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text }
  .mention, a { display: inline; padding: 0; color: var(--accent-hover); font: inherit; text-align: inherit; white-space: inherit; user-select: text }
  .mention:hover, a:hover { text-decoration: underline; text-underline-offset: 3px }
  strong { font-weight: 650 }
  code { font-family: "Geist Mono", Consolas, monospace; font-size: .92em; font-weight: 400; padding: 1px 4px; border-radius: 4px; background: var(--bg-input) }
  pre, blockquote { margin: 5px 0; padding: 7px 9px; border-radius: 6px; background: var(--bg-input); text-align: left }
  pre { white-space: pre-wrap; overflow-wrap: anywhere }
  pre code { padding: 0; background: transparent }
  blockquote { border-inline-start: 2px solid var(--accent-hover) }
  .collapsed { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden }
  .quote-toggle { padding: 4px 0 0; font-size: .85em; color: var(--text-primary); text-decoration: underline }
  .spoiler { display: inline; max-width: 100%; padding: 0; border-radius: 3px; white-space: inherit; overflow-wrap: inherit; font: inherit; background: var(--text-secondary); color: transparent; user-select: none }
  .link-error { color: var(--danger); font-size: 11px; display: block }
</style>
