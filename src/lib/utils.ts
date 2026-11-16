import type { ProfileTarget, TextEntityData, ChatActivityData, ChatActivityKind, MsgData, SenderData } from "$lib/api/td"

export function releaseMedia(element: HTMLMediaElement) {
  return {
    destroy() {
      if (!element.hasAttribute("src")) return
      element.pause()
      element.removeAttribute("src")
      element.load()
    },
  }
}

export function horizontalWheel(element: HTMLElement) {
  const scroll = (event: WheelEvent) => {
    if (event.ctrlKey || element.scrollWidth <= element.clientWidth) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    event.preventDefault()
    element.scrollLeft += delta * (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? element.clientWidth : 1)
  }
  element.addEventListener("wheel", scroll, { passive: false })
  return { destroy: () => element.removeEventListener("wheel", scroll) }
}

export function rangeSlider(element: HTMLInputElement, value: number) {
  const update = (current: number) => {
    const minimum = Number(element.min) || 0
    const maximum = Number(element.max) || 100
    element.style.setProperty("--range-fill", `${Math.max(0, Math.min(100, (current - minimum) / Math.max(1, maximum - minimum) * 100))}%`)
  }
  update(value)
  return { update }
}

export function mentionQuery(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null
  const match = text.slice(0, caret).match(/(?:^|[\s(])@([\p{L}\p{N}_]{0,64})$/u)
  if (!match || /[\p{L}\p{N}_]/u.test(text[caret] ?? "")) return null
  return { start: caret - match[1].length - 1, end: caret, query: match[1] }
}

export function chatEventText(message: MsgData, sender: SenderData = message.sender): string {
  if (message.content.kind !== "Event") return ""
  const event = message.content.data
  const actor = sender.name || "Участник"
  const members = event.members.map((member) => member.name || "Участник").join(", ")
  switch (event.action) {
    case "pin": return `${actor} закрепил сообщение`
    case "add_members": return event.members.length === 1 && event.members[0].id === sender.id ? `${actor} вступил в группу` : `${actor} добавил ${members}`
    case "remove_member": return event.members[0]?.id === sender.id ? `${actor} вышел из группы` : `${actor} удалил ${members}`
    case "join": return `${actor} вступил по ссылке`
    case "title": return `${actor} изменил название на «${event.text}»`
    case "create": return `${actor} создал группу «${event.text}»`
    case "upgrade": return "Группа стала супергруппой"
    case "photo": return `${actor} изменил фото группы`
    case "delete_photo": return `${actor} удалил фото группы`
    default: return `${actor} ${event.text}`
  }
}

export function chatActivityText(items: ChatActivityData[], group: boolean): string {
  if (!items.length) return ""
  const actions: Record<ChatActivityKind, [string, string]> = {
    typing: ["печатает", "печатают"], recording_voice: ["записывает голосовое", "записывают голосовое"],
    recording_video: ["записывает видео", "записывают видео"], uploading_video: ["отправляет видео", "отправляют видео"],
    uploading_voice: ["отправляет голосовое", "отправляют голосовые"], uploading_photo: ["отправляет фото", "отправляют фото"],
    uploading_file: ["отправляет файл", "отправляют файлы"], choosing_sticker: ["выбирает стикер", "выбирают стикеры"],
    choosing_location: ["выбирает место", "выбирают место"], choosing_contact: ["выбирает контакт", "выбирают контакты"],
    playing_game: ["играет", "играют"], recording_video_note: ["записывает кружок", "записывают кружки"],
    uploading_video_note: ["отправляет кружок", "отправляют кружки"], watching_animation: ["смотрит анимацию", "смотрят анимацию"], cancel: ["", ""],
  }
  if (!group) return actions[items[0].action][0]
  const name = (item: ChatActivityData) => item.sender.name || "Участник"
  if (items.length === 1) return `${name(items[0])} ${actions[items[0].action][0]}`
  if (items.every((item) => item.action === items[0].action)) {
    const names = items.length === 2 ? `${name(items[0])} и ${name(items[1])}` : `${name(items[0])}, ${name(items[1])} и ещё ${items.length - 2}`
    return `${names} ${actions[items[0].action][1]}`
  }
  return items.slice(0, 2).map((item) => `${name(item)} ${actions[item.action][0]}`).join(", ")
}

export function initials(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function avatarClass(id: number, title: string): string {
  let hash = 0;
  for (const ch of title + id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `avatar-${Math.abs(hash) % 7}`;
}

export function formatTime(unix: number, timeOnly = false): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (timeOnly || sameDay) return `${hh}:${mm}`
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) {
    const days = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
    return days[d.getDay()];
  }
  return `${d.getDate().toString().padStart(2, "0")}.${(d.getMonth() + 1)
    .toString()
    .padStart(2, "0")}.${String(d.getFullYear()).slice(2)}`;
}

export function messagePreview(content: { kind: string; data: Record<string, unknown> }): string {
  switch (content.kind) {
    case "Text":
      return String(content.data.text);
    case "Photo":
      return "Фото"
    case "Video":
      return "Видео"
    case "VideoNote":
      return "Кружок"
    case "Animation":
      return "GIF"
    case "File":
      return String(content.data.file_name)
    case "Audio":
      return String(content.data.title || content.data.file_name || "Музыка")
    case "Voice":
      return "Голосовое сообщение"
    case "Sticker":
      return content.data.emoji ? `${content.data.emoji} Стикер` : "Стикер"
    case "Unsupported":
      return String(content.data.label);
    case "Event":
      return "Событие чата"
    default:
      return "";
  }
}

export function formatDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`
}

export function voiceWaveform(encoded: string): number[] {
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
    const count = Math.floor(bytes.length * 8 / 5)
    if (!count) return Array(36).fill(3)
    const samples = Array.from({ length: count }, (_, index) => {
      const bit = index * 5
      const byte = bit >> 3
      return ((bytes[byte] | (bytes[byte + 1] ?? 0) << 8) >> (bit % 8)) & 31
    })
    return Array.from({ length: 36 }, (_, index) => {
      const start = Math.floor(index * count / 36)
      const end = Math.max(start + 1, Math.floor((index + 1) * count / 36))
      return Math.max(3, ...samples.slice(start, end))
    })
  } catch {
    return Array(36).fill(3)
  }
}

export function profileTargetFromUrl(value: string): ProfileTarget | null {
  try {
    const url = new URL(value.includes(":") ? value : `https://${value}`)
    if (url.protocol === "tg:" && url.hostname === "user") {
      const id = Number(url.searchParams.get("id"))
      return Number.isSafeInteger(id) && id > 0 ? { kind: "user", id } : null
    }
    if (!["http:", "https:"].includes(url.protocol) || !["t.me", "telegram.me", "www.t.me"].includes(url.hostname)) return null
    const username = url.pathname.replace(/^\/+|\/+$/g, "")
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(username) || ["share", "joinchat", "addstickers", "addemoji", "c", "s", "proxy", "login"].includes(username.toLowerCase())) return null
    return { kind: "username", username }
  } catch {
    return null
  }
}

export function isTelegramUrl(value: string) {
  try {
    const url = new URL(value.includes(":") ? value : `https://${value}`)
    return url.protocol === "tg:" || ["http:", "https:"].includes(url.protocol) && ["t.me", "telegram.me", "www.t.me"].includes(url.hostname)
  } catch {
    return false
  }
}

type TextFormat = Exclude<TextEntityData["kind"], "mention" | "user" | "url">

export type TextPart = { text: string; target?: ProfileTarget; url?: string; format?: TextFormat; children?: TextPart[] }

function plainTextParts(text: string, autoLink: boolean): TextPart[] {
  if (!text) return []
  if (!autoLink) return [{ text }]
  const parts: TextPart[] = []
  let start = 0
  for (const match of text.matchAll(/\b(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s<>]+/gi)) {
    const value = match[0].replace(/[.,!?;:)\]}]+$/, "")
    if (match.index > start) parts.push({ text: text.slice(start, match.index) })
    parts.push({ text: value, url: /^https?:/i.test(value) ? value : `https://${value}` })
    start = match.index + value.length
  }
  if (start < text.length) parts.push({ text: text.slice(start) })
  return parts
}

function entityPriority(kind: TextEntityData["kind"]) {
  if (kind === "quote" || kind === "expandable_quote") return 0
  if (kind === "spoiler" || kind === "pre" || kind === "code") return 1
  return 2
}

export function textParts(text: string, entities: TextEntityData[] = []): TextPart[] {
  const isBoundary = (offset: number) => !(text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff)
  const ordered = entities.filter(({ offset, length }) => Number.isInteger(offset) && Number.isInteger(length)
    && offset >= 0 && length > 0 && offset + length <= text.length && isBoundary(offset) && isBoundary(offset + length))
    .sort((a, b) => a.offset - b.offset || b.length - a.length || entityPriority(a.kind) - entityPriority(b.kind))
  let index = 0

  function parse(start: number, end: number, autoLink: boolean, depth: number): TextPart[] {
    const parts: TextPart[] = []
    let cursor = start
    while (index < ordered.length && ordered[index].offset < end) {
      const entity = ordered[index++]
      const next = entity.offset + entity.length
      if (entity.offset < cursor || next > end) continue
      parts.push(...plainTextParts(text.slice(cursor, entity.offset), autoLink))
      const content = text.slice(entity.offset, next)
      const part: TextPart = { text: content }
      const { kind } = entity
      const link = kind === "user" || kind === "mention" || kind === "url"
      if (autoLink && kind === "user" && entity.user_id && Number.isSafeInteger(entity.user_id)) part.target = { kind: "user", id: entity.user_id }
      else if (autoLink && kind === "mention") part.target = { kind: "username", username: content.replace(/^@/, "") }
      else if (autoLink && kind === "url") {
        const value = entity.value || content
        const target = profileTargetFromUrl(value)
        if (target) part.target = target
        else {
          try {
            const url = new URL(value.includes(":") ? value : `https://${value}`)
            if (["http:", "https:"].includes(url.protocol) || isTelegramUrl(url.href)) part.url = url.href
          } catch {}
        }
      } else if (!link) part.format = kind

      if (part.format !== "pre" && part.format !== "code" && depth < 12) {
        const children = parse(entity.offset, next, autoLink && !link, depth + 1)
        if (children.length !== 1 || children[0].format || children[0].url || children[0].target || children[0].children) part.children = children
      } else {
        while (index < ordered.length && ordered[index].offset < next) index += 1
      }
      parts.push(part)
      cursor = next
    }
    parts.push(...plainTextParts(text.slice(cursor, end), autoLink))
    return parts
  }
  return parse(0, text.length, true, 0)
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}
