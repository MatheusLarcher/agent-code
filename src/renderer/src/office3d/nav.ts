/**
 * Navegação PURA de uma sala (sem three): grade de caminhável com célula CELL
 * (≤ 0,5 m) gerada dos móveis de furniture.ts — mesas, cadeiras, estante,
 * plantas, luminárias, café, pufe e paredes, com folga do raio do agente —,
 * A* de 8 vizinhos sem cortar quina, suavização do caminho por linha de visão
 * e a reserva de pontos de interesse (um agente por POI).
 *
 * Custo: a grade nasce com a sala; o A* reaproveita os mesmos vetores tipados
 * a cada busca (carimbo de geração em vez de limpar) e só roda quando alguém
 * troca de destino — nunca por quadro.
 */
import type { Rect, RoomFurniture } from './furniture'
import type { RoomLayout } from './layout'

export const CELL = 0.25
export const AGENT_RADIUS = 0.22
/** Até onde (em células) se procura a célula livre mais próxima. */
const SEARCH_RINGS = 14
const DIAG = Math.SQRT2

export class NavGrid {
  readonly cols: number
  readonly rows: number
  /** 1 = bloqueada. */
  readonly blocked: Uint8Array
  private readonly g: Float32Array
  private readonly f: Float32Array
  private readonly from: Int32Array
  private readonly stamp: Uint32Array
  private readonly closed: Uint32Array
  private readonly heap: Int32Array
  private readonly trail: Int32Array
  private gen = 0

  constructor(
    readonly x0: number,
    readonly z0: number,
    width: number,
    depth: number,
    obstacles: readonly Rect[],
    inflate = AGENT_RADIUS
  ) {
    this.cols = Math.max(1, Math.ceil(width / CELL - 1e-9))
    this.rows = Math.max(1, Math.ceil(depth / CELL - 1e-9))
    const n = this.cols * this.rows
    this.blocked = new Uint8Array(n)
    this.g = new Float32Array(n)
    this.f = new Float32Array(n)
    this.from = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.closed = new Uint32Array(n)
    this.heap = new Int32Array(n * 8 + 8)
    this.trail = new Int32Array(n)
    for (const o of obstacles) this.block(o.x0 - inflate, o.z0 - inflate, o.x1 + inflate, o.z1 + inflate)
  }

  /** Bloqueia as células cujo centro cai no retângulo. */
  private block(ax: number, az: number, bx: number, bz: number): void {
    const c0 = Math.max(0, Math.floor((ax - this.x0) / CELL))
    const c1 = Math.min(this.cols - 1, Math.floor((bx - this.x0) / CELL))
    const r0 = Math.max(0, Math.floor((az - this.z0) / CELL))
    const r1 = Math.min(this.rows - 1, Math.floor((bz - this.z0) / CELL))
    for (let r = r0; r <= r1; r++) {
      const z = this.z0 + (r + 0.5) * CELL
      if (z < az || z > bz) continue
      for (let c = c0; c <= c1; c++) {
        const x = this.x0 + (c + 0.5) * CELL
        if (x >= ax && x <= bx) this.blocked[r * this.cols + c] = 1
      }
    }
  }

  /** Índice da célula de (x, z); -1 fora da grade. */
  cellAt(x: number, z: number): number {
    const c = Math.floor((x - this.x0) / CELL)
    const r = Math.floor((z - this.z0) / CELL)
    return c < 0 || r < 0 || c >= this.cols || r >= this.rows ? -1 : r * this.cols + c
  }

  cellX(i: number): number {
    return this.x0 + ((i % this.cols) + 0.5) * CELL
  }

  cellZ(i: number): number {
    return this.z0 + (Math.floor(i / this.cols) + 0.5) * CELL
  }

  isFree(x: number, z: number): boolean {
    const i = this.cellAt(x, z)
    return i >= 0 && this.blocked[i] === 0
  }

  /** Célula livre mais perto de (x, z) (em anéis); -1 se não houver por perto. */
  nearestFree(x: number, z: number): number {
    const c0 = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x0) / CELL)))
    const r0 = Math.min(this.rows - 1, Math.max(0, Math.floor((z - this.z0) / CELL)))
    if (this.blocked[r0 * this.cols + c0] === 0) return r0 * this.cols + c0
    for (let k = 1; k <= SEARCH_RINGS; k++) {
      let best = -1
      let bestD = Infinity
      for (let r = r0 - k; r <= r0 + k; r++) {
        if (r < 0 || r >= this.rows) continue
        const edge = r === r0 - k || r === r0 + k
        for (let c = c0 - k; c <= c0 + k; c += edge ? 1 : 2 * k) {
          if (c < 0 || c >= this.cols) continue
          const i = r * this.cols + c
          if (this.blocked[i]) continue
          const d = (this.cellX(i) - x) ** 2 + (this.cellZ(i) - z) ** 2
          if (d < bestD) {
            bestD = d
            best = i
          }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  /** Linha de visão: o segmento só passa por células livres (amostrado a CELL·0,4). */
  clear(ax: number, az: number, bx: number, bz: number): boolean {
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.4)))
    for (let i = 0; i <= steps; i++) {
      const k = i / steps
      const c = this.cellAt(ax + (bx - ax) * k, az + (bz - az) * k)
      if (c < 0 || this.blocked[c]) return false
    }
    return true
  }

  /** Célula livre sorteada (até 40 tentativas); -1 se a sala estiver lotada. */
  randomFree(rng: () => number): number {
    const n = this.cols * this.rows
    for (let k = 0; k < 40; k++) {
      const i = Math.min(n - 1, Math.floor(rng() * n))
      if (!this.blocked[i]) return i
    }
    return -1
  }

  /**
   * Caminho de (ax, az) até (bx, bz), suavizado: pontos (x, z) em `out`, sem a
   * origem e terminando EXATAMENTE no destino. Devolve quantos pontos; 0 = sem
   * caminho. Origem ou destino dentro de móvel saem/entram pela célula livre
   * mais próxima.
   */
  findPath(ax: number, az: number, bx: number, bz: number, out: Float32Array): number {
    const cap = out.length >> 1
    if (cap < 1) return 0
    let s = this.cellAt(ax, az)
    const startFree = s >= 0 && this.blocked[s] === 0
    if (!startFree) s = this.nearestFree(ax, az)
    let t = this.cellAt(bx, bz)
    if (t < 0 || this.blocked[t]) t = this.nearestFree(bx, bz)
    if (s < 0 || t < 0) return 0
    if (startFree && this.clear(ax, az, bx, bz)) {
      out[0] = bx
      out[1] = bz
      return 1
    }
    const n = this.astar(s, t)
    if (n === 0) return 0
    let count = 0
    let px = ax
    let pz = az
    let k = startFree ? 1 : 0
    // Origem dentro de móvel: o 1º ponto é a célula livre (clear falha de lá).
    while (k < n && !this.clear(px, pz, bx, bz)) {
      let j = k
      while (j + 1 < n && this.clear(px, pz, this.cellX(this.trail[j + 1]), this.cellZ(this.trail[j + 1]))) j++
      px = this.cellX(this.trail[j])
      pz = this.cellZ(this.trail[j])
      if (count < cap - 1) {
        out[count * 2] = px
        out[count * 2 + 1] = pz
        count++
      }
      k = j + 1
    }
    out[count * 2] = bx
    out[count * 2 + 1] = bz
    return count + 1
  }

  /** A* de `s` até `t`; escreve as células (s..t) em `trail` e devolve quantas; 0 sem caminho. */
  private astar(s: number, t: number): number {
    if (++this.gen >= 0xffffffff) {
      this.gen = 1
      this.stamp.fill(0)
      this.closed.fill(0)
    }
    const gen = this.gen
    const { cols, rows, blocked, g, f, from, stamp, closed } = this
    const tc = t % cols
    const tr = Math.floor(t / cols)
    const h = (i: number): number => {
      const dx = Math.abs((i % cols) - tc)
      const dz = Math.abs(Math.floor(i / cols) - tr)
      return dx + dz + (DIAG - 2) * Math.min(dx, dz)
    }
    let size = 0
    const push = (i: number): void => {
      if (size >= this.heap.length) return
      let k = size++
      this.heap[k] = i
      while (k > 0) {
        const p = (k - 1) >> 1
        if (f[this.heap[p]] <= f[this.heap[k]]) break
        const tmp = this.heap[p]
        this.heap[p] = this.heap[k]
        this.heap[k] = tmp
        k = p
      }
    }
    const pop = (): number => {
      const top = this.heap[0]
      this.heap[0] = this.heap[--size]
      let k = 0
      for (;;) {
        const l = k * 2 + 1
        const r = l + 1
        let m = k
        if (l < size && f[this.heap[l]] < f[this.heap[m]]) m = l
        if (r < size && f[this.heap[r]] < f[this.heap[m]]) m = r
        if (m === k) break
        const tmp = this.heap[m]
        this.heap[m] = this.heap[k]
        this.heap[k] = tmp
        k = m
      }
      return top
    }
    g[s] = 0
    f[s] = h(s)
    from[s] = -1
    stamp[s] = gen
    push(s)
    let found = s === t
    while (size > 0 && !found) {
      const cur = pop()
      if (closed[cur] === gen) continue
      closed[cur] = gen
      if (cur === t) {
        found = true
        break
      }
      const cr = Math.floor(cur / cols)
      const cc = cur - cr * cols
      for (let dr = -1; dr <= 1; dr++) {
        const nr = cr + dr
        if (nr < 0 || nr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          const nc = cc + dc
          if ((dr === 0 && dc === 0) || nc < 0 || nc >= cols) continue
          const ni = nr * cols + nc
          if (blocked[ni] || closed[ni] === gen) continue
          // Diagonal só com os dois vizinhos ortogonais livres (não corta quina).
          if (dr !== 0 && dc !== 0 && (blocked[cr * cols + nc] || blocked[nr * cols + cc])) continue
          const ng = g[cur] + (dr !== 0 && dc !== 0 ? DIAG : 1)
          if (stamp[ni] === gen && ng >= g[ni]) continue
          stamp[ni] = gen
          g[ni] = ng
          f[ni] = ng + h(ni)
          from[ni] = cur
          push(ni)
        }
      }
    }
    if (!found) return 0
    let n = 0
    for (let i = t; i !== -1 && n < this.trail.length; i = from[i]) this.trail[n++] = i
    this.trail.subarray(0, n).reverse()
    return n
  }
}

export function buildNavGrid(room: Pick<RoomLayout, 'x' | 'z' | 'width' | 'depth'>, furniture: Pick<RoomFurniture, 'obstacles'>): NavGrid {
  return new NavGrid(room.x, room.z, room.width, room.depth, furniture.obstacles)
}

/** Reserva de pontos de interesse: um agente por POI. */
export class PoiBook {
  private readonly held = new Map<string, string>()

  holder(id: string): string | undefined {
    return this.held.get(id)
  }

  isFree(id: string, key?: string): boolean {
    const h = this.held.get(id)
    return h === undefined || h === key
  }

  claim(id: string, key: string): boolean {
    if (!this.isFree(id, key)) return false
    this.held.set(id, key)
    return true
  }

  release(id: string, key: string): void {
    if (this.held.get(id) === key) this.held.delete(id)
  }

  releaseAll(key: string): void {
    for (const [id, k] of this.held) if (k === key) this.held.delete(id)
  }

  /** Sala saiu (ou mudou): solta tudo o que era dela. */
  dropRoom(roomId: string): void {
    const prefix = `${roomId}|`
    for (const id of this.held.keys()) if (id.startsWith(prefix)) this.held.delete(id)
  }

  get size(): number {
    return this.held.size
  }
}
