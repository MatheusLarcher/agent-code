#!/usr/bin/env node
// Análise de gargalos de usabilidade nas conversas reais do Agent Code.
//
// SÓ LEITURA: copia a pasta do Postgres embutido para uma pasta temporária, sobe
// um Postgres separado em cima da CÓPIA (outra porta, sem senha, só 127.0.0.1),
// lê, desliga e apaga a cópia. O banco do app não é tocado e o app não precisa
// fechar. Nada sai do PC.
//
// Uso:  node scripts/analise-conversas/analisar.mjs [principal|teste]
//   principal = app instalado (congelado, régua de comparação) — padrão
//   teste     = cópia de teste (AGENT_CODE_DEV_DATA_DIR), que recebe as correções
// Env:  AC_DESDE (AAAA-MM-DD: só conta o que aconteceu a partir dessa data),
//       AC_PGDATA, AC_PG_BIN, AC_PORT (15499),
//       AC_SAIDA (raiz da saída; fica FORA do repo porque tem trechos das conversas)
//
// Saída: resumo no terminal + <AC_SAIDA>/<instancia>/analise-<data>.json.
// Comparar as duas: node scripts/analise-conversas/comparar.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTANCIAS, LOCAL, instancia, lerBanco } from './banco.mjs'
import { analisarConversa, contar, lerObservadores, mediana, observadoresDoApp } from './metricas.mjs'

const INSTANCIA = instancia(process.argv[2])
const DESDE = process.env.AC_DESDE ? Date.parse(process.env.AC_DESDE) : 0
if (Number.isNaN(DESDE)) throw new Error(`AC_DESDE inválido: "${process.env.AC_DESDE}" (use AAAA-MM-DD)`)
const PGDATA = process.env.AC_PGDATA ?? INSTANCIAS[INSTANCIA].pgdata
const PORT = Number(process.env.AC_PORT ?? 15499)
const SAIDA = join(process.env.AC_SAIDA ?? join(LOCAL, 'agent-code', 'analise-conversas'), INSTANCIA)

const lerDados = () => lerBanco(PGDATA, PORT, async (q) => ({
  conversas: await q(`SELECT conversation_id id, payload->>'title' titulo, deleted_at IS NOT NULL apagada,
    created_at, payload->'messages' msgs FROM conversations
    WHERE jsonb_array_length(coalesce(payload->'messages','[]')) > 0`),
  entradas: await q(`SELECT conversation_id id, entry FROM sdk_session_entries
    WHERE entry->>'type' IN ('assistant','system','attachment','queue-operation')
    ORDER BY conversation_id, session_id, subpath, sequence`),
  tempos: await q('SELECT conv_id, turn_id, duration_ms FROM conversation_turn_time'),
  llmCalls: await q('SELECT turn_id, cache_read_tokens FROM llm_calls'),
  // Gravações de memória aplicadas, por autor e operação (memorista, bibliotecário, usuário…).
  memorias: await q(`SELECT coalesce(origin_agent, 'usuario') autor, op, created_at FROM memory_proposals WHERE status = 'applied'`)
}))

/** Por autor: criadas, complementadas e aposentadas desde DESDE. Complementar em vez de
 *  criar é o sinal de que o memorista parou de duplicar (D23, D26). */
function contarMemorias(linhas, desde) {
  const out = {}
  for (const l of linhas) {
    if (Date.parse(l.created_at) < desde) continue
    const a = (out[l.autor] ??= { criadas: 0, complementadas: 0, aposentadas: 0 })
    if (l.op === 'create') a.criadas++
    else if (l.op === 'update') a.complementadas++
    else if (l.op === 'retire') a.aposentadas++
  }
  return out
}

const k = (n) => `${Math.round(n / 1000).toLocaleString('pt-BR')}k`
const somar = (lista, f) => lista.reduce((s, x) => s + f(x), 0)
const juntar = (lista, campo) => {
  const m = {}
  for (const c of lista) for (const [h, n] of Object.entries(c[campo])) m[h] = (m[h] ?? 0) + n
  return m
}

async function main() {
  const dados = await lerDados()
  const porConv = dados.conversas
    .map((c) => analisarConversa(c, dados.entradas.filter((e) => e.id === c.id), dados.tempos.filter((t) => t.conv_id === c.id), DESDE))
    .filter((c) => c.pedidos > 0)

  const ferr = {}
  for (const c of porConv) for (const [n, f] of Object.entries(c.ferramentas)) {
    const t = (ferr[n] ??= { usos: 0, erros: 0, recusas: 0 }); t.usos += f.usos; t.erros += f.erros; t.recusas += f.recusas
  }
  const todosTurnos = porConv.flatMap((c) => c.turnos.map((t) => ({ conversa: c.titulo, ...t })))
  const criadas = dados.conversas.map((c) => new Date(c.created_at).getTime())
  const desde = Math.max(DESDE, criadas.length ? Math.min(...criadas) : Date.now())
  const sdkIds = new Set(dados.entradas.map((e) => e.entry.sessionId).filter(Boolean))
  const pedidos = somar(porConv, (c) => c.pedidos)
  const porPedido = (n) => (pedidos ? Math.round(n / pedidos) : 0)
  const fundo = observadoresDoApp(lerObservadores(desde, sdkIds), porConv.flatMap((c) => c.turnos.map((t) => t.ts)))
  const tokensFundo = somar(Object.values(fundo), (v) => v.tokensEntrada)
  const tokensEntrada = somar(porConv, (c) => c.tokensEntrada)
  const retrabalhos = porConv.flatMap((c) => c.retrabalho.map((r) => r.tipo))

  const total = {
    instancia: INSTANCIA, geradoEm: new Date().toISOString(), desde: new Date(desde).toISOString(),
    conversas: porConv.length, pedidos,
    memorias: contarMemorias(dados.memorias, DESDE),
    // Números por pedido: é o que dá para comparar entre os dois apps, mesmo com volumes diferentes.
    porPedido: {
      tokensEntrada: porPedido(tokensEntrada),
      tokensObservadores: porPedido(tokensFundo),
      chamadasModelo: +(somar(porConv, (c) => c.chamadasModelo) / (pedidos || 1)).toFixed(1),
      segundosMediana: mediana(porConv.flatMap((c) => c.turnos.map((t) => t.segundos)).filter((s) => s > 0)),
      errosFerramenta: +(somar(porConv, (c) => c.errosFerramenta.length) / (pedidos || 1)).toFixed(2)
    },
    contextoInicialMediana: mediana(porConv.map((c) => c.contextoInicial).filter(Boolean)),
    retrabalhoPct: pedidos ? +(100 * retrabalhos.length / pedidos).toFixed(1) : 0,
    delirios: retrabalhos.filter((t) => t === 'delirio').length,
    retrabalho: contar(retrabalhos),
    confirmacoesCurtas: somar(porConv, (c) => c.confirmacoes.length),
    perguntasDoAgente: somar(porConv, (c) => c.perguntasDoAgente),
    colouTerminal: somar(porConv, (c) => c.colouTerminal.length),
    usosFerramenta: somar(Object.values(ferr), (f) => f.usos),
    errosFerramenta: somar(porConv, (c) => c.errosFerramenta.length),
    recusas: somar(porConv, (c) => c.recusas.length),
    falhasRepetidas: somar(porConv, (c) => c.falhasRepetidas.length),
    categoriasDeErro: contar(porConv.flatMap((c) => c.errosFerramenta.map((e) => `${e.ferramenta} — ${e.categoria}`))).slice(0, 15),
    ferramentas: Object.entries(ferr).sort((a, b) => b[1].erros - a[1].erros || b[1].usos - a[1].usos),
    hooksQuebrados: juntar(porConv, 'hooksQuebrados'), avisosNoChat: juntar(porConv, 'avisosNoChat'),
    resumosContexto: somar(porConv, (c) => c.resumosContexto),
    maiorContexto: Math.max(0, ...porConv.map((c) => c.maiorContexto)),
    tokensEntrada, tokensSaida: somar(porConv, (c) => c.tokensSaida), tokensObservadores: tokensFundo,
    horasDeTrabalho: +(somar(porConv, (c) => c.segundos) / 3600).toFixed(1),
    turnosMaisLentos: [...todosTurnos].sort((a, b) => b.segundos - a.segundos).slice(0, 8),
    turnosMaisCaros: [...todosTurnos].sort((a, b) => b.tokensEntrada - a.tokensEntrada).slice(0, 8),
    // Pedidos com mais ações (chamadas de ferramenta) e de onde vêm as ações no total.
    turnosComMaisAcoes: [...todosTurnos].sort((a, b) => b.acoes - a.acoes).slice(0, 10),
    acoesPorPedidoMediana: mediana(todosTurnos.map((t) => t.acoes)),
    acoesPorTipo: contar(todosTurnos.flatMap((t) => Object.entries(t.acoesPorTipo).flatMap(([n, q]) => Array(q).fill(n)))),
    // Telemetria: mesmo valor em várias linhas do turno = total acumulado gravado por chamada.
    llmCallsGruposRepetidos: contar(dados.llmCalls.map((l) => `${l.turn_id}|${l.cache_read_tokens}`)).filter(([, n]) => n > 1).length,
    llmCallsLinhas: dados.llmCalls.length,
    segundoPlano: fundo
  }

  mkdirSync(SAIDA, { recursive: true })
  const arq = join(SAIDA, `analise-${total.geradoEm.slice(0, 16).replace(/[:T]/g, '-')}.json`)
  writeFileSync(arq, JSON.stringify({ total, porConversa: porConv }, null, 2))

  const L = (s = '') => console.log(s)
  const p = total.porPedido
  L(`# Análise de conversas — ${INSTANCIA} — ${total.geradoEm} (desde ${total.desde.slice(0, 10)})`)
  L(`${total.conversas} conversas, ${total.pedidos} pedidos, ${total.horasDeTrabalho} h de agente trabalhando`)
  L(`Por pedido: ${k(p.tokensEntrada)} tokens (+${k(p.tokensObservadores)} dos observadores), ${p.chamadasModelo} chamadas, mediana ${p.segundosMediana}s, ${p.errosFerramenta} erros de ferramenta`)
  L(`Contexto inicial (mediana): ${k(total.contextoInicialMediana)}. Maior contexto: ${k(total.maiorContexto)}. Resumos de contexto: ${total.resumosContexto}`)
  L(`Retrabalho: ${total.retrabalhoPct}% dos pedidos. Delírios apontados: ${total.delirios}`)
  L('\n## Por conversa')
  for (const c of porConv) {
    L(`- ${c.titulo}${c.apagada ? ' (apagada)' : ''}: ${c.pedidos} pedidos, retrabalho ${c.retrabalho.length}, ` +
      `erros ${c.errosFerramenta.length}/${somar(Object.values(c.ferramentas), (f) => f.usos)}, recusas ${c.recusas.length}, ` +
      `confirmações ${c.confirmacoes.length}, terminal colado ${c.colouTerminal.length}, ` +
      `${Math.round(c.segundos / 60)} min, ${k(c.tokensEntrada)} tokens, contexto inicial ${k(c.contextoInicial)}, máx ${k(c.maiorContexto)}`)
    for (const r of c.retrabalho) L(`    retrabalho [${r.tipo}] ${r.texto}`)
  }
  L('\n## Retrabalho'); for (const [t, n] of total.retrabalho) L(`- ${t}: ${n}`)
  L('\n## Ferramentas (erros/recusas/usos)')
  for (const [n, f] of total.ferramentas.slice(0, 15)) L(`- ${n}: ${f.erros} erros, ${f.recusas} recusas, ${f.usos} usos`)
  L('\n## Erros mais comuns'); for (const [c, n] of total.categoriasDeErro) L(`- ${n}× ${c}`)
  L(`Falhas repetidas em sequência: ${total.falhasRepetidas}`)
  L('\n## Hooks quebrados'); for (const [h, n] of Object.entries(total.hooksQuebrados)) L(`- ${n}× ${h}`)
  L('\n## Avisos no chat'); for (const [h, n] of Object.entries(total.avisosNoChat)) L(`- ${n}× ${h}`)
  L(`\n## Confirmações: ${total.confirmacoesCurtas} respostas curtas a perguntas do agente; ${total.perguntasDoAgente} AskUserQuestion; ${total.recusas} recusas; ${total.colouTerminal}× saída de terminal colada`)
  for (const c of porConv) for (const x of c.confirmacoes) L(`- "${x.texto}" ← ${x.pergunta}`)
  for (const c of porConv) for (const x of c.recusas) L(`- recusa ${x.ferramenta}: ${x.texto}`)
  L('\n## Turnos mais lentos'); for (const t of total.turnosMaisLentos) L(`- ${t.segundos}s, ${t.chamadas} chamadas — ${t.texto}`)
  const tipos = (porTipo) => Object.entries(porTipo).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, q]) => `${n} ${q}`).join(', ')
  const totalAcoes = somar(total.acoesPorTipo, ([, n]) => n)
  L(`\n## Ações por pedido (mediana ${total.acoesPorPedidoMediana})`)
  for (const t of total.turnosComMaisAcoes) L(`- ${t.acoes} ações, ${t.chamadas} chamadas, ${t.segundos}s — ${t.texto}\n    ${tipos(t.acoesPorTipo)}`)
  L('\n## De onde vêm as ações (todos os pedidos)')
  for (const [n, q] of total.acoesPorTipo.slice(0, 15)) L(`- ${n}: ${q} (${totalAcoes ? Math.round((q / totalAcoes) * 100) : 0}%)`)
  L('\n## Turnos mais caros'); for (const t of total.turnosMaisCaros) L(`- ${k(t.tokensEntrada)} tokens, ${t.chamadas} chamadas, ${t.segundos}s — ${t.texto}`)
  L(`\n## Telemetria llm_calls: ${total.llmCallsGruposRepetidos} grupos de valores repetidos em ${total.llmCallsLinhas} linhas`)
  L('\n## Segundo plano (observadores)')
  for (const [tipo, v] of Object.entries(total.segundoPlano)) {
    const modelos = Object.entries(v.modelos).map(([m, n]) => `${m.replace('claude-', '')} ${n}`).join(', ')
    L(`- ${tipo}: ${v.sessoes} sessões, ${v.chamadas} chamadas, ${k(v.tokensEntrada)} tokens (${modelos})`)
  }
  L(`\nJSON completo: ${arq}`)
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1) }) // a cópia já foi apagada no finally de lerBanco
