/**
 * Card "Voz": o modelo de ditado no próprio celular (Parakeet v3, offline). Só
 * aparece no app instalado com o plugin. Sem o modelo, o áudio vai ao PC.
 */
import { useEffect } from 'react'
import { useStore } from '../core/store'
import { cancelSttInstall, installStt, refreshStt, removeStt, setUsePc, stt } from '../voice/localStt'

const mb = (n: number): string => Math.round(n / (1024 * 1024)) + ' MB'

export function VoiceCard(): JSX.Element | null {
  const s = useStore(stt, (x) => x)
  useEffect(() => void refreshStt(), [])
  if (!s.available) return null
  const status = s.installing
    ? `Baixando e instalando… ${s.progress}%`
    : s.installed
      ? `Instalado (${mb(s.bytes)})`
      : s.error
        ? `Falhou: ${s.error}`
        : 'Não instalado (download de ~490 MB)'
  return (
    <section className="cfg-card cfg-voice">
      <div className="cfg-card-title">Voz</div>
      <span className="cfg-desc">Transcreve o que você fala no próprio celular (Parakeet v3, offline). Só o texto vai ao PC; sem o modelo, o áudio vai para o PC.</span>
      <div className="cfg-row"><span className="cfg-k">Modelo</span><span className="cfg-v">{status}</span></div>
      {s.installing && (
        <div className="voice-progress"><span style={{ width: `${s.progress}%` }} /></div>
      )}
      <div className="cfg-row"><span className="cfg-k">Transcrição em</span><span className="cfg-v">{s.usePc ? 'PC' : s.installed ? 'Celular · CPU' : 'PC (até instalar)'}</span></div>
      <div className="cfg-row"><span className="cfg-k">Processador</span><span className="cfg-v">{s.soc || '—'}</span></div>
      {!s.installed && !s.installing && (
        <button type="button" className="cfg-btn" onClick={() => void installStt().catch(() => undefined)}>
          {s.error ? 'Tentar de novo' : 'Instalar modelo'}
        </button>
      )}
      {s.installing && <button type="button" className="cfg-btn" onClick={() => void cancelSttInstall()}>Cancelar</button>}
      {s.installed && !s.installing && (
        <button
          type="button"
          className="cfg-exit"
          onClick={() => {
            if (window.confirm('Remover o modelo de voz do celular? A transcrição volta a ser feita no PC.')) void removeStt()
          }}
        >
          Remover modelo
        </button>
      )}
      <label className="cfg-switch-row">
        <span className="cfg-switch-text">
          <strong>Transcrever no PC</strong>
          <span className="cfg-desc">Ignora o modelo do celular e envia o áudio ao PC.</span>
        </span>
        <input className="cfg-switch-input" type="checkbox" checked={s.usePc} onChange={(e) => setUsePc(e.currentTarget.checked)} />
        <span className="cfg-switch-visual" aria-hidden="true" />
      </label>
    </section>
  )
}
