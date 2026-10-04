/**
 * A Central: a conversa única que roteia cada mensagem (pelo TypeSafe) para a
 * conversa certa. Tipos compartilhados entre o main (decisor), a tela e o celular.
 */
import type { PermissionRequest } from './ipc'

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

/**
 * Etapa 4 / Emenda A1 (todas as conversas na Central): de onde veio o pedido e
 * qual PC criou cada entrada — os dois PCs dividem a MESMA Central, e cada
 * entrada tem um dono só. Campos opcionais, somados por declaration merging às
 * entradas lá de cima (entradas antigas continuam válidas).
 */
export interface CentralRequestEntry {
  /** 'central' (ausente = anterior à A1): roteada pela Central. 'conversation': turno
   *  enviado na própria conversa e adotado pela Central (sem "não era aqui"). */
  origin?: 'central' | 'conversation'
  /** `installationId` do PC que criou a entrada. Ausente = legado, tratada como deste PC. */
  device?: string
  /** Ajuste injetado num turno em andamento: aparece como bolha, nunca tem resposta própria. */
  injected?: true
  /** Resposta a uma mensagem da Central (estilo WhatsApp): vai direto à conversa dela,
   *  sem o decisor. `id` = entrada citada; `convId` = conversa dela; `text` = trecho citado. */
  replyTo?: CentralReplyQuote
}

/** A mensagem citada por uma resposta. */
export interface CentralReplyQuote {
  id: string
  convId: string
  text: string
}

/** O "porquê" do destino de uma resposta a uma mensagem. */
export const CENTRAL_REPLY_WHY = 'resposta a uma mensagem'
/** O trecho citado guardado na entrada, no máximo. */
export const CENTRAL_REPLY_QUOTE_MAX = 160
/** Tamanho máximo do `replyTo` aceito em `POST /api/send`. */
export const CENTRAL_REPLY_ID_MAX = 100

/**
 * O `replyTo` de `POST /api/send`: ausente → undefined (envio normal); string de
 * 1..100 caracteres (sem espaços nas pontas) → o id; qualquer outra coisa → null (400).
 */
export function parseReplyTo(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const id = value.trim()
  return id && id.length <= CENTRAL_REPLY_ID_MAX ? id : null
}

export interface CentralReplyEntry {
  /** `installationId` do PC que espelhou a resposta (o mesmo do pedido). */
  device?: string
}

export interface CentralQuestionEntry {
  /** `installationId` do PC onde a pergunta foi respondida. */
  device?: string
}

/* ---- Etapa 6: a Central no celular (RemoteConversation.central) ---- */

/**
 * O retrato da Central que o celular desenha sem refazer nada (montado por
 * src/renderer/src/central/centralRemote.ts). Compacto e sem dado de imagem de
 * mensagem/anexo: anexos são só nomes. A única imagem é o ícone do projeto nos
 * cards e nas opções, e só quando pequeno (data URL de até 12 KB).
 */
export interface RemoteCentral {
  /** As últimas entradas, na ordem do tempo. */
  entries: RemoteCentralEntry[]
  /** Destinos trabalhando agora (os cartões do topo). */
  rail: RemoteCentralCard[]
  /** Perguntas/permissões pendentes dos destinos — respondidas com o `convId` DO DESTINO. */
  questions: RemoteCentralQuestion[]
}

/** O ícone de traço de um destino, desenhado no celular sem ícone de projeto: pasta, sandbox ou conversa nova. */
export type RemoteCentralGlyph = 'project' | 'sandbox' | 'new'

export interface RemoteCentralCard {
  convId: string
  project: string
  title: string
  color: string
  /** Ícone do projeto: `data:image/…` de até 12 KB, senão null (o celular desenha a pasta/sandbox). */
  icon: string | null
  sandbox: boolean
}

/** Uma opção de "Para onde vai?" pronta para o botão. */
export interface RemoteCentralOption {
  label: string
  sub?: string
  /** Ícone do projeto (mesma regra dos cards); null = o traço de `glyph`. */
  icon: string | null
  glyph: RemoteCentralGlyph
  /** A mais provável (destacada). */
  best: boolean
}

export interface RemoteCentralRequest {
  kind: 'request'
  id: string
  ts: number
  text: string
  attachments?: string[]
  state: CentralRequestEntry['state']
  origin?: 'central' | 'conversation'
  injected?: true
  /** Criado por OUTRO PC (o `device` dele difere deste): só aquele PC entrega, então o
   *  celular mostra o "Para onde vai?" sem botões. Ausente = deste PC ou legado. */
  foreign?: true
  /** Para onde foi: `→ <to>` (adotado, A1: `em <to>`) na cor do destino. */
  notice?: { to: string; why: string; color: string }
  /** "Para onde vai?" pendente (só pedido roteado esperando destino). */
  ask?: { reason: CentralAskReason; options: RemoteCentralOption[] }
  anchor?: CentralAnchor
  /** A mensagem citada (resposta estilo WhatsApp): "projeto · conversa", cor e trecho. */
  replyTo?: { who: string; color: string; text: string }
}

/** A linha-resumo PRONTA (a mesma da tela) e se o turno acabou. */
export interface RemoteCentralActivity extends CentralActivity {
  done: boolean
}

export interface RemoteCentralReply {
  kind: 'reply'
  id: string
  ts: number
  requestId: string
  anchor: CentralAnchor
  /** "projeto · conversa" do destino. */
  who: string
  color: string
  notes: string[]
  answer?: string
  activity: RemoteCentralActivity
  /** Espelhada por OUTRO PC: o celular não oferece responder (só o dono entrega). */
  foreign?: true
}

/** Pergunta de um destino já respondida pela Central. */
export interface RemoteCentralAnswered {
  kind: 'question'
  id: string
  ts: number
  convId: string
  who: string
  color: string
  question: string
  answer: string
}

export type RemoteCentralEntry = RemoteCentralRequest | RemoteCentralReply | RemoteCentralAnswered

/** Pergunta/permissão viva de um destino; `request.input` vai enxuto (só texto curto de exibição). */
export interface RemoteCentralQuestion {
  convId: string
  who: string
  color: string
  request: PermissionRequest
}

/** `POST /api/central-choose`: a opção `option` do "Para onde vai?" do pedido `entryId`. */
export interface RemoteCentralChoose {
  entryId: string
  option: number
}

/** Tamanho máximo do id do pedido e maior índice de opção aceitos pela rota. */
export const CENTRAL_CHOOSE_ID_MAX = 100
export const CENTRAL_CHOOSE_OPTION_MAX = 20

/** O corpo de `/api/central-choose` validado na fronteira; null = fora do contrato (400). */
export function parseCentralChoose(value: unknown): RemoteCentralChoose | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { entryId, option } = value as Record<string, unknown>
  if (typeof entryId !== 'string') return null
  const id = entryId.trim()
  if (!id || id.length > CENTRAL_CHOOSE_ID_MAX) return null
  if (typeof option !== 'number' || !Number.isInteger(option) || option < 0 || option > CENTRAL_CHOOSE_OPTION_MAX) {
    return null
  }
  return { entryId: id, option }
}
