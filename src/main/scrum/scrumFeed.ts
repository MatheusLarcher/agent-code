import { randomUUID } from 'node:crypto'
import type { ScrumLogWriter } from './scrumLog'
import type { ScrumDecisao } from './scrumTypes'

/**
 * O diário do SM COM AVISO: cada linha gravada vai também à tela (o evento
 * `scrumChanged`, que move o SM do escritório e relê o painel), e a resposta do
 * agente à cobrança vira uma linha `resposta` ligada à decisão.
 *
 * A resposta é o PRIMEIRO texto do agente principal depois de a cobrança ser
 * entregue (o `entregue` do hook) ou do corte (`interrompeu`, que manda a
 * cobrança como mensagem nova). A AgentSession avisa por `noteScrumAgentText`.
 */

/** Teto do texto do agente guardado no diário (a resposta, não o transcript). */
export const SCRUM_RESPOSTA_MAX = 4_000

export interface ScrumFeed {
  /** O gravador que o ScrumMaster usa (grava, avisa a tela e arma a espera da resposta). */
  log: ScrumLogWriter
  /** Um texto do agente principal de uma conversa de handoff. */
  agentText(convId: string, text: string): void
}

export interface ScrumFeedDeps {
  write: ScrumLogWriter
  emit(decisao: ScrumDecisao): void
  now?(): number
  uuid?(): string
}

export function createScrumFeed(deps: ScrumFeedDeps): ScrumFeed {
  /** A última cobrança decidida por conversa (a que o `entregue` leva ao agente). */
  const charges = new Map<string, ScrumDecisao>()
  /** A decisão cuja resposta ainda não chegou, por conversa. */
  const awaiting = new Map<string, ScrumDecisao>()
  const now = deps.now ?? Date.now

  const log: ScrumLogWriter = (d) => {
    try {
      deps.write(d)
    } catch {
      /* o gravador já engole; nada aqui derruba o SM */
    }
    if (d.tipo === 'cobrou' || d.tipo === 'falha') {
      if (d.cobranca) charges.set(d.convId, d)
    } else if (d.tipo === 'entregue') {
      const charge = charges.get(d.convId)
      awaiting.set(d.convId, charge && charge.envioId === d.envioId && charge.entregaId === d.entregaId ? charge : d)
      charges.delete(d.convId)
    } else if (d.tipo === 'interrompeu') {
      awaiting.set(d.convId, d)
    } else if (d.tipo === 'parou') {
      charges.delete(d.convId)
      awaiting.delete(d.convId)
    }
    try {
      deps.emit(d)
    } catch {
      /* janela fechada: a tela relê ao abrir */
    }
  }

  const agentText = (convId: string, text: string): void => {
    const ref = awaiting.get(convId)
    const said = text.trim()
    if (!ref || !said) return
    awaiting.delete(convId)
    const at = now()
    log({
      ...ref,
      id: (deps.uuid ?? randomUUID)(),
      at: new Date(at).toISOString(),
      tipo: 'resposta',
      veredito: null,
      tipoDesvio: null,
      motivo: null,
      cobranca: null,
      rota: null,
      durationMs: null,
      decorridoMs: Math.max(0, at - Date.parse(ref.at)),
      refId: ref.id,
      texto: said.length > SCRUM_RESPOSTA_MAX ? `${said.slice(0, SCRUM_RESPOSTA_MAX - 1)}…` : said
    })
  }

  return { log, agentText }
}

let active: ScrumFeed | null = null

export function setActiveScrumFeed(feed: ScrumFeed | null): void {
  active = feed
}

/** A AgentSession: o texto do agente principal de uma conversa de handoff. Nunca lança. */
export function noteScrumAgentText(convId: string, text: string): void {
  try {
    active?.agentText(convId, text)
  } catch {
    /* o SM nunca derruba o chat */
  }
}
