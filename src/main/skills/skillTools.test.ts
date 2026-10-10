import { describe, expect, it } from 'vitest'
import type { TieredSkill } from './skillTiers'
import { searchSkills, listSkillsByCategory } from './skillTools'

const t = (name: string, description: string, category: TieredSkill['category'], tier: TieredSkill['tier'] = 'low'): TieredSkill => ({
  name,
  description,
  skillFile: `C:/skills/${name}/SKILL.md`,
  tier,
  category
})

const SKILLS: TieredSkill[] = [
  t('click-path-audit', 'Trace every user-facing button through its state changes to find bugs where the UI ends inconsistent.', 'Depuração'),
  t('react-testing', 'React component testing with React Testing Library, Vitest/Jest and MSW.', 'Testes e qualidade'),
  t('django-patterns', 'Django architecture patterns, REST API design with DRF, ORM best practices.', 'Python'),
  t('brag', 'Turn the project into a launch video.', 'Vídeo e mídia', 'medium')
]

describe('skills_buscar', () => {
  it('acha pelo nome e pela descrição, sem diferenciar maiúsculas e acentos, com resumo e caminho', () => {
    const hits = searchSkills(SKILLS, 'botão button')
    expect(hits[0].name).toBe('click-path-audit')
    expect(hits[0].skillFile).toBe('C:/skills/click-path-audit/SKILL.md')
    expect(searchSkills(SKILLS, 'DJANGO')[0].name).toBe('django-patterns')
    expect(searchSkills(SKILLS, 'testing library').map((h) => h.name)).toContain('react-testing')
  })

  it('pedido em português acha descrição em inglês (visto no app: "botão não faz nada" voltava vazio)', () => {
    expect(searchSkills(SKILLS, 'botão não faz nada')[0]?.name).toBe('click-path-audit')
    expect(searchSkills(SKILLS, 'teste de componente react')[0]?.name).toBe('react-testing')
    expect(searchSkills(SKILLS, 'vídeo de lançamento').map((h) => h.name)).toContain('brag')
  })

  it('texto vazio ou sem nada: lista vazia', () => {
    expect(searchSkills(SKILLS, '  ')).toEqual([])
    expect(searchSkills(SKILLS, 'kubernetes')).toEqual([])
  })
})

describe('skills_listar', () => {
  it('sem categoria: as categorias com a contagem; com categoria (sem acento também): as skills dela', () => {
    expect(listSkillsByCategory(SKILLS)).toMatchObject({ kind: 'categories' })
    const python = listSkillsByCategory(SKILLS, 'python')
    expect(python).toMatchObject({ kind: 'skills', category: 'Python' })
    expect(python.kind === 'skills' && python.skills.map((s) => s.name)).toEqual(['django-patterns'])
    const depuracao = listSkillsByCategory(SKILLS, 'depuracao')
    expect(depuracao.kind === 'skills' && depuracao.skills.map((s) => s.name)).toEqual(['click-path-audit'])
  })

  it('categoria inexistente: avisa e mostra as válidas', () => {
    expect(listSkillsByCategory(SKILLS, 'Culinária')).toMatchObject({ kind: 'unknown' })
  })
})
