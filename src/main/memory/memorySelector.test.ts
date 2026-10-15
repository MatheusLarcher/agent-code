import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  selector: 'haiku' as unknown,
  typeSafeActive: true,
  configThrows: false
}))

vi.mock('../config', () => ({
  loadConfig: () => {
    if (state.configThrows) throw new Error('config ilegível')
    return { memorySelector: state.selector }
  }
}))
vi.mock('../typesafe', () => ({
  typeSafeMemorySelectionActive: async () => state.typeSafeActive
}))
vi.mock('../memorySelectionHaiku', () => ({
  selectMemoriesWithHaiku: vi.fn()
}))

import { memorySelectorUsesTypeSafe, subagentMemoryInput } from './memorySelector'

beforeEach(() => {
  state.selector = 'haiku'
  state.typeSafeActive = true
  state.configThrows = false
})

describe('memorySelectorUsesTypeSafe', () => {
  it('padrão "haiku": o Haiku escolhe, mesmo com o TypeSafe no ar', async () => {
    expect(await memorySelectorUsesTypeSafe()).toBe(false)
  })

  it('"typesafe" escolhido e no ar: TypeSafe', async () => {
    state.selector = 'typesafe'
    expect(await memorySelectorUsesTypeSafe()).toBe(true)
  })

  it('"typesafe" escolhido mas fora do ar: cai no Haiku', async () => {
    state.selector = 'typesafe'
    state.typeSafeActive = false
    expect(await memorySelectorUsesTypeSafe()).toBe(false)
  })

  it('valor estranho ou config que lança: Haiku', async () => {
    state.selector = 'qualquer'
    expect(await memorySelectorUsesTypeSafe()).toBe(false)
    state.selector = 'typesafe'
    state.configThrows = true
    expect(await memorySelectorUsesTypeSafe()).toBe(false)
  })
})

describe('subagentMemoryInput', () => {
  const haiku = async () => false

  it('põe o bloco escolhido no começo do prompt e preserva os outros campos', async () => {
    const select = vi.fn(async () => ({ block: '--- Memória relevante: a.md ---\nA', relPaths: ['a.md'], entries: [] }))
    const conversation = (max: number) => `conversa ${max}`
    const out = await subagentMemoryInput(
      { description: 'Auditar', prompt: 'Confira.', subagent_type: 'Explore' },
      { dir: '/mem', conversation, usesTypeSafe: haiku, select }
    )
    expect(out).toEqual({ description: 'Auditar', subagent_type: 'Explore', prompt: '--- Memória relevante: a.md ---\nA\n\nConfira.' })
    expect(select).toHaveBeenCalledWith('/mem', 'Auditar\n\nConfira.', { subject: 'subagent', conversation })
  })

  it('sem descrição, a tarefa é só o prompt', async () => {
    const select = vi.fn(async () => ({ block: 'B', relPaths: ['b.md'], entries: [] }))
    await subagentMemoryInput({ prompt: 'Faça.' }, { dir: '/mem', usesTypeSafe: haiku, select })
    expect(select).toHaveBeenCalledWith('/mem', 'Faça.', { subject: 'subagent' })
  })

  it('não mexe no input: TypeSafe, prompt ausente, nada escolhido, null ou falha', async () => {
    const select = vi.fn(async () => ({ block: 'B', relPaths: ['b.md'], entries: [] }))
    expect(await subagentMemoryInput({ prompt: 'x' }, { dir: '/m', usesTypeSafe: async () => true, select })).toBeNull()
    expect(await subagentMemoryInput({ description: 'só isso' }, { dir: '/m', usesTypeSafe: haiku, select })).toBeNull()
    expect(await subagentMemoryInput('texto', { dir: '/m', usesTypeSafe: haiku, select })).toBeNull()
    expect(select).not.toHaveBeenCalled()

    const empty = vi.fn(async () => ({ block: '  ', relPaths: [], entries: [] }))
    expect(await subagentMemoryInput({ prompt: 'x' }, { dir: '/m', usesTypeSafe: haiku, select: empty })).toBeNull()
    const none = vi.fn(async () => null)
    expect(await subagentMemoryInput({ prompt: 'x' }, { dir: '/m', usesTypeSafe: haiku, select: none })).toBeNull()

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = vi.fn(async () => {
      throw new Error('tempo esgotado')
    })
    expect(await subagentMemoryInput({ prompt: 'x' }, { dir: '/m', usesTypeSafe: haiku, select: boom })).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
