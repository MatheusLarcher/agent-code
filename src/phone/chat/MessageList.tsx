/**
 * A lista de mensagens da conversa aberta: segue o fim enquanto o agente escreve
 * (só se você já estava no fim — lendo mais acima, a tela fica onde está), centra
 * a mensagem vinda da busca/mapa, "ir para o final" e puxar-para-atualizar no topo
 * (recarrega pelo `/api/history`, em silêncio, sem apagar a tela).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type TouchEvent } from 'react'
import { client } from '../app/runtime'
import { isHiddenMessage } from '../core/reducer'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'
import { toggleSpeak, tts } from '../voice/tts'
import { MessageItem } from './MessageItem'
import { QuestionMap } from './QuestionMap'

const PULL_THRESHOLD = 64
const NEAR_BOTTOM = 80
const JUMP_AFTER = 220

type PullMode = 'hidden' | 'pulling' | 'ready' | 'refreshing'

export function MessageList({ onRefresh }: { onRefresh: () => Promise<unknown> }): JSX.Element {
  const messages = useStore(client.store, (s) => s.messages)
  const loading = useStore(client.store, (s) => s.historyLoading)
  const convId = useStore(client.store, (s) => s.convId)
  const scrollTo = useStore(client.store, (s) => s.scrollToMsg)
  const voiceReady = useStore(client.store, (s) => s.voiceReady)
  const speakingId = useStore(tts, (s) => s.speakingId)
  const boxRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const [far, setFar] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [pull, setPull] = useState<PullMode>('hidden')
  const pullRef = useRef({ active: false, startY: 0, over: false })

  const measure = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight
    nearBottom.current = dist < NEAR_BOTTOM
    setFar(dist > JUMP_AFTER)
  }, [])

  // Conversa nova aberta: começa no fim.
  useEffect(() => {
    nearBottom.current = true
  }, [convId])

  // Conteúdo mudou: no fim → acompanha; lendo acima → fica onde está (o React não recria a lista).
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || loading) return
    if (scrollTo) {
      const el = box.querySelector<HTMLElement>(`[data-mid="${CSS.escape(scrollTo)}"]`)
      if (el) {
        el.scrollIntoView({ block: 'center' })
        setFlash(scrollTo)
        client.clearScrollTarget()
        setTimeout(() => setFlash((f) => (f === scrollTo ? null : f)), 2200)
        measure()
        return
      }
    }
    if (nearBottom.current) box.scrollTop = box.scrollHeight
    measure()
  }, [messages, loading, scrollTo, measure])

  const toBottom = (): void => {
    const box = boxRef.current
    if (!box) return
    box.scrollTop = box.scrollHeight
    measure()
  }

  // ---- puxar para atualizar --------------------------------------------------------
  const onTouchStart = (e: TouchEvent): void => {
    if (pull === 'refreshing') return
    const box = boxRef.current
    pullRef.current = { active: !!box && box.scrollTop <= 0, startY: e.touches[0].clientY, over: false }
  }
  const onTouchMove = (e: TouchEvent): void => {
    const p = pullRef.current
    const box = boxRef.current
    if (!p.active || pull === 'refreshing' || !box) return
    if (box.scrollTop > 0) {
      p.active = false
      setPull('hidden')
      return
    }
    const dy = e.touches[0].clientY - p.startY
    if (dy <= 0) {
      p.over = false
      setPull('hidden')
      return
    }
    p.over = dy > PULL_THRESHOLD
    setPull(p.over ? 'ready' : 'pulling')
  }
  const onTouchEnd = (): void => {
    const p = pullRef.current
    if (!p.active || pull === 'refreshing') return
    p.active = false
    if (!p.over) return setPull('hidden')
    setPull('refreshing')
    const done = (): void => setPull('hidden')
    onRefresh().then(done, done)
  }

  // O gesto a partir do topo trava a rolagem nativa (o "bounce" brigaria com o "solte para atualizar").
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const block = (e: globalThis.TouchEvent): void => {
      if (pullRef.current.active && box.scrollTop <= 0 && e.cancelable) {
        const dy = e.touches[0].clientY - pullRef.current.startY
        if (dy > 0) e.preventDefault()
      }
    }
    box.addEventListener('touchmove', block, { passive: false })
    return () => box.removeEventListener('touchmove', block)
  }, [])

  const visible = messages.filter((m) => !isHiddenMessage(m))
  return (
    <div className="messages-wrap">
      {pull !== 'hidden' && (
        <div className="bar reconnect pull-bar">
          <span className="spinner" />
          {pull === 'refreshing' ? 'Atualizando…' : pull === 'ready' ? 'Solte para atualizar' : 'Puxe para atualizar'}
        </div>
      )}
      <div
        ref={boxRef}
        className="messages"
        onScroll={measure}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {loading ? (
          <div className="messages-loading"><span className="spinner" /> Carregando mensagens…</div>
        ) : visible.length === 0 ? (
          <div className="messages-empty">Nenhuma mensagem ainda. Envie um comando para começar.</div>
        ) : (
          visible.map((m, i) => (
            <MessageItem
              key={m.id ?? `i${i}`}
              m={m}
              flash={flash !== null && m.id === flash}
              voiceReady={voiceReady}
              speakingId={speakingId}
              onSpeak={toggleSpeak}
            />
          ))
        )}
      </div>
      <QuestionMap />
      {far && (
        <button type="button" className="jump-bottom" title="Ir para o final" aria-label="Ir para o final" onClick={toBottom}>
          <Icon name="down" size={22} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
