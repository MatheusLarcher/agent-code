// Regras de classificação e métricas por conversa (sem I/O de banco).
// Teste: node scripts/analise-conversas/metricas.test.mjs

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const norm = (s) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
export const curto = (s, n = 110) => (s ?? '').replace(/\{\{midia:\d+\}\}/g, '[imagem] ').replace(/\s+/g, ' ').trim().slice(0, n)

// ponytail: palavras-chave, não modelo de linguagem — pega o explícito e erra o sutil.
// Retrabalho: usuário corrige, repete ou reclama. Texto já sem acento e minúsculo.
export const RETRABALHO = [
  // Delírio: o agente afirmou algo falso (arquivo, função, dado que não existe) e o usuário apontou.
  ['delirio', /\b(inventou|inventando|alucin\w*|mentiu|mentira)\b|(nao|isso nao) existe|nao e verdade|de onde (voce |vc )?tirou|(ta|esta|isso esta) errado/],
  ['nao entendeu', /\b(nao|n) (entendi|entenndi|entendeu|compreendi)|\bentendi nada/],
  ['nao respondeu', /\b(nao|n|vc nao|voce nao) (me )?respo\w*|cade a resposta/],
  ['nao pedi isso', /nao (pedi|mandei)|\beu (te )?pedi\b|nao (e|era|foi) (isso|assim)/],
  ['repetiu pedido', /\b(de novo|novamente|outra vez|ja (falei|disse|pedi)|repito|continua\w*|ainda (nao|esta|ta))\b/],
  ['nao funcionou', /nao (funcionou|funciona|deu certo|mudou|resolveu)|mesmo problema|piorou|quebrou/],
  ['reclamou do resultado', /\b(pessimo|horrivel|feio|zuad\w*|ruim|nao gostei|urgente\w*)\b/],
  ['mandou desfazer', /\b(desfaz|desfazer|reverte|volta como|volte como|tira isso)\b/]
]
// Confirmação: resposta curta liberando o que o agente acabou de perguntar.
export const CONFIRMA = /^(sim|s|pode|ok|okay|faca isso|faz|faz isso|autorizo|pode fazer|pode seguir|manda|vai|segue|isso|confirmo|beleza|bora|perfeito|certo)\b[\s\S]{0,80}$/
// Saída de terminal colada pelo usuário (o agente pediu para ele rodar algo).
export const COLOU_TERMINAL = /(^|\n)\s*PS [A-Z]:\\|^\s*powershell\s+-ExecutionPolicy|At line:\d|CategoryInfo\s*:/i
// Recusa de permissão / bloqueio no texto do resultado de ferramenta.
export const RECUSA = /doesn.t want to proceed|user (denied|rejected|declined)|permission (denied|was denied)|requires? (approval|permission)|was blocked|blocked by|refused|nao autoriz|recusad|bloquead|negad|fora do (write_scope|escopo)|outside (the )?(write.?scope|working director)|declare o plano/i

export function classificarRetrabalho(texto) {
  const t = norm(texto)
  return RETRABALHO.find(([, re]) => re.test(t))?.[0] ?? null
}

export function categoriaErro(texto) {
  return norm((texto ?? '').split('\n')[0])
    .replace(/<\/?tool_use_error>/g, '')
    .replace(/[a-z]:\\[^\s'"]+|\/[\w.\-/]+/gi, '<caminho>')
    .replace(/\d+/g, 'N').slice(0, 90)
}

export function mediana(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

export function contar(itens) {
  const m = {}
  for (const i of itens) m[i] = (m[i] ?? 0) + 1
  return Object.entries(m).sort((a, b) => b[1] - a[1])
}

/** `desde` (ms): ignora o que veio antes — o 1º pedido a partir da data abre a janela. */
export function analisarConversa(conv, entradas, tempos, desde = 0) {
  const todas = conv.msgs ?? []
  const inicio = desde ? todas.findIndex((m) => m.kind === 'user' && !m.injected && Number(m.ts) >= desde) : 0
  const msgs = inicio < 0 ? [] : todas.slice(inicio)
  if (desde) entradas = entradas.filter(({ entry: e }) => !e.timestamp || Date.parse(e.timestamp) >= desde)
  const users = msgs.filter((m) => m.kind === 'user' && !m.injected)
  const r = {
    id: conv.id, titulo: curto(conv.titulo, 50), apagada: conv.apagada, pedidos: users.length,
    retrabalho: [], confirmacoes: [], colouTerminal: [], perguntasDoAgente: 0,
    ferramentas: {}, errosFerramenta: [], recusas: [], falhasRepetidas: [],
    turnos: [], maiorContexto: 0, resumosContexto: 0, hooksQuebrados: {}, avisosNoChat: {},
    mensagensEnfileiradas: 0, trocasDeConta: msgs.filter((m) => m.kind === 'account-switch').length
  }

  let ultimaFala = ''
  let anterior = null
  // Ações (chamadas de ferramenta) de cada pedido, por tipo — na mesma ordem de `users`.
  const acoesPorPedido = []
  for (const m of msgs) {
    if (m.kind === 'assistant-text') ultimaFala = m.text ?? ''
    if (m.kind === 'status') r.avisosNoChat[curto(m.text, 70)] = (r.avisosNoChat[curto(m.text, 70)] ?? 0) + 1
    if (m.kind === 'user' && !m.injected) {
      acoesPorPedido.push({})
      const tipo = classificarRetrabalho(m.text)
      if (tipo) r.retrabalho.push({ tipo, texto: curto(m.text) })
      if (CONFIRMA.test(norm(m.text)) && ultimaFala.slice(-400).includes('?')) r.confirmacoes.push({ texto: curto(m.text, 40), pergunta: curto(ultimaFala.slice(-160), 160) })
      if (COLOU_TERMINAL.test(m.text ?? '')) r.colouTerminal.push(curto(m.text, 80))
    }
    if (m.kind !== 'tool-use') continue
    const doPedido = acoesPorPedido[acoesPorPedido.length - 1]
    if (doPedido) doPedido[m.name] = (doPedido[m.name] ?? 0) + 1
    if (m.name === 'AskUserQuestion') r.perguntasDoAgente++
    const f = (r.ferramentas[m.name] ??= { usos: 0, erros: 0, recusas: 0 })
    f.usos++
    const texto = m.result?.text ?? ''
    // Só resultado marcado como erro: saída longa de comando que cita "blocked" não é recusa.
    if (m.result?.isError === true && RECUSA.test(texto.slice(0, 300))) { f.recusas++; r.recusas.push({ ferramenta: m.name, texto: curto(texto, 140) }) }
    if (m.result?.isError !== true) { anterior = null; continue }
    f.erros++
    const cat = categoriaErro(texto)
    r.errosFerramenta.push({ ferramenta: m.name, categoria: cat })
    if (anterior?.ferramenta === m.name && anterior.categoria === cat) r.falhasRepetidas.push({ ferramenta: m.name, categoria: cat })
    anterior = { ferramenta: m.name, categoria: cat }
  }

  // Turnos: tempo vem de conversation_turn_time (pelos turnIds do pedido); tokens vêm das
  // respostas do modelo deduplicadas por message.id e atribuídas ao último pedido anterior.
  const duracao = new Map()
  for (const t of tempos) duracao.set(t.turn_id, (duracao.get(t.turn_id) ?? 0) + Number(t.duration_ms))
  const turnos = users.map((u, i) => ({
    ts: Number(u.ts), texto: curto(u.text, 90),
    acoes: Object.values(acoesPorPedido[i] ?? {}).reduce((s, n) => s + n, 0),
    acoesPorTipo: acoesPorPedido[i] ?? {},
    segundos: Math.round((u.turnIds ?? []).reduce((s, id) => s + (duracao.get(id) ?? 0), 0) / 1000),
    chamadas: 0, tokensEntrada: 0, tokensSaida: 0
  }))
  const chamadas = new Map()
  for (const { entry: e } of entradas) {
    if (e.type === 'system' && e.subtype === 'compact_boundary') r.resumosContexto++
    if (e.type === 'queue-operation' && e.operation === 'enqueue') r.mensagensEnfileiradas++
    if (e.type === 'attachment' && e.attachment?.type === 'hook_non_blocking_error') {
      const cmd = curto((e.attachment.stderr ?? e.attachment.content ?? '').replace(/^Failed with non-blocking status code:\s*/i, ''), 120)
      r.hooksQuebrados[cmd] = (r.hooksQuebrados[cmd] ?? 0) + 1
    }
    const u = e.type === 'assistant' ? e.message?.usage : null
    if (!u) continue
    const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    chamadas.set(e.message.id ?? e.uuid, { ts: Date.parse(e.timestamp), ctx, out: u.output_tokens ?? 0 })
  }
  for (const v of chamadas.values()) {
    r.maiorContexto = Math.max(r.maiorContexto, v.ctx)
    const turno = turnos.findLast((t) => t.ts <= v.ts + 1000)
    if (!turno) continue
    turno.chamadas++; turno.tokensEntrada += v.ctx; turno.tokensSaida += v.out
  }
  r.turnos = turnos
  r.chamadasModelo = chamadas.size
  // Contexto fixo: o que a 1ª chamada já carrega antes de qualquer trabalho.
  // Só vale se a conversa começou dentro do período (senão a 1ª chamada é do meio dela).
  r.contextoInicial = inicio === 0 ? [...chamadas.values()].sort((a, b) => a.ts - b.ts)[0]?.ctx ?? 0 : 0
  r.tokensEntrada = turnos.reduce((s, t) => s + t.tokensEntrada, 0)
  r.tokensSaida = turnos.reduce((s, t) => s + t.tokensSaida, 0)
  r.segundos = turnos.reduce((s, t) => s + t.segundos, 0)
  return r
}

// Observadores (PO, memorista, vigia, título, curador…): cada análise é uma sessão própria
// do SDK, gravada como .jsonl em ~/.claude/projects e fora do banco. Reconhecidos pelo
// prompt de abertura ("Você é o PO…", "Você é o memorista…").
export function lerObservadores(desde, idsDoBanco) {
  const raiz = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects')
  const sessoes = []
  if (!existsSync(raiz)) return sessoes
  for (const pasta of readdirSync(raiz)) {
    const dir = join(raiz, pasta)
    if (!statSync(dir).isDirectory()) continue
    for (const arq of readdirSync(dir).filter((a) => a.endsWith('.jsonl'))) {
      const caminho = join(dir, arq)
      if (statSync(caminho).mtimeMs < desde || idsDoBanco.has(arq.slice(0, -6))) continue
      const s = lerSessaoObservador(readFileSync(caminho, 'utf8'))
      if (s && s.inicio >= desde) sessoes.push(s)
    }
  }
  return sessoes
}

export function lerSessaoObservador(txt) {
  let s = null
  const ids = new Set()
  for (const linha of txt.split('\n')) {
    if (!linha) continue
    let e
    try { e = JSON.parse(linha) } catch { continue }
    if (!s && e.type === 'user') {
      const c = e.message?.content
      const texto = typeof c === 'string' ? c : (Array.isArray(c) ? c.find((b) => b.type === 'text')?.text : '') ?? ''
      const m = /^voce e o ([a-z]+)/.exec(norm(texto))
      if (e.entrypoint !== 'sdk-ts' || !m) return null // não é observador do Agent Code
      s = { tipo: m[1], inicio: Date.parse(e.timestamp), chamadas: 0, tokensEntrada: 0, modelos: {} }
      continue
    }
    const u = e.type === 'assistant' ? e.message?.usage : null
    if (!s || !u || ids.has(e.message.id)) continue
    ids.add(e.message.id)
    s.chamadas++
    s.tokensEntrada += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    s.modelos[e.message.model] = (s.modelos[e.message.model] ?? 0) + 1
  }
  return s
}

/**
 * Atribui cada observador ao app medido pelo horário: ele começa logo depois de um pedido
 * do app que acompanha. ponytail: com os dois apps em uso no mesmo minuto, a sessão conta
 * para os dois; o curador (diário, sem pedido) fica de fora.
 */
export function observadoresDoApp(sessoes, tsPedidos, janelaMs = 15 * 60 * 1000) {
  const ts = [...tsPedidos].sort((a, b) => a - b)
  const resumo = {}
  for (const s of sessoes) {
    if (!ts.some((t) => s.inicio >= t && s.inicio - t <= janelaMs)) continue
    const r = (resumo[s.tipo] ??= { sessoes: 0, chamadas: 0, tokensEntrada: 0, modelos: {} })
    r.sessoes++; r.chamadas += s.chamadas; r.tokensEntrada += s.tokensEntrada
    for (const [m, n] of Object.entries(s.modelos)) r.modelos[m] = (r.modelos[m] ?? 0) + n
  }
  return resumo
}
