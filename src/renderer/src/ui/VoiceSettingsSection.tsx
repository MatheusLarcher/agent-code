import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { SPEECH_MODEL_SIZE_MB, VOICE_OPTIONS, VOICE_SPEEDS, type AppConfig, type SpeechStatus, type VoiceId } from '@shared/ipc'
import { VoiceComponentInstall } from './VoiceComponentInstall'
import { useUI } from './UiProvider'

const SAMPLE = 'Olá! Esta é a voz que vai ler as respostas do agente.'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  loaded: boolean
}

/**
 * Aba Voz das Configurações. Tudo roda neste computador — não há chave nem
 * serviço na nuvem: a leitura usa o Kokoro, e o ditado o Parakeet TDT v3 (ONNX,
 * GPU ou CPU). Cada modelo tem "Instalar" aqui; sem isso, é baixado no primeiro
 * uso, com o progresso na faixa acima do campo de mensagem.
 */
export function VoiceSettingsSection({ cfg, setCfg, loaded }: Props): JSX.Element {
  const { notify } = useUI()
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => () => audioRef.current?.pause(), [])
  useEffect(() => {
    let alive = true
    void window.api
      ?.voiceStatus?.()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const running = status?.label ? status : null

  // Toca uma frase com a voz e a velocidade ESCOLHIDAS AGORA (antes de salvar).
  const testVoice = async (): Promise<void> => {
    if (testing) {
      audioRef.current?.pause()
      audioRef.current = null
      setTesting(false)
      return
    }
    setTesting(true)
    try {
      const r = await window.api.speak(SAMPLE, { voice: cfg.voice.voice, speed: cfg.voice.speed })
      if (!r.ok || !r.audioBase64) {
        notify('erro', `Falha ao gerar áudio: ${r.error ?? 'erro'}`)
        setTesting(false)
        return
      }
      const audio = new Audio(`data:${r.mimeType ?? 'audio/wav'};base64,${r.audioBase64}`)
      audioRef.current = audio
      const done = (): void => {
        if (audioRef.current === audio) audioRef.current = null
        setTesting(false)
      }
      audio.onended = done
      audio.onerror = done
      audio.onpause = done
      await audio.play().catch(done)
    } catch (err) {
      notify('erro', `Falha ao gerar áudio: ${err instanceof Error ? err.message : String(err)}`)
      setTesting(false)
    }
  }

  return (
    <>
      <section className="settings-section">
        <span className="settings-field-label">Leitura em voz alta</span>
        <div className="settings-key-row settings-voice-row">
          <label className="settings-field settings-field-inline">
            <span className="settings-field-label">Voz</span>
            <select
              className="settings-input"
              value={cfg.voice.voice}
              disabled={!loaded}
              onChange={(e) => setCfg((c) => ({ ...c, voice: { ...c.voice, voice: e.target.value as VoiceId } }))}
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field settings-field-inline">
            <span className="settings-field-label">Velocidade</span>
            <select
              className="settings-input"
              value={String(cfg.voice.speed)}
              disabled={!loaded}
              onChange={(e) => setCfg((c) => ({ ...c, voice: { ...c.voice, speed: Number(e.target.value) } }))}
            >
              {VOICE_SPEEDS.map((s) => (
                <option key={s.value} value={String(s.value)}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!loaded} onClick={() => void testVoice()}>
            {testing ? 'Parar' : 'Testar voz'}
          </button>
        </div>
        <VoiceComponentInstall component={{ kind: 'tts' }} size="~330 MB" />
        <span className="settings-hint">
          A voz roda neste computador (Kokoro), sem chave e sem enviar texto para fora. Instale aqui ou deixe
          para a primeira leitura no chat, que baixa o modelo sozinha; depois funciona sem internet.
        </span>
      </section>

      {/* Onde a fala vira texto: um modelo só, o Parakeet, rodando aqui. */}
      <section className="settings-section">
        <div className="settings-field">
          <span className="settings-field-label">Transcrição do microfone</span>
          <span className="settings-hint" data-testid="speech-device">
            {running
              ? `Parakeet TDT v3 rodando em: ${running.label}${running.gpuError ? ` (GPU indisponível: ${running.gpuError})` : ''}.`
              : 'Parakeet TDT v3 (NVIDIA), 25 idiomas, português detectado sozinho. Tenta a GPU primeiro e cai para a CPU se ela não servir; aparece aqui depois do primeiro ditado.'}
          </span>
          <VoiceComponentInstall component={{ kind: 'stt' }} size={`~${SPEECH_MODEL_SIZE_MB} MB`} testable />
          <span className="settings-hint">
            Instale aqui ou deixe para a primeira vez que você falar, que baixa o modelo sozinha e mostra o
            progresso. O áudio nunca sai deste computador.
          </span>
        </div>
      </section>
    </>
  )
}
