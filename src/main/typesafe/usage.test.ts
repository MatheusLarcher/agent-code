// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
const readPersistedKv = vi.fn(async (key: string) => store.get(key) ?? null)
const writePersistedKv = vi.fn(async (key: string, value: string) => {
  store.set(key, value)
})
vi.mock('../persistence/kvFacade', () => ({ readPersistedKv, writePersistedKv }))

const { flushTypeSafeUsage, recordTypeSafeUsage, typeSafeUsage, TYPESAFE_USAGE_KEY } = await import('./usage')

beforeEach(() => {
  store.clear()
  // `mockReset` e não `mockClear`: um caso que força rejeição continuaria
  // valendo no caso seguinte e mascararia o comportamento testado lá.
  readPersistedKv.mockReset()
  writePersistedKv.mockReset()
  readPersistedKv.mockImplementation(async (key: string) => store.get(key) ?? null)
  writePersistedKv.mockImplementation(async (key: string, value: string) => {
    store.set(key, value)
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('contador de uso do TypeSafe', () => {
  it('começa zerado', async () => {
    expect(await typeSafeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 })
  })

  it('acumula tokens e chamadas, inclusive concorrentes', async () => {
    await Promise.all([
      recordTypeSafeUsage({ input_tokens: 10, output_tokens: 1 }),
      recordTypeSafeUsage({ input_tokens: 5, output_tokens: 2 })
    ])
    await flushTypeSafeUsage()

    // Serializado: a segunda gravação soma sobre a primeira em vez de apagá-la.
    expect(await typeSafeUsage()).toEqual({ inputTokens: 15, outputTokens: 3, calls: 2 })
    expect(store.get(TYPESAFE_USAGE_KEY)).toBeTruthy()
  })

  it('não derruba a decisão quando a gravação falha', async () => {
    writePersistedKv.mockRejectedValue(new Error('Storage autoritativo offline.'))

    await expect(recordTypeSafeUsage({ input_tokens: 7, output_tokens: 0 })).resolves.toBeUndefined()
  })

  it('não derruba a leitura quando o storage está fora', async () => {
    readPersistedKv.mockRejectedValue(new Error('Storage autoritativo offline.'))

    expect(await typeSafeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 })
  })

  it('recomeça do zero em cima de um contador corrompido', async () => {
    store.set(TYPESAFE_USAGE_KEY, '{não é json')

    expect(await typeSafeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 })

    await recordTypeSafeUsage({ input_tokens: 3, output_tokens: 0 })
    await flushTypeSafeUsage()
    expect(await typeSafeUsage()).toEqual({ inputTokens: 3, outputTokens: 0, calls: 1 })
  })

  it('ignora número inválido gravado no lugar do total', async () => {
    store.set(TYPESAFE_USAGE_KEY, JSON.stringify({ inputTokens: -5, outputTokens: 'muitos', calls: null }))

    expect(await typeSafeUsage()).toEqual({ inputTokens: 0, outputTokens: 0, calls: 0 })
  })
})
