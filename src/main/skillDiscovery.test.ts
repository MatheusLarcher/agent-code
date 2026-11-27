import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkillCatalogSnapshot,
  discoverSkills,
  parseSkillFrontmatter,
  renderAgentSkillCatalog,
  renderSkillCatalogChange,
  renderSkillCatalogUpdate,
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

    // O catálogo do app é só a regra: nome e descrição já vão na listagem do SDK.
    const catalog = renderAgentSkillCatalog(found)
    expect(catalog).toContain('FILESYSTEM SKILLS: 3 skills')
    expect(catalog).toContain('Skill tool')
    for (const repeated of ['/duplicada', '/global', '/planejar', 'projeto nativo', 'SKILL.md', 'BODY_SENTINEL']) {
      expect(catalog).not.toContain(repeated)
    }
    expect(catalog.length).toBeLessThan(500)
  })

  it('catálogo vazio avisa que não há skills', () => {
    expect(renderAgentSkillCatalog([])).toContain('no filesystem skills are currently available')
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
    // A listagem do SDK só anuncia nome novo: descrição mudada e remoção vão no delta.
    const delta = renderSkillCatalogChange(first.skills, added.skills)
    expect(delta).toContain('/one\n  Description: descrição atualizada e maior')
    expect(delta).toContain('/two\n  Description: segunda skill')
    expect(delta).not.toContain('Removed')
    const gone = renderSkillCatalogChange(added.skills, removed.skills)
    expect(gone).toContain('Removed (no longer available): one')
    expect(gone).not.toContain('/two')
    expect(renderSkillCatalogChange(added.skills, [])).toContain('no filesystem skills are currently available')

    const update = renderSkillCatalogUpdate(removed, { skills: added.skills, announced: true })
    expect(update.startsWith('[SKILL_CATALOG_UPDATE]')).toBe(true)
    expect(update).toContain('Removed (no longer available): one')
    expect(update).not.toContain(removed.catalog)
    expect(renderSkillCatalogUpdate(first)).toContain(first.catalog)

    // Primeiro anúncio da conversa: a regra, mais só o que mudou desde a lista do SDK na subida.
    const firstSend = renderSkillCatalogUpdate(changed, { skills: first.skills, announced: false })
    expect(firstSend).toContain(changed.catalog)
    expect(firstSend).toContain('/one\n  Description: descrição atualizada e maior')
    const unchanged = renderSkillCatalogUpdate(first, { skills: first.skills, announced: false })
    expect(unchanged).toContain(first.catalog)
    expect(unchanged).not.toContain('Description:')
  })

  it('mantém as skills do app quando a conversa abre outro projeto', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-other-project-'))
    // realpath: no macOS o tmpdir passa pelo symlink /var → /private/var.
    const home = await realpath(await mkdtemp(join(tmpdir(), 'skills-empty-home-')))
    const cache = await mkdtemp(join(tmpdir(), 'skills-agent-code-'))
    await skill(cache, 'code-review', 'code-review', 'revisar o diff')
    expect(exposeCacheSkills(cache, home).errors).toEqual([])

    const found = discoverSkills(project, home)
    expect(found).toEqual([
      expect.objectContaining({ name: 'code-review', source: 'user-claude', root: join(home, '.claude', 'skills') })
    ])
  })

  it('identifica a skill pela pasta, mesmo com nome de exibição no frontmatter', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-name-mismatch-'))
    await skill(join(project, '.claude', 'skills'), 'web-security', 'Web Application Security Testing', 'OWASP')
    await mkdir(join(project, '.claude', 'skills', 'vazia'), { recursive: true })
    await writeFile(join(project, '.claude', 'skills', 'vazia', 'SKILL.md'), '', 'utf8')
    expect(discoverSkills(project, join(project, 'home')).map(({ name, description }) => ({ name, description }))).toEqual([
      { name: 'vazia', description: '' },
      { name: 'web-security', description: 'OWASP' }
    ])
  })

  it('pasta ausente, skill malformada e raiz relativa não quebram', async () => {
    const project = await mkdtemp(join(tmpdir(), 'skills-empty-'))
    await mkdir(join(project, '.claude', 'skills', 'bad'), { recursive: true })
    await writeFile(join(project, '.claude', 'skills', 'bad', 'SKILL.md'), 'sem frontmatter', 'utf8')
    // sem frontmatter a skill continua existindo para o SDK, só sem descrição
    expect(discoverSkills(project, join(project, 'home')).map(({ name, description }) => ({ name, description }))).toEqual([
      { name: 'bad', description: '' }
    ])
    expect(discoverSkills('relativo', join(project, 'home'))).toEqual([])
  })
})
