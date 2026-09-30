import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import {
  DEFAULT_WHISPER_MODEL,
  WHISPER_MODEL_OPTIONS,
  type AppConfig,
  type WhisperModelId,
  type WhisperStatus
} from '@shared/ipc'

interface Props {
  cfg: AppConfig
  setCfg: Dispatch<SetStateAction<AppConfig>>
  loaded: boolean
}

const gb = (mb: number): string => (mb >= 1000 ? `${(mb / 1024).toFixed(1).replace('.', ',')} GB` : `${mb} MB`)

/**
 * Modelo do Whisper local (Configurações › Voz) e onde ele está rodando. A
 * troca vale no próximo ditado, sem reiniciar: o motor lê a config a cada
 * chamada e descarrega o modelo anterior.
 */
export function WhisperModelPicker({ cfg, setCfg, loaded }: Props): JSX.Element {
  const [status, setStatus] = useState<WhisperStatus | null>(null)
  const model = cfg.voice.whisperModel ?? DEFAULT_WHISPER_MODEL
  const option = WHISPER_MODEL_OPTIONS.find((m) => m.id === model) ?? WHISPER_MODEL_OPTIONS[0]

  useEffect(() => {
    let alive = true
    void window.api
      .voiceStatus()
      .then((s) => alive && setStatus(s))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  // O dispositivo informado é do modelo que rodou por último; outro modelo
  // escolhido agora ainda não rodou.
  const running = status && status.model === model && status.label ? status : null
  const sizes =
    option.sizeMb.gpu === option.sizeMb.cpu
      ? `~${gb(option.sizeMb.cpu)}`
      : `~${gb(option.sizeMb.gpu)} com GPU, ~${gb(option.sizeMb.cpu)} só na CPU`

  return (
    <>
      {/* Mesmo formato do seletor do Parakeet logo acima: select solto no campo. */}
      <select
        className="settings-input"
        aria-label="Modelo do Whisper"
        value={model}
        disabled={!loaded}
        data-testid="whisper-model"
        onChange={(e) => setCfg((c) => ({ ...c, voice: { ...c.voice, whisperModel: e.target.value as WhisperModelId } }))}
      >
        {WHISPER_MODEL_OPTIONS.map((m) => (
          <option key={m.id} value={m.id}>
            {`Whisper ${m.label} — ${m.note}`}
          </option>
        ))}
      </select>
      <span className="settings-hint" data-testid="whisper-device">
        {running
          ? `Rodando em: ${running.label}${running.gpuError ? ` (GPU indisponível: ${running.gpuError})` : ''}.`
          : 'Aceleração: tenta a GPU primeiro e cai para a CPU se ela não servir; aparece aqui depois do primeiro ditado.'}
      </span>
      <span className="settings-hint">
        {`Na primeira vez que você falar, o app baixa este modelo (${sizes}) e mostra o progresso. O áudio nunca sai deste computador.`}
      </span>
    </>
  )
}
