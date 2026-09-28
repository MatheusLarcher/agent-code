import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTO_EFFORT, AUTO_MODEL, EFFORT_LEVELS, MODEL_EFFORT, type EffortLevel } from './ipc'
import {
  effortForModelChange,
  effortLadderFor,
  isEffortLevel,
  migrateConversationEffort,
  migratePlanningEffort,
  sdkEffort
} from './autoEffort'

const TETO_HIGH = '__teste_autoeffort_teto_high__'

beforeEach(() => {
  ;(MODEL_EFFORT as Record<string, EffortLevel[]>)[TETO_HIGH] = ['low', 'medium', 'high']
})
afterEach(() => {
  delete (MODEL_EFFORT as Record<string, EffortLevel[]>)[TETO_HIGH]
})

describe('sdkEffort — a última barreira antes do SDK', () => {
  it("o sentinel 'auto' nunca sai: vira ausência de esforço", () => {
    expect(sdkEffort('claude-opus-5-5', AUTO_EFFORT)).toBeUndefined()
    expect(sdkEffort(AUTO_MODEL, AUTO_EFFORT)).toBeUndefined()
  })

  it('texto fora da escada, vazio ou ausente também não sai', () => {
    for (const value of ['', 'turbo', undefined, null, 3]) expect(sdkEffort('claude-opus-5-5', value)).toBeUndefined()
  })

  it('degrau válido passa, recortado ao teto do modelo por clampEffortToModel', () => {
    expect(sdkEffort('claude-opus-5-5', 'max')).toBe('max')
    expect(sdkEffort(TETO_HIGH, 'max')).toBe('high')
    // Modelo sem tabela (Ollama): nada contra o que recortar.
    expect(sdkEffort('gpt-oss:120b-cloud', 'low')).toBe('low')
  })

  it('isEffortLevel só aceita os degraus', () => {
    expect(isEffortLevel('xhigh')).toBe(true)
    expect(isEffortLevel(AUTO_EFFORT)).toBe(false)
  })
})

describe('migração one-shot das conversas', () => {
  /** Um registro como o banco guarda hoje (payload jsonb da tabela de conversas),
   *  gravado antes da separação: Automático no modelo, esforço fixo que era ignorado. */
  const legado = {
    id: 'c-legado',
    title: 'Refatorar o parser',
    cwd: 'C:\\GitHub\\proj',
    model: 'auto',
    autoModel: 'claude-sonnet-5-5',
    effort: 'high',
    economyMode: false,
    loopEnabled: false,
    fastMode: false,
    sdkSessionId: 'sess-1',
    messages: [{ kind: 'user', id: 'u1', text: 'oi', ts: 1 }],
    tokens: { context: 1200, output: 300, cost: 0.01 },
    createdAt: 1758800000000,
    updatedAt: 1758800100000
  }

  it("model:'auto' sem marcador passa a effort:'auto' e ganha o marcador", () => {
    const migrado = migrateConversationEffort(legado)
    expect(migrado).toMatchObject({ model: 'auto', effort: 'auto', effortSplit: true })
    // O resto do registro fica como estava, e o modelo salvo não muda.
    expect(migrado.autoModel).toBe('claude-sonnet-5-5')
    expect(migrado.messages).toBe(legado.messages)
  })

  it('esforço ausente no registro legado também vira auto', () => {
    const { effort: _e, ...semEsforco } = legado
    expect(migrateConversationEffort(semEsforco)).toMatchObject({ effort: 'auto', effortSplit: true })
  })

  it('modelo fixo não é tocado — só ganha o marcador', () => {
    expect(migrateConversationEffort({ ...legado, model: 'claude-opus-5-5' })).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      effortSplit: true
    })
  })

  it('com o marcador, "Automático + Alto" escolhido depois NÃO volta a auto', () => {
    const escolhido = { ...legado, effort: 'high', effortSplit: true as const }
    expect(migrateConversationEffort(escolhido)).toBe(escolhido)
    // Idempotente em cadeia: migrar de novo o já migrado não muda nada.
    const uma = migrateConversationEffort(legado)
    expect(migrateConversationEffort(uma)).toBe(uma)
  })
})

describe('migração do config do Agent Manager', () => {
  it("{auto, medium} (o padrão antigo) vira {auto, auto}", () => {
    expect(migratePlanningEffort({ model: AUTO_MODEL, effort: 'medium' })).toEqual({ model: AUTO_MODEL, effort: AUTO_EFFORT })
  })

  it('devolve o MESMO objeto quando não há o que mudar', () => {
    const fixo = { model: 'claude-opus-5-5', effort: 'high' }
    expect(migratePlanningEffort(fixo)).toBe(fixo)
    const auto = { model: AUTO_MODEL, effort: AUTO_EFFORT }
    expect(migratePlanningEffort(auto)).toBe(auto)
  })
})

describe('effortLadderFor / effortForModelChange — as duas dimensões independentes', () => {
  it('modelo Automático oferece a escada inteira; fixo, a dele; sem esforço (Ollama), nenhuma', () => {
    expect(effortLadderFor(AUTO_MODEL)).toEqual(EFFORT_LEVELS)
    expect(effortLadderFor(TETO_HIGH)).toEqual(['low', 'medium', 'high'])
    expect(effortLadderFor('glm-5:cloud')).toEqual([])
    expect(effortLadderFor(undefined)).toEqual([])
  })

  it('trocar para Automático NÃO grava esforço Automático; o nível fixo continua', () => {
    expect(effortForModelChange(AUTO_MODEL, 'xhigh', 'high')).toBe('xhigh')
    expect(effortForModelChange(AUTO_MODEL, AUTO_EFFORT, 'high')).toBe(AUTO_EFFORT)
  })

  it('modelo fixo mantém o esforço Automático e recorta o fixo ao teto dele', () => {
    expect(effortForModelChange(TETO_HIGH, AUTO_EFFORT, 'high')).toBe(AUTO_EFFORT)
    expect(effortForModelChange(TETO_HIGH, 'max', 'high')).toBe('high')
    expect(effortForModelChange(TETO_HIGH, undefined, 'medium')).toBe('medium')
    expect(effortForModelChange(TETO_HIGH, 'lixo', 'medium')).toBe('medium')
  })

  it('modelo sem esforço volta ao padrão, mesmo vindo de Automático', () => {
    expect(effortForModelChange('glm-5:cloud', AUTO_EFFORT, 'high')).toBe('high')
  })
})
