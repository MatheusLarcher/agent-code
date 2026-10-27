/**
 * Sessão Kimi: o ambiente do CLI e o modelo que vai no fio. Fica fora do
 * agentSession.ts (já enorme); lá só o ramo curto que chama isto.
 *
 * O CLI roda logado na conta Claude da conversa (mesma pasta, mesmas flags e
 * plugins), com o endereço base no roteador local (kimiRouter.ts), que leva ao
 * Kimi só os pedidos com modelo Kimi. Ambiente provado pela captura do
 * planejamento (modo `kimi2`): prompt de sistema e ferramentas idênticos aos do
 * Claude, só as linhas de identidade do modelo diferem.
 * - SEM `ANTHROPIC_DEFAULT_*_MODEL`: com o apelido FABLE = modelo o CLI se
 *   apresenta como "Claude Fable 5"; com os outros, os auxiliares internos do CLI
 *   (título etc.) iriam ao Kimi em vez de ficarem no Claude.
 * - Nenhuma credencial do Kimi: ela mora no roteador. O ambiente do CLI é herdado
 *   pelos comandos Bash do agente.
 */
import type { KimiConfig } from '../../shared/ipc'

/** Janela em que a conversa Kimi compacta. Plano de 256K: a própria janela. Plano
 *  de 1M: 400K — o guia do Kimi cita teto de 2 MB por requisição (~500K tokens);
 *  a sonda de 26/10 (plano Plus) não chegou a vê-lo, mas no 1M ele vale antes da janela. */
export function kimiCompactWindow(contextWindow: number): number {
  return contextWindow >= 1_048_576 ? 400_000 : contextWindow
}

/** Modelo no fio: `k3.1-pro[1m]` quando o plano dá 1M (o CLI tira o sufixo e
 *  manda o beta de 1M); senão o id escolhido. */
export function kimiWireModel(model: string, cfg: Pick<KimiConfig, 'contextWindow'>): string {
  const bare = model.replace(/\[1m\]$/i, '')
  return bare === 'k3.1-pro' && cfg.contextWindow >= 1_048_576 ? `${bare}[1m]` : bare
}

const STRIP = /^(ANTHROPIC_DEFAULT_\w+_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_MODEL|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_SUBAGENT_MODEL)$/

/** Ambiente do CLI na sessão Kimi. `base` = o env da conta Claude da conversa
 *  (`claudeAccounts.envFor`) ou o `process.env` (conta padrão). */
export function kimiSessionEnv(
  base: NodeJS.ProcessEnv,
  wireModel: string,
  routerBaseUrl: string,
  cfg: Pick<KimiConfig, 'contextWindow'>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!STRIP.test(k)) env[k] = v
  return {
    ...env,
    ANTHROPIC_BASE_URL: routerBaseUrl,
    CLAUDE_CODE_SUBAGENT_MODEL: wireModel,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(cfg.contextWindow),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(kimiCompactWindow(cfg.contextWindow)),
    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'padded-countdown',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '128000'
  }
}

export const KIMI_AUX_RESERVE_NOTICE =
  'Claude indisponível: os auxiliares desta conversa (título, resumos) estão usando o Kimi (k3-256k).'

/** Ouvintes do aviso de reserva, um por sessão Kimi aberta: cada um compara o id
 *  da sessão do CLI com o seu. O roteador é um só para o app inteiro. */
const auxListeners = new Set<(cliSessionId: string) => void>()

export function addKimiAuxListener(listener: (cliSessionId: string) => void): () => void {
  auxListeners.add(listener)
  return () => auxListeners.delete(listener)
}

export function notifyKimiAuxReserve(cliSessionId: string): void {
  for (const l of auxListeners) l(cliSessionId)
}
