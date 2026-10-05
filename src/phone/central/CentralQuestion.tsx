/**
 * Pergunta/permissão viva de um destino, na cor dele. Uma pergunta de escolha
 * única: o toque responde. Várias perguntas ou múltipla escolha: marca e
 * "Responder". Permissão: o que a ferramenta quer fazer, e Negar / Permitir. A
 * resposta vai com o convId DO DESTINO.
 */
import type { AskQuestion, PermissionRequest } from '@shared/ipc'
import type { RemoteCentralQuestion } from '@shared/central'
import { describeTool } from '@renderer/components/toolDescribe'
import { useStore } from '../core/store'
import { answerDestination } from './centralActions'
import { centralUi } from './centralStore'
import { colorVar, openDestination, WaitLine } from './CentralEntries'

export function CentralQuestion({ q }: { q: RemoteCentralQuestion }): JSX.Element {
  const req = q.request
  const asks = Array.isArray(req.questions) && req.questions.length ? req.questions : null
  const busy = useStore(centralUi, (s) => !!s.busy['q:' + req.id])
  return (
    <div className="c-q" style={colorVar(q.color)}>
      <div className="c-who">{q.who + (asks ? ' pergunta' : ' pede permissão')}</div>
      {asks ? <Options q={q} req={req} asks={asks} busy={busy} /> : <PermissionAsk q={q} req={req} busy={busy} />}
      {busy && <WaitLine text="respondendo…" />}
      <button type="button" className="c-open" onClick={() => openDestination({ convId: q.convId })}>abrir</button>
    </div>
  )
}

function Options({ q, req, asks, busy }: { q: RemoteCentralQuestion; req: PermissionRequest; asks: AskQuestion[]; busy: boolean }): JSX.Element {
  const key = q.convId + ':' + req.id
  const simple = asks.length === 1 && !asks[0].multiSelect
  const picks = useStore(centralUi, (s) => s.picks[key]) ?? asks.map(() => [] as string[])
  const pick = (qi: number, label: string, multi: boolean): void => {
    const next = picks.map((p, i) => {
      if (i !== qi) return p
      if (multi) return p.includes(label) ? p.filter((x) => x !== label) : [...p, label]
      return p.includes(label) ? [] : [label]
    })
    centralUi.set((s) => ({ picks: { ...s.picks, [key]: next } }))
  }
  return (
    <>
      {asks.map((a, qi) => (
        <div key={qi}>
          <div className="c-q-title">{a.question}</div>
          <div className="c-opts">
            {(Array.isArray(a.options) ? a.options : []).map((o) => (
              <button
                key={o.label}
                type="button"
                className={`c-opt${picks[qi]?.includes(o.label) ? ' picked' : ''}`}
                disabled={busy}
                onClick={() =>
                  simple
                    ? answerDestination(q, req, 'allow', [{ header: a.header, question: a.question, selected: [o.label] }])
                    : pick(qi, o.label, a.multiSelect)
                }
              >
                <span className="c-opt-label">{o.label}</span>
                {o.description && <span className="c-opt-sub">{o.description}</span>}
              </button>
            ))}
          </div>
        </div>
      ))}
      {!simple && (
        <div className="c-q-actions">
          <button
            type="button"
            className="c-btn primary"
            disabled={busy || picks.some((p) => !p?.length)}
            onClick={() => answerDestination(q, req, 'allow', asks.map((a, qi) => ({ header: a.header, question: a.question, selected: (picks[qi] ?? []).slice() })))}
          >
            Responder
          </button>
        </div>
      )}
    </>
  )
}

function PermissionAsk({ q, req, busy }: { q: RemoteCentralQuestion; req: PermissionRequest; busy: boolean }): JSX.Element {
  const input = (req.input || {}) as Record<string, unknown>
  const name = String(req.toolName || 'ferramenta')
  const info = describeTool(name, input)
  const code = [input.command, input.url, input.pattern, input.query].find((v) => typeof v === 'string' && v) as string | undefined
  return (
    <>
      <div className="c-q-title">
        quer usar <b>{/^mcp__/.test(name) ? name.replace(/^mcp__[^_]+__/, '') : info.verb}</b>
        {info.detail ? ` ${info.detail}` : ''}
      </div>
      {code && <div className="c-q-code">{code}</div>}
      {typeof input.description === 'string' && input.description && <div className="c-q-desc">{input.description}</div>}
      <div className="c-q-actions">
        <button type="button" className="c-btn" disabled={busy} onClick={() => answerDestination(q, req, 'deny')}>Negar</button>
        <button type="button" className="c-btn primary" disabled={busy} onClick={() => answerDestination(q, req, 'allow')}>Permitir</button>
      </div>
    </>
  )
}
