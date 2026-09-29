import { describe, it, expect } from 'vitest'
import { findBlankConversation, isBlankConversation } from './blankConversation'
import { DEFAULT_TITLE, type Conversation } from './types'

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: DEFAULT_TITLE,
    cwd: '/proj',
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

describe('isBlankConversation', () => {
  it('recém-criada (título padrão, sem mensagem nem rascunho) é vazia', () => {
    expect(isBlankConversation(conv())).toBe(true)
  })

  it('rascunho só com espaços continua vazia', () => {
    expect(isBlankConversation(conv({ draft: '  \n\t ' }))).toBe(true)
  })

  it('qualquer mensagem tira de vazia', () => {
    expect(isBlankConversation(conv({ messages: [{ id: 'u1', kind: 'user', text: 'oi' }] }))).toBe(false)
  })

  it('título que não é o padrão (renomeada, handoff, MCP) não é vazia', () => {
    expect(isBlankConversation(conv({ title: 'Implementação: checkout' }))).toBe(false)
  })

  it('rascunho com texto não é vazia', () => {
    expect(isBlankConversation(conv({ draft: 'meio digitado' }))).toBe(false)
  })

  it('rascunho só com anexo não é vazia', () => {
    const draftMedia = [{ kind: 'image' as const, name: 'a.png', mediaType: 'image/png', path: '/tmp/a.png', size: 1 }]
    expect(isBlankConversation(conv({ draftMedia }))).toBe(false)
  })

  it('planejamento não é vazia, nem com o título padrão', () => {
    expect(isBlankConversation(conv({ mode: 'planning', planningSlug: 'checkout' }))).toBe(false)
  })
})

describe('findBlankConversation', () => {
  const cheia = conv({ id: 'cheia', messages: [{ id: 'u1', kind: 'user', text: 'oi' }] })
  const outraPasta = conv({ id: 'outra', cwd: '/outro' })
  const a = conv({ id: 'a' })
  const b = conv({ id: 'b' })

  it('só olha a pasta pedida', () => {
    expect(findBlankConversation([outraPasta, cheia], '/proj')).toBeUndefined()
    expect(findBlankConversation([outraPasta, cheia], '/outro')?.id).toBe('outra')
  })

  it('prefere a indicada (a ativa) quando ela é uma das vazias', () => {
    expect(findBlankConversation([a, b], '/proj', 'b')?.id).toBe('b')
  })

  it('preferida ausente, cheia ou de outra pasta: a primeira vazia da lista', () => {
    expect(findBlankConversation([a, b], '/proj')?.id).toBe('a')
    expect(findBlankConversation([cheia, a, b], '/proj', 'cheia')?.id).toBe('a')
    expect(findBlankConversation([outraPasta, a, b], '/proj', 'outra')?.id).toBe('a')
    expect(findBlankConversation([a, b], '/proj', null)?.id).toBe('a')
  })

  it('nenhuma vazia → undefined', () => {
    expect(findBlankConversation([], '/proj')).toBeUndefined()
    expect(findBlankConversation([cheia], '/proj', 'cheia')).toBeUndefined()
  })
})
