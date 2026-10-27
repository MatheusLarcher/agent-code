/**
 * Credencial do Kimi: a chave oficial do Kimi Code, colada em Configurações →
 * Kimi e guardada como sensível na config (`config.kimi.apiKey`). Sem OAuth,
 * sem renovação: a chave é estática. Quem a lê é o roteador (a cada pedido, para
 * a troca valer sem reiniciar) e o Testar conexão; ela nunca vai ao ambiente do
 * CLI nem a log.
 */
import type { KimiConfig } from '../../shared/ipc'
import { kimiSelectable } from '../../shared/selectableModels'

/** A chave, ou null quando o Kimi está desligado ou sem chave. */
export function kimiApiKey(cfg: KimiConfig | undefined): string | null {
  const key = cfg?.enabled ? cfg.apiKey?.trim() : ''
  return key ? key : null
}

/** Conectado = ligado + chave + conexão testada (há modelo liberado). */
export function isKimiConnected(cfg: KimiConfig | undefined): boolean {
  return kimiSelectable(cfg).length > 0
}

export const KIMI_MISSING_KEY_ERROR =
  'Modelo Kimi selecionado, mas a chave do Kimi não está configurada. Abra Configurações → Kimi, cole a chave e clique em Testar conexão.'
