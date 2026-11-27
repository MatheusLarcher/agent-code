/**
 * Cabeçalho das memórias (layout novo — D43, D48, D49): o que o memorista grava e o
 * bibliotecário completa. O cabeçalho serve para ACHAR a memória; o corpo, abaixo dele,
 * continua sendo a memória completa e nunca é resumido nem cortado aqui (D49).
 *
 * Campos: tema, criada, modificada, importancia (1–5), gatilhos (3–6 jeitos de o usuário
 * pedir), termos, contexto (projeto + o que se fazia), contradiz, relacionadas, substitui.
 * Funções puras: o memorista, o bibliotecário e os scripts de medição usam as mesmas.
 */

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export const CAMPOS_LISTA = ['gatilhos', 'termos', 'contradiz', 'relacionadas', 'substitui'] as const
export const CAMPOS_TEXTO = ['tema', 'criada', 'modificada', 'importancia', 'contexto', 'origem'] as const
type CampoLista = (typeof CAMPOS_LISTA)[number]
type CampoTexto = (typeof CAMPOS_TEXTO)[number]

export type CamposCabecalho = Partial<Record<CampoTexto, string> & Record<CampoLista, string[]>>

/** Uma linha só, sem quebra nem aspas soltas: o valor não pode abrir outra chave YAML. */
function linha(valor: string): string {
  return valor.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Separa cabeçalho e corpo. Sem cabeçalho, `front` vem vazio e o corpo é o conteúdo todo. */
export function separar(conteudo: string): { front: string; corpo: string; tem: boolean } {
  const m = FRONT.exec(conteudo ?? '')
  if (!m) return { front: '', corpo: conteudo ?? '', tem: false }
  return { front: m[1], corpo: conteudo.slice(m[0].length), tem: true }
}

/** Tira do cabeçalho as chaves dadas, inclusive listas em bloco (`chave:` + linhas `  - x`). */
function semChaves(front: string, chaves: readonly string[]): string {
  const fora = new Set(chaves)
  const out: string[] = []
  let pulando = false
  for (const l of front.split(/\r?\n/)) {
    // Chave de 1º nível decide; linha recuada (item de lista, sub-chave) segue a chave de cima.
    const chave = /^([A-Za-zÀ-ú_]+):/.exec(l)?.[1]
    if (chave !== undefined) pulando = fora.has(chave)
    if (!pulando) out.push(l)
  }
  return out.join('\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * Grava os campos dados no cabeçalho (cria um se não houver), trocando os que já existiam
 * e mantendo o resto (name, description, metadata, sempre…). O corpo não muda.
 * Campo `undefined` não mexe; lista vazia ou texto vazio REMOVE o campo.
 */
export function comCampos(conteudo: string, campos: CamposCabecalho): string {
  const { front, corpo } = separar(conteudo)
  const chaves = Object.keys(campos).filter((k) => (campos as Record<string, unknown>)[k] !== undefined)
  const novas: string[] = []
  for (const k of CAMPOS_TEXTO) {
    const v = campos[k]
    if (v !== undefined && linha(v)) novas.push(`${k}: ${linha(v)}`)
  }
  for (const k of CAMPOS_LISTA) {
    const v = (campos[k] ?? []).map(linha).filter(Boolean)
    if (campos[k] !== undefined && v.length) novas.push(`${k}:`, ...v.map((x) => `  - ${JSON.stringify(x)}`))
  }
  const base = semChaves(front, chaves)
  const cabecalho = [base, ...novas].filter(Boolean).join('\n')
  return `---\n${cabecalho}\n---\n${corpo.replace(/^\r?\n/, '')}`
}

function valor(front: string, chave: string): string | undefined {
  const v = new RegExp(`^${chave}:[ \\t]*(.+?)\\s*$`, 'm').exec(front)?.[1]?.trim()
  return v ? v.replace(/^["'](.*)["']$/, '$1') : undefined
}

/** Lista YAML em bloco ou em linha (`["a","b"]`). */
function listaDe(front: string, chave: string): string[] {
  const emLinha = new RegExp(`^${chave}:[ \\t]*(\\[.*\\])\\s*$`, 'm').exec(front)?.[1]
  if (emLinha) {
    try {
      const v = JSON.parse(emLinha) as unknown
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const bloco = new RegExp(`^${chave}:[ \\t]*\\r?\\n((?:[ \\t]+-.*(?:\\r?\\n|$))+)`, 'm').exec(front)?.[1] ?? ''
  return bloco
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .map((l) => {
      try {
        return l.startsWith('"') ? (JSON.parse(l) as string) : l
      } catch {
        return l
      }
    })
    .filter(Boolean)
}

/** Lê os campos do layout novo que existirem. */
export function lerCampos(conteudo: string): CamposCabecalho {
  const { front } = separar(conteudo)
  const out: CamposCabecalho = {}
  for (const k of CAMPOS_TEXTO) {
    const v = valor(front, k)
    if (v) out[k] = v
  }
  for (const k of CAMPOS_LISTA) {
    const v = listaDe(front, k)
    if (v.length) out[k] = v
  }
  return out
}

/** Data no formato do cabeçalho (AAAA-MM-DD). */
export function dataCabecalho(quando: number | Date): string {
  return new Date(quando).toISOString().slice(0, 10)
}

/** A memória ainda está no layout antigo? (falta tema, datas ou gatilhos) */
export function faltaLayoutNovo(conteudo: string): { tema: boolean; datas: boolean; gatilhos: boolean } {
  const c = lerCampos(conteudo)
  return { tema: !c.tema, datas: !c.criada || !c.modificada, gatilhos: !c.gatilhos?.length }
}
