#!/usr/bin/env node
/*
 * Standalone APK builder for the Agent Remote app (CLI use).
 *
 * Assumes a JDK 17 and the Android SDK are available (ANDROID_HOME / JAVA_HOME),
 * e.g. from Android Studio. The desktop app's "Gerar APK" button does the same
 * steps but can also auto-install the toolchain (see src/main/remote/buildApk.ts).
 *
 * Steps: npm install → cap add/sync android → gradlew assembleDebug → copy to
 * dist/agent-remote.apk.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

async function main() {
  if (!existsSync(join(ROOT, 'node_modules'))) {
    console.log('→ npm install')
    if ((await run('npm', ['install'])) !== 0) process.exit(1)
  }

  const androidDir = join(ROOT, 'android')
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
    await run('npx', ['--yes', '@capacitor/assets', 'generate', '--android'])
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
  }

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
