#!/usr/bin/env node
// Compara o app principal (congelado) com o app de teste (com as correções), lado a lado.
// Lê o analise-*.json mais recente de cada um e grava comparativo-<data>.md na raiz da
// saída. Só números: nenhum trecho de conversa entra no comparativo.
//
// Uso: node scripts/analise-conversas/comparar.mjs   (rode antes o analisar.mjs de cada app)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const RAIZ = process.env.AC_SAIDA ?? join(LOCAL, 'agent-code', 'analise-conversas')

function ultimo(instancia) {
  const dir = join(RAIZ, instancia)
  if (!existsSync(dir)) return null
  const arq = readdirSync(dir).filter((a) => /^analise-.*\.json$/.test(a)).sort().at(-1)
  return arq ? JSON.parse(readFileSync(join(dir, arq), 'utf8')).total : null
}

// [rótulo, leitor, "menor é melhor"?]
const LINHAS = [
  ['Pedidos analisados', (t) => t.pedidos, null],
  ['Tokens por pedido (conversa)', (t) => t.porPedido?.tokensEntrada, true],
  ['Tokens por pedido (observadores)', (t) => t.porPedido?.tokensObservadores, true],
  ['Contexto inicial (mediana)', (t) => t.contextoInicialMediana, true],
  ['Maior contexto', (t) => t.maiorContexto, true],
  ['Chamadas ao modelo por pedido', (t) => t.porPedido?.chamadasModelo, true],
  ['Tempo por pedido, mediana (s)', (t) => t.porPedido?.segundosMediana, true],
  ['Erros de ferramenta por pedido', (t) => t.porPedido?.errosFerramenta, true],
  ['Recusas de ferramenta', (t) => t.recusas, true],
  ['Retrabalho (% dos pedidos)', (t) => t.retrabalhoPct, true],
  ['Delírios apontados', (t) => t.delirios, true],
  ['Saídas de terminal coladas', (t) => t.colouTerminal, true],
  ['Resumos de contexto no meio', (t) => t.resumosContexto, true],
  ['Falhas de hook', (t) => Object.values(t.hooksQuebrados ?? {}).reduce((s, n) => s + n, 0), true]
]

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'))

function veredito(a, b, menorMelhor) {
  if (menorMelhor == null || a == null || b == null || a === b) return ''
  const melhor = menorMelhor ? b < a : b > a
  const pct = a ? ` (${b > a ? '+' : ''}${Math.round((100 * (b - a)) / a)}%)` : ''
  return `${melhor ? '✅ Homol melhor' : '⚠️ Homol pior'}${pct}`
}

const principal = ultimo('principal')
const teste = ultimo('teste')
if (!principal && !teste) {
  console.error(`Nenhuma análise encontrada em ${RAIZ}. Rode antes: node scripts/analise-conversas/analisar.mjs principal (e teste)`)
  process.exit(1)
}

const hoje = new Date().toISOString().slice(0, 10)
const linhas = [
  `# Comparativo de uso — principal × Homol — ${hoje}`,
  '',
  `- **Principal** (app instalado, congelado): ${principal ? `análise de ${principal.geradoEm.slice(0, 16)}, desde ${principal.desde?.slice(0, 10)}` : 'sem análise'}`,
  `- **Teste = Agent Code Homol** (com as correções): ${teste ? `análise de ${teste.geradoEm.slice(0, 16)}, desde ${teste.desde?.slice(0, 10)}` : 'sem análise (abra a Homol e use-a)'}`,
  '',
  'Compare os valores **por pedido**: os dois apps têm volumes diferentes de uso.',
  'Com menos de ~20 pedidos num dos lados, a diferença ainda é ruído.',
  '',
  '| Medida | Principal | Homol | Resultado |',
  '|---|---:|---:|---|',
  ...LINHAS.map(([rotulo, ler, menor]) => {
    const a = principal ? ler(principal) : null
    const b = teste ? ler(teste) : null
    // Com menos de 20 pedidos num dos lados, não há veredito (0 pedidos virava "teste melhor -100%").
    const poucos = Math.min(principal?.pedidos ?? 0, teste?.pedidos ?? 0) < 20
    return `| ${rotulo} | ${fmt(a)} | ${fmt(b)} | ${menor != null && poucos ? 'poucos dados' : veredito(a, b, menor)} |`
  }),
  ...secaoMemorias(principal, teste)
]

/** Memórias gravadas por autor: o memorista novo deve COMPLEMENTAR mais e criar menos
 *  repetidas; o bibliotecário só aparece quando estiver em "Organizar de verdade". */
function secaoMemorias(a, b) {
  const autores = [...new Set([...Object.keys(a?.memorias ?? {}), ...Object.keys(b?.memorias ?? {})])].sort()
  if (!autores.length) return ['', '## Memórias gravadas', '', 'Nenhuma memória gravada no período (ou análise antiga, sem esta contagem).']
  const cel = (m) => (m ? `${m.criadas} / ${m.complementadas} / ${m.aposentadas}` : '—')
  return [
    '',
    '## Memórias gravadas (criadas / complementadas / aposentadas)',
    '',
    'Memorista funcionando bem = mais **complementadas** que criadas (ele achou a memória do mesmo assunto em vez de duplicar).',
    '',
    '| Quem gravou | Principal | Homol |',
    '|---|---:|---:|',
    ...autores.map((autor) => `| ${autor} | ${cel(a?.memorias?.[autor])} | ${cel(b?.memorias?.[autor])} |`)
  ]
}
const saida = join(RAIZ, `comparativo-${hoje}.md`)
writeFileSync(saida, linhas.join('\n') + '\n')
console.log(linhas.join('\n'))
console.log(`\nGravado em ${saida}`)
