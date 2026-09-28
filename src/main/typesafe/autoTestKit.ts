/**
 * Peças compartilhadas pelos testes do Automático (execution*.test.ts,
 * autoDecision.test.ts). Só dados — o duplo de `./client` fica em cada arquivo
 * de teste, porque `vi.mock` é içado por arquivo.
 */
import type { AutoSources } from './autoDecision'

/** Uma resposta de `choice` como o serviço a devolve. */
export function choiceAnswer(model: string, confidence = 0.7): unknown {
  return { type: 'choice', choice: model, confidence, probabilities: { [model]: confidence } }
}

/** Uma resposta de `score`: o número pode cair ENTRE dois degraus. */
export function scoreAnswer(value: number, confidence = 0.6): unknown {
  return { type: 'score', score: value, confidence, legend: {}, probabilities: {} }
}

/** Nenhum modelo real do catálogo atual tem teto de esforço abaixo de `max` —
 *  este id sintético existe só para exercitar o recorte de `clampEffortToModel`
 *  sem prender os testes a um modelo real que pode mudar de teto. */
export const MODELO_TETO_HIGH = '__teste_teto_high__'

/** Um modelo fixo sem escada de esforço (como os do Ollama). */
export const MODELO_SEM_ESFORCO = 'gpt-oss:120b-cloud'

export const BOTH_TYPESAFE: AutoSources = { model: 'typesafe', effort: 'typesafe' }
export const BOTH_FALLBACK: AutoSources = { model: 'fallback', effort: 'fallback' }
export const BOTH_UNPROMPTED: AutoSources = { model: 'unprompted', effort: 'unprompted' }

/** O par vivo como a conversa o guarda, com as duas dimensões decididas. */
export const DECIDED_BOTH = { model: true, effort: true }
