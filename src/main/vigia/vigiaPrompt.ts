/**
 * Vigia — as regras puras: o que ele vê, o que ele pergunta, e o que conta
 * como resposta. Sem SDK, sem Electron, sem estado: é aqui que os tetos de
 * custo e o critério de "alerta válido" ficam testáveis.
 *
 * Ver docs/superpowers/specs/2026-09-12-vigia-questionador-paralelo-design.md.
 */

/** Chamadas de ferramenta acumuladas que disparam a análise no meio do turno.
 *  Antes disso o agente ainda não revelou COMO interpretou o pedido; muito
 *  depois, o aviso chega tarde. */
export const VIGIA_CALL_TRIGGER = 3

/** Silêncio mínimo entre duas análises da mesma conversa. */
export const VIGIA_COOLDOWN_MS = 60_000

/** Tetos do digest — o custo não pode crescer com o tamanho da conversa. */
export const VIGIA_MAX_CALLS = 12
export const VIGIA_MAX_USER_CHARS = 2000
export const VIGIA_MAX_CALL_CHARS = 200

/** Uma ação do agente, já reduzida ao que cabe no digest. */
export interface VigiaCall {
  tool: string
  detail: string
}

/** O turno observado: o pedido e o que o agente fez com ele. */
export interface VigiaTurn {
  userText: string
  calls: VigiaCall[]
}

/**
 * O papel, em uma pergunta só. A barra alta é deliberada: um observador que
 * fala sobre tudo é um observador que o usuário silencia na primeira semana —
 * a mesma lição do watchdog de travamento.
 */
export const VIGIA_SYSTEM_PROMPT = `Você observa, em paralelo, um agente de programação trabalhando para um usuário. Você NÃO conversa com o agente, NÃO executa nada e NÃO interrompe o trabalho. Seu único trabalho é responder a uma pergunta:

Alguma premissa deste trabalho depende de algo que SÓ O USUÁRIO sabe e que ele não confirmou?

Alerte apenas quando a dúvida for desse tipo:
- uma medida, valor ou dado do mundo real que só o usuário pode informar ou conferir;
- uma intenção ambígua, em que duas leituras razoáveis do pedido levam a resultados diferentes e incompatíveis;
- uma restrição não declarada que, se existir, invalida o trabalho (algo que não pode mudar, um alvo diferente do que o agente escolheu).

NÃO alerte sobre: estilo, organização de código, desempenho, sugestões de melhoria, risco genérico, nem sobre qualquer coisa que o agente possa descobrir sozinho lendo o projeto. Na dúvida entre alertar e calar, cale.

Responda em UMA linha, em português, num destes dois formatos exatos:
OK
ALERTA: <a dúvida, escrita como uma pergunta curta e direta ao usuário>`

/** Monta o texto que o vigia lê: o pedido e a lista de ações, ambos capados. */
export function buildVigiaDigest(turn: VigiaTurn): string {
  const pedido = clip(turn.userText.trim(), VIGIA_MAX_USER_CHARS) || '(sem texto)'
  const calls = turn.calls.slice(0, VIGIA_MAX_CALLS)
  const acoes = calls.length
    ? calls.map((c) => `- ${c.tool}${c.detail ? `: ${clip(c.detail, VIGIA_MAX_CALL_CHARS)}` : ''}`).join('\n')
    : '- (nenhuma ação ainda)'
  const omitidas = turn.calls.length - calls.length
  const nota = omitidas > 0 ? `\n- (+${omitidas} ações omitidas)` : ''
  return `Pedido do usuário:\n${pedido}\n\nO que o agente fez até agora:\n${acoes}${nota}`
}

/** O prompt completo da chamada avulsa (papel + digest). */
export function buildVigiaPrompt(turn: VigiaTurn): string {
  return `${VIGIA_SYSTEM_PROMPT}\n\n---\n\n${buildVigiaDigest(turn)}`
}

/**
 * Extrai o alerta da resposta, ou `null`.
 *
 * Falha FECHADA: resposta que não case com nenhum dos dois formatos vira
 * silêncio, nunca um alerta inventado — o custo de um aviso errado aqui é o
 * usuário parar de ler os avisos.
 */
export function parseVigiaVerdict(raw: string): string | null {
  const text = raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim()
  if (!text) return null
  const match = /ALERTA\s*:\s*(.+)/i.exec(text)
  if (!match) return null
  const alert = match[1].split('\n')[0].trim().replace(/^["'“]|["'”]$/g, '').trim()
  return alert.length >= 8 ? alert : null
}

/** Identidade do alerta para o dedupe: uma premissa não resolvida não pode
 *  virar o mesmo aviso a cada turno. Insensível a caixa, acento e pontuação. */
export function alertFingerprint(text: string): string {
  const norm = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  let hash = 5381
  for (let i = 0; i < norm.length; i++) hash = ((hash * 33) ^ norm.charCodeAt(i)) >>> 0
  return hash.toString(16)
}

/** Reduz uma chamada de ferramenta ao detalhe curto que o digest carrega.
 *  Nunca devolve conteúdo de arquivo — só o alvo/parâmetro da ação. */
export function summarizeCall(tool: string, input: unknown): string {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return clip(pick('command'), VIGIA_MAX_CALL_CHARS)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path', 'path')
    case 'Grep':
    case 'Glob':
      return pick('pattern', 'query')
    case 'Skill':
      return pick('skill')
    case 'Agent':
    case 'Task':
      return pick('description', 'subagent_type')
    case 'WebSearch':
    case 'WebFetch':
      return pick('query', 'url')
    case 'AskUserQuestion':
      return pick('question')
    default:
      return clip(pick('file_path', 'path', 'query', 'description'), VIGIA_MAX_CALL_CHARS)
  }
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
