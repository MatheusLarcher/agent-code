/**
 * Onde ficam os olhos de um avatar GLB — PURO (sem three). Os modelos do
 * elenco (Meshy/Mixamo) não têm blendshape nem osso de pálpebra: o olho é
 * pintado na textura. Daqui sai o lugar das pálpebras (eyelids.ts), achado
 * pela cor da própria pele do modelo:
 *
 *   amostras da frente da cabeça (posição, normal e cor da textura, no referencial
 *   do personagem: Y para cima, o rosto olhando para −Z)
 *   → o branco dos olhos (claro e sem cor): o par de manchas na mesma altura, espelhadas no rosto e no
 *     afastamento de dois olhos; sem esse par (textura de foto, quase sem branco), a íris escura entre dois claros
 *   → a cor da pele (a bochecha logo abaixo de cada olho)
 *   → o olho inteiro: a mancha que "não é pele" em volta do branco (íris, pupila,
 *     contorno), numa grade sobre o rosto, sem passar para a sobrancelha (há pele no meio);
 *     se vazar (a armação dos óculos), o espalhamento do branco; sem branco, o tamanho típico.
 *
 * Devolve null se não achar os dois olhos parecidos e na mesma altura (modelo
 * fora do padrão: fica sem pálpebra, o olho continua aberto).
 */

/** Campos de cada amostra em `samples` (Float32Array, uma amostra a cada STRIDE números). */
export const STRIDE = 9
export const S = { x: 0, y: 1, z: 2, nx: 3, ny: 4, nz: 5, r: 6, g: 7, b: 8 } as const

export interface Eye {
  /** Centro (m, referencial do personagem). */
  x: number
  y: number
  z: number
  /** Meia largura e meia altura do olho (m). */
  rx: number
  ry: number
}

export interface EyeFind {
  eyes: [Eye, Eye]
  /** Cor da pele (0..1, sRGB da textura). */
  skin: [number, number, number]
}

/**
 * A pálpebra aparece com o canal `eyes` da pose (1 aberto, 0 fechado) abaixo disto: só o olho fechado de vez
 * (o cochilo, 0); o franzido do espreguiçar (0,2 no pico) e o piscar continuam com o olho pintado.
 */
export const LIDS_BELOW = 0.15
export const lidsClosed = (eyes: number): boolean => eyes < LIDS_BELOW

/** A frente da cabeça: normal virada para −Z pelo menos isto. */
const FRONT = 0.3
/** Distância de cor (0..1, RGB) até a pele a partir da qual o ponto "não é pele". */
const SKIN_DIST = 0.2

const light = (r: number, g: number, b: number): number => (Math.max(r, g, b) + Math.min(r, g, b)) / 2
/** O branco do olho: claro e quase sem cor. */
export function isSclera(r: number, g: number, b: number): boolean {
  return light(r, g, b) > 0.66 && Math.max(r, g, b) - Math.min(r, g, b) < 0.2
}

function median(v: number[]): number {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** Acha os dois olhos nas amostras da cabeça (ver o cabeçalho). */
export function findEyes(samples: ArrayLike<number>): EyeFind | null {
  const n = Math.floor(samples.length / STRIDE)
  const at = (i: number, f: number): number => samples[i * STRIDE + f]
  // A caixa da cabeça e a frente do rosto.
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, at(i, S.x)); x1 = Math.max(x1, at(i, S.x))
    y0 = Math.min(y0, at(i, S.y)); y1 = Math.max(y1, at(i, S.y))
    z0 = Math.min(z0, at(i, S.z)); z1 = Math.max(z1, at(i, S.z))
  }
  const width = x1 - x0
  if (!(width > 0.05) || !(y1 - y0 > 0.05)) return null
  const face: number[] = []
  for (let i = 0; i < n; i++) {
    if (-at(i, S.nz) < FRONT) continue
    if (at(i, S.z) > z0 + 0.35 * (z1 - z0)) continue
    if (at(i, S.y) < y0 + 0.3 * (y1 - y0)) continue
    face.push(i)
  }
  if (face.length < 20) return null
  // O par de manchas brancas com a íris escura do lado, na mesma altura (cabelo e barba grisalhos, dente, gola,
  // reflexo e a pálpebra clara da textura de foto também são claros e sem cor, mas não formam isso); sem ele, o das íris.
  const white = face.filter((i) => isSclera(at(i, S.r), at(i, S.g), at(i, S.b)))
  const dark = face.filter((i) => light(at(i, S.r), at(i, S.g), at(i, S.b)) < 0.33)
  const irisNear = (p: Spot): boolean => dark.filter((i) => Math.abs(at(i, S.x) - p.x) < 0.07 * width && Math.abs(at(i, S.y) - p.y) < 0.025 * width).length >= 3
  const center = (x0 + x1) / 2
  const pair = pairOf(whiteSpots(white, samples, width).filter(irisNear), center, width) ?? pairOf(whiteSpots(irisPoints(samples, face, width), samples, width), center, width)
  if (!pair) return null
  const out: Eye[] = []
  const skins: number[][] = [[], [], []]
  const blobs: number[][] = []
  for (const { x: cx, y: cy } of pair) {
    // A pele: a bochecha logo abaixo deste olho.
    for (const i of face) {
      const dy = cy - at(i, S.y)
      if (dy < 0.08 * width || dy > 0.2 * width || Math.abs(at(i, S.x) - cx) > 0.08 * width) continue
      const r = at(i, S.r), g = at(i, S.g), b = at(i, S.b)
      if (light(r, g, b) < 0.2 || isSclera(r, g, b)) continue
      skins[0].push(r); skins[1].push(g); skins[2].push(b)
    }
    blobs.push([cx, cy])
  }
  const skin: [number, number, number] = [median(skins[0]), median(skins[1]), median(skins[2])]
  if (skin.some((c) => !Number.isFinite(c))) return null
  for (const [cx, cy] of blobs) {
    const e = eyeBlob(samples, face, cx, cy, width, skin) ?? scleraEye(samples, face, cx, cy, width) ?? typicalEye(samples, face, cx, cy, width)
    if (!e) return null
    out.push(e)
  }
  if (agree(out[0], out[1])) return { eyes: [out[0], out[1]], skin }
  // As medidas discordam (uma vazou para a sobrancelha, comum na textura de foto): o tamanho típico nos dois
  // centros do par, que já passaram pela altura e pela simetria.
  const a = typicalEye(samples, face, pair[0].x, pair[0].y, width)
  const b = typicalEye(samples, face, pair[1].x, pair[1].y, width)
  return a && b && agree(a, b) ? { eyes: [a, b], skin } : null
}

/** Os dois olhos parecidos e na mesma altura (senão o achado é outra coisa: dente, brinco, reflexo). */
function agree(a: Eye, b: Eye): boolean {
  return Math.abs(a.y - b.y) <= 0.25 * Math.max(a.ry, b.ry) + 0.004 && Math.max(a.rx, b.rx) <= 1.6 * Math.min(a.rx, b.rx)
}

/**
 * Sem dar para separar o olho da pele (a armação dos óculos encosta, a textura de foto não tem contorno): o olho
 * pelo espalhamento do branco em volta de (cx, cy), nos limites de um olho de verdade para a largura da cabeça.
 */
function scleraEye(samples: ArrayLike<number>, face: number[], cx: number, cy: number, width: number): Eye | null {
  const at = (i: number, f: number): number => samples[i * STRIDE + f]
  const xs: number[] = [], ys: number[] = [], zs: number[] = []
  for (const i of face) {
    if (Math.abs(at(i, S.x) - cx) > 0.12 * width || Math.abs(at(i, S.y) - cy) > 0.05 * width) continue
    if (!isSclera(at(i, S.r), at(i, S.g), at(i, S.b))) continue
    xs.push(at(i, S.x)); ys.push(at(i, S.y)); zs.push(at(i, S.z))
  }
  if (xs.length < 3) return null
  const pct = (v: number[], f: number): number => [...v].sort((a, b) => a - b)[Math.floor(f * (v.length - 1))]
  const xa = pct(xs, 0.05), xb = pct(xs, 0.95)
  const rx = Math.min(0.13 * width, Math.max(0.07 * width, 0.575 * (xb - xa)))
  const ry = Math.min(0.75 * rx, Math.max(0.45 * rx, 0.65 * (pct(ys, 0.95) - pct(ys, 0.05))))
  return { x: (xa + xb) / 2, y: median(ys), z: median(zs), rx, ry }
}

/** O olho do tamanho típico (o dos modelos medidos, pela largura da cabeça) em (cx, cy). */
function typicalEye(samples: ArrayLike<number>, face: number[], cx: number, cy: number, width: number): Eye | null {
  const zs = face.filter((i) => Math.hypot(samples[i * STRIDE + S.x] - cx, samples[i * STRIDE + S.y] - cy) < 0.03 * width).map((i) => samples[i * STRIDE + S.z])
  if (!zs.length) return null
  return { x: cx, y: cy, z: median(zs), rx: 0.1 * width, ry: 0.06 * width }
}

/** O par de manchas (esquerda, direita): na mesma altura, no afastamento de dois olhos, em volta do meio da cabeça; a mais cheia. */
function pairOf(spots: Spot[], center: number, width: number): [Spot, Spot] | null {
  let pair: [Spot, Spot] | null = null
  for (const a of spots) {
    for (const b of spots) {
      const sep = b.x - a.x
      if (sep < 0.25 * width || sep > 0.6 * width || Math.abs(a.y - b.y) > 0.06 * width || Math.abs((a.x + b.x) / 2 - center) > 0.12 * width) continue
      if (!pair || Math.min(a.n, b.n) > Math.min(pair[0].n, pair[1].n)) pair = [a, b]
    }
  }
  return pair && Math.min(pair[0].n, pair[1].n) >= 3 ? pair : null
}

/**
 * Os pontos de íris: numa grade sobre o rosto, a célula escura com uma clara e sem cor dos dois lados na mesma
 * linha (o branco em volta da íris). A sobrancelha e o cabelo têm pele ou cabelo do lado, não o branco.
 */
function irisPoints(samples: ArrayLike<number>, face: number[], width: number): number[] {
  const at = (i: number, f: number): number => samples[i * STRIDE + f]
  const cell = width / 60
  const key = (gx: number, gy: number): number => (gx + 5000) * 10000 + (gy + 5000)
  const cells = new Map<number, { r: number; g: number; b: number; pts: number[] }>()
  for (const i of face) {
    const k = key(Math.floor(at(i, S.x) / cell), Math.floor(at(i, S.y) / cell))
    let c = cells.get(k)
    if (!c) cells.set(k, (c = { r: 0, g: 0, b: 0, pts: [] }))
    c.r += at(i, S.r); c.g += at(i, S.g); c.b += at(i, S.b)
    c.pts.push(i)
  }
  const kind = (gx: number, gy: number): number => {
    const c = cells.get(key(gx, gy))
    if (!c) return 0
    const n = c.pts.length
    const r = c.r / n, g = c.g / n, b = c.b / n
    const l = light(r, g, b)
    if (l < 0.33) return 1
    return l > 0.55 && Math.max(r, g, b) - Math.min(r, g, b) < 0.25 ? 2 : 0
  }
  const lit = (gx: number, gy: number, dir: number): boolean => {
    for (let d = 1; d <= 4; d++) for (let dy = -1; dy <= 1; dy++) if (kind(gx + dir * d, gy + dy) === 2) return true
    return false
  }
  const out: number[] = []
  for (const [k, c] of cells) {
    const gx = Math.floor(k / 10000) - 5000
    const gy = (k % 10000) - 5000
    if (kind(gx, gy) === 1 && lit(gx, gy, -1) && lit(gx, gy, 1)) out.push(...c.pts)
  }
  return out
}

interface Spot {
  x: number
  y: number
  /** Pontos brancos na mancha. */
  n: number
}

/** As manchas dos pontos brancos `pts` (até 10, da mais cheia): o centro é a mediana dos pontos em volta da célula. */
function whiteSpots(pts: number[], samples: ArrayLike<number>, width: number): Spot[] {
  const at = (i: number, f: number): number => samples[i * STRIDE + f]
  const cell = 0.04 * width
  const key = (gx: number, gy: number): number => (gx + 5000) * 10000 + (gy + 5000)
  const bins = new Map<number, number>()
  for (const i of pts) {
    const k = key(Math.floor(at(i, S.x) / cell), Math.floor(at(i, S.y) / cell))
    bins.set(k, (bins.get(k) ?? 0) + 1)
  }
  const cells: Array<[number, number, number]> = []
  for (const k of bins.keys()) {
    const gx = Math.floor(k / 10000) - 5000
    const gy = (k % 10000) - 5000
    let n = 0
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) n += bins.get(key(gx + dx, gy + dy)) ?? 0
    cells.push([gx, gy, n])
  }
  cells.sort((a, b) => b[2] - a[2])
  const spots: Spot[] = []
  const taken: Array<[number, number]> = []
  for (const [gx, gy] of cells) {
    if (spots.length >= 10) break
    if (taken.some(([x, y]) => Math.abs(x - gx) <= 2 && Math.abs(y - gy) <= 2)) continue
    taken.push([gx, gy])
    const cx = (gx + 0.5) * cell
    const cy = (gy + 0.5) * cell
    const near = pts.filter((i) => Math.hypot(at(i, S.x) - cx, at(i, S.y) - cy) < 0.07 * width)
    spots.push({ x: median(near.map((i) => at(i, S.x))), y: median(near.map((i) => at(i, S.y))), n: near.length })
  }
  return spots
}

/**
 * O olho em volta do branco (cx, cy): numa grade sobre o rosto, as células que não são pele ligadas
 * à do centro (o branco, a íris e o contorno); a sobrancelha fica de fora pela pele que a separa.
 */
function eyeBlob(samples: ArrayLike<number>, face: number[], cx: number, cy: number, width: number, skin: readonly number[]): Eye | null {
  const at = (i: number, f: number): number => samples[i * STRIDE + f]
  const cell = width / 90
  const hx = 0.2 * width
  const hy = 0.12 * width
  const nx = Math.ceil((2 * hx) / cell)
  const ny = Math.ceil((2 * hy) / cell)
  // Por célula: quantas amostras não são pele e quantas são (a maioria decide), e a profundidade.
  const off = new Uint16Array(nx * ny)
  const on = new Uint16Array(nx * ny)
  const zs: number[][] = Array.from({ length: nx * ny }, () => [])
  for (const i of face) {
    const gx = Math.floor((at(i, S.x) - (cx - hx)) / cell)
    const gy = Math.floor((at(i, S.y) - (cy - hy)) / cell)
    if (gx < 0 || gy < 0 || gx >= nx || gy >= ny) continue
    const k = gy * nx + gx
    const d = Math.hypot(at(i, S.r) - skin[0], at(i, S.g) - skin[1], at(i, S.b) - skin[2])
    if (d > SKIN_DIST) off[k]++
    else on[k]++
    zs[k].push(at(i, S.z))
  }
  const notSkin = (k: number): boolean => off[k] > on[k]
  // Começa na célula que não é pele mais perto do centro (o branco às vezes cai entre duas células).
  let start = -1
  for (let r = 0; r <= 3 && start < 0; r++) {
    for (let dy = -r; dy <= r && start < 0; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const k = (Math.floor(ny / 2) + dy) * nx + Math.floor(nx / 2) + dx
        if (notSkin(k)) {
          start = k
          break
        }
      }
    }
  }
  if (start < 0) return null
  const seen = new Uint8Array(nx * ny)
  const stack = [start]
  seen[start] = 1
  let gx0 = nx, gx1 = -1, gy0 = ny, gy1 = -1
  const depth: number[] = []
  while (stack.length) {
    const k = stack.pop()!
    const gx = k % nx
    const gy = (k - gx) / nx
    gx0 = Math.min(gx0, gx); gx1 = Math.max(gx1, gx)
    gy0 = Math.min(gy0, gy); gy1 = Math.max(gy1, gy)
    for (const z of zs[k]) depth.push(z)
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = gx + dx
      const y = gy + dy
      if (x < 0 || y < 0 || x >= nx || y >= ny) continue
      const j = y * nx + x
      if (seen[j] || !notSkin(j)) continue
      seen[j] = 1
      stack.push(j)
    }
  }
  // Encostou na borda da grade: vazou para o cabelo ou para a sobrancelha.
  if (gx0 === 0 || gy0 === 0 || gx1 === nx - 1 || gy1 === ny - 1) return null
  const rx = ((gx1 - gx0 + 1) * cell) / 2
  const ry = ((gy1 - gy0 + 1) * cell) / 2
  if (rx < 0.02 * width || ry > 1.2 * rx) return null
  return { x: cx - hx + ((gx0 + gx1 + 1) * cell) / 2, y: cy - hy + ((gy0 + gy1 + 1) * cell) / 2, z: median(depth), rx, ry }
}
