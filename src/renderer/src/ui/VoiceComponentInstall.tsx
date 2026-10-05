import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechSetupProgress, VoiceComponent, VoiceInstallStatus, VoiceSelfTest } from '@shared/ipc'

interface Props {
  component: VoiceComponent
  /** Download size shown next to the button ("~1,6 GB"). */
  size?: string
  /** Shows "Testar transcrição" (transcription models only). */
  testable?: boolean
}

const keyOf = (c: VoiceComponent): string => c.kind

const progressText = (p: SpeechSetupProgress): string =>
  `${p.message}${typeof p.percent === 'number' ? ` ${p.percent}%` : ''}${p.totalMb ? ` de ~${p.totalMb} MB` : ''}`

/**
 * Status + "Instalar" (and "Testar transcrição") of one on-device voice model,
 * in Settings › Voz. Installing here is the same download the chat does on the
 * first use; the progress comes on the same speechSetupProgress channel.
 */
export function VoiceComponentInstall({ component, size, testable }: Props): JSX.Element {
  const key = keyOf(component)
  const [status, setStatus] = useState<VoiceInstallStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'test' | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [test, setTest] = useState<VoiceSelfTest | null>(null)
  const alive = useRef(true)
  // `component` is a fresh object each render; `key` identifies it.
  const current = useRef({ key, component })
  current.current = { key, component }

  const refresh = useCallback(async (): Promise<void> => {
    const asked = current.current
    let s: VoiceInstallStatus | null = null
    try {
      s = await window.api.voiceComponentStatus(asked.component)
    } catch {
      /* status unknown: the button stays disabled until a later refresh */
    }
    if (alive.current && current.current.key === asked.key) {
      setStatus(s)
      // A failure remembered by the main process (e.g. the install that failed
      // while Settings was closed) — the component that awaited it is gone.
      if (s?.error) setError(s.error)
    }
  }, [key])

  /** Still mounted and still showing the component the action started for. */
  const stillFor = (k: string): boolean => alive.current && current.current.key === k

  useEffect(() => {
    alive.current = true
    setBusy(null)
    setStatus(null)
    setError(null)
    setTest(null)
    setProgress(null)
    void refresh()
    return () => {
      alive.current = false
    }
  }, [refresh])

  // Progress lines only while something runs here (or the model is already
  // being installed elsewhere, e.g. by the chat).
  const listening = busy !== null || status?.installing === true
  useEffect(() => {
    if (!listening) return
    return window.api.onSpeechSetupProgress((p) => {
      if (!alive.current) return
      if (p.stage === 'done' || p.stage === 'error') {
        setProgress(null)
        void refresh()
      } else setProgress(progressText(p))
    })
  }, [listening, refresh])

  const install = async (): Promise<void> => {
    if (busy) return
    const k = key
    setBusy('install')
    setError(null)
    try {
      const r = await window.api.voiceComponentInstall(component)
      if (stillFor(k) && !r.ok) setError(r.error || 'Não consegui instalar.')
    } catch (err) {
      if (stillFor(k)) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (stillFor(k)) {
        setBusy(null)
        setProgress(null)
        void refresh()
      }
    }
  }

  const runTest = async (): Promise<void> => {
    if (busy) return
    const k = key
    setBusy('test')
    setError(null)
    setTest(null)
    try {
      const r = await window.api.voiceTestTranscription(component)
      if (stillFor(k)) setTest(r)
    } catch (err) {
      if (stillFor(k)) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (stillFor(k)) {
        setBusy(null)
        setProgress(null)
        void refresh()
      }
    }
  }

  const installed = status?.installed === true
  const installing = busy === 'install' || status?.installing === true
  const label = installing ? 'Instalando…' : installed ? 'Instalado' : 'Instalar'

  return (
    <div className="settings-install" data-testid={`voice-install-${key}`}>
      <div className="settings-install-row">
        <span className={`settings-install-status${installed ? ' ok' : ''}`} data-testid="voice-install-status">
          {status === null ? 'Verificando…' : installed ? 'Instalado neste computador' : 'Não instalado'}
          {size && !installed ? ` · ${size}` : ''}
        </span>
        <button
          type="button"
          className="btn"
          disabled={busy !== null || installing || status === null || installed}
          onClick={() => void install()}
        >
          {label}
        </button>
        {testable && (
          <button type="button" className="btn ghost" disabled={busy !== null || installing} onClick={() => void runTest()}>
            {busy === 'test' ? 'Testando…' : 'Testar transcrição'}
          </button>
        )}
      </div>
      {progress && <span className="settings-hint" role="status">{progress}</span>}
      {error && (
        <span className="settings-hint settings-install-error" role="alert">
          {error}
        </span>
      )}
      {test && (
        <span className={`settings-hint ${test.ok ? 'settings-install-pass' : 'settings-install-error'}`} role="status" data-testid="voice-test-result">
          {test.error
            ? `Teste falhou: ${test.error}`
            : `${test.ok ? 'Funcionando' : 'Transcrição diferente do esperado'} — falei “${test.expected}”, ouvi “${test.heard || '(nada)'}”.`}
        </span>
      )}
    </div>
  )
}
