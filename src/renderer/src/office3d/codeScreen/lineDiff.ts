/**
 * Diff de linhas (LCS) — PURO. É o "como no GitHub" do monitor de código: só as
 * linhas que mudaram de verdade saem coloridas.
 *
 * Corta o prefixo e o sufixo iguais; o miolo vai para a tabela da LCS quando
 * cabe (MAX_CELLS células) e, quando não cabe, é partido pelas linhas que
 * aparecem uma vez só dos dois lados (âncoras, como no "patience diff"). Sem
 * âncora, um bloco removido seguido de um bloco adicionado — honesto, só menos
 * fino. Num trecho trocado as removidas vêm antes das adicionadas.
 */

export type DiffOp = { op: 'eq'; a: number; b: number } | { op: 'del'; a: number } | { op: 'add'; b: number }

/** Tabela da LCS: até isto de células (Uint16, ~4 MB). Com n·m ≤ isto, a LCS cabe em 16 bits. */
const MAX_CELLS = 2_000_000
/** Profundidade da partição por âncoras. */
const MAX_DEPTH = 12

type Lines = readonly string[]

export function diffLines(a: Lines, b: Lines): DiffOp[] {
  const out: DiffOp[] = []
  range(a, 0, a.length, b, 0, b.length, out, 0)
  return out
}

function range(a: Lines, a0: number, a1: number, b: Lines, b0: number, b1: number, out: DiffOp[], depth: number): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push({ op: 'eq', a: a0++, b: b0++ })
  let ea = a1
  let eb = b1
  while (ea > a0 && eb > b0 && a[ea - 1] === b[eb - 1]) {
    ea--
    eb--
  }
  middle(a, a0, ea, b, b0, eb, out, depth)
  for (let k = 0; ea + k < a1; k++) out.push({ op: 'eq', a: ea + k, b: eb + k })
}

function middle(a: Lines, a0: number, a1: number, b: Lines, b0: number, b1: number, out: DiffOp[], depth: number): void {
  const n = a1 - a0
  const m = b1 - b0
  if (n === 0 || m === 0) return block(a0, a1, b0, b1, out)
  if (n * m <= MAX_CELLS) return lcs(a, a0, a1, b, b0, b1, out)
  const anchors = depth < MAX_DEPTH ? uniqueAnchors(a, a0, a1, b, b0, b1) : []
  if (anchors.length === 0) return block(a0, a1, b0, b1, out)
  let pa = a0
  let pb = b0
  for (const [i, j] of anchors) {
    range(a, pa, i, b, pb, j, out, depth + 1)
    out.push({ op: 'eq', a: i, b: j })
    pa = i + 1
    pb = j + 1
  }
  range(a, pa, a1, b, pb, b1, out, depth + 1)
}

function block(a0: number, a1: number, b0: number, b1: number, out: DiffOp[]): void {
  for (let i = a0; i < a1; i++) out.push({ op: 'del', a: i })
  for (let j = b0; j < b1; j++) out.push({ op: 'add', b: j })
}

/** LCS clássica: t[i][j] = LCS de a[i..] e b[j..]; o caminho prefere remover antes de adicionar. */
function lcs(a: Lines, a0: number, a1: number, b: Lines, b0: number, b1: number, out: DiffOp[]): void {
  const n = a1 - a0
  const m = b1 - b0
  const w = m + 1
  const t = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[a0 + i] === b[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push({ op: 'eq', a: a0 + i++, b: b0 + j++ })
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
      out.push({ op: 'del', a: a0 + i++ })
    } else {
      out.push({ op: 'add', b: b0 + j++ })
    }
  }
  while (i < n) out.push({ op: 'del', a: a0 + i++ })
  while (j < m) out.push({ op: 'add', b: b0 + j++ })
}

/** Linhas que aparecem uma vez só em cada lado, na maior sequência crescente dos dois índices. */
function uniqueAnchors(a: Lines, a0: number, a1: number, b: Lines, b0: number, b1: number): Array<[number, number]> {
  const inA = new Map<string, number>()
  for (let i = a0; i < a1; i++) inA.set(a[i], inA.has(a[i]) ? -1 : i)
  const inB = new Map<string, number>()
  for (let j = b0; j < b1; j++) inB.set(b[j], inB.has(b[j]) ? -1 : j)
  const pairs: Array<[number, number]> = []
  for (let i = a0; i < a1; i++) {
    if (inA.get(a[i]) !== i) continue
    const j = inB.get(a[i])
    if (j !== undefined && j >= 0) pairs.push([i, j])
  }
  // Maior subsequência crescente em j (os pares já vêm em ordem de i).
  const tails: number[] = []
  const prev = new Int32Array(pairs.length).fill(-1)
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1]
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (pairs[tails[mid]][1] < j) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[k] = tails[lo - 1]
    tails[lo] = k
  }
  const out: Array<[number, number]> = []
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) out.push(pairs[k])
  return out.reverse()
}
