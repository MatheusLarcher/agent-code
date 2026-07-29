import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTrack, TrackStep } from '../agentTracks'
import { sortTracks } from '../agentTracks'
import { IconClose, IconSparkStar, IconSpinner, IconUsers } from './Icons'

/**
 * The flow view: the same tracks the panel lists, drawn as a map that grows.
 *
 * Left to right: you → the main agent → each subagent it spawned → the calls
 * each one made. Nodes appear as the work happens and the links draw themselves,
 * so a glance answers "who is doing what, and who spawned whom" — which a
 * vertical list can't show.
 */

interface Props {
  tracks: Record<string, AgentTrack>
  busy: boolean
  busySince: number | null
  /** Conversation title, shown on the root node. */
  title: string
  onClose: () => void
  /** Inside the side panel (no overlay, no header) instead of full screen —
   *  the chat has to stay usable while you watch the map. */
  embedded?: boolean
}

/** Geometry — one place, so nodes and links can never disagree.
 *  Four columns: seu pedido · agente principal · subagentes · ações.
 *  O layout embutido é mais apertado: no painel lateral, a versão larga só
 *  caberia cortando a coluna de ações, que é justamente o que interessa ver. */
const WIDE = { colX: [28, 268, 560, 900], nodeW: [204, 244, 296, 320] }
const TIGHT = { colX: [12, 176, 392, 668], nodeW: [152, 196, 256, 250] }
const ROW_H = 46
const TRACK_GAP = 34
const TOP = 36
/** Altura mínima de uma trilha: o card do subagente não pode encostar no vizinho. */
const TRACK_MIN_H = 58
/** Calls drawn per subagent (the newest ones) — the rest stays in the list. */
const STEPS_SHOWN = 5

interface Placed {
  track: AgentTrack
  y: number
  height: number
  steps: TrackStep[]
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s`
}

function stepLabel(step: TrackStep): string {
  const i = (step.input ?? {}) as Record<string, unknown>
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = i[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  const path = pick('file_path', 'path')
  const text = path ? path.split(/[\\/]/).slice(-1)[0] : pick('command', 'pattern', 'query', 'url') ?? ''
  const clean = text.replace(/\s+/g, ' ')
  return clean.length > 34 ? `${clean.slice(0, 33)}…` : clean
}

/** Curve from the right edge of one node to the left edge of the next. */
function link(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, (x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

export function AgentFlow({ tracks, busy, busySince, title, onClose, embedded = false }: Props): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // Encolhe o mapa para caber na largura disponível: numa janela estreita as
  // colunas da direita ficariam fora da tela e o "de cima" viraria "pedaço de".
  // Num painel estreito, o mapa corta a coluna de ações em vez de virar formiga.
  const [width, setWidth] = useState(0)
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const fit = (): void => setWidth(el.clientWidth)
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { colX: COL_X, nodeW: NODE_W } = embedded ? TIGHT : WIDE
  const fullWidth = COL_X[3] + NODE_W[3] + 40
  const compactWidth = COL_X[2] + NODE_W[2] + 40
  const fit = (w: number): number => (width === 0 ? 1 : Math.min(1, (width - 24) / w))
  // Legibilidade acima de completude: se caber tudo exigir encolher demais,
  // corta a coluna de ações em vez de deixar o texto do tamanho de formiga.
  const showSteps = fit(fullWidth) >= 0.8
  const stageWidth = showSteps ? fullWidth : compactWidth
  const scale = Math.max(0.55, fit(stageWidth))

  // Esc fecha — só no modo expandido; embutido, ele não está no caminho de nada
  // e Esc pertence ao que o usuário estiver fazendo no chat.
  useEffect(() => {
    if (embedded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, embedded])

  const placed = useMemo<Placed[]>(() => {
    let y = TOP
    return sortTracks(tracks).map((track) => {
      const steps = track.steps.slice(-STEPS_SHOWN)
      const height = Math.max(TRACK_MIN_H, steps.length * ROW_H)
      const item = { track, y, height, steps }
      y += height + TRACK_GAP
      return item
    })
  }, [tracks])

  const running = placed.filter((p) => p.track.status === 'running').length
  const totalHeight = (placed.at(-1)?.y ?? TOP) + (placed.at(-1)?.height ?? ROW_H) + 60
  const agentY = placed.length ? (TOP + totalHeight - 60) / 2 : TOP + 20

  const canvas = (
      <div className={`flow-canvas${embedded ? ' embedded' : ''}`} ref={canvasRef}>
        <div
          className="flow-stage"
          style={{
            height: totalHeight * scale,
            width: stageWidth * scale,
            ['--flow-scale' as string]: scale
          }}
        >
          <svg className="flow-links" width={stageWidth} height={totalHeight} aria-hidden="true">
            {/* seu pedido → agente principal */}
            <path className="flow-link" d={link(COL_X[0] + NODE_W[0], agentY + 26, COL_X[1], agentY + 26)} />
            {placed.map((p, i) => (
              <g key={p.track.id}>
                <path
                  className={`flow-link${p.track.status === 'running' ? ' live' : ''}`}
                  style={{ animationDelay: `${i * 0.06}s` }}
                  d={link(COL_X[1] + NODE_W[1], agentY + 26, COL_X[2], p.y + p.height / 2)}
                />
                {/* Sem a coluna de ações, a linha dela sobraria apontando pro vazio. */}
                {showSteps &&
                  p.steps.map((s, j) => (
                  <path
                    key={s.id}
                    className={`flow-link thin${s.endedAt ? '' : ' live'}`}
                    style={{ animationDelay: `${j * 0.05}s` }}
                    d={link(
                      COL_X[2] + NODE_W[2],
                      p.y + p.height / 2,
                      COL_X[3],
                      p.y + j * ROW_H + ROW_H / 2
                    )}
                  />
                  ))}
              </g>
            ))}
          </svg>

          {/* raiz: o pedido do usuário */}
          <article className="flow-node root" style={{ left: COL_X[0], top: agentY - 4, width: NODE_W[0] }}>
            <span className="flow-node-kind">Seu pedido</span>
            <span className="flow-node-label">{title}</span>
          </article>

          {/* agente principal */}
          <article
            className={`flow-node main ${busy ? 'running' : 'idle'}`}
            style={{ left: COL_X[1], top: agentY, width: NODE_W[1] }}
          >
            <span className="flow-node-mark">
              {busy ? <IconSpinner className="spinner" size={14} /> : <IconSparkStar size={14} />}
            </span>
            <span className="flow-node-body">
              <span className="flow-node-label">Agente principal</span>
              <span className="flow-node-meta">
                {busy ? (busySince ? fmt(now - busySince) : 'trabalhando') : 'ocioso'}
                {running > 0 && ` · ${running} delegado${running > 1 ? 's' : ''}`}
              </span>
            </span>
          </article>

          {/* subagentes + suas ações */}
          {placed.map((p) => (
            <div key={p.track.id}>
              <article
                className={`flow-node agent ${p.track.status}`}
                style={{ left: COL_X[2], top: p.y + p.height / 2 - 26, width: NODE_W[2] }}
              >
                <span className="flow-node-mark">
                  {p.track.status === 'running' ? (
                    <IconSpinner className="spinner" size={14} />
                  ) : (
                    <IconSparkStar size={14} />
                  )}
                </span>
                <span className="flow-node-body">
                  <span className="flow-node-label">{p.track.label}</span>
                  <span className="flow-node-meta">
                    {fmt((p.track.endedAt ?? now) - p.track.startedAt)} · {p.track.stepCount} ações
                  </span>
                </span>
              </article>

              {showSteps &&
                p.steps.map((s, j) => (
                  <article
                    key={s.id}
                    className={`flow-node step${s.isError ? ' error' : ''}${s.endedAt ? ' done' : ' running'}`}
                    style={{ left: COL_X[3], top: p.y + j * ROW_H, width: NODE_W[3] }}
                  >
                    <span className="flow-step-tool">{s.name}</span>
                    <span className="flow-step-detail">{stepLabel(s)}</span>
                  </article>
                ))}
            </div>
          ))}

          {placed.length === 0 && (
            <p className="flow-empty" style={{ left: COL_X[2], top: agentY }}>
              Ainda não há subagentes nesta conversa. Assim que o agente delegar algo, o mapa cresce
              sozinho a partir daqui.
            </p>
          )}
        </div>
      </div>
  )

  // Embutido no painel: só o mapa, sem overlay — o chat continua acessível.
  if (embedded) return canvas

  return (
    <div className="flow-overlay" role="dialog" aria-label="Fluxo dos agentes">
      <header className="flow-head">
        <span className="flow-title">
          <IconUsers size={16} />
          Fluxo dos agentes
        </span>
        {/* O nome da conversa já é o nó raiz do mapa — repetir aqui seria ruído. */}
        <span className="flow-counts">
          {running > 0 ? `${running} trabalhando` : `${placed.length} no total`}
        </span>
        <button type="button" className="nav-btn" onClick={onClose} title="Fechar (Esc)">
          <IconClose />
        </button>
      </header>
      {canvas}
    </div>
  )
}
