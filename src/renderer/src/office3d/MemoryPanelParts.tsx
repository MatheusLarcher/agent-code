/**
 * As peças do painel de Memórias (MemoryPanel.tsx): a linha do uso, a linha da
 * memória com a barrinha dos 7 dias e o texto de uma memória (só leitura), com
 * o "Mostrar na pasta" no PC.
 */
import { useState } from 'react'
import { principalKey } from '../office/adapter/model'
import { Markdown } from '../components/Markdown'
import { ReadRetry } from '../components/ReadRetry'
import { seedCss } from './appearance'
import type { MemoryRow, UsageEvent, UsageHow } from './memoryUsage'

export const HOW_LABEL: Record<UsageHow, string> = {
  escolhida: 'escolhida pelo app',
  lida: 'lida',
  gravada: 'gravada',
  atualizada: 'atualizada',
  aposentada: 'aposentada'
}

export const SCOPE_LABEL: Record<MemoryRow['scope'], string> = { user: 'do usuário', project: 'do projeto', domain: 'de domínio' }

const projectName = (cwd: string): string => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd

/** "há 5 min", "ontem 14:02", "3 de out." */
export function when(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const d = new Date(at)
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (min < 24 * 60 && new Date(now).getDate() === d.getDate()) return `hoje ${hh}`
  if (min < 48 * 60) return `ontem ${hh}`
  return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' })
}

/** A linha do uso. Com `onOpen` (a memória existe na lista), o nome dela abre o texto. `dot`: a cor do agente (a do projeto); sem ela, a seed. */
export function UsageLine({ e, title, now, dot, onAgent, onOpen }: { e: UsageEvent; title: string; now: number; dot?: string; onAgent: (convId: string) => void; onOpen?: (relPath: string) => void }): JSX.Element {
  const rel = e.relPath
  return (
    <li className="mp-use" data-testid="mp-use">
      <button type="button" className="mp-agent" onClick={() => onAgent(e.convId)} title="Levar a câmera até o agente">
        <span className="mp-dot" style={{ background: dot ?? seedCss(principalKey(e.convId)) }} />
        {e.agent}
      </button>
      <span className="mp-use-what">
        {rel && onOpen ? (
          <button type="button" className="mp-link mp-use-name" onClick={() => onOpen(rel)} title="Ler a memória">
            {title}
          </button>
        ) : (
          <b>{title}</b>
        )}{' '}
        · {HOW_LABEL[e.how]}
      </span>
      <span className="mp-use-meta">
        {projectName(e.project)} · {when(e.at, now)}
      </span>
    </li>
  )
}

export function MemoryLine({ r, now, onOpen }: { r: MemoryRow; now: number; onOpen: (relPath: string) => void }): JSX.Element {
  const peak = Math.max(1, ...r.week)
  return (
    <li>
      <button type="button" className={`mp-mem${r.status === 'retired' ? ' retired' : ''}`} onClick={() => onOpen(r.relPath)} data-testid="mp-mem">
        <span className="mp-mem-title">{r.title}</span>
        <span className="mp-mem-hook">{r.hook}</span>
        <span className="mp-mem-meta">
          {SCOPE_LABEL[r.scope]} · atualizada {when(Date.parse(r.updatedAt), now)} · {r.uses ? `${r.uses} uso${r.uses === 1 ? '' : 's'}` : 'nunca usada'}
          {r.status === 'retired' ? ' · aposentada' : ''}
        </span>
        <span className="mp-week" aria-label={`Uso nos últimos 7 dias: ${r.week.join(', ')}`}>
          {r.week.map((n, i) => (
            <i key={i} style={{ height: `${Math.round((n / peak) * 100)}%` }} />
          ))}
        </span>
      </button>
    </li>
  )
}

export interface MemoryDetailProps {
  r: MemoryRow
  body: string | null
  /** O corpo não abriu (falha ou prazo): "tentar de novo" em vez de "Abrindo…". */
  bodyError?: unknown
  onRetryBody?: () => void
  uses: readonly UsageEvent[]
  now: number
  onBack: () => void
  onOpenConversation: (convId: string) => void
  /** "Mostrar na pasta": o Explorador com o .md selecionado. Ausente (celular): sem o botão. */
  onReveal?: () => Promise<{ ok: boolean; message: string }>
}

export function MemoryDetail({ r, body, bodyError, onRetryBody, uses, now, onBack, onOpenConversation, onReveal }: MemoryDetailProps): JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const reveal = async (): Promise<void> => {
    setNote(null)
    const res = await onReveal?.().catch(() => ({ ok: false, message: 'Não deu para abrir a pasta.' }))
    if (res && !res.ok) setNote(res.message)
  }
  return (
    <div className="mp-detail" data-testid="mp-detail">
      <div className="mp-detail-bar">
        <button type="button" className="mp-back" onClick={onBack}>
          ← Todas as memórias
        </button>
        {onReveal && (
          <button type="button" className="mp-reveal" onClick={() => void reveal()} title="Abrir o Explorador na pasta da memória, com o arquivo selecionado">
            Mostrar na pasta
          </button>
        )}
      </div>
      {note && (
        <p className="mp-note" role="alert">
          {note}
        </p>
      )}
      <h3>{r.title}</h3>
      <p className="mp-mem-meta">
        {r.relPath} · {SCOPE_LABEL[r.scope]} · revisão {r.revision} · só leitura
      </p>
      <div className="mp-body">
        {body !== null ? (
          <Markdown text={body} />
        ) : bodyError ? (
          <ReadRetry error={bodyError} what="a memória" onRetry={() => onRetryBody?.()} />
        ) : (
          <p>Abrindo…</p>
        )}
      </div>
      <h4 className="mp-h">Onde foi usada</h4>
      {uses.length === 0 ? <p className="mp-empty">Nenhum uso registrado.</p> : null}
      <ul className="mp-list">
        {uses.slice(0, 30).map((e, i) => (
          <li key={i} className="mp-use">
            <button type="button" className="mp-link" onClick={() => onOpenConversation(e.convId)}>
              {e.agent}
            </button>
            <span className="mp-use-meta">
              {HOW_LABEL[e.how]} · {when(e.at, now)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
