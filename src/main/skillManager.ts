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
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

const MANIFEST_NAME = '.agent-code-managed.json'
const BUNDLED_MANIFEST_NAME = '.agent-code-bundled.json'
const VALID_SKILL_DIRECTORY = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u

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
      .filter((name) => VALID_SKILL_DIRECTORY.test(name))
      .filter((name) => !name.endsWith('.agent-code-new'))
      .filter((name) => existsSync(join(root, name, 'SKILL.md')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

function directoryDigest(root: string): string {
  const hash = createHash('sha256')
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const key = relative(root, path).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        hash.update(`d:${key}\0`)
        visit(path)
      } else if (entry.isSymbolicLink()) {
        hash.update(`l:${key}:${readlinkSync(path)}\0`)
      } else if (entry.isFile()) {
        hash.update(`f:${key}:`)
        hash.update(readFileSync(path))
        hash.update('\0')
      }
    }
  }
  try {
    visit(root)
    return hash.digest('hex')
  } catch {
    return ''
  }
}

/** Content version of the bundled skill source. Sessions compare it before each
 * user dispatch so a newly installed versioned skill can be materialized without
 * restarting the application. */
export function managedSkillsFilesystemVersion(appRoot: string): string {
  return directoryDigest(join(appRoot, '.agents', 'skills'))
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function safeSkillPath(root: string, name: string): string | null {
  if (!VALID_SKILL_DIRECTORY.test(name)) return null
  const candidate = resolve(root, name)
  return isInside(root, candidate) ? candidate : null
}

function readManagedLinks(globalRoot: string): Map<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(globalRoot, MANIFEST_NAME), 'utf8')) as {
      version?: number
      skills?: unknown
    }
    if (parsed.version === 2 && parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)) {
      return new Map(
        Object.entries(parsed.skills)
          .filter(([name, target]) => VALID_SKILL_DIRECTORY.test(name) && typeof target === 'string')
          .map(([name, target]) => [name, target === '' ? '' : normalize(resolve(target))])
      )
    }
    if (Array.isArray(parsed.skills)) {
      return new Map(
        parsed.skills
          .filter((name): name is string => typeof name === 'string' && VALID_SKILL_DIRECTORY.test(name))
          .map((name) => [name, ''])
      )
    }
  } catch {
    // Missing or malformed manifests are treated as unmanaged.
  }
  return new Map()
}

function writeManagedLinks(globalRoot: string, links: Map<string, string>): void {
  writeFileSync(
    join(globalRoot, MANIFEST_NAME),
    JSON.stringify(
      { version: 2, skills: Object.fromEntries([...links].sort(([a], [b]) => a.localeCompare(b))) },
      null,
      2
    ),
    'utf8'
  )
}

function readManaged(globalRoot: string, manifestName: string = MANIFEST_NAME): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(globalRoot, manifestName), 'utf8')) as Partial<ManagedManifest>
    return new Set(Array.isArray(parsed.skills) ? parsed.skills.filter((name): name is string => typeof name === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeManaged(globalRoot: string, names: string[], manifestName: string = MANIFEST_NAME): void {
  writeFileSync(
    join(globalRoot, manifestName),
    JSON.stringify({ version: 1, skills: [...names].sort((a, b) => a.localeCompare(b)) }, null, 2),
    'utf8'
  )
}

function linkTarget(path: string): string {
  const raw = readlinkSync(path)
  return normalize(isAbsolute(raw) ? raw : resolve(dirname(path), raw))
}

function isLegacyAgentCodeTarget(target: string): boolean {
  const normalized = target.toLowerCase()
  return normalized.includes(`${normalize('.agents/skills').toLowerCase()}`) || normalized.includes(`${normalize('.agents\\skills').toLowerCase()}`)
}

function replaceDirectory(source: string, destination: string): void {
  if (directoryDigest(source) === directoryDigest(destination)) return
  const staged = `${destination}.agent-code-new`
  rmSync(staged, { recursive: true, force: true })
  try {
    cpSync(source, staged, { recursive: true, force: true, preserveTimestamps: true })
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

/** True when the global-root entry for `name` belongs to Agent Code. A managed
 * entry is either recorded in the manifest or still a junction pointing into the
 * active cache / a former `.agents/skills` checkout. */
function ownsGlobalEntry(
  link: string,
  name: string,
  skillsDir: string,
  previouslyManaged: Map<string, string>
): boolean {
  if (previouslyManaged.has(name)) return true
  try {
    if (!lstatSync(link).isSymbolicLink()) return false
    const current = linkTarget(link)
    return isInside(skillsDir, current) || isLegacyAgentCodeTarget(current)
  } catch {
    return false
  }
}

function removeGlobalEntry(link: string): void {
  try {
    if (lstatSync(link).isSymbolicLink()) {
      unlinkSync(link)
      return
    }
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  rmSync(link, { recursive: true, force: true })
}

/**
 * Expose every cache skill inside the native Claude Code user root as a REAL
 * directory. Junctions cannot be used here: on Windows a junction is reported as
 * `isDirectory() === false`, so the SDK's skill scanner skips it and the Skill
 * tool answers `Unknown skill` for a skill the catalog just advertised.
 */
export function exposeCacheSkills(skillsDir: string, userHome: string = homedir()): SkillSyncResult {
  const globalRoot = join(userHome, '.claude', 'skills')
  const errors: string[] = []
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  const available = skillNames(skillsDir)
  const availableSet = new Set(available)
  const previouslyManaged = readManagedLinks(globalRoot)
  const managedNow = new Map<string, string>()

  for (const [name, previousSource] of previouslyManaged) {
    if (availableSet.has(name)) continue
    const link = safeSkillPath(globalRoot, name)
    if (!link) {
      errors.push(`Manifesto de skills contém nome inválido: ${name}`)
      continue
    }
    try {
      removeGlobalEntry(link)
    } catch (error) {
      errors.push(`Não foi possível remover a skill obsoleta ${name}: ${String(error)}`)
      managedNow.set(name, previousSource)
    }
  }

  for (const name of available) {
    const destination = safeSkillPath(globalRoot, name)
    const source = safeSkillPath(skillsDir, name)
    if (!destination || !source) {
      errors.push(`Não foi possível expor uma skill com nome inválido: ${name}`)
      continue
    }
    const sourcePath = normalize(resolve(source))
    try {
      const exists = (() => {
        try {
          lstatSync(destination)
          return true
        } catch (error) {
          if (isMissing(error)) return false
          throw error
        }
      })()

      if (exists && !ownsGlobalEntry(destination, name, skillsDir, previouslyManaged)) {
        // A real user installation wins; never replace what Agent Code does not own.
        continue
      }
      const alreadyCurrent = exists && !lstatSync(destination).isSymbolicLink() &&
        directoryDigest(destination) === directoryDigest(sourcePath)
      if (!alreadyCurrent) {
        if (exists) removeGlobalEntry(destination)
        replaceDirectory(sourcePath, destination)
      }
      managedNow.set(name, sourcePath)
    } catch (error) {
      errors.push(`Não foi possível expor a skill ${name}: ${String(error)}`)
      managedNow.set(name, previouslyManaged.get(name) ?? sourcePath)
    }
  }

  for (const entry of readdirSync(globalRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.agent-code-new')) continue
    try {
      removeGlobalEntry(join(globalRoot, entry.name))
    } catch {
      // A leftover staging folder is cosmetic; never fail the exposure for it.
    }
  }

  try {
    writeManagedLinks(globalRoot, managedNow)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills: ${String(error)}`)
  }
  return { skillsDir, available, errors }
}

/** `<cacheDir>/native` — the extra root handed to the SDK (`additionalDirectories`). */
export function nativeSkillRoot(cacheDir: string): string {
  return join(cacheDir, 'native')
}

/**
 * Make the cache skills reachable by the Claude Code CLI the way it actually
 * discovers them when driven through the Agent SDK.
 *
 * Measured against the bundled CLI (SDK 0.3.257): with `skills: 'all'` and
 * `settingSources: ['user','project','local']` it loads `<cwd>/.claude/skills`
 * and `<additionalDirectory>/.claude/skills`, but NOT `~/.claude/skills` — the
 * user root that `exposeCacheSkills` fills was silently ignored, so every
 * managed skill answered `Unknown skill`. A junction placed at the
 * `.claude/skills` level of an additional directory IS followed, so we keep a
 * single copy of the skills and point `<cacheDir>/native/.claude/skills` at it.
 *
 * `~/.claude/skills` is still populated for the interactive `claude` CLI and
 * older SDKs; this root is what the in-app sessions rely on.
 *
 * Never clobbers a real directory at that path (only links are replaced), and
 * refuses to create anything when the cache dir itself does not exist yet.
 */
export function ensureNativeSkillRoot(cacheDir: string, skillsDir: string = join(cacheDir, 'skills')): {
  root: string
  errors: string[]
} {
  const root = nativeSkillRoot(cacheDir)
  const errors: string[] = []
  if (!existsSync(cacheDir)) {
    errors.push(`Pasta de dados inexistente, raiz nativa de skills não criada: ${cacheDir}`)
    return { root, errors }
  }
  const claudeDir = join(root, '.claude')
  const link = join(claudeDir, 'skills')
  const target = normalize(resolve(skillsDir))
  try {
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(claudeDir, { recursive: true })
    let current: ReturnType<typeof lstatSync> | null = null
    try {
      current = lstatSync(link)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (current) {
      if (!current.isSymbolicLink()) {
        errors.push(`Já existe um diretório real em ${link}; não será substituído.`)
        return { root, errors }
      }
      if (linkTarget(link) === target) return { root, errors }
      unlinkSync(link)
    }
    // 'junction' is what works without admin rights on Windows; other platforms
    // ignore the type and create a plain symlink.
    symlinkSync(target, link, 'junction')
  } catch (error) {
    errors.push(`Não foi possível criar a raiz nativa de skills em ${link}: ${String(error)}`)
  }
  return { root, errors }
}

/**
 * Materialize bundled skills in the selected cache and expose them through the
 * native Claude Code user-level skill directory. External cache skills are
 * retained; real user directories in the global skill root are never replaced.
 */
export function syncCacheSkills(appRoot: string, cacheDir: string, userHome: string = homedir()): SkillSyncResult {
  const bundledRoot = join(appRoot, '.agents', 'skills')
  const skillsDir = join(cacheDir, 'skills')
  const errors: string[] = []
  mkdirSync(skillsDir, { recursive: true })
  // Upgrade the old name-only link manifest while every prior cache target is
  // still present. The final exposure pass can then safely remove stale links
  // by comparing their recorded target.
  errors.push(...exposeCacheSkills(skillsDir, userHome).errors)

  const bundled = skillNames(bundledRoot)
  const bundledSet = new Set(bundled)
  for (const stale of readManaged(skillsDir, BUNDLED_MANIFEST_NAME)) {
    if (bundledSet.has(stale)) continue
    const target = safeSkillPath(skillsDir, stale)
    if (!target) {
      errors.push(`Manifesto de skills empacotadas contém nome inválido: ${stale}`)
      continue
    }
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      errors.push(`Não foi possível remover a skill descontinuada ${stale}: ${String(error)}`)
    }
  }
  for (const name of bundled) {
    try {
      replaceDirectory(join(bundledRoot, name), join(skillsDir, name))
    } catch (error) {
      errors.push(`Não foi possível sincronizar a skill ${name}: ${String(error)}`)
    }
  }
  try {
    writeManaged(skillsDir, bundled, BUNDLED_MANIFEST_NAME)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills empacotadas: ${String(error)}`)
  }

  const exposed = exposeCacheSkills(skillsDir, userHome)
  return { ...exposed, errors: [...errors, ...exposed.errors] }
}
