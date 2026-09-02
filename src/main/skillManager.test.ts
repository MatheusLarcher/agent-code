import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureNativeSkillRoot, exposeCacheSkills, syncCacheSkills } from './skillManager'

async function seedSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: teste\n---\n${body}`, 'utf8')
}

describe('ensureNativeSkillRoot', () => {
  it('cria <cache>/native/.claude/skills como link para <cache>/skills, e é idempotente', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'skill-native-'))
    await seedSkill(join(cache, 'skills'), 'caveman', 'ugh')

    const first = ensureNativeSkillRoot(cache)
    expect(first.errors).toEqual([])
    expect(first.root).toBe(join(cache, 'native'))
    const link = join(cache, 'native', '.claude', 'skills')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    // Followed like a real directory: this is exactly what the CLI scanner does.
    expect(await readFile(join(link, 'caveman', 'SKILL.md'), 'utf8')).toContain('ugh')

    // Second call: nothing to do, nothing broken.
    expect(ensureNativeSkillRoot(cache).errors).toEqual([])
    expect(await readFile(join(link, 'caveman', 'SKILL.md'), 'utf8')).toContain('ugh')
  })

  it('re-aponta um link que apontava para outro lugar', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'skill-native-repoint-'))
    const elsewhere = join(cache, 'old-skills')
    await seedSkill(elsewhere, 'velha', 'x')
    await mkdir(join(cache, 'native', '.claude'), { recursive: true })
    await symlink(elsewhere, join(cache, 'native', '.claude', 'skills'), 'junction')
    await seedSkill(join(cache, 'skills'), 'nova', 'y')

    expect(ensureNativeSkillRoot(cache).errors).toEqual([])
    const link = join(cache, 'native', '.claude', 'skills')
    expect(existsSync(join(link, 'nova', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(link, 'velha', 'SKILL.md'))).toBe(false)
  })

  it('nunca substitui um diretório real no lugar do link', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'skill-native-real-'))
    await seedSkill(join(cache, 'native', '.claude', 'skills'), 'do-usuario', 'meu')
    await seedSkill(join(cache, 'skills'), 'caveman', 'ugh')

    const result = ensureNativeSkillRoot(cache)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/diretório real/)
    expect(await readFile(join(cache, 'native', '.claude', 'skills', 'do-usuario', 'SKILL.md'), 'utf8')).toContain('meu')
  })

  it('não cria nada quando a pasta de dados não existe', async () => {
    const result = ensureNativeSkillRoot(join(tmpdir(), 'nao-existe-' + Date.now()))
    expect(result.errors).toHaveLength(1)
    expect(existsSync(result.root)).toBe(false)
  })
})

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

    await rm(join(app, '.agents', 'skills', 'brainstorming'), { recursive: true })
    result = syncCacheSkills(app, cache, home)
    expect(result.errors).toEqual([])
    expect(existsSync(join(cache, 'skills', 'brainstorming', 'SKILL.md'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', 'brainstorming', 'SKILL.md'))).toBe(false)
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

  it('expõe skill adicionada a quente e remove somente junction gerenciada obsoleta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-hot-'))
    const skills = join(root, 'cache', 'skills')
    const home = join(root, 'home')
    await seedSkill(skills, 'dynamic', 'ativa')

    expect(exposeCacheSkills(skills, home).errors).toEqual([])
    const globalSkill = join(home, '.claude', 'skills', 'dynamic', 'SKILL.md')
    expect(existsSync(globalSkill)).toBe(true)

    await rm(join(skills, 'dynamic'), { recursive: true })
    expect(exposeCacheSkills(skills, home).errors).toEqual([])
    expect(existsSync(globalSkill)).toBe(false)
  })

  it('não remove caminho externo citado por manifesto empacotado corrompido', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-hostile-manifest-'))
    const app = join(root, 'app')
    const cache = join(root, 'cache')
    const home = join(root, 'home')
    const victim = join(root, 'victim')
    await mkdir(join(cache, 'skills'), { recursive: true })
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'não apagar', 'utf8')
    await writeFile(
      join(cache, 'skills', '.agent-code-bundled.json'),
      JSON.stringify({ version: 1, skills: ['..\\..\\victim'] }),
      'utf8'
    )

    const result = syncCacheSkills(app, cache, home)
    expect(result.errors.join('\n')).toMatch(/nome inválido/i)
    expect(await readFile(join(victim, 'keep.txt'), 'utf8')).toBe('não apagar')
  })

  it('remove a cópia gerenciada obsoleta mesmo depois de o usuário reescrever o conteúdo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-replaced-link-'))
    const skills = join(root, 'cache', 'skills')
    const home = join(root, 'home')
    await seedSkill(skills, 'foo', 'cache')
    expect(exposeCacheSkills(skills, home).errors).toEqual([])

    const globalSkill = join(home, '.claude', 'skills', 'foo')
    await seedSkill(join(home, '.claude', 'skills'), 'foo', 'editada pelo usuário')
    await rm(join(skills, 'foo'), { recursive: true })

    // O manifesto registra a skill como gerenciada, então a cópia sai junto com a
    // origem — é o preço de materializar diretório real em vez de junction.
    expect(exposeCacheSkills(skills, home).errors).toEqual([])
    expect(existsSync(globalSkill)).toBe(false)
  })

  it('nunca substitui diretório do usuário que o Agent Code não criou', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-user-dir-'))
    const skills = join(root, 'cache', 'skills')
    const home = join(root, 'home')
    await seedSkill(skills, 'shared', 'cache')
    await seedSkill(join(home, '.claude', 'skills'), 'shared', 'do usuário')

    expect(exposeCacheSkills(skills, home).errors).toEqual([])
    expect(await readFile(join(home, '.claude', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('do usuário')
  })

  it('migra manifesto v1 antes de remover uma junction gerenciada obsoleta', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-v1-stale-'))
    const app = join(root, 'app')
    const cache = join(root, 'cache')
    const skills = join(cache, 'skills')
    const home = join(root, 'home')
    const globalRoot = join(home, '.claude', 'skills')
    await seedSkill(skills, 'stale', 'antiga')
    await mkdir(globalRoot, { recursive: true })
    await symlink(join(skills, 'stale'), join(globalRoot, 'stale'), 'junction')
    await writeFile(
      join(globalRoot, '.agent-code-managed.json'),
      JSON.stringify({ version: 1, skills: ['stale'] }),
      'utf8'
    )
    await writeFile(
      join(skills, '.agent-code-bundled.json'),
      JSON.stringify({ version: 1, skills: ['stale'] }),
      'utf8'
    )

    expect(syncCacheSkills(app, cache, home).errors).toEqual([])
    await expect(lstat(join(globalRoot, 'stale'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('remove junction v1 já quebrada quando ainda aponta para o cache ativo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-manager-v1-dangling-'))
    const app = join(root, 'app')
    const cache = join(root, 'cache')
    const skills = join(cache, 'skills')
    const home = join(root, 'home')
    const globalRoot = join(home, '.claude', 'skills')
    await mkdir(skills, { recursive: true })
    await mkdir(globalRoot, { recursive: true })
    await symlink(join(skills, 'gone'), join(globalRoot, 'gone'), 'junction')
    await writeFile(
      join(globalRoot, '.agent-code-managed.json'),
      JSON.stringify({ version: 1, skills: ['gone'] }),
      'utf8'
    )

    expect(syncCacheSkills(app, cache, home).errors).toEqual([])
    await expect(lstat(join(globalRoot, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' })
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
