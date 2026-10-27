import { CLAUDE_MODELS, DEEPSEEK_MODELS, KIMI_MODELS, OLLAMA_MODELS, OPENAI_MODELS, type KimiConfig } from './ipc'

/**
 * Os modelos que o seletor da conversa oferece AGORA: Claude sempre, os do
 * Ollama Cloud e da DeepSeek com a integração ligada e com chave, e os GPT com
 * login do ChatGPT (Codex). Uma regra só para a tela e para o MCP de entrada —
 * duas cópias divergiriam, e o chamador externo aceitaria um modelo que a tela
 * não oferece (ou o contrário). "Automático" não entra: é um sentinel da tela.
 */
export interface ModelAvailability {
  /** Ollama Cloud ligado e com chave. */
  ollama: boolean
  /** Login do ChatGPT (Codex) no ar. */
  codex: boolean
  /** DeepSeek ligado e com chave. Ausente = desligado. */
  deepseek?: boolean
  /** Kimi ligado, com chave e com a conexão testada: os ids que o plano libera.
   *  Ausente ou vazio = sem Kimi no seletor. */
  kimi?: readonly string[]
}

export function selectableModels(a: ModelAvailability): { id: string; label: string }[] {
  return [
    ...CLAUDE_MODELS,
    ...(a.ollama ? OLLAMA_MODELS : []),
    ...(a.codex ? OPENAI_MODELS : []),
    ...(a.deepseek ? DEEPSEEK_MODELS : []),
    ...KIMI_MODELS.filter((m) => a.kimi?.includes(m.id))
  ]
}

/** Os modelos Kimi que o seletor oferece: ligado + chave + conexão testada. */
export function kimiSelectable(cfg: KimiConfig | undefined): string[] {
  if (!cfg?.enabled || !cfg.apiKey?.trim()) return []
  return (cfg.models ?? []).filter((id) => KIMI_MODELS.some((m) => m.id === id))
}

export function selectableModelIds(a: ModelAvailability): string[] {
  return selectableModels(a).map((m) => m.id)
}

/** A config de um provedor por chave deixa os modelos dele no seletor? (ligado + chave). */
export function keyProviderSelectable(cfg: { enabled?: boolean; apiKey?: string } | undefined): boolean {
  return !!cfg?.enabled && !!cfg.apiKey?.trim()
}

/** A config do Ollama deixa os modelos dele no seletor? (ligado + chave). */
export const ollamaSelectable = keyProviderSelectable

/** A config da DeepSeek deixa os modelos dela no seletor? (ligado + chave). */
export const deepseekSelectable = keyProviderSelectable
