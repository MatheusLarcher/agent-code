#!/usr/bin/env node
// Tamanho do contexto que o app entrega ao agente no 1º turno de cada conversa.
//
// SÓ LEITURA (mesma cópia temporária do banco que analisar.mjs, ver banco.mjs).
// Lê só context_turn.blocks_json (tipo, rótulo, origem, bytes) e usage_json
// (contagem do SDK no fim do turno). Não lê o texto dos blocos (context_blob),
// o pedido, as memórias nem as senhas: a saída tem só tamanhos e nomes de bloco.
//
// Uso:  node scripts/analise-conversas/contexto.mjs [principal|teste]
// Env:  AC_PORT (15498 — o analisar.mjs agendado usa 15499), AC_PGDATA, AC_PG_BIN,
//       AC_CONVERSAS (quantas conversas detalhar, das mais recentes; 15; 0 = todas)

import { INSTANCIAS, instancia, lerBanco } from './banco.mjs'
import { mediana } from './metricas.mjs'

const INSTANCIA = instancia(process.argv[2])
const PGDATA = process.env.AC_PGDATA ?? INSTANCIAS[INSTANCIA].pgdata
const PORT = Number(process.env.AC_PORT ?? 15498)
const DETALHAR = Number(process.env.AC_CONVERSAS ?? 15)
const INICIAL = new Set(['system', 'prompt', 'hook-start'])

const tok = (bytes) => Math.round((Number(bytes) || 0) / 4)
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-')
const col = (s, n) => String(s).slice(0, n).padEnd(n)
const num = (s, n) => String(s).padStart(n)

/** Rótulo do bloco: o fixo do app; o de subagente leva tipo e etiqueta, então vira só o tipo. */
const rotulo = (b) => (String(b.kind).startsWith('subagent') ? b.kind : String(b.label ?? b.kind))

function porBloco(blocks) {
  const grupos = new Map()
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const chave = `${b.kind}/${b.source}`
    const g = grupos.get(chave) ?? { chave, rotulo: rotulo(b), n: 0, tokens: 0, inicial: INICIAL.has(b.source) }
    g.n++
    g.tokens += tok(b.bytes)
    grupos.set(chave, g)
  }
  return [...grupos.values()].sort((a, b) => b.tokens - a.tokens)
}

function doSdk(usage) {
  if (!usage || typeof usage !== 'object' || !Number(usage.totalTokens)) return null
  const soma = (lista) => (Array.isArray(lista) ? lista.reduce((s, x) => s + (Number(x.tokens) || 0), 0) : 0)
  const mcp = {}
  for (const t of usage.mcpTools ?? []) mcp[t.serverName] = (mcp[t.serverName] ?? 0) + (Number(t.tokens) || 0)
  return {
    total: Number(usage.totalTokens), max: Number(usage.maxTokens) || 0,
    categorias: (usage.categories ?? []).filter((c) => c.kind !== 'free' && c.kind !== 'buffer')
      .map((c) => ({ nome: c.kind === 'deferred' && !/deferred/i.test(c.name) ? `${c.name} (deferred)` : c.name, tokens: Number(c.tokens) || 0 })),
    mcp, ferramentasSistema: soma(usage.systemTools), skills: soma(usage.skills)
  }
}

async function main() {
  const turnos = await lerBanco(PGDATA, PORT, (q) => q(`SELECT DISTINCT ON (conv_id) conv_id, started_at, model, provider,
    complete, blocks_json blocks, usage_json usage FROM context_turn ORDER BY conv_id, started_at, turn_id`))
  const convs = turnos.map((t) => {
    const blocos = porBloco(t.blocks)
    const total = blocos.reduce((s, g) => s + g.tokens, 0)
    return { id: String(t.conv_id).slice(0, 8), em: Number(t.started_at), modelo: t.model || t.provider, completo: t.complete,
      blocos, total, inicial: blocos.filter((g) => g.inicial).reduce((s, g) => s + g.tokens, 0), sdk: doSdk(t.usage) }
  }).sort((a, b) => b.em - a.em)

  const L = (s = '') => console.log(s)
  L(`# Contexto do 1º turno — ${INSTANCIA} — ${new Date().toISOString()}`)
  L(`# ${convs.length} conversas. Tokens ESTIMADOS = bytes/4 do texto mascarado (não é a contagem do modelo).`)
  L('# "inicial" = system + prompt + hook-start; o resto é o reenvio no meio do turno (hook-mid) e retomadas.')
  L('# "SDK" = getContextUsage medido no FIM do turno (inclui ferramentas e a conversa do turno), quando gravado.')

  for (const c of DETALHAR ? convs.slice(0, DETALHAR) : convs) {
    L(`\n## ${c.id} · ${new Date(c.em).toISOString().slice(0, 16).replace('T', ' ')} · ${c.modelo}${c.completo ? '' : ' · incompleto'}`)
    L(`  ${col('bloco', 34)} ${col('tipo/origem', 30)} ${num('n', 3)} ${num('~tokens', 8)} ${num('%', 5)}`)
    for (const g of c.blocos) L(`  ${col(g.rotulo, 34)} ${col(g.chave, 30)} ${num(g.n, 3)} ${num(g.tokens, 8)} ${num(pct(g.tokens, c.total), 5)}`)
    L(`  estimado: ${k(c.total)} (inicial ${k(c.inicial)}, resto ${k(c.total - c.inicial)})`)
    if (!c.sdk) { L('  SDK: sem medição'); continue }
    L(`  SDK: ${k(c.sdk.total)} de ${k(c.sdk.max)} · ${c.sdk.categorias.map((x) => `${x.nome} ${k(x.tokens)}`).join(' · ')}`)
    const mcp = Object.entries(c.sdk.mcp).sort((a, b) => b[1] - a[1])
    if (mcp.length) L(`  MCP por servidor (inclui as deferred): ${mcp.map(([s, t]) => `${s} ${k(t)}`).join(' · ')}`)
  }

  // Agregado: cada tipo/origem nas conversas em que aparece.
  const tipos = new Map()
  for (const c of convs) for (const g of c.blocos) {
    const a = tipos.get(g.chave) ?? { chave: g.chave, rotulo: g.rotulo, convs: 0, soma: 0, valores: [], pcts: [] }
    a.convs++; a.soma += g.tokens; a.valores.push(g.tokens); a.pcts.push(c.total ? (100 * g.tokens) / c.total : 0)
    tipos.set(g.chave, a)
  }
  const somaTudo = convs.reduce((s, c) => s + c.total, 0)
  L(`\n# Agregado — maiores tipos de bloco no 1º turno (${convs.length} conversas, ${k(somaTudo)} tokens estimados)`)
  L(`  ${col('bloco', 34)} ${col('tipo/origem', 30)} ${num('convs', 5)} ${num('soma', 8)} ${num('%soma', 6)} ${num('mediana', 8)} ${num('%turno', 7)}`)
  for (const a of [...tipos.values()].sort((x, y) => y.soma - x.soma)) {
    L(`  ${col(a.rotulo, 34)} ${col(a.chave, 30)} ${num(a.convs, 5)} ${num(k(a.soma), 8)} ${num(pct(a.soma, somaTudo), 6)} ${num(k(mediana(a.valores)), 8)} ${num(`${mediana(a.pcts.map(Math.round))}%`, 7)}`)
  }

  const medidas = convs.filter((c) => c.sdk)
  L(`\n# Estimado x SDK (${medidas.length} conversas com medição)`)
  if (!medidas.length) return
  L(`  mediana estimada (inicial): ${k(mediana(medidas.map((c) => c.inicial)))} · mediana SDK (fim do turno): ${k(mediana(medidas.map((c) => c.sdk.total)))}`)
  const agrupa = (fn) => {
    const m = new Map()
    for (const c of medidas) for (const [nome, t] of fn(c)) m.set(nome, [...(m.get(nome) ?? []), t])
    return [...m.entries()].map(([nome, v]) => ({ nome, n: v.length, med: mediana(v) })).sort((a, b) => b.med - a.med)
  }
  L('  categorias do SDK (mediana, nº de conversas):')
  for (const x of agrupa((c) => c.sdk.categorias.map((y) => [y.nome, y.tokens]))) L(`    ${col(x.nome, 32)} ${num(k(x.med), 8)} ${num(x.n, 4)}`)
  const mcp = agrupa((c) => Object.entries(c.sdk.mcp))
  if (mcp.length) {
    L('  MCP por servidor, inclui as deferred (mediana, nº de conversas):')
    for (const x of mcp) L(`    ${col(x.nome, 32)} ${num(k(x.med), 8)} ${num(x.n, 4)}`)
  }
  const extra = medidas.filter((c) => c.sdk.ferramentasSistema || c.sdk.skills)
  if (extra.length) L(`  detalhe (${extra.length} conv.): ferramentas do sistema ${k(mediana(extra.map((c) => c.sdk.ferramentasSistema)))} · skills ${k(mediana(extra.map((c) => c.sdk.skills)))}`)
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1) })
