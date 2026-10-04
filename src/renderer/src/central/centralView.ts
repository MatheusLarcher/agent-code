/**
 * O que a tela da Central mostra de cada entrada, puro (sem React): o aviso do
 * destino debaixo do pedido, o "projeto · conversa" de uma resposta, os rótulos
 * do "Para onde vai?", o motivo da pergunta e a âncora mais recente de um destino.
 * Os mesmos textos do celular (centralRemote.ts), lidos aqui do controller.
 */
import type {
  CentralAskReason,
  CentralAnchor,
  CentralEntry,
  CentralOption,
  CentralRequestEntry
} from '@shared/central'
import type { CentralLabel } from './centralRecents'

export type LabelOf = (convId: string) => CentralLabel

/** O motivo do "Para onde vai?", apagado ao lado do título. */
export const ASK_REASON_TEXT: Record<CentralAskReason, string> = {
  'low-confidence': 'não tenho certeza — a mensagem está esperando',
  'typesafe-failed': 'o TypeSafe não respondeu — a mensagem está esperando',
  'target-missing': 'o destino não existe mais — a mensagem está esperando',
  moved: 'não era aqui — escolha o destino'
}

/** "projeto · conversa" (destino desconhecido: só a conversa). */
export const whoOf = (label: CentralLabel): string => (label.project ? `${label.project} · ${label.title}` : label.title)

/** "1 ação" / "N ações". */
export const actionsLabel = (n: number): string => (n === 1 ? '1 ação' : `${n} ações`)

export interface CentralNotice {
  /** A1: enviado na própria conversa — `em …`, sem porquê nem "não era aqui". */
  adopted: boolean
  /** O texto clicável na cor do destino. */
  to: string
  why: string
  color: string
  anchor: CentralAnchor
}

/** Para onde foi um pedido entregue; null enquanto decide, pergunta ou falhou. */
export function requestNotice(e: CentralRequestEntry, labelOf: LabelOf): CentralNotice | null {
  if (e.state !== 'delivered' || !e.route || !e.anchor) return null
  const dest = labelOf(e.anchor.convId)
  const adopted = e.origin === 'conversation'
  const target = e.route.target
  let to = whoOf(dest)
  if (!adopted && target?.kind === 'new-conversation') to = `nova conversa em ${target.project}`
  else if (!adopted && target?.kind === 'new-sandbox') to = 'sandbox'
  return { adopted, to, why: adopted ? '' : (e.route.why ?? ''), color: dest.color, anchor: e.anchor }
}

export type CentralGlyphKind = 'project' | 'sandbox' | 'new'

export interface CentralOptionView {
  label: string
  /** O projeto, apagado depois do título. */
  sub?: string
  icon: string | null
  glyph: CentralGlyphKind
}

/** O botão de uma opção: conversa = título + projeto; nova = "nova em <projeto>"; sandbox novo = "sandbox". */
export function optionView(option: CentralOption, labelOf: LabelOf): CentralOptionView {
  const t = option.target
  if (t.kind === 'new-conversation') return { label: `nova em ${t.project}`, icon: null, glyph: 'new' }
  if (t.kind === 'new-sandbox') return { label: 'sandbox', icon: null, glyph: 'sandbox' }
  // O título vivo (a conversa pode ter sido renomeada), senão o da opção.
  const live = labelOf(t.convId)
  const known = live.project !== ''
  return {
    label: (known ? live.title : t.title) || 'conversa',
    sub: t.sandbox ? 'sandbox' : known ? live.project : t.project,
    icon: t.sandbox ? null : live.icon,
    glyph: t.sandbox ? 'sandbox' : 'project'
  }
}

/** A bolha do último pedido ancorado nesse destino (o trilho abre a conversa nele). */
export function latestAnchorMsg(entries: readonly CentralEntry[], convId: string): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'request' && e.anchor?.convId === convId) return e.anchor.msgId
  }
  return undefined
}

/** Pedidos injetados (A1): bolha e aviso, nunca bloco de resposta próprio. */
export function injectedIds(entries: readonly CentralEntry[]): Set<string> {
  return new Set(entries.filter((e) => e.kind === 'request' && e.injected).map((e) => e.id))
}
