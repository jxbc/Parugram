<script lang="ts">
  let { name, size = 20, strokeWidth = 1.5 }: { name: string; size?: number; strokeWidth?: number } = $props()
  const sources = import.meta.glob<string>([
    "/node_modules/iconoir/icons/regular/{archive,arrow-right,arrow-up-right,badge-check,bell,bell-off,bookmark,chat-bubble,check,clock,copy,double-check,download,edit-pencil,emoji,expand,eye,eye-closed,frame,log-out,mail,media-image,microphone,minus,more-horiz,music-note,repeat,repeat-once,shuffle,skip-next,skip-prev,sound-high,sound-off,nav-arrow-down,nav-arrow-left,nav-arrow-right,page,pause,pin,play,plus,reply,search,settings,shield-check,sparks,square,trash,user,view-columns-2,warning-circle,xmark}.svg",
    "/node_modules/iconoir/icons/solid/send.svg",
  ], { eager: true, query: "?raw", import: "default" })
  const inline: Record<string, string> = {
    "ph:sticker": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="M168,32H88A56.06,56.06,0,0,0,32,88v80a56.06,56.06,0,0,0,56,56h48a8.07,8.07,0,0,0,2.53-.41c26.23-8.75,76.31-58.83,85.06-85.06A8.07,8.07,0,0,0,224,136V88A56.06,56.06,0,0,0,168,32ZM48,168V88A40,40,0,0,1,88,48h80a40,40,0,0,1,40,40v40H184a56.06,56.06,0,0,0-56,56v24H88A40,40,0,0,1,48,168Zm96,35.14V184a40,40,0,0,1,40-40h19.14C191,163.5,163.5,191,144,203.14Z"/></svg>',
    "mynaui:image": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 8a2 2 0 1 0 4 0a2 2 0 0 0-4 0m14.427 1.99c-6.61-.908-12.31 4-11.927 10.51"/><path d="M3 13.066c2.78-.385 5.275.958 6.624 3.1"/><path d="M3 9.4c0-2.24 0-3.36.436-4.216a4 4 0 0 1 1.748-1.748C6.04 3 7.16 3 9.4 3h5.2c2.24 0 3.36 0 4.216.436a4 4 0 0 1 1.748 1.748C21 6.04 21 7.16 21 9.4v5.2c0 2.24 0 3.36-.436 4.216a4 4 0 0 1-1.748 1.748C17.96 21 16.84 21 14.6 21H9.4c-2.24 0-3.36 0-4.216-.436a4 4 0 0 1-1.748-1.748C3 17.96 3 16.84 3 14.6z"/></svg>',
  }
  const svg = $derived(inline[name] ?? sources[`/node_modules/iconoir/icons/${name === "send-solid" ? "solid/send" : `regular/${name}`}.svg`] ?? "")
</script>

<span class="icon" aria-hidden="true" style:width={`${size}px`} style:height={`${size}px`} style:--icon-stroke={strokeWidth}>{@html svg}</span>

<style>
  .icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; vertical-align: middle }
  .icon :global(svg) { width: 100%; height: 100%; stroke-width: var(--icon-stroke) }
</style>
