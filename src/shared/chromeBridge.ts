/** Status da ponte Chrome exposto à UI (mesma forma de ChromeBridge.getStatus()). */
export interface ChromeBridgeStatus {
  listening: boolean
  port: number | null
  connected: boolean
  extensionVersion: string | null
  userAgent: string | null
}
