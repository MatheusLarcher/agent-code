/**
 * Aviso de handoff em tempo real: o que a conversa de implementação ou a fila
 * fizeram sozinhas e o usuário precisa SABER (não responder). Vira toast no app
 * e, pela ponte, toast no celular pareado (evento SSE `handoff-aviso`).
 *
 * - `fila`: o envio seguinte saiu sozinho (com pendência do anterior, ou retomado);
 * - `decisao`: uma pergunta foi resolvida pela opção recomendada;
 * - `atencao`: linha "ATENÇÃO:" / "DESVIO DO PLANO:" do agente;
 * - `scrum`: resumo do Scrum Master (marco de 200%+, corte, parada, declaração acima do teto).
 */

export const HANDOFF_NOTICE_EVENT = 'handoff-aviso'

export type HandoffNoticeTipo = 'fila' | 'decisao' | 'atencao' | 'scrum'

export interface HandoffNotice {
  convId: string
  tipo: HandoffNoticeTipo
  /** Texto livre, pronto para mostrar. */
  texto: string
  at: number
}

const TIPOS: readonly HandoffNoticeTipo[] = ['fila', 'decisao', 'atencao', 'scrum']

/** "Envio N/M": a posição do envio no lote (prompts do plano, sem rotina nem tirados da fila). */
export function envioPositionLabel(position: { n: number; m: number }): string {
  return `Envio ${position.n}/${position.m}`
}

export function queueIncompleteText(position: { n: number; m: number }, motivo: string | null): string {
  return `${envioPositionLabel(position)} saiu sozinho com a pendência do anterior: ${motivo?.trim() || 'sem detalhe'}`
}

export function queueResumedText(position: { n: number; m: number }): string {
  return `${envioPositionLabel(position)} retomado depois de parar por inatividade`
}

/** O texto do toast (app e celular) de um aviso; `title` é o nome da conversa, quando se sabe. */
export function handoffNoticeText(notice: Pick<HandoffNotice, 'tipo' | 'texto'>, title?: string): string {
  const conv = title?.trim()
  if (notice.tipo === 'decisao') {
    const opcao = notice.texto.replace(/^Decidido sozinho:\s*/u, '')
    return conv ? `Decidido sozinho em ${conv}: ${opcao}` : `Decidido sozinho: ${opcao}`
  }
  if ((notice.tipo === 'atencao' || notice.tipo === 'scrum') && conv) return `${conv} — ${notice.texto}`
  return notice.texto
}

/** Validação na fronteira (SSE no celular, IPC no renderer). */
export function isHandoffNotice(value: unknown): value is HandoffNotice {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.convId === 'string' &&
    typeof v.texto === 'string' &&
    typeof v.at === 'number' &&
    TIPOS.includes(v.tipo as HandoffNoticeTipo)
  )
}
