import { describe, expect, it } from 'vitest'
import { AUTO_EFFORT, AUTO_MODEL, CLAUDE_MODELS, EFFORT_LEVELS, OLLAMA_MODELS, PLANNING_MODELS } from '@shared/ipc'
import {
  AUTO_EFFORT_LABEL,
  EFFORT_LABELS,
  effortLevelsFor,
  remoteEffortCatalog,
  runningEffort,
  withAutoModelOption
} from './effortOptions'

const ids = (list: { id: string }[]): string[] => list.map((m) => m.id)

describe('effortLevelsFor', () => {
  it('modelo Automático mantém o controle, com a escada inteira', () => {
    expect(effortLevelsFor(AUTO_MODEL).map((o) => o.value)).toEqual([...EFFORT_LEVELS])
  })

  it('modelo fixo usa a escada dele, rotulada em português', () => {
    expect(effortLevelsFor('claude-sonnet-5-5')).toEqual([
      { value: 'low', label: 'Baixo' },
      { value: 'medium', label: 'Médio' },
      { value: 'high', label: 'Alto' },
      { value: 'xhigh', label: 'Extra alto' },
      { value: 'max', label: 'Máximo' }
    ])
  })

  it('modelo sem esforço (Ollama) ou sem modelo: nenhum nível, o controle some', () => {
    expect(effortLevelsFor(OLLAMA_MODELS[0].id)).toEqual([])
    expect(effortLevelsFor(undefined)).toEqual([])
  })
})

describe('withAutoModelOption — seletor de modelo do chat principal', () => {
  const chat = [...CLAUDE_MODELS]

  it('com TypeSafe pronto, o Automático entra na frente', () => {
    const out = withAutoModelOption(chat, true, 'claude-sonnet-5-5')
    expect(out[0]).toEqual({ id: AUTO_MODEL, label: 'Automático' })
    expect(ids(out).slice(1)).toEqual(ids(chat))
  })

  it('sem TypeSafe, o Automático não aparece', () => {
    expect(ids(withAutoModelOption(chat, false, 'claude-sonnet-5-5'))).not.toContain(AUTO_MODEL)
  })

  it('sem TypeSafe mas com Automático gravado, ele continua visível (a escolha salva não troca)', () => {
    expect(ids(withAutoModelOption(chat, false, AUTO_MODEL))[0]).toBe(AUTO_MODEL)
  })

  it('não duplica o Automático quando a lista de entrada já o tem', () => {
    const out = withAutoModelOption([{ id: AUTO_MODEL, label: 'Automático' }, ...chat], true, AUTO_MODEL)
    expect(ids(out).filter((id) => id === AUTO_MODEL)).toHaveLength(1)
  })
})

describe('withAutoModelOption — seletor de modelo do Agent Manager', () => {
  it('PLANNING_MODELS traz o Automático, e sem TypeSafe ele sai', () => {
    expect(ids([...PLANNING_MODELS])).toContain(AUTO_MODEL)
    const out = withAutoModelOption(PLANNING_MODELS, false, 'claude-sonnet-5-5')
    expect(ids(out)).not.toContain(AUTO_MODEL)
    expect(out.length).toBe(PLANNING_MODELS.length - 1)
  })

  it('com TypeSafe, ou com o Automático já gravado no Manager, ele fica', () => {
    expect(ids(withAutoModelOption(PLANNING_MODELS, true, 'claude-sonnet-5-5'))[0]).toBe(AUTO_MODEL)
    expect(ids(withAutoModelOption(PLANNING_MODELS, false, AUTO_MODEL))[0]).toBe(AUTO_MODEL)
  })
})

describe('runningEffort', () => {
  it('só com a escolha em Automático e um nível decidido', () => {
    expect(runningEffort(AUTO_EFFORT, 'high')).toBe('high')
    expect(runningEffort(AUTO_EFFORT, undefined)).toBeUndefined()
    expect(runningEffort(AUTO_EFFORT, AUTO_EFFORT)).toBeUndefined()
    expect(runningEffort('medium', 'high')).toBeUndefined()
  })
})

describe('remoteEffortCatalog — celular', () => {
  it('com o Automático oferecido, `auto` abre cada escada e ganha rótulo', () => {
    const cat = remoteEffortCatalog(true)
    expect(cat.modelEffort[AUTO_MODEL]).toEqual([AUTO_EFFORT, ...EFFORT_LEVELS])
    expect(cat.modelEffort['claude-sonnet-5-5'][0]).toBe(AUTO_EFFORT)
    expect(cat.effortLabels[AUTO_EFFORT]).toBe(AUTO_EFFORT_LABEL)
    expect(cat.effortLabels.high).toBe(EFFORT_LABELS.high)
  })

  it('sem o Automático, nenhuma escada tem `auto`', () => {
    const cat = remoteEffortCatalog(false)
    for (const levels of Object.values(cat.modelEffort)) expect(levels).not.toContain(AUTO_EFFORT)
    expect(cat.modelEffort[AUTO_MODEL]).toEqual([...EFFORT_LEVELS])
  })

  it('modelo sem esforço (Ollama) fica fora do catálogo', () => {
    expect(remoteEffortCatalog(true).modelEffort[OLLAMA_MODELS[0].id]).toBeUndefined()
  })
})
