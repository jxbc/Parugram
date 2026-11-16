<script lang="ts">
  import { onMount, tick } from "svelte"

  let { value = $bindable(""), kind, label, disabled = false, autofocus = false, fresh = false, centered = false }: {
    value?: string; kind: "pin" | "password"; label: string; disabled?: boolean; autofocus?: boolean; fresh?: boolean; centered?: boolean
  } = $props()
  let fields: HTMLInputElement[] = []
  let passwordInput: HTMLInputElement | undefined = $state()
  let digits = $state(["", "", "", ""])

  $effect(() => {
    if (kind === "pin" && value !== digits.join("")) digits = Array.from({ length: 4 }, (_, index) => value[index] ?? "")
  })

  onMount(() => {
    if (autofocus) (kind === "pin" ? fields[0] : passwordInput)?.focus()
  })

  $effect(() => {
    if (autofocus && !disabled && value === "") void tick().then(() => (kind === "pin" ? fields[0] : passwordInput)?.focus())
  })

  function update(index: number, event: Event) {
    const field = event.currentTarget as HTMLInputElement
    const digit = field.value.replace(/\D/g, "").slice(-1)
    field.value = digit
    digits[index] = digit
    value = digits.join("")
    if (digit && index < 3) fields[index + 1]?.focus()
  }

  function paste(index: number, event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text").replace(/\D/g, "").slice(0, 4) ?? ""
    event.preventDefault()
    if (!text) return
    const start = text.length === 4 ? 0 : index
    for (let offset = 0; offset < text.length && start + offset < 4; offset += 1) digits[start + offset] = text[offset]
    value = digits.join("")
    fields[Math.min(3, start + text.length)]?.focus()
  }

  function key(index: number, event: KeyboardEvent) {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault()
      fields[Math.max(0, Math.min(3, index + (event.key === "ArrowLeft" ? -1 : 1)))]?.focus()
    } else if (event.key === "Backspace" && !digits[index] && index > 0) {
      event.preventDefault()
      digits[index - 1] = ""
      value = digits.join("")
      fields[index - 1]?.focus()
    }
  }
</script>

<div class="secret-field" class:centered>
  {#if kind === "pin"}
    <span class="secret-label">{label}</span>
    <div class="pin-fields" role="group" aria-label={label}>{#each [0, 1, 2, 3] as index}<input bind:this={fields[index]} type="password" inputmode="numeric" autocomplete="off" maxlength="1" aria-label={`${label}, цифра ${index + 1}`} value={digits[index]} {disabled} onfocus={(event) => event.currentTarget.select()} oninput={(event) => update(index, event)} onpaste={(event) => paste(index, event)} onkeydown={(event) => key(index, event)} />{/each}</div>
  {:else}
    <label class="secret-label">{label}<input bind:this={passwordInput} class="text-input" type="password" autocomplete={fresh ? "new-password" : "current-password"} placeholder={fresh ? "Не менее 4 символов" : undefined} maxlength="128" {disabled} bind:value /></label>
  {/if}
</div>

<style>
  .secret-field { min-width: 0 }
  .secret-label { display: grid; gap: 8px; font-size: 12px; color: var(--text-secondary) }
  .pin-fields { display: flex; gap: 9px; margin-top: 8px }
  .pin-fields input { width: 48px; height: 52px; border: 1px solid var(--border); border-radius: 14px; text-align: center; font-size: 24px; padding: 0; caret-color: var(--accent) }
  .pin-fields input:focus { border-color: var(--accent); background: var(--accent-soft) }
  .text-input { margin-top: 0 }
  .centered { text-align: center }
  .centered .pin-fields { justify-content: center }
  .centered input { background: transparent }
  .centered input:focus { border: 3px solid var(--accent); background: transparent; box-shadow: none }
  .centered .text-input { text-align: center; height: 52px; border-radius: 15px }
</style>
