// @vitest-environment node
// Tamanho do contexto fixo (bytes/4 ≈ tokens). ANTES = os mesmos blocos no HEAD
// 8a69137, medidos com os escapes resolvidos (o texto que vai ao modelo).
import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ANDROID_HINT, ANDROID_SHORT_HINT, BROWSER_HINT, DOWNLOAD_HINT } from './browser/hints'
import { CHROME_CONTROL_HINT } from './chromeBridge/hint'
import { AGENT_RULES_HINT } from './agents/agentRules'
import { discoverSkills, renderAgentSkillCatalog, type DiscoveredSkill } from './skillDiscovery'

const BEFORE: Record<string, number> = {
  BROWSER_HINT: 1583,
  ANDROID_HINT: 1599,
  ANDROID_SHORT_HINT: 168,
  DOWNLOAD_HINT: 782,
  CHROME_CONTROL_HINT: 1252,
  AGENT_RULES_HINT: 2051
}

const AFTER: Record<string, string> = {
  BROWSER_HINT,
  ANDROID_HINT,
  ANDROID_SHORT_HINT,
  DOWNLOAD_HINT,
  CHROME_CONTROL_HINT,
  AGENT_RULES_HINT
}

/** O catálogo como era no HEAD: cabeçalho + nome, descrição e caminho de cada skill. */
function oldCatalog(skills: DiscoveredSkill[]): string {
  const lines = skills.map(
    (s) => `- /${s.name}\n  Description: ${s.description || '(missing description in SKILL.md frontmatter)'}\n  SKILL.md: ${s.skillFile}`
  )
  return `AUTHORITATIVE FILESYSTEM SKILLS CATALOG
This is the complete current catalog of every skill discovered in the configured project, Agent Code,
cache, and user-global filesystem roots. It supersedes shorter or incomplete listings of those skills;
SDK-bundled commands that have no SKILL.md in these roots may still be listed separately by the runtime.
Before acting on every user request, compare it with ALL descriptions below. When the user names a skill,
or the request clearly matches a description, load that skill through the Skill tool FIRST and follow it.
Every filesystem skill listed here has been exposed through a native SDK root; never claim that a skill was
loaded unless the Skill tool call succeeded.

${lines.join('\n') || '(no filesystem skills are currently available)'}`
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const row = (name: string, before: number, after: number): string =>
  `${name.padEnd(30)} ${String(before).padStart(7)} B ~${String(Math.round(before / 4)).padStart(5)} tok -> ${String(after).padStart(6)} B ~${String(Math.round(after / 4)).padStart(5)} tok`

describe('orçamento do contexto fixo', () => {
  it('instruções fixas encolheram, bloco a bloco', () => {
    const table: string[] = []
    let totalBefore = 0
    let totalAfter = 0
    for (const [name, before] of Object.entries(BEFORE)) {
      const after = bytes(AFTER[name])
      table.push(row(name, before, after))
      totalBefore += before
      totalAfter += after
      expect(after, name).toBeLessThanOrEqual(before)
    }
    table.push(row('TOTAL instruções', totalBefore, totalAfter))
    console.log(table.join('\n'))
    expect(totalAfter).toBeLessThan(totalBefore * 0.85)
  })

  it('catálogo de skills: tamanho fixo, não cresce com o número de skills', () => {
    const fake = (n: number): DiscoveredSkill[] =>
      Array.from({ length: n }, (_, i) => ({
        name: `skill-${i}`,
        description: 'Descrição típica de uma skill, com quando usar e o que ela cobre, em uma ou duas frases.'.repeat(2),
        skillFile: `C:\\Users\\me\\.claude\\skills\\skill-${i}\\SKILL.md`,
        root: 'C:\\Users\\me\\.claude\\skills',
        source: 'user-claude' as const,
        native: true,
        modifiedAtMs: 0,
        sizeBytes: 0
      }))
    const real = discoverSkills(process.cwd(), homedir())
    const table = [
      ...[10, 100].map((n) => row(`catálogo (${n} skills sintéticas)`, bytes(oldCatalog(fake(n))), bytes(renderAgentSkillCatalog(fake(n))))),
      row(`catálogo (${real.length} skills desta máquina)`, bytes(oldCatalog(real)), bytes(renderAgentSkillCatalog(real)))
    ]
    console.log(table.join('\n'))
    expect(renderAgentSkillCatalog(fake(100)).length).toBeLessThan(500)
    expect(bytes(renderAgentSkillCatalog(fake(100)))).toBeLessThan(bytes(oldCatalog(fake(1))))
  })
})
