/**
 * Pedido pendente da conversa aberta (o `permission` do retrato): permissão de
 * ferramenta (Negar / Permitir uma vez / Sempre permitir) ou AskUserQuestion
 * (opções, "Outro…" livre, várias perguntas e múltipla escolha), com a barra da
 * contagem regressiva até a auto-resolução do PC (7 min). A resposta vai por
 * `POST /api/permission-respond`; respondido no PC, o pedido some do retrato e o
 * modal fecha sozinho. O mesmo pedido nunca é redesenhado (apagaria as marcações).
 */
import { useEffect, useRef, useState } from 'react'
import type { PermissionRequest, PermissionResponse } from '@shared/ipc'
import { client, toast } from '../app/runtime'
import { errorText, statusOf } from '../core/net'
import { useStore } from '../core/store'

const OTHER = '__other__'

export function PermissionModal(): JSX.Element | null {
  const convId = useStore(client.store, (s) => s.convId)
  const req = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId)?.permission ?? null)
  const [answered, setAnswered] = useState<string | null>(null)
  if (!req || !convId || answered === req.id) return null
  const respond = (res: Omit<PermissionResponse, 'id'>): void => {
    setAnswered(req.id)
    client.permissionRespond(convId, { id: req.id, ...res }).catch((err) => {
      if (statusOf(err) === 409) return
      setAnswered(null)
      toast('Não foi possível responder: ' + errorText(err))
    })
  }
  return (
    <div className="modal-overlay">
      <div className="modal-card perm-card">
        <Countdown key={`c${req.id}`} deadline={req.deadline} />
        {req.questions?.length ? <Questions key={req.id} req={req} respond={respond} /> : <ToolAsk req={req} respond={respond} />}
      </div>
    </div>
  )
}

function Countdown({ deadline }: { deadline?: number }): JSX.Element | null {
  const bar = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!deadline) return
    const total = Math.max(1, deadline - Date.now())
    const tick = (): void => {
      const remaining = Math.max(0, deadline - Date.now())
      if (bar.current) bar.current.style.transform = `scaleX(${remaining / total})`
    }
    tick()
    const t = setInterval(tick, 250)
    return () => clearInterval(t)
  }, [deadline])
  if (!deadline) return null
  return (
    <div className="perm-countdown">
      <span ref={bar} />
    </div>
  )
}

function ToolAsk({ req, respond }: { req: PermissionRequest; respond: (r: Omit<PermissionResponse, 'id'>) => void }): JSX.Element {
  const name = (req.toolName || '').replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, '')
  const input = req.input || {}
  const detail = ['command', 'url', 'file_path', 'pattern', 'query'].map((k) => input[k]).find((v) => typeof v === 'string' && v) as string | undefined
  return (
    <>
      <div className="perm-body">
        <div className="perm-tool">
          <span>
            O agente quer executar <strong>{name}</strong>
          </span>
        </div>
        {detail && <pre className="perm-code">{detail.slice(0, 600)}</pre>}
        {typeof input.description === 'string' && input.description && <div className="perm-desc">{input.description}</div>}
      </div>
      <div className="perm-actions">
        <button type="button" className="perm-btn-deny" onClick={() => respond({ behavior: 'deny', always: false })}>Negar</button>
        <button type="button" className="perm-btn-allow" onClick={() => respond({ behavior: 'allow', always: false })}>Permitir uma vez</button>
        <button type="button" className="perm-btn-always" onClick={() => respond({ behavior: 'allow', always: true })}>Sempre permitir</button>
      </div>
    </>
  )
}

function Questions({ req, respond }: { req: PermissionRequest; respond: (r: Omit<PermissionResponse, 'id'>) => void }): JSX.Element {
  const qs = req.questions ?? []
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []))
  const [other, setOther] = useState<string[]>(() => qs.map(() => ''))
  const resolved = (qi: number): string[] => {
    const labels = picked[qi].filter((l) => l !== OTHER)
    const text = other[qi].trim()
    return picked[qi].includes(OTHER) && text ? [...labels, text] : labels
  }
  const ready = qs.every((_, qi) => resolved(qi).length > 0)
  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((cur) =>
      cur.map((p, i) => {
        if (i !== qi) return p
        if (multi) return p.includes(label) ? p.filter((x) => x !== label) : [...p, label]
        return p[0] === label ? [] : [label]
      })
    )
  }
  return (
    <>
      <div className="perm-body">
        <div className="perm-questions">
          {qs.map((q, qi) => (
            <div key={qi}>
              {q.header && <div className="perm-q-sub">{q.header}</div>}
              <div className="perm-q-title">{q.question}</div>
              <div className="perm-q-opts">
                {q.options.map((op) => (
                  <button key={op.label} type="button" className={`perm-opt${picked[qi].includes(op.label) ? ' selected' : ''}`} onClick={() => toggle(qi, op.label, q.multiSelect)}>
                    <span>{op.label}</span>
                    {op.description && <span className="perm-opt-desc">{op.description}</span>}
                  </button>
                ))}
                <button type="button" className={`perm-opt${picked[qi].includes(OTHER) ? ' selected' : ''}`} onClick={() => toggle(qi, OTHER, q.multiSelect)}>
                  <span>Outro…</span>
                  <span className="perm-opt-desc">Escrever uma resposta própria</span>
                </button>
              </div>
              {picked[qi].includes(OTHER) && (
                <input
                  type="text"
                  className="perm-other-input"
                  placeholder="Sua resposta"
                  value={other[qi]}
                  onChange={(e) => {
                    const v = e.currentTarget.value
                    setOther((cur) => cur.map((o, i) => (i === qi ? v : o)))
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="perm-actions">
        <button type="button" className="perm-btn-deny" onClick={() => respond({ behavior: 'deny', always: false })}>Cancelar</button>
        <button
          type="button"
          className="perm-btn-submit"
          disabled={!ready}
          onClick={() => respond({ behavior: 'allow', always: false, answers: qs.map((q, qi) => ({ header: q.header, question: q.question, selected: resolved(qi) })) })}
        >
          Responder
        </button>
      </div>
    </>
  )
}
