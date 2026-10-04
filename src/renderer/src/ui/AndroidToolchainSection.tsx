import { useCallback, useEffect, useRef, useState } from 'react'
import type { AndroidToolchainStatus } from '@shared/ipc'

/**
 * Configurações › Android: o que falta da toolchain (JDK 17, SDK, emulador,
 * imagem do sistema, AVD) e o botão para instalar agora. É a mesma instalação
 * que o agente faz sozinho (android_setup) e a geração do APK do celular —
 * instalar aqui só adianta o download.
 */
export function AndroidToolchainSection(): JSX.Element {
  const [status, setStatus] = useState<AndroidToolchainStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await window.api.androidToolchainStatus()
      if (alive.current) setStatus(s)
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    const off = window.api.onAndroidToolchainProgress((l) => alive.current && setLine(l))
    return () => {
      alive.current = false
      off()
    }
  }, [refresh])

  // Instalação iniciada pelo agente ou pelo APK: os passos não vêm para cá,
  // então o status é relido até ela terminar.
  const elsewhere = !busy && status?.installing === true
  useEffect(() => {
    if (!elsewhere) return
    const t = setInterval(() => void refresh(), 3000)
    return () => clearInterval(t)
  }, [elsewhere, refresh])

  const install = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setLine(null)
    try {
      const r = await window.api.androidToolchainInstall()
      if (alive.current && !r.ok) setError(r.error || 'Não consegui instalar a toolchain Android.')
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) {
        setBusy(false)
        setLine(null)
        void refresh()
      }
    }
  }

  const ready = status?.ready === true
  const installing = busy || status?.installing === true

  return (
    <section className="settings-section">
      <span className="settings-field-label">Ferramentas Android</span>
      <div className="settings-install">
        <div className="settings-install-row">
          <span className={`settings-install-status${ready ? ' ok' : ''}`} data-testid="android-status">
            {status === null
              ? 'Verificando…'
              : ready
                ? 'Instalado neste computador'
                : `Falta: ${status.missing.join(', ')}`}
          </span>
          <button type="button" className="btn" disabled={installing || status === null || ready} onClick={() => void install()}>
            {installing ? 'Instalando…' : ready ? 'Instalado' : 'Instalar'}
          </button>
        </div>
        {installing && line && (
          <span className="settings-hint" role="status">
            {line}
          </span>
        )}
        {error && (
          <span className="settings-hint settings-install-error" role="alert">
            {error}
          </span>
        )}
      </div>
      <span className="settings-hint">
        JDK 17, Android SDK, emulador e um aparelho virtual — o necessário para o agente gerar APKs e abrir o
        preview Android, e para gerar o app do celular. São alguns GB, baixados uma vez. Sem instalar aqui, o
        agente instala quando precisar; um Android Studio já instalado é reaproveitado.
      </span>
    </section>
  )
}
