/**
 * Prévia do agente ao passar o mouse (sem clique): um cartão flutuante sobre o
 * monitor dele com o título da conversa e as últimas entradas do turno, nos
 * componentes REAIS do chat (cartões de ferramenta recolhidos). Só leitura e
 * sem eventos de ponteiro — o mouse continua no 3D. Quem decide quando aparece
 * (atraso do hover) é o Office3DWorkspace; quem move o cartão, por transform, é
 * o motor (PointAnchor) — nada de React por quadro.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { lookupOf, turnHead, turnMessages } from './chatPage'
import { TurnHeader, TurnRows } from './ChatTurn'
import { PROJECTOR_KEY } from './engineTypes'
import './screens.css'

/** Quantas entradas do turno a prévia mostra. */
export const PREVIEW_MESSAGES = 5
/** O mouse fica isto sobre o agente antes da prévia aparecer. */
export const PREVIEW_DELAY_MS = 250

/**
 * O agente cuja prévia aparece: o hover (motor) parado nele por
 * PREVIEW_DELAY_MS; sair dele (ou ir para outro) esconde na hora. A tela do
 * projetor não tem prévia. Aba fechada ou desmontar limpam o temporizador.
 */
export function useHoverPreview(active: boolean): [string | null, (key: string | null) => void] {
  const [key, setKey] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = useCallback((): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const onHover = useCallback(
    (next: string | null): void => {
      clear()
      setKey((cur) => (cur === next ? cur : null))
      if (!next || next.startsWith(PROJECTOR_KEY)) return
      timer.current = setTimeout(() => {
        timer.current = null
        setKey(next)
      }, PREVIEW_DELAY_MS)
    },
    [clear]
  )
  useEffect(() => {
    if (active) return
    clear()
    setKey(null)
  }, [active, clear])
  useEffect(() => clear, [clear])
  return [key, onHover]
}

export function ChatPreview({ feed, model }: { feed: OfficeFeed | null; model: OfficeCharacterModel }): JSX.Element {
  const messages = useMemo(() => turnMessages(feed, lookupOf(model)), [feed, model])
  const head = turnHead(feed, model)
  return (
    <div className="o3d-preview" data-testid="office-preview" aria-hidden="true">
      <TurnHeader head={head} seed={model.seed} />
      <div className="message-list o3d-preview-body">
        <TurnRows messages={messages} busy={head.busy} limit={PREVIEW_MESSAGES} />
      </div>
    </div>
  )
}
