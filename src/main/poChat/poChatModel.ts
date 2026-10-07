/**
 * O "FALA, PO" sem modelo: o CONTEXTO do projeto com referências curtas (C1…
 * conversas, K1… cartões, F próximos prompts, T tarefas do registro), o texto
 * do pedido e a LEITURA da resposta — referência que não existe cai fora, os
 * minutos da verificação ficam entre 1 e 15, e as fontes e opções saem do que
 * existe de verdade. Puro: o serviço (poChatService.ts) junta os dados e chama.
 */
import {
  PO_CHAT_HISTORY_EXCHANGES,
  type PoChatMessage,
  type PoChatOption,
  type PoChatSource
} from '../../shared/poChat'

export interface PoChatCard {
  id: string
  conversationId: string
  title: string
  /** a fazer / fazendo / concluído */
  status: string
  poReason: string | null
  /** "Aguardando você" / "Interrompido" */
  awaiting: string | null
  deadline: string | null
  prints: number
  thumbUrl: string | null
  updatedAt: string
}

export interface PoChatConversation {
  id: string
  title: string
  /** O fim da última resposta do agente (o que ele disse por último). */
  lastAnswer: string | null
  lastAt: number | null
}

export interface PoChatQueueLine {
  plan: string
  label: string
  estado: string
  motivo: string | null
  conversationTitle: string
}

export interface PoChatTask {
  title: string
  status: string
}

export interface PoChatContext {
  projectName: string
  boardAt: number | null
  cards: PoChatCard[]
  conversations: PoChatConversation[]
  queue: PoChatQueueLine[]
  tasks: PoChatTask[]
}

/** O contexto com as referências (K1…, C1…) que o modelo cita. */
export interface PoChatRefs {
  cards: Map<string, PoChatCard>
  conversations: Map<string, PoChatConversation>
}

export function refsOf(ctx: PoChatContext): PoChatRefs {
  return {
    cards: new Map(ctx.cards.map((c, i) => [`K${i + 1}`, c])),
    conversations: new Map(ctx.conversations.map((c, i) => [`C${i + 1}`, c]))
  }
}

const VERIFY_MIN = 1
const VERIFY_MAX = 15
const ANSWER_CHARS = 1_200

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `…${t.slice(-max)}` : t
}

function contextText(ctx: PoChatContext, refs: PoChatRefs, now: number): string {
  const lines: string[] = [`PROJETO: ${ctx.projectName}`, '']
  lines.push(`QUADRO (atualizado ${ctx.boardAt ? `há ${Math.round((now - ctx.boardAt) / 60_000)} min` : 'em hora desconhecida'}):`)
  if (refs.cards.size === 0) lines.push('(nenhum cartão)')
  for (const [ref, c] of refs.cards) {
    const conv = [...refs.conversations].find(([, v]) => v.id === c.conversationId)?.[0] ?? '?'
    const extra = [c.awaiting, c.deadline, c.poReason ? `motivo: ${c.poReason}` : null, c.prints ? `${c.prints} print(s)` : null]
      .filter(Boolean)
      .join(' · ')
    lines.push(`[${ref}] ${c.status} — "${c.title}" (conversa ${conv})${extra ? ` — ${extra}` : ''}`)
  }
  lines.push('', 'ÚLTIMAS RESPOSTAS DOS AGENTES:')
  if (refs.conversations.size === 0) lines.push('(nenhuma conversa)')
  for (const [ref, c] of refs.conversations) {
    const when = c.lastAt ? `há ${Math.round((now - c.lastAt) / 60_000)} min` : 'sem resposta ainda'
    lines.push(`[${ref}] "${c.title}" (${when}): ${c.lastAnswer ? clip(c.lastAnswer, ANSWER_CHARS) : '(o agente ainda não respondeu)'}`)
  }
  lines.push('', '[F] PRÓXIMOS PROMPTS (a fila):')
  if (ctx.queue.length === 0) lines.push('(vazia)')
  for (const q of ctx.queue) lines.push(`- ${q.plan} · ${q.label} · ${q.estado}${q.motivo ? `: ${q.motivo}` : ''} (${q.conversationTitle})`)
  lines.push('', '[T] TAREFAS DO REGISTRO:')
  if (ctx.tasks.length === 0) lines.push('(nenhuma)')
  for (const t of ctx.tasks.slice(0, 40)) lines.push(`- ${t.status}: ${t.title}`)
  return lines.join('\n')
}

/** O contexto em texto, com as referências que o modelo cita (a resposta rápida e a verificação). */
export function poChatContextText(ctx: PoChatContext, now: number): string {
  return contextText(ctx, refsOf(ctx), now)
}

const RULES = `Você é o PO deste projeto, no chat "Fala, PO". Responda à pergunta do usuário em português do Brasil, curto e direto (até ~8 linhas), usando SÓ o que está no CONTEXTO: o quadro, as últimas respostas dos agentes, os próximos prompts e as tarefas do registro. Não invente: se algo não está no contexto, diga que não sabe.

Cite a fonte de cada afirmação com a referência entre colchetes, colada na frase: [C1] (conversa), [K1] (cartão), [F] (próximos prompts), [T] (tarefas do registro).

O que só um agente DISSE e ninguém conferiu no código ("o agente disse que terminou") NÃO está confirmado: diga isso na resposta.

Depois da resposta, linhas de controle (cada uma opcional, uma por linha, exatamente assim):
NAO_CONFIRMADO: <o que ninguém conferiu, numa frase>
VERIFICAR: <quantos minutos levaria conferir de verdade no projeto, de 1 a 15, pelo tamanho do que precisa conferir>
ABRIR: <os cartões que vale o usuário abrir, ex.: K2, K5>
MANDAR: <os cartões que um agente deveria fazer agora, ex.: K3> | <nota curta para o agente, opcional>`

/** O pedido inteiro: regras, as últimas ~10 trocas, o contexto e a pergunta. */
export function poChatPrompt(input: { ctx: PoChatContext; history: readonly PoChatMessage[]; question: string; now: number }): string {
  const refs = refsOf(input.ctx)
  const recent = input.history.filter((m) => !m.error).slice(-PO_CHAT_HISTORY_EXCHANGES * 2)
  const talk = recent.map((m) => `${m.role === 'usuario' ? 'USUÁRIO' : 'PO'}: ${clip(m.text, 800)}`).join('\n')
  return [
    RULES,
    '',
    '=== CONVERSA ATÉ AQUI (as últimas trocas) ===',
    talk || '(é a primeira pergunta)',
    '',
    '=== CONTEXTO ===',
    contextText(input.ctx, refs, input.now),
    '',
    '=== PERGUNTA ===',
    input.question
  ].join('\n')
}

const CONTROL = /^\s*(NAO_CONFIRMADO|NÃO_CONFIRMADO|VERIFICAR|ABRIR|MANDAR)\s*:\s*(.*)$/i
const REF = /\[(C\d+|K\d+|F|T)\]/g

export interface PoChatReply {
  text: string
  sources: PoChatSource[]
  unconfirmed: string | null
  options: PoChatOption[]
}

/** A resposta do modelo → texto limpo, fontes que existem, opções que existem. */
export function parsePoChatReply(raw: string, ctx: PoChatContext, question: string): PoChatReply {
  const refs = refsOf(ctx)
  const control = new Map<string, string>()
  const body: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = CONTROL.exec(line)
    if (m) control.set(m[1].toUpperCase().replace('Ã', 'A'), m[2].trim())
    else body.push(line)
  }
  const cited = new Set<string>()
  for (const m of body.join('\n').matchAll(REF)) cited.add(m[1])
  const text = body
    .join('\n')
    .replace(REF, '')
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  const sources: PoChatSource[] = []
  for (const ref of cited) {
    const conv = refs.conversations.get(ref)
    if (conv) sources.push({ kind: 'conversa', conversationId: conv.id, title: conv.title, at: conv.lastAt })
  }
  const cardRefs = [...cited].filter((r) => refs.cards.has(r))
  if (cardRefs.length > 0) sources.push({ kind: 'quadro', at: ctx.boardAt })
  for (const ref of cardRefs) {
    const c = refs.cards.get(ref)!
    sources.push({ kind: 'card', cardId: c.id, conversationId: c.conversationId, title: c.title, thumbUrl: c.thumbUrl })
  }
  if (cited.has('F')) sources.push({ kind: 'fila' })
  if (cited.has('T')) sources.push({ kind: 'tarefas' })

  const unconfirmed = control.get('NAO_CONFIRMADO') || null
  const options: PoChatOption[] = []
  const minutesRaw = Number.parseInt(control.get('VERIFICAR') ?? '', 10)
  if (unconfirmed || Number.isFinite(minutesRaw)) {
    const minutes = Math.min(VERIFY_MAX, Math.max(VERIFY_MIN, Number.isFinite(minutesRaw) ? minutesRaw : 5))
    options.push({ kind: 'verificar', minutes, question })
  }
  const listed = (key: string): PoChatCard[] =>
    [...new Set((control.get(key) ?? '').split('|')[0].toUpperCase().match(/K\d+/g) ?? [])].map((r) => refs.cards.get(r)).filter((c): c is PoChatCard => !!c)
  for (const c of listed('ABRIR')) options.push({ kind: 'abrir-card', cardId: c.id, conversationId: c.conversationId, title: c.title })
  // "Mandar fazer": uma proposta por conversa dona dos cartões (etapa 19). O
  // texto que vai ao agente é montado AQUI, dos cartões; do modelo, só a nota.
  const [, noteRaw] = (control.get('MANDAR') ?? '').split('|')
  const note = (noteRaw ?? '').trim().slice(0, PO_REQUEST_NOTE_MAX) || null
  const byConv = new Map<string, PoChatCard[]>()
  for (const c of listed('MANDAR')) byConv.set(c.conversationId, [...(byConv.get(c.conversationId) ?? []), c])
  for (const [conversationId, cards] of byConv) {
    const conv = ctx.conversations.find((c) => c.id === conversationId)
    options.push({
      kind: 'mandar',
      conversationId,
      conversationTitle: conv?.title ?? 'conversa removida',
      cardIds: cards.map((c) => c.id),
      titles: cards.map((c) => c.title),
      text: poRequestText(cards, note),
      note
    })
  }
  return { text: text || '(o PO não respondeu nada)', sources, unconfirmed, options }
}

/** A nota do PO no pedido (o resto do texto é dos cartões). */
export const PO_REQUEST_NOTE_MAX = 300

/** O texto EXATO que o "Mandar fazer" manda ao agente — montado pelo código, a partir dos cartões. */
export function poRequestText(cards: readonly Pick<PoChatCard, 'title' | 'status' | 'poReason' | 'awaiting'>[], note: string | null): string {
  const lines = cards.map((c) => {
    const extra = [c.poReason ? `motivo do PO: ${c.poReason}` : null, c.awaiting].filter(Boolean).join(' — ')
    return `- "${c.title}" (${c.status})${extra ? ` — ${extra}` : ''}`
  })
  return [
    'Pedido do PO, aprovado pelo usuário no "Fala, PO": termine estas tarefas do quadro deste projeto.',
    '',
    ...lines,
    ...(note ? ['', `Nota do PO: ${note}`] : []),
    '',
    'Ao terminar cada uma, marque-a como concluída na sua lista de tarefas.'
  ].join('\n')
}
