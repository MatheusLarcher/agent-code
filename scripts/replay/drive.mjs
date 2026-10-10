// Conduz uma conversa da instância isolada até o fim, pela ponte do celular:
// responde permissões pela política (policy.mjs), responde perguntas com a opção
// recomendada, e insiste quando o agente encerra o turno perguntando.
// A mesma regra vale para os dois lados.
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { decidePermission, recommendedAnswers } from './policy.mjs'

/** Milissegundos desde a última escrita em qualquer transcript sob `dir` (subagentes incluídos). */
export function quietSince(dir) {
  let last = 0
  const walk = (d, depth) => {
    if (depth > 4 || !existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.jsonl')) last = Math.max(last, statSync(p).mtimeMs)
    }
  }
  walk(dir, 0)
  return last ? Date.now() - last : Number.POSITIVE_INFINITY
}

/** Texto da insistência: aceita o recomendado (a política combinada) e pede para terminar. */
export const NUDGE = 'Siga com a opção que você recomenda e termine a tarefa. Não precisa me perguntar de novo.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Um passo: responde as permissões pendentes de todas as conversas. Devolve o estado. */
export async function pump(bridge, ctx, log) {
  const state = await bridge.state()
  for (const conv of state.conversations ?? []) {
    const req = conv.permission
    if (!req?.id || ctx.answered.has(req.id)) continue
    ctx.answered.add(req.id)
    if (req.questions?.length) {
      const answers = recommendedAnswers(req.questions)
      ctx.events.push({ at: Date.now(), conv: conv.id, kind: 'pergunta', tool: req.toolName, answers })
      log(`[pergunta] ${conv.title}: ${answers.map((a) => `${a.header}=${a.selected.join('/')}`).join('; ')}`)
      await bridge.respond(conv.id, { id: req.id, behavior: 'allow', answers })
      continue
    }
    const d = decidePermission(req, ctx.policy)
    ctx.events.push({ at: Date.now(), conv: conv.id, kind: d.behavior, tool: req.toolName, reason: d.reason, input: summarize(req.input) })
    log(d.behavior === 'deny' ? `[negado] ${req.toolName}: ${d.reason}` : `[permitido] ${req.toolName}`)
    await bridge.respond(conv.id, { id: req.id, behavior: d.behavior, ...(d.behavior === 'deny' ? { message: `Recusado no replay: ${d.reason}` } : {}) })
  }
  return state
}

const summarize = (input) => {
  const s = JSON.stringify(input ?? {})
  return s.length > 300 ? `${s.slice(0, 300)}…` : s
}

/** Última resposta do agente na conversa ('' se não houver). As mensagens da ponte são `assistant-text`. */
export async function lastAssistantText(bridge, convId) {
  return lastAssistantOf((await bridge.history(convId)).messages)
}

export function lastAssistantOf(messages) {
  const msgs = Array.isArray(messages) ? messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if ((m?.kind === 'assistant-text' || m?.kind === 'assistant') && typeof m.text === 'string' && m.text.trim()) return m.text
    if (m?.kind === 'user') return ''
  }
  return ''
}

/** Textos dos pedidos do usuário na conversa (para saber quais prompts do handoff já chegaram). */
export function userTexts(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m?.kind === 'user').map((m) => String(m.text ?? ''))
}

/**
 * Marca (índices em `delivered`) os prompts do handoff cujo começo aparece nos pedidos do
 * usuário. A ponte só devolve as 30 últimas mensagens: um prompt antigo some da janela,
 * por isso o que já foi visto ou enviado fica guardado em `delivered`, nunca é recalculado.
 */
export function markDelivered(prompts, delivered, sentTexts) {
  prompts.forEach((p, i) => {
    if (sentTexts.some((s) => s.includes(p.trim().slice(0, 120)))) delivered.add(i)
  })
}

/** Índice do próximo prompt ainda não entregue (-1 se todos chegaram). */
export const nextPromptIndex = (prompts, delivered) => prompts.findIndex((_, i) => !delivered.has(i))

/** O turno terminou com pergunta ao usuário? (alguma das últimas linhas termina em "?"; vale com a lista de opções depois). */
export function endsWithQuestion(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-8)
  return lines.some((l) => /\?\s*(\*|_|`|\))*\s*$/.test(l))
}

/**
 * Espera a conversa `pick(state)` terminar. Fim = parada (sem trabalho, sem fila,
 * sem permissão, sem recuperação) por `idleMs` seguidos E nenhum transcript da rodada
 * escrito nesse tempo (`quietMs()`: subagentes em segundo plano não aparecem na ponte).
 * Prompts do handoff que a fila não soltou (`prompts`) são enviados um a um. Se terminar
 * perguntando, insiste até `maxNudges` vezes. `onTick(state)` roda a cada volta.
 * `timeoutMs` é o teto do TRABALHO: a conversa que parou antes dele termina como 'done'
 * mesmo que a confirmação do fim (`idleMs`) passe do teto; depois do teto, nada é enviado.
 */
export async function driveUntilDone(bridge, ctx, { pick, timeoutMs, idleMs = 90_000, maxNudges = 3, nudgeText = NUDGE, onTick, quietMs, prompts = [], log }) {
  const t0 = Date.now()
  const late = () => Date.now() - t0 >= timeoutMs
  let idleSince = null
  let nudges = 0
  let convId = null
  // A conversa pode nascer parada (o despachante ainda não soltou o prompt): só
  // conta como terminada depois de ter trabalhado ao menos uma vez.
  let worked = false
  // Prompts do handoff já entregues (índices): vistos no histórico ou enviados por aqui.
  const delivered = new Set()
  let lastHistoryCheck = 0
  while (Date.now() - t0 < timeoutMs + idleMs) {
    const state = await pump(bridge, ctx, log)
    if (onTick) await onTick(state)
    const conv = pick(state)
    if (conv) convId = conv.id
    // Trabalhando = o 1º prompt chegou (a conversa de implementação nasce com ele).
    if (conv?.busy && prompts.length) delivered.add(0)
    if (conv?.busy) worked = true
    // Prompt que a fila soltou sozinha: registra enquanto ainda está na janela da ponte.
    if (conv && nextPromptIndex(prompts, delivered) >= 0 && Date.now() - lastHistoryCheck > 15_000) {
      lastHistoryCheck = Date.now()
      markDelivered(prompts, delivered, userTexts((await bridge.history(conv.id)).messages))
    }
    // 1º prompt preso na fila do Quadro (outro plano com a vez, pasta não limpa) por 3 min: envia.
    if (conv && !worked && !conv.busy && prompts[0] && Date.now() - t0 > 180_000 && !ctx.firstForced) {
      ctx.firstForced = true
      markDelivered(prompts, delivered, userTexts((await bridge.history(conv.id)).messages))
      if (!delivered.has(0)) {
        ctx.events.push({ at: Date.now(), conv: conv.id, kind: 'primeiro-prompt-forcado' })
        log('[primeiro prompt] a fila não soltou em 3 min; enviado pela ponte')
        await bridge.send(conv.id, prompts[0])
        delivered.add(0)
      }
    }
    const quiet = worked && conv && !conv.busy && !conv.permission && !(conv.queued ?? []).length && !conv.recovery
    if (!quiet) {
      idleSince = null
      if (late()) break
    } else {
      idleSince ??= Date.now()
      // Parou só depois do teto: não terminou a tempo.
      if (idleSince - t0 >= timeoutMs) break
      if (Date.now() - idleSince >= idleMs && (!quietMs || quietMs() >= idleMs)) {
        const history = (await bridge.history(conv.id)).messages
        const text = lastAssistantOf(history)
        // Prompt do handoff ainda não entregue (a fila do Quadro só solta com o anterior concluído).
        markDelivered(prompts, delivered, userTexts(history))
        const i = nextPromptIndex(prompts, delivered)
        const next = i >= 0 ? prompts[i] : null
        if ((next || (endsWithQuestion(text) && nudges < maxNudges)) && late()) break
        if (next) {
          ctx.events.push({ at: Date.now(), conv: conv.id, kind: 'proximo-prompt', head: next.slice(0, 120) })
          log(`[próximo prompt] ${next.split('\n')[0].slice(0, 100)}`)
          await bridge.send(conv.id, next)
          delivered.add(i)
          idleSince = null
        } else if (endsWithQuestion(text) && nudges < maxNudges) {
          nudges++
          ctx.events.push({ at: Date.now(), conv: conv.id, kind: 'insistencia', question: text.slice(-400) })
          log(`[insistência ${nudges}] ${text.slice(-160).replace(/\s+/g, ' ')}`)
          await bridge.send(conv.id, nudgeText)
          idleSince = null
        } else {
          // workMs: até a conversa parar (sem a janela de confirmação do fim).
          return { status: 'done', convId: conv.id, nudges, ms: Date.now() - t0, workMs: idleSince - t0, finalText: text }
        }
      }
    }
    await sleep(3000)
  }
  return { status: 'timeout', convId, nudges, ms: Date.now() - t0, finalText: convId ? await lastAssistantText(bridge, convId).catch(() => '') : '' }
}
