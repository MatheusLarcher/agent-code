import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills, parseSkillFrontmatter, renderAgentSkillCatalog } from './skillDiscovery'

async function skill(root: string, folder: string, name: string, description: string): Promise<void> {
  const dir = join(root, folder)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBODY_SENTINEL`, 'utf8')
}

describe('skillDiscovery', () => {
  it('entende descrição inline e em bloco e rejeita nome perigoso', () => {
    expect(parseSkillFrontmatter('---\nname: ok\ndescription: >-\n  primeira\n  segunda\n---')).toEqual({
      name: 'ok',
      description: 'primeira segunda'
    })
    expect(parseSkillFrontmatter('---\nname: ../fora\ndescription: não\n---')).toBeNull()
  })

  it('usa a mesma precedência da UI e não injeta o corpo no catálogo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-project-'))
    const home = await mkdtemp(join(tmpdir(), 'skills-home-'))
    const app = await mkdtemp(join(tmpdir(), 'skills-app-'))
    await skill(join(project, '.claude', 'skills'), 'native', 'duplicada', 'projeto nativo')
    await skill(join(project, '.agents', 'skills'), 'adapted', 'adaptada', 'somente agents')
    await skill(join(project, '.agents', 'skills'), 'loser', 'duplicada', 'não deve vencer')
    await skill(join(app, '.agents', 'skills'), 'bundled', 'planejar', 'skill do Agent Code')
    await skill(join(home, '.claude', 'skills'), 'global', 'global', 'usuário')

    const found = discoverSkills(project, home, app)
    expect(found.map(({ name }) => name)).toEqual(['adaptada', 'duplicada', 'global', 'planejar'])
    expect(found.find(({ name }) => name === 'duplicada')?.source).toBe('project-claude')

    const catalog = renderAgentSkillCatalog(found)
    expect(catalog).toContain('/adaptada')
    expect(catalog).toContain('SKILL.md:')
    expect(catalog).not.toContain('BODY_SENTINEL')
    expect(catalog).not.toContain('/duplicada')
  })

  it('mantém as skills do app quando a conversa abre outro projeto', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-other-project-'))
    const home = await mkdtemp(join(tmpdir(), 'skills-empty-home-'))
    const app = await mkdtemp(join(tmpdir(), 'skills-agent-code-'))
    await skill(join(app, '.agents', 'skills'), 'review', 'code-review', 'revisar o diff')

    const found = discoverSkills(project, home, app)
    expect(found).toEqual([
      expect.objectContaining({ name: 'code-review', source: 'app-agents', root: join(app, '.agents', 'skills') })
    ])
  })

  it('pasta ausente, skill malformada e raiz relativa não quebram', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-empty-'))
    await mkdir(join(project, '.agents', 'skills', 'bad'), { recursive: true })
    await writeFile(join(project, '.agents', 'skills', 'bad', 'SKILL.md'), 'sem frontmatter', 'utf8')
    expect(discoverSkills(project, join(project, 'home'), join(project, 'no-app'))).toEqual([])
    expect(discoverSkills('relativo', join(project, 'home'), join(project, 'no-app'))).toEqual([])
  })
})
