import { describe, expect, it } from 'vitest'
import { ConversationDigest, DIGEST_ENTRY_MAX_CHARS, DIGEST_STORE_MAX_CHARS } from './conversationDigest'

describe('ConversationDigest', () => {
  it('sai em ordem cronológica, com o rótulo de quem falou', () => {
    const digest = new ConversationDigest()
    digest.add('user', 'oi')
    digest.add('assistant', 'olá')
    digest.add('user', '   ')
    expect(digest.size).toBe(2)
    expect(digest.render(1_000)).toBe('Usuário: oi\n\nAssistente: olá')
  })

  it('no teto, ficam as mais recentes; a mais antiga que não cabe some', () => {
    const digest = new ConversationDigest()
    for (let i = 0; i < 10; i++) digest.add('user', `m${i} ${'z'.repeat(1_000)}`)
    const out = digest.render(3_500)
    expect(out.length).toBeLessThanOrEqual(3_500)
    expect(out).toContain('m9 ')
    expect(out).toContain('m7 ')
    expect(out).not.toContain('m5 ')
    expect(out.indexOf('m8 ')).toBeLessThan(out.indexOf('m9 '))
  })

  it('a primeira que não cabe entra cortada só se a sobra disser alguma coisa', () => {
    const digest = new ConversationDigest()
    digest.add('user', `antiga ${'a'.repeat(2_000)}`)
    digest.add('assistant', 'recente')
    expect(digest.render(1_000)).toMatch(/^Usuário: antiga a+…\n\nAssistente: recente$/)
    expect(digest.render(1_000).length).toBeLessThanOrEqual(1_000)
    expect(digest.render(100)).toBe('Assistente: recente')
  })

  it('mensagem gigante é guardada cortada; orçamento zero ou negativo é vazio', () => {
    const digest = new ConversationDigest()
    digest.add('assistant', 'b'.repeat(DIGEST_ENTRY_MAX_CHARS * 2))
    expect(digest.render(1_000_000).length).toBeLessThanOrEqual(DIGEST_ENTRY_MAX_CHARS + 'Assistente: '.length)
    expect(digest.render(0)).toBe('')
    expect(digest.render(-5)).toBe('')
  })

  it('prepend põe a conversa retomada antes da atual', () => {
    const digest = new ConversationDigest()
    digest.add('user', 'novo')
    digest.prepend([{ role: 'user', text: 'antigo' }, { role: 'assistant', text: '  ' }, { role: 'assistant', text: 'resposta' }])
    expect(digest.size).toBe(3)
    expect(digest.render(1_000)).toBe('Usuário: antigo\n\nAssistente: resposta\n\nUsuário: novo')
  })

  it('prepend não repete o que a gravação já trouxe deste processo', () => {
    const digest = new ConversationDigest()
    digest.add('user', 'novo')
    digest.add('assistant', 'feito')
    digest.prepend([{ role: 'user', text: 'antigo' }, { role: 'user', text: 'novo' }, { role: 'assistant', text: 'feito' }])
    expect(digest.render(1_000)).toBe('Usuário: antigo\n\nUsuário: novo\n\nAssistente: feito')
    const partial = new ConversationDigest()
    partial.add('user', 'novo')
    partial.add('assistant', 'feito')
    partial.prepend([{ role: 'user', text: 'antigo' }, { role: 'user', text: 'novo' }])
    expect(partial.render(1_000)).toBe('Usuário: antigo\n\nUsuário: novo\n\nAssistente: feito')
  })

  it('prepend respeita os tetos: a semente gigante perde as mais antigas', () => {
    const digest = new ConversationDigest()
    digest.add('user', 'atual')
    const seed = Array.from({ length: 80 }, (_, i) => ({ role: 'assistant' as const, text: `s${i} ${'x'.repeat(DIGEST_ENTRY_MAX_CHARS * 2)}` }))
    digest.prepend(seed)
    expect(digest.render(DIGEST_ENTRY_MAX_CHARS * 2)).toContain('Usuário: atual')
    expect(digest.size).toBeLessThan(81)
    expect(digest.render(10_000_000).length).toBeLessThanOrEqual(DIGEST_STORE_MAX_CHARS + digest.size * 14)
  })

  it('reset esvazia', () => {
    const digest = new ConversationDigest()
    digest.add('user', 'oi')
    digest.reset()
    expect(digest.size).toBe(0)
    expect(digest.render(1_000)).toBe('')
  })
})
