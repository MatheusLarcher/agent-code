import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncCacheSkills } from './skillManager'

async function seedSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: teste\n---\n${body}`, 'utf8')
}

describe('syncCacheSkills', () => {
  it('copia, atualiza e expõe skills empacotadas pelo cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-'))
    const app = join(root, 'app')
    const cache = join(root, 'cache')
    const home = join(root, 'home')
    await seedSkill(join(app, '.agents', 'skills'), 'brainstorming', 'v1')

    let result = syncCacheSkills(app, cache, home)
    expect(result.errors).toEqual([])
    expect(await readFile(join(cache, 'skills', 'brainstorming', 'SKILL.md'), 'utf8')).toContain('v1')
    expect(await readFile(join(home, '.claude', 'skills', 'brainstorming', 'SKILL.md'), 'utf8')).toContain('v1')

    await seedSkill(join(app, '.agents', 'skills'), 'brainstorming', 'v2')
    result = syncCacheSkills(app, cache, home)
    expect(result.errors).toEqual([])
    expect(await readFile(join(home, '.claude', 'skills', 'brainstorming', 'SKILL.md'), 'utf8')).toContain('v2')
  })

  it('preserva skill externa no cache e diretório global real', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-external-'))
    const app = join(root, 'app')
    const cache = join(root, 'cache')
    const home = join(root, 'home')
    await seedSkill(join(app, '.agents', 'skills'), 'bundled', 'app')
    await seedSkill(join(cache, 'skills'), 'external', 'cache')
    await seedSkill(join(cache, 'skills'), 'incompleta.agent-code-new', 'estágio')
    await seedSkill(join(home, '.claude', 'skills'), 'external', 'perfil')

    const result = syncCacheSkills(app, cache, home)
    expect(result.available).toEqual(['bundled', 'external'])
    expect(await readFile(join(cache, 'skills', 'external', 'SKILL.md'), 'utf8')).toContain('cache')
    expect(await readFile(join(home, '.claude', 'skills', 'external', 'SKILL.md'), 'utf8')).toContain('perfil')
  })

  it('repara link quebrado legado e religa ao trocar o cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-legacy-'))
    const app = join(root, 'app')
    const firstCache = join(root, 'first-cache')
    const secondCache = join(root, 'second-cache')
    const home = join(root, 'home')
    await seedSkill(join(app, '.agents', 'skills'), 'brainstorming', 'ativa')
    const globalRoot = join(home, '.claude', 'skills')
    await mkdir(globalRoot, { recursive: true })
    await symlink(join(root, 'checkout-antigo', '.agents', 'skills', 'brainstorming'), join(globalRoot, 'brainstorming'), 'junction')
    expect(existsSync(join(globalRoot, 'brainstorming', 'SKILL.md'))).toBe(false)

    expect(syncCacheSkills(app, firstCache, home).errors).toEqual([])
    expect(existsSync(join(globalRoot, 'brainstorming', 'SKILL.md'))).toBe(true)
    expect(syncCacheSkills(app, secondCache, home).errors).toEqual([])
    expect(await readFile(join(globalRoot, 'brainstorming', 'SKILL.md'), 'utf8')).toContain('ativa')
    expect(existsSync(join(secondCache, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true)
  })
})
