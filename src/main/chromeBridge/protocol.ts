/** Contrato da ponte Chrome — ver docs/superpowers/plans/2026-09-28-chrome-extension.md. */

export const CHROME_BRIDGE_PORTS = [47831, 47832, 47833, 47834, 47835] as const

export const HELLO_TIMEOUT_MS = 3000
export const REQUEST_TIMEOUT_MS = 30000
export const CLOSE_AUTH_FAILED = 4001

export const ERR_NOT_CONNECTED =
  'Chrome não conectado: abra o Chrome ou instale a extensão em Configurações'
export const ERR_TIMEOUT = 'Tempo esgotado aguardando o Chrome'

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
