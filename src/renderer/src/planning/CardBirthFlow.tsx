/**
 * O nascimento de um card que o Agent Manager criou: um fluxo na cor do tipo
 * sai do chat, corre até onde o card vai ficar e, quando chega, o card se
 * materializa ali — a impressão é a do chat gerando o card no canvas.
 *
 * Montado dentro da `.pl-main` (a área do canvas + chat), por cima dos dois e
 * sem capturar clique. Recebe a leva `born` do usePlanning:
 *
 * - No MESMO render em que o plano novo chega, um <style> esconde os cards da
 *   leva — sem isso o card piscaria no lugar antes do fluxo sair do chat.
 * - Depois acha o nó de cada card no DOM (o React Flow o mede um pouco depois;
 *   tenta por ~0,5s), desenha a curva chat → card e, no fim dela, marca o nó
 *   com `data-born="arrive"`: a animação de chegada (cardBirth.css) e o fim do
 *   esconderijo. Atributo, não classe: o React não mexe no que não renderizou.
 * - Vários de uma vez saem em cascata. Sem chat na tela, ou com "reduzir
 *   movimento" do sistema, não há fluxo: o card só aparece com o brilho.
 */
import './cardBirth.css'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { typeColorVar } from './cardTypes'
import type { CardBirth } from './usePlanning'

/** Quanto o fluxo leva do chat ao card. */
export const FLOW_MS = 720
/** Intervalo entre os fluxos de uma mesma leva. */
export const STAGGER_MS = 160
/** Duração da chegada (brilho + escala) — o atributo sai depois dela. */
export const ARRIVE_MS = 900
const FADE_MS = 320
const FIND_TRIES = 30
const FIND_EVERY_MS = 16

interface Stream {
  key: string
  d: string
  color: string
}

function escapeId(id: string): string {
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
  return css?.escape ? css.escape(id) : id.replace(/["\\]/g, '\\$&')
}

/** O nó do card no canvas (CardNode põe o data-testid). */
export function cardSelector(id: string): string {
  return `[data-testid="pl-card-${escapeId(id)}"]`
}

/** Curva em S do ponto de saída (borda de cima do chat) ao centro do card. */
export function flowPath(sx: number, sy: number, ex: number, ey: number): string {
  const my = (sy + ey) / 2
  return `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function CardBirthFlow({ birth }: { birth: CardBirth | null }): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const [streams, setStreams] = useState<Stream[]>([])
  // Os já chegados desta leva — os demais continuam escondidos.
  const [arrived, setArrived] = useState<{ seq: number; ids: ReadonlySet<string> }>({ seq: 0, ids: new Set() })

  useEffect(() => {
    const area = layerRef.current?.parentElement
    if (!birth || !area) return
    const seq = birth.seq
    const timers: ReturnType<typeof setTimeout>[] = []
    const later = (fn: () => void, ms: number): void => void timers.push(setTimeout(fn, ms))
    const reduce = prefersReducedMotion()
    setStreams([])

    const markArrived = (id: string): void =>
      setArrived((a) => ({ seq, ids: new Set(a.seq === seq ? [...a.ids, id] : [id]) }))

    const land = (el: HTMLElement | null, id: string): void => {
      if (el) {
        el.dataset.born = 'arrive'
        later(() => {
          if (el.dataset.born === 'arrive') delete el.dataset.born
        }, ARRIVE_MS)
      }
      markArrived(id)
    }

    const launch = (el: HTMLElement, card: CardBirth['cards'][number]): void => {
      const chat = area.querySelector('.pl-chat-float')
      if (!chat || reduce) return land(el, card.id)
      const a = area.getBoundingClientRect()
      const s = chat.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      const d = flowPath(s.left + s.width / 2 - a.left, s.top - a.top, c.left + c.width / 2 - a.left, c.top + c.height / 2 - a.top)
      const key = `${seq}:${card.id}`
      setStreams((list) => [...list, { key, d, color: typeColorVar(card.tipo) }])
      later(() => land(el, card.id), FLOW_MS)
      later(() => setStreams((list) => list.filter((x) => x.key !== key)), FLOW_MS + FADE_MS)
    }

    birth.cards.forEach((card, i) => {
      let tries = 0
      const find = (): void => {
        const el = area.querySelector<HTMLElement>(cardSelector(card.id))
        // Nó ainda sem medida (o React Flow mede depois de montar): espera.
        const measured = !!el && el.getBoundingClientRect().width > 0
        if (measured && el) return launch(el, card)
        if (tries++ < FIND_TRIES) return later(find, FIND_EVERY_MS)
        land(el, card.id) // nunca mediu: aparece sem o fluxo, mas aparece
      }
      later(find, i * STAGGER_MS)
    })

    return () => timers.forEach(clearTimeout)
  }, [birth])

  const hidden = birth
    ? birth.cards.filter((c) => !(arrived.seq === birth.seq && arrived.ids.has(c.id))).map((c) => c.id)
    : []

  return (
    <div ref={layerRef} className="pl-birth-layer" aria-hidden="true">
      {hidden.length > 0 && (
        <style>{hidden.map((id) => `${cardSelector(id)}:not([data-born]) { opacity: 0; }`).join('\n')}</style>
      )}
      {/* Um <svg> por fluxo: cada um tem a própria linha do tempo, então a animação começa quando ele entra. */}
      {streams.map((s) => (
        <svg key={s.key} className="pl-birth-stream" style={{ '--pl-flow': s.color } as CSSProperties}>
          <path className="pl-birth-glow" d={s.d} pathLength={1} />
          <path className="pl-birth-core" d={s.d} pathLength={1} />
          <circle className="pl-birth-spark" r={5}>
            <animateMotion dur={`${FLOW_MS}ms`} path={s.d} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.2 1" />
          </circle>
        </svg>
      ))}
    </div>
  )
}
