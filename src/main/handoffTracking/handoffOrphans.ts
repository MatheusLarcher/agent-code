import { CARD_ETAPA_PREFIX, type HandoffEntregaStatus, type HandoffEnvio } from '../../shared/handoffTracking'
import { boardItemStatus, type BoardItem, type BoardItemStatus } from '../../shared/ipc'
import { handoffEtapaSections } from '../planning/handoffAceite'
import { etapaIdFromTitle, poContestReason } from './handoffCardMatch'
import { entregaCard, truncate } from './handoffRules'

/**
 * As etapas do prompt deste turno como o fechamento do PO as recebe:
 *
 * - `orphanEtapas`: as SEM cartão no Quadro — para criar o cartão `[id]` de
 *   cada uma (FEITA com evidência, NOVA sem ela). Só o PO resolve: PO
 *   desligado, ninguém cria cartão automático.
 * - `envioEtapasForPo`: o PLACAR inteiro — toda etapa, com o status que o
 *   usuário vê, o cartão que fala por ela e o aceite da seção dela no prompt,
 *   para o PO conferir o status real contra a evidência (ETAPA CONCLUÍDA/PENDENTE).
 *
 * O cartão é achado pelo casamento do acompanhamento (`entregaCard` em
 * handoffRules.ts), com os cartões do PROJETO: órfã aqui é exatamente a entrega
 * para a qual a sincronização (syncEntregas) não acha cartão nenhum.
 */

export interface OrphanEtapa {
  etapaId: string
  titulo: string
}

/** O id que um título `[id] …` carrega de volta — senão o cartão criado nunca casaria. */
function prefixable(etapaId: string): boolean {
  return !etapaId.startsWith(CARD_ETAPA_PREFIX) && etapaIdFromTitle(`[${etapaId}]`) === etapaId.toLowerCase()
}

/**
 * As entregas do envio ainda NÃO concluídas e sem cartão, na ordem do envio.
 * Fora: a corrigida pelo usuário (o Quadro já não decide por ela) e a ligada
 * direto a um cartão (`card:<id>`) ou com um id que o prefixo não carrega — um
 * cartão novo não as alcançaria.
 */
export function orphanEtapas(envio: HandoffEnvio, cards: readonly BoardItem[]): OrphanEtapa[] {
  return envio.entregas
    .filter((entrega) => entrega.status !== 'concluida' && entrega.corrigidoPor !== 'usuario' && prefixable(entrega.etapaId))
    .filter((entrega) => entregaCard(envio, entrega, cards) === null)
    .map((entrega) => ({ etapaId: entrega.etapaId, titulo: entrega.etapaTitulo }))
}

// ---------------------------------------------------------------------------
// O placar do envio para o PO
// ---------------------------------------------------------------------------

/** Uma etapa do envio corrente como o fechamento do PO a vê. */
export interface PoEnvioEtapa {
  etapaId: string
  titulo: string
  /** O status no placar — o que o usuário acompanha. */
  status: HandoffEntregaStatus
  /** O cartão que fala pela etapa (o MESMO casamento do acompanhamento), com o
   *  status efetivo e se o PO já o contestou; `null` sem cartão. */
  card: { id: string; status: BoardItemStatus; contested: boolean } | null
  /** "Aceite:" e "Verificar com:" da seção da etapa no texto do prompt;
   *  `null` sem seção ou sem o rótulo. */
  aceite: string | null
  verificarCom: string | null
}

/** Teto do aceite e do "verificar com" (o PO os lê contra a evidência; não executa). */
export const PO_ETAPA_FIELD_MAX = 160

/** Um rótulo da seção da etapa, tolerante ao negrito/itálico em volta (`**Aceite:**`, `**Aceite**:`). */
function label(name: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}])${name}[*_]*\\s*:[*_]*`, 'iu')
}
const ACEITE = label('Aceite')
const VERIFICAR = label('Verificar com')
/** Onde o valor de um rótulo acaba: outro rótulo (inclusive "Decidido:"). */
const ANY_LABEL = label('(?:Aceite|Verificar com|Decidido)')
const HEADING = /^\s*#{1,6}\s/u
const LIST_MARK = /^\s*(?:[-*+]|\d+[.)])\s+/u

/** Tira a ênfase de markdown (`**negrito**`, `_itálico_`) sem tocar no `*` e no `_`
 *  de comandos e caminhos (`src/**\/*.ts`, `_handoff/`): só os pares que envolvem texto. */
function unmark(text: string): string {
  return text
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^*_]*?\S)[*_](?=[\s).,;:!?]|$)/gu, '$1$2')
}

/**
 * O texto depois do rótulo: até o fim da linha dele mais as linhas seguintes,
 * até uma linha vazia, outro rótulo ou um título. Colapsado e cortado no teto;
 * `null` sem o rótulo (ou com ele vazio).
 */
function fieldAfter(lines: readonly string[], field: RegExp): string | null {
  const at = lines.findIndex((line) => field.test(line))
  if (at < 0) return null
  const found = field.exec(lines[at])!
  let first = lines[at].slice(found.index + found[0].length)
  // Dois rótulos na mesma linha ("Aceite: x — Verificar com: y"): o valor para no segundo.
  const next = ANY_LABEL.exec(first)
  if (next) first = first.slice(0, next.index)
  const parts = [first]
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || ANY_LABEL.test(line) || HEADING.test(line)) break
    parts.push(line.replace(LIST_MARK, ''))
  }
  const clean = unmark(parts.join(' ')).replace(/\s+/gu, ' ').trim()
  return clean ? truncate(clean, PO_ETAPA_FIELD_MAX) : null
}

/**
 * TODAS as entregas do envio, na ordem (as concluídas inclusive): o placar que
 * o fechamento do PO confere etapa por etapa. O cartão vem do mesmo casamento
 * das regras (`entregaCard`); `contested` é a contestação do PO que o placar já
 * mostra (`poContestReason`); o aceite e o "verificar com" saem da seção da
 * etapa no texto do prompt (planning/handoffAceite.ts — só leitura).
 */
export function envioEtapasForPo(envio: HandoffEnvio, cards: readonly BoardItem[]): PoEnvioEtapa[] {
  const sections = handoffEtapaSections(envio.conteudo, envio.entregas.map((entrega) => entrega.etapaId))
  return envio.entregas.map((entrega) => {
    const card = entregaCard(envio, entrega, cards)
    const lines = sections.get(entrega.etapaId)?.split('\n') ?? null
    return {
      etapaId: entrega.etapaId,
      titulo: entrega.etapaTitulo,
      status: entrega.status,
      card: card ? { id: card.id, status: boardItemStatus(card), contested: poContestReason(card) !== null } : null,
      aceite: lines ? fieldAfter(lines, ACEITE) : null,
      verificarCom: lines ? fieldAfter(lines, VERIFICAR) : null
    }
  })
}
