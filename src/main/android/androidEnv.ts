import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, access } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/**
 * Android toolchain manager (app-global singleton).
 *
 * Detects and, on demand, installs everything needed to boot an emulator and
 * build an APK: a JDK, the Android SDK command-line tools, platform-tools (adb),
 * the emulator + a system image, a build platform/build-tools, and a default AVD.
 *
 * Everything is cached under the app's userData dir so it is downloaded once and
 * reused across conversations and sessions. Electron is imported lazily so this
 * module can also load in plain Node (tests) without an Electron runtime.
 */

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''
const BAT = WIN ? '.bat' : ''

/** Packages installed via sdkmanager. android-34 keeps the download reasonable. */
const SDK_PACKAGES = [
  'platform-tools',
  'emulator',
  'platforms;android-34',
  'build-tools;34.0.0',
  'system-images;android-34;google_apis;x86_64'
]
const SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64'
export const DEFAULT_AVD = 'agent_code_avd'

/** Download URLs (Windows host). cmdline-tools build number is the current stable. */
const CMDLINE_TOOLS_URL_WIN =
  'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip'
const CMDLINE_TOOLS_URL_MAC =
  'https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip'
const CMDLINE_TOOLS_URL_LINUX =
  'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip'
const jdkUrl = (): string => {
  const os = WIN ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  return `https://api.adoptium.net/v3/binary/latest/17/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`
}

export type Progress = (line: string) => void

export interface ToolPaths {
  sdkRoot: string
  jdkBase: string
  javaHome: string | null
  adb: string | null
  emulator: string | null
  sdkmanager: string | null
  avdmanager: string | null
}

export interface DetectResult extends ToolPaths {
  hasJava: boolean
  /** cmdline-tools + platform-tools (adb) present. */
  hasSdk: boolean
  hasEmulator: boolean
  hasSystemImage: boolean
  hasAvd: boolean
  /** Everything needed to boot the emulator. */
  ready: boolean
  missing: string[]
  /** Env (JAVA_HOME, ANDROID_HOME, PATH) to pass when spawning adb/emulator/gradle. */
  env: NodeJS.ProcessEnv
}

let cachedRoot: string | null = null

/** App data dir (userData under Electron, ~/.agent-code otherwise). */
async function dataDir(): Promise<string> {
  if (cachedRoot) return cachedRoot
  try {
    const { app } = await import('electron')
    cachedRoot = app.getPath('userData')
  } catch {
    cachedRoot = process.env['AGENT_CODE_HOME'] || join(homedir(), '.agent-code')
  }
  return cachedRoot
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** First child dir of `base` that contains bin/java — Temurin extracts to jdk-17.x.y+z. */
async function findJavaHome(base: string): Promise<string | null> {
  if (await exists(join(base, 'bin', `java${EXE}`))) return base
  let entries: string[]
  try {
    entries = await readdir(base)
  } catch {
    return null
  }
  for (const name of entries) {
    const cand = join(base, name)
    // macOS Temurin nests under Contents/Home.
    for (const home of [cand, join(cand, 'Contents', 'Home')]) {
      if (await exists(join(home, 'bin', `java${EXE}`))) return home
    }
  }
  return null
}

function buildEnv(p: ToolPaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (p.javaHome) env['JAVA_HOME'] = p.javaHome
  env['ANDROID_HOME'] = p.sdkRoot
  env['ANDROID_SDK_ROOT'] = p.sdkRoot
  const extra = [
    p.javaHome ? join(p.javaHome, 'bin') : '',
    join(p.sdkRoot, 'platform-tools'),
    join(p.sdkRoot, 'emulator'),
    join(p.sdkRoot, 'cmdline-tools', 'latest', 'bin')
  ].filter(Boolean)
  const sep = WIN ? ';' : ':'
  env['PATH'] = [...extra, env['PATH'] || ''].join(sep)
  return env
}

async function resolvePaths(): Promise<ToolPaths> {
  const base = await dataDir()
  const jdkBase = join(base, 'jdk-17')
  // Prefer an existing SDK (env or standard location) over our cache to avoid
  // re-downloading multiple GB when the user already has Android Studio.
  const candidates = [
    process.env['ANDROID_HOME'],
    process.env['ANDROID_SDK_ROOT'],
    join(base, 'android-sdk'),
    WIN && process.env['LOCALAPPDATA'] ? join(process.env['LOCALAPPDATA'], 'Android', 'Sdk') : '',
    process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : '',
    join(homedir(), 'Android', 'Sdk')
  ].filter((x): x is string => Boolean(x))

  let sdkRoot = join(base, 'android-sdk')
  for (const c of candidates) {
    if (await exists(join(c, 'cmdline-tools', 'latest', 'bin', `sdkmanager${BAT}`))) {
      sdkRoot = c
      break
    }
    if (await exists(join(c, 'platform-tools', `adb${EXE}`))) sdkRoot = c
  }

  const javaHome =
    (process.env['JAVA_HOME'] && (await exists(join(process.env['JAVA_HOME'], 'bin', `java${EXE}`)))
      ? process.env['JAVA_HOME']
      : null) ?? (await findJavaHome(jdkBase))

  const adbPath = join(sdkRoot, 'platform-tools', `adb${EXE}`)
  const emuPath = join(sdkRoot, 'emulator', `emulator${EXE}`)
  const sdkmPath = join(sdkRoot, 'cmdline-tools', 'latest', 'bin', `sdkmanager${BAT}`)
  const avdmPath = join(sdkRoot, 'cmdline-tools', 'latest', 'bin', `avdmanager${BAT}`)

  return {
    sdkRoot,
    jdkBase,
    javaHome,
    adb: (await exists(adbPath)) ? adbPath : null,
    emulator: (await exists(emuPath)) ? emuPath : null,
    sdkmanager: (await exists(sdkmPath)) ? sdkmPath : null,
    avdmanager: (await exists(avdmPath)) ? avdmPath : null
  }
}

async function hasSystemImage(p: ToolPaths): Promise<boolean> {
  return exists(join(p.sdkRoot, 'system-images', 'android-34', 'google_apis', 'x86_64', 'system.img'))
}

async function hasAvd(): Promise<boolean> {
  // AVDs live in the user's ~/.android/avd, regardless of SDK location.
  const avdHome = process.env['ANDROID_AVD_HOME'] || join(homedir(), '.android', 'avd')
  return exists(join(avdHome, `${DEFAULT_AVD}.ini`))
}

/** Snapshot of what is present and what is missing. */
export async function detect(): Promise<DetectResult> {
  const p = await resolvePaths()
  const env = buildEnv(p)
  const hasJava = Boolean(p.javaHome)
  const hasSdk = Boolean(p.sdkmanager && p.adb)
  const hasEmulator = Boolean(p.emulator)
  const sysImg = await hasSystemImage(p)
  const avd = await hasAvd()
  const missing: string[] = []
  if (!hasJava) missing.push('JDK 17')
  if (!p.sdkmanager) missing.push('Android command-line tools')
  if (!p.adb) missing.push('platform-tools (adb)')
  if (!hasEmulator) missing.push('emulator')
  if (!sysImg) missing.push('system image (android-34)')
  if (!avd) missing.push(`AVD (${DEFAULT_AVD})`)
  const ready = hasJava && hasSdk && hasEmulator && sysImg && avd
  return {
    ...p,
    env,
    hasJava,
    hasSdk,
    hasEmulator,
    hasSystemImage: sysImg,
    hasAvd: avd,
    ready,
    missing
  }
}

/** Run a tool, streaming each stdout/stderr line to onLine; resolves with the exit code. */
export function spawnTool(
  cmd: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; cwd?: string; onLine?: Progress; input?: string } = {}
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      // .bat tools (sdkmanager/avdmanager) need a shell on Windows.
      shell: WIN && /\.bat$/i.test(cmd)
    })
    let out = ''
    const onData = (buf: Buffer): void => {
      const s = buf.toString()
      out += s
      if (opts.onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLine(line.trim())
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    if (opts.input) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
    child.on('error', (err) => {
      out += String(err)
      resolve({ code: -1, out })
    })
    child.on('close', (code) => resolve({ code: code ?? -1, out }))
  })
}

/** Download a URL to a file, reporting rough percentage progress. */
async function download(url: string, dest: string, onProgress: Progress, label: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Falha ao baixar ${label}: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') || 0)
  let received = 0
  let lastPct = -1
  await mkdir(join(dest, '..'), { recursive: true })
  const file = createWriteStream(dest)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    file.write(value)
    if (total) {
      const pct = Math.floor((received / total) * 100)
      if (pct >= lastPct + 5) {
        lastPct = pct
        onProgress(`${label}: ${pct}% (${(received / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} MB)`)
      }
    }
  }
  await new Promise<void>((r) => file.end(r))
  void Readable // keep import used across runtimes
}

/** Extract a .zip into destDir (created if needed). */
async function unzip(zip: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  if (WIN) {
    const ps = `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`
    const r = await spawnTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps])
    if (r.code !== 0) throw new Error(`Falha ao extrair ${zip}: ${r.out.slice(-300)}`)
  } else {
    const r = await spawnTool('unzip', ['-oq', zip, '-d', destDir])
    if (r.code !== 0) throw new Error(`Falha ao extrair ${zip}: ${r.out.slice(-300)}`)
  }
}

function cmdlineToolsUrl(): string {
  if (WIN) return CMDLINE_TOOLS_URL_WIN
  return process.platform === 'darwin' ? CMDLINE_TOOLS_URL_MAC : CMDLINE_TOOLS_URL_LINUX
}

const installListeners = new Set<Progress>()
let installRun: Promise<DetectResult> | null = null

/** An install is running (agent tool, APK build or Settings). */
export function isInstalling(): boolean {
  return installRun !== null
}

/**
 * Install whatever is missing. Idempotent: re-running after a partial install
 * only fetches what's still absent. Returns a fresh detect() at the end. A call
 * during an install joins it (and gets its progress lines) instead of starting
 * a second one over the same folders.
 */
export function ensureInstalled(onProgress: Progress): Promise<DetectResult> {
  installListeners.add(onProgress)
  if (!installRun) {
    const broadcast: Progress = (line) => {
      for (const fn of installListeners) fn(line)
    }
    installRun = runInstall(broadcast).finally(() => {
      installRun = null
      installListeners.clear()
    })
  }
  return installRun
}

async function runInstall(onProgress: Progress): Promise<DetectResult> {
  let d = await detect()
  if (d.ready) {
    onProgress('Toolchain Android já está instalada.')
    return d
  }
  const base = await dataDir()
  const work = join(base, 'android-tmp')
  await mkdir(work, { recursive: true })

  // 1) JDK 17
  if (!d.hasJava) {
    onProgress('Baixando JDK 17 (Temurin)…')
    const zip = join(work, 'jdk.zip')
    await download(jdkUrl(), zip, onProgress, 'JDK 17')
    onProgress('Extraindo JDK…')
    await rm(d.jdkBase, { recursive: true, force: true })
    await unzip(zip, d.jdkBase)
    await rm(zip, { force: true })
    d = await detect()
    if (!d.hasJava) throw new Error('JDK extraído, mas java não foi encontrado.')
  }

  // 2) Android command-line tools (gives us sdkmanager/avdmanager)
  if (!d.sdkmanager) {
    onProgress('Baixando Android command-line tools…')
    const zip = join(work, 'cmdline-tools.zip')
    await download(cmdlineToolsUrl(), zip, onProgress, 'cmdline-tools')
    onProgress('Instalando command-line tools…')
    const tmp = join(work, 'cmdline-extract')
    await rm(tmp, { recursive: true, force: true })
    await unzip(zip, tmp)
    // The zip contains a top-level `cmdline-tools/` — place it as `latest`.
    const latest = join(d.sdkRoot, 'cmdline-tools', 'latest')
    await mkdir(join(d.sdkRoot, 'cmdline-tools'), { recursive: true })
    await rm(latest, { recursive: true, force: true })
    await rename(join(tmp, 'cmdline-tools'), latest)
    await rm(zip, { force: true })
    d = await detect()
    if (!d.sdkmanager) throw new Error('sdkmanager não encontrado após instalar command-line tools.')
  }

  // 3) SDK packages via sdkmanager (accept licenses first)
  onProgress('Aceitando licenças do Android SDK…')
  await spawnTool(d.sdkmanager!, [`--sdk_root=${d.sdkRoot}`, '--licenses'], {
    env: d.env,
    input: 'y\n'.repeat(50),
    onLine: () => undefined
  })
  onProgress(`Instalando pacotes do SDK: ${SDK_PACKAGES.join(', ')} (pode demorar)…`)
  const inst = await spawnTool(
    d.sdkmanager!,
    [`--sdk_root=${d.sdkRoot}`, ...SDK_PACKAGES],
    { env: d.env, input: 'y\n'.repeat(50), onLine: (l) => /(Installing|Unzipping|done|%)/i.test(l) && onProgress(l) }
  )
  if (inst.code !== 0) throw new Error(`sdkmanager falhou: ${inst.out.slice(-400)}`)
  d = await detect()

  // 4) Default AVD
  if (!d.hasAvd && d.avdmanager) {
    onProgress(`Criando AVD padrão "${DEFAULT_AVD}"…`)
    const r = await spawnTool(
      d.avdmanager!,
      ['create', 'avd', '-n', DEFAULT_AVD, '-k', SYSTEM_IMAGE, '-d', 'pixel_6', '--force'],
      { env: d.env, input: 'no\n', onLine: (l) => onProgress(l) }
    )
    if (r.code !== 0) throw new Error(`avdmanager falhou: ${r.out.slice(-400)}`)
    d = await detect()
  }

  await rm(work, { recursive: true, force: true }).catch(() => undefined)
  onProgress(d.ready ? 'Toolchain Android pronta.' : `Ainda faltam: ${d.missing.join(', ')}`)
  return d
}

/** Quick check used by the UI/tools to give a helpful message before booting. */
export async function tmpScratch(): Promise<string> {
  // Some callers want a scratch dir on the same volume as the SDK.
  const base = await dataDir().catch(() => tmpdir())
  const dir = join(base, 'android-scratch')
  await mkdir(dir, { recursive: true })
  return dir
}

/** True if `stat` succeeds — small helper re-exported for the device module. */
export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}
