import { CLAUDE_MODELS, OLLAMA_MODELS, OPENAI_MODELS } from './ipc'

/**
 * Os modelos que o seletor da conversa oferece AGORA: Claude sempre, os do
 * Ollama Cloud com a integração ligada e com chave, e os GPT com login do
 * ChatGPT (Codex). Uma regra só para a tela e para o MCP de entrada — duas
 * cópias divergiriam, e o chamador externo aceitaria um modelo que a tela não
 * oferece (ou o contrário). "Automático" não entra: é um sentinel da tela.
 */
export interface ModelAvailability {
  /** Ollama Cloud ligado e com chave. */
  ollama: boolean
  /** Login do ChatGPT (Codex) no ar. */
  codex: boolean
}

export function selectableModels(a: ModelAvailability): { id: string; label: string }[] {
  return [...CLAUDE_MODELS, ...(a.ollama ? OLLAMA_MODELS : []), ...(a.codex ? OPENAI_MODELS : [])]
}

export function selectableModelIds(a: ModelAvailability): string[] {
  return selectableModels(a).map((m) => m.id)
}

/** A config do Ollama deixa os modelos dele no seletor? (ligado + chave). */
export function ollamaSelectable(ollama: { enabled?: boolean; apiKey?: string } | undefined): boolean {
  return !!ollama?.enabled && !!ollama.apiKey?.trim()
}
