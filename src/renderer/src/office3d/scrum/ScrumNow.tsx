/**
 * A aba "Agora" do painel do Scrum Master: um cartão por envio acompanhado —
 * título, 📍, status, a linha do projeto, a etapa, a trilha do prazo e a troca
 * SM ↔ agente. No envio parado: Retomar com o aviso / Ver a conversa / Tirar da
 * fila; na declaração acima do teto: Aprovar / Recusar.
 */
import { useState } from 'react'
import type { ScrumEnvioView, ScrumFala } from '@shared/scrumPanel'
import { ProjectRow, Track, Verdict, type ProjectColorOf } from './ScrumParts'
import { etapaText, filterEnvios, hhmm, marcoText, NOW_CHIPS, statusOf, type NowChip } from './scrumPanelText'

export interface ScrumNowActions {
  onLocate: (convId: string) => void
  onOpenConversation: (convId: string) => void
  /** "Retomar com o aviso"; sem ele (sem envio para a conversa), sem o botão. */
  onResume?: (envio: ScrumEnvioView) => void
  dequeue: (envioId: string) => Promise<string | null>
  decide: (envioId: string, entregaId: string, aprovar: boolean) => Promise<string | null>
}

function Fala({ f }: { f: ScrumFala }): JSX.Element {
  const sm = f.quem === 'sm'
  return (
    <div className={`smp-msg ${sm ? 'sm-msg' : 'agent-msg'}`} data-testid="smp-fala">
      <span className="smp-who">{sm ? 'SM' : 'AG'}</span>
      <div className="smp-bubble">
        <div className="smp-meta">
          {hhmm(f.at)}
          {sm ? (
            <>
              {f.marco !== null ? ` · ${marcoText(f.marco)}` : ''} <Verdict v={f.veredito} tipo={f.tipoDesvio} />
              {f.avisouVoce ? ' · avisou você' : ''}
            </>
          ) : (
            ' · resposta do agente'
          )}
        </div>
        {f.texto}
      </div>
    </div>
  )
}

function EnvioCard({ e, color, actions }: { e: ScrumEnvioView; color: string; actions: ScrumNowActions }): JSX.Element {
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const status = statusOf(e)
  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    const err = await fn()
    setBusy(false)
    setNote(err)
  }
  return (
    <section className="smp-envio" data-testid="smp-envio" data-estado={e.estado}>
      <div className="smp-envio-top">
        <button type="button" className="smp-agent" title="Voar até a mesa" onClick={() => actions.onLocate(e.convId)}>
          <span className="smp-dot" style={{ background: color }} />
          {e.conversationTitle} <small>· agente principal</small> <span aria-hidden="true">📍</span>
        </button>
        <span className={`smp-status ${status.cls}`} data-testid="smp-status">
          {status.text}
        </span>
      </div>
      <ProjectRow cwd={e.projectCwd} color={color} />
      <div className="smp-etapa">{etapaText(e)}</div>
      <Track envio={e} />
      {e.falas.length === 0 ? (
        <div className="smp-quiet">Nada a cobrar. O Scrum Master só fala a partir de 150% do prazo da etapa.</div>
      ) : (
        <div className="smp-talk">
          {e.falas.map((f) => (
            <Fala key={f.id} f={f} />
          ))}
          {e.semResposta ? (
            <div className="smp-msg agent-msg">
              <span className="smp-who">AG</span>
              <div className="smp-bubble">
                <span className="smp-reply-note">ainda sem resposta — a próxima ferramenta do agente traz a cobrança</span>
              </div>
            </div>
          ) : null}
        </div>
      )}
      {e.estado === 'parado' ? (
        <div className="smp-actions">
          {actions.onResume ? (
            <button type="button" className="smp-btn primary" disabled={busy} onClick={() => actions.onResume?.(e)}>
              Retomar com o aviso
            </button>
          ) : null}
          <button type="button" className="smp-btn" onClick={() => actions.onOpenConversation(e.convId)}>
            Ver a conversa
          </button>
          {e.proximoNaFila ? (
            <button type="button" className="smp-btn" disabled={busy} onClick={() => void run(() => actions.dequeue(e.proximoNaFila as string))}>
              Tirar da fila
            </button>
          ) : null}
        </div>
      ) : null}
      {e.declaracao ? (
        <div className="smp-decl" data-testid="smp-decl">
          O agente declarou {e.declaracao.pedidoMin} min para esta tarefa, acima de 3× o prazo (vale {e.declaracao.validoMin} min até você decidir): “{e.declaracao.motivo}”
          <div className="smp-actions">
            <button type="button" className="smp-btn primary" disabled={busy} onClick={() => void run(() => actions.decide(e.envioId, e.declaracao!.entregaId, true))}>
              Aprovar
            </button>
            <button type="button" className="smp-btn" disabled={busy} onClick={() => void run(() => actions.decide(e.envioId, e.declaracao!.entregaId, false))}>
              Recusar
            </button>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className="smp-err" role="alert">
          {note}
        </div>
      ) : null}
    </section>
  )
}

export function ScrumNow({ envios, colorOf, actions }: { envios: readonly ScrumEnvioView[]; colorOf: ProjectColorOf; actions: ScrumNowActions }): JSX.Element {
  const [chip, setChip] = useState<NowChip>('todos')
  const shown = filterEnvios(envios, chip)
  return (
    <div className="smp-pane" data-testid="smp-pane-agora">
      <div className="smp-chips">
        {NOW_CHIPS.map((c) => (
          <button key={c.id} type="button" className={`smp-chip${chip === c.id ? ' on' : ''}`} aria-pressed={chip === c.id} onClick={() => setChip(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="smp-h">Em andamento</div>
      {shown.length === 0 ? (
        <div className="smp-quiet">{envios.length === 0 ? 'Nenhum envio de handoff em andamento agora.' : 'Nenhum envio neste filtro.'}</div>
      ) : (
        shown.map((e) => <EnvioCard key={e.envioId} e={e} color={colorOf(e.projectCwd)} actions={actions} />)
      )}
    </div>
  )
}
