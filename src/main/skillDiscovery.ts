import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { createHash } from 'node:crypto'

const MAX_FRONTMATTER_BYTES = 64 * 1024
const VALID_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

export type SkillSource = 'project-claude' | 'user-claude'

export interface DiscoveredSkill {
  name: string
  description: string
  skillFile: string
  root: string
  source: SkillSource
  native: boolean
  modifiedAtMs: number
  sizeBytes: number
}

export interface SkillCatalogSnapshot {
  skills: DiscoveredSkill[]
  catalog: string
  version: string
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

function canonicalDirectory(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function readFrontmatterPrefix(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function candidateSkillRoots(
  projectRoot: string,
  userHome: string
): Array<{ path: string; source: SkillSource; native: boolean }> {
  const project = projectRoot && isAbsolute(projectRoot) ? resolve(projectRoot) : ''
  return [
    ...(project ? [{ path: join(project, '.claude', 'skills'), source: 'project-claude' as const, native: true }] : []),
    { path: join(userHome, '.claude', 'skills'), source: 'user-claude', native: true }
  ]
}

function skillEntries(root: string): Dirent[] {
  try {
    return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** Cheap tree signature used before every user dispatch. It deliberately reads
 * only directory entries plus SKILL.md metadata; frontmatter is parsed only
 * after this signature changes. */
export function skillCatalogFilesystemVersion(
  projectRoot: string,
  userHome: string = homedir()
): string {
  const versionInput: Array<{ source: SkillSource; skillFile: string; modifiedAtMs: number; sizeBytes: number }> = []
  for (const candidate of candidateSkillRoots(projectRoot, userHome)) {
    const root = canonicalDirectory(candidate.path)
    if (!root) continue
    for (const entry of skillEntries(root)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const skillFile = realpathSync(join(root, entry.name, 'SKILL.md'))
        const metadata = statSync(skillFile)
        versionInput.push({
          source: candidate.source,
          skillFile,
          modifiedAtMs: metadata.mtimeMs,
          sizeBytes: metadata.size
        })
      } catch {
        // Missing and broken entries are not part of the available catalog.
      }
    }
  }
  return createHash('sha256').update(JSON.stringify(versionInput)).digest('hex')
}

/**
 * Only roots the SDK itself scans are catalogued. Cache skills reach the model
 * because `exposeCacheSkills` materializes them inside the user root.
 */
export function discoverSkills(
  projectRoot: string,
  userHome: string = homedir()
): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>()
  for (const candidateRoot of candidateSkillRoots(projectRoot, userHome)) {
    const root = canonicalDirectory(candidateRoot.path)
    if (!root) continue
    for (const entry of skillEntries(root)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      try {
        const skillFile = realpathSync(join(root, entry.name, 'SKILL.md'))
        const metadata = statSync(skillFile)
        const parsed = parseSkillFrontmatter(readFrontmatterPrefix(skillFile))
        if (!parsed || parsed.name !== entry.name || byName.has(parsed.name)) continue
        byName.set(parsed.name, {
          ...parsed,
          skillFile,
          root,
          source: candidateRoot.source,
          native: candidateRoot.native,
          modifiedAtMs: metadata.mtimeMs,
          sizeBytes: metadata.size
        })
      } catch {
        // Broken, unreadable or escaping entries are not available to either UI or runtime.
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function renderAgentSkillCatalog(skills: DiscoveredSkill[]): string {
  const lines = skills.map(
    (skill) =>
      `- /${skill.name}\n  Description: ${skill.description || '(missing description in SKILL.md frontmatter)'}\n  SKILL.md: ${skill.skillFile}`
  )
  return `AUTHORITATIVE FILESYSTEM SKILLS CATALOG
This is the complete current catalog of every skill discovered in the configured project, Agent Code,
cache, and user-global filesystem roots. It supersedes shorter or incomplete listings of those skills;
SDK-bundled commands that have no SKILL.md in these roots may still be listed separately by the runtime.
Before acting on every user request, compare it with ALL descriptions below. When the user names a skill,
or the request clearly matches a description, load that skill through the Skill tool FIRST and follow it.
Every filesystem skill listed here has been exposed through a native SDK root; never claim that a skill was
loaded unless the Skill tool call succeeded.\n\n${lines.length > 0 ? lines.join('\n') : '(no filesystem skills are currently available)'}`
}

export function createSkillCatalogSnapshot(skills: DiscoveredSkill[]): SkillCatalogSnapshot {
  const catalog = renderAgentSkillCatalog(skills)
  const versionInput = skills.map(({ name, description, skillFile, source, modifiedAtMs, sizeBytes }) => ({
    name,
    description,
    skillFile,
    source,
    modifiedAtMs,
    sizeBytes
  }))
  return {
    skills,
    catalog,
    version: createHash('sha256').update(JSON.stringify(versionInput)).digest('hex')
  }
}

export function renderSkillCatalogUpdate(snapshot: SkillCatalogSnapshot): string {
  return `[SKILL_CATALOG_UPDATE]
The skills on disk changed after this conversation started. Replace every earlier skill catalog with the
complete authoritative catalog below. Do not mention this automatic refresh to the user unless it blocks
the task.\n\n${snapshot.catalog}
[/SKILL_CATALOG_UPDATE]`
}
