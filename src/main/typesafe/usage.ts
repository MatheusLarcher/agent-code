import { readPersistedKv, writePersistedKv } from '../persistence/kvFacade'
import type { Usage } from '@typesafe-ai/sdk'

/** Onde o contador mora. Registrado em `keyRegistry`/`inventory` como toda chave
 *  persistida — sem isso, `persistedKeyDefinition` lança na primeira gravação. */
export const TYPESAFE_USAGE_KEY = 'agentcode.typesafe.usage.v1'

/** Quanto o TypeSafe já custou nesta instalação. Saída é grátis no serviço, mas
 *  entra no contador para dar a conta completa de uma chamada. */
export interface TypeSafeUsage {
  inputTokens: number
  outputTokens: number
  calls: number
}

const ZERO: TypeSafeUsage = { inputTokens: 0, outputTokens: 0, calls: 0 }

/** Uma gravação por vez: sem isto, duas decisões concorrentes leem o mesmo
 *  total e a segunda escrita apaga a primeira. */
let queue: Promise<unknown> = Promise.resolve()

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function parse(raw: string | null): TypeSafeUsage {
  if (!raw) return { ...ZERO }
  try {
    const parsed = JSON.parse(raw) as Partial<TypeSafeUsage> | null
    if (!parsed || typeof parsed !== 'object') return { ...ZERO }
    return {
      inputTokens: count(parsed.inputTokens),
      outputTokens: count(parsed.outputTokens),
      calls: count(parsed.calls)
    }
  } catch {
    // Contador corrompido não é motivo para derrubar nada: recomeça do zero.
    return { ...ZERO }
  }
}

/**
 * O total acumulado. Zeros quando nunca houve chamada, quando o storage está
 * offline ou quando o valor gravado não é legível — este número é informativo,
 * e uma tela de configurações não pode quebrar por causa dele.
 */
export async function typeSafeUsage(): Promise<TypeSafeUsage> {
  try {
    return parse(await readPersistedKv(TYPESAFE_USAGE_KEY))
  } catch {
    return { ...ZERO }
  }
}

/**
 * Soma uma chamada ao contador. Best-effort de propósito: a decisão já foi
 * tomada e devolvida quando isto roda, então uma falha de gravação (storage
 * offline, PostgreSQL fora do ar) só pode custar a contabilidade — nunca a
 * decisão. Nunca rejeita.
 */
export function recordTypeSafeUsage(delta: Usage): Promise<void> {
  const write = async (): Promise<void> => {
    try {
      const current = parse(await readPersistedKv(TYPESAFE_USAGE_KEY))
      const next: TypeSafeUsage = {
        inputTokens: current.inputTokens + count(delta?.input_tokens),
        outputTokens: current.outputTokens + count(delta?.output_tokens),
        calls: current.calls + 1
      }
      await writePersistedKv(TYPESAFE_USAGE_KEY, JSON.stringify(next))
    } catch (error) {
      console.error(`[typesafe] contador de uso não gravado: ${(error as Error)?.message ?? error}`)
    }
  }
  const pending = queue.then(write, write)
  queue = pending
  return pending
}

/** Espera as gravações pendentes. Quem decide não chama isto (o ponto do
 *  contador é não estar no caminho); serve a teste e a encerramento. */
export function flushTypeSafeUsage(): Promise<void> {
  return queue.then(
    () => undefined,
    () => undefined
  )
}
