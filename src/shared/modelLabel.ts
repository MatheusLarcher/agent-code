import { CLAUDE_MODELS, OLLAMA_MODELS, OPENAI_MODELS, isAutoModel } from './ipc'

/**
 * O nome que a tela mostra para o modelo que RESPONDEU (o id vem da resposta da
 * API, não do seletor). Usa os rótulos das listas do seletor, sem o sufixo entre
 * parênteses ("GPT-6.1 Sol (ChatGPT)" → "GPT-6.1 Sol"). Id fora das listas
 * aparece como veio — nunca se inventa nome. O sentinela do Automático não é um
 * modelo que rodou: vira ''.
 */
const LABELS: ReadonlyMap<string, string> = new Map(
  [...CLAUDE_MODELS, ...OPENAI_MODELS, ...OLLAMA_MODELS].map((m) => [m.id, m.label.replace(/\s*\([^()]*\)\s*$/u, '')])
)

export function modelDisplayName(id: string | null | undefined): string {
  const model = typeof id === 'string' ? id.trim() : ''
  if (!model || isAutoModel(model)) return ''
  return LABELS.get(model) ?? model
}

/** Os modelos de um turno na ordem em que entraram: "Opus 5.5 → GPT-6.1 Sol". */
export function modelSequenceLabel(ids: readonly string[]): string {
  const names: string[] = []
  for (const id of ids) {
    const name = modelDisplayName(id)
    if (name && !names.includes(name)) names.push(name)
  }
  return names.join(' → ')
}
