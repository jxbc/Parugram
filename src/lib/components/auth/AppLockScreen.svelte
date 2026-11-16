<script lang="ts">
  import SecretInput from "./SecretInput.svelte"
  import Icon from "$lib/components/Icon.svelte"
  import { store, api, applyAppLockStatus } from "$lib/stores/app.svelte"

  let { startupError = "", retry }: { startupError?: string; retry: () => void } = $props()
  let secret = $state("")
  let busy = $state(false)
  let error = $state("")
  const status = $derived(store.appLock)
  const canSubmit = $derived(status?.kind === "pin" ? secret.length === 4 : secret.length > 0)

  async function unlock(event: SubmitEvent) {
    event.preventDefault()
    if (busy || !status || !canSubmit && !status.logout_pending) return
    busy = true
    error = ""
    try {
      const result = await api.unlockApp(secret)
      applyAppLockStatus(result.status)
      if (!result.accepted && !result.status.logout_pending) error = status.kind === "pin" ? "Неверный код" : "Неверный пароль"
      secret = ""
    } catch (failure) {
      error = String(failure)
    } finally {
      busy = false
    }
  }
</script>

<main class="lock-screen">
  <form class="lock-form auth-card" onsubmit={unlock}>
    <h1>Parugram</h1>
    {#if startupError}<div class="lock-error" role="alert">{startupError}</div><button class="btn-accent" type="button" onclick={retry}>Повторить</button>
    {:else if !status}<span class="lock-status">Подключение...</span>
    {:else if status.logout_pending || status.logged_out}<span class="lock-status">Выходим из аккаунта...</span>{#if status.logout_pending}<button class="btn-accent" type="submit" disabled={busy}>Повторить выход</button>{/if}
    {:else}<SecretInput bind:value={secret} kind={status.kind ?? "password"} label={status.kind === "pin" ? "Код приложения" : "Пароль приложения"} disabled={busy} autofocus centered />
      {#if error}<div class="lock-error" role="alert">{error}</div>{/if}
      <span class="lock-status">Осталось попыток: {status.remaining_attempts}</span>
      <button class="btn-accent" type="submit" disabled={busy || !canSubmit}>Открыть<Icon name="arrow-right" size={18} /></button>
    {/if}
  </form>
</main>

<style>
  .lock-screen { display: grid; place-items: center; width: 100%; height: 100%; min-height: 0; padding: 40px 20px; overflow: auto }
  .lock-form { display: flex; flex-direction: column; gap: 20px; width: 448px; max-width: 100%; padding: 40px 36px 36px; background: linear-gradient(150deg, rgba(19,28,43,.48), rgba(8,13,22,.58)); animation: appear .35s ease-out }
  h1 { margin: 0 0 12px; text-align: center; font-size: clamp(27px, 3.2vw, 34px); letter-spacing: -1.2px; line-height: 1.15; font-weight: 500; color: #f2f6ff }
  .lock-status { color: var(--text-secondary); font-size: 12px; line-height: 1.5; text-align: center }
  .lock-error { color: var(--danger); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; text-align: center }
  @media (max-width: 480px) { .lock-screen { padding: 28px 10px } .lock-form { padding: 30px 24px; border-radius: 25px } }
  @media (max-height: 600px) { .lock-screen { padding-block: 24px } .lock-form { padding-block: 28px } }
</style>
