/**
 * "Algum provedor conectado?" — Claude (login ou conta do registro), GPT
 * (login do Codex) e Ollama (ligado + chave). O chat mostra o botão
 * "Conectar conta" quando os três estão desligados.
 *
 * As consultas vêm injetadas: cada uma já existe em outro módulo e o index
 * decide qual usar. Consulta que falha conta como `false` (na dúvida o card
 * aparece; o login existente resolve) — a função nunca lança.
 */
import type { ProvidersStatus } from '../shared/ipc'

export interface ProviderStatusDeps {
  claude: () => Promise<boolean>
  gpt: () => Promise<boolean>
  ollama: () => boolean | Promise<boolean>
}

async function safe(query: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return (await query()) === true
  } catch {
    return false
  }
}

export async function providerStatusWith(deps: ProviderStatusDeps): Promise<ProvidersStatus> {
  const [claude, gpt, ollama] = await Promise.all([safe(deps.claude), safe(deps.gpt), safe(deps.ollama)])
  return { claude, gpt, ollama }
}

/** Registra `providersStatus` e devolve o `changed()` que o index chama depois
 *  de login/logout Claude, conexão/desconexão do Codex e gravação do Ollama:
 *  ele reconsulta e emite `providersChanged` com o estado novo. */
export function registerProviderStatusIpc(opts: {
  handle: (channel: string, listener: () => Promise<ProvidersStatus>) => void
  send: (channel: string, status: ProvidersStatus) => void
  channels: { status: string; changed: string }
  deps: ProviderStatusDeps
}): () => void {
  opts.handle(opts.channels.status, () => providerStatusWith(opts.deps))
  return () => {
    void providerStatusWith(opts.deps).then((status) => opts.send(opts.channels.changed, status))
  }
}
