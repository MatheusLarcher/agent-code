/** Contrato da ponte Chrome — ver docs/superpowers/plans/2026-09-28-chrome-extension.md. */


/** Portas da ponte da extensão do Chrome. */
export const CHROME_BRIDGE_PORTS: readonly number[] = [47831, 47832, 47833, 47834, 47835]

export const HELLO_TIMEOUT_MS = 3000
export const REQUEST_TIMEOUT_MS = 30000
export const CLOSE_AUTH_FAILED = 4001

export const ERR_NOT_CONNECTED =
  'Chrome não conectado: abra o Chrome ou instale a extensão em Configurações'
export const ERR_TIMEOUT = 'Tempo esgotado aguardando o Chrome'
/** Quanto o app espera o clique do "Selecionar" (a extensão desiste antes, em 110 s). */
export const PICK_ELEMENT_TIMEOUT_MS = 120000
/** Prefixo do erro da extensão quando a página navega com a seleção aberta (cdp.js ERR.pickNavigated). */
export const ERR_PICK_NAVIGATED = 'A página mudou durante a seleção'

export interface HelloMessage {
  type: 'hello'
  token: string
  version: string
  userAgent: string
}
export interface WelcomeMessage {
  type: 'welcome'
  version: string
}
export interface PingMessage {
  type: 'ping'
}
export interface PongMessage {
  type: 'pong'
}
export interface RequestMessage {
  type: 'req'
  id: number
  method: string
  params: unknown
}
export type ResponseMessage =
  | { type: 'res'; id: number; ok: true; result: unknown }
  | { type: 'res'; id: number; ok: false; error: string }

export type ExtensionToServer = HelloMessage | PingMessage | ResponseMessage
export type ServerToExtension = WelcomeMessage | PongMessage | RequestMessage
