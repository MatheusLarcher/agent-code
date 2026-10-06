/**
 * O que a barra de tarefas do monitor abre por cima da tela: o menu do Agent (o
 * "Iniciar"), a prévia de um app (mouse parado no botão dele), os avisos estilo
 * Windows, a bandeja (contexto ocupado, bateria do escritório, relógio do turno)
 * e a dica de primeira vez. Só apresentação: os dados vêm do CodeMonitor.
 */
import type { ReactNode } from 'react'
import { modelDisplayName } from '@shared/modelLabel'
import type { ContextTurnModel } from '@shared/contextSnapshot'
import { Icon } from './icons'
import { clock, fmtElapsed, fmtUsd } from './monitorStatus'
import type { MonitorApp } from './monitorPrefs'
import { AppIcon, APP_LABEL } from './Taskbar'
import type { MonitorToast } from './useMonitorToasts'

/** "62,4 mil" / "1 mi" (a janela de 1M não vira "1000,0 mil"). */
const mil = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')} mi` : `${(n / 1000).toFixed(1).replace('.', ',')} mil`
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Os modelos do turno, somando as chamadas de cada um em todos os nós, na ordem. */
export function callsByModel(models: readonly ContextTurnModel[]): Array<{ model: string; calls: number }> {
  const out: Array<{ model: string; calls: number }> = []
  for (const m of models) {
    const at = out.find((x) => x.model === m.model)
    if (at) at.calls += m.calls
    else out.push({ model: m.model, calls: m.calls })
  }
  return out
}

export interface StartMenuProps {
  name: string
  model: string
  effort: string
  /** null: ainda não se sabe (lendo); []: nenhuma resposta ainda. */
  turnModels: Array<{ model: string; calls: number | null }> | null
  conversation: string
  project: string
  busy: boolean
  needsYou: boolean
  mood: string
  elapsed: number | null
  context: { used: number; max: number; pct: number }
  outputTokens: number | null
  costUsd: number | null
  onCopyContext: () => void
  onOpenInApp?: () => void
}

export function StartMenu(p: StartMenuProps): JSX.Element {
  const sub = [modelDisplayName(p.model), p.effort ? `esforço ${p.effort.toLowerCase()}` : ''].filter(Boolean).join(' · ')
  return (
    <div className="cm-startmenu" role="dialog" aria-label="Menu do Agent">
      <div className="cm-sm-h">
        <span className={`cm-avatar big${p.busy ? ' busy' : ''}`}>
          <Icon name="bot" />
        </span>
        <div>
          <div className="cm-sm-name">{p.name}</div>
          <div className="cm-sm-sub">{sub || 'modelo ainda não conhecido'}</div>
        </div>
      </div>
      <div className="cm-sm-mood">{p.mood}</div>
      <dl className="cm-sm-grid">
        <dt>Conversa</dt>
        <dd>{p.conversation || '—'}</dd>
        <dt>Modelos do turno</dt>
        <dd>
          {p.turnModels === null
            ? 'lendo…'
            : p.turnModels.length === 0
              ? 'nenhuma resposta ainda'
              : p.turnModels.map((m) => (
                  <span key={m.model} className="cm-sm-model" title={m.model}>
                    {modelDisplayName(m.model) || m.model}
                    {m.calls !== null ? ` · ${plural(m.calls, 'chamada', 'chamadas')}` : ''}
                  </span>
                ))}
        </dd>
        <dt>Projeto</dt>
        <dd>{p.project || '—'}</dd>
        <dt>{p.busy ? 'Trabalhando há' : 'O turno levou'}</dt>
        <dd>{fmtElapsed(p.elapsed)}</dd>
        <dt>Contexto</dt>
        <dd>
          {mil(p.context.used)} de {mil(p.context.max)}
          <div className="cm-meter" aria-hidden="true">
            <i style={{ width: `${p.context.pct}%` }} />
          </div>
        </dd>
        <dt>Gerado no turno</dt>
        <dd>{p.outputTokens === null ? '—' : `${mil(p.outputTokens)} tokens`}</dd>
        <dt>Custo do turno</dt>
        <dd>{fmtUsd(p.costUsd)}</dd>
      </dl>
      <div className="cm-sm-acts">
        <button type="button" className="cm-btn pri" onClick={p.onCopyContext}>
          <Icon name="copy" />
          Copiar contexto
        </button>
        {p.onOpenInApp && (
          <button type="button" className="cm-btn" onClick={p.onOpenInApp}>
            <Icon name="msg" />
            Abrir no app
          </button>
        )}
      </div>
    </div>
  )
}

export function AppPreview({ app, left, children }: { app: MonitorApp; left: number; children: ReactNode }): JSX.Element {
  return (
    <div className="cm-taskpreview" style={{ left: `${left}px` }} aria-hidden="true">
      <div className="cm-pv-t">
        <AppIcon app={app} size={16} />
        {APP_LABEL[app]}
      </div>
      <div className="cm-pv-l">{children}</div>
    </div>
  )
}

export function Toasts({ toasts, onOpen }: { toasts: readonly MonitorToast[]; onOpen: (t: MonitorToast) => void }): JSX.Element {
  return (
    <div className="cm-toasts" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`cm-toast ${t.kind}${t.leaving ? ' leaving' : ''}`} onClick={() => onOpen(t)}>
          <span className="cm-toast-ic">
            <Icon name={t.icon} />
          </span>
          <span>
            <b>{t.title}</b>
            <span>{t.body}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export interface TrayProps {
  context: { used: number; max: number; pct: number }
  /** Bateria do escritório (energia do plano, %); null sem leitura. */
  battery: number | null
  busy: boolean
  needsYou: boolean
  /** Segundos do turno (trabalhando) ou null. */
  elapsed: number | null
  now: Date
}

export function Tray(p: TrayProps): JSX.Element {
  const C = 2 * Math.PI * 7
  return (
    <>
      <span className="cm-ti" title={`Contexto ocupado: ${mil(p.context.used)} de ${mil(p.context.max)} tokens`}>
        <svg className="cm-g" viewBox="0 0 18 18" aria-hidden="true">
          <circle cx="9" cy="9" r="7" fill="none" stroke="#4a4a4e" strokeWidth="2.5" />
          <circle
            cx="9" cy="9" r="7" fill="none" stroke="var(--cm-agent)" strokeWidth="2.5" strokeLinecap="round" transform="rotate(-90 9 9)"
            strokeDasharray={`${((C * p.context.pct) / 100).toFixed(1)} ${C.toFixed(1)}`}
          />
        </svg>
        {p.context.pct}%
      </span>
      {p.battery !== null && (
        <span className="cm-ti" title={`Bateria do escritório (o que ainda resta no plano): ${p.battery}%`}>
          <svg className="cm-g" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="2.5" y="7" width="17" height="10" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M21.5 10.5v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <rect x="4.5" y="9" width={((13 * p.battery) / 100).toFixed(1)} height="6" rx="1" fill={p.battery > 20 ? '#3fb950' : '#f85149'} />
          </svg>
          {p.battery}%
        </span>
      )}
      <span className="cm-ti cm-clock" title={p.busy ? 'Tempo deste turno' : 'Agora'}>
        {p.busy && p.elapsed !== null ? clock(p.elapsed) : `${String(p.now.getHours()).padStart(2, '0')}:${String(p.now.getMinutes()).padStart(2, '0')}`}
        <small>{p.needsYou ? 'esperando você' : p.busy ? 'trabalhando' : 'parado'}</small>
      </span>
    </>
  )
}

export function Coach({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="cm-coach">
      Leve o mouse até a borda de baixo para abrir a barra
      <button type="button" className="cm-coach-x" aria-label="Fechar a dica" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  )
}
