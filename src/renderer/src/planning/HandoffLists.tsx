/**
 * As listas do diálogo "Enviar para implementação" (HandoffDialog): os prompts
 * a enviar, os que ficaram fora deste envio e os já enviados. Só apresentação;
 * as ações vêm do diálogo.
 */
import type { PlanningHandoffDto, PlanningHandoffSentDto } from '@shared/ipc'
import { IconWarning } from '../components/Icons'
import type { HandoffIssue } from './handoffReadiness'
import { StaleBadge } from './HandoffStale'

export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
}

function when(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t)
    ? new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    : iso
}

/** Ambiguidade aberta: bloqueia o envio até marcar "enviar mesmo assim". */
export function HandoffBlockers(props: {
  blockers: readonly HandoffIssue[]
  override: boolean
  onOverride: (v: boolean) => void
}): JSX.Element | null {
  if (props.blockers.length === 0) return null
  return (
    <section className="pl-handoff-issues block" aria-label="Bloqueios">
      <h4>
        <IconWarning size={13} /> Bloqueia o envio
      </h4>
      <ul>
        {props.blockers.map((i) => (
          <li key={`${i.kind}:${i.ref}`}>{i.text}</li>
        ))}
      </ul>
      <label className="pl-handoff-override">
        <input type="checkbox" checked={props.override} onChange={(e) => props.onOverride(e.target.checked)} />
        Enviar mesmo assim — as ambiguidades vão como pendentes de confirmação
      </label>
    </section>
  )
}

/** Prompts de _handoff/ ainda não enviados (passo "Conferir"). */
export function PendingHandoffs(props: {
  pending: readonly PlanningHandoffDto[]
  disabled: boolean
  onMarkSent: (name: string) => void
  /** Os antigos (gravados antes da última mudança do plano): ganham o selo. */
  stale?: ReadonlySet<string>
}): JSX.Element | null {
  const { pending } = props
  if (pending.length === 0) return null
  return (
    <section className="pl-handoff-saved" aria-label="Prompts a enviar">
      <h4>{pending.length > 1 ? `${pending.length} prompts a enviar` : '1 prompt a enviar'}</h4>
      <ul className="pl-handoff-files">
        {pending.map((h) => (
          <li key={h.name}>
            <code>_handoff/{h.name}</code>
            {props.stale?.has(h.name) && <StaleBadge />}
            <span>{firstLine(h.content)}</span>
            <button
              type="button"
              className="btn ghost small pl-handoff-row-act"
              disabled={props.disabled}
              onClick={() => props.onMarkSent(h.name)}
            >
              Marcar como já enviado
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Pendentes que não estão nesta revisão (tirados, gravados depois, ou antigos). */
export function OutsideHandoffs(props: {
  outside: readonly PlanningHandoffDto[]
  disabled: boolean
  onInclude: (h: PlanningHandoffDto) => void
  stale?: ReadonlySet<string>
}): JSX.Element | null {
  const { outside } = props
  if (outside.length === 0) return null
  return (
    <section className="pl-handoff-saved pl-handoff-outside" aria-label="Fora deste envio">
      <h4>{outside.length > 1 ? `${outside.length} prompts a enviar fora deste envio` : '1 prompt a enviar fora deste envio'}</h4>
      <ul className="pl-handoff-files">
        {outside.map((h) => (
          <li key={h.name}>
            <code>_handoff/{h.name}</code>
            {props.stale?.has(h.name) && <StaleBadge />}
            <span>{firstLine(h.content)}</span>
            <button
              type="button"
              className="btn ghost small pl-handoff-row-act"
              disabled={props.disabled}
              onClick={() => props.onInclude(h)}
            >
              Incluir
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** O que já saiu de "a enviar", na ordem dos nomes. */
export function SentHandoffs(props: {
  sent: readonly PlanningHandoffSentDto[]
  conversationExists: (id: string) => boolean
  onOpenConversation: (id: string) => void
}): JSX.Element | null {
  if (props.sent.length === 0) return null
  // Numérico: "-100" depois de "-99", como a ordem do listHandoffs.
  const list = [...props.sent].sort((a, b) => a.nome.localeCompare(b.nome, undefined, { numeric: true }))
  return (
    <section className="pl-handoff-saved" aria-label="Prompts enviados">
      <h4>{list.length > 1 ? `${list.length} prompts enviados` : '1 prompt enviado'}</h4>
      <ul className="pl-handoff-files pl-handoff-sent">
        {list.map((e) => (
          <li key={e.nome}>
            <code>_handoff/{e.nome}</code>
            <span className="pl-handoff-when">{when(e.enviadoEm)}</span>
            {e.conversaId ? (
              <>
                <span title={e.conversaTitulo}>{e.conversaTitulo}</span>
                {props.conversationExists(e.conversaId) ? (
                  <button
                    type="button"
                    className="btn ghost small pl-handoff-row-act"
                    onClick={() => props.onOpenConversation(e.conversaId as string)}
                  >
                    Abrir conversa
                  </button>
                ) : (
                  <span className="pl-handoff-gone">conversa apagada</span>
                )}
              </>
            ) : e.substituidoPor ? (
              <span>
                substituído por <code>{e.substituidoPor}</code>
              </span>
            ) : (
              <span>marcado como já enviado</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
