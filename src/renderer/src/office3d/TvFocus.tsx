/**
 * O foco DENTRO da TV (dec-clique-tv): o que estava na tela no clique, encaixado
 * na TV pela âncora do motor (a mesma homografia do monitor; no voo, sem clique).
 *
 *   mockup  a página viva no iframe isolado (protocolo agent-mockup, sandbox só
 *           com scripts: origem opaca, sem popup, sem navegar o app, sem
 *           formulário) e, embaixo, Aprovar / Pedir ajuste — um envio normal para
 *           a conversa do agente ("Aprovado: <arquivo>" / "Ajustes no <arquivo>:
 *           <texto>"); responder fecha o foco. Fechar sem responder não manda nada;
 *   test    o espelho da TV (os quadros com a barra de URL), ao vivo;
 *   plan    a Tela de Planejamento inteira (o PlanningWorkspace da conversa do
 *           plano, que o App monta), interativa; abas para trocar de plano;
 *   score   o espelho do placar.
 *
 * "+N esperando" no alto quando a sala tem fila. Desmontar solta o espelho e o
 * iframe (nada fica vivo fora do foco).
 */
import './tvFocus.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MockupUrlResult } from '@shared/officeMockup'
import type { Projectors, TvFocusInfo } from './projectors'
import { PROJ_H, PROJ_W } from './projectorPaint'

export interface TvFocusProps {
  info: TvFocusInfo
  projectors: Pick<Projectors, 'mirror'>
  onClose: () => void
  /** Manda o texto para a conversa (o mesmo envio do chat). Sem ele, sem a faixa de resposta. */
  onSend?: (convId: string, text: string) => void
  /** O endereço do mockup no protocolo (window.api; injetável nos testes). */
  mockupUrl?: (req: { cwd: string; path: string }) => Promise<MockupUrlResult>
  /** A Tela de Planejamento da conversa ativa (o foco de um plano a mostra quando a ativa é a dele). */
  planning?: ReactNode
  /** A conversa ativa (o plano em foco vira a ativa para o chat do Manager ser o dele). */
  activeConvId?: string | null
  /** Troca o plano pelas abas. */
  onPickPlan?: (convId: string) => void
}

const MIRROR_SCALE = 2

function defaultMockupUrl(req: { cwd: string; path: string }): Promise<MockupUrlResult> {
  const api = (window as { api?: { officeMockupUrl?: (r: typeof req) => Promise<MockupUrlResult> } }).api
  return api?.officeMockupUrl ? api.officeMockupUrl(req) : Promise.resolve({ ok: false, error: 'fora do app' })
}

function Mirror({ roomId, projectors }: { roomId: string; projectors: TvFocusProps['projectors'] }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    projectors.mirror(roomId, canvas)
    return () => projectors.mirror(roomId, null)
  }, [roomId, projectors])
  return <canvas ref={ref} className="tvf-mirror" width={PROJ_W * MIRROR_SCALE} height={PROJ_H * MIRROR_SCALE} data-testid="tv-focus-mirror" />
}

function Mockup({ info, onSend, mockupUrl }: { info: Extract<TvFocusInfo, { kind: 'mockup' }>; onSend?: TvFocusProps['onSend']; mockupUrl: NonNullable<TvFocusProps['mockupUrl']> }): JSX.Element {
  const [url, setUrl] = useState<MockupUrlResult | null>(null)
  const [asking, setAsking] = useState(false)
  const [text, setText] = useState('')
  useEffect(() => {
    let live = true
    void mockupUrl({ cwd: info.cwd, path: info.path }).then((r) => live && setUrl(r))
    return () => {
      live = false
    }
  }, [info.cwd, info.path, mockupUrl])
  const send = (msg: string): void => onSend?.(info.convId, msg)
  return (
    <>
      <div className="tvf-page">
        {url?.ok ? (
          <iframe className="tvf-frame" sandbox="allow-scripts" referrerPolicy="no-referrer" src={url.url} title={info.rel} data-testid="tv-focus-iframe" />
        ) : (
          <div className="tvf-empty">{url ? `Não deu para abrir ${info.rel}: ${url.error}` : `Abrindo ${info.rel}…`}</div>
        )}
      </div>
      {onSend ? (
        <div className="tvf-reply" data-testid="tv-focus-reply">
          {asking ? (
            <form
              className="tvf-ask"
              onSubmit={(e) => {
                e.preventDefault()
                if (text.trim()) send(`Ajustes no ${info.rel}: ${text.trim()}`)
              }}
            >
              <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={`O que ajustar em ${info.rel}?`} aria-label="Ajustes" />
              <button type="submit" disabled={!text.trim()}>
                Enviar
              </button>
              <button type="button" className="tvf-ghost" onClick={() => setAsking(false)}>
                Cancelar
              </button>
            </form>
          ) : (
            <>
              <span className="tvf-file">{info.rel}</span>
              <button type="button" className="tvf-approve" onClick={() => send(`Aprovado: ${info.rel}`)}>
                Aprovar
              </button>
              <button type="button" onClick={() => setAsking(true)}>
                Pedir ajuste
              </button>
            </>
          )}
        </div>
      ) : null}
    </>
  )
}

export function TvFocus({ info, projectors, onClose, onSend, mockupUrl = defaultMockupUrl, planning, activeConvId, onPickPlan }: TvFocusProps): JSX.Element {
  const title =
    info.kind === 'mockup' ? `${info.agent} · ${info.rel}` : info.kind === 'test' ? `${info.agent} · ${info.title || info.url}` : info.kind === 'plan' ? 'Planejamento' : 'Placar do escritório'
  return (
    <div className="tvf" data-testid="tv-focus" data-kind={info.kind}>
      <div className="tvf-bar">
        <span className="tvf-title">{title}</span>
        {info.kind === 'plan' && info.plans.length > 1 ? (
          <span className="tvf-tabs" role="tablist" aria-label="Planos">
            {info.plans.map((p) => (
              <button key={p.convId} type="button" role="tab" aria-selected={p.convId === info.convId} className={p.convId === info.convId ? 'on' : ''} onClick={() => onPickPlan?.(p.convId)}>
                {p.title}
              </button>
            ))}
          </span>
        ) : null}
        {info.waiting > 0 ? <span className="tvf-waiting">+{info.waiting} esperando</span> : null}
        <button type="button" className="tvf-close" onClick={onClose} aria-label="Fechar a TV" title="Fechar (Esc)">
          ×
        </button>
      </div>
      {info.kind === 'mockup' ? (
        <Mockup info={info} onSend={onSend} mockupUrl={mockupUrl} />
      ) : info.kind === 'plan' ? (
        <div className="tvf-plan" data-testid="tv-focus-plan">
          {planning && activeConvId === info.convId ? planning : <div className="tvf-empty">Abrindo o planejamento…</div>}
        </div>
      ) : (
        <Mirror roomId={info.roomId} projectors={projectors} />
      )}
    </div>
  )
}
