import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectNode } from '@shared/ipc'
import { actionColor, actionKind, fileType, type ActionKind, type Touch, type Turn } from '../projectActivity'
import type { TodoItem } from '../types'
import { ProjectFilters } from './ProjectFilters'
import {
  addMark,
  advancePhases,
  bounds,
  buildGraph,
  ensureNode,
  markFor,
  pathToNode,
  stepPhysics,
  type Graph,
  type GraphNode,
  type NodeMark
} from '../projectGraph'

/**
 * The project map: the repo's most recently touched files as a graph that
 * lights up where the agent is working.
 *
 * Folders are dots with a name, files are smaller dots. When a call happens, a
 * glowing head travels the REAL tree route (root → folder → … → file) and only
 * lights the node when it arrives — so the line is the story, not decoration.
 *
 * What the agent touched stays lit FOREVER, in the colour of the action (read,
 * edit, create, run…), with the file's name next to it: the map is the history
 * of the session, not a heat map that erases itself. The old fading is now only
 * a pulse on what is happening right now. To read one step at a time, the
 * filter bar follows a single message the user sent (`turnId`), and the file
 * type chips take out whatever you don't want to see.
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
  /** The user's messages that produced work — the "follow one step" filter. */
  turns: Turn[]
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

/**
 * Heat decay per frame (~4s half-life). Heat is now ONLY the "this is happening
 * now" pulse — it no longer decides whether a node is lit, so it can fade fast
 * without erasing anything: the mark underneath stays.
 */
const COOL = 0.997
/**
 * The balloon's own life, in ms. The lit node and the file's name are what
 * stays; the balloon is the running commentary ("Bash npm test"), and letting
 * it sit meant three stale balloons parked over the map while the agent had
 * already moved on. So it snaps in, is readable for a beat, and fades out.
 */
const SAY_IN = 160
const SAY_HOLD = 2100
const SAY_OUT = 700
const SAY_LIFE = SAY_IN + SAY_HOLD + SAY_OUT
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
  /** Message that caused it — stamped on the node when the head arrives. */
  turnId: string
  say: string
  isError: boolean
  added?: number
  removed?: number
  /** Second leg of a `Read`: the paper coming back to the agent. */
  back?: boolean
}

/** Tools whose call goes out AND brings something back (see RETURN_MS). */
const FETCHING = new Set(['Read'])
/** How long the paper takes to come back — quicker than going, it's a reply. */
const RETURN_MS = 1200

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3)

/**
 * Parse `#rrggbb` OR `rgb(r,g,b)`.
 *
 * Accepting its own output matters: `mix()` calls are nested (blink over heat
 * over base colour), and a hex-only parser turned the inner `rgb(...)` into
 * `rgb(NaN,NaN,NaN)`. Canvas silently IGNORES an invalid fillStyle and keeps
 * the previous one, so nodes were painted with the leftover colour of the last
 * label drawn — that is how every folder quietly lost its orange, with no error
 * anywhere.
 */
function parseColor(c: string): [number, number, number] {
  if (c.startsWith('#')) {
    return [
      parseInt(c.slice(1, 3), 16),
      parseInt(c.slice(3, 5), 16),
      parseInt(c.slice(5, 7), 16)
    ]
  }
  const m = c.match(/-?\d+(\.\d+)?/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0]
}

function mix(c1: string, c2: string, t: number): string {
  const A = parseColor(c1)
  const B = parseColor(c2)
  const k = Math.max(0, Math.min(1, t))
  return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`
}

/** Tools that bring a file into existence — those assemble instead of arriving. */
const CREATING = new Set(['Write', 'NotebookEdit'])

/** Where the "I don't want to see this" choices are remembered between sessions. */
const HIDDEN_TYPES_KEY = 'agentcode.pgraph.hidden-types.v1'
const HIDDEN_KINDS_KEY = 'agentcode.pgraph.hidden-kinds.v1'

export function ProjectGraph({
  entries,
  touches,
  turns,
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

  // Which message the map is following (null = the whole session) and which file
  // types are switched off. The canvas loop reads them through refs: it runs at
  // 60fps and must not be re-created every time a chip is clicked.
  const [turnId, setTurnId] = useState<string | null>(null)
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set())
  const [hiddenKinds, setHiddenKinds] = useState<Set<ActionKind>>(new Set())
  const turnRef = useRef<string | null>(null)
  turnRef.current = turnId
  const hiddenRef = useRef<Set<string>>(hiddenTypes)
  hiddenRef.current = hiddenTypes
  const kindsRef = useRef<Set<ActionKind>>(hiddenKinds)
  kindsRef.current = hiddenKinds

  // The chosen message can vanish (conversation switched, history compacted) —
  // following an id that no longer exists would blank the map with no way back.
  useEffect(() => {
    if (turnId && !turns.some((t) => t.id === turnId)) setTurnId(null)
  }, [turns, turnId])

  useEffect(() => {
    void (async () => {
      try {
        const [rawTypes, rawKinds] = await Promise.all([
          window.api.kvGet(HIDDEN_TYPES_KEY),
          window.api.kvGet(HIDDEN_KINDS_KEY)
        ])
        if (rawTypes) setHiddenTypes(new Set(JSON.parse(rawTypes) as string[]))
        if (rawKinds) setHiddenKinds(new Set(JSON.parse(rawKinds) as ActionKind[]))
      } catch {
        /* nothing saved yet (or unreadable) — start showing everything */
      }
    })()
  }, [])

  const persistHidden = (next: Set<string>): void => {
    setHiddenTypes(next)
    void window.api.kvSet(HIDDEN_TYPES_KEY, JSON.stringify([...next])).catch(() => undefined)
  }

  const persistKinds = (next: Set<ActionKind>): void => {
    setHiddenKinds(next)
    void window.api.kvSet(HIDDEN_KINDS_KEY, JSON.stringify([...next])).catch(() => undefined)
  }

  // File types present in the map, most frequent first — the chips the user
  // switches off.
  const types = useMemo(() => {
    const count = new Map<string, number>()
    for (const e of entries) {
      if (e.isDir) continue
      const t = fileType(e.path)
      count.set(t, (count.get(t) ?? 0) + 1)
    }
    return [...count.entries()]
      .map(([type, n]) => ({ type, count: n }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  }, [entries])

  // Under a message filter, the counter and the legend describe THAT step —
  // saying "312 ações" while the map shows the 4 of the selected message would
  // just be wrong.
  const shownTouches = useMemo(() => {
    const byTurn = turnId ? touches.filter((t) => t.turnId === turnId) : touches
    return hiddenKinds.size
      ? byTurn.filter((t) => !hiddenKinds.has(t.isError ? 'error' : actionKind(t.tool)))
      : byTurn
  }, [touches, turnId, hiddenKinds])

  // The legend (which doubles as the "kind of change" filter) lists every kind
  // present in the selected step — including the ones switched off, otherwise
  // there would be no way to switch them back on.
  const kinds = useMemo(() => {
    const set = new Set<ActionKind>()
    const scope = turnId ? touches.filter((t) => t.turnId === turnId) : touches
    for (const t of scope) set.add(t.isError ? 'error' : actionKind(t.tool))
    return [...set]
  }, [touches, turnId])

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
        // Opening the tab mid-session: no replay, but every past call still
        // marks its node — that history is exactly what the map is for now.
        const fromEnd = fresh.length - 1 - i
        addMark(node, t.turnId, t.tool, t.isError, Date.now() - fromEnd)
        if (fromEnd < 10) {
          node.heat = Math.max(node.heat, 1 - fromEnd * 0.1)
          node.tool = t.tool
          node.say = t.detail
          node.isError = t.isError
          node.added = t.added
          node.removed = t.removed
          node.sayAt = Date.now() - fromEnd * 400
        }
        return
      }
      travels.current.push({
        route: pathToNode(node),
        t: 0,
        tool: t.tool,
        turnId: t.turnId,
        say: t.detail,
        isError: t.isError,
        added: t.added,
        removed: t.removed
      })
    })
    // De propósito NÃO acorda a física aqui. Um empurrão de alpha por chamada
    // fazia o mapa inteiro se remexer enquanto o agente trabalha — os galhos
    // "abrindo" a cada ação. O layout agora fica parado; quem se mexe é só o
    // nó que está piscando. A física só volta quando a ÁRVORE muda (arquivo
    // criado/apagado), onde há de fato geometria nova para acomodar.
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
      // A touched file keeps a slightly bigger dot for good — with the whole
      // session lit, size is what separates "the agent worked here" from the
      // hundreds of files that merely exist.
      return base + (n.marks.length ? 1.6 : 0) + n.heat * 8
    }

    /**
     * Files of a type the user switched off simply aren't drawn (folders always
     * are — hiding a branch's parent would leave its children floating).
     */
    const isHidden = (n: GraphNode): boolean =>
      !n.isDir && hiddenRef.current.size > 0 && hiddenRef.current.has(fileType(n.path))

    const shortSay = (s: string): string => (s.length > SAY_MAX ? `${s.slice(0, SAY_MAX - 1)}…` : s)

    interface Box { x: number; y: number; w: number; h: number }
    const overlaps = (a: Box, b: Box): boolean =>
      a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x && a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y

    const sayAlpha = (n: GraphNode, now: number): number => {
      if (!n.say || !n.sayAt) return 0
      const age = now - n.sayAt
      if (age >= SAY_LIFE) return 0
      if (age < SAY_IN) return age / SAY_IN
      if (age < SAY_IN + SAY_HOLD) return 1
      return 1 - (age - SAY_IN - SAY_HOLD) / SAY_OUT
    }

    const drawBalloon = (n: GraphNode, sx: number, sy: number, placed: Box[], now: number): void => {
      const a = sayAlpha(n, now)
      if (a <= 0 || !n.say) return
      // Sobe um tiquinho enquanto apaga — dá a leitura de "passou" em vez de
      // simplesmente desligar.
      sy -= (1 - a) * 10
      const tone = actionColor(n.tool ?? '', n.isError)
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
      ctx.strokeStyle = tone
      ctx.globalAlpha = a * 0.55
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.globalAlpha = a
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

    /** Segment lengths of a route + the total, used by both legs of a travel. */
    const metrics = (p: GraphNode[]): { lens: number[]; total: number } => {
      const lens: number[] = []
      for (let i = 0; i < p.length - 1; i++) {
        lens.push(Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y))
      }
      return { lens, total: lens.reduce((a, b) => a + b, 0) || 1 }
    }

    /** Point at `dist` along the route (graph coords). */
    const pointAt = (p: GraphNode[], lens: number[], dist: number): { x: number; y: number } => {
      let acc = 0
      for (let i = 0; i < lens.length; i++) {
        if (dist <= acc + lens[i]) {
          const k = lens[i] === 0 ? 0 : (dist - acc) / lens[i]
          return { x: p[i].x + (p[i + 1].x - p[i].x) * k, y: p[i].y + (p[i + 1].y - p[i].y) * k }
        }
        acc += lens[i]
      }
      const last = p[p.length - 1]
      return { x: last.x, y: last.y }
    }

    /**
     * The sheet of paper a `Read` carries back to the agent. Drawn at a fixed
     * screen size (not scaled with the graph) so it stays recognisable as an
     * object even when the map is zoomed way out.
     */
    const drawPaper = (sx: number, sy: number, a: number, tone: string): void => {
      const w2 = 9
      const h2 = 12
      const fold = 4
      ctx.globalAlpha = a
      ctx.shadowColor = tone
      ctx.shadowBlur = 8
      ctx.beginPath()
      ctx.moveTo(sx - w2 / 2, sy - h2 / 2)
      ctx.lineTo(sx + w2 / 2 - fold, sy - h2 / 2)
      ctx.lineTo(sx + w2 / 2, sy - h2 / 2 + fold)
      ctx.lineTo(sx + w2 / 2, sy + h2 / 2)
      ctx.lineTo(sx - w2 / 2, sy + h2 / 2)
      ctx.closePath()
      ctx.fillStyle = '#eceff2'
      ctx.fill()
      ctx.shadowBlur = 0
      // dobra da quina
      ctx.beginPath()
      ctx.moveTo(sx + w2 / 2 - fold, sy - h2 / 2)
      ctx.lineTo(sx + w2 / 2 - fold, sy - h2 / 2 + fold)
      ctx.lineTo(sx + w2 / 2, sy - h2 / 2 + fold)
      ctx.closePath()
      ctx.fillStyle = mix(tone, '#ffffff', 0.35)
      ctx.fill()
      // linhas de texto
      ctx.strokeStyle = 'rgba(70,80,95,.75)'
      ctx.lineWidth = 1
      for (let i = 0; i < 3; i++) {
        const ly = sy - 2.5 + i * 3
        ctx.beginPath()
        ctx.moveTo(sx - w2 / 2 + 2, ly)
        ctx.lineTo(sx + w2 / 2 - 2, ly)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    /** The return leg of a Read: the paper gliding back to the agent (root). */
    const drawReturn = (tr: Travel): void => {
      const { scale, x: ox, y: oy } = view.current
      const p = tr.route
      if (p.length < 2) return
      const { lens, total } = metrics(p)
      const e = easeInOut(Math.min(1, tr.t))
      const tone = actionColor(tr.tool, tr.isError)
      // Anda do arquivo DE VOLTA até a raiz.
      const pt = pointAt(p, lens, total * (1 - e))
      const sx = pt.x * scale + ox
      const sy = pt.y * scale + oy

      // rastro curto atrás do papel, pra leitura de movimento
      const tailPt = pointAt(p, lens, Math.min(total, total * (1 - e) + 26))
      ctx.strokeStyle = tone
      ctx.globalAlpha = 0.35
      ctx.lineWidth = 1.4
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(tailPt.x * scale + ox, tailPt.y * scale + oy)
      ctx.lineTo(sx, sy)
      ctx.stroke()
      ctx.globalAlpha = 1

      // some nos últimos 15% (chegou no agente, entregou)
      drawPaper(sx, sy, e > 0.85 ? (1 - e) / 0.15 : Math.min(1, tr.t * 6), tone)
    }

    const drawTravel = (tr: Travel): void => {
      if (tr.back) return drawReturn(tr)
      const { scale, x: ox, y: oy } = view.current
      const p = tr.route
      if (p.length < 2) return
      const { lens, total } = metrics(p)
      const prog = easeInOut(Math.min(1, tr.t)) * total
      const tone = actionColor(tr.tool, tr.isError)

      ctx.strokeStyle = tone
      ctx.globalAlpha = 0.85
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
      ctx.globalAlpha = 1

      const sx = hx * scale + ox
      const sy = hy * scale + oy
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, 11)
      grd.addColorStop(0, mix(tone, '#ffffff', 0.55))
      grd.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.beginPath(); ctx.arc(sx, sy, 11, 0, 7); ctx.fillStyle = grd; ctx.fill()
      ctx.beginPath(); ctx.arc(sx, sy, 2.8, 0, 7); ctx.fillStyle = mix(tone, '#ffffff', 0.75); ctx.fill()
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
        tr.t += 16 / (tr.back ? RETURN_MS : TRAVEL_MS)
        if (tr.t < 1) continue
        if (tr.back) {
          // O papel chegou no agente: fim da viagem.
          travels.current.splice(i, 1)
          continue
        }
        const n = tr.route[tr.route.length - 1]
        addMark(n, tr.turnId, tr.tool, tr.isError, Date.now())
        n.heat = 1
        n.tool = tr.tool
        n.say = tr.say
        n.isError = tr.isError
        n.added = tr.added
        n.removed = tr.removed
        n.sayAt = Date.now()
        if (FETCHING.has(tr.tool) && !tr.isError) {
          // Ler não é só ir até o arquivo: o agente TRAZ o conteúdo de volta.
          // A segunda perna carrega uma folha de papel do arquivo até a raiz,
          // que é o que diferencia um Read de um Edit no mapa.
          tr.back = true
          tr.t = 0
        } else {
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

      // Every edge in ONE path, all the same cold grey. Edges used to light up
      // green around a hot node, which made the work look like it was BLEEDING
      // out into the branches; the only coloured line on the map is the travel
      // itself, so the eye follows one thing instead of a spreading stain.
      // (One stroke() per edge is also what makes a graph this size crawl.)
      ctx.strokeStyle = 'rgba(58,56,54,.7)'
      ctx.lineWidth = 0.8
      ctx.beginPath()
      for (const l of graph.links) {
        if (l.b.phase === 'building' || l.b.phase === 'arriving') continue
        if (isHidden(l.b)) continue
        ctx.moveTo(l.a.x * scale + ox, l.a.y * scale + oy)
        ctx.lineTo(l.b.x * scale + ox, l.b.y * scale + oy)
      }
      ctx.stroke()

      const pulse = Date.now() / 1000
      const filter = turnRef.current
      // Marks of a kind the user switched off simply don't count as "lit".
      const allowKind = kindsRef.current.size
        ? (m: NodeMark): boolean => !kindsRef.current.has(m.isError ? 'error' : actionKind(m.tool))
        : undefined
      const labels: { text: string; x: number; y: number; color: string; dir: boolean; marked: boolean }[] = []
      for (const n of graph.nodes) {
        if (isHidden(n)) continue
        const sx = n.x * scale + ox
        const sy = n.y * scale + oy
        if (sx < -60 || sy < -60 || sx > w + 60 || sy > h + 60) continue
        const baseR = radius(n) * Math.max(0.6, Math.min(1.4, scale))
        // What the agent did here — under the message and kind-of-change
        // filters. No mark means "not part of this step": plain grey dot.
        const mark = markFor(n, filter, allowKind)
        const tone = mark?.color ?? OK

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

        // Piscada: a batida vai de 0 a 1 e volta, e o nó CLAREIA no pico. Isso
        // é só o "está acontecendo agora"; quando passa, o nó continua aceso na
        // cor da ação — ele não volta mais a apagar.
        const beat = n.heat > 0.04 ? (1 + Math.sin(pulse * 4.4)) / 2 : 0
        if (beat > 0 && mark) {
          ctx.beginPath()
          ctx.arc(sx, sy, r + 5, 0, 7)
          ctx.globalAlpha = 0.1 + 0.32 * beat * n.heat
          ctx.fillStyle = tone
          ctx.fill()
          ctx.globalAlpha = 1
        }
        ctx.globalAlpha = fade
        ctx.beginPath()
        ctx.arc(sx, sy, r, 0, 7)
        // Aceso = a cor da ação, cheia e permanente; o pulso só clareia por cima.
        const hot = mix(tone, mix(tone, '#ffffff', 0.55), beat * n.heat)
        ctx.fillStyle = mark ? hot : n.isDir ? '#6b5346' : '#4a4744'
        ctx.fill()
        ctx.globalAlpha = 1

        const hasBalloon = n.heat > 0.3 && !!n.say
        // Nomes: todo arquivo que o agente mexeu fica nomeado pra sempre (é o
        // que o mapa está contando), mais o topo da árvore — zoom out num painel
        // estreito deixa a escala bem abaixo de 0.35, e um mapa de bolinhas
        // anônimas não diz NADA sobre onde o agente trabalhou.
        const showLabel =
          !hasBalloon && n.phase === 'idle' && (n.isDir ? n.depth <= 2 || scale > 0.5 : !!mark)
        if (showLabel) {
          labels.push({
            text: n.name,
            x: sx,
            y: sy - r - 6,
            color: mark ? mix(tone, '#ffffff', 0.5) : 'rgba(163,160,155,.75)',
            dir: n.isDir,
            // Um arquivo que o agente mexeu ganha o lugar: é a informação que o
            // usuário pediu. O nome da pasta é contexto e pode ceder.
            marked: !!mark
          })
        }
      }

      // Nomes desenhados por último e sem se atropelar: um rótulo por cima do
      // outro vira borrão ilegível justo onde o trabalho aconteceu. Os arquivos
      // marcados escolhem primeiro; quem não acha lugar em 3 tentativas é
      // deixado de fora (a bolinha colorida continua lá).
      const takenLabels: Box[] = []
      labels.sort((a, b) => Number(b.marked) - Number(a.marked))
      for (const l of labels) {
        ctx.font = l.dir ? '600 11.5px system-ui' : '400 11px system-ui'
        const tw = ctx.measureText(l.text).width
        let y = l.y
        let fits = true
        for (let i = 0; i < 3; i++) {
          const box = { x: l.x - tw / 2, y: y - 10, w: tw, h: 13 }
          const clash = takenLabels.find((p) => overlaps(box, p))
          if (!clash) {
            takenLabels.push(box)
            fits = true
            break
          }
          y = clash.y - 13
          fits = false
        }
        if (!fits) continue
        ctx.textAlign = 'center'
        ctx.fillStyle = l.color
        ctx.fillText(l.text, l.x, y)
      }

      // A viagem e o balão obedecem aos mesmos filtros do nó: com "leu"
      // desligado, um Read não pode continuar riscando o mapa.
      const mutedTravel = (tool: string, isError: boolean): boolean =>
        kindsRef.current.has(isError ? 'error' : actionKind(tool))
      travels.current.forEach((tr) => {
        if (isHidden(tr.route[tr.route.length - 1])) return
        if (mutedTravel(tr.tool, tr.isError)) return
        drawTravel(tr)
      })

      const placed: Box[] = []
      const nowMs = Date.now()
      graph.nodes
        .filter(
          (n) =>
            n.phase !== 'dying' &&
            !isHidden(n) &&
            !mutedTravel(n.tool ?? '', n.isError === true) &&
            sayAlpha(n, nowMs) > 0
        )
        .sort((a, b) => (b.sayAt ?? 0) - (a.sayAt ?? 0))
        .slice(0, 3)
        .forEach((n) => drawBalloon(n, n.x * scale + ox, n.y * scale + oy, placed, nowMs))
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
      <ProjectFilters
        turns={turns}
        turnId={turnId}
        onPickTurn={setTurnId}
        types={types}
        hidden={hiddenTypes}
        onToggleType={(t) => {
          const next = new Set(hiddenTypes)
          if (next.has(t)) next.delete(t)
          else next.add(t)
          persistHidden(next)
        }}
        onShowAllTypes={() => persistHidden(new Set())}
        kinds={kinds}
        hiddenKinds={hiddenKinds}
        onToggleKind={(k) => {
          const next = new Set(hiddenKinds)
          if (next.has(k)) next.delete(k)
          else next.add(k)
          persistKinds(next)
        }}
      />
      <div className="pgraph-stage">
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
        <span><i className="dot file" />arquivo</span>
        <span><i className="dot dir" />pasta</span>
        {truncated && <span className="pgraph-warn">100 mais recentes</span>}
        {shownTouches.length > 0 && (
          <span className="pgraph-count">
            {shownTouches.length} {shownTouches.length === 1 ? 'ação' : 'ações'}
            {turnId ? ' nesta mensagem' : ''}
          </span>
        )}
      </div>
      </div>
    </div>
  )
}
