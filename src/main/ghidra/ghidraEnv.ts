// Ghidra sob demanda para o MCP "rea" embutido: nada vem no setup. Quando o agente
// precisa da análise nativa, o app baixa o Ghidra 12.1.4 oficial (SHA-256 conferido)
// para o cache LOCAL (<userData>/agent-code-local/ghidra — nunca a pasta sincronizada)
// e usa o JDK 21 do androidEnv (o mesmo <userData>/jdk-21 do build de APK). O caminho
// é fixo, então o reaMcp.ts já o passa ao rea antes de existir. Tudo que toca disco ou
// rede entra por parâmetro (teste sem rede).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { access, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { download, findJavaHome, installJdk, javaMajor, unzip, type Progress } from '../android/androidEnv'

export const GHIDRA_VERSION = '12.1.4'
export const GHIDRA_ZIP_ROOT = `ghidra_${GHIDRA_VERSION}_PUBLIC`
export const GHIDRA_ZIP = `${GHIDRA_ZIP_ROOT}_20260921.zip`
export const GHIDRA_URL = `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/${GHIDRA_ZIP}`
/** SHA-256 publicado no release oficial (corpo do release e `digest` do asset). */
export const GHIDRA_SHA256 = 'ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db'
/** O rea exige um JDK completo de 64 bits, 21 ou mais novo. */
export const MIN_JDK = 21

const WIN = process.platform === 'win32'
const HEADLESS = WIN ? 'analyzeHeadless.bat' : 'analyzeHeadless'
const EXE = WIN ? '.exe' : ''

export interface GhidraPaths {
  localDir: string
  /** A raiz do Ghidra (GHIDRA_INSTALL_DIR): support/, Ghidra/application.properties… */
  installDir: string
  /** Download e extração; some no fim. */
  workDir: string
  /** A base do JDK 21 do androidEnv (<userData>/jdk-21); o home é um filho versionado. */
  jdkBase: string
}

/** Os caminhos fixos a partir do cache local (<userData>/agent-code-local). */
export function ghidraPaths(localDir: string): GhidraPaths {
  if (!localDir || !isAbsolute(localDir)) throw new Error(`Cache local inválido: "${localDir}"`)
  return {
    localDir,
    installDir: join(localDir, 'ghidra'),
    workDir: join(localDir, 'ghidra-tmp'),
    jdkBase: join(dirname(localDir), 'jdk-21')
  }
}

/** O cache local do app — o mesmo getCacheInfo().localDir (localDataDir() do store.ts:
 *  <userData>/agent-code-local) —, ou null fora do Electron. Não importa o store: ele
 *  puxa node:sqlite, que quebra no vitest qualquer teste que só importe o appTools. */
export function defaultLocalDir(): string | null {
  try {
    const { app } = createRequire(import.meta.url)('electron') as typeof import('electron')
    const userData = app?.getPath('userData')
    return typeof userData === 'string' && isAbsolute(userData) ? join(userData, 'agent-code-local') : null
  } catch {
    return null
  }
}

/** Home do JDK dentro da base, síncrono (o reaMcpConfig é síncrono): a própria base ou o
 *  primeiro filho com bin/java — o mesmo critério do findJavaHome do androidEnv. Sem
 *  JDK ainda, devolve a base: o caminho é fixo e passa a valer na próxima conversa. */
export function javaHomeSync(jdkBase: string, exists: (p: string) => boolean = existsSync, list: (p: string) => string[] = readdirSync): string {
  const hasJava = (home: string): boolean => exists(join(home, 'bin', `java${EXE}`))
  if (hasJava(jdkBase)) return jdkBase
  let names: string[] = []
  try {
    names = list(jdkBase)
  } catch {
    return jdkBase
  }
  for (const name of names) {
    const cand = join(jdkBase, name)
    for (const home of [cand, join(cand, 'Contents', 'Home')]) if (hasJava(home)) return home
  }
  return jdkBase
}

/** O que o reaMcp passa ao rea quando o ambiente não define GHIDRA_INSTALL_DIR/JAVA_HOME. */
export function reaCachePaths(localDir: string | null = defaultLocalDir()): { GHIDRA_INSTALL_DIR: string; JAVA_HOME: string } | null {
  if (!localDir) return null
  try {
    const p = ghidraPaths(localDir)
    return { GHIDRA_INSTALL_DIR: p.installDir, JAVA_HOME: javaHomeSync(p.jdkBase) }
  } catch {
    return null
  }
}

/** `application.version=12.1.4` do Ghidra/application.properties. */
export function parseGhidraVersion(props: string): string | null {
  const m = props.match(/^\s*application\.version\s*=\s*(\S+)\s*$/m)
  return m ? m[1] : null
}

export interface GhidraDetect {
  installDir: string
  ghidraReady: boolean
  version: string | null
  javaReady: boolean
  javaHome: string | null
  javaMajor: number | null
  /** GHIDRA_INSTALL_DIR do ambiente: tem prioridade no reaMcp sobre o cache. */
  envGhidraDir: string | null
}

export interface GhidraDeps {
  localDir?: string | null
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => Promise<boolean>
  /** Texto do arquivo, ou '' se não der para ler. */
  readText?: (p: string) => Promise<string>
  javaMajor?: (home: string) => Promise<number | null>
  findJavaHome?: (base: string) => Promise<string | null>
  download?: (url: string, dest: string, onProgress: Progress, label: string) => Promise<void>
  sha256?: (file: string) => Promise<string>
  unzip?: (zip: string, destDir: string) => Promise<void>
  rename?: (from: string, to: string) => Promise<void>
  /** Apaga recursivo, sem erro se não existir. */
  remove?: (p: string) => Promise<void>
  installJdk?: (major: number, jdkBase: string, work: string, onProgress: Progress) => Promise<string>
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function withDefaults(deps: GhidraDeps): Required<Omit<GhidraDeps, 'localDir'>> & { localDir: string | null } {
  return {
    localDir: deps.localDir === undefined ? defaultLocalDir() : deps.localDir,
    env: deps.env ?? process.env,
    exists: deps.exists ?? ((p) => access(p).then(() => true, () => false)),
    readText: deps.readText ?? ((p) => readFile(p, 'utf8').catch(() => '')),
    javaMajor: deps.javaMajor ?? javaMajor,
    findJavaHome: deps.findJavaHome ?? findJavaHome,
    download: deps.download ?? download,
    sha256: deps.sha256 ?? sha256File,
    unzip: deps.unzip ?? unzip,
    rename: deps.rename ?? rename,
    remove: deps.remove ?? ((p) => rm(p, { recursive: true, force: true })),
    installJdk: deps.installJdk ?? installJdk
  }
}

type Resolved = ReturnType<typeof withDefaults>

function pathsOf(d: Resolved): GhidraPaths {
  if (!d.localDir) throw new Error('Cache local do app indisponível: não há onde instalar o Ghidra.')
  return ghidraPaths(d.localDir)
}

/** JDK completo (java + javac) com major ≥ 21: o JAVA_HOME do ambiente primeiro, depois o do androidEnv. */
async function findJdk(p: GhidraPaths, d: Resolved): Promise<{ home: string; major: number } | null> {
  const envHome = d.env['JAVA_HOME']
  const candidates = [envHome && isAbsolute(envHome) ? envHome : null, await d.findJavaHome(p.jdkBase)]
  for (const home of candidates) {
    if (!home) continue
    const major = await d.javaMajor(home)
    if (major === null || major < MIN_JDK) continue
    if (await d.exists(join(home, 'bin', `java${EXE}`)) && (await d.exists(join(home, 'bin', `javac${EXE}`)))) return { home, major }
  }
  return null
}

async function detectWith(p: GhidraPaths, d: Resolved): Promise<GhidraDetect> {
  const version = parseGhidraVersion(await d.readText(join(p.installDir, 'Ghidra', 'application.properties')))
  const ghidraReady = version === GHIDRA_VERSION && (await d.exists(join(p.installDir, 'support', HEADLESS)))
  const jdk = await findJdk(p, d)
  return {
    installDir: p.installDir,
    ghidraReady,
    version,
    javaReady: !!jdk,
    javaHome: jdk?.home ?? null,
    javaMajor: jdk?.major ?? null,
    envGhidraDir: d.env['GHIDRA_INSTALL_DIR'] || null
  }
}

/** Estado do Ghidra no cache local e do JDK 21+, sem baixar nada. */
export async function detectGhidra(deps: GhidraDeps = {}): Promise<GhidraDetect> {
  const d = withDefaults(deps)
  return detectWith(pathsOf(d), d)
}

/** Baixa o zip oficial, confere o SHA-256 e põe a raiz extraída no caminho fixo de uma vez. */
async function installGhidraZip(p: GhidraPaths, d: Resolved, report: Progress): Promise<void> {
  await d.remove(p.workDir)
  const zip = join(p.workDir, GHIDRA_ZIP)
  report(`Baixando o Ghidra ${GHIDRA_VERSION} (~570 MB)…`)
  await d.download(GHIDRA_URL, zip, report, `Ghidra ${GHIDRA_VERSION}`)
  report('Conferindo o SHA-256 do Ghidra…')
  const sum = (await d.sha256(zip)).trim().toLowerCase()
  if (sum !== GHIDRA_SHA256) {
    await d.remove(zip)
    throw new Error(`SHA-256 do Ghidra não confere (esperado ${GHIDRA_SHA256}, obtido ${sum}); o download foi descartado.`)
  }
  report('Extraindo o Ghidra (pode demorar alguns minutos)…')
  const out = join(p.workDir, 'x')
  await d.unzip(zip, out)
  await d.remove(zip)
  const root = join(out, GHIDRA_ZIP_ROOT)
  if (!(await d.exists(join(root, 'support', HEADLESS)))) throw new Error(`Zip do Ghidra sem ${GHIDRA_ZIP_ROOT}/support/${HEADLESS}.`)
  // A pasta final só aparece completa: uma instalação parcial ou velha sai antes.
  await d.remove(p.installDir)
  await d.rename(root, p.installDir)
}

async function runInstall(d: Resolved, report: Progress): Promise<GhidraDetect> {
  const p = pathsOf(d)
  const before = await detectWith(p, d)
  try {
    if (!before.ghidraReady) await installGhidraZip(p, d, report)
    if (!before.javaReady) await d.installJdk(MIN_JDK, p.jdkBase, p.workDir, report)
  } finally {
    await d.remove(p.workDir).catch(() => undefined)
  }
  const after = await detectWith(p, d)
  if (!after.ghidraReady) throw new Error(`Ghidra instalado, mas ${p.installDir} não tem a versão ${GHIDRA_VERSION} com support/${HEADLESS}.`)
  if (!after.javaReady) throw new Error(`JDK ${MIN_JDK}+ não encontrado depois da instalação (${p.jdkBase}).`)
  report('Ghidra pronto.')
  return after
}

export type GhidraState = 'idle' | 'running' | 'ready' | 'error'

export interface GhidraStatus {
  state: GhidraState
  /** A última linha de progresso (só em "running"). */
  progress: string | null
  error: string | null
  result: GhidraDetect | null
}

const IDLE: GhidraStatus = { state: 'idle', progress: null, error: null, result: null }
let current: GhidraStatus = { ...IDLE }
let run: Promise<GhidraDetect> | null = null
const listeners = new Set<Progress>()

/** Retrato do processo de instalação (para a ferramenta responder na hora). */
export function ghidraStatus(): GhidraStatus {
  return { ...current }
}

/** Instala Ghidra + JDK uma vez só: chamadas durante a instalação recebem a mesma promessa.
 *  Depois de um erro, a próxima chamada tenta de novo. */
export function installGhidra(onProgress?: Progress, deps: GhidraDeps = {}): Promise<GhidraDetect> {
  if (onProgress) listeners.add(onProgress)
  if (run) return run
  current = { state: 'running', progress: 'Preparando…', error: null, result: null }
  const report: Progress = (msg) => {
    current = { ...current, progress: msg }
    for (const l of listeners) {
      try {
        l(msg)
      } catch {
        /* um ouvinte que falha não derruba a instalação */
      }
    }
  }
  run = runInstall(withDefaults(deps), report)
    .then(
      (result) => {
        current = { state: 'ready', progress: null, error: null, result }
        return result
      },
      (err: unknown) => {
        current = { state: 'error', progress: null, error: err instanceof Error ? err.message : String(err), result: null }
        throw err
      }
    )
    .finally(() => {
      run = null
      listeners.clear()
    })
  return run
}

/** Só para teste: volta ao estado inicial. */
export function resetGhidraInstallForTests(): void {
  current = { ...IDLE }
  run = null
  listeners.clear()
}

/** O que a ferramenta app_preparar_ghidra usa (injetável no teste). */
export interface GhidraPreparer {
  status: () => GhidraStatus
  detect: () => Promise<GhidraDetect>
  /** Dispara a instalação em segundo plano; não espera. */
  start: () => void
}

export const ghidraPreparer: GhidraPreparer = {
  status: ghidraStatus,
  detect: () => detectGhidra(),
  start: () => void installGhidra().catch(() => undefined)
}
