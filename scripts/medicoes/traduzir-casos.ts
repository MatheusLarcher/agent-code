// Leva um casos.json (gabarito do teste de escolha de memórias) para o acervo
// consolidado, usando o mapa.json gerado por consolidar-memorias.ts. Esperadas
// que viraram a mesma memória colapsam numa só.
//
// Uso (da raiz do repo):
//   npx esbuild scripts/medicoes/traduzir-casos.ts --bundle --platform=node --format=esm --packages=external --outfile=scripts/medicoes/.traduzir.tmp.mjs
//   node scripts/medicoes/.traduzir.tmp.mjs --casos <casos.json> --mapa <mapa.json> [--saida <casos-consolidado.json>]
// Ou, sem gerar arquivo: npx jiti scripts/medicoes/traduzir-casos.ts --casos ... --mapa ...
// Sem --saida, grava casos-consolidado.json ao lado do casos.json.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Item = string | { umaDe: string[] }

export interface Caso {
  id?: string
  esperadas: Item[]
  aceitaveis?: string[]
  [outro: string]: unknown
}

export type Mapa = Record<string, string>

/** Traduz um caso: troca caminhos pelo novo, colapsa repetidas e resolve grupos que passaram a se cruzar. */
export function traduzirCaso(caso: Caso, mapa: Mapa, avisos: string[] = []): Caso {
  const rotulo = caso.id ?? '(sem id)'
  const novo = (c: string): string => {
    if (c in mapa) return mapa[c]
    avisos.push(`caso ${rotulo}: ${c} não está no mapa; ficou igual`)
    return c
  }
  // Cada item vira um conjunto de caminhos aceitos (solto = conjunto de 1).
  let itens: Set<string>[] = caso.esperadas.map((it) => new Set(typeof it === 'string' ? [novo(it)] : it.umaDe.map(novo)))
  // Junta itens que se cruzam: um solto dentro de um grupo fica só o solto (vale exatamente ele);
  // dois grupos que se cruzam viram a união (com aviso).
  for (let mudou = true; mudou; ) {
    mudou = false
    fora: for (let i = 0; i < itens.length; i++) {
      for (let j = i + 1; j < itens.length; j++) {
        const a = itens[i]
        const b = itens[j]
        if (![...a].some((c) => b.has(c))) continue
        let junto: Set<string>
        if (a.size === 1 || b.size === 1) junto = a.size <= b.size ? a : b
        else {
          junto = new Set([...a, ...b])
          avisos.push(`caso ${rotulo}: dois grupos "umaDe" passaram a se cruzar e viraram um só`)
        }
        itens = itens.filter((_, k) => k !== i && k !== j)
        itens.splice(i, 0, junto)
        mudou = true
        break fora
      }
    }
  }
  const esperadas: Item[] = itens.map((s) => (s.size === 1 ? [...s][0] : { umaDe: [...s] }))
  const usados = new Set(itens.flatMap((s) => [...s]))
  const out: Caso = { ...caso, esperadas }
  if (caso.aceitaveis) {
    const aceitaveis = [...new Set(caso.aceitaveis.map(novo))].filter((c) => !usados.has(c))
    if (aceitaveis.length) out.aceitaveis = aceitaveis
    else delete out.aceitaveis
  }
  return out
}

/** Aceita a lista de casos ou um objeto com `casos`, como o avaliador. */
export function traduzirCasos(dados: unknown, mapa: Mapa): { dados: unknown; avisos: string[] } {
  const avisos: string[] = []
  const lista = Array.isArray(dados) ? dados : (dados as { casos?: unknown })?.casos
  if (!Array.isArray(lista)) throw new Error('casos.json precisa ser uma lista de casos ou { "casos": [...] }')
  for (const c of lista as Caso[]) {
    if (!c || !Array.isArray(c.esperadas)) throw new Error(`caso ${c?.id ?? '?'} sem "esperadas"`)
    for (const it of c.esperadas) {
      const ok = typeof it === 'string' || (it && Array.isArray(it.umaDe) && it.umaDe.length > 0 && it.umaDe.every((x) => typeof x === 'string'))
      if (!ok) throw new Error(`caso ${c.id ?? '?'}: item de "esperadas" inválido`)
    }
  }
  const traduzidos = (lista as Caso[]).map((c) => traduzirCaso(c, mapa, avisos))
  return { dados: Array.isArray(dados) ? traduzidos : { ...(dados as object), casos: traduzidos }, avisos }
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function main(): void {
  const casosArg = arg('casos')
  const mapaArg = arg('mapa')
  if (!casosArg || !mapaArg) throw new Error('uso: --casos <casos.json> --mapa <mapa.json> [--saida <casos-consolidado.json>]')
  const casos = resolve(casosArg)
  const mapa = JSON.parse(readFileSync(resolve(mapaArg), 'utf8')) as unknown
  if (!mapa || typeof mapa !== 'object' || Array.isArray(mapa) || Object.values(mapa).some((v) => typeof v !== 'string')) {
    throw new Error('mapa.json precisa ser { "caminho-antigo": "caminho-novo" }')
  }
  const { dados, avisos } = traduzirCasos(JSON.parse(readFileSync(casos, 'utf8')), mapa as Mapa)
  const saida = resolve(arg('saida') ?? join(dirname(casos), 'casos-consolidado.json'))
  if (saida === casos) throw new Error('--saida não pode sobrescrever o casos.json de origem')
  writeFileSync(saida, `${JSON.stringify(dados, null, 2)}\n`)
  for (const a of avisos) console.log(`aviso: ${a}`)
  console.log(`Gravado: ${saida}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (e) {
    console.error(`ERRO: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  }
}
