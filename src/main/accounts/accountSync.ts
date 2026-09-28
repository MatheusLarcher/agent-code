import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY,
  credentialLive,
  decryptCredential,
  encryptCredential,
  missingLoginCause,
  newer,
  parseBackups,
  readFolderCredential,
  saveBackups,
  writeFolderCredential,
  type CredentialBackupEntry,
  type CredentialBackups,
  type CredentialCipher
} from './accountBackup'
import {
  accountDir,
  accountsRoot,
  clearRecreatedMark,
  isRecreatedDir,
  isSafeAccountId,
  prepareAccountDir,
  readCredentialInfo,
  readOauthEmail
} from './accountDirs'
import { DEFAULT_ACCOUNT_ID, type AccountRegistry } from './registry'
import { readOauthOrg } from './registryStore'

/**
 * Confere, ao abrir o app (e de tempos em tempos), se a lista de contas no banco
 * e as pastas de cada conta batem:
 *
 * 1. conta que existe SÓ na pasta (a lista a perdeu) volta para a lista — menos
 *    a pasta de um login em andamento (`busy`) e a pasta sem e-mail;
 * 2. conta da lista sem pasta, ou com a pasta RECRIADA pelo app (marcador
 *    `RECREATED_MARKER`, mesmo que o CLI já tenha gravado um `.claude.json` sem
 *    conta nela), tem a credencial restaurada da cópia cifrada, se a cópia vale;
 * 3. pasta que já existia (sem o marcador) e ficou sem login é LOGOUT: o
 *    `claude auth logout` revogou o refresh token. A cópia não volta e sai do banco;
 * 4. credencial da pasta mais nova que a do banco vai para o banco;
 * 5. cópia de conta que não está mais na lista sai do banco (remoção feita com o
 *    banco fora do ar, ou uma cópia que voltou numa corrida com a remoção).
 *
 * Cada conta é conferida isolada: uma que falha (arquivo preso pelo CLI no
 * Windows) fica em `failed` e é tentada na passada seguinte; as outras seguem.
 * Nunca apaga pasta nem conta. A conta padrão (o `~/.claude` da máquina) fica de
 * fora: é o CLI do sistema quem cuida dela.
 */

export interface AccountSyncDeps {
  localDir: () => string
  readKv: (key: string) => Promise<string | null>
  writeKv: (key: string, value: string) => Promise<void>
  cipher: CredentialCipher
  registry: Pick<AccountRegistry, 'ensureLoaded' | 'ids' | 'adopt' | 'storeReady' | 'busy'>
  log?: (line: string) => void
  now?: () => number
}

export interface AccountSyncReport {
  adopted: string[]
  recreatedDirs: string[]
  restored: string[]
  backedUp: string[]
  /** Cópias no banco que não abriram aqui (outra máquina, cifra indisponível). */
  unreadable: string[]
  /** Logout numa pasta que continuou, ou cópia vencida: não restaurado. */
  notRestored: string[]
  /** Cópias tiradas do banco: conta fora da lista, ou logout (credencial revogada). */
  pruned: string[]
  /** Contas que falharam nesta passada (ex.: arquivo preso pelo CLI); nova tentativa na próxima. */
  failed: string[]
  /** O banco não respondeu: nada foi feito. */
  skipped: boolean
}

function emptyReport(skipped = false): AccountSyncReport {
  return { adopted: [], recreatedDirs: [], restored: [], backedUp: [], unreadable: [], notRestored: [], pruned: [], failed: [], skipped }
}

/** Pastas de conta no disco (só nomes que podem ser id). */
function folderIds(localDir: string): string[] {
  const root = accountsRoot(localDir)
  if (!existsSync(root)) return []
  return readdirSync(root).filter((name) => {
    if (!isSafeAccountId(name) || name === DEFAULT_ACCOUNT_ID) return false
    try {
      return statSync(join(root, name)).isDirectory()
    } catch {
      return false
    }
  })
}

/** Contas só na pasta, com login: a de credencial mais nova primeiro (dedup por e-mail no `adopt`). */
async function adoptOrphans(deps: AccountSyncDeps, report: AccountSyncReport): Promise<void> {
  const known = new Set(deps.registry.ids())
  const orphans = folderIds(deps.localDir())
    // Pasta de um add() em andamento: é dele, não uma órfã.
    .filter((id) => !known.has(id) && !deps.registry.busy(id))
    .map((id) => ({ id, dir: accountDir(deps.localDir(), id) }))
    .map((entry) => ({ ...entry, credential: readFolderCredential(entry.dir) }))
    .filter((entry) => entry.credential !== null)
    .sort((a, b) => (b.credential?.expiresAt ?? 0) - (a.credential?.expiresAt ?? 0))
  for (const { id, dir } of orphans) {
    try {
      const info = readCredentialInfo(dir)
      const adopted = await deps.registry.adopt(id, {
        email: readOauthEmail(dir),
        org: readOauthOrg(dir),
        plan: info.subscriptionType,
        rateLimitTier: info.rateLimitTier
      })
      if (adopted) report.adopted.push(id)
    } catch (error) {
      report.failed.push(id)
      console.warn(`[contas] pasta ${id} não adotada nesta passada:`, (error as Error).message)
    }
  }
}

/** O que uma passada acumula conta a conta. */
interface Pass {
  report: AccountSyncReport
  updates: CredentialBackups
  forget: string[]
  cipherWarned: { value: boolean }
  log: (line: string) => void
}

/** Confere UMA conta da lista: pasta × cópia no banco. Pode lançar (fs); quem chama isola. */
function syncOne(deps: AccountSyncDeps, id: string, stored: CredentialBackupEntry | undefined, now: number, pass: Pass): void {
  const { report } = pass
  const dir = accountDir(deps.localDir(), id)
  const existed = existsSync(dir)
  if (!existed) report.recreatedDirs.push(id)
  const folder = readFolderCredential(dir)
  // Sem login: pasta sumida ou recriada pelo app (restaura), ou logout numa pasta que continuou (não).
  const cause = folder ? null : missingLoginCause(dir, existed)
  // Recria o que faltar (CLAUDE.md, settings.json, skills) sem mexer no login; pasta
  // criada agora ganha o marcador de recriada.
  prepareAccountDir(dir)
  // Login presente na pasta: ela passa a ter história; um logout depois é logout.
  if (folder && isRecreatedDir(dir)) clearRecreatedMark(dir)
  if (cause === 'cleared') {
    // Logout (`claude auth logout` revoga o refresh token): a cópia não volta e sai
    // do banco. Não olha credentialLive: a cópia no formato do CLI (sem
    // refreshTokenExpiresAt) sempre "vale" por ele.
    if (stored) {
      report.notRestored.push(id)
      pass.forget.push(id)
    }
    return
  }
  if (stored && (cause === 'lost' || (folder && stored.expiresAt > folder.expiresAt))) {
    const restored = decryptCredential(deps.cipher, stored)
    if (restored && credentialLive(restored, now)) {
      writeFolderCredential(dir, restored)
      report.restored.push(id)
      return
    }
    if (restored) report.notRestored.push(id)
    else report.unreadable.push(id)
  }
  if (!folder) return
  const entry = encryptCredential(deps.cipher, folder, now)
  if (!entry) {
    if (!pass.cipherWarned.value) pass.log('[contas] proteção de segredos do sistema indisponível: credencial não copiada para o banco')
    pass.cipherWarned.value = true
    return
  }
  if (newer(entry, stored)) pass.updates[id] = entry
}

let running: Promise<AccountSyncReport> | null = null

/** Uma passada por vez: boot, relógio e login novo podem chamar juntos. */
export function syncClaudeAccounts(deps: AccountSyncDeps): Promise<AccountSyncReport> {
  running ??= runSync(deps).finally(() => {
    running = null
  })
  return running
}

async function runSync(deps: AccountSyncDeps): Promise<AccountSyncReport> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const now = deps.now?.() ?? Date.now()
  await deps.registry.ensureLoaded()
  // Sem a lista lida do banco, "conta que falta na lista" não quer dizer nada.
  if (!deps.registry.storeReady()) return emptyReport(true)
  const report = emptyReport()
  await adoptOrphans(deps, report)

  const backups = parseBackups(await deps.readKv(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY))
  const updates: CredentialBackups = {}
  const forget: string[] = []
  const pass: Pass = { report, updates, forget, cipherWarned: { value: false }, log }
  for (const id of deps.registry.ids()) {
    // Login em andamento na pasta: o CLI está escrevendo nela agora.
    if (id === DEFAULT_ACCOUNT_ID || deps.registry.busy(id)) continue
    // Uma conta que falha (ex.: EPERM/EBUSY no rename do .claude.json que o CLI
    // segura aberto no Windows) não derruba a passada: as outras seguem e a cópia
    // delas é gravada; esta fica como estava e é tentada na próxima passada.
    try {
      syncOne(deps, id, backups[id], now, pass)
    } catch (error) {
      report.failed.push(id)
      log(`[contas] conta ${id} não conferida nesta passada (nova tentativa na próxima): ${(error as Error).message}`)
    }
  }
  // Lida de novo: uma conta removida durante a passada não volta para o banco.
  const listed = new Set(deps.registry.ids())
  for (const id of Object.keys(updates)) if (!listed.has(id)) delete updates[id]
  for (const id of Object.keys(backups)) if (!listed.has(id) && !deps.registry.busy(id)) forget.push(id)
  const saved = await saveBackups(deps, updates, forget)
  report.backedUp = saved.written
  report.pruned = saved.removed
  const parts = [
    report.adopted.length && `${report.adopted.length} conta(s) de volta à lista`,
    report.recreatedDirs.length && `${report.recreatedDirs.length} pasta(s) recriada(s)`,
    report.restored.length && `${report.restored.length} login(s) restaurado(s) do banco`,
    report.backedUp.length && `${report.backedUp.length} login(s) copiado(s) para o banco`,
    report.unreadable.length && `${report.unreadable.length} cópia(s) do banco que não abrem nesta máquina`,
    report.notRestored.length && `${report.notRestored.length} login(s) encerrado(s) pelo CLI ou vencido(s), não restaurado(s)`,
    report.pruned.length && `${report.pruned.length} cópia(s) sem uso tirada(s) do banco`,
    report.failed.length && `${report.failed.length} conta(s) com falha, nova tentativa na próxima passada`
  ].filter(Boolean)
  if (parts.length) log(`[contas] ${parts.join('; ')}`)
  return report
}

/**
 * Tira do banco a cópia de uma conta removida pelo usuário. Se o banco estiver
 * fora (ou uma passada regravar a cópia na corrida), a próxima passada do sync
 * poda a cópia: o id não está mais na lista.
 */
export async function forgetAccountBackup(deps: Pick<AccountSyncDeps, 'readKv' | 'writeKv'>, id: string): Promise<void> {
  await saveBackups(deps, {}, [id])
}
