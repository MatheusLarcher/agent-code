import { describe, expect, it } from 'vitest'
import { enterSendsTyped, matchSlashEntries } from './slashMenu'

const skills = [
  { name: 'hook-development', description: 'Hooks: PreToolUse, PostToolUse, PreCompact e afins' },
  { name: 'brag', description: 'Vídeo de lançamento' },
  { name: 'compact', description: 'skill do usuário com nome de comando do CLI' }
]

describe('menu "/" da caixa de texto', () => {
  it('"/compact" traz o comando do CLI em primeiro, não a skill que cita PreCompact na descrição', () => {
    const hits = matchSlashEntries(skills, 'compact')
    expect(hits.map((h) => h.name)).toEqual(['compact', 'hook-development'])
    expect(hits[0].description).toMatch(/Compacta a conversa/)
  })

  it('prefixo do nome vem antes de quem só casa pela descrição', () => {
    expect(matchSlashEntries(skills, 'com').map((h) => h.name)).toEqual(['compact', 'hook-development'])
  })

  it('sem texto lista tudo em ordem alfabética', () => {
    expect(matchSlashEntries(skills, '').map((h) => h.name)).toEqual(['brag', 'compact', 'hook-development'])
  })

  it('Enter envia só quando o nome destacado é exatamente o digitado', () => {
    expect(enterSendsTyped('compact', 'compact')).toBe(true)
    expect(enterSendsTyped('compact', 'comp')).toBe(false)
    expect(enterSendsTyped('hook-development', 'compact')).toBe(false)
    expect(enterSendsTyped(undefined, 'compact')).toBe(false)
  })
})
