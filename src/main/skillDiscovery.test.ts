import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkillCatalogSnapshot,
  discoverSkills,
  parseSkillFrontmatter,
  renderAgentSkillCatalog,
  skillCatalogFilesystemVersion
} from './skillDiscovery'

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

  it('usa a mesma precedência da UI e injeta todas as descrições, mas não o corpo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-project-'))
    const home = await mkdtemp(join(tmpdir(), 'skills-home-'))
    const cache = await mkdtemp(join(tmpdir(), 'skills-cache-'))
    await skill(join(project, '.claude', 'skills'), 'native', 'duplicada', 'projeto nativo')
    await skill(join(project, '.agents', 'skills'), 'adapted', 'adaptada', 'somente agents')
    await skill(join(project, '.agents', 'skills'), 'loser', 'duplicada', 'não deve vencer')
    await skill(cache, 'bundled', 'planejar', 'skill do Agent Code')
    await skill(join(home, '.claude', 'skills'), 'global', 'global', 'usuário')

    const found = discoverSkills(project, home, cache)
    expect(found.map(({ name }) => name)).toEqual(['adaptada', 'duplicada', 'global', 'planejar'])
    expect(found.find(({ name }) => name === 'duplicada')?.source).toBe('project-claude')

    const catalog = renderAgentSkillCatalog(found)
    expect(catalog).toContain('/adaptada')
    expect(catalog).toContain('/duplicada')
    expect(catalog).toContain('Description: projeto nativo')
    expect(catalog).toContain('/global')
    expect(catalog).toContain('/planejar')
    expect(catalog).toContain('SKILL.md:')
    expect(catalog).not.toContain('BODY_SENTINEL')
  })

  it('lê somente o prefixo de SKILL.md grande sem descartar seu frontmatter', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-large-'))
    const root = join(project, '.agents', 'skills', 'large')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'SKILL.md'),
      `---\nname: large-skill\ndescription: descrição que precisa chegar ao modelo\n---\n\n${'x'.repeat(80 * 1024)}`,
      'utf8'
    )

    const found = discoverSkills(project, join(project, 'home'), join(project, 'no-cache'))
    expect(found).toEqual([
      expect.objectContaining({
        name: 'large-skill',
        description: 'descrição que precisa chegar ao modelo',
        sizeBytes: expect.any(Number),
        modifiedAtMs: expect.any(Number)
      })
    ])
  })

  it('versiona adição, alteração e remoção pelo estado atual das skills', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-version-'))
    const root = join(project, '.agents', 'skills')
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    await skill(root, 'one', 'one', 'primeira descrição')
    const firstFilesystemVersion = skillCatalogFilesystemVersion(project, home, cache)
    const first = createSkillCatalogSnapshot(discoverSkills(project, home, cache))

    await skill(root, 'one', 'one', 'descrição atualizada e maior')
    const changedFilesystemVersion = skillCatalogFilesystemVersion(project, home, cache)
    const changed = createSkillCatalogSnapshot(discoverSkills(project, home, cache))
    await skill(root, 'two', 'two', 'segunda skill')
    const added = createSkillCatalogSnapshot(discoverSkills(project, home, cache))
    await rm(join(root, 'one'), { recursive: true })
    const removed = createSkillCatalogSnapshot(discoverSkills(project, home, cache))

    expect(changed.version).not.toBe(first.version)
    expect(changedFilesystemVersion).not.toBe(firstFilesystemVersion)
    expect(added.version).not.toBe(changed.version)
    expect(removed.version).not.toBe(added.version)
    expect(added.catalog).toContain('Description: descrição atualizada e maior')
    expect(added.catalog).toContain('Description: segunda skill')
    expect(removed.catalog).not.toContain('/one')
  })

  it('mantém as skills do app quando a conversa abre outro projeto', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-other-project-'))
    const home = await mkdtemp(join(tmpdir(), 'skills-empty-home-'))
    const cache = await mkdtemp(join(tmpdir(), 'skills-agent-code-'))
    await skill(cache, 'review', 'code-review', 'revisar o diff')

    const found = discoverSkills(project, home, cache)
    expect(found).toEqual([
      expect.objectContaining({ name: 'code-review', source: 'cache', root: cache })
    ])
  })

  it('pasta ausente, skill malformada e raiz relativa não quebram', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-empty-'))
    await mkdir(join(project, '.agents', 'skills', 'bad'), { recursive: true })
    await writeFile(join(project, '.agents', 'skills', 'bad', 'SKILL.md'), 'sem frontmatter', 'utf8')
    expect(discoverSkills(project, join(project, 'home'), join(project, 'no-cache'))).toEqual([])
    expect(discoverSkills('relativo', join(project, 'home'), join(project, 'no-cache'))).toEqual([])
  })
})
