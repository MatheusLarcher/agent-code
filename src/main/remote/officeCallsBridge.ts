/**
 * Os chamados do agente na ponte do celular (req-aviso-chamado, só a parte do
 * PC): `office-call` quando um agente chama, `office-call-resolved` quando o
 * chamado acaba e, a quem conecta, a lista dos abertos (`office-calls`). Vai no
 * mesmo envelope SSE dos eventos do chat ({ convId, event }), com a conversa
 * OFFICE_BRIDGE_CONV: o app do celular de hoje trata como evento de outra
 * conversa (só atualiza a lista), sem mexer no chat aberto.
 */
import { OFFICE_BRIDGE_CONV, type OfficeBridgeEvent, type OfficeCallEvent, type OfficeCallResolved } from '../../shared/officeCall'

export class OfficeCallsBridge {
  private readonly open = new Map<string, OfficeCallEvent>()

  constructor(private readonly write: (line: string) => void) {}

  private line(event: OfficeBridgeEvent): string {
    return `data: ${JSON.stringify({ convId: OFFICE_BRIDGE_CONV, event })}\n\n`
  }

  /** Um agente chamou. */
  call(e: OfficeCallEvent): void {
    this.open.set(e.id, e)
    this.write(this.line({ kind: 'office-call', ...e }))
  }

  /** O chamado acabou (só os que a ponte anunciou). */
  resolved(r: OfficeCallResolved): void {
    if (!this.open.delete(r.id)) return
    this.write(this.line({ kind: 'office-call-resolved', id: r.id, motivo: r.motivo }))
  }

  /** Os abertos, do mais antigo ao mais novo. */
  list(): OfficeCallEvent[] {
    return [...this.open.values()]
  }

  /** A linha para quem acabou de conectar (null sem chamado aberto). */
  hello(): string | null {
    return this.open.size ? this.line({ kind: 'office-calls', calls: this.list() }) : null
  }
}
