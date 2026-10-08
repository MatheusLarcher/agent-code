/**
 * O foco DENTRO da TV (dec-clique-tv): o que estava na tela no clique, encaixado
 * na TV pela âncora do motor (a mesma homografia do monitor; no voo, sem clique).
 *
 *   mockup  a página viva no iframe isolado (MockupFrame, o mesmo da Prévia do
 *           monitor: protocolo agent-mockup, sandbox só com scripts — origem
 *           opaca, sem popup, sem navegar o app, sem formulário) e, embaixo,
 *           Aprovar / Pedir ajuste — um envio normal para
 *           a conversa do agente ("Aprovado: <arquivo>" / "Ajustes no <arquivo>:
 *           <texto>"); responder fecha o foco. Fechar sem responder não manda nada;
 *   test    o espelho da TV (os quadros com a barra de URL), ao vivo;
 *   plan    a Tela de Planejamento inteira (o PlanningWorkspace da conversa do
 *           plano, que o App monta), interativa; abas para trocar de plano e,
 *           com agente chamando ou testando (`agents`), a aba "Agente chamando
 *           (N)": o mockup ou o espelho do 1º da fila no lugar do plano — o
 *           chamado só conta como visto quando ela abre (`onSeen`); com envios
 *           para implementação (o centro de Entregas do App, por contexto), a
 *           aba "Implantação · N/M · status" (N/M = etapas prontas do plano,
 *           planProgress com o roteiro do planning:peek — usePlanRoteiro, o
 *           cache da TV —, relida quando o resumo chega; status = o do envio
 *           de agora, planEnvioAtual): o andamento e os botões (TvDeploy);
 *   score   o espelho do placar.
 *
 * "+N esperando" no alto quando a sala tem fila. Desmontar solta o espelho e o
 * iframe (nada fica vivo fora do foco).
 */
import './tvFocus.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDeliveryCenterContext } from '../deliveries/deliveryCenterContext'
import { usePlanRoteiro } from '../handoffTracking/usePlanRoteiro'
import { MockupFrame, type MockupUrlFn } from './MockupFrame'
import { callMarks } from './officeCalls'
import type { Projectors, TvFocusInfo } from './projectors'
import { PROJ_H, PROJ_W } from './projectorPaint'
import { deploySummary, TvDeploy } from './TvDeploy'
import type { PeekApi } from './tvPlans'

export interface TvFocusProps {
  info: TvFocusInfo
  projectors: Pick<Projectors, 'mirror'>
  onClose: () => void
  /** Manda o texto para a conversa (o mesmo envio do chat). Sem ele, sem a faixa de resposta. */
  onSend?: (convId: string, text: string) => void
  /** O endereço do mockup no protocolo (window.api; injetável nos testes). */
  mockupUrl?: MockupUrlFn
  /** A Tela de Planejamento da conversa ativa (o foco de um plano a mostra quando a ativa é a dele). */
  planning?: ReactNode
  /** A conversa ativa (o plano em foco vira a ativa para o chat do Manager ser o dele). */
  activeConvId?: string | null
  /** Troca o plano pelas abas. */
  onPickPlan?: (convId: string) => void
  /** O chamado foi visto (a aba "Agente chamando" abriu o mockup dele); padrão: as marcas do app. */
  onSeen?: (callId: string) => void
  /** "Ir até o agente" da aba Implantação: fecha o foco e voa até a mesa dele; false se ele não está no escritório. */
  onGoToAgent?: (convId: string) => boolean
  /** O resumo do plano (planning:peek) para o roteiro da aba Implantação; injetável nos testes, padrão: window.api. */
  peekApi?: PeekApi | null
}

const MIRROR_SCALE = 2

const markSeen = (callId: string): void => callMarks.end(callId, 'aberto')

function titleOf(info: TvFocusInfo): string {
  if (info.kind === 'mockup') return `${info.agent} · ${info.rel}`
  if (info.kind === 'test') return `${info.agent} · ${info.title || info.url}`
  return info.kind === 'plan' ? 'Planejamento' : 'Placar do escritório'
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

function Mockup({ info, onSend, mockupUrl }: { info: Extract<TvFocusInfo, { kind: 'mockup' }>; onSend?: TvFocusProps['onSend']; mockupUrl?: MockupUrlFn }): JSX.Element {
  const [asking, setAsking] = useState(false)
  const [text, setText] = useState('')
  const send = (msg: string): void => onSend?.(info.convId, msg)
  return (
    <>
      <div className="tvf-page">
        <MockupFrame cwd={info.cwd} path={info.path} rel={info.rel} mockupUrl={mockupUrl} frameClass="tvf-frame" emptyClass="tvf-empty" testId="tv-focus-iframe" />
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

export function TvFocus({ info, projectors, onClose, onSend, mockupUrl, planning, activeConvId, onPickPlan, onSeen = markSeen, onGoToAgent, peekApi }: TvFocusProps): JSX.Element {
  // A aba aberta ("Agente chamando" ou "Implantação") vale para ESTE foco: outro foco (ou outro plano) volta ao plano.
  const [tabFor, setTabFor] = useState<{ info: TvFocusInfo; tab: 'agent' | 'deploy' } | null>(null)
  const agents = info.kind === 'plan' ? (info.agents ?? []) : []
  const plan = info.kind === 'plan' ? (info.plans.find((p) => p.convId === info.convId) ?? null) : null
  const center = useDeliveryCenterContext()
  // Sem o centro de Entregas não há aba Implantação: nem pede o resumo.
  const roteiro = usePlanRoteiro(center ? plan?.cwd : null, plan?.slug, peekApi)
  const deploy = plan ? deploySummary(center, plan, roteiro) : null
  const onAgent = tabFor?.info === info && tabFor.tab === 'agent' && agents.length > 0
  const onDeploy = tabFor?.info === info && tabFor.tab === 'deploy' && !!deploy
  const shown = onAgent ? agents[0] : info
  const openAgent = (): void => {
    const a = agents[0]
    setTabFor({ info, tab: 'agent' })
    if (!onAgent && a.kind === 'mockup' && a.callId) onSeen(a.callId)
  }
  const pickPlan = (id: string): void => {
    setTabFor(null)
    onPickPlan?.(id)
  }
  // Abrir a conversa de um envio: a TV fecha antes (aberta, ela traria de volta a conversa do plano) e o chat flutuante a mostra.
  const openConversation = (id: string): void => {
    onClose()
    center?.openConversation(id)
  }
  return (
    <div className="tvf" data-testid="tv-focus" data-kind={shown.kind}>
      <div className="tvf-bar">
        <span className="tvf-title">{onDeploy && plan ? `Implantação · ${plan.title}` : titleOf(shown)}</span>
        {info.kind === 'plan' && (info.plans.length > 1 || agents.length > 0 || deploy) ? (
          <span className="tvf-tabs" role="tablist" aria-label="Telas da TV">
            {info.plans.map((p) => {
              const on = !onAgent && !onDeploy && p.convId === info.convId
              return (
                <button key={p.convId} type="button" role="tab" aria-selected={on} className={on ? 'on' : ''} onClick={() => pickPlan(p.convId)}>
                  {p.title}
                </button>
              )
            })}
            {agents.length > 0 ? (
              <button type="button" role="tab" aria-selected={onAgent} className={`tvf-agent-tab${onAgent ? ' on' : ''}`} onClick={openAgent}>
                Agente chamando ({agents.length})
              </button>
            ) : null}
            {deploy ? (
              <button type="button" role="tab" aria-selected={onDeploy} className={`tvf-deploy-tab s-${deploy.status}${onDeploy ? ' on' : ''}`} onClick={() => setTabFor({ info, tab: 'deploy' })}>
                {deploy.label}
              </button>
            ) : null}
          </span>
        ) : null}
        {shown.waiting > 0 ? <span className="tvf-waiting">+{shown.waiting} esperando</span> : null}
        <button type="button" className="tvf-close" onClick={onClose} aria-label="Fechar a TV" title="Fechar (Esc)">
          ×
        </button>
      </div>
      {info.kind === 'plan' ? (
        // Com a aba do agente (ou a Implantação) aberta o plano fica montado, escondido: voltar não recarrega a tela nem o chat.
        <div className="tvf-plan" data-testid="tv-focus-plan" hidden={onAgent || onDeploy}>
          {planning && activeConvId === info.convId ? planning : <div className="tvf-empty">Abrindo o planejamento…</div>}
        </div>
      ) : null}
      {onDeploy && plan && center ? (
        <TvDeploy plan={plan} center={center} onOpenConversation={openConversation} onGoToAgent={onGoToAgent} peekApi={peekApi} />
      ) : shown.kind === 'mockup' ? (
        <Mockup info={shown} onSend={onSend} mockupUrl={mockupUrl} />
      ) : shown.kind === 'plan' ? null : (
        <Mirror roomId={shown.roomId} projectors={projectors} />
      )}
    </div>
  )
}
