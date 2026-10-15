import { loadConfig } from '../config'
import { selectMemoriesWithHaiku, type HaikuMemorySelection } from '../memorySelectionHaiku'
import { typeSafeMemorySelectionActive } from '../typesafe'

/**
 * Quem escolhe as memórias: o Haiku (padrão) ou o TypeSafe. Configurações →
 * `memorySelector`. O TypeSafe só vale escolhido E no ar (ligado e com chave);
 * escolhido mas fora do ar, o turno segue pelo Haiku como antes.
 *
 * É a ÚNICA porta dessa decisão: agentSession.ts pergunta aqui no start, no
 * send, no aviso de seletor fora do ar e na releitura do catálogo.
 */
export async function memorySelectorUsesTypeSafe(): Promise<boolean> {
  try {
    if (loadConfig().memorySelector !== 'typesafe') return false
    return await typeSafeMemorySelectionActive()
  } catch {
    return false
  }
}

/** Os campos do input da ferramenta Agent/Task que dizem qual é a tarefa. */
interface SubagentToolInput {
  prompt?: unknown
  description?: unknown
  [key: string]: unknown
}

export interface SubagentMemoryOptions {
  /** Pasta de memórias do usuário. */
  dir: string
  /** A conversa do agente principal até aqui (ConversationDigest.render). */
  conversation?: (maxChars: number) => string
  /** Env da conta Claude da conversa. */
  env?: NodeJS.ProcessEnv
  /** Carimbo do envio (máquina, data, hora): vai na pergunta ao Haiku. */
  context?: string
  /** Injetável para o teste; padrão = TypeSafe-ou-Haiku pela configuração. */
  usesTypeSafe?: () => Promise<boolean>
  /** Injetável para o teste; padrão = selectMemoriesWithHaiku. */
  select?: typeof selectMemoriesWithHaiku
}

/**
 * O input da ferramenta Agent/Task com as memórias do subagente no começo do
 * prompt dele — para o PreToolUse devolver como `updatedInput`. O subagente não
 * passa pelo envelope do turno: sem isto ele nunca vê uma memória.
 *
 * `null` = não mexer no input: modo TypeSafe, prompt ausente, nenhuma memória
 * escolhida, ou qualquer falha (tempo esgotado incluso). Nunca lança: o
 * subagente não pode deixar de rodar por causa da memória.
 */
export async function subagentMemoryInput(toolInput: unknown, opts: SubagentMemoryOptions): Promise<Record<string, unknown> | null> {
  try {
    if (!toolInput || typeof toolInput !== 'object') return null
    const input = toolInput as SubagentToolInput
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) return null
    if (await (opts.usesTypeSafe ?? memorySelectorUsesTypeSafe)()) return null
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    const task = description ? `${description}\n\n${input.prompt}` : input.prompt
    const select = opts.select ?? selectMemoriesWithHaiku
    const chosen: HaikuMemorySelection | null = await select(opts.dir, task, {
      subject: 'subagent',
      ...(opts.conversation ? { conversation: opts.conversation } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.context ? { context: opts.context } : {})
    })
    if (!chosen || !chosen.block.trim()) return null
    return { ...input, prompt: `${chosen.block}\n\n${input.prompt}` }
  } catch (error) {
    console.error(`[memória] memórias do subagente descartadas: ${(error as Error)?.message ?? error}`)
    return null
  }
}
