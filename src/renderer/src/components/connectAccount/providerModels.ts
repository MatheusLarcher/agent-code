/**
 * Regras puras do "Conectar conta": qual provedor serve cada modelo e para
 * qual modelo a conversa vai depois de conectar um provedor.
 */
import {
  CLAUDE_MODELS,
  OLLAMA_MODELS,
  OPENAI_MODELS,
  type ProvidersStatus
} from '@shared/ipc'

export type ProviderId = keyof ProvidersStatus

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', gpt: 'GPT', ollama: 'Ollama' }

const FIRST_MODEL: Record<ProviderId, string> = {
  claude: CLAUDE_MODELS[0].id,
  gpt: OPENAI_MODELS[0].id,
  ollama: OLLAMA_MODELS[0].id
}

export function hasAnyProvider(status: ProvidersStatus): boolean {
  return status.claude || status.gpt || status.ollama
}

/** Provedor de um modelo. "Automático" roda em Claude (o fallback dele é Claude);
 *  id desconhecido também conta como Claude, o padrão do app. */
export function providerOfModel(model: string | undefined): ProviderId {
  if (model && OPENAI_MODELS.some((m) => m.id === model)) return 'gpt'
  if (model && OLLAMA_MODELS.some((m) => m.id === model)) return 'ollama'
  return 'claude'
}

/** Modelo depois de conectar `connected`: se o atual é de um provedor que não
 *  está conectado, passa para o primeiro modelo do recém-conectado; senão fica. */
export function modelAfterConnect(
  model: string | undefined,
  status: ProvidersStatus,
  connected: ProviderId
): string | undefined {
  const current = providerOfModel(model)
  if (model && status[current]) return model
  if (connected === current && model) return model
  return FIRST_MODEL[connected]
}

/** Modelo de uma conversa NOVA: o herdado, se o provedor dele está conectado;
 *  senão o primeiro de um provedor conectado (Claude, GPT, Ollama nessa ordem).
 *  Nenhum conectado → o herdado (o card "Conectar conta" resolve depois). */
export function modelForNewConversation(model: string, status: ProvidersStatus | null): string {
  if (!status || !hasAnyProvider(status) || status[providerOfModel(model)]) return model
  const first = (['claude', 'gpt', 'ollama'] as const).find((p) => status[p])
  return first ? FIRST_MODEL[first] : model
}
