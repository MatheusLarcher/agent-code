/**
 * O que o roteador do Kimi lê a cada pedido: chave, região, janela e as
 * instruções da organização, direto da config (a troca vale sem reiniciar).
 */
import { loadConfig } from '../config'
import { kimiApiKey } from './kimiAuth'
import type { KimiRouterCredential } from './kimiRouter'

export function kimiRouterCredential(): KimiRouterCredential | null {
  const cfg = loadConfig()
  const apiKey = kimiApiKey(cfg.kimi)
  if (!apiKey) return null
  return {
    apiKey,
    region: cfg.kimi.region,
    contextWindow: cfg.kimi.contextWindow,
    orgInstructions: cfg.externalOrgInstructions ?? ''
  }
}
