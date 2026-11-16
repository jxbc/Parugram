<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte"
  import { convertFileSrc } from "@tauri-apps/api/core"
  import { openPath } from "@tauri-apps/plugin-opener"
  import Icon from "$lib/components/Icon.svelte"
  import { store, api, loadAvatar, stepMusic, stopMusic, jumpToMessage, setMusicShuffle, playVoice, seekVoice, stopVoice } from "$lib/stores/app.svelte"
  import { formatDuration, rangeSlider, releaseMedia } from "$lib/utils"
  import { telegramMediaSrc } from "$lib/api/td"

  let audio: HTMLAudioElement | undefined = $state()
  let voiceAudio: HTMLAudioElement | undefined = $state()
  let previousVolume = .8
  let retry = $state(0)
  const music = $derived(store.music)
  const voice = $derived(store.voice)
  const path = $derived(music ? store.files.get(music.track.fileId) : null)
  const src = $derived(music ? `${telegramMediaSrc(music.track.fileId, music.track.fileName, "mp3")}?retry=${retry}` : "")
  const cover = $derived(music?.track.coverFileId ? store.files.get(music.track.coverFileId) : null)

  $effect(() => {
    const node = voiceAudio
    const current = voice
    if (!node || !current) return
    if (!current.playing || store.playingVoice !== current.key) {
      node.pause()
      return
    }
    let disposed = false
    if (node.error) node.load()
    void node.play().catch((error) => {
      if (!disposed && error?.name !== "AbortError") failVoice(node)
    })
    return () => { disposed = true }
  })

  $effect(() => { if (voiceAudio && voice) voiceAudio.playbackRate = voice.speed })

  $effect(() => {
    if (!voiceAudio || !voice || voice.seekTo === null) return
    voiceAudio.currentTime = voice.seekTo
    voice.seekTo = null
  })

  function failVoice(node: HTMLAudioElement) {
    if (!voice || node !== voiceAudio || node.dataset.key !== voice.key) return
    voice.playing = false
    voice.error = "Не удалось воспроизвести голосовое"
    if (store.playingVoice === voice.key) store.playingVoice = null
  }

  function voiceEvent(event: Event) {
    const node = event.currentTarget as HTMLAudioElement
    if (!voice || node !== voiceAudio || node.dataset.key !== voice.key) return
    if (event.type === "ended") stopVoice()
    else if (event.type === "error") failVoice(node)
    else if (event.type === "playing") {
      if (!voice.opened && store.playingVoice === voice.key) {
        voice.opened = true
        void api.openMessageContent(voice.chatId, voice.messageId, "voice").catch(() => {})
      }
    } else {
      voice.position = node.currentTime
      if (Number.isFinite(node.duration)) voice.duration = node.duration
    }
  }

  function toggleVoice() {
    if (voice) void playVoice(voice.chatId, voice.messageId, voice.fileId, voice.duration, voice.speed, voice.conversationKey)
  }

  $effect(() => {
    const id = music?.track.coverFileId
    if (id && !cover) void loadAvatar(id).catch(() => {})
  })

  $effect(() => {
    const node = audio
    const current = music
    const playing = current?.playing
    if (!node || !current) return
    let disposed = false
    if (playing) {
      if (node.ended || untrack(() => current.position === 0) && node.currentTime > 0) node.currentTime = 0
      void node.play().catch((error) => {
        if (disposed || store.music !== current) return
        current.playing = false
        current.loading = false
        current.error = error?.name === "NotAllowedError" ? "Нажмите воспроизведение ещё раз" : "Не удалось воспроизвести музыку"
      })
    } else node.pause()
    return () => { disposed = true }
  })

  $effect(() => { if (audio) audio.volume = store.musicVolume })
  $effect(() => { if (store.playingVoice && music) music.playing = false })

  $effect(() => {
    if (!("mediaSession" in navigator)) return
    const playing = voice ? voice.playing && !voice.loading : music?.playing
    navigator.mediaSession.metadata = voice ? new MediaMetadata({ title: "Голосовое сообщение" })
      : music ? new MediaMetadata({ title: music.track.title, artist: music.track.performer, artwork: cover ? [{ src: convertFileSrc(cover) }] : [] }) : null
    navigator.mediaSession.playbackState = voice || music ? playing ? "playing" : "paused" : "none"
  })

  function toggle() {
    if (!music) return
    if (audio?.error) retry += 1
    music.error = ""
    music.playing = !music.playing
    if (music.playing) {
      stopVoice()
      store.playingVoice = null
    }
  }

  function seek(position: number) {
    if (!audio || !music) return
    audio.currentTime = Math.max(0, Math.min(music.duration || 0, position))
    music.position = audio.currentTime
  }

  function timeUpdate(event: Event) {
    const node = event.currentTarget as HTMLAudioElement
    if (!music || music.track.key !== node.dataset.key) return
    music.position = node.currentTime
    if (Number.isFinite(node.duration)) music.duration = node.duration
    if ("mediaSession" in navigator && music.duration > 0) {
      try { navigator.mediaSession.setPositionState({ duration: music.duration, position: Math.min(music.duration, music.position), playbackRate: 1 }) }
      catch {}
    }
  }

  function audioStatus(event: Event) {
    const node = event.currentTarget as HTMLAudioElement
    const current = music
    if (!current || current.track.key !== node.dataset.key) return
    if (event.type === "waiting") current.loading = true
    else if (event.type === "canplay") current.loading = false
    else if (event.type === "ended") {
      current.loading = false
      stepMusic(1, true)
    } else if (event.type === "error") {
      current.error = "Не удалось воспроизвести музыку"
      current.playing = false
      current.loading = false
    }
  }

  function mute() {
    if (store.musicVolume > 0) {
      previousVolume = store.musicVolume
      store.musicVolume = 0
    } else store.musicVolume = previousVolume || .8
  }

  async function external() {
    if (!music) return
    const current = music
    try {
      const local = path || await loadAvatar(current.track.fileId)
      if (local && store.music === current) await openPath(local)
    } catch { if (store.music === current) current.error = "Не удалось открыть файл" }
  }

  onMount(() => {
    if (!("mediaSession" in navigator)) return
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => { if (voice) { if (!voice.playing) toggleVoice() } else if (music) { store.playingVoice = null; music.playing = true } }],
      ["pause", () => { if (voice?.playing) toggleVoice(); else if (music) music.playing = false }],
      ["previoustrack", () => { if (!voice) stepMusic(-1) }],
      ["nexttrack", () => { if (!voice) stepMusic(1) }],
      ["seekto", (details) => { if (details.seekTime !== undefined) (voice ? seekVoice : seek)(details.seekTime) }],
      ["seekbackward", (details) => (voice ? seekVoice : seek)((voice?.position ?? audio?.currentTime ?? 0) - (details.seekOffset ?? 10))],
      ["seekforward", (details) => (voice ? seekVoice : seek)((voice?.position ?? audio?.currentTime ?? 0) + (details.seekOffset ?? 10))],
    ]
    for (const [action, handler] of handlers) {
      try { navigator.mediaSession.setActionHandler(action, handler) }
      catch {}
    }
    return () => {
      for (const [action] of handlers) {
        try { navigator.mediaSession.setActionHandler(action, null) }
        catch {}
      }
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = "none"
    }
  })

  onDestroy(() => {
    stopVoice()
    if (store.music) store.music.playing = false
  })
</script>

{#if voice}
  <section class="voice-mini glass glowing-panel" aria-label="Плеер голосового сообщения">
    <button class="icon-button play" aria-label={voice.playing ? "Пауза" : "Воспроизвести голосовое"} disabled={voice.loading} onclick={toggleVoice}><Icon name={voice.playing && !voice.loading ? "pause" : "play"} size={17} /></button>
    <button class="voice-title" onclick={() => { if (voice) void jumpToMessage(voice.chatId, voice.messageId, voice.conversationKey).catch(() => {}) }}>{voice.loading ? "Загрузка…" : "Голосовое"}</button>
    <div class="timeline"><span>{formatDuration(voice.position)}</span><input type="range" aria-label="Перемотка голосового" min="0" max={voice.duration || 1} step="0.1" value={voice.position} use:rangeSlider={voice.position} disabled={!voice.path || !voice.duration} oninput={(event) => seekVoice(Number(event.currentTarget.value))} /><span>{formatDuration(voice.duration)}</span></div>
    <button class="icon-button" aria-label="Закрыть голосовое" onclick={stopVoice}><Icon name="xmark" size={16} /></button>
    {#if voice.error}<div class="music-error" role="alert">{voice.error}</div>{/if}
  </section>
  {#if voice.path}
    {#key voice}
      <audio bind:this={voiceAudio} use:releaseMedia data-key={voice.key} src={convertFileSrc(voice.path)} preload="metadata" onloadedmetadata={voiceEvent} ontimeupdate={voiceEvent} onplaying={voiceEvent} onended={voiceEvent} onerror={voiceEvent}></audio>
    {/key}
  {/if}
{:else if music}
  <section class="music-player glass glowing-panel" aria-label="Музыкальный плеер">
    <button class="track-info" onclick={() => { if (music) void jumpToMessage(music.track.chatId, music.track.messageId).catch(() => {}) }}>
      <span class="cover">{#if cover}<img src={convertFileSrc(cover)} alt="" />{:else}<Icon name="music-note" size={23} />{/if}</span>
      <span class="track-text"><strong>{music.track.title}</strong>{#if music.loading || music.track.performer || music.track.title !== music.track.fileName}<span>{music.loading ? "Загрузка..." : music.track.performer || music.track.fileName}</span>{/if}</span>
    </button>
    <div class="transport">
      <button class="icon-button small" class:active={store.musicShuffle} aria-label="Перемешать" aria-pressed={store.musicShuffle} onclick={() => setMusicShuffle(!store.musicShuffle)}><Icon name="shuffle" size={17} /></button>
      <button class="icon-button" aria-label="Предыдущий трек" onclick={() => stepMusic(-1)}><Icon name="skip-prev" size={19} /></button>
      <button class="icon-button play" aria-label={music.playing ? "Пауза" : "Воспроизвести"} onclick={toggle}><Icon name={music.playing ? "pause" : "play"} size={21} /></button>
      <button class="icon-button" aria-label="Следующий трек" disabled={music.queue.length < 2 || store.musicRepeat === "off" && music.queue.at(-1)?.key === music.track.key} onclick={() => stepMusic(1)}><Icon name="skip-next" size={19} /></button>
      <button class="icon-button small" class:active={store.musicRepeat !== "off"} aria-label={store.musicRepeat === "one" ? "Повтор одного трека" : store.musicRepeat === "all" ? "Повтор очереди" : "Без повтора"} aria-pressed={store.musicRepeat !== "off"} onclick={() => store.musicRepeat = store.musicRepeat === "off" ? "all" : store.musicRepeat === "all" ? "one" : "off"}><Icon name={store.musicRepeat === "one" ? "repeat-once" : "repeat"} size={17} /></button>
    </div>
    <div class="volume"><button class="icon-button small" aria-label={store.musicVolume ? "Выключить звук" : "Включить звук"} onclick={mute}><Icon name={store.musicVolume ? "sound-high" : "sound-off"} size={18} /></button><input type="range" aria-label="Громкость" min="0" max="1" step="0.01" value={store.musicVolume} use:rangeSlider={store.musicVolume} oninput={(event) => store.musicVolume = Number(event.currentTarget.value)} /></div>
    <button class="icon-button close" aria-label="Закрыть плеер" onclick={stopMusic}><Icon name="xmark" size={18} /></button>
    <div class="timeline"><span>{formatDuration(music.position)}</span><input type="range" aria-label="Перемотка музыки" min="0" max={music.duration || 1} step="0.1" value={music.position} use:rangeSlider={music.position} disabled={!music.duration} oninput={(event) => seek(Number(event.currentTarget.value))} /><span>{formatDuration(music.duration)}</span></div>
    {#if music.error}<div class="music-error" role="alert">{music.error}<button onclick={external}>Открыть файл</button></div>{/if}
  </section>
{/if}
{#if music}
  {#key src}<audio bind:this={audio} use:releaseMedia data-key={music.track.key} {src} preload="metadata" onloadedmetadata={timeUpdate} ontimeupdate={timeUpdate} onwaiting={audioStatus} oncanplay={audioStatus} onended={audioStatus} onerror={audioStatus}></audio>{/key}
{/if}

<style>
  .voice-mini { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 2px 8px; flex-shrink: 0; padding: 5px 8px; border-radius: 18px }
  .voice-mini .timeline { grid-column: auto }
  .voice-title { padding: 0; font-size: 12px; font-weight: 550 }
  .voice-title:hover { color: var(--accent-hover) }
  .music-player { display: grid; grid-template-columns: minmax(0, 1fr) auto 110px 28px; align-items: center; gap: 3px 12px; flex-shrink: 0; padding: 8px 13px 5px; border-radius: 23px }
  .track-info { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 0; text-align: left }
  .cover { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border-radius: 10px; background: var(--accent-soft); color: var(--accent-hover); overflow: hidden }
  .cover img { width: 100%; height: 100%; object-fit: cover }
  .track-text { display: grid; gap: 3px; min-width: 0 }
  .track-text strong, .track-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .track-text strong { font-size: 12px; font-weight: 550 }
  .track-text > span { font-size: 10px; color: var(--text-secondary) }
  .transport, .volume { display: flex; align-items: center; gap: 2px }
  .icon-button { width: 30px; height: 30px }
  .small { width: 25px; height: 28px }
  .active { color: var(--accent-hover) }
  .play { color: var(--accent-hover); background: var(--accent-soft) }
  .icon-button:disabled { opacity: .35 }
  .volume input { min-width: 0; width: 100%; margin: 0 }
  .timeline { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 10px }
  .timeline input { flex: 1; min-width: 0; margin: 0 }
  .timeline span { min-width: 30px; font-variant-numeric: tabular-nums }
  .timeline span:last-child { text-align: right }
  .music-error { grid-column: 1 / -1; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 11px; color: var(--danger); padding-bottom: 4px }
  .music-error button { font-size: inherit; color: var(--accent-hover); padding: 0 }
  @media (max-width: 1000px) {
    .music-player { grid-template-columns: minmax(0, 1fr) 80px 28px; gap: 4px 8px }
    .track-info { grid-column: 1 / 3 }
    .close { grid-column: 3; grid-row: 1 }
    .transport { grid-column: 1; grid-row: 2 }
    .volume { grid-column: 2 / 4; grid-row: 2; justify-self: end; width: 100px }
  }
</style>
