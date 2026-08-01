import type { ProjectNode } from '@shared/ipc'
import { actionColor } from './projectActivity'

/**
 * The project map's model: tree → force-graph nodes, plus the physics step.
 *
 * Kept out of the React component so the layout rules are unit testable and the
 * component stays "canvas + effects". Everything here mutates in place: this
 * runs 60x a second and allocating a new graph per frame would be the whole
 * performance budget.
 */

/**
 * A node's lifecycle on screen.
 * - `idle`    — just there.
 * - `arriving`— was outside the "most recent" list and the agent just touched
 *               it: it flies in from the back instead of popping into place.
 * - `building`— created now: fragments converge and fuse into the dot.
 * - `dying`   — deleted from disk: the dot breaks apart and is then removed.
 */
export type NodePhase = 'idle' | 'arriving' | 'building' | 'dying'

/**
 * One action that landed on a node. Marks are PERMANENT: the map is the
 * session's history, so a file the agent touched stays lit (and named) instead
 * of cooling back to grey. `turnId` is what lets the map show only the work of
 * one message the user sent.
 */
export interface NodeMark {
  turnId: string
  tool: string
  /** Colour of the action's family (red when the call failed). */
  color: string
  isError: boolean
  /** Epoch ms — the most recent mark wins when several share a node. */
  at: number
}

export interface GraphNode {
  /** Path relative to the project root; '' is the root node itself. */
  path: string
  name: string
  isDir: boolean
  depth: number
  parent: GraphNode | null
  x: number
  y: number
  vx: number
  vy: number
  /** Everything the agent did on this node, oldest first (never cleared). */
  marks: NodeMark[]
  /** 1 right after the agent touched it, decaying towards 0. Drives ONLY the
   *  pulse ("this is happening now"); the node's colour comes from `marks` and
   *  no longer fades away with it. */
  heat: number
  /** Tool + text shown in the balloon while this node is hot. */
  tool?: string
  say?: string
  isError?: boolean
  /** Edit line counts, drawn colored next to the text (like the chat card). */
  added?: number
  removed?: number
  /** Epoch ms the balloon text was set — it lives on its OWN short timer,
   *  independent of `heat` (see SAY_* in ProjectGraph). */
  sayAt?: number
  phase: NodePhase
  /** 0→1 progress inside the current phase. */
  phaseT: number
}

/** How long each animated phase lasts, in ms. */
export const PHASE_MS: Record<Exclude<NodePhase, 'idle'>, number> = {
  arriving: 900,
  building: 1100,
  dying: 900
}

export interface GraphLink {
  a: GraphNode
  b: GraphNode
}

export interface Graph {
  nodes: GraphNode[]
  links: GraphLink[]
  root: GraphNode
  /** path → node, for resolving a Touch onto the map. */
  byPath: Map<string, GraphNode>
}

/** Ring spacing between tree levels — same as the folder spring's rest length. */
const RING = 120
/** A file sits closer to its folder than a subfolder does (it has no branch). */
const LEAF = 72

/**
 * Build the graph from a flat, breadth-first project listing.
 *
 * Nodes are SEEDED with a radial tree layout (each folder owns an angular
 * sector, split among its children by subtree size) instead of being scattered
 * randomly around their parent. That is not cosmetic: at ~1200 nodes a random
 * scatter starts as one dense blob, and grid-based repulsion only reaches
 * neighbouring cells — the blob has no way to push itself apart and the map
 * stays an unreadable clump forever (observed on this very repo). Seeded this
 * way, the physics only has to RELAX an already-open layout.
 *
 * The seed is fully deterministic, so the same project always opens with the
 * same shape.
 */
export function buildGraph(entries: ProjectNode[], rootName: string, w = 900, h = 600): Graph {
  const cx = w / 2
  const cy = h / 2
  const root: GraphNode = {
    path: '', name: rootName, isDir: true, depth: 0, parent: null,
    x: cx, y: cy, vx: 0, vy: 0, marks: [], heat: 0, phase: 'idle', phaseT: 0
  }
  const byPath = new Map<string, GraphNode>([['', root]])
  const nodes: GraphNode[] = [root]
  const links: GraphLink[] = []
  const kids = new Map<GraphNode, GraphNode[]>()

  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  for (const e of sorted) {
    if (byPath.has(e.path)) continue
    const slash = e.path.lastIndexOf('/')
    const parentPath = slash < 0 ? '' : e.path.slice(0, slash)
    const parent = byPath.get(parentPath)
    if (!parent) continue // parent got cut by the scan cap — skip the orphan
    const n: GraphNode = {
      path: e.path, name: e.name, isDir: e.isDir, depth: parent.depth + 1, parent,
      x: 0, y: 0, vx: 0, vy: 0, marks: [], heat: 0, phase: 'idle', phaseT: 0
    }
    byPath.set(e.path, n)
    nodes.push(n)
    links.push({ a: parent, b: n })
    const arr = kids.get(parent)
    if (arr) arr.push(n)
    else kids.set(parent, [n])
  }

  // Subtree weight (leaves), so a fat folder gets a proportionally wider slice
  // and a folder holding one file doesn't get the same wedge as src/.
  const weight = new Map<GraphNode, number>()
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    const cs = kids.get(n)
    weight.set(n, cs ? cs.reduce((s, c) => s + (weight.get(c) ?? 1), 0) : 1)
  }

  // Walk down, handing each child its angular slice of the parent's sector.
  const place = (n: GraphNode, a0: number, a1: number): void => {
    const cs = kids.get(n)
    if (!cs) return
    const total = weight.get(n) ?? 1
    let a = a0
    for (const c of cs) {
      const span = ((weight.get(c) ?? 1) / total) * (a1 - a0)
      const mid = a + span / 2
      // Ring distance matches the spring's rest length for that kind of edge,
      // so the physics relaxes the seed instead of yanking it back inwards.
      const r = RING * (c.depth - 1) + (c.isDir ? RING : LEAF)
      // Deterministic nudge from the path hash: with a very thin slice, siblings
      // would land on the exact same pixel, where the (distance-floored)
      // repulsion is exactly zero and they'd stay welded together forever.
      let hsh = 0
      for (let k = 0; k < c.path.length; k++) hsh = (hsh * 31 + c.path.charCodeAt(k)) | 0
      const jx = ((hsh % 17) - 8) * 1.5
      const jy = (((hsh >> 5) % 17) - 8) * 1.5
      c.x = cx + Math.cos(mid) * r + jx
      c.y = cy + Math.sin(mid) * r + jy
      a += span
      // Children never get the full circle back — a slightly padded slice keeps
      // sibling branches from growing into each other.
      place(c, mid - span / 2, mid + span / 2)
    }
  }
  place(root, 0, Math.PI * 2)

  return { nodes, links, root, byPath }
}

/**
 * Add a path to a LIVE graph (creating any missing folders along the way) and
 * return its node, or the existing one if it's already there.
 *
 * This is what lets the map stay filtered to the ~100 most recent files without
 * lying: the moment the agent touches something outside that list, the file
 * joins the map instead of the call having nowhere to land. New nodes are born
 * on top of their parent so the entrance animation reads as "coming from
 * inside the project", not as a dot teleporting into empty space.
 */
export function ensureNode(g: Graph, path: string, isDir: boolean, phase: NodePhase = 'arriving'): GraphNode {
  const found = g.byPath.get(path)
  if (found) return found
  const slash = path.lastIndexOf('/')
  const parentPath = slash < 0 ? '' : path.slice(0, slash)
  const parent = parentPath === path ? g.root : ensureNode(g, parentPath, true, phase)
  const name = path.slice(slash + 1)
  let hsh = 0
  for (let k = 0; k < path.length; k++) hsh = (hsh * 31 + path.charCodeAt(k)) | 0
  const ang = ((hsh >>> 0) % 360) * (Math.PI / 180)
  const n: GraphNode = {
    path, name, isDir, depth: parent.depth + 1, parent,
    x: parent.x + Math.cos(ang) * 6,
    y: parent.y + Math.sin(ang) * 6,
    vx: 0, vy: 0, marks: [], heat: 0, phase, phaseT: 0
  }
  g.byPath.set(path, n)
  g.nodes.push(n)
  g.links.push({ a: parent, b: n })
  return n
}

/** Drop a node (and its edge) once its death animation has played out. */
export function removeNode(g: Graph, n: GraphNode): void {
  g.byPath.delete(n.path)
  const i = g.nodes.indexOf(n)
  if (i >= 0) g.nodes.splice(i, 1)
  for (let k = g.links.length - 1; k >= 0; k--) {
    if (g.links[k].a === n || g.links[k].b === n) g.links.splice(k, 1)
  }
  // Orphaned children would keep a dangling `parent` and draw edges to a node
  // that no longer exists — reattach them to the grandparent instead.
  for (const m of g.nodes) {
    if (m.parent === n) {
      m.parent = n.parent
      if (m.parent) g.links.push({ a: m.parent, b: m })
    }
  }
}

/**
 * Advance every animated node by `dtMs`. A node that finishes `dying` leaves
 * the graph; the others fall back to `idle`.
 */
export function advancePhases(g: Graph, dtMs: number): void {
  for (let i = g.nodes.length - 1; i >= 0; i--) {
    const n = g.nodes[i]
    if (n.phase === 'idle') continue
    n.phaseT += dtMs / PHASE_MS[n.phase]
    if (n.phaseT < 1) continue
    if (n.phase === 'dying') removeNode(g, n)
    else {
      n.phase = 'idle'
      n.phaseT = 0
    }
  }
}

/** Record an action on a node. Repeating the same tool in the same turn only
 *  refreshes the timestamp — a loop of 40 Reads shouldn't grow the list. */
export function addMark(n: GraphNode, turnId: string, tool: string, isError: boolean, at: number): void {
  const same = n.marks.find((m) => m.turnId === turnId && m.tool === tool && m.isError === isError)
  if (same) {
    same.at = at
    return
  }
  n.marks.push({ turnId, tool, color: actionColor(tool, isError), isError, at })
}

/**
 * The mark that decides how a node is painted: the most recent one, or the most
 * recent one still allowed by the filters — a message the user sent (`turnId`)
 * and/or a kind of action (`allow`, from the "tipo de modificação" chips).
 * `undefined` means "nothing the agent did here survives the filter", so the
 * node stays a plain grey dot.
 */
export function markFor(
  n: GraphNode,
  turnId: string | null,
  allow?: (m: NodeMark) => boolean
): NodeMark | undefined {
  let best: NodeMark | undefined
  for (const m of n.marks) {
    if (turnId && m.turnId !== turnId) continue
    if (allow && !allow(m)) continue
    if (!best || m.at >= best.at) best = m
  }
  return best
}

/** Root → node, the route the "call" animation travels. */
export function pathToNode(n: GraphNode): GraphNode[] {
  const out: GraphNode[] = []
  for (let c: GraphNode | null = n; c; c = c.parent) out.unshift(c)
  return out
}

const CELL = 70

/**
 * One physics tick: gravity to the centre, repulsion between neighbours, springs
 * along the tree.
 *
 * The repulsion uses a uniform grid instead of comparing every pair. That is not
 * a micro-optimisation: this view can hold ~1200 nodes, and all-pairs would be
 * ~720k distance checks PER FRAME, which drops the app to a slideshow. The grid
 * only compares nodes in the 3x3 cells around each one — beyond that the force
 * is negligible anyway.
 */
export function stepPhysics(g: Graph, w: number, h: number, alpha: number): void {
  const cx = w / 2
  const cy = h / 2
  const grid = new Map<string, GraphNode[]>()
  for (const n of g.nodes) {
    const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`
    const cell = grid.get(key)
    if (cell) cell.push(n)
    else grid.set(key, [n])
  }

  for (const n of g.nodes) {
    // Very weak gravity on purpose: the layout arrives already open (radial
    // seed), so gravity is only here to stop slow drift. Anything stronger
    // collapses the rings back into the blob this seeding exists to avoid.
    n.vx += (cx - n.x) * 0.0002 * alpha
    n.vy += (cy - n.y) * 0.0002 * alpha
    const gx = Math.floor(n.x / CELL)
    const gy = Math.floor(n.y / CELL)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cell = grid.get(`${gx + ox},${gy + oy}`)
        if (!cell) continue
        for (const m of cell) {
          if (m === n) continue
          const dx = m.x - n.x
          const dy = m.y - n.y
          const raw = dx * dx + dy * dy
          if (raw > CELL * CELL * 4) continue
          // Floor the distance before dividing by it. Two nodes seeded at
          // (almost) the same point give d²→0, which turns 700/d² into a
          // catapult: measured on this repo, stray nodes were flung to a radius
          // of 5784 while the real mass sat inside 400, and the auto-fit then
          // framed the strays and squashed the map into a corner.
          const d2 = Math.max(raw, 64)
          const d = Math.sqrt(d2)
          const f = Math.min(3, (700 / d2) * alpha)
          n.vx -= (dx / d) * f
          n.vy -= (dy / d) * f
        }
      }
    }
  }

  for (const l of g.links) {
    const dx = l.b.x - l.a.x
    const dy = l.b.y - l.a.y
    const d = Math.hypot(dx, dy) || 0.01
    // Folder-to-folder edges are longer: it's what separates the big branches
    // instead of packing every cluster at the same radius.
    const rest = l.b.isDir ? RING : LEAF
    const f = (d - rest) * 0.014 * alpha
    const ux = dx / d
    const uy = dy / d
    l.a.vx += ux * f
    l.a.vy += uy * f
    l.b.vx -= ux * f
    l.b.vy -= uy * f
  }

  for (const n of g.nodes) {
    n.vx *= 0.86
    n.vy *= 0.86
    n.x += n.vx
    n.y += n.vy
  }
}

/** Bounding box of the laid-out graph, for fitting it into the canvas. */
export function bounds(g: Graph): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of g.nodes) {
    if (n.x < minX) minX = n.x
    if (n.y < minY) minY = n.y
    if (n.x > maxX) maxX = n.x
    if (n.y > maxY) maxY = n.y
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}
