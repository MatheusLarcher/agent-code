import { CARD_ETAPA_PREFIX, type HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardItem } from '../../shared/ipc'
import { etapaIdFromTitle } from './handoffCardMatch'
import { entregaCard } from './handoffRules'

/**
 * As etapas do prompt SEM cartão no Quadro — o que o fechamento do PO recebe
 * para criar o cartão `[id]` de cada uma (FEITA com evidência, NOVA sem ela).
 * Só o PO resolve: PO desligado, ninguém cria cartão automático.
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
