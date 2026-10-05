import { useEffect, useRef, useState } from 'react'

/**
 * "Instalar voz e transcrição" item of the mic menu: downloads the local Kokoro
 * and Parakeet models now instead of on the first audio. Progress and the final
 * result show on the Composer's speech-setup notice (same channel as the
 * on-demand download); here only the item's own state: installed / installing /
 * error. Mounted when the menu opens, so the status is read fresh each time.
 */
export function VoiceInstallItem(): React.JSX.Element | null {
  const [installed, setInstalled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    void window.api
      ?.voiceInstallStatus?.()
      .then((s) => {
        if (!alive.current) return
        setInstalled(s.installed)
        if (s.installing) setBusy(true)
      })
      .catch(() => undefined)
    return () => {
      alive.current = false
    }
  }, [])

  if (typeof window.api?.voiceInstall !== 'function') return null

  const install = async (): Promise<void> => {
    if (running.current || installed) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.voiceInstall()
      if (!alive.current) return
      if (r.ok) setInstalled(true)
      else setError(r.error || 'Não consegui instalar a voz e a transcrição.')
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }

  return (
    <>
      <div className="mic-menu-label">Voz neste computador</div>
      <button
        className="mic-item voice-install"
        onClick={() => void install()}
        disabled={busy || installed}
        aria-disabled={busy || installed}
        title="Baixa a voz (Kokoro) e a transcrição (Parakeet) agora, em vez de esperar o primeiro áudio"
      >
        <span className="mic-check">{installed ? '✓' : ''}</span>
        {installed ? 'Voz e transcrição instaladas' : busy ? 'Instalando voz e transcrição…' : 'Instalar voz e transcrição'}
      </button>
      {error && (
        <div className="mic-menu-label" role="alert">
          {error}
        </div>
      )}
    </>
  )
}
