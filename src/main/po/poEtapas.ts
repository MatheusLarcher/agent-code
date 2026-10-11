import type { PoEnvioEtapa } from './poPrompt'

/**
 * A leitura das linhas do PLACAR no veredito do fechamento —
 * `ETAPA [id] | CONCLUÍDA | <evidência>` e `ETAPA [id] | PENDENTE | <o que
 * falta>` — e o mapa etapa → cartão que as liga ao quadro.
 *
 * Mora à parte porque DOIS leitores precisam da mesma regra: o parser do
 * veredito (poVerdict.ts), que transforma a linha em operação, e o padrão do
 * fechamento (poCloseDefault.ts), que precisa saber que o cartão da etapa
 * citada foi JULGADO e não pode ser concluído pelo padrão. A seta continua de
 * mão única: este arquivo importa só o tipo de poPrompt.ts, e poPrompt.ts não
 * importa (nem reexporta) nada daqui.
 */

/**
 * `ETAPA [id] | CONCLUÍDA|PENDENTE | motivo`: id com ou sem colchetes, verbo
 * sem distinção de caixa e com ou sem acento. O motivo é opcional AQUI — quem
 * decide o que fazer sem ele é quem chama: o parser descarta a linha, o padrão
 * do fechamento ainda a conta como julgamento (o modelo quis falar do cartão).
 */
const ETAPA_LINE = /^ETAPA\s+\[?([^\]\s|]{1,64})\]?\s*\|\s*(CONCLU[IÍ]DA|PENDENTE)\b\s*(?:\|\s*(.*))?$/iu

export interface PoEtapaLine {
  /** O id da etapa em minúsculas — a chave do mapa. */
  etapaId: string
  /** CONCLUÍDA conclui o cartão; PENDENTE o contesta. */
  verdict: 'complete' | 'contest'
  /** O motivo como veio (pode ser vazio). */
  reason: string
}

export function parseEtapaLine(text: string): PoEtapaLine | null {
  const match = ETAPA_LINE.exec(text)
  if (!match) return null
  const [, id, verb, reason] = match
  return {
    etapaId: id.toLowerCase(),
    verdict: verb.toUpperCase() === 'PENDENTE' ? 'contest' : 'complete',
    reason: (reason ?? '').trim()
  }
}

/**
 * O mapa etapa (minúscula) → cartão das etapas do placar que TÊM cartão: só
 * essas viram operação (a sem cartão é das órfãs, FEITA/NOVA). Com o mesmo id
 * duas vezes, vale a primeira — a ordem do roteiro.
 */
export function poEnvioEtapaMap(etapas: readonly PoEnvioEtapa[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const etapa of etapas) {
    const id = etapa.etapaId.toLowerCase()
    if (etapa.card && !map.has(id)) map.set(id, etapa.card.id)
  }
  return map
}
