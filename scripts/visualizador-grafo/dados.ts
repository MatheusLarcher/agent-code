/**
 * Funções puras do visualizador dos grafos de memórias (D32): tema, data, nível,
 * perfis de tema e ligações por cosseno. Sem disco e sem rede — o `gerar.ts` lê os
 * arquivos e chama estas funções; os testes as exercitam direto.
 */
import { cosineOf } from '../../src/main/memoryRanker'

export const NIVEIS = ['fast', 'curto', 'medio', 'longo', 'observacoes'] as const
export type Nivel = (typeof NIVEIS)[number]

export const TEMA_GERAL = 'geral'
const DIA_MS = 86_400_000

/** Tema = a primeira pasta da memória; arquivo solto na raiz vai para `geral`. */
export function temaDe(folders: readonly string[]): string {
  const primeira = folders[0]?.trim()
  return primeira ? primeira : TEMA_GERAL
}

/** Meia-noite UTC do dia, ou null se a data não existe (31/02, mês 13…). */
function diaUtc(ano: number, mes: number, dia: number): number | null {
  if (ano < 2000 || ano > 2099 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  const t = Date.UTC(ano, mes - 1, dia)
  const d = new Date(t)
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? t : null
}

/** Datas escritas no texto (AAAA-MM-DD e D/M/AAAA), em ms UTC, sem repetir, em ordem. */
export function datasNoTexto(texto: string): number[] {
  const achadas = new Set<number>()
  for (const m of texto.matchAll(/(?<!\d)(20\d\d)-(\d\d)-(\d\d)(?!\d)/g)) {
    const t = diaUtc(Number(m[1]), Number(m[2]), Number(m[3]))
    if (t !== null) achadas.add(t)
  }
  for (const m of texto.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})\/(20\d\d)(?![\d/])/g)) {
    const t = diaUtc(Number(m[3]), Number(m[2]), Number(m[1]))
    if (t !== null) achadas.add(t)
  }
  return [...achadas].sort((a, b) => a - b)
}

/**
 * Data da memória = a mais recente escrita no texto que não passa de `hoje`.
 * Datas futuras (prazos, planos) não contam. Null quando o texto não traz data.
 */
export function dataDaMemoria(texto: string, hoje: number): number | null {
  const limite = inicioDoDia(hoje)
  const validas = datasNoTexto(texto).filter((t) => t <= limite)
  return validas.length ? validas[validas.length - 1] : null
}

export function inicioDoDia(t: number): number {
  return Math.floor(t / DIA_MS) * DIA_MS
}

/**
 * Nível pela idade da data (REGRAS-MEMORIA §4, só com datas): fast ≤ 24 h (hoje
 * ou ontem, já que a data é do dia), curto ≤ 7 dias, médio ≤ 60 dias, longo o resto.
 * Sem data → longo ("o resto"). Observações não saem daqui: dependem de quem cura.
 */
export function nivelDe(data: number | null, hoje: number): Exclude<Nivel, 'observacoes'> {
  if (data === null) return 'longo'
  const dias = (inicioDoDia(hoje) - inicioDoDia(data)) / DIA_MS
  if (dias <= 1) return 'fast'
  if (dias <= 7) return 'curto'
  if (dias <= 60) return 'medio'
  return 'longo'
}

export function dataIso(t: number | null): string | null {
  return t === null ? null : new Date(t).toISOString().slice(0, 10)
}

/** Média elemento a elemento. Vazio → []. */
export function media(vetores: readonly (readonly number[])[]): number[] {
  if (vetores.length === 0) return []
  const out = new Array<number>(vetores[0].length).fill(0)
  for (const v of vetores) for (let i = 0; i < out.length; i++) out[i] += v[i] ?? 0
  return out.map((x) => x / vetores.length)
}

/** Tira a média do acervo de cada vetor: sobra o que distingue, não o que todos têm. */
export function centralizar(vetores: readonly (readonly number[])[]): number[][] {
  const m = media(vetores)
  return vetores.map((v) => v.map((x, i) => x - m[i]))
}

export interface Ligacao {
  a: number
  b: number
  cosseno: number
}

/**
 * Ligações "parecida": cada item liga aos seus `k` vizinhos mais próximos com cosseno
 * ≥ `limiar`. Não dirigida e sem repetir (a < b). Ordem: a, depois b.
 */
export function vizinhosMaisProximos(vetores: readonly (readonly number[])[], k: number, limiar: number): Ligacao[] {
  const n = vetores.length
  const pares = new Map<string, Ligacao>()
  for (let i = 0; i < n; i++) {
    const candidatos: Array<[number, number]> = []
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const c = cosineOf(vetores[i], vetores[j])
      if (c >= limiar) candidatos.push([j, c])
    }
    candidatos.sort((x, y) => y[1] - x[1] || x[0] - y[0])
    for (const [j, c] of candidatos.slice(0, k)) {
      const a = Math.min(i, j)
      const b = Math.max(i, j)
      pares.set(`${a}:${b}`, { a, b, cosseno: c })
    }
  }
  return [...pares.values()].sort((x, y) => x.a - y.a || x.b - y.b)
}

/** Reescala para 0–1 (min→0, max→1). Todos iguais → 1. */
export function escalar(valores: readonly number[]): number[] {
  if (valores.length === 0) return []
  const min = Math.min(...valores)
  const max = Math.max(...valores)
  return valores.map((v) => (max === min ? 1 : (v - min) / (max - min)))
}

/** Percentil (0–100) por interpolação linear. Vazio → NaN. */
export function percentil(valores: readonly number[], p: number): number {
  if (valores.length === 0) return Number.NaN
  const s = [...valores].sort((a, b) => a - b)
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

const PARADAS = new Set(
  ('a o e é de da do das dos em no na nos nas um uma uns umas para pra por com sem que se ' +
    'não nao ao aos à às ou como mais menos já ja quando onde qual quais sobre entre até ate ' +
    'antes depois também tambem só so isso este esta esse essa ele ela eles elas seu sua ' +
    'tem ter ser sempre nunca vez vai foi são sao the and of to in for is on with').split(/\s+/)
)

/** Palavras do texto, minúsculas, sem acento-lixo e sem palavras vazias. */
export function palavras(texto: string): string[] {
  return (texto.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((p) => !PARADAS.has(p) && !/^\d+$/.test(p))
}

/**
 * Palavras características de cada grupo (TF × IDF entre grupos): as que aparecem
 * muito no grupo e pouco nos outros. Devolve até `n` por grupo, melhor primeiro.
 */
export function palavrasCaracteristicas(grupos: ReadonlyMap<string, readonly string[]>, n: number): Map<string, string[]> {
  const contagens = new Map<string, Map<string, number>>()
  const df = new Map<string, number>()
  for (const [grupo, textos] of grupos) {
    const tf = new Map<string, number>()
    for (const t of textos) for (const p of palavras(t)) tf.set(p, (tf.get(p) ?? 0) + 1)
    contagens.set(grupo, tf)
    for (const p of tf.keys()) df.set(p, (df.get(p) ?? 0) + 1)
  }
  const total = grupos.size
  const out = new Map<string, string[]>()
  for (const [grupo, tf] of contagens) {
    const notas = [...tf].map(([p, f]): [string, number] => [p, f * Math.log((1 + total) / (df.get(p) ?? 1))])
    notas.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    out.set(grupo, notas.slice(0, n).map(([p]) => p))
  }
  return out
}

/** Gerador pseudoaleatório com semente (mulberry32): o mesmo layout a cada geração. */
export function aleatorio(semente: number): () => number {
  let s = semente >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
