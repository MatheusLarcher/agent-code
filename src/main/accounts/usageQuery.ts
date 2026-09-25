import { homedir } from 'node:os'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { UsageWindow } from '../../shared/claudeAccounts'
import { windowsFromUsage } from './usageMath'

/**
 * Lê as janelas de limite de uma conta abrindo um processo do CLI com a pasta
 * dela e perguntando o `/usage` — SEM mandar mensagem nenhuma.
 *
 * O dado vem de `api/oauth/usage`: é leitura HTTP, não chama o modelo, então
 * não gasta limite. `skipBehaviors` pula a varredura dos transcripts locais.
 * Medido em 2026-09-24 (SDK 0.3.281, Windows): 1,06–1,35 s de ponta a ponta.
 *
 * Proibido "mandar uma mensagem mínima para ler o consumo": isso gasta limite.
 */
export async function fetchAccountWindows(
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal
): Promise<Record<string, UsageWindow>> {
  let release!: () => void
  const closed = new Promise<void>((resolve) => {
    release = resolve
  })
  // Entrada que nunca produz mensagem: o processo só serve para o controle.
  async function* noMessages(): AsyncIterable<SDKUserMessage> {
    await closed
  }
  const abortController = new AbortController()
  const onAbort = (): void => abortController.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  const options: Options = {
    cwd: homedir(),
    executable: 'node',
    tools: [],
    // Sem hooks, plugins e MCP do usuário: é só uma leitura de controle.
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    abortController,
    ...(env ? { env } : {})
  }
  const q = query({ prompt: noMessages(), options })
  try {
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
    if (!usage.rate_limits_available) throw new Error('conta sem limites de plano (sem login do claude.ai?)')
    return windowsFromUsage(usage.rate_limits)
  } finally {
    signal.removeEventListener('abort', onAbort)
    release()
    q.close()
  }
}
