/**
 * O nascimento de um card que o Agent Manager criou: um fluxo na cor do tipo
 * sai do chat, corre até onde o card vai ficar e, quando chega, o card se
 * CONSTRÓI ali — um cursor vai até ele, um contorno se desenha em volta e as
 * partes do card entram uma a uma sobre um esqueleto com brilho (a linguagem
 * do Google Stitch; cursor + contorno adaptados do canvas-anim.js do Nexos,
 * MIT — github.com/Yanngc32/Nexos).
 *
 * Montado dentro da `.pl-main` (a área do canvas + chat), por cima dos dois e
 * sem capturar clique. Recebe a leva `born` do usePlanning:
 *
 * - No MESMO render em que o plano novo chega, um <style> esconde os cards da
 *   leva — sem isso o card piscaria no lugar antes do fluxo sair do chat.
 * - Depois acha o nó de cada card no DOM (o React Flow o mede um pouco depois;
 *   tenta por ~0,5s), desenha a curva chat → card e, no fim dela, marca o nó
 *   com `data-born="arrive"`: a construção (cardBirth.css) e o fim do
 *   esconderijo. Atributo, não classe: o React não mexe no que não renderizou.
 * - Vários de uma vez saem em cascata. Sem chat na tela, ou com "reduzir
 *   movimento" do sistema, não há fluxo: o card só se constrói.
 */
import './cardBirth.css'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { typeColorVar } from './cardTypes'
import type { CardBirth } from './usePlanning'

/** Quanto o fluxo leva do chat ao card. */
export const FLOW_MS = 820
/** Intervalo entre os fluxos de uma mesma leva. */
export const STAGGER_MS = 220
/** Duração da construção (contorno + partes entrando) — o atributo sai depois dela. */
export const ARRIVE_MS = 1400
const FADE_MS = 320
const FIND_TRIES = 30
const FIND_EVERY_MS = 16

interface Stream {
  key: string
  d: string
  color: string
}

/** Cursor + contorno em volta do card que está se construindo (coordenadas da camada). */
interface Build {
  key: string
  x: number
  y: number
  w: number
  h: number
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
  const [builds, setBuilds] = useState<Build[]>([])
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
    setBuilds([])

    const markArrived = (id: string): void =>
      setArrived((a) => ({ seq, ids: new Set(a.seq === seq ? [...a.ids, id] : [id]) }))

    const land = (el: HTMLElement | null, card: CardBirth['cards'][number]): void => {
      if (el) {
        el.dataset.born = 'arrive'
        later(() => {
          if (el.dataset.born === 'arrive') delete el.dataset.born
        }, ARRIVE_MS)
        if (!reduce) {
          const a = area.getBoundingClientRect()
          const c = el.getBoundingClientRect()
          if (c.width > 0) {
            const key = `${seq}:${card.id}`
            const build = { key, x: c.left - a.left, y: c.top - a.top, w: c.width, h: c.height, color: typeColorVar(card.tipo) }
            setBuilds((list) => [...list.filter((b) => b.key !== key), build])
            later(() => setBuilds((list) => list.filter((b) => b.key !== key)), ARRIVE_MS)
          }
        }
      }
      markArrived(card.id)
    }

    const launch = (el: HTMLElement, card: CardBirth['cards'][number]): void => {
      const chat = area.querySelector('.pl-chat-float')
      if (!chat || reduce) return land(el, card)
      const a = area.getBoundingClientRect()
      const s = chat.getBoundingClientRect()
      const c = el.getBoundingClientRect()
      const d = flowPath(s.left + s.width / 2 - a.left, s.top - a.top, c.left + c.width / 2 - a.left, c.top + c.height / 2 - a.top)
      const key = `${seq}:${card.id}`
      setStreams((list) => [...list, { key, d, color: typeColorVar(card.tipo) }])
      later(() => land(el, card), FLOW_MS)
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
        land(el, card) // nunca mediu: aparece sem o fluxo, mas aparece
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
          <path className="pl-birth-comet" d={s.d} pathLength={1} />
          <circle className="pl-birth-spark" r={7}>
            <animateMotion dur={`${FLOW_MS}ms`} path={s.d} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.2 1" />
          </circle>
        </svg>
      ))}
      {builds.map((b) => {
        const per = 2 * (b.w + b.h) + 16
        return (
          <div
            key={b.key}
            className="pl-build"
            style={{ '--pl-flow': b.color, '--pl-per': per, left: b.x, top: b.y, width: b.w, height: b.h } as CSSProperties}
          >
            {/* O impacto: onde a faísca bateu, uma onda abre para fora do card. */}
            <span className="pl-build-ring" />
            <svg className="pl-build-trace" viewBox={`-4 -4 ${b.w + 8} ${b.h + 8}`}>
              <rect x={-2} y={-2} width={b.w + 4} height={b.h + 4} rx={12} />
            </svg>
            <svg className="pl-build-cursor" viewBox="0 0 16 16" width={20} height={20}>
              <path d="M2 1.5 13.5 8 8.2 9.3 5.6 14.5Z" />
            </svg>
          </div>
        )
      })}
    </div>
  )
}
