/**
 * O modelo que fez cada coisa, como a tela do monitor mostra. O id vem da
 * resposta (o `model` do tool-use e os modelos do turno gravados no main), nunca
 * do seletor; o nome é o legível do seletor (modelDisplayName) e id fora das
 * listas aparece como veio. Sem dado, nada — não se chuta.
 *
 *   shortModelName(id)   etiqueta curta: "Opus", "Sonnet", "Sol"…
 *   modelProvider(id)    claude | gpt | ollama | other (a cor da etiqueta)
 *   ModelTags            as etiquetas de um item; só num turno com mais de um modelo
 *   ModelChip            "feito por Opus 5.5 → GPT-6.1 Sol"
 */
import { isOllamaModel, isOpenAIModel } from '@shared/ipc'
import { modelDisplayName, modelSequenceLabel } from '@shared/modelLabel'
import { Icon } from './icons'

export type ModelProvider = 'claude' | 'gpt' | 'ollama' | 'other'

export function modelProvider(id: string): ModelProvider {
  if (isOpenAIModel(id)) return 'gpt'
  if (isOllamaModel(id)) return 'ollama'
  if (id.startsWith('claude-')) return 'claude'
  return 'other'
}

/** A etiqueta curta: Claude pela família ("Opus"), GPT pelo nome ("Sol"), o resto pelo 1º nome. */
export function shortModelName(id: string): string {
  const name = modelDisplayName(id)
  if (!name) return ''
  if (name === id.trim()) return name
  const words = name.split(/\s+/)
  return modelProvider(id) === 'gpt' ? words[words.length - 1] : words[0]
}

/** Ids distintos, na ordem, sem vazio. */
export function distinctModels(ids: readonly (string | undefined | null)[]): string[] {
  const out: string[] = []
  for (const id of ids) {
    const v = typeof id === 'string' ? id.trim() : ''
    if (v && modelDisplayName(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/** As etiquetas de um item (só quando o turno é misto: com um modelo só, seria ruído). */
export function ModelTags({ models, mixed }: { models: readonly string[] | undefined; mixed: boolean }): JSX.Element | null {
  if (!mixed || !models || models.length === 0) return null
  return (
    <>
      {models.map((id) => (
        <span key={id} className={`cm-mt cm-mt-${modelProvider(id)}`} title={`Feito por ${modelDisplayName(id)} (${id})`}>
          {shortModelName(id)}
        </span>
      ))}
    </>
  )
}

/** "feito por <modelo>" (ou a sequência), com a dica de onde vem o dado. */
export function ModelChip({ models }: { models: readonly string[] }): JSX.Element | null {
  const label = modelSequenceLabel(models)
  if (!label) return null
  return (
    <span className="cm-mchip" title="Lido da resposta da API, não do seletor de modelo">
      <Icon name="spark" />
      feito por <b>{label}</b>
    </span>
  )
}

/** "feito por X" para a dica de um item (sempre, mesmo num turno de um modelo só). */
export function madeBy(models: readonly string[] | undefined): string {
  const label = modelSequenceLabel(models ?? [])
  return label ? ` · feito por ${label.replace(/ → /g, ' e ')}` : ''
}
