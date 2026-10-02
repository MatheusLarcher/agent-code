/**
 * A Central: a conversa única que roteia cada mensagem (pelo TypeSafe) para a
 * conversa certa. Tipos compartilhados entre o main (decisor), a tela e o celular.
 */

/** Id fixo: há UMA Central, e o boot a acha por id (conversa sem pasta não entra na carga por projeto). */
export const CENTRAL_ID = 'central'
export const CENTRAL_TITLE = 'Central'
/** Teto de entradas guardadas na Central (as mais antigas saem primeiro). */
export const MAX_CENTRAL_ENTRIES = 400

/** Para onde vai uma mensagem da Central. */
export type CentralTarget =
  /** Conversa existente (de projeto ou de sandbox). */
  | { kind: 'conversation'; convId: string; cwd: string; project: string; title: string; sandbox: boolean }
  /** Conversa nova na pasta do projeto. */
  | { kind: 'new-conversation'; cwd: string; project: string }
  /** Conversa nova numa subpasta nova do sandbox. */
  | { kind: 'new-sandbox' }

/** A regra que levou ao destino: 1 continua um destino recente; 2 volta a uma conversa antiga do projeto;
 *  3 abre conversa nova no projeto; 4 sem projeto (sandbox, existente ou novo). */
export type CentralRule = 'continua' | 'conversa-antiga' | 'nova' | 'sandbox'

/** Um destino recente da Central, como a tela o manda no pedido de rota. */
export interface CentralRecent {
  convId: string
  /** O último pedido do usuário que foi para lá (cortado). */
  request: string
  /** O começo da resposta do agente lá ('' se ainda não respondeu). */
  replyStart: string
}

export interface CentralRouteRequest {
  text: string
  /** Só os NOMES dos anexos. */
  attachments: string[]
  /** Até 5 destinos recentes, do mais recente para o mais antigo. */
  recent: CentralRecent[]
  /** "Não era aqui" e reenvio: nunca manda direto, sempre devolve opções. */
  forceAsk?: boolean
  /** Destino a tirar das opções (o errado, no "não era aqui"). */
  exclude?: CentralTarget
}

/** Uma opção de "Para onde vai?". */
export interface CentralOption {
  target: CentralTarget
  /** Probabilidade dada pelo TypeSafe (ausente nas opções de heurística). */
  probability?: number
}

export type CentralAskReason = 'low-confidence' | 'typesafe-failed' | 'target-missing' | 'moved'

export type CentralRouteResult =
  | { kind: 'direct'; target: CentralTarget; rule: CentralRule; confidence: number; why: string }
  /** `best` = índice da opção mais provável (borda laranja); ausente quando nenhuma se destaca. */
  | { kind: 'ask'; options: CentralOption[]; reason: CentralAskReason; best?: number }

/** "Não era aqui": a correção vai para um log local que alimenta a calibração. */
export interface CentralCorrection {
  ts: number
  text: string
  attachments: string[]
  from: CentralTarget
  fromRule?: CentralRule
  fromConfidence?: number
  to: CentralTarget
}

/** A mensagem entregue no destino: conversa + id da bolha do usuário lá. */
export interface CentralAnchor {
  convId: string
  msgId: string
}

export interface CentralRequestEntry {
  kind: 'request'
  id: string
  ts: number
  text: string
  /** Nomes dos anexos (o conteúdo não é guardado aqui). */
  attachments?: string[]
  /** routing: decidindo · asking: esperando "Para onde vai?" · delivered: entregue · failed: não deu para entregar. */
  state: 'routing' | 'asking' | 'delivered' | 'failed'
  route?: { target: CentralTarget; rule?: CentralRule; confidence?: number; why: string; byUser?: boolean }
  ask?: { options: CentralOption[]; reason: CentralAskReason; best?: number }
  anchor?: CentralAnchor
  /** "Não era aqui": de onde a mensagem foi tirada. */
  movedFrom?: CentralTarget
}

export interface CentralActivitySegment {
  text: string
  tone?: 'strong' | 'add' | 'rem' | 'ok' | 'bad'
}

/** A linha-resumo da atividade de um turno (montada sem LLM). */
export interface CentralActivity {
  /** A linha para a tela, já cortada em ~110 caracteres. */
  segments: CentralActivitySegment[]
  /** A linha inteira, sem corte (vai no `title` e no celular). */
  text: string
  /** Quantas ações (tool-use da trilha principal, sem as de plano). */
  count: number
  errors: number
  /** "lendo auth.ts…" enquanto o turno roda; ausente quando terminou ou não há ação em curso. */
  now?: string
}

export interface CentralReplyEntry {
  kind: 'reply'
  id: string
  ts: number
  requestId: string
  anchor: CentralAnchor
  notes: string[]
  answer?: string
  activity: CentralActivity
  done: boolean
}

export interface CentralQuestionEntry {
  kind: 'question'
  id: string
  ts: number
  convId: string
  question: string
  answer: string
}

export type CentralEntry = CentralRequestEntry | CentralReplyEntry | CentralQuestionEntry

export interface CentralState {
  entries: CentralEntry[]
}

/** A Central? (pelo modo, com o id fixo como segunda garantia). */
export function isCentralConversation(conv: { id?: string; mode?: string } | null | undefined): boolean {
  return !!conv && (conv.mode === 'central' || conv.id === CENTRAL_ID)
}

/**
 * Etapa 3 (decisor): o que a tela já sabe do destino recente. Com isto o decisor
 * monta o destino mesmo quando o índice não tem a conversa (recém-criada, ainda
 * não gravada) ou não pôde ser lido. Campos opcionais, somados por declaration
 * merging à `CentralRecent` lá de cima.
 */
export interface CentralRecent {
  /** A pasta da conversa. */
  cwd?: string
  /** O título da conversa. */
  title?: string
}
