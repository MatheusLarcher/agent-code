import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { detect, ensureInstalled, type Progress } from '../android/androidEnv'

/**
 * Build the Android remote APK (the `smartfone-remote` Capacitor project),
 * reusing the same JDK/Android SDK manager the in‑app Android preview uses
 * (src/main/android/androidEnv.ts). Steps: ensure toolchain → npm install →
 * `cap add/sync android` → `gradlew assembleDebug` → copy to dist/agent-remote.apk.
 *
 * Idempotent and incremental: only installs/scaffolds what's missing.
 */

const WIN = process.platform === 'win32'

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Spawn a command, streaming trimmed output lines. `shell` resolves npm/npx
 *  (.cmd shims) on Windows. Resolves with the exit code. */
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: Progress } = {}
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true
    })
    const onData = (buf: Buffer): void => {
      if (!opts.onLine) return
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) opts.onLine(line.trim())
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (err) => {
      opts.onLine?.(String(err))
      resolve(-1)
    })
    child.on('close', (code) => resolve(code ?? -1))
  })
}

/** Depth‑first search for the freshest debug apk under a dir. */
async function findApk(dir: string): Promise<string | null> {
  const stack = [dir]
  let best: string | null = null
  let guard = 0
  while (stack.length && guard < 5000) {
    guard++
    const cur = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '.gradle'].includes(e.name)) stack.push(full)
      } else if (e.name.endsWith('.apk') && /[\\/]debug[\\/]/.test(full + '/')) {
        best = full
      }
    }
  }
  return best
}

/** Ensure the generated manifest declares CAMERA so the in‑app QR scanner
 *  (getUserMedia in the WebView) can request the camera. Idempotent. */
async function ensureCameraPermission(androidDir: string, onLine: Progress): Promise<void> {
  const manifest = join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
  let xml: string
  try {
    xml = await readFile(manifest, 'utf8')
  } catch {
    return
  }
  if (xml.includes('android.permission.CAMERA')) return
  const open = xml.match(/<manifest[^>]*>/)
  if (!open) return
  const perm = '\n    <uses-permission android:name="android.permission.CAMERA" />'
  await writeFile(manifest, xml.replace(open[0], open[0] + perm))
  onLine('Permissão de câmera adicionada ao AndroidManifest.')
}

export interface BuildResult {
  ok: boolean
  apkPath?: string
  message: string
}

/**
 * @param rootDir absolute path to the `smartfone-remote` project.
 * @param onLine  progress sink (each toolchain/npm/gradle line).
 */
export async function buildRemoteApk(rootDir: string, onLine: Progress): Promise<BuildResult> {
  // 1) Toolchain (JDK + Android SDK). Reuses the cached install if present.
  onLine('Verificando toolchain Android…')
  let d = await detect()
  if (!d.hasJava || !d.hasSdk) {
    onLine('Toolchain ausente — instalando (1ª vez baixa vários GB, pode demorar)…')
    d = await ensureInstalled(onLine)
  }
  if (!d.hasJava || !d.hasSdk) {
    return { ok: false, message: `Toolchain incompleta: ${d.missing.join(', ')}.` }
  }

  // 2) npm dependencies of the Capacitor project.
  if (!(await exists(join(rootDir, 'node_modules')))) {
    onLine('Instalando dependências do projeto (npm install)…')
    const code = await run('npm', ['install'], { cwd: rootDir, env: d.env, onLine })
    if (code !== 0) return { ok: false, message: 'npm install falhou.' }
  }

  // 3) Capacitor Android platform: add on first run, then sync the web assets.
  const androidDir = join(rootDir, 'android')
  if (!(await exists(androidDir))) {
    onLine('Criando plataforma Android (cap add android)…')
    const code = await run('npx', ['--yes', 'cap', 'add', 'android'], { cwd: rootDir, env: d.env, onLine })
    if (code !== 0) return { ok: false, message: 'cap add android falhou.' }
  }
  onLine('Sincronizando web → Android (cap sync)…')
  await run('npx', ['--yes', 'cap', 'sync', 'android'], { cwd: rootDir, env: d.env, onLine })
  await ensureCameraPermission(androidDir, onLine)

  // Brand the launcher/splash with the SAME art as the desktop app
  // (resources/ generated from build/icon.svg). Non-fatal: a failure here just
  // leaves the default Capacitor icon instead of aborting the build.
  if (await exists(join(rootDir, 'resources', 'icon-only.png'))) {
    onLine('Aplicando ícone do app (mesma arte do desktop)…')
    const iconCode = await run('npx', ['--yes', '@capacitor/assets', 'generate', '--android'], {
      cwd: rootDir,
      env: d.env,
      onLine
    })
    if (iconCode !== 0) onLine('Aviso: não foi possível gerar os ícones; usando o padrão.')
  }

  // 4) Gradle debug build.
  onLine('Compilando APK (gradlew assembleDebug)… isso pode levar alguns minutos.')
  const gradlew = WIN ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew')
  const code = await run(gradlew, ['assembleDebug'], { cwd: androidDir, env: d.env, onLine })
  if (code !== 0) return { ok: false, message: `Build Gradle falhou (exit ${code}).` }

  // 5) Locate and publish the APK where the bridge serves it (/download).
  const apk =
    (await exists(join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')))
      ? join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
      : await findApk(androidDir)
  if (!apk) return { ok: false, message: 'Build concluído, mas nenhum .apk encontrado.' }

  const dist = join(rootDir, 'dist')
  await mkdir(dist, { recursive: true })
  const dest = join(dist, 'agent-remote.apk')
  await copyFile(apk, dest)
  onLine(`APK pronto: ${dest}`)
  return { ok: true, apkPath: dest, message: `APK gerado em ${dest}` }
}
