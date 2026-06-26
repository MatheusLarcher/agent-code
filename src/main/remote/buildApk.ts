import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
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

/**
 * Find a directory that contains `npm` (and `node`), so the build never depends
 * on the Electron process having Node on its PATH — the cause of the
 * "'npm' não é reconhecido" failure when the app isn't launched from start.bat.
 *
 * Checks, in order: the portable Node that start.bat downloads
 * (`.node/node-*-win-x64` at the repo root, sibling of smartfone-remote), then
 * the dir of the currently running node binary, then common system installs.
 * Returns the dir, or null if it couldn't be found (npm may still be on PATH).
 */
async function findNodeBin(rootDir: string): Promise<string | null> {
  const npmName = WIN ? 'npm.cmd' : 'npm'
  const hasNpm = async (dir: string): Promise<boolean> => exists(join(dir, npmName))

  // 1) Portable Node downloaded by start.bat (repo root = parent of rootDir).
  const nodeCache = join(rootDir, '..', '.node')
  try {
    for (const name of await readdir(nodeCache)) {
      const cand = join(nodeCache, name)
      if (await hasNpm(cand)) return cand
    }
  } catch {
    /* no .node dir — fall through */
  }

  // 2) The directory of the node binary that is currently running, if any
  //    (process.execPath is electron.exe under Electron, but worth a look).
  const execDir = dirname(process.execPath)
  if (await hasNpm(execDir)) return execDir

  // 3) Common system install locations.
  const candidates = WIN
    ? [
        process.env['ProgramFiles'] && join(process.env['ProgramFiles'], 'nodejs'),
        process.env['ProgramW6432'] && join(process.env['ProgramW6432'], 'nodejs'),
        process.env['APPDATA'] && join(process.env['APPDATA'], 'npm')
      ]
    : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin']
  for (const c of candidates) {
    if (c && (await hasNpm(c))) return c
  }
  return null
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

/** Ensure the manifest declares RECORD_AUDIO so the chat's voice dictation
 *  (getUserMedia in the WebView) can request the microphone. Idempotent. */
async function ensureMicrophonePermission(androidDir: string, onLine: Progress): Promise<void> {
  const manifest = join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
  let xml: string
  try {
    xml = await readFile(manifest, 'utf8')
  } catch {
    return
  }
  if (xml.includes('android.permission.RECORD_AUDIO')) return
  const open = xml.match(/<manifest[^>]*>/)
  if (!open) return
  const perm =
    '\n    <uses-permission android:name="android.permission.RECORD_AUDIO" />' +
    '\n    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'
  await writeFile(manifest, xml.replace(open[0], open[0] + perm))
  onLine('Permissão de microfone adicionada ao AndroidManifest.')
}

/** Java source installed into the (gitignored, regenerated) Android project so the
 *  WebView saves files streamed by the PC bridge to the phone's Downloads. */
const MAIN_ACTIVITY_JAVA = `package com.matheus.agentremote;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

// Wires a WebView download listener so files streamed by the PC bridge
// (GET /api/file, Content-Disposition: attachment) are saved to the phone's
// public Downloads folder via DownloadManager. Managed by buildApk.ts.
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this, new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, 1);
        }

        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
                DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                request.setMimeType(mimeType);
                if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
                request.setTitle(fileName);
                request.setDescription("Agent Remote");
                request.allowScanningByMediaScanner();
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm != null) dm.enqueue(request);
                Toast.makeText(getApplicationContext(), "Baixando " + fileName + "…", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(getApplicationContext(), "Falha no download: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }
}
`

/**
 * Install download support into the generated Android project: declare
 * WRITE_EXTERNAL_STORAGE (only needed pre‑API 29) and overwrite MainActivity with
 * the version that wires a WebView download listener. Idempotent.
 */
async function ensureDownloadSupport(androidDir: string, onLine: Progress): Promise<void> {
  // 1) Storage permission for DownloadManager on API < 29.
  const manifest = join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
  try {
    const xml = await readFile(manifest, 'utf8')
    if (!xml.includes('WRITE_EXTERNAL_STORAGE')) {
      const open = xml.match(/<manifest[^>]*>/)
      if (open) {
        const perm =
          '\n    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />'
        await writeFile(manifest, xml.replace(open[0], open[0] + perm))
        onLine('Permissão de armazenamento (download) adicionada ao AndroidManifest.')
      }
    }
  } catch {
    /* manifest not generated yet — skip */
  }
  // 2) MainActivity with the download listener.
  const activity = join(androidDir, 'app', 'src', 'main', 'java', 'com', 'matheus', 'agentremote', 'MainActivity.java')
  try {
    const cur = await readFile(activity, 'utf8').catch(() => '')
    if (cur !== MAIN_ACTIVITY_JAVA) {
      await writeFile(activity, MAIN_ACTIVITY_JAVA)
      onLine('MainActivity: download de arquivos no app habilitado.')
    }
  } catch (err) {
    onLine(`Aviso: não foi possível habilitar o download no app (${String(err)}).`)
  }
}

/** Dark used for the adaptive-icon background (matches the desktop icon). */
const ICON_BG = '#1f1e1d'

/**
 * Make the adaptive icon background a SOLID full-bleed color instead of the
 * inset background image @capacitor/assets emits (its 16.7% inset can leave a
 * transparent ring under the larger masks some launchers use). The coral spark
 * stays as the inset foreground. Idempotent; safe to re-run. */
async function brandAdaptiveIcon(androidDir: string, onLine: Progress): Promise<void> {
  const res = join(androidDir, 'app', 'src', 'main', 'res')
  const colorXml =
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n' +
    `    <color name="ic_launcher_background">${ICON_BG}</color>\n</resources>\n`
  const adaptiveXml =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n' +
    '    <background android:drawable="@color/ic_launcher_background"/>\n' +
    '    <foreground>\n' +
    '        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />\n' +
    '    </foreground>\n</adaptive-icon>\n'
  try {
    await writeFile(join(res, 'values', 'ic_launcher_background.xml'), colorXml)
    for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      await writeFile(join(res, 'mipmap-anydpi-v26', f), adaptiveXml)
    }
    onLine('Ícone adaptativo: fundo sólido escuro aplicado.')
  } catch (err) {
    onLine(`Aviso: não foi possível ajustar o ícone adaptativo (${String(err)}).`)
  }
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

  // Make sure npm/npx/node resolve regardless of how the app was launched: the
  // Electron process doesn't always inherit Node on its PATH (e.g. when not
  // started from start.bat). Prepend the located Node dir to the build env's PATH.
  const env: NodeJS.ProcessEnv = { ...d.env }
  const nodeBin = await findNodeBin(rootDir)
  if (nodeBin) {
    env['PATH'] = nodeBin + delimiter + (env['PATH'] || '')
    onLine(`Usando Node em: ${nodeBin}`)
  } else {
    onLine('Aviso: Node não localizado; tentando usar o npm do PATH do sistema…')
  }

  // 2) npm dependencies of the Capacitor project.
  if (!(await exists(join(rootDir, 'node_modules')))) {
    onLine('Instalando dependências do projeto (npm install)…')
    const code = await run('npm', ['install'], { cwd: rootDir, env, onLine })
    if (code !== 0) {
      return {
        ok: false,
        message: nodeBin
          ? 'npm install falhou. Veja os logs acima.'
          : "npm install falhou: Node.js não encontrado. Abra o app pelo start.bat (que baixa o Node automaticamente) ou instale o Node.js."
      }
    }
  }

  // 3) Capacitor Android platform: add on first run, then sync the web assets.
  const androidDir = join(rootDir, 'android')
  if (!(await exists(androidDir))) {
    onLine('Criando plataforma Android (cap add android)…')
    const code = await run('npx', ['--yes', 'cap', 'add', 'android'], { cwd: rootDir, env, onLine })
    if (code !== 0) return { ok: false, message: 'cap add android falhou.' }
  }
  onLine('Sincronizando web → Android (cap sync)…')
  await run('npx', ['--yes', 'cap', 'sync', 'android'], { cwd: rootDir, env, onLine })
  await ensureCameraPermission(androidDir, onLine)
  await ensureMicrophonePermission(androidDir, onLine)
  await ensureDownloadSupport(androidDir, onLine)

  // Brand the launcher/splash with the SAME art as the desktop app
  // (resources/ generated from build/icon.svg). Non-fatal: a failure here just
  // leaves the default Capacitor icon instead of aborting the build.
  if (await exists(join(rootDir, 'resources', 'icon-only.png'))) {
    onLine('Aplicando ícone do app (mesma arte do desktop)…')
    // Solid dark background (fills the whole adaptive icon, no inset gaps); the
    // coral spark is the foreground.
    const iconArgs = [
      '--yes', '@capacitor/assets', 'generate', '--android',
      '--iconBackgroundColor', '#1f1e1d',
      '--iconBackgroundColorDark', '#1f1e1d'
    ]
    const iconCode = await run('npx', iconArgs, { cwd: rootDir, env, onLine })
    if (iconCode !== 0) onLine('Aviso: não foi possível gerar os ícones; usando o padrão.')
    else await brandAdaptiveIcon(androidDir, onLine)
  }

  // 4) Gradle debug build.
  onLine('Compilando APK (gradlew assembleDebug)… isso pode levar alguns minutos.')
  const gradlew = WIN ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew')
  const code = await run(gradlew, ['assembleDebug'], { cwd: androidDir, env, onLine })
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
