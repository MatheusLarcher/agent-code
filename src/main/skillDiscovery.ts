import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { createHash } from 'node:crypto'

const MAX_FRONTMATTER_BYTES = 64 * 1024
const VALID_SKILL_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

export type SkillSource = 'project-claude' | 'user-claude'

export interface DiscoveredSkill {
  name: string
  /** O `name` do frontmatter quando difere da pasta ("AI & LLM Security"): é por
   *  ele que o CLI anuncia a skill no `init.skills`. Ausente = igual à pasta. */
  displayName?: string
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
  const fields = parseFrontmatterFields(md)
  if (!fields || !VALID_SKILL_NAME.test(fields.name)) return null
  return fields
}

/** Frontmatter fields without validating `name`. The SDK identifies a skill by
 * its folder, so a display name ("Web Application Security Testing") must not
 * hide it from the catalog. */
function parseFrontmatterFields(md: string): { name: string; description: string } | null {
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
        if (!VALID_SKILL_NAME.test(entry.name) || byName.has(entry.name)) continue
        const parsed = parseFrontmatterFields(readFrontmatterPrefix(skillFile))
        byName.set(entry.name, {
          name: entry.name,
          ...(parsed?.name && parsed.name !== entry.name ? { displayName: parsed.name } : {}),
          description: parsed?.description ?? '',
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

const NO_SKILLS = '(no filesystem skills are currently available)'

/**
 * Só a regra: cada skill daqui foi confirmada pelo `reloadSkills()`, e a lista
 * de skills do próprio SDK já leva nome e descrição de todas. Repetir o catálogo
 * aqui mandava o mesmo texto duas vezes por conversa (~8k tokens).
 */
export function renderAgentSkillCatalog(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return `FILESYSTEM SKILLS\n${NO_SKILLS}`
  return `FILESYSTEM SKILLS: ${skills.length} skills are loaded in the Skill tool; the runtime's skill listing shows each name and description (not repeated here).
Before acting on each user request, compare it with those descriptions. When the user names a skill or the request clearly matches one, load it with the Skill tool FIRST and follow it. Never claim a skill was loaded unless the Skill tool call succeeded.`
}

const skillLine = (skill: DiscoveredSkill): string =>
  `- /${skill.name}\n  Description: ${skill.description || '(missing description in SKILL.md frontmatter)'}`

/**
 * O que mudou desde o que o modelo já viu (a lista do SDK na subida, ou o último
 * anúncio). A lista do SDK só anuncia nome novo: descrição trocada e skill
 * removida não chegam por ela, então vão aqui. `head` abre o bloco.
 */
export function renderSkillCatalogChange(
  previous: readonly DiscoveredSkill[],
  next: readonly DiscoveredSkill[],
  head = `FILESYSTEM SKILLS changed (${next.length} available). Use the Skill tool as before.`
): string {
  if (next.length === 0) return `FILESYSTEM SKILLS\n${NO_SKILLS}`
  const before = new Map(previous.map((s) => [s.name, s]))
  const changed = next.filter((s) => {
    const old = before.get(s.name)
    return !old || old.description !== s.description || old.skillFile !== s.skillFile
  })
  const names = new Set(next.map((s) => s.name))
  const removed = previous.filter((s) => !names.has(s.name)).map((s) => s.name)
  const parts = [head]
  if (changed.length) parts.push(`Added or updated:\n${changed.map(skillLine).join('\n')}`)
  if (removed.length) parts.push(`Removed (no longer available): ${removed.join(', ')}`)
  return parts.join('\n\n')
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

/**
 * `since.skills` = o que o modelo já viu nesta conversa (a lista do SDK na subida
 * ou o último anúncio): vai só a diferença. Sem `since.announced`, a regra
 * (`snapshot.catalog`) abre o bloco. Sem `since`, vai o catálogo inteiro.
 */
export function renderSkillCatalogUpdate(
  snapshot: SkillCatalogSnapshot,
  since?: { skills: readonly DiscoveredSkill[]; announced: boolean } | null
): string {
  const body = since
    ? renderSkillCatalogChange(since.skills, snapshot.skills, since.announced ? undefined : snapshot.catalog)
    : snapshot.catalog
  return `[SKILL_CATALOG_UPDATE]
Automatic skill catalog refresh (newer than any earlier one). Do not mention it to the user unless it blocks the task.\n\n${body}
[/SKILL_CATALOG_UPDATE]`
}
