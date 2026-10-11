import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SkillCatalogConfig, SkillCategory, SkillTier, SkillTierRow } from '../../shared/ipc'
import { SKILL_CATEGORIES } from '../../shared/ipc'
import type { DiscoveredSkill, SkillCatalogSnapshot } from '../skillDiscovery'
import TIER_INDEX from './skillTierIndex.json'

/**
 * Catálogo de skills em três níveis (AppConfig.skillCatalog.tiered):
 * - alto: o SKILL.md inteiro no prompt de sistema (parte fixa, em cache);
 * - médio: como antes — listada pelo SDK (nome e descrição) e, no catálogo do
 *   app, o caminho do SKILL.md;
 * - baixo: só o nome, por categoria; achada por skills_buscar/skills_listar
 *   (skillTools.ts) e lida pelo caminho.
 * Desligado, a política é a identidade: `skills: 'all'` e o catálogo de antes.
 */

export interface TieredSkill {
  name: string
  description: string
  skillFile: string
  tier: SkillTier
  category: SkillCategory
}

type IndexEntry = { tier: SkillTier; category: SkillCategory }
const INDEX = TIER_INDEX as Record<string, IndexEntry>

/** Teto do texto das skills de nível alto no prompt de sistema. Passou: avisa, e a que não coube cai para o médio. */
export const HIGH_BUDGET_BYTES = 20_000

/**
 * As skills embutidas no CLI do SDK (sem SKILL.md nas pastas do app), vistas no
 * `init.skills` da versão empacotada. Com `skills: string[]` o SDK esconde do
 * modelo tudo o que não está na lista — inclusive estas (medido: o /loop sumia).
 */
export const DEFAULT_NATIVE_EXTRA_SKILLS: readonly string[] = [
  'batch', 'claude-api', 'code-review', 'dataviz', 'debug', 'deep-research', 'doctor', 'fewer-permission-prompts', 'init',
  'keybindings-help', 'loop', 'plugin-authoring', 'run', 'run-skill-generator', 'schedule', 'security-review', 'simplify',
  'update-config', 'verify', 'workflow-authoring'
]

const learnedExtras = new Set<string>()

/** Guarda as skills que o CLI anunciou (`init.skills`, sempre a lista inteira) e que
 *  não são pastas do app: embutidas e de plugins. Somam entre sessões (contas
 *  diferentes podem ter plugins diferentes) e entram na lista nativa das próximas
 *  sessões em níveis. */
export function rememberNativeSkillNames(initSkills: readonly string[], discovered: readonly DiscoveredSkill[]): void {
  const fileNames = fileSkillNames(discovered)
  for (const name of initSkills) if (!fileNames.has(name)) learnedExtras.add(name)
}

const fileSkillNames = (discovered: readonly DiscoveredSkill[]): Set<string> =>
  new Set(discovered.flatMap((s) => [s.name, s.displayName ?? s.name]))

export function resolveSkillTiers(
  skills: readonly DiscoveredSkill[],
  overrides: SkillCatalogConfig['overrides'] = {}
): TieredSkill[] {
  return skills.map((s) => {
    // Skill nova (fora do índice e sem ajuste) entra no nível médio, na categoria que
    // o nome e a descrição sugerem, até alguém classificar.
    const choice = overrides[s.name] ?? INDEX[s.name] ?? { tier: 'medium', category: guessSkillCategory(s.name, s.description) }
    const category = SKILL_CATEGORIES.includes(choice.category) ? choice.category : 'Outras'
    return { name: s.name, description: s.description, skillFile: s.skillFile, tier: choice.tier, category }
  })
}

// Primeira regra que casa vence: as específicas antes das genéricas (segurança e
// testes antes de backend, por exemplo). Casam nome + descrição, sem acento.
const CATEGORY_RULES: readonly (readonly [SkillCategory, RegExp])[] = [
  ['Segurança', /secur|seguranc|vulnerab|exploit|pentest|threat|malware|red.?team|blue.?team|osint|compliance|hipaa/],
  ['Web3 e cripto', /web3|blockchain|crypto|cripto|solidity|evm|defi|token|keccak|nft/],
  ['Ciência e saúde', /scien|cienti|pubmed|patent|research paper|literature|health|saude|clinic|medic/],
  ['Testes e qualidade', /\btest|tdd|e2e|\bqa\b|verif|review|lint|quality|qualidade/],
  ['Depuração', /debug|depura|bug|trace|diagnos/],
  ['Git e DevOps', /\bgit\b|github|commit|branch|worktree|docker|kubernetes|deploy|ci\/cd|pipeline de build|terminal/],
  ['Redes e infraestrutura', /network|\brede|homelab|vlan|vpn|router|cisco|bgp|ssh|dns/],
  ['Modelagem 3D', /\b3d\b|blender|stl|3mf|cad\b|mesh|impress[aã]o 3d/],
  ['Vídeo e mídia', /video|v[ií]deo|audio|[aá]udio|animation|anima[cç]|media|m[ií]dia|image|imagem/],
  ['IA e agentes', /\bagent|\bllm|\bai\b|\bia\b|prompt|claude|subagent|skill|mcp|rag\b|model/],
  ['Mobile', /android|\bios\b|swift|kotlin|flutter|react.native|mobile|celular|apk/],
  ['Banco de dados', /database|banco de dados|\bsql|postgres|mysql|redis|prisma|orm\b|migration|schema/],
  ['Python', /python|django|fastapi|pytorch|pandas/],
  ['Frontend', /frontend|\bui\b|\bux\b|react|vue|angular|css|html|design|componen|a11y/],
  ['Backend', /backend|\bapi\b|server|servidor|node|java|golang|rust|\.net|microservi/],
  ['Marketing e conteúdo', /marketing|copy|seo|brand|marca|campaign|campanha|content|conte[uú]do|social|newsletter|email/],
  ['Documentos', /document|docx|pdf|xlsx|pptx|planilha|relat[oó]rio|report|contrato|contract|writing|escrita/],
  ['Regras de negócio (ERP)', /\berp\b|financ|fiscal|estoque|inventory|logist|nota fiscal|nfe|nfse|faturamento/],
  ['Planejamento e processo', /plan|process|workflow|brainstorm|decis|architect|arquitet|roadmap/]
]

/** Categoria sugerida para uma skill fora do índice; "Outras" só quando nada casa. */
export function guessSkillCategory(name: string, description: string): SkillCategory {
  const text = `${name.replace(/[-_]/g, ' ')} ${description}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  return CATEGORY_RULES.find(([, re]) => re.test(text))?.[0] ?? 'Outras'
}

/** As linhas do editor das Configurações: nível em uso, padrão do índice e origem. */
export function skillTierRows(
  discovered: readonly DiscoveredSkill[],
  overrides: SkillCatalogConfig['overrides'],
  eccNames: ReadonlySet<string>
): SkillTierRow[] {
  const defaults = new Map(resolveSkillTiers(discovered).map((s) => [s.name, s]))
  return resolveSkillTiers(discovered, overrides)
    .map((s) => ({
      name: s.name,
      description: s.description,
      tier: s.tier,
      category: s.category,
      defaultTier: defaults.get(s.name)!.tier,
      defaultCategory: defaults.get(s.name)!.category,
      fromEcc: eccNames.has(s.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillCatalogPolicy {
  tiered: boolean
  /** A opção `skills` do SDK. */
  sdkSkills(discovered: readonly DiscoveredSkill[]): 'all' | string[]
  /** As de nível alto inteiras, para o `append`; `warning` quando passou do teto. */
  systemBlock(discovered: readonly DiscoveredSkill[]): { text: string; warning: string | null }
  /** O que o registro nativo do CLI precisa confirmar (reloadSkills). */
  nativeExpected(discovered: readonly DiscoveredSkill[]): DiscoveredSkill[]
  /** O catálogo que o app anuncia ao modelo, a partir do que o nativo confirmou. */
  announce(confirmed: SkillCatalogSnapshot, discovered: readonly DiscoveredSkill[]): SkillCatalogSnapshot
  /** `/nome` de uma skill de nível baixo vira "leia e siga o SKILL.md". */
  rewriteCommand(text: string, discovered: readonly DiscoveredSkill[]): string
}

const IDENTITY: Omit<SkillCatalogPolicy, 'tiered'> = {
  sdkSkills: () => 'all',
  systemBlock: () => ({ text: '', warning: null }),
  nativeExpected: (discovered) => [...discovered],
  announce: (confirmed) => confirmed,
  rewriteCommand: (text) => text
}

const SLASH = /^\/([\p{L}\p{N}][\p{L}\p{N}._:-]*)(?:[ \t]+|\r?\n|$)([\s\S]*)$/u

export function skillCatalogPolicy(
  config: SkillCatalogConfig,
  opts: { read?: (path: string) => string } = {}
): SkillCatalogPolicy {
  if (!config.tiered) return { tiered: false, ...IDENTITY }
  const read = opts.read ?? ((path: string) => readFileSync(path, 'utf8'))
  // As de nível alto que entraram no prompt de sistema na subida da sessão: o catálogo
  // só chama de nível alto (texto já no prompt) o que de fato está lá.
  let pinned: Set<string> | null = null
  // Uma leitura das de nível alto por lista descoberta (a sessão passa o mesmo array).
  let memo: { discovered: readonly DiscoveredSkill[]; fit: ReturnType<typeof computeFit> } | null = null

  // As de nível alto que cabem no teto, na ordem; a que não cabe é tratada como de nível médio.
  const computeFit = (discovered: readonly DiscoveredSkill[]) => {
    const tiered = resolveSkillTiers(discovered, config.overrides)
    const included: { skill: TieredSkill; text: string }[] = []
    const overflow: string[] = []
    let used = 0
    for (const skill of tiered.filter((s) => s.tier === 'high')) {
      // Depois da subida o texto já está no prompt: só vale o que foi fixado, sem reler.
      if (pinned) {
        if (pinned.has(skill.name)) included.push({ skill, text: '' })
        else overflow.push(skill.name)
        continue
      }
      let text = ''
      try {
        text = read(skill.skillFile)
      } catch {
        overflow.push(skill.name)
        continue
      }
      const size = Buffer.byteLength(text, 'utf8')
      if (used + size > HIGH_BUDGET_BYTES) {
        overflow.push(skill.name)
        continue
      }
      used += size
      included.push({ skill, text })
    }
    const tiers = tiered.map((s) => (s.tier === 'high' && overflow.includes(s.name) ? { ...s, tier: 'medium' as const } : s))
    return { tiers, included, overflow }
  }
  const highFit = (discovered: readonly DiscoveredSkill[]): ReturnType<typeof computeFit> => {
    if (memo?.discovered !== discovered) memo = { discovered, fit: computeFit(discovered) }
    return memo.fit
  }

  return {
    tiered: true,
    sdkSkills(discovered) {
      const { tiers } = highFit(discovered)
      const byName = new Map(discovered.map((s) => [s.name, s]))
      const names = tiers
        .filter((s) => s.tier !== 'low')
        .flatMap((s) => [s.name, ...(byName.get(s.name)?.displayName ? [byName.get(s.name)!.displayName!] : [])])
      // Embutida com o nome de uma pasta de skill segue o nível da pasta (nível baixo não volta por aqui).
      const files = fileSkillNames(discovered)
      const extras = [...DEFAULT_NATIVE_EXTRA_SKILLS, ...learnedExtras].filter((name) => !files.has(name))
      return [...new Set([...names, ...extras])].sort((a, b) => a.localeCompare(b))
    },
    systemBlock(discovered) {
      const { included, overflow } = highFit(discovered)
      pinned = new Set(included.map((c) => c.skill.name))
      const kb = Math.round(HIGH_BUDGET_BYTES / 1000)
      const warning =
        overflow.length === 0
          ? null
          : overflow.length === 1
            ? `Catálogo de skills em níveis: ${overflow[0]} não coube no teto de ${kb} KB das skills de nível alto e foi tratada como de nível médio nesta conversa.`
            : `Catálogo de skills em níveis: ${overflow.join(', ')} não couberam no teto de ${kb} KB das skills de nível alto e foram tratadas como de nível médio nesta conversa.`
      if (included.length === 0) return { text: '', warning }
      const body = included
        .map(({ skill, text }) => `### Skill de nível alto: ${skill.name} (${skill.skillFile})\n\n${text.trim()}`)
        .join('\n\n')
      return {
        text: `## Skills de nível alto\n\nAs skills abaixo valem para TODA tarefa desta conversa. O texto inteiro já está aqui: siga-as sem precisar chamá-las.\n\n${body}`,
        warning
      }
    },
    nativeExpected(discovered) {
      const native = new Set(highFit(discovered).tiers.filter((s) => s.tier !== 'low').map((s) => s.name))
      return discovered.filter((s) => native.has(s.name))
    },
    announce(confirmed, discovered) {
      const { tiers, included } = highFit(discovered)
      const confirmedNames = new Set(confirmed.skills.map((s) => s.name))
      const inPrompt = new Set(included.map((c) => c.skill.name))
      const high = tiers.filter((s) => inPrompt.has(s.name))
      const medium = tiers.filter((s) => !inPrompt.has(s.name) && s.tier !== 'low' && confirmedNames.has(s.name))
      const low = tiers.filter((s) => s.tier === 'low')
      const catalog = renderTieredCatalog(high, medium, low)
      return {
        skills: confirmed.skills,
        catalog,
        version: createHash('sha256').update(catalog).digest('hex')
      }
    },
    rewriteCommand(text, discovered) {
      const m = SLASH.exec(text.trimStart())
      if (!m) return text
      const skill = resolveSkillTiers(discovered, config.overrides).find((s) => s.name === m[1] && s.tier === 'low')
      if (!skill) return text
      const rest = m[2].trim()
      const head = `Leia e siga a skill ${skill.name}: abra ${skill.skillFile} com Read e siga as instruções dela.`
      return rest ? `${head}\n\n${rest}` : head
    }
  }
}

function renderTieredCatalog(high: TieredSkill[], medium: TieredSkill[], low: TieredSkill[]): string {
  const byCategory = SKILL_CATEGORIES.map((category) => [category, low.filter((s) => s.category === category)] as const)
    .filter(([, list]) => list.length > 0)
    .map(([category, list]) => `- ${category}: ${list.map((s) => s.name).sort((a, b) => a.localeCompare(b)).join(', ')}`)
  return `AUTHORITATIVE FILESYSTEM SKILLS CATALOG (tiered)
This is the complete current catalog of the skills on disk, in three tiers. It supersedes earlier skill catalogs.
Before acting on every user request, check whether a skill fits — in all three tiers — and use it FIRST.

High (full text already in the system prompt — follow it, no need to load):
${high.length ? high.map((s) => `- ${s.name}`).join('\n') : '(none)'}

Medium (the Skill tool lists their descriptions; load with the Skill tool, or Read the SKILL.md):
${medium.length ? medium.map((s) => `- /${s.name} — ${s.skillFile}`).join('\n') : '(none)'}

Low (name only, by category; the Skill tool does NOT load these). When a request might need one, call
mcp__skills__skills_buscar(texto) or mcp__skills__skills_listar(categoria): they return a one-line summary and the
SKILL.md path. Then Read that SKILL.md and follow it. Most descriptions are in English: search with English words too.
${byCategory.length ? byCategory.join('\n') : '(none)'}`
}
