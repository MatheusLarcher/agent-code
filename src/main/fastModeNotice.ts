import type { FastModeDisabledReason, FastModeState } from '@anthropic-ai/claude-agent-sdk'

/**
 * O Modo rápido da Anthropic é um pedido, não uma garantia: o CLI sobe com ele
 * "on" e, se a conta não puder usá-lo, serve em velocidade padrão e só diz o
 * motivo no resultado do turno (`fast_mode_state` / `fast_mode_disabled_reason`).
 * Medido nesta máquina: com o interruptor ligado e "uso extra" desligado na conta,
 * `usage.speed` voltou "standard" e o turno terminou com `extra_usage_disabled`.
 * Sem este aviso o toggle parecia ligado e não fazia nada.
 */
const REASON_TEXT: Partial<Record<FastModeDisabledReason, string>> = {
  extra_usage_disabled:
    'o modo rápido é cobrado como "uso extra" e ele está desligado nesta conta Claude. Ative o uso extra na conta (claude.ai → Configurações → Uso) para ele valer',
  free: 'contas gratuitas não têm modo rápido',
  preference: 'o modo rápido está desligado por política da organização',
  model_not_allowed: 'este modelo não está liberado para o modo rápido nesta conta',
  not_first_party: 'o modo rápido só existe na API própria da Anthropic',
  disabled_by_env: 'o modo rápido está desligado por variável de ambiente',
  network_error: 'não consegui confirmar o modo rápido com a Anthropic (falha de rede)',
  pending: 'a Anthropic ainda está confirmando o modo rápido nesta conta'
}

/** Texto do aviso quando o modo rápido foi pedido numa sessão Anthropic e o turno
 *  NÃO rodou nele; `null` quando ele valeu (ou não foi pedido). */
export function fastModeNotice(
  requested: boolean,
  state: FastModeState | undefined,
  reason: FastModeDisabledReason | undefined
): { key: string; text: string } | null {
  if (!requested || state === 'on' || (state === undefined && reason === undefined)) return null
  if (state === 'cooldown') {
    return {
      key: 'cooldown',
      text: 'Modo rápido em pausa: o limite de taxa dele estourou e o app voltou à velocidade padrão por alguns minutos.'
    }
  }
  const why = (reason && REASON_TEXT[reason]) ?? 'a Anthropic não liberou o modo rápido para este pedido'
  return { key: reason ?? 'off', text: `Modo rápido NÃO ativo, este turno rodou em velocidade padrão: ${why}.` }
}
