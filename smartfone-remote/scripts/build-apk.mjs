#!/usr/bin/env node
/*
 * Standalone APK builder for the Agent Remote app (CLI use).
 *
 * Capacitor 8 needs a JDK 21 and the Android SDK with android-36 (JAVA_HOME /
 * ANDROID_HOME, or what the desktop app installed in its userData). The desktop
 * app's "Gerar APK" button does the same steps but can also auto-install the
 * toolchain (see src/main/remote/buildApk.ts).
 *
 * Steps: npm install → npm run phone:build (repo root: src/phone → www/) →
 * cap add/sync android (recreating an android/ from an older template) →
 * gradlew assembleDebug → copy to dist/agent-remote.apk.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WIN = process.platform === 'win32'

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: 'inherit', shell: true })
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code ?? -1))
  })
}

// Make the adaptive icon background a solid full-bleed dark color (avoids the
// transparent ring @capacitor/assets' inset background can leave under larger
// launcher masks). The coral spark stays as the inset foreground.
function brandAdaptiveIcon(androidDir) {
  const res = join(androidDir, 'app/src/main/res')
  const colorXml =
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
    '    <color name="ic_launcher_background">#1f1e1d</color>\n</resources>\n'
  const adaptiveXml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/ic_launcher_background"/>\n' +
    '    <foreground>\n' +
    '        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />\n' +
    '    </foreground>\n</adaptive-icon>\n'
  try {
    writeFileSync(join(res, 'values/ic_launcher_background.xml'), colorXml)
    for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      writeFileSync(join(res, 'mipmap-anydpi-v26', f), adaptiveXml)
    }
    console.log('→ ícone adaptativo: fundo sólido escuro aplicado')
  } catch (e) {
    console.log('aviso: não foi possível ajustar o ícone adaptativo:', String(e))
  }
}

/** userData do app desktop (onde o android_setup instala JDK e SDK): o mesmo lugar que src/main/android/androidEnv.ts usa. */
function appDataDirs() {
  const home = homedir()
  const dirs = []
  if (process.env.AGENT_CODE_HOME) dirs.push(process.env.AGENT_CODE_HOME)
  if (WIN && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'agent-code-desktop'))
  if (process.platform === 'darwin') dirs.push(join(home, 'Library', 'Application Support', 'agent-code-desktop'))
  dirs.push(join(home, '.config', 'agent-code-desktop'), join(home, '.agent-code'))
  return dirs
}

/** O Capacitor 8 compila com Java 21; o Gradle 8.14 não roda em JDK mais novo. */
const JDK = 21
const java = (h) => existsSync(join(h, 'bin', WIN ? 'java.exe' : 'java'))
/** Versão principal pelo arquivo `release` do JDK (JAVA_VERSION="21.0.5"). */
function javaMajor(h) {
  try {
    const m = readFileSync(join(h, 'release'), 'utf8').match(/JAVA_VERSION="(\d+)/)
    return m ? Number(m[1]) : null
  } catch { return null }
}
const isJdk = (h) => java(h) && javaMajor(h) === JDK

/** JAVA_HOME que seja JDK 21, ou o JDK 21 que o app instalou (jdk-21 no userData), ou o do Android Studio. */
function findJavaHome() {
  if (process.env.JAVA_HOME && isJdk(process.env.JAVA_HOME)) return process.env.JAVA_HOME
  const bases = appDataDirs().map((d) => join(d, `jdk-${JDK}`))
  if (WIN) bases.push('C:\\Program Files\\Android\\Android Studio\\jbr')
  for (const base of bases) {
    if (isJdk(base)) return base
    let names = []
    try { names = readdirSync(base) } catch { continue }
    for (const n of names) for (const h of [join(base, n), join(base, n, 'Contents', 'Home')]) if (isJdk(h)) return h
  }
  return null
}

/** android/ de template anterior ao Capacitor 8 (compileSdk < 36, bridge_layout_main) ou sem variables.gradle. */
function isStaleAndroidProject(androidDir) {
  if (existsSync(join(androidDir, 'app/src/main/res/layout/bridge_layout_main.xml'))) return true
  let vars = ''
  try { vars = readFileSync(join(androidDir, 'variables.gradle'), 'utf8') } catch { /* sem arquivo */ }
  const m = vars.match(/compileSdkVersion\s*=\s*(\d+)/)
  return !m || Number(m[1]) < 36
}

/** ANDROID_HOME válido, ou o SDK que o app instalou, ou o do Android Studio. */
function findSdk() {
  const cands = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, ...appDataDirs().map((d) => join(d, 'android-sdk'))]
  if (WIN && process.env.LOCALAPPDATA) cands.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  cands.push(join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk'))
  return cands.find((c) => c && existsSync(join(c, 'platforms'))) ?? null
}

function findApk(dir) {
  const stack = [dir]
  let best = null
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = join(cur, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '.gradle'].includes(e.name)) stack.push(full)
      } else if (e.name.endsWith('.apk') && /[\\/]debug[\\/]/.test(full + '/')) best = full
    }
  }
  return best
}

/** node_modules absent or missing a declared dependency (e.g. the local plugins/parakeet-stt). */
function missingDependencies() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true
  let deps = {}
  try { deps = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).dependencies || {} } catch { return false }
  return Object.keys(deps).some((n) => !existsSync(join(ROOT, 'node_modules', n, 'package.json')))
}

async function main() {
  // `cap sync` only wires native plugins that are present in node_modules.
  if (missingDependencies()) {
    console.log('→ npm install')
    if ((await run('npm', ['install'])) !== 0) process.exit(1)
  }

  // The phone client (src/phone) is built by the repo root into www/.
  console.log('→ npm run phone:build (raiz do repositório)')
  if ((await run('npm', ['run', 'phone:build'], { cwd: join(ROOT, '..') })) !== 0) {
    console.error('Build do app do celular (npm run phone:build) falhou.')
    process.exit(1)
  }

  const androidDir = join(ROOT, 'android')
  if (existsSync(androidDir) && isStaleAndroidProject(androidDir)) {
    console.log('→ android/ de template antigo do Capacitor: recriando')
    rmSync(androidDir, { recursive: true, force: true, maxRetries: 3 })
  }
  if (!existsSync(androidDir)) {
    console.log('→ cap add android')
    if ((await run('npx', ['--yes', 'cap', 'add', 'android'])) !== 0) process.exit(1)
  }
  console.log('→ cap sync android')
  await run('npx', ['--yes', 'cap', 'sync', 'android'])

  // Brand the launcher/splash with the same art as the desktop app
  // (resources/ generated from build/icon.svg). Non-fatal.
  if (existsSync(join(ROOT, 'resources', 'icon-only.png'))) {
    console.log('→ capacitor-assets generate (ícone do app)')
    await run('npx', [
      '--yes', '@capacitor/assets', 'generate', '--android',
      '--iconBackgroundColor', '#1f1e1d',
      '--iconBackgroundColorDark', '#1f1e1d'
    ])
    brandAdaptiveIcon(androidDir)
  }

  // Ensure the in-app QR scanner can use the camera.
  const manifest = join(androidDir, 'app/src/main/AndroidManifest.xml')
  if (existsSync(manifest)) {
    let xml = readFileSync(manifest, 'utf8')
    if (!xml.includes('android.permission.CAMERA')) {
      const open = xml.match(/<manifest[^>]*>/)
      if (open) {
        xml = xml.replace(open[0], open[0] + '\n    <uses-permission android:name="android.permission.CAMERA" />')
        writeFileSync(manifest, xml)
        console.log('→ CAMERA permission added to AndroidManifest')
      }
    }
    if (!xml.includes('android.permission.RECORD_AUDIO')) {
      const open = xml.match(/<manifest[^>]*>/)
      if (open) {
        xml = xml.replace(open[0], open[0] +
          '\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />' +
          '\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />')
        writeFileSync(manifest, xml)
        console.log('→ RECORD_AUDIO permission added to AndroidManifest')
      }
    }
  }

  // Sem JAVA_HOME/ANDROID_HOME no ambiente: usa o toolchain que o app desktop instalou.
  const javaHome = findJavaHome()
  const sdk = findSdk()
  if (!javaHome || !sdk) {
    console.error(`Falta ${!javaHome ? `o JDK ${JDK}` : 'o Android SDK'}. Gere o APK uma vez pelo app (ele instala o toolchain) ou defina ${!javaHome ? 'JAVA_HOME' : 'ANDROID_HOME'}.`)
    process.exit(1)
  }
  process.env.JAVA_HOME = javaHome
  process.env.ANDROID_HOME = process.env.ANDROID_SDK_ROOT = sdk
  process.env.PATH = [join(javaHome, 'bin'), process.env.PATH].join(WIN ? ';' : ':')
  writeFileSync(join(androidDir, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`)
  console.log(`→ JDK: ${javaHome}\n→ SDK: ${sdk}`)

  console.log('→ gradlew assembleDebug')
  const gradlew = WIN ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew')
  if ((await run(gradlew, ['assembleDebug'], { cwd: androidDir })) !== 0) {
    console.error('Gradle build failed.')
    process.exit(1)
  }

  const apk =
    (existsSync(join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk'))
      ? join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')
      : findApk(androidDir))
  if (!apk) { console.error('No .apk produced.'); process.exit(1) }

  const dist = join(ROOT, 'dist')
  mkdirSync(dist, { recursive: true })
  const dest = join(dist, 'agent-remote.apk')
  copyFileSync(apk, dest)
  console.log('✓ APK pronto:', dest)
}

main().catch((e) => { console.error(e); process.exit(1) })
