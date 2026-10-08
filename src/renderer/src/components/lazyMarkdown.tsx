import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { UIMessage } from '../types'
import { Markdown, type CardRefResolver } from './Markdown'

/**
 * Troca de conversa com renderização progressiva (sem virtualizar): ao abrir, só as
 * últimas respostas — perto do fim, onde a conversa abre — viram Markdown na hora.
 * As de cima entram como TEXTO SIMPLES (o mesmo texto, no DOM desde o início: Ctrl+F
 * e rolagem funcionam) e viram Markdown quando chegam perto da tela ou quando o app
 * fica ocioso, em lotes pequenos. A âncora de rolagem do Chromium (overflow-anchor)
 * segura a posição quando um texto acima da tela cresce ao virar Markdown.
 */

/** Respostas do fim que já abrem em Markdown. */
export const EAGER_ANSWERS = 6
/** Margem do observador: vira Markdown antes de aparecer. */
const NEAR_SCREEN = '1500px 0px'
/** Quantas viram Markdown por fatia ociosa. */
const IDLE_BATCH = 2

/** Os ids das respostas que abrem como texto simples (null = todas em Markdown). */
const LazyMarkdownGate = createContext<ReadonlySet<string> | null>(null)
export const LazyMarkdownProvider = LazyMarkdownGate.Provider

/** Fixado na montagem da lista (uma por conversa): o que chega depois já é do fim. */
export function useLazyAnswers(messages: readonly UIMessage[]): ReadonlySet<string> {
  const [lazy] = useState<ReadonlySet<string>>(() => {
    const answers = messages.filter((m) => m.kind === 'assistant-text').map((m) => m.id)
    return new Set(answers.slice(0, Math.max(0, answers.length - EAGER_ANSWERS)))
  })
  return lazy
}

type Upgrade = () => void
const queue: Upgrade[] = []
let scheduled = false

const idle = (fn: () => void): void => {
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback
  if (ric) ric(fn, { timeout: 2_000 })
  else setTimeout(fn, 50)
}

function drain(): void {
  scheduled = false
  for (let i = 0; i < IDLE_BATCH && queue.length; i++) queue.shift()?.()
  if (queue.length) schedule()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  idle(drain)
}

/** Na fila do ocioso; devolve como sair dela (a linha saiu da tela antes). */
function upgradeWhenIdle(fn: Upgrade): () => void {
  queue.push(fn)
  schedule()
  return () => {
    const at = queue.indexOf(fn)
    if (at >= 0) queue.splice(at, 1)
  }
}

export function LazyMarkdown({
  messageId,
  text,
  resolveRef,
  blur = false
}: {
  messageId: string
  text: string
  resolveRef?: CardRefResolver | null
  blur?: boolean
}): JSX.Element {
  const gate = useContext(LazyMarkdownGate)
  const [ready, setReady] = useState(() => blur || !gate?.has(messageId))
  const holder = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ready) return
    let done = false
    const upgrade = (): void => {
      if (done) return
      done = true
      setReady(true)
    }
    const el = holder.current
    const observer =
      el && typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && upgrade(), {
            root: el.closest('.message-list'),
            rootMargin: NEAR_SCREEN
          })
        : null
    if (el) observer?.observe(el)
    const leave = upgradeWhenIdle(upgrade)
    return () => {
      done = true
      observer?.disconnect()
      leave()
    }
  }, [ready])
  if (ready) return <Markdown text={text} resolveRef={resolveRef} blur={blur} />
  return (
    <div ref={holder} className="md md-plain">
      {text}
    </div>
  )
}
