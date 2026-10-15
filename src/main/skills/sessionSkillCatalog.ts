import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type AppConfig } from '../../shared/ipc'
import { loadConfig } from '../config'
import { getCacheInfo } from '../store'
import {
  createSkillCatalogSnapshot,
  discoverSkills,
  type DiscoveredSkill,
  renderSkillCatalogUpdate,
  skillCatalogFilesystemVersion,
  type SkillCatalogSnapshot
} from '../skillDiscovery'
import { activeSkillKits } from '../skillKits'
import { skillSync } from './skillSync'
import { rememberNativeSkillNames, resolveSkillTiers, skillCatalogPolicy, type SkillCatalogPolicy } from './skillTiers'
import { createSkillsMcpServer, SKILLS_MCP_SERVER } from './skillTools'

const EMPTY_SKILL_CATALOG = createSkillCatalogSnapshot([])

export interface SkillRuntimePaths {
  appRoot: string
  userHome?: string
}

/** O `reloadSkills` do query vivo da sessão (null quando não há query). */
export interface SkillReloader {
  reloadSkills(): Promise<{ skills: ReadonlyArray<{ name: string }> }>
}

/** O que a subida da sessão leva para as Options do SDK e o system prompt. */
export interface SkillCatalogStart {
  /** Raízes das skills descobertas (viram additionalDirectories). */
  roots: string[]
  /** Valor de `Options.skills`: 'all' com o catálogo em níveis desligado. */
  sdkSkills: 'all' | string[]
  /** As de nível alto inteiras para o system prompt ('' sem nenhuma) e o aviso de teto. */
  high: { text: string; warning: string | null }
  /** Servidor `skills` (busca e listagem), só no modo em níveis. */
  mcpServer?: ReturnType<typeof createSkillsMcpServer>
}

/**
 * Catálogo de skills de UMA sessão: sincroniza o kit gerenciado no cache, lê o
 * catálogo do disco, confirma no registro nativo do CLI (`reloadSkills`) e
 * entrega ao modelo só o que mudou. Com o catálogo em níveis ligado, a política
 * (skillTiers.ts) decide o que vai nativo e o que vai anunciado; desligado, ela
 * é a identidade e tudo fica como antes.
 */
export class SessionSkillCatalog {
  /** Version of the authoritative skill catalog already loaded into this
   *  session. Recomputed before every user dispatch so installs/removals become
   *  available without reopening the conversation. */
  private catalogVersion = ''
  /** Version successfully reloaded by the SDK's native Skill registry. Kept
   *  separate so a transient reload failure is retried without duplicating the
   *  catalog update already delivered to the model. */
  private nativeRegistryVersion = ''
  /** Fixada na subida; desligado = identidade. */
  private policy: SkillCatalogPolicy = skillCatalogPolicy(DEFAULT_CONFIG.skillCatalog)
  private discovered: DiscoveredSkill[] = []
  /** Em níveis: a versão do snapshot nativo de que saiu o catálogo anunciado. */
  private nativeVersion = ''
  /** The catalog actually announced for `nativeRegistryVersion` — the
   *  discovered snapshot minus whatever the SDK refused to load. */
  private nativeConfirmed: SkillCatalogSnapshot | null = null
  /** Cheap metadata-only signature checked before parsing any frontmatter. */
  private filesystemVersion = ''
  /** Content signature of the versioned `.agents/skills` source already copied
   * into the active cache for this session. */
  private managedSourceVersion = ''
  /** A content-level managed skill change still awaiting SDK confirmation. */
  private managedReloadPending = false

  constructor(
    private readonly cwd: string,
    private readonly runtime: SkillRuntimePaths | undefined,
    private readonly query: () => SkillReloader | null
  ) {}

  get tiered(): boolean {
    return this.policy.tiered
  }

  /** Subida da sessão: lê o catálogo e fixa a política. Chame depois de `syncManaged`. */
  start(config: AppConfig): SkillCatalogStart {
    this.filesystemVersion = skillCatalogFilesystemVersion(this.cwd, this.runtime?.userHome)
    const snapshot = this.readSnapshot()
    const catalogConfig = config.skillCatalog ?? DEFAULT_CONFIG.skillCatalog
    this.policy = skillCatalogPolicy(catalogConfig)
    this.discovered = snapshot.skills
    // The authoritative filesystem catalog is injected with the first user
    // dispatch, only after reloadSkills() confirms the same names. The native
    // registry is never marked as loaded before that for this SDK process.
    this.catalogVersion = ''
    this.nativeRegistryVersion = ''
    return {
      roots: [...new Set(snapshot.skills.map((skill) => skill.root))],
      sdkSkills: this.policy.sdkSkills(snapshot.skills),
      high: this.policy.systemBlock(snapshot.skills),
      ...(this.policy.tiered
        ? { mcpServer: createSkillsMcpServer(() => resolveSkillTiers(this.discovered, catalogConfig.overrides)) }
        : {})
    }
  }

  /** Copia o kit gerenciado (e os kits ligados) para o cache; true = recarregar o nativo. */
  async syncManaged(cacheDir: string, cacheSkillsDir: string): Promise<boolean> {
    return (await this.syncManagedAndFingerprint(cacheDir, cacheSkillsDir)).changed
  }

  /**
   * A sincronização roda no worker do app (skillSync.ts), partilhada entre as
   * sessões. Devolve também a assinatura barata do disco já lida para decidir o
   * TTL, para o refresh não repetir a leitura.
   */
  private async syncManagedAndFingerprint(
    cacheDir: string,
    cacheSkillsDir: string
  ): Promise<{ changed: boolean; fingerprint: string | null }> {
    const runtime = this.runtime
    if (!runtime) return { changed: false, fingerprint: null }
    // Os kits ligados entram na versão: trocar o interruptor ressincroniza aqui.
    const kits = activeSkillKits(loadConfig())
    let fingerprint: string | null = null
    const outcome = await skillSync().syncManaged(
      { appRoot: runtime.appRoot, cacheDir, skillsDir: cacheSkillsDir, userHome: runtime.userHome, kits },
      {
        scope: this.cwd,
        fingerprint: () => (fingerprint = skillCatalogFilesystemVersion(this.cwd, runtime.userHome))
      }
    )
    // A versão fica registrada mesmo com erro: a nova tentativa completa é do
    // coordenador, depois do backoff, e não a cada envio.
    if (outcome.version !== this.managedSourceVersion) {
      this.managedSourceVersion = outcome.version
      this.managedReloadPending = true
    }
    if (outcome.ran && outcome.result.errors.length > 0) {
      console.warn('[skills] managed skill synchronization failed:', outcome.result.errors.join('\n'))
    }
    return { changed: this.managedReloadPending, fingerprint }
  }

  /** Atualização do catálogo para esta mensagem ('' quando nada mudou). */
  async refresh(): Promise<string> {
    const cacheInfo = getCacheInfo()
    const managed = await this.syncManagedAndFingerprint(cacheInfo.dir, cacheInfo.skillsDir)
    const managedChanged = managed.changed
    const filesystemVersion = managed.fingerprint ?? skillCatalogFilesystemVersion(this.cwd, this.runtime?.userHome)
    // Em níveis, o catálogo anunciado tem versão própria: o "nativo em dia" se mede
    // pela versão do snapshot nativo de onde ele saiu.
    const announcedFrom = this.policy.tiered ? this.nativeVersion : this.catalogVersion
    if (
      !managedChanged &&
      this.catalogVersion !== '' &&
      filesystemVersion === this.filesystemVersion &&
      this.nativeRegistryVersion === announcedFrom
    ) return ''

    const discovered = this.readSnapshot()
    this.discovered = discovered.skills
    // Em níveis, o nativo só confirma os níveis alto + médio; o catálogo anunciado é o dos níveis.
    const snapshot = this.policy.tiered
      ? createSkillCatalogSnapshot(this.policy.nativeExpected(discovered.skills))
      : discovered
    const native = await this.reloadNativeIfNeeded(snapshot, managedChanged)
    const confirmed = native && this.policy.announce(native, discovered.skills)
    if (!confirmed) {
      if (this.catalogVersion === '') {
        this.catalogVersion = EMPTY_SKILL_CATALOG.version
        return renderSkillCatalogUpdate(EMPTY_SKILL_CATALOG)
      }
      return ''
    }

    this.filesystemVersion = filesystemVersion
    if (native) this.nativeVersion = native.version
    if (confirmed.version === this.catalogVersion) return ''

    this.catalogVersion = confirmed.version
    return renderSkillCatalogUpdate(confirmed)
  }

  /** `/nome` de skill de nível baixo vira "leia e siga o SKILL.md". Desligado, nada muda. */
  rewriteCommand(text: string): string {
    return this.policy.rewriteCommand(text, this.discovered)
  }

  /** skills_buscar/skills_listar só leem o catálogo; o servidor só é o do app com o modo em níveis. */
  ownsTool(toolName: string): boolean {
    return this.policy.tiered && toolName.startsWith(`mcp__${SKILLS_MCP_SERVER}__`)
  }

  /** As skills embutidas/de plugin que o CLI anuncia no init: a lista nativa das próximas sessões em níveis. */
  rememberNative(names: readonly string[]): void {
    rememberNativeSkillNames(names, this.discovered)
  }

  private readSnapshot(): SkillCatalogSnapshot {
    return createSkillCatalogSnapshot(discoverSkills(this.cwd, this.runtime?.userHome))
  }

  /**
   * Reload the CLI's native Skill registry and return the catalog to announce:
   * exactly the discovered skills the SDK confirmed as invocable.
   *
   * A skill the SDK did not load (e.g. one that only exists in `~/.claude/skills`,
   * a root the SDK-driven CLI does not scan) is dropped from the announcement
   * and logged — it must NOT poison the rest. The previous all-or-nothing rule
   * announced "no skills available" whenever a single expected name was missing,
   * which hid every working skill from the model (measured: one stray user
   * skill silenced the whole managed kit).
   *
   * Returns null only when the reload itself fails or the session has no query.
   */
  private async reloadNativeIfNeeded(snapshot: SkillCatalogSnapshot, force: boolean = false): Promise<SkillCatalogSnapshot | null> {
    const q = this.query()
    if (!q) return null
    if (!force && snapshot.version === this.nativeRegistryVersion && this.nativeConfirmed) {
      return this.nativeConfirmed
    }
    try {
      const response = await q.reloadSkills()
      const loaded = new Set(response.skills.map((skill) => skill.name))
      const missing = snapshot.skills.map((skill) => skill.name).filter((name) => !loaded.has(name))
      let confirmed = snapshot
      // Retry on the next dispatch only for skills the CLI is known to scan
      // (project .claude/skills, or the managed cache exposed through the native
      // root) — an omission there is usually a race with a file still being
      // written. A skill that lives only in ~/.claude/skills is never going to
      // load through the SDK, so retrying would just spam reloadSkills().
      let retry = false
      if (missing.length > 0) {
        console.warn(`[skills] native registry omitted expected skills: ${missing.join(', ')}`)
        const cacheSkillsDir = getCacheInfo().skillsDir
        retry = snapshot.skills.some(
          (skill) =>
            !loaded.has(skill.name) &&
            (skill.source === 'project-claude' || existsSync(join(cacheSkillsDir, skill.name, 'SKILL.md')))
        )
        confirmed = createSkillCatalogSnapshot(snapshot.skills.filter((skill) => loaded.has(skill.name)))
      }
      this.nativeRegistryVersion = snapshot.version
      this.nativeConfirmed = confirmed
      this.managedReloadPending = retry
      return confirmed
    } catch (error) {
      console.warn('[skills] native reload failed; catalog remains unchanged:', error)
      return null
    }
  }
}
