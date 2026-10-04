/**
 * O chamado do agente (Fase 2, sug-ferramenta-chamar / req-aviso-chamado): a
 * ferramenta `app_chamar_usuario` e o contrato dos avisos que saem do PC.
 *
 * O escritório tira o chamado das mensagens da conversa (a chamada da
 * ferramenta); o main avisa o Windows e a ponte do celular no handler dela.
 */
/** Nome da ferramenta como aparece nas mensagens (servidor MCP 'app'). */
export const OFFICE_CALL_TOOL = 'mcp__app__app_chamar_usuario'
/** Tamanho máximo da mensagem do chamado. */
export const OFFICE_CALL_MESSAGE_MAX = 280

/** Por que o chamado acabou. */
export type OfficeCallEnd = 'aberto' | 'respondido' | 'cancelado'

/** Ponte → celular: um agente chamou o usuário para ver um HTML. */
export interface OfficeCallEvent {
  /** O id da chamada da ferramenta (o mesmo que o escritório usa). */
  id: string
  convId: string
  /** O título da conversa (o nome do agente no escritório). */
  agente: string
  /** O nome do projeto (a pasta). */
  projeto: string
  /** Caminho do HTML relativo à pasta do projeto. */
  arquivo: string
  /** O <title> do HTML, ou o nome do arquivo. */
  titulo: string
  mensagem?: string
  /** Quando chamou (epoch ms). */
  at: number
}

/** Ponte → celular: o chamado acabou. */
export interface OfficeCallResolved {
  id: string
  motivo: OfficeCallEnd
}

/**
 * Renderer → main: o que só a interface sabe dos chamados — os abertos, os que
 * acabaram (com o motivo), se o usuário está olhando a sala de reunião (aí não
 * notifica) e o título de cada conversa do escritório (o nome do agente no aviso).
 */
export interface OfficeCallsState {
  open: string[]
  ended: OfficeCallResolved[]
  /** Na aba Escritório, com a janela em foco e a sala de reunião à vista. */
  watching: boolean
  titles: Record<string, string>
}

/** Main → renderer: o clique na notificação (a aba Escritório, o filtro no projeto e a câmera na TV). */
export interface OfficeCallOpen {
  id: string
  convId: string
}

/** A "conversa" dos avisos na ponte (o celular trata como evento de outra conversa: só atualiza a lista). */
export const OFFICE_BRIDGE_CONV = 'office'

/** O que a ponte manda ao celular sobre os chamados. */
export type OfficeBridgeEvent =
  | ({ kind: 'office-call' } & OfficeCallEvent)
  | ({ kind: 'office-call-resolved' } & OfficeCallResolved)
  | { kind: 'office-calls'; calls: OfficeCallEvent[] }
