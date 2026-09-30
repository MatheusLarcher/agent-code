import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { LOCAL_SPEECH_MODELS, VOICE_OPTIONS, VOICE_SPEEDS, type AppConfig, type VoiceId } from '@shared/ipc'
import { useUI } from './UiProvider'

const SAMPLE = 'Olá! Esta é a voz que vai ler as respostas do agente.'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  loaded: boolean
}

/**
 * Aba Voz das Configurações. Tudo roda neste computador — não há chave nem
 * serviço na nuvem: a leitura usa o Kokoro, e o ditado o Whisper local (padrão)
 * ou o Parakeet/Canary em Python. Os modelos são baixados no primeiro uso, com
 * o progresso na faixa acima do campo de mensagem.
 */
export function VoiceSettingsSection({ cfg, setCfg, loaded }: Props): JSX.Element {
  const { notify } = useUI()
  const [testing, setTesting] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => () => audioRef.current?.pause(), [])

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
        <span className="settings-hint">
          A voz roda neste computador (Kokoro), sem chave e sem enviar texto para fora. Na primeira leitura
          o app baixa o modelo de voz (~330 MB) e mostra o progresso; depois funciona sem internet.
        </span>
      </section>

      {/* Onde a fala vira texto. Os dois motores rodam aqui; mudam o peso e o que precisam. */}
      <section className="settings-section">
        <div className="settings-field">
          <span className="settings-field-label">Transcrição do microfone</span>
          <div className="settings-engine-row">
            <button
              type="button"
              className={`settings-engine${cfg.transcribeEngine === 'whisper' ? ' on' : ''}`}
              disabled={!loaded}
              onClick={() => setCfg((c) => ({ ...c, transcribeEngine: 'whisper' }))}
            >
              <strong>Whisper local</strong>
              <span>padrão: roda na CPU, sem instalar nada</span>
            </button>
            <button
              type="button"
              className={`settings-engine${cfg.transcribeEngine === 'local' ? ' on' : ''}`}
              disabled={!loaded}
              onClick={() => setCfg((c) => ({ ...c, transcribeEngine: 'local' }))}
            >
              <strong>Parakeet/Canary (Python)</strong>
              <span>usa a GPU; precisa de um Python com CUDA na máquina</span>
            </button>
          </div>
          {cfg.transcribeEngine === 'local' ? (
            <>
              <select
                className="settings-input"
                value={cfg.localSpeech.model}
                disabled={!loaded}
                onChange={(e) => setCfg((c) => ({ ...c, localSpeech: { model: e.target.value } }))}
              >
                {LOCAL_SPEECH_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {`${m.label} — ${m.note} (~${m.sizeMb} MB)`}
                  </option>
                ))}
              </select>
              <span className="settings-hint">
                Na primeira vez que você falar, o app prepara o ambiente e baixa o modelo, mostrando o
                progresso. Depois disso ele fica salvo e funciona sem internet.
              </span>
            </>
          ) : (
            <span className="settings-hint">
              Na primeira vez que você falar, o app baixa o Whisper (~1 GB) e mostra o progresso. O áudio
              nunca sai deste computador.
            </span>
          )}
        </div>
      </section>
    </>
  )
}
