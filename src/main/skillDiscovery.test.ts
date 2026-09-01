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
import { exposeCacheSkills } from './skillManager'

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

  it('cataloga somente raízes nativas com precedência do projeto e sem incluir o corpo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-project-'))
    const home = await mkdtemp(join(tmpdir(), 'skills-home-'))
    const cache = await mkdtemp(join(tmpdir(), 'skills-cache-'))
    await skill(join(project, '.claude', 'skills'), 'duplicada', 'duplicada', 'projeto nativo')
    await skill(join(project, '.agents', 'skills'), 'adaptada', 'adaptada', 'não é raiz nativa')
    await skill(cache, 'planejar', 'planejar', 'skill do Agent Code')
    await skill(join(home, '.claude', 'skills'), 'duplicada', 'duplicada', 'não deve vencer')
    await skill(join(home, '.claude', 'skills'), 'global', 'global', 'usuário')
    expect(exposeCacheSkills(cache, home).errors).toEqual([])

    const found = discoverSkills(project, home)
    expect(found.map(({ name }) => name)).toEqual(['duplicada', 'global', 'planejar'])
    expect(found.find(({ name }) => name === 'duplicada')?.source).toBe('project-claude')
    expect(found.find(({ name }) => name === 'planejar')?.source).toBe('user-claude')

    const catalog = renderAgentSkillCatalog(found)
    expect(catalog).not.toContain('/adaptada')
    expect(catalog).toContain('/duplicada')
    expect(catalog).toContain('Description: projeto nativo')
    expect(catalog).toContain('/global')
    expect(catalog).toContain('/planejar')
    expect(catalog).toContain('SKILL.md:')
    expect(catalog).not.toContain('BODY_SENTINEL')
  })

  it('lê somente o prefixo de SKILL.md grande sem descartar seu frontmatter', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-large-'))
    const root = join(project, '.claude', 'skills', 'large-skill')
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'SKILL.md'),
      `---\nname: large-skill\ndescription: descrição que precisa chegar ao modelo\n---\n\n${'x'.repeat(80 * 1024)}`,
      'utf8'
    )

    const found = discoverSkills(project, join(project, 'home'))
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
    const root = join(project, '.claude', 'skills')
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    await skill(root, 'one', 'one', 'primeira descrição')
    const firstFilesystemVersion = skillCatalogFilesystemVersion(project, home)
    const first = createSkillCatalogSnapshot(discoverSkills(project, home))

    await skill(root, 'one', 'one', 'descrição atualizada e maior')
    const changedFilesystemVersion = skillCatalogFilesystemVersion(project, home)
    const changed = createSkillCatalogSnapshot(discoverSkills(project, home))
    await skill(root, 'two', 'two', 'segunda skill')
    const added = createSkillCatalogSnapshot(discoverSkills(project, home))
    await rm(join(root, 'one'), { recursive: true })
    const removed = createSkillCatalogSnapshot(discoverSkills(project, home))

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
    await skill(cache, 'code-review', 'code-review', 'revisar o diff')
    expect(exposeCacheSkills(cache, home).errors).toEqual([])

    const found = discoverSkills(project, home)
    expect(found).toEqual([
      expect.objectContaining({ name: 'code-review', source: 'user-claude', root: join(home, '.claude', 'skills') })
    ])
  })

  it('não anuncia skill cujo diretório diverge do nome nativo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-name-mismatch-'))
    await skill(join(project, '.claude', 'skills'), 'diretorio', 'outro-nome', 'inválida para o SDK')
    expect(discoverSkills(project, join(project, 'home'))).toEqual([])
  })

  it('pasta ausente, skill malformada e raiz relativa não quebram', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-empty-'))
    await mkdir(join(project, '.claude', 'skills', 'bad'), { recursive: true })
    await writeFile(join(project, '.claude', 'skills', 'bad', 'SKILL.md'), 'sem frontmatter', 'utf8')
    expect(discoverSkills(project, join(project, 'home'))).toEqual([])
    expect(discoverSkills('relativo', join(project, 'home'))).toEqual([])
  })
})
