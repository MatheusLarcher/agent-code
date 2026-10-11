/**
 * Os avisos de handoff (shared/handoffNotice.ts) na ponte do celular: o evento
 * `handoff-aviso` vai no mesmo envelope SSE dos eventos do chat ({ convId, event }),
 * com a conversa OFFICE_BRIDGE_CONV — o app do celular antigo ignora (é "da
 * outra conversa" do escritório); o novo mostra um toast. Só toast com o app
 * aberto: notificação de sistema fica fora (sem plugin no Capacitor).
 */
import { HANDOFF_NOTICE_EVENT, type HandoffNotice } from '../../shared/handoffNotice'
import { OFFICE_BRIDGE_CONV } from '../../shared/officeCall'

export type HandoffNoticeBridgeEvent = { kind: typeof HANDOFF_NOTICE_EVENT; title?: string } & HandoffNotice

export class HandoffNoticeBridge {
  constructor(private readonly write: (line: string) => void) {}

  /** `title`: o nome da conversa, quando o main sabe (vai junto ao celular). */
  notice(notice: HandoffNotice, title?: string): void {
    const event: HandoffNoticeBridgeEvent = { kind: HANDOFF_NOTICE_EVENT, ...notice, ...(title ? { title } : {}) }
    this.write(`data: ${JSON.stringify({ convId: OFFICE_BRIDGE_CONV, event })}\n\n`)
  }
}
