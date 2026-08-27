import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

const MANIFEST_NAME = '.agent-code-managed.json'

interface ManagedManifest {
  version: 1
  skills: string[]
}

export interface SkillSyncResult {
  skillsDir: string
  available: string[]
  errors: string[]
}

function skillNames(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('.agent-code-new'))
      .filter((name) => existsSync(join(root, name, 'SKILL.md')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function readManaged(globalRoot: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(globalRoot, MANIFEST_NAME), 'utf8')) as Partial<ManagedManifest>
    return new Set(Array.isArray(parsed.skills) ? parsed.skills.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeManaged(globalRoot: string, names: string[]): void {
  writeFileSync(
    join(globalRoot, MANIFEST_NAME),
    JSON.stringify({ version: 1, skills: [...names].sort((a, b) => a.localeCompare(b)) }, null, 2),
    'utf8'
  )
}

function linkTarget(path: string): string {
  try {
    const raw = readlinkSync(path)
    return normalize(isAbsolute(raw) ? raw : resolve(dirname(path), raw))
  } catch {
    return ''
  }
}

function isLegacyAgentCodeLink(path: string): boolean {
  const target = linkTarget(path).toLowerCase()
  return target.includes(`${normalize('.agents/skills').toLowerCase()}`) || target.includes(`${normalize('.agents\\skills').toLowerCase()}`)
}

function replaceDirectory(source: string, destination: string): void {
  const staged = `${destination}.agent-code-new`
  rmSync(staged, { recursive: true, force: true })
  try {
    cpSync(source, staged, { recursive: true, force: true })
    rmSync(destination, { recursive: true, force: true })
    try {
      renameSync(staged, destination)
    } catch {
      // Cloud-sync clients can briefly deny directory renames. The original
      // destination is already gone, so finish with a direct recursive copy.
      cpSync(staged, destination, { recursive: true, force: true })
    }
  } finally {
    rmSync(staged, { recursive: true, force: true })
  }
}

/**
 * Materialize bundled skills in the selected cache and expose them through the
 * native Claude Code user-level skill directory. External cache skills are
 * retained; real user directories in the global skill root are never replaced.
 */
export function syncCacheSkills(appRoot: string, cacheDir: string, userHome: string = homedir()): SkillSyncResult {
  const bundledRoot = join(appRoot, '.agents', 'skills')
  const skillsDir = join(cacheDir, 'skills')
  const globalRoot = join(userHome, '.claude', 'skills')
  const errors: string[] = []
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  const bundled = skillNames(bundledRoot)
  for (const name of bundled) {
    try {
      replaceDirectory(join(bundledRoot, name), join(skillsDir, name))
    } catch (error) {
      errors.push(`Não foi possível sincronizar a skill ${name}: ${String(error)}`)
    }
  }

  const available = skillNames(skillsDir)
  const previouslyManaged = readManaged(globalRoot)
  const managedNow: string[] = []
  for (const name of available) {
    const link = join(globalRoot, name)
    const target = join(skillsDir, name)
    try {
      if (existsSync(link)) {
        const stat = lstatSync(link)
        if (stat.isSymbolicLink() && (previouslyManaged.has(name) || isLegacyAgentCodeLink(link))) {
          if (linkTarget(link) !== normalize(resolve(target))) {
            rmSync(link, { recursive: true, force: true })
            symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
          }
          managedNow.push(name)
        }
        continue
      }

      // A dangling junction is false for existsSync but remains visible to lstat.
      try {
        const stat = lstatSync(link)
        if (!stat.isSymbolicLink() || (!previouslyManaged.has(name) && !isLegacyAgentCodeLink(link))) continue
        rmSync(link, { recursive: true, force: true })
      } catch {
        // Truly absent: create it below.
      }
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      managedNow.push(name)
    } catch (error) {
      errors.push(`Não foi possível expor a skill ${name}: ${String(error)}`)
    }
  }

  try {
    writeManaged(globalRoot, managedNow)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills: ${String(error)}`)
  }
  return { skillsDir, available, errors }
}
