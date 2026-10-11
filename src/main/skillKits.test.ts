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

/** Um app com a base (`.agents/skills`) e o kit do ECC (`.agents/skills-ecc`) com uma skill. */
async function fixture(prefix: string): Promise<{ app: string; cache: string; home: string; kitRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const app = join(root, 'app')
  const kitRoot = join(app, '.agents', 'skills-ecc')
  await seedSkill(join(app, '.agents', 'skills'), 'brainstorming', 'base')
  await seedSkill(kitRoot, 'click-path-audit', 'do kit')
  return { app, cache: join(root, 'cache'), home: join(root, 'home'), kitRoot }
}

const names = (home: string): string[] => discoverSkills('', home).map((s) => s.name)
const tiered = { ...DEFAULT_CONFIG.skillCatalog, tiered: true }

describe('kits de skills atrás de um interruptor', () => {
  it('o kit do ciclo saiu do app: só o ECC é kit', () => {
    expect(SKILL_KITS.map((k) => k.id)).toEqual(['ecc'])
    // Config antiga com o campo do ciclo não liga kit nenhum.
    expect(activeSkillKits({ handoff: { ciclo: true, leituraGuiada: false } as never })).toEqual([])
  })

  it('o kit do ECC segue o interruptor "Catálogo de skills em níveis" (desligado por padrão)', () => {
    expect(activeSkillKits(DEFAULT_CONFIG)).toEqual([])
    expect(activeSkillKits({ ...DEFAULT_CONFIG, skillCatalog: tiered })).toEqual(['ecc'])
  })

  it('ligado: a skill do kit vai para o cache e para a raiz nativa; desligado: some de tudo', async () => {
    const { app, cache, home } = await fixture('skill-kit-toggle-')

    expect(syncCacheSkills(app, cache, home, ['ecc']).errors).toEqual([])
    expect(existsSync(join(cache, 'skills', 'click-path-audit', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'click-path-audit', 'SKILL.md'))).toBe(true)
    expect(names(home)).toEqual(['brainstorming', 'click-path-audit'])

    const off = syncCacheSkills(app, cache, home, [])
    expect(off.errors).toEqual([])
    expect(off.available).toEqual(['brainstorming'])
    expect(existsSync(join(cache, 'skills', 'click-path-audit'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', 'click-path-audit'))).toBe(false)
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
    await seedSkill(join(app, '.agents', 'skills'), 'click-path-audit', 'cópia na base')
    await seedSkill(join(app, '.agents', 'seed-skills'), 'click-path-audit', 'semente')
    expect(syncCacheSkills(app, cache, home, []).errors).toEqual([])
    expect(names(home)).toEqual(['brainstorming'])
  })

  it('skill do usuário com o mesmo nome no cache: o kit não a sobrescreve nem a apaga ao desligar', async () => {
    const { app, cache, home } = await fixture('skill-kit-user-')
    await seedSkill(join(cache, 'skills'), 'click-path-audit', 'minha versão')
    expect(syncCacheSkills(app, cache, home, ['ecc']).errors).toEqual([])
    expect(await readFile(join(cache, 'skills', 'click-path-audit', 'SKILL.md'), 'utf8')).toContain('minha versão')
    expect(syncCacheSkills(app, cache, home, []).errors).toEqual([])
    expect(await readFile(join(cache, 'skills', 'click-path-audit', 'SKILL.md'), 'utf8')).toContain('minha versão')
  })

  it('kit real do repositório: o ECC só entra ligado, nenhum nome dele repete o do kit base, e a pasta do ciclo não existe', async () => {
    const repo = join(__dirname, '..', '..')
    expect(existsSync(join(repo, '.agents', 'skills-ciclo'))).toBe(false)
    const ecc = skillNamesIn(join(repo, '.agents', 'skills-ecc'))
    const base = new Set(skillNamesIn(join(repo, '.agents', 'skills')))
    expect(ecc.length).toBeGreaterThan(100)
    expect(ecc.filter((name) => base.has(name))).toEqual([])
    const root = await mkdtemp(join(tmpdir(), 'skill-kit-real-'))
    const off = syncCacheSkills(repo, join(root, 'cache'), join(root, 'home'), [])
    expect(off.errors).toEqual([])
    expect(off.available.filter((name) => ecc.includes(name))).toEqual([])
    const on = syncCacheSkills(repo, join(root, 'cache'), join(root, 'home'), ['ecc'])
    expect(on.errors).toEqual([])
    expect(ecc.every((name) => on.available.includes(name))).toBe(true)
  }, 60_000)

  it('trocar o interruptor muda a versão das skills gerenciadas (a sessão ressincroniza no próximo envio)', async () => {
    const { app } = await fixture('skill-kit-version-')
    const off = managedSkillsFilesystemVersion(app, [])
    expect(managedSkillsFilesystemVersion(app)).toBe(off)
    expect(managedSkillsFilesystemVersion(app, ['ecc'])).not.toBe(off)
  })
})
