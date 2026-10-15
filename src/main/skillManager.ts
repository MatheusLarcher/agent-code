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
import { homedir, hostname } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
// Sem devDataDir (que importa 'electron'): este módulo roda também no worker de
// sincronização (skills/skillSyncWorker.ts). Quem chama resolve a home do dev.
import { directoryDigest, skillNames, VALID_SKILL_DIRECTORY } from './skillDirs'
import { bundledSkillSources, kitSkillNames, kitsDigest, type SkillKitId } from './skillKits'

const MANIFEST_NAME = '.agent-code-managed.json'
const BUNDLED_MANIFEST_NAME = '.agent-code-bundled.json'
/** Seeds already applied to this cache (shared on purpose: it is a property of the cache). */
const SEEDED_MANIFEST_NAME = '.agent-code-seeded.json'
/** Legacy import manifest shared by every machine on the synced cache; read only to migrate. */
const LEGACY_IMPORTED_MANIFEST_NAME = '.agent-code-imported.json'

/** Per-machine import manifest: the cache is shared via OneDrive but `~/.claude/skills` is
 * local, so a shared list made one machine delete every skill another had imported. */
function importedManifestName(machine: string): string {
  return `.agent-code-imported.${machine.replace(/[^A-Za-z0-9_-]/g, '_') || 'local'}.json`
}
interface ManagedManifest {
  version: 1
  skills: string[]
}

export interface SkillSyncResult {
  skillsDir: string
  available: string[]
  errors: string[]
}

/** Content version of the bundled skill source. Sessions compare it before each
 * user dispatch so a newly installed versioned skill can be materialized without
 * restarting the application. Active kits enter the version, so flipping a kit's
 * switch also triggers a re-sync; without kits it is the plain digest of before. */
export function managedSkillsFilesystemVersion(appRoot: string, kits: readonly SkillKitId[] = []): string {
  return [directoryDigest(join(appRoot, '.agents', 'skills')), ...kitsDigest(appRoot, kits)].join('|')
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
export function exposeCacheSkills(skillsDir: string, userHome: string = homedir(), machine: string = hostname()): SkillSyncResult {
  const globalRoot = join(userHome, '.claude', 'skills')
  const errors: string[] = []
  mkdirSync(skillsDir, { recursive: true })
  mkdirSync(globalRoot, { recursive: true })

  errors.push(...importUserSkills(skillsDir, userHome, machine))
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

/**
 * Pull skills the user installed for Claude itself (real directories in
 * `~/.claude/skills`) into the cache, the single copy the SDK-driven CLI reads.
 * Nothing is linked back, so a skill is never listed twice. Never touches what
 * Agent Code exposed there, and never overrides a bundled or user-made cache
 * skill of the same name. Imports that vanished from `~/.claude` are removed.
 */
export function importUserSkills(skillsDir: string, userHome: string = homedir(), machine: string = hostname()): string[] {
  const errors: string[] = []
  const globalRoot = join(userHome, '.claude', 'skills')
  const manifestName = importedManifestName(machine)
  const managedByUs = readManagedLinks(globalRoot)
  const bundled = readManaged(skillsDir, BUNDLED_MANIFEST_NAME)
  const localSkills = skillNames(globalRoot)
  // First per-machine run: adopt from the legacy list only skills present in THIS ~/.claude/skills.
  const previouslyImported = existsSync(join(skillsDir, manifestName))
    ? readManaged(skillsDir, manifestName)
    : new Set([...readManaged(skillsDir, LEGACY_IMPORTED_MANIFEST_NAME)].filter((name) => localSkills.includes(name)))
  const imported = new Set<string>()

  for (const name of localSkills) {
    const source = safeSkillPath(globalRoot, name)
    const destination = safeSkillPath(skillsDir, name)
    if (!source || !destination || managedByUs.has(name) || bundled.has(name)) continue
    try {
      if (lstatSync(source).isSymbolicLink()) continue
      if (existsSync(destination) && !previouslyImported.has(name)) continue
      replaceDirectory(source, destination)
      imported.add(name)
    } catch (error) {
      errors.push(`Não foi possível importar a skill ${name} de ${globalRoot}: ${String(error)}`)
      if (previouslyImported.has(name)) imported.add(name)
    }
  }

  for (const stale of previouslyImported) {
    if (imported.has(stale)) continue
    const target = safeSkillPath(skillsDir, stale)
    if (!target || bundled.has(stale)) continue
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (error) {
      errors.push(`Não foi possível remover a skill importada ${stale}: ${String(error)}`)
      imported.add(stale)
    }
  }
  try {
    if (imported.size > 0 || previouslyImported.size > 0) writeManaged(skillsDir, [...imported], manifestName)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills importadas: ${String(error)}`)
  }
  return errors
}

/** `<cacheDir>/native` — the extra root handed to the SDK (`additionalDirectories`). */
export function nativeSkillRoot(cacheDir: string): string {
  return join(cacheDir, 'native')
}

/**
 * Make the cache skills reachable by the Claude Code CLI the way it actually
 * discovers them when driven through the Agent SDK.
 *
 * Measured against the bundled CLI (SDK 0.3.278): with `skills: 'all'` and
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
 * `kits`: the skill kits switched on (skillKits.ts); a kit switched off has its
 * skills removed like any discontinued bundled skill.
 */
export function syncCacheSkills(
  appRoot: string,
  cacheDir: string,
  userHome: string = homedir(),
  kits: readonly SkillKitId[] = [],
  machine: string = hostname()
): SkillSyncResult {
  const kitOwned = kitSkillNames(appRoot)
  const sources = bundledSkillSources(appRoot, kits, kitOwned)
  const skillsDir = join(cacheDir, 'skills')
  const errors: string[] = []
  mkdirSync(skillsDir, { recursive: true })
  // Upgrade the old name-only link manifest while every prior cache target is
  // still present. The final exposure pass can then safely remove stale links
  // by comparing their recorded target.
  errors.push(...exposeCacheSkills(skillsDir, userHome, machine).errors)

  const previouslyBundled = readManaged(skillsDir, BUNDLED_MANIFEST_NAME)
  // A kit never takes over a skill of the same name the user already had in the
  // cache: adopting it would overwrite it now and delete it when the kit is off.
  for (const name of kitOwned) {
    if (sources.has(name) && !previouslyBundled.has(name) && existsSync(join(skillsDir, name))) sources.delete(name)
  }
  const bundled = [...sources.keys()].sort((a, b) => a.localeCompare(b))
  const bundledSet = new Set(bundled)
  for (const stale of previouslyBundled) {
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
  for (const [name, source] of sources) {
    try {
      replaceDirectory(source, join(skillsDir, name))
    } catch (error) {
      errors.push(`Não foi possível sincronizar a skill ${name}: ${String(error)}`)
    }
  }
  try {
    writeManaged(skillsDir, bundled, BUNDLED_MANIFEST_NAME)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills empacotadas: ${String(error)}`)
  }
  errors.push(...seedCacheSkills(appRoot, skillsDir, kitOwned))

  const exposed = exposeCacheSkills(skillsDir, userHome, machine)
  return { ...exposed, errors: [...errors, ...exposed.errors] }
}

/** Copy the build machine's installed skills (`<appRoot>/.agents/seed-skills`, scripts/stage-skills.mjs)
 * into a cache once: never overwrites, and a seeded skill the user deletes is not brought back. */
export function seedCacheSkills(
  appRoot: string,
  skillsDir: string,
  kitOwned: ReadonlySet<string> = kitSkillNames(appRoot)
): string[] {
  const seedRoot = join(appRoot, '.agents', 'seed-skills')
  // A kit skill only exists while its switch is on: never seed it.
  const seeds = skillNames(seedRoot).filter((name) => !kitOwned.has(name))
  if (seeds.length === 0) return []
  const errors: string[] = []
  const seeded = readManaged(skillsDir, SEEDED_MANIFEST_NAME)
  const before = seeded.size
  for (const name of seeds) {
    const destination = safeSkillPath(skillsDir, name)
    if (seeded.has(name) || !destination) continue
    try {
      if (!existsSync(destination)) replaceDirectory(join(seedRoot, name), destination)
      seeded.add(name)
    } catch (error) {
      errors.push(`Não foi possível instalar a skill ${name}: ${String(error)}`)
    }
  }
  try {
    if (seeded.size !== before) writeManaged(skillsDir, [...seeded], SEEDED_MANIFEST_NAME)
  } catch (error) {
    errors.push(`Não foi possível salvar o manifesto de skills semeadas: ${String(error)}`)
  }
  return errors
}
