/**
 * Contexto que o app entregou ao agente num turno, copiado na origem
 * (agentSession) — para o app "Contexto" do monitor do escritório.
 *
 * Nada disto viaja no `ChatEvent`: mensagens são gravadas, sincronizadas entre
 * PCs e mandadas ao celular. Fica no histórico próprio (`context_turn` +
 * `context_blob`) e só sai do main por IPC do PC.
 */

/** O que é cada bloco. A tela agrupa e rotula por aqui. */
export type ContextBlockKind =
  // Mensagem enviada (stamped(outText))
  | 'stamp'
  | 'memory-catalog'
  | 'skills-catalog'
  | 'projects'
  | 'others'
  | 'cancel-note'
  | 'loop'
  | 'reminder'
  | 'user-request'
  | 'images'
  // Contexto dos hooks (additionalContext)
  | 'docs'
  | 'memory-excerpts'
  // Uma vez por sessão
  | 'system-append'
  // Monitor de subagente
  | 'subagent-instructions'
  | 'subagent-request'

/** De onde o bloco saiu. `hook-mid` = reenvio do PostToolBatch no meio do turno;
 *  `continuation` = a mensagem interna que retoma o MESMO turno (troca por cota
 *  ou de conta, retomada depois de erro) e o contexto que ela levou. */
export type ContextBlockSource = 'prompt' | 'hook-start' | 'hook-mid' | 'system' | 'subagent' | 'continuation'

/** Bloco como gravado em `context_turn.blocks_json` (o texto mora em `context_blob`). */
export interface ContextBlockRef {
  kind: ContextBlockKind
  label: string
  source: ContextBlockSource
  /** sha256 hex do texto JÁ mascarado. */
  hash: string
  /** Tamanho em bytes UTF-8 do texto mascarado. */
  bytes: number
  /** epoch ms em que o app montou/entregou o bloco. */
  at: number
}

/** O bloco com o texto (descomprimido, senhas já mascaradas). */
export interface ContextBlock extends ContextBlockRef {
  text: string
}

/** Uma senha do cofre presente no system prompt: nunca o valor. */
export interface ContextSecretMask {
  name: string
  /** Comprimento do valor, para a máscara `••••` do mesmo tamanho. */
  length: number
}

/**
 * Marcador que substitui o valor da senha no texto do bloco `system-append`.
 * A tela troca pelo `••••` + olho; o valor só vem por `secrets:reveal`.
 */
export const SECRET_PLACEHOLDER_PREFIX = '⟦senha:'
export const SECRET_PLACEHOLDER_SUFFIX = '⟧'
export function secretPlaceholder(name: string): string {
  return `${SECRET_PLACEHOLDER_PREFIX}${name}${SECRET_PLACEHOLDER_SUFFIX}`
}

/** Linha por categoria do `getContextUsage` (o SDK classifica por `kind`). */
export interface ContextUsageCategory {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** Resumo/medição do SDK (`query.getContextUsage`). Campos extras são opcionais. */
export interface ContextUsageSnapshot {
  detail: 'summary' | 'full'
  /** epoch ms da medição. */
  at: number
  model?: string
  totalTokens: number
  maxTokens: number
  percentage: number
  categories: ContextUsageCategory[]
  memoryFiles?: Array<{ path: string; type: string; tokens: number }>
  mcpTools?: Array<{ name: string; serverName: string; tokens: number }>
  skills?: Array<{ name: string; source: string; tokens: number }>
  agents?: Array<{ agentType: string; source: string; tokens: number }>
  systemPromptSections?: Array<{ name: string; tokens: number }>
  systemTools?: Array<{ name: string; tokens: number }>
}

/** Resultado do botão "Contar exato": sempre devolve algo para a tela. */
export interface ContextExactCount {
  ok: boolean
  /** `full` quando deu certo; senão o último resumo (pode ser null). */
  usage: ContextUsageSnapshot | null
  /** Motivo legível quando `ok` é false (rota GPT/Ollama, sessão fechada…). */
  reason?: string
}

/** Um modelo que respondeu no turno, lido de cada resposta (não do seletor). */
export interface ContextTurnModel {
  /** Id como veio na resposta (nome legível: modelDisplayName). */
  model: string
  /** Quantas respostas (chamadas ao modelo) ele deu neste nó. */
  calls: number
  /** `null` = agente principal; senão o `parentToolUseId` do subagente. */
  node: string | null
}

/** Linha do seletor "Turno das 16:42 ▾". */
export interface ContextTurnSummary {
  convId: string
  /** O `messageUuid` do envio (mesmo id dos `turnIds` do chat). */
  turnId: string
  /** Em qual PC o turno rodou. */
  pc: string
  /** epoch ms. */
  startedAt: number
  /** Modelo da sessão quando o turno começou — o que a tela mostra antes da
   *  primeira resposta. Nunca o sentinela do Automático ('' se desconhecido). */
  model: string
  /** Quem respondeu, na ordem da primeira resposta de cada (nó, modelo). Vazio =
   *  sem resposta ainda, ou turno gravado antes deste campo: a tela não chuta. */
  models: ContextTurnModel[]
  provider: 'claude' | 'gpt' | 'ollama'
  /** Pedido do usuário resumido (até ~120 caracteres). */
  request: string
  blockCount: number
  totalBytes: number
  /** Nomes (relPath) das memórias realmente enviadas no turno. */
  memoriesSent: string[]
  /** `true` depois que o fim do turno completou o registro. */
  complete: boolean
}

/** Um turno lido inteiro. */
export interface ContextTurnDetail extends ContextTurnSummary {
  blocks: ContextBlock[]
  usage: ContextUsageSnapshot | null
  secrets: ContextSecretMask[]
}

/** Aviso leve "mudou" (main → renderer): a tela relê se estiver aberta. */
export interface ContextTurnChanged {
  convId: string
  turnId: string
  /** O contexto foi reenviado no meio do turno (hook do PostToolBatch): o aviso da tela. */
  resent?: boolean
}

/** Quantos turnos o seletor mostra. Tudo fica no banco. */
export const CONTEXT_TURNS_ON_SCREEN = 10

/** Cabeçalho de cada trecho de memória injetado (ver memoryContextBlock). */
const MEMORY_HEADER = /^--- Memória relevante: (.+?) ---$/gmu

/** Nomes das memórias enviadas, tirados do bloco REALMENTE enviado. */
export function memoryNamesFromBlock(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(MEMORY_HEADER)) {
    const name = match[1].trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
