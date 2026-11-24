/**
 * Reenviar um plano: para qual conversa?
 *
 * Quando o plano já foi enviado a uma conversa de implementação que ainda
 * existe, o "Enviar para implementação" pergunta na hora se os prompts vão para
 * ESSA conversa ou para uma nova (ex.: a atual travou num bug e o usuário quer
 * recomeçar sem refazer o planejamento). Sem conversa anterior viva, não
 * pergunta: cria uma nova, como sempre.
 *
 * Esc e clique fora cancelam (nada é enviado).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PlanningHandoffDto, PlanningHandoffSentDto } from '@shared/ipc'

/** A escolha: `targetId` = mandar na conversa existente; ausente = conversa nova. */
export interface HandoffTargetChoice {
  targetId?: string
}

/** A conversa de implementação mais recente deste plano que ainda existe. */
export function previousConversation(
  sent: readonly PlanningHandoffSentDto[],
  exists: (id: string) => boolean
): { id: string; title: string } | null {
  const live = sent.filter((e) => e.conversaId && exists(e.conversaId))
  if (live.length === 0) return null
  const last = live.reduce((a, b) => (Date.parse(b.enviadoEm) >= Date.parse(a.enviadoEm) ? b : a))
  return { id: last.conversaId as string, title: last.conversaTitulo?.trim() || 'Implementação' }
}

/** Os enviados que dá para mandar de novo: o arquivo ainda existe e não foi trocado por um editado. */
export function resendableHandoffs(
  handoffs: readonly PlanningHandoffDto[],
  sent: readonly PlanningHandoffSentDto[]
): Set<string> {
  const files = new Set(handoffs.map((h) => h.name))
  return new Set(sent.filter((e) => !e.substituidoPor && files.has(e.nome)).map((e) => e.nome))
}

/** As opções do onSend do diálogo. */
export interface HandoffSendOptions {
  fastMode?: boolean
  /** Mandar nesta conversa (que já existe) em vez de criar uma nova. */
  targetConversationId?: string
}

/** As opções do onSend: o Fast mode (se a tela mostra a opção) e a conversa escolhida. */
export function sendOptions(
  fast: { fastMode: boolean } | null | undefined,
  choice: HandoffTargetChoice
): HandoffSendOptions | undefined {
  const opts = { ...(fast ?? {}), ...(choice.targetId ? { targetConversationId: choice.targetId } : {}) }
  return Object.keys(opts).length > 0 ? opts : undefined
}

/**
 * `choose()` devolve a escolha (null = cancelou). Sem conversa anterior viva,
 * resolve na hora com "conversa nova". `dialog` é o modal a renderizar; `open`
 * diz se ele está na tela (o diálogo de baixo não fecha com o Esc dele).
 */
export function useHandoffTarget(
  sent: readonly PlanningHandoffSentDto[],
  exists: (id: string) => boolean
): { choose: () => Promise<HandoffTargetChoice | null>; open: boolean; dialog: JSX.Element | null } {
  const previous = useMemo(() => previousConversation(sent, exists), [sent, exists])
  const [asking, setAsking] = useState<{ id: string; title: string } | null>(null)
  const resolveRef = useRef<((c: HandoffTargetChoice | null) => void) | null>(null)

  const finish = useCallback((c: HandoffTargetChoice | null): void => {
    resolveRef.current?.(c)
    resolveRef.current = null
    setAsking(null)
  }, [])

  // Desmontado com a pergunta aberta: vale como cancelar.
  useEffect(() => () => resolveRef.current?.(null), [])

  const choose = useCallback((): Promise<HandoffTargetChoice | null> => {
    if (!previous) return Promise.resolve({})
    resolveRef.current?.(null)
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setAsking(previous)
    })
  }, [previous])

  const dialog = asking ? <TargetDialog conversation={asking} onChoose={finish} /> : null
  return { choose, open: asking !== null, dialog }
}

function TargetDialog(props: {
  conversation: { id: string; title: string }
  onChoose: (c: HandoffTargetChoice | null) => void
}): JSX.Element {
  const { conversation, onChoose } = props
  const sameRef = useRef<HTMLButtonElement>(null)
  useEffect(() => sameRef.current?.focus(), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onChoose(null)
    }
    // Captura: o Esc é desta pergunta, não do diálogo de envio por baixo.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChoose])
  return createPortal(
    <div className="modal-overlay pl-handoff-target-overlay" onMouseDown={(e) => e.target === e.currentTarget && onChoose(null)}>
      <div className="modal-card pl-handoff-target" role="dialog" aria-modal="true" aria-labelledby="pl-handoff-target-title">
        <h3 className="modal-title" id="pl-handoff-target-title">
          Enviar para qual conversa?
        </h3>
        <p className="modal-message">
          Este plano já foi enviado para a conversa <b>{conversation.title}</b>. Você pode mandar de novo nela ou começar
          uma conversa nova, se a atual travou ou se perdeu. O planejamento continua o mesmo.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => onChoose(null)}>
            Cancelar
          </button>
          <span className="pl-handoff-spacer" />
          <button type="button" className="btn" onClick={() => onChoose({})}>
            Criar conversa nova
          </button>
          <button type="button" ref={sameRef} className="btn primary" onClick={() => onChoose({ targetId: conversation.id })}>
            Usar a mesma conversa
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
