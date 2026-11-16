<script lang="ts">
  import { renderSVG } from "uqr"
  import Icon from "$lib/components/Icon.svelte"
  import { store, api } from "$lib/stores/app.svelte"

  let phone = $state("")
  let code = $state("")
  let password = $state("")
  let firstName = $state("")
  let lastName = $state("")
  let busy = $state(false)
  let changingMethod = $state(false)
  let error = $state("")
  let showPassword = $state(false)
  let hidePhone = $state(false)
  let input: HTMLInputElement | undefined = $state()
  const stage = $derived(store.stage)
  const qrStage = $derived(stage === "wait_other_device")
  const qrSrc = $derived(qrStage && store.qrLoginLink ? `data:image/svg+xml,${encodeURIComponent(renderSVG(store.qrLoginLink, { border: 4, ecc: "M", pixelSize: 1 }))}` : "")
  const title = $derived(qrStage ? "Вход по QR-коду" : stage === "wait_code" ? "Код подтверждения" : stage === "wait_password" ? "Пароль Telegram" : stage === "wait_registration" ? "Как вас зовут?" : "Sign in to Telegram")
  const canSubmit = $derived(stage === "wait_phone" ? phone.replace(/\D/g, "").length >= 6 : stage === "wait_code" ? code.trim().length >= 3 : stage === "wait_password" ? password.length > 0 : firstName.trim().length > 0)
  const formStage = $derived(["wait_phone", "wait_code", "wait_password", "wait_registration"].includes(stage))

  $effect(() => {
    void stage
    input?.focus()
    error = ""
    changingMethod = false
  })

  async function switchLoginMethod(request: () => Promise<void>, failure: string) {
    if (busy || changingMethod) return
    changingMethod = true
    error = ""
    const previousStage = stage
    try {
      await request()
    } catch {
      if (stage === previousStage) {
        changingMethod = false
        error = failure
      }
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (busy || changingMethod || !canSubmit) return
    busy = true
    error = ""
    try {
      if (stage === "wait_phone") await api.setPhone(phone.trim().replace(/[^\d+]/g, ""))
      else if (stage === "wait_code") await api.setCode(code.trim())
      else if (stage === "wait_password") await api.setPassword(password)
      else if (stage === "wait_registration") await api.registerUser(firstName.trim(), lastName.trim())
    } catch (failure) {
      const message = String(failure)
      error = message.includes("PHONE_NUMBER_INVALID") ? "Проверьте номер телефона" : message.includes("PHONE_CODE_INVALID") ? "Неверный код" : message.includes("PHONE_CODE_EXPIRED") ? "Код истёк. Запросите новый" : message.includes("PASSWORD_HASH_INVALID") ? "Неверный пароль" : message
    } finally {
      busy = false
    }
  }
</script>

<main class="auth-screen">
  <div class="auth-shell">
  <section class="auth-form auth-card" aria-labelledby="auth-title">
    <h1 id="auth-title">{title}</h1>
    {#if formStage}
      <form onsubmit={submit}>
        {#if stage === "wait_phone"}
          <label>Номер телефона<div class="phone-field"><input class="text-input" type={hidePhone ? "password" : "tel"} inputmode="tel" autocomplete="tel" placeholder="+380 00 000 00 00" bind:value={phone} bind:this={input} maxlength={24} /><button type="button" class="icon-button" aria-label={hidePhone ? "Показать номер" : "Скрыть номер"} aria-pressed={hidePhone} onclick={() => hidePhone = !hidePhone}><Icon name={hidePhone ? "eye" : "eye-closed"} size={18} /></button></div></label>
        {:else if stage === "wait_code"}
          <label>Код<input class="text-input code-input" inputmode="numeric" autocomplete="one-time-code" placeholder="00000" bind:value={code} bind:this={input} /></label>
        {:else if stage === "wait_password"}
          <label>Облачный пароль<div class="password-field"><input class="text-input" type={showPassword ? "text" : "password"} autocomplete="current-password" placeholder="Пароль" bind:value={password} bind:this={input} /><button type="button" class="icon-button" aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"} onclick={() => showPassword = !showPassword}>{#if showPassword}<Icon name="eye-closed" size={18} />{:else}<Icon name="eye" size={18} />{/if}</button></div></label>
        {:else}
          <label>Имя<input class="text-input" autocomplete="given-name" placeholder="Имя" bind:value={firstName} bind:this={input} /></label>
          <label>Фамилия<input class="text-input" autocomplete="family-name" placeholder="Необязательно" bind:value={lastName} /></label>
        {/if}
        {#if error}<div class="auth-error" role="alert">{error}</div>{/if}
        <button type="submit" class="btn-accent continue" disabled={busy || changingMethod || !canSubmit}>{busy ? "Подождите..." : stage === "wait_phone" ? "Продолжить" : stage === "wait_registration" ? "Создать аккаунт" : "Войти"}<Icon name="arrow-right" size={17} strokeWidth={1.5} /></button>
        {#if stage === "wait_phone" && !store.appLock?.session_suspended}
          <button type="button" class="login-method" disabled={busy || changingMethod} onclick={() => switchLoginMethod(api.requestQrLogin, "Не удалось получить QR-код")}>{changingMethod ? "Получаем QR-код…" : "Войти по QR-коду"}</button>
        {/if}
      </form>
    {:else if qrStage}
      <div class="qr-login">
        {#if qrSrc && !changingMethod}
          <img class="login-qr" src={qrSrc} alt="QR-код для входа в Telegram" width="216" height="216" />
          <p class="auth-status">В Telegram откройте «Настройки → Устройства → Подключить устройство» и отсканируйте код.</p>
        {:else if !changingMethod}<p class="auth-status" role="status">Получаем QR-код…</p>{/if}
        {#if error}<div class="auth-error" role="alert">{error}</div>{/if}
        <button type="button" class="login-method" disabled={changingMethod} onclick={() => switchLoginMethod(api.cancelQrLogin, "Не удалось вернуться к входу по номеру")}>{changingMethod ? "Переключаемся…" : "Войти по номеру телефона"}</button>
      </div>
    {:else if stage === "no_credentials"}
      <div class="auth-error" role="alert">Не удалось запустить вход в Telegram.</div>
    {:else if store.startupError}<div class="auth-error" role="alert">{store.startupError}</div>
    {:else}<p class="auth-status">{stage === "loading" ? "Подключаемся к Telegram..." : stage === "logged_out" ? "Вы вышли из аккаунта. Перезапустите приложение." : "Этот способ входа пока недоступен"}</p>{/if}
  </section>
  {#if formStage}<p class="privacy-note">Ваши данные передаются напрямую в Telegram через MTProto, мы не передаем и не храним ваши данные, честно, клянусь</p>{/if}
  </div>
</main>

<style>
  .auth-screen { width: 100%; min-width: 0; display: grid; place-items: center; padding: 40px 20px; overflow: auto }
  .auth-shell { width: 448px; max-width: 100%; animation: appear .35s ease-out }
  .auth-form { padding: 40px 36px 36px; background: linear-gradient(150deg, rgba(19,28,43,.15), rgba(8,13,22,.2)) }
  h1 { font-size: clamp(27px, 3.2vw, 34px); letter-spacing: -1.2px; line-height: 1.15; margin: 0 0 32px; font-weight: 500; color: #f2f6ff }
  form { display: grid; gap: 20px }
  .qr-login { display: grid; justify-items: center; gap: 16px; text-align: center }
  .login-qr { display: block; max-width: 100%; height: auto; aspect-ratio: 1; border-radius: 14px }
  .login-method { justify-self: center; padding: 4px 0; color: var(--accent-hover); font-size: 13px }
  .login-method:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px }
  .login-method:disabled { opacity: .55 }
  label { display: grid; gap: 9px; color: #a1b2cc; font-size: 12px }
  .text-input { height: 52px; border-radius: 15px; border-color: rgba(119,152,203,.16); background: rgba(3,8,16,.52); font-size: 15px; padding: 14px 16px; transition: border-color .2s, box-shadow .2s }
  .text-input:focus { border-color: rgba(79,143,255,.76); box-shadow: 0 0 0 3px rgba(52,127,255,.09), inset 0 1px 8px rgba(0,0,0,.15) }
  .code-input { letter-spacing: 7px; font-size: 20px; text-align: center }
  .password-field, .phone-field { position: relative }
  .password-field input, .phone-field input { padding-right: 48px }
  .password-field .icon-button, .phone-field .icon-button { position: absolute; right: 9px; top: 9px }
  .privacy-note { margin: 23px 16px 0; text-align: center; font-size: 11px; line-height: 1.7; color: #7d90ae; text-wrap: pretty }
  .auth-error { color: var(--danger); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; user-select: text }
  .auth-status { color: var(--text-secondary); font-size: 12px; line-height: 1.7; margin: 0 }
  @media (max-width: 480px) { .auth-screen { padding: 28px 10px } .auth-form { padding: 30px 24px; border-radius: 25px } .privacy-note { margin-inline: 6px } }
  @media (max-height: 600px) { .auth-screen { padding-block: 24px } .auth-form { padding-block: 28px } h1 { margin-bottom: 24px } .privacy-note { margin-top: 18px } }
</style>
