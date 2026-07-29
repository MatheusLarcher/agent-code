import { useEffect, useRef, useState } from 'react'
import type { ProjectNode } from '@shared/ipc'
import type { Touch } from '../projectActivity'
import type { TodoItem } from '../types'
import {
  advancePhases,
  bounds,
  buildGraph,
  ensureNode,
  pathToNode,
  stepPhysics,
  type Graph,
  type GraphNode
} from '../projectGraph'

/**
 * The project map: the repo's most recently touched files as a graph that
 * lights up where the agent is working.
 *
 * Folders are dots with a name, files are smaller dots. When a call happens, a
 * glowing head travels the REAL tree route (root → folder → … → file) and only
 * lights the node when it arrives — so the line is the story, not decoration.
 * The node then cools down slowly, which turns a session into a heat map of the
 * area of the project that moved.
 *
 * Files have a life on screen too: one the agent touches from outside the
 * "recent" list flies IN from the back, a created file assembles from
 * fragments, and a deleted one breaks apart before leaving.
 *
 * Everything animated lives in refs and is drawn on a canvas: re-rendering
 * React per frame is not an option.
 */

interface Props {
  entries: ProjectNode[]
  /** Every tool call of the conversation, oldest first (see projectActivity). */
  touches: Touch[]
  /** Paths confirmed DELETED from disk (never "just fell out of the ranking"). */
  missing?: string[]
  /** The agent's current plan — shown as a strip above the map. */
  steps?: TodoItem[]
  /** Project folder name, shown on the root node. */
  rootName: string
  /** True when the project has more files than the map is showing. */
  truncated?: boolean
  embedded?: boolean
}

const COOL = 0.9993 // heat decay per frame → ~16s half-life
const TRAVEL_MS = 1800
const SAY_MAX = 38
const OK = '#7fae6f'
const ERR = '#d97070'
/** Shards drawn for the assemble/destroy animations. */
const SHARDS = 7

interface Travel {
  route: GraphNode[]
  t: number
  tool: string
  say: string
  isError: boolean
  added?: number
  removed?: number
}

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

function mix(c1: string, c2: string, t: number): string {
  const p = (h: string): number[] => [
    parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)
  ]
  const A = p(c1)
  const B = p(c2)
  const k = Math.max(0, Math.min(1, t))
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`
}

/** Tools that bring a file into existence — those assemble instead of arriving. */
const CREATING = new Set(['Write', 'NotebookEdit'])

export function ProjectGraph({
  entries,
  touches,
  missing,
  steps,
  rootName,
  truncated,
  embedded
}: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [stepsOpen, setStepsOpen] = useState(true)
  const graphRef = useRef<Graph | null>(null)
  const travels = useRef<Travel[]>([])
  const seen = useRef<Set<string>>(new Set())
  const view = useRef({ scale: 1, x: 0, y: 0, fitted: false })
  const alpha = useRef(0.5)

  // Build once, then RECONCILE. Rebuilding on every refresh would reset every
  // position and the map would jump on screen each time the tree is re-read.
  useEffect(() => {
    const g = graphRef.current
    if (!g || g.root.name !== rootName) {
      graphRef.current = buildGraph(entries, rootName)
      travels.current = []
      seen.current = new Set()
      view.current.fitted = false
      alpha.current = 0.5
      return
    }
    for (const e of entries) {
      if (!g.byPath.has(e.path)) {
        // Showed up in a refresh, so it was just created on disk.
        ensureNode(g, e.path, e.isDir, e.isDir ? 'arriving' : 'building')
        alpha.current = Math.max(alpha.current, 0.2)
      }
    }
  }, [entries, rootName])

  // Deletions are reported explicitly by the main process (see ProjectTree.missing)
  // rather than inferred from "not in the list any more" — a file can leave the
  // recency ranking while sitting right there on disk, and blowing it up would
  // be a lie.
  useEffect(() => {
    const g = graphRef.current
    if (!g || !missing?.length) return
    for (const path of missing) {
      const n = g.byPath.get(path)
      if (n && n.phase !== 'dying') {
        n.phase = 'dying'
        n.phaseT = 0
      }
    }
  }, [missing])

  // New calls → launch a travel. Calls already on screen when the view opens are
  // marked seen and given decaying heat instead, so switching to this tab
  // mid-session shows the recent work rather than replaying the whole session.
  useEffect(() => {
    const g = graphRef.current
    if (!g) return
    const fresh = touches.filter((t) => !seen.current.has(t.id))
    if (!fresh.length) return
    const first = seen.current.size === 0
    fresh.forEach((t, i) => {
      seen.current.add(t.id)
      let node = t.path != null ? g.byPath.get(t.path) : g.root
      if (!node) {
        // Outside the recent-files filter (or brand new): put it on the map.
        node =
          t.path != null
            ? ensureNode(g, t.path, false, CREATING.has(t.tool) ? 'building' : 'arriving')
            : g.root
        alpha.current = Math.max(alpha.current, 0.3)
      }
      if (first) {
        const fromEnd = fresh.length - 1 - i
        if (fromEnd < 10) {
          node.heat = Math.max(node.heat, 1 - fromEnd * 0.1)
          node.tool = t.tool
          node.say = t.detail
          node.isError = t.isError
          node.added = t.added
          node.removed = t.removed
        }
        return
      }
      travels.current.push({
        route: pathToNode(node),
        t: 0,
        tool: t.tool,
        say: t.detail,
        isError: t.isError,
        added: t.added,
        removed: t.removed
      })
    })
    alpha.current = Math.max(alpha.current, 0.25)
  }, [touches])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let w = 0
    let h = 0

    const resize = (): void => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      view.current.fitted = false
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(canvas)

    const fit = (g: Graph): void => {
      const b = bounds(g)
      const gw = Math.max(1, b.maxX - b.minX)
      const gh = Math.max(1, b.maxY - b.minY)
      const s = Math.min(1.6, Math.min((w - 80) / gw, (h - 80) / gh))
      view.current.scale = Math.max(0.12, s)
      view.current.x = w / 2 - ((b.minX + b.maxX) / 2) * view.current.scale
      view.current.y = h / 2 - ((b.minY + b.maxY) / 2) * view.current.scale
    }

    const radius = (n: GraphNode): number => {
      const base = n.path === '' ? 8 : n.isDir ? 5.5 : 3.6
      return base + n.heat * 8
    }

    const shortSay = (s: string): string => (s.length > SAY_MAX ? `${s.slice(0, SAY_MAX - 1)}…` : s)

    interface Box { x: number; y: number; w: number; h: number }
    const overlaps = (a: Box, b: Box): boolean =>
      a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x && a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y

    const drawBalloon = (n: GraphNode, sx: number, sy: number, placed: Box[]): void => {
      const a = Math.min(1, (n.heat - 0.3) / 0.4)
      if (a <= 0 || !n.say) return
      const tone = n.isError ? ERR : OK
      const tool = n.tool ?? ''
      const txt = shortSay(n.say)
      // `+N` / `−M` of an Edit, same rule as the chat's tool card: green for
      // added, red for removed, and a zero is simply not shown.
      const plus = n.added ? `+${n.added}` : ''
      const minus = n.removed ? `−${n.removed}` : ''
      ctx.font = '700 10px system-ui'
      const wTool = ctx.measureText(tool).width
      ctx.font = '400 11.5px ui-monospace, Consolas, monospace'
      const wTxt = ctx.measureText(txt).width
      ctx.font = '600 11px ui-monospace, Consolas, monospace'
      const wPlus = plus ? ctx.measureText(plus).width + 6 : 0
      const wMinus = minus ? ctx.measureText(minus).width + 6 : 0
      const padX = 9
      const bw = Math.max(wTool + wTxt + wPlus + wMinus + padX * 2 + 8, 90)
      const bh = 30
      const r = 9
      let x = sx + radius(n) * view.current.scale + 14
      let y = sy - bh - 12
      if (x + bw > w - 10) x = sx - radius(n) * view.current.scale - 14 - bw
      if (y < 6) y = sy + radius(n) * view.current.scale + 14
      for (let i = 0; i < 8; i++) {
        const box = { x, y, w: bw, h: bh }
        const clash = placed.find((p) => overlaps(box, p))
        if (!clash) break
        y = clash.y - bh - 8
        if (y < 6) y = clash.y + clash.h + 8
      }
      placed.push({ x, y, w: bw, h: bh })

      ctx.globalAlpha = a
      ctx.fillStyle = 'rgba(48,46,44,.94)'
      const side = x > sx ? 1 : -1
      ctx.beginPath(); ctx.arc(sx + side * 6, sy - 8, 3.2, 0, 7); ctx.fill()
      ctx.beginPath(); ctx.arc(sx + side * 12, sy - 14, 2.1, 0, 7); ctx.fill()
      ctx.beginPath()
      ctx.moveTo(x + r, y)
      ctx.arcTo(x + bw, y, x + bw, y + bh, r)
      ctx.arcTo(x + bw, y + bh, x, y + bh, r)
      ctx.arcTo(x, y + bh, x, y, r)
      ctx.arcTo(x, y, x + bw, y, r)
      ctx.closePath()
      ctx.fill()
      ctx.strokeStyle = n.isError ? 'rgba(217,112,112,.6)' : 'rgba(127,174,111,.55)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.textAlign = 'left'
      ctx.font = '700 10px system-ui'
      ctx.fillStyle = tone
      ctx.fillText(tool, x + padX, y + 13)
      ctx.font = '400 11.5px ui-monospace, Consolas, monospace'
      ctx.fillStyle = '#cfcbc5'
      ctx.fillText(txt, x + padX, y + 24)
      if (plus || minus) {
        let dx = x + padX + wTxt + 6
        ctx.font = '600 11px ui-monospace, Consolas, monospace'
        if (plus) {
          ctx.fillStyle = OK
          ctx.fillText(plus, dx, y + 24)
          dx += wPlus
        }
        if (minus) {
          ctx.fillStyle = ERR
          ctx.fillText(minus, dx, y + 24)
        }
      }
      ctx.globalAlpha = 1
    }

    /** Shards for the build/destroy animations: same seed in, same shape out. */
    const shards = (n: GraphNode, sx: number, sy: number, dist: number, a: number, size: number): void => {
      let hsh = 0
      for (let k = 0; k < n.path.length; k++) hsh = (hsh * 31 + n.path.charCodeAt(k)) | 0
      ctx.globalAlpha = a
      ctx.fillStyle = OK
      for (let i = 0; i < SHARDS; i++) {
        const ang = (i / SHARDS) * Math.PI * 2 + ((hsh >>> 0) % 100) / 100
        ctx.beginPath()
        ctx.arc(sx + Math.cos(ang) * dist, sy + Math.sin(ang) * dist, size, 0, 7)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    const drawTravel = (tr: Travel): void => {
      const { scale, x: ox, y: oy } = view.current
      const p = tr.route
      if (p.length < 2) return
      const lens: number[] = []
      for (let i = 0; i < p.length - 1; i++) {
        lens.push(Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y))
      }
      const total = lens.reduce((a, b) => a + b, 0) || 1
      const prog = easeInOut(Math.min(1, tr.t)) * total
      const tone = tr.isError ? ERR : OK

      ctx.strokeStyle = tr.isError ? 'rgba(217,112,112,.85)' : 'rgba(127,174,111,.85)'
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.shadowColor = tone
      ctx.shadowBlur = 10
      let acc = 0
      let hx = p[0].x
      let hy = p[0].y
      ctx.beginPath()
      ctx.moveTo(p[0].x * scale + ox, p[0].y * scale + oy)
      for (let i = 0; i < lens.length; i++) {
        const a = p[i]
        const b = p[i + 1]
        const L = lens[i]
        if (prog >= acc + L) {
          ctx.lineTo(b.x * scale + ox, b.y * scale + oy)
          hx = b.x
          hy = b.y
        } else {
          const k = Math.max(0, (prog - acc) / L)
          hx = a.x + (b.x - a.x) * k
          hy = a.y + (b.y - a.y) * k
          ctx.lineTo(hx * scale + ox, hy * scale + oy)
          break
        }
        acc += L
      }
      ctx.stroke()
      ctx.shadowBlur = 0

      const sx = hx * scale + ox
      const sy = hy * scale + oy
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, 11)
      grd.addColorStop(0, tr.isError ? 'rgba(240,190,190,.95)' : 'rgba(190,230,175,.95)')
      grd.addColorStop(1, 'rgba(127,174,111,0)')
      ctx.beginPath(); ctx.arc(sx, sy, 11, 0, 7); ctx.fillStyle = grd; ctx.fill()
      ctx.beginPath(); ctx.arc(sx, sy, 2.8, 0, 7); ctx.fillStyle = '#e8f3e0'; ctx.fill()
    }

    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const graph = graphRef.current
      if (!graph) return

      if (!view.current.fitted && graph.nodes.length) {
        // The radial seed is already open, so this only relaxes it — and it runs
        // BEFORE fitting, otherwise the frame would be computed for a layout
        // that then moves out of it.
        for (let i = 0; i < 60; i++) stepPhysics(graph, w, h, 0.5)
        fit(graph)
        view.current.fitted = true
      }

      for (let i = travels.current.length - 1; i >= 0; i--) {
        const tr = travels.current[i]
        tr.t += 16 / TRAVEL_MS
        if (tr.t >= 1) {
          const n = tr.route[tr.route.length - 1]
          n.heat = 1
          n.tool = tr.tool
          n.say = tr.say
          n.isError = tr.isError
          n.added = tr.added
          n.removed = tr.removed
          travels.current.splice(i, 1)
        }
      }

      // Lifecycle phases; a node that finished dying leaves the graph for good.
      advancePhases(graph, 16)

      if (alpha.current > 0.02) {
        stepPhysics(graph, w, h, alpha.current)
        alpha.current *= 0.99
      }
      for (const n of graph.nodes) n.heat *= COOL

      const { scale, x: ox, y: oy } = view.current
      ctx.clearRect(0, 0, w, h)

      // Cold edges in ONE path: a stroke() per edge is the thing that makes a
      // graph this size crawl.
      ctx.strokeStyle = 'rgba(58,56,54,.7)'
      ctx.lineWidth = 0.8
      ctx.beginPath()
      for (const l of graph.links) {
        if (Math.max(l.a.heat, l.b.heat) > 0.05) continue
        if (l.b.phase === 'building' || l.b.phase === 'arriving') continue
        ctx.moveTo(l.a.x * scale + ox, l.a.y * scale + oy)
        ctx.lineTo(l.b.x * scale + ox, l.b.y * scale + oy)
      }
      ctx.stroke()

      for (const l of graph.links) {
        const heat = Math.max(l.a.heat, l.b.heat)
        if (heat <= 0.05) continue
        ctx.strokeStyle = `rgba(127,174,111,${0.15 + heat * 0.5})`
        ctx.lineWidth = 1 + heat * 1.6
        ctx.beginPath()
        ctx.moveTo(l.a.x * scale + ox, l.a.y * scale + oy)
        ctx.lineTo(l.b.x * scale + ox, l.b.y * scale + oy)
        ctx.stroke()
      }

      const pulse = Date.now() / 1000
      for (const n of graph.nodes) {
        const sx = n.x * scale + ox
        const sy = n.y * scale + oy
        if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue
        const baseR = radius(n) * Math.max(0.6, Math.min(1.4, scale))
        const tone = n.isError ? ERR : OK

        // --- lifecycle: born, arriving, destroyed ---
        if (n.phase === 'building') {
          const t = n.phaseT
          // Fragments converge, then fuse into the dot in the last stretch.
          shards(n, sx, sy, (1 - easeOut(t)) * 26, Math.min(1, t * 2) * (1 - t * 0.5), 1.8)
          const grow = t < 0.6 ? 0 : (t - 0.6) / 0.4
          if (grow > 0) {
            ctx.beginPath()
            ctx.arc(sx, sy, baseR * grow, 0, 7)
            ctx.fillStyle = mix('#4a4744', OK, 1 - grow * 0.4)
            ctx.fill()
          }
          continue
        }
        if (n.phase === 'dying') {
          const t = n.phaseT
          shards(n, sx, sy, easeOut(t) * 30, 1 - t, 1.8)
          ctx.beginPath()
          ctx.arc(sx, sy, baseR * (1 - t), 0, 7)
          ctx.fillStyle = `rgba(217,112,112,${1 - t})`
          ctx.fill()
          continue
        }

        // "Coming from the back": starts big, faint and blurred, settling in.
        let scaleMul = 1
        let fade = 1
        if (n.phase === 'arriving') {
          const t = easeOut(n.phaseT)
          scaleMul = 1 + (1 - t) * 5
          fade = Math.min(1, n.phaseT * 1.6)
        }
        const r = baseR * scaleMul

        if (n.heat > 0.04) {
          const p = 1 + Math.sin(pulse * 3.2) * 0.22
          ctx.beginPath()
          ctx.arc(sx, sy, r + 9 * n.heat * p, 0, 7)
          ctx.fillStyle = n.isError
            ? `rgba(217,112,112,${0.13 * n.heat})`
            : `rgba(127,174,111,${0.13 * n.heat})`
          ctx.fill()
        }
        ctx.globalAlpha = fade
        ctx.beginPath()
        ctx.arc(sx, sy, r, 0, 7)
        ctx.fillStyle = n.isDir
          ? mix('#8a5a44', tone, n.heat)
          : mix('#4a4744', tone, Math.min(1, n.heat * 1.5))
        ctx.fill()
        ctx.globalAlpha = 1

        const hasBalloon = n.heat > 0.3 && !!n.say
        // The top of the tree is always named: zoomed out to fit a narrow panel
        // the scale is well under 0.35, and a map of anonymous dots tells you
        // nothing about WHERE in the project the agent is working.
        const showLabel =
          !hasBalloon && n.phase === 'idle' && (n.isDir ? n.depth <= 2 || scale > 0.5 : n.heat > 0.12)
        if (showLabel) {
          ctx.font = n.isDir ? '600 11.5px system-ui' : '400 11px system-ui'
          ctx.textAlign = 'center'
          ctx.fillStyle =
            n.heat > 0.12 ? mix('#a3a09b', '#cfe7c4', n.heat) : 'rgba(163,160,155,.75)'
          ctx.fillText(n.name, sx, sy - r - 6)
        }
      }

      travels.current.forEach(drawTravel)

      const placed: Box[] = []
      graph.nodes
        .filter((n) => n.heat > 0.3 && n.say && n.phase !== 'dying')
        .sort((a, b) => b.heat - a.heat)
        .slice(0, 3)
        .forEach((n) => drawBalloon(n, n.x * scale + ox, n.y * scale + oy, placed))
    }
    raf = requestAnimationFrame(frame)

    // Pan and zoom: the fitted view is dense, so being able to get closer is
    // what makes the map readable rather than decorative.
    let dragging = false
    let lastX = 0
    let lastY = 0
    const onDown = (e: MouseEvent): void => { dragging = true; lastX = e.clientX; lastY = e.clientY }
    const onMove = (e: MouseEvent): void => {
      if (!dragging) return
      view.current.x += e.clientX - lastX
      view.current.y += e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
    }
    const onUp = (): void => { dragging = false }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const k = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const next = Math.max(0.08, Math.min(4, view.current.scale * k))
      const ratio = next / view.current.scale
      view.current.x = mx - (mx - view.current.x) * ratio
      view.current.y = my - (my - view.current.y) * ratio
      view.current.scale = next
    }
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [])

  const done = steps?.filter((s) => s.status === 'completed').length ?? 0

  return (
    <div className={`pgraph${embedded ? ' embedded' : ''}`}>
      {!!steps?.length && (
        <div
          className={`pgraph-steps${stepsOpen ? '' : ' mini'}`}
          role="button"
          tabIndex={0}
          aria-expanded={stepsOpen}
          aria-label={stepsOpen ? 'Minimizar as etapas' : 'Mostrar as etapas'}
          title={stepsOpen ? 'Minimizar as etapas' : 'Mostrar as etapas'}
          onClick={() => setStepsOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setStepsOpen((v) => !v)
            }
          }}
        >
          <span className="pgraph-steps-count">
            {done}/{steps.length}
          </span>
          <ol>
            {steps.map((s, i) => (
              <li key={`${s.id ?? i}-${s.content}`} className={s.status}>
                <i aria-hidden="true" />
                {/* Minimizado, só as bolinhas ficam — o texto sai do DOM em vez
                    de ser escondido, senão continuaria sendo lido em voz alta e
                    encontrado pela busca da página. */}
                {stepsOpen && (
                  <span>{s.status === 'in_progress' ? s.activeForm || s.content : s.content}</span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      <canvas ref={canvasRef} className="pgraph-canvas" />
      {entries.length === 0 && <p className="pgraph-empty">Lendo os arquivos do projeto…</p>}
      <div className="pgraph-legend">
        <span><i className="dot live" />mexendo agora</span>
        <span><i className="dot warm" />mexeu há pouco</span>
        <span><i className="dot file" />arquivo</span>
        <span><i className="dot dir" />pasta</span>
        {truncated && <span className="pgraph-warn">100 mais recentes</span>}
        {touches.length > 0 && <span className="pgraph-count">{touches.length} ações</span>}
      </div>
    </div>
  )
}
