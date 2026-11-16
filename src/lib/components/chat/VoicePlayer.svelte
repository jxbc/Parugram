<script lang="ts">
  import Icon from "$lib/components/Icon.svelte"
  import { store, playVoice, seekVoice } from "$lib/stores/app.svelte"
  import { formatDuration, voiceWaveform } from "$lib/utils"

  let { fileId, duration, waveform, chatId, messageId, conversationKey, presentation = false }: {
    fileId: number; duration: number; waveform: string; chatId: number; messageId: number; conversationKey?: number; presentation?: boolean
  } = $props()
  let speed = $state(1)
  const key = $derived(`${chatId}:${messageId}`)
  const voice = $derived(!presentation && store.voice?.key === key && store.voice.fileId === fileId ? store.voice : null)
  const playing = $derived(voice?.playing && store.playingVoice === key)
  const position = $derived(voice?.position ?? 0)
  const total = $derived(voice?.duration ?? duration)
  const bars = $derived(voiceWaveform(waveform))

  function changeSpeed() {
    const current = voice?.speed ?? speed
    speed = current === 1 ? 1.5 : current === 1.5 ? 2 : 1
    if (voice) voice.speed = speed
  }
</script>

<div class="voice-player">
  <button class="play" aria-label={voice?.loading ? "Загрузка аудио" : playing ? "Пауза" : "Воспроизвести голосовое сообщение"} onclick={() => void playVoice(chatId, messageId, fileId, duration, speed, conversationKey)} disabled={presentation || voice?.loading}>
    {#if playing && !voice?.loading}<Icon name="pause" size={18} />{:else if !store.files.has(fileId)}<Icon name="download" size={19} />{:else}<Icon name="play" size={18} />{/if}
  </button>
  <div class="voice-body">
    <div class="waveform" aria-hidden="true">{#each bars as height, index}<span class:played={index / bars.length <= position / (total || 1)} style:height={`${height}px`}></span>{/each}</div>
    <input class="seek" type="range" aria-label="Позиция воспроизведения" min="0" max={total || 1} step="0.1" value={position} disabled={!voice?.path} oninput={(event) => seekVoice(Number(event.currentTarget.value))} />
    <div class="voice-meta"><span>{formatDuration(voice ? position : duration)}</span><button class="speed" aria-label="Скорость воспроизведения" disabled={presentation} onclick={changeSpeed}>{voice?.speed ?? speed}x</button></div>
  </div>
</div>

<style>
  .voice-player { display: flex; align-items: center; gap: 12px; min-width: 220px; padding: 4px 0 }
  .play { width: 38px; height: 38px; border-radius: 50%; background: rgba(119,160,229,.17); color: #a4c5ff; display: grid; place-items: center; flex-shrink: 0 }
  .play:hover { background: rgba(119,160,229,.25) }
  .voice-body { flex: 1; position: relative; min-width: 0 }
  .waveform { display: flex; align-items: center; justify-content: space-between; gap: 2px; height: 33px }
  .waveform span { width: 3px; border-radius: 2px; background: rgba(137,162,202,.27) }
  .waveform .played { background: #94baff }
  .seek { position: absolute; top: 0; left: 0; width: 100%; height: 33px; margin: 0; opacity: 0; cursor: pointer }
  .seek:focus-visible { opacity: .5 }
  .voice-meta { display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary); font-size: 10px; margin-top: 3px }
  .speed { color: var(--text-secondary); padding: 0 3px; font-size: 10px }
</style>
