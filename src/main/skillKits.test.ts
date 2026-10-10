import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../shared/ipc'
import { skillNames as skillNamesIn } from './skillDirs'
import { discoverSkills } from './skillDiscovery'
import { activeSkillKits, SKILL_KITS } from './skillKits'
import { managedSkillsFilesystemVersion, syncCacheSkills } from './skillManager'

async function seedSkill(root: string, name: string, body: string): Promise<void> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: teste\n---\n${body}`, 'utf8')
}

async function fixture(prefix: string): Promise<{ app: string; cache: string; home: string; kitRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const app = join(root, 'app')
  const kitRoot = join(app, '.agents', 'skills-ciclo')
  await seedSkill(join(app, '.agents', 'skills'), 'brainstorming', 'base')
  await seedSkill(kitRoot, 'verification-loop', 'do kit')
  return { app, cache: join(root, 'cache'), home: join(root, 'home'), kitRoot }
}

const names = (home: string): string[] => discoverSkills('', home).map((s) => s.name)

describe('kits de skills atrás de um interruptor', () => {
  it('o kit do ciclo segue o interruptor "Ciclo completo nos handoffs" (desligado por padrão)', () => {
    expect(SKILL_KITS.map((k) => k.id)).toContain('ciclo')
    expect(activeSkillKits(DEFAULT_CONFIG)).toEqual([])
    expect(activeSkillKits({ handoff: { ciclo: true, leituraGuiada: false } })).toEqual(['ciclo'])
    expect(activeSkillKits({ handoff: { ciclo: false, leituraGuiada: true } })).toEqual([])
  })

  it('o kit do ECC segue o interruptor "Catálogo de skills em níveis" (desligado por padrão), independente do ciclo', () => {
    expect(SKILL_KITS.map((k) => k.id)).toContain('ecc')
    expect(activeSkillKits(DEFAULT_CONFIG)).not.toContain('ecc')
    const tiered = { ...DEFAULT_CONFIG.skillCatalog, tiered: true }
    expect(activeSkillKits({ ...DEFAULT_CONFIG, skillCatalog: tiered })).toEqual(['ecc'])
    expect(activeSkillKits({ handoff: { ciclo: true, leituraGuiada: false }, skillCatalog: tiered })).toEqual(['ciclo', 'ecc'])
    expect(activeSkillKits({ handoff: { ciclo: false, leituraGuiada: false }, skillCatalog: tiered })).toEqual(['ecc'])
  })

  it('kit do ECC desligado: nenhuma skill dele no cache nem na raiz nativa', async () => {
    const { app, cache, home } = await fixture('skill-kit-ecc-')
    await seedSkill(join(app, '.agents', 'skills-ecc'), 'click-path-audit', 'do ECC')
    expect(syncCacheSkills(app, cache, home, ['ciclo', 'ecc']).available).toEqual(['brainstorming', 'click-path-audit', 'verification-loop'])
    expect(syncCacheSkills(app, cache, home, ['ciclo']).available).toEqual(['brainstorming', 'verification-loop'])
    expect(names(home)).not.toContain('click-path-audit')
  })

  it('ligado: a skill do kit vai para o cache e para a raiz nativa; desligado: some de tudo', async () => {
    const { app, cache, home } = await fixture('skill-kit-toggle-')

    expect(syncCacheSkills(app, cache, home, ['ciclo']).errors).toEqual([])
    expect(existsSync(join(cache, 'skills', 'verification-loop', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'verification-loop', 'SKILL.md'))).toBe(true)
    expect(names(home)).toEqual(['brainstorming', 'verification-loop'])

    const off = syncCacheSkills(app, cache, home, [])
    expect(off.errors).toEqual([])
    expect(off.available).toEqual(['brainstorming'])
    expect(existsSync(join(cache, 'skills', 'verification-loop'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', 'verification-loop'))).toBe(false)
    // Catálogo do app, menu "/" e lista nativa leem a mesma descoberta.
    expect(names(home)).toEqual(['brainstorming'])
  })

  it('desligado desde o início: nada do kit aparece (e sem kits = o comportamento de hoje)', async () => {
    const { app, cache, home } = await fixture('skill-kit-off-')
    expect(syncCacheSkills(app, cache, home).available).toEqual(['brainstorming'])
    expect(names(home)).toEqual(['brainstorming'])
  })

  it('o nome do kit nunca entra por outro caminho: cópia em .agents/skills nem semente do instalador', async () => {
    const { app, cache, home } = await fixture('skill-kit-leak-')
    // Um `npx skills` que restaure o lock em .agents/skills, e a semente da máquina de build.
    await seedSkill(join(app, '.agents', 'skills'), 'verification-loop', 'cópia na base')
    await seedSkill(join(app, '.agents', 'seed-skills'), 'verification-loop', 'semente')
    expect(syncCacheSkills(app, cache, home, []).errors).toEqual([])
    expect(names(home)).toEqual(['brainstorming'])
  })

  it('skill do usuário com o mesmo nome no cache: o kit não a sobrescreve nem a apaga ao desligar', async () => {
    const { app, cache, home } = await fixture('skill-kit-user-')
    await seedSkill(join(cache, 'skills'), 'verification-loop', 'minha versão')
    expect(syncCacheSkills(app, cache, home, ['ciclo']).errors).toEqual([])
    expect(await readFile(join(cache, 'skills', 'verification-loop', 'SKILL.md'), 'utf8')).toContain('minha versão')
    expect(syncCacheSkills(app, cache, home, []).errors).toEqual([])
    expect(await readFile(join(cache, 'skills', 'verification-loop', 'SKILL.md'), 'utf8')).toContain('minha versão')
  })

  it('kit real do repositório: o ECC só entra ligado e nenhum nome dele repete o do kit base ou do ciclo', async () => {
    const repo = join(__dirname, '..', '..')
    const ecc = skillNamesIn(join(repo, '.agents', 'skills-ecc'))
    const base = new Set([...skillNamesIn(join(repo, '.agents', 'skills')), ...skillNamesIn(join(repo, '.agents', 'skills-ciclo'))])
    expect(ecc.length).toBeGreaterThan(100)
    expect(ecc.filter((name) => base.has(name))).toEqual([])
    const root = await mkdtemp(join(tmpdir(), 'skill-kit-real-'))
    const off = syncCacheSkills(repo, join(root, 'cache'), join(root, 'home'), ['ciclo'])
    expect(off.errors).toEqual([])
    expect(off.available.filter((name) => ecc.includes(name))).toEqual([])
    const on = syncCacheSkills(repo, join(root, 'cache'), join(root, 'home'), ['ciclo', 'ecc'])
    expect(on.errors).toEqual([])
    expect(ecc.every((name) => on.available.includes(name))).toBe(true)
  }, 60_000)

  it('trocar o interruptor muda a versão das skills gerenciadas (a sessão ressincroniza no próximo envio)', async () => {
    const { app } = await fixture('skill-kit-version-')
    const off = managedSkillsFilesystemVersion(app, [])
    expect(managedSkillsFilesystemVersion(app)).toBe(off)
    expect(managedSkillsFilesystemVersion(app, ['ciclo'])).not.toBe(off)
  })
})
