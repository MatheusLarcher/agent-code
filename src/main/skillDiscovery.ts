import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'

const MAX_FRONTMATTER_BYTES = 64 * 1024
const VALID_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

export type SkillSource = 'project-claude' | 'project-agents' | 'cache' | 'user-claude'

export interface DiscoveredSkill {
  name: string
  description: string
  skillFile: string
  root: string
  source: SkillSource
  native: boolean
}

export function parseSkillFrontmatter(md: string): { name: string; description: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)
  if (!m) return null
  const lines = m[1].split(/\r?\n/)
  let name = ''
  let description = ''
  for (let i = 0; i < lines.length; i++) {
    const nameM = /^name:\s*(.+)$/.exec(lines[i])
    if (nameM) {
      name = nameM[1].trim().replace(/^['"]|['"]$/g, '')
      continue
    }
    const descM = /^description:\s*(.*)$/.exec(lines[i])
    if (!descM) continue
    const inline = descM[1].trim()
    if (inline === '' || /^[>|][-+]?$/.test(inline)) {
      const buf: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s/.test(lines[j]) || lines[j].trim() === '') buf.push(lines[j].trim())
        else break
      }
      description = buf.join(' ').trim()
    } else {
      description = inline.replace(/^['"]|['"]$/g, '')
    }
  }
  if (!VALID_SKILL_NAME.test(name)) return null
  return { name, description: description.replace(/\s+/g, ' ').trim() }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function canonicalDirectory(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * `cacheSkillsRoot` is the active per-user skill store. It remains stable when
 * the user opens a chat for another project and follows cache-folder changes.
 */
export function discoverSkills(
  projectRoot: string,
  userHome: string = homedir(),
  cacheSkillsRoot: string = ''
): DiscoveredSkill[] {
  const project = projectRoot && isAbsolute(projectRoot) ? resolve(projectRoot) : ''
  const cache = cacheSkillsRoot && isAbsolute(cacheSkillsRoot) ? resolve(cacheSkillsRoot) : ''
  const roots: Array<{ path: string; source: SkillSource; native: boolean }> = [
    ...(project ? [{ path: join(project, '.claude', 'skills'), source: 'project-claude' as const, native: true }] : []),
    ...(project ? [{ path: join(project, '.agents', 'skills'), source: 'project-agents' as const, native: false }] : []),
    ...(cache ? [{ path: cache, source: 'cache' as const, native: true }] : []),
    { path: join(userHome, '.claude', 'skills'), source: 'user-claude', native: true }
  ]

  const byName = new Map<string, DiscoveredSkill>()
  for (const candidateRoot of roots) {
    const root = canonicalDirectory(candidateRoot.path)
    if (!root) continue
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const skillFile = realpathSync(join(root, entry.name, 'SKILL.md'))
        if (!inside(root, skillFile) || statSync(skillFile).size > MAX_FRONTMATTER_BYTES) continue
        const parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'))
        if (!parsed || byName.has(parsed.name)) continue
        byName.set(parsed.name, { ...parsed, skillFile, root, source: candidateRoot.source, native: candidateRoot.native })
      } catch {
        // Broken, unreadable or escaping entries are not available to either UI or runtime.
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function renderAgentSkillCatalog(skills: DiscoveredSkill[]): string {
  const adapted = skills.filter((skill) => !skill.native)
  if (adapted.length === 0) return ''
  const lines = adapted.map((skill) => `- /${skill.name} — ${skill.description || 'sem descrição'}\n  SKILL.md: ${skill.skillFile}`)
  return `PROJECT SKILLS FROM .agents/skills
The skills below are available even though this directory is not discovered natively by Claude Code.
When the user sends /<name>, or their request clearly matches a description below, Read that skill's
SKILL.md FIRST and follow it before doing anything else. Load files referenced by SKILL.md only as
needed. Never claim that a skill was loaded unless Read succeeded.\n\n${lines.join('\n')}`
}
