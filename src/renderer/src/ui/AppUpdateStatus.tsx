/**
 * Rodapé do menu de Configurações: "Versão X · Verificar agora · <estado da
 * atualização>". O estado vem do main pelo `useAppUpdate`; "Verificar agora"
 * fica travado enquanto há verificação, download ou instalação em curso.
 */
import { useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/ipc'
import { useAppUpdate } from '../components/useAppUpdate'
import { useUI } from './UiProvider'

const TICK_MS = 30_000

/** Tempo decorrido em português curto: "há 12 min", "há 3 h", "há 2 dias". */
export function fmtAgo(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 60_000) return 'agora há pouco'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  return d === 1 ? 'há 1 dia' : `há ${d} dias`
}

/** Uma linha de estado para Configurações. */
export function describeUpdate(s: AppUpdateState, nowMs: number): string {
  const v = s.version ?? 'nova versão'
  switch (s.phase) {
    case 'verificando':
      return 'Verificando…'
    case 'baixando':
      return s.percent == null ? `Baixando ${v}…` : `Baixando ${v}… ${Math.round(s.percent)}%`
    case 'pronta':
      return `${v} pronta para instalar`
    case 'agendada':
      return 'Agendada: instala quando os agentes terminarem'
    case 'instalando':
      return `Instalando ${v}…`
    case 'erro':
      return `Não foi possível verificar: ${s.error ?? 'erro sem mensagem'}`
    default:
      return s.checkedAt ? `Última verificação ${fmtAgo(s.checkedAt, nowMs)}` : 'Ainda não verificado'
  }
}

const BUSY: ReadonlySet<AppUpdateState['phase']> = new Set(['verificando', 'baixando', 'instalando'])

export function AppUpdateStatus({ appVersion }: { appVersion: string }): JSX.Element {
  const { notify } = useUI()
  const { state, checkNow } = useAppUpdate({ onError: (m) => notify('erro', m) })
  const [now, setNow] = useState(() => Date.now())

  // "há N min" precisa andar com o relógio enquanto o modal está aberto.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="settings-nav-version update-status">
      <span>Versão {appVersion}</span>
      <button type="button" className="update-status-check" disabled={BUSY.has(state.phase)} onClick={() => void checkNow()}>
        Verificar agora
      </button>
      <span className={`update-status-state${state.phase === 'erro' ? ' err' : ''}`} aria-live="polite">
        {describeUpdate(state, now)}
      </span>
    </div>
  )
}
