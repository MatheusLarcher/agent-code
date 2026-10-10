import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredSkill } from '../skillDiscovery'
import { createSkillCatalogSnapshot, renderAgentSkillCatalog } from '../skillDiscovery'
import {
  CRITICAL_BUDGET_BYTES,
  DEFAULT_NATIVE_EXTRA_SKILLS,
  rememberNativeSkillNames,
  resolveSkillTiers,
  skillCatalogPolicy,
  skillTierRows
} from './skillTiers'

const skill = (name: string, description = `descrição de ${name}`, skillFile = `C:/skills/${name}/SKILL.md`): DiscoveredSkill => ({
  name,
  description,
  skillFile,
  root: 'C:/skills',
  source: 'user-claude',
  native: true,
  modifiedAtMs: 0,
  sizeBytes: 10
})

const OFF = { tiered: false, overrides: {} }
const ON = { tiered: true, overrides: {} }
const read = (path: string): string => `# conteúdo de ${path}`

describe('resolveSkillTiers', () => {
  it('usa o índice, o ajuste do usuário vence, e skill nova entra como média em "Outras"', () => {
    const tiers = resolveSkillTiers(
      [skill('verification-before-completion'), skill('click-path-audit'), skill('brag'), skill('skill-inventada')],
      { brag: { tier: 'low', category: 'Vídeo e mídia' } }
    )
    const by = Object.fromEntries(tiers.map((t) => [t.name, [t.tier, t.category]]))
    expect(by['verification-before-completion']).toEqual(['critical', 'Testes e qualidade'])
    expect(by['click-path-audit']).toEqual(['low', 'Depuração'])
    expect(by['brag']).toEqual(['low', 'Vídeo e mídia'])
    expect(by['skill-inventada']).toEqual(['medium', 'Outras'])
  })
})

describe('skillCatalogPolicy — desligado = exatamente como hoje', () => {
  const policy = skillCatalogPolicy(OFF, { read })
  const all = [skill('verification-before-completion'), skill('click-path-audit'), skill('brag')]

  it('skills: "all", nenhum bloco no prompt de sistema, nativo confirma tudo e nada é reescrito', () => {
    expect(policy.tiered).toBe(false)
    expect(policy.sdkSkills(all)).toBe('all')
    expect(policy.systemBlock(all)).toEqual({ text: '', warning: null })
    expect(policy.nativeExpected(all)).toEqual(all)
    expect(policy.rewriteCommand('/click-path-audit no botão', all)).toBe('/click-path-audit no botão')
  })

  it('o catálogo anunciado é o de hoje (renderAgentSkillCatalog), sem mudança', () => {
    const confirmed = createSkillCatalogSnapshot(all)
    const announced = policy.announce(confirmed, all)
    expect(announced.catalog).toBe(renderAgentSkillCatalog(all))
    expect(announced.version).toBe(confirmed.version)
  })
})

describe('skillCatalogPolicy — catálogo em níveis', () => {
  const all = [skill('verification-before-completion'), skill('brag'), skill('click-path-audit'), skill('react-testing')]

  it('lista nativa: críticas + médias + as embutidas do CLI; nunca as baixas', () => {
    const native = skillCatalogPolicy(ON, { read }).sdkSkills(all) as string[]
    expect(native).toEqual(expect.arrayContaining(['verification-before-completion', 'brag', ...DEFAULT_NATIVE_EXTRA_SKILLS]))
    expect(native).not.toContain('click-path-audit')
    expect(native).not.toContain('react-testing')
    expect(native).toContain('loop')
    expect(skillCatalogPolicy(ON, { read }).nativeExpected(all).map((s) => s.name)).toEqual(['verification-before-completion', 'brag'])
  })

  it('as embutidas que a sessão anunciou (init.skills) entram na lista nativa das próximas', () => {
    rememberNativeSkillNames(['brag', 'anthropic-skills:pdf', 'nova-embutida'], all)
    const native = skillCatalogPolicy(ON, { read }).sdkSkills(all) as string[]
    expect(native).toEqual(expect.arrayContaining(['anthropic-skills:pdf', 'nova-embutida']))
    rememberNativeSkillNames([], all)
  })

  it('crítica vai INTEIRA no prompt de sistema', () => {
    const { text, warning } = skillCatalogPolicy(ON, { read }).systemBlock(all)
    expect(text).toContain('# conteúdo de C:/skills/verification-before-completion/SKILL.md')
    expect(text).toMatch(/verification-before-completion/)
    expect(text).not.toContain('C:/skills/brag/SKILL.md')
    expect(warning).toBeNull()
  })

  it('críticas acima do teto: avisa e a que não coube vira média (nunca cortada calada)', () => {
    const big = (path: string): string => (path.includes('verification') ? 'x'.repeat(CRITICAL_BUDGET_BYTES + 10) : read(path))
    const policy = skillCatalogPolicy(ON, { read: big })
    const block = policy.systemBlock(all)
    expect(block.text).toBe('')
    expect(block.warning).toMatch(/verification-before-completion/)
    expect(block.warning).toMatch(/20 KB/)
    expect(policy.sdkSkills(all)).toContain('verification-before-completion')
  })

  it('catálogo do app: médias com o caminho, baixas só o nome por categoria, e as ferramentas de busca', () => {
    const policy = skillCatalogPolicy(ON, { read })
    const confirmed = createSkillCatalogSnapshot(policy.nativeExpected(all))
    const { catalog, version } = policy.announce(confirmed, all)
    expect(catalog).toContain('C:/skills/brag/SKILL.md')
    // A descrição da média já vai na listagem nativa do SDK: não se repete aqui.
    expect(catalog).not.toContain('descrição de brag')
    expect(catalog).toMatch(/Depuração: click-path-audit/)
    expect(catalog).toMatch(/Testes e qualidade: react-testing/)
    expect(catalog).not.toContain('descrição de click-path-audit')
    expect(catalog).not.toContain('C:/skills/click-path-audit/SKILL.md')
    expect(catalog).toContain('mcp__skills__skills_buscar')
    expect(catalog).toContain('mcp__skills__skills_listar')
    expect(version).not.toBe(confirmed.version)
  })

  it('/nome de skill baixa vira "leia e siga o SKILL.md"; média e desconhecida ficam como estão', () => {
    const policy = skillCatalogPolicy(ON, { read })
    expect(policy.rewriteCommand('/click-path-audit o botão salvar não faz nada', all)).toBe(
      'Leia e siga a skill click-path-audit: abra C:/skills/click-path-audit/SKILL.md com Read e siga as instruções dela.\n\no botão salvar não faz nada'
    )
    expect(policy.rewriteCommand('/brag', all)).toBe('/brag')
    expect(policy.rewriteCommand('/naoexiste x', all)).toBe('/naoexiste x')
    expect(policy.rewriteCommand('texto /click-path-audit no meio', all)).toBe('texto /click-path-audit no meio')
  })
})

describe('skillCatalogPolicy — achados da revisão', () => {
  const all = [skill('verification-before-completion'), skill('brag'), skill('click-path-audit')]

  it('o catálogo só chama de crítica (texto no prompt) a que entrou no prompt na subida', () => {
    const policy = skillCatalogPolicy(ON, { read })
    policy.systemBlock([skill('brag')]) // subida: nenhuma crítica no disco ainda
    const later = [...all] // a crítica apareceu depois
    const { catalog } = policy.announce(createSkillCatalogSnapshot(policy.nativeExpected(later)), later)
    expect(catalog).toMatch(/Critical[^\n]*\n\(none\)/)
    expect(catalog).toContain('/verification-before-completion — C:/skills/verification-before-completion/SKILL.md')
  })

  it('skill do usuário em nível baixo com nome de embutida (simplify) não volta pela lista de embutidas', () => {
    const policy = skillCatalogPolicy({ tiered: true, overrides: { simplify: { tier: 'low', category: 'Outras' } } }, { read })
    expect(policy.sdkSkills([...all, skill('simplify')])).not.toContain('simplify')
    expect(policy.sdkSkills(all)).toContain('simplify')
  })

  it('as embutidas aprendidas somam entre sessões em vez de a última apagar as outras', () => {
    rememberNativeSkillNames(['plugin:a'], all)
    rememberNativeSkillNames(['plugin:b'], all)
    const native = skillCatalogPolicy(ON, { read }).sdkSkills(all) as string[]
    expect(native).toEqual(expect.arrayContaining(['plugin:a', 'plugin:b']))
  })

  it('as críticas são lidas uma vez por lista descoberta', () => {
    let reads = 0
    const policy = skillCatalogPolicy(ON, { read: (p) => (reads++, read(p)) })
    policy.systemBlock(all)
    policy.sdkSkills(all)
    policy.nativeExpected(all)
    policy.announce(createSkillCatalogSnapshot(all), all)
    expect(reads).toBe(1)
  })

  it('aviso no plural com o teto vindo da constante', () => {
    const big = (): string => 'x'.repeat(CRITICAL_BUDGET_BYTES + 1)
    const { warning } = skillCatalogPolicy(
      { tiered: true, overrides: { brag: { tier: 'critical', category: 'Vídeo e mídia' } } },
      { read: big }
    ).systemBlock(all)
    expect(warning).toMatch(/verification-before-completion, brag não couberam/)
    expect(warning).toMatch(/foram tratadas como médias/)
  })
})

describe('skillTierRows (o editor das Configurações)', () => {
  it('cada skill com o nível em uso, o padrão do índice e se veio do ECC', () => {
    const rows = skillTierRows(
      [skill('brag'), skill('click-path-audit'), skill('nova')],
      { brag: { tier: 'low', category: 'Vídeo e mídia' } },
      new Set(['click-path-audit'])
    )
    expect(rows).toEqual([
      { name: 'brag', description: 'descrição de brag', tier: 'low', category: 'Vídeo e mídia', defaultTier: 'medium', defaultCategory: 'Vídeo e mídia', fromEcc: false },
      { name: 'click-path-audit', description: 'descrição de click-path-audit', tier: 'low', category: 'Depuração', defaultTier: 'low', defaultCategory: 'Depuração', fromEcc: true },
      { name: 'nova', description: 'descrição de nova', tier: 'medium', category: 'Outras', defaultTier: 'medium', defaultCategory: 'Outras', fromEcc: false }
    ])
  })
})

describe('resolveSkillTiers com o kit real', () => {
  it('lê o SKILL.md de verdade para a crítica', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tiers-'))
    await mkdir(join(dir, 'verification-before-completion'))
    const file = join(dir, 'verification-before-completion', 'SKILL.md')
    await writeFile(file, '---\nname: verification-before-completion\n---\nIron Law', 'utf8')
    const { text } = skillCatalogPolicy(ON).systemBlock([skill('verification-before-completion', 'x', file)])
    expect(text).toContain('Iron Law')
  })
})
