/**
 * Os passos 2 (Gerar) e 3 (Revisar prompt(s)) do diálogo "Enviar para
 * implementação" (HandoffDialog). Só apresentação: estado e ações vêm dele.
 */
import type { PlanningHandoffDto } from '@shared/ipc'
import { IconSpinner } from '../components/Icons'
import { firstLine, HandoffBlockers, OutsideHandoffs } from './HandoffLists'
import type { HandoffIssue } from './handoffReadiness'

export interface Draft {
  /** O arquivo em _handoff/ com o texto `saved`. */
  name: string
  /** O texto como veio (do Manager ou do rascunho automático): base do "editado". */
  original: string
  /** O último texto gravado em _handoff/: só o que difere dele é gravado de novo. */
  saved: string
  text: string
}

export const draftOf = (name: string, content: string): Draft => ({ name, original: content, saved: content, text: content })

export type HandoffWork = null | 'ask' | 'draft' | 'send' | 'mark'

export type HandoffStep = 'review' | 'waiting' | 'prompts'

const STEPS: { id: HandoffStep; label: string }[] = [
  { id: 'review', label: 'Conferir' },
  { id: 'waiting', label: 'Gerar' },
  { id: 'prompts', label: 'Revisar prompt(s)' }
]

export function HandoffHeader(props: { titulo: string; step: HandoffStep }): JSX.Element {
  const stepIndex = STEPS.findIndex((s) => s.id === props.step)
  return (
    <header className="pl-handoff-head">
      <span className="pl-handoff-eyebrow">Planejamento · {props.titulo}</span>
      <h3 className="modal-title" id="pl-handoff-title">
        Enviar para implementação
      </h3>
      <ol className="pl-handoff-steps" aria-label="Passos">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i === stepIndex ? 'on' : i < stepIndex ? 'done' : ''} aria-current={i === stepIndex ? 'step' : undefined}>
            <span className="pl-handoff-step-n">{i + 1}</span>
            {s.label}
          </li>
        ))}
      </ol>
    </header>
  )
}

export function WaitingStep(props: {
  found: readonly PlanningHandoffDto[]
  managerBusy: boolean
  working: HandoffWork
  onCancel: () => void
  onAutoDraft: () => void
  onReview: () => void
}): JSX.Element {
  const { found, managerBusy, working } = props
  return (
    <>
      <div className="pl-handoff-wait" role="status">
        {managerBusy && <IconSpinner className="spinner" size={15} />}
        <div>
          <strong>
            {found.length === 0
              ? 'Esperando o Agent Manager gravar o(s) prompt(s)…'
              : found.length === 1
                ? '1 prompt novo em _handoff/'
                : `${found.length} prompts novos em _handoff/`}
          </strong>
          <span>
            O pedido foi para a conversa de planejamento.{' '}
            {managerBusy ? 'O Agent Manager está trabalhando.' : 'O Agent Manager não está num turno agora.'}
          </span>
        </div>
      </div>
      {found.length > 0 && (
        <ul className="pl-handoff-files">
          {found.map((h) => (
            <li key={h.name}>
              <code>_handoff/{h.name}</code>
              <span>{firstLine(h.content)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          Cancelar
        </button>
        <span className="pl-handoff-spacer" />
        <button type="button" className="btn" disabled={working !== null} onClick={props.onAutoDraft}>
          {working === 'draft' ? 'Gravando…' : 'Usar rascunho automático'}
        </button>
        <button type="button" className="btn primary" disabled={found.length === 0} onClick={props.onReview}>
          {found.length > 1 ? `Revisar ${found.length} prompts` : 'Revisar prompt'}
        </button>
      </div>
    </>
  )
}

export function PromptsStep(props: {
  drafts: readonly Draft[]
  outside: readonly PlanningHandoffDto[]
  blockers: readonly HandoffIssue[]
  override: boolean
  onOverride: (v: boolean) => void
  working: HandoffWork
  onText: (index: number, text: string) => void
  onRemove: (name: string) => void
  onMarkSent: (name: string) => void
  onInclude: (h: PlanningHandoffDto) => void
  onCheckPlan: () => void
  onAskManager: () => void
  onSend: () => void
}): JSX.Element {
  const { drafts, working } = props
  const blocked = props.blockers.length > 0 && !props.override
  return (
    <>
      <p className="modal-message">
        É isto que a conversa de implementação vai receber{drafts.length > 1 ? ', um prompt por mensagem, na ordem' : ''}.
        Prompt editado é gravado como um arquivo novo em <code>_handoff/</code> antes do envio.
      </p>
      <HandoffBlockers blockers={props.blockers} override={props.override} onOverride={props.onOverride} />
      <div className="pl-handoff-prompts">
        {drafts.map((d, i) => (
          <section className="pl-handoff-prompt" key={d.name}>
            <div className="pl-handoff-prompt-head">
              <span className="pl-handoff-prompt-n">
                Prompt {i + 1} de {drafts.length}
              </span>
              <code>{d.name}</code>
              {d.text !== d.original && <span className="pl-handoff-badge">editado</span>}
              {i > 0 && <span className="pl-handoff-queue">entra na fila</span>}
              <span className="pl-handoff-spacer" />
              <button
                type="button"
                className="btn ghost small"
                disabled={working !== null}
                title="Só deste envio: o arquivo continua em _handoff/, a enviar"
                onClick={() => props.onRemove(d.name)}
              >
                Tirar deste envio
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={working !== null}
                title="Registra em _handoff/enviados.json que este prompt já foi enviado"
                onClick={() => props.onMarkSent(d.name)}
              >
                Marcar como já enviado
              </button>
            </div>
            <textarea
              aria-label={`Prompt ${i + 1}`}
              value={d.text}
              spellCheck={false}
              rows={drafts.length > 1 ? 9 : 16}
              onChange={(e) => props.onText(i, e.target.value)}
            />
            {!d.text.trim() && <span className="pl-handoff-empty">Prompt vazio não é enviado — escreva algo ou volte.</span>}
          </section>
        ))}
        <OutsideHandoffs outside={props.outside} disabled={working !== null} onInclude={props.onInclude} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" disabled={working === 'send'} onClick={props.onCheckPlan}>
          Conferir o plano
        </button>
        <button type="button" className="btn" disabled={blocked || working !== null} onClick={props.onAskManager}>
          Gerar de novo com o Agent Manager
        </button>
        <span className="pl-handoff-spacer" />
        <button
          type="button"
          className="btn primary"
          disabled={blocked || working !== null || drafts.length === 0 || drafts.some((d) => !d.text.trim())}
          onClick={props.onSend}
        >
          {working === 'send' ? 'Enviando…' : 'Enviar para implementação'}
        </button>
      </div>
    </>
  )
}
