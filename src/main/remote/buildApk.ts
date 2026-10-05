import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import {
  APK_COMPILE_SDK,
  detect,
  ensureApkToolchain,
  ensureInstalled,
  type ApkToolchain,
  type Progress
} from '../android/androidEnv'

/**
 * Build the Android remote APK (the `smartfone-remote` Capacitor project),
 * reusing the same JDK/Android SDK manager the in‑app Android preview uses
 * (src/main/android/androidEnv.ts). Steps: ensure toolchain (+ JDK 21/android-36
 * for Capacitor 8) → npm install → `npm run phone:build` (repo root: src/phone →
 * www/) → `cap add/sync android` (recreating an outdated android/) →
 * `gradlew assembleDebug` → copy to dist/agent-remote.apk.
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

/** Permissions added to the generated manifest: [marker that means "already
 *  there", lines to insert, log line]. CAMERA: the in‑app QR scanner and
 *  RECORD_AUDIO: voice dictation (both getUserMedia in the WebView);
 *  WRITE_EXTERNAL_STORAGE: DownloadManager on API < 29. */
const MANIFEST_PERMISSIONS: Array<[string, string[], string]> = [
  [
    'android.permission.CAMERA',
    ['<uses-permission android:name="android.permission.CAMERA" />'],
    'Permissão de câmera adicionada ao AndroidManifest.'
  ],
  [
    'android.permission.RECORD_AUDIO',
    [
      '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
      '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'
    ],
    'Permissão de microfone adicionada ao AndroidManifest.'
  ],
  [
    'WRITE_EXTERNAL_STORAGE',
    ['<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />'],
    'Permissão de armazenamento (download) adicionada ao AndroidManifest.'
  ]
]

/** Insert each missing permission right after `<manifest …>`. Idempotent; a
 *  manifest not generated yet is skipped. */
async function ensureManifestPermissions(androidDir: string, onLine: Progress): Promise<void> {
  const manifest = join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
  for (const [marker, lines, done] of MANIFEST_PERMISSIONS) {
    const xml = await readFile(manifest, 'utf8').catch(() => null)
    if (xml === null) return
    const open = xml.match(/<manifest[^>]*>/)
    if (xml.includes(marker) || !open) continue
    await writeFile(manifest, xml.replace(open[0], open[0] + lines.map((l) => `\n    ${l}`).join('')))
    onLine(done)
  }
}

/** Java source installed into the (gitignored, regenerated) Android project so the
 *  WebView saves files streamed by the PC bridge to the phone's Downloads.
 *
 *  Two paths, and the second is the one that actually runs in the app:
 *   - `setDownloadListener` only fires for a navigation the WebView itself
 *     handles. Measured on a real emulator: tapping "Baixar" with an
 *     `<a download href="http://<pc>/api/file…">` never reached it — Capacitor
 *     externalizes navigation to a host other than its own, so the tap **left
 *     the app and opened Chrome**, and nothing landed in Downloads. It stays
 *     only as a safety net for in-app navigations.
 *   - `AgentDownload.enqueue(url, name)` is a JavaScript interface the web
 *     client calls directly (the phone client in src/phone). No
 *     navigation, so nothing can be hijacked: the URL goes straight to
 *     DownloadManager. The URL is not taken on trust — it must point at the
 *     bridge the app is currently paired with (`/api/file`), so a page can't
 *     turn this into an arbitrary downloader. */
export const MAIN_ACTIVITY_JAVA = `package com.matheus.agentremote;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

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

        getBridge().getWebView().addJavascriptInterface(new DownloadBridge(), "AgentDownload");

        getBridge().getWebView().setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            enqueue(url, URLUtil.guessFileName(url, contentDisposition, mimeType), mimeType);
        });
    }

    /** Called from the web client (src/phone) instead of navigating. */
    public class DownloadBridge {
        @JavascriptInterface
        public void enqueue(String url, String fileName) {
            MainActivity.this.enqueue(url, fileName, null);
        }
    }

    private void enqueue(String url, String fileName, String mimeType) {
        runOnUiThread(() -> {
            try {
                Uri uri = Uri.parse(url);
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                boolean isBridgeFile = ("http".equals(scheme) || "https".equals(scheme))
                        && uri.getPath() != null && uri.getPath().endsWith("/api/file");
                if (!isBridgeFile) {
                    Toast.makeText(getApplicationContext(), "Download recusado: endereço inválido.", Toast.LENGTH_LONG).show();
                    return;
                }
                String name = (fileName == null || fileName.trim().isEmpty())
                        ? URLUtil.guessFileName(url, null, mimeType)
                        : fileName.replaceAll("[\\\\\\\\/:*?\\"<>|]", "_");
                DownloadManager.Request request = new DownloadManager.Request(uri);
                if (mimeType != null) request.setMimeType(mimeType);
                request.setTitle(name);
                request.setDescription("Agent Remote");
                request.allowScanningByMediaScanner();
                request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                if (dm == null) throw new IllegalStateException("DownloadManager indisponível");
                dm.enqueue(request);
                Toast.makeText(getApplicationContext(), "Baixando " + name + "…", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(getApplicationContext(), "Falha no download: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }
}
`

/**
 * Install download support into the generated Android project: overwrite
 * MainActivity with the version that wires the WebView download bridge (the
 * storage permission comes from MANIFEST_PERMISSIONS). Idempotent.
 */
async function ensureDownloadSupport(androidDir: string, onLine: Progress): Promise<void> {
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

/** True when node_modules is absent or lacks any dependency declared in package.json. */
export async function missingDependencies(rootDir: string): Promise<boolean> {
  let deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    deps = pkg.dependencies ?? {}
  } catch {
    /* unreadable package.json: fall back to the node_modules check */
  }
  if (!(await exists(join(rootDir, 'node_modules')))) return true
  for (const name of Object.keys(deps)) {
    if (!(await exists(join(rootDir, 'node_modules', name, 'package.json')))) return true
  }
  return false
}

/**
 * True when android/ is not a Capacitor 8 project: scaffolded by an older
 * template (compileSdk below APK_COMPILE_SDK, or the pre‑8 bridge_layout_main
 * layout) or broken (no variables.gradle). It's gitignored and regenerated with
 * `cap add android`; the customizations are re‑applied after every sync.
 */
export async function isStaleAndroidProject(androidDir: string): Promise<boolean> {
  if (await exists(join(androidDir, 'app', 'src', 'main', 'res', 'layout', 'bridge_layout_main.xml'))) return true
  const vars = await readFile(join(androidDir, 'variables.gradle'), 'utf8').catch(() => '')
  const m = vars.match(/compileSdkVersion\s*=\s*(\d+)/)
  return !m || Number(m[1]) < APK_COMPILE_SDK
}

/** The phone client (src/phone) is built by the repo root — parent of the
 *  Capacitor project — into smartfone-remote/www, the web assets `cap sync` packs. */
export function phoneBuildCommand(rootDir: string): { cmd: string; args: string[]; cwd: string } {
  return { cmd: 'npm', args: ['run', 'phone:build'], cwd: join(rootDir, '..') }
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
  // Capacitor 8 compiles with JDK 21 against android-36 (the preview keeps JDK 17/android-34).
  let apkTools: ApkToolchain
  try {
    apkTools = await ensureApkToolchain(onLine)
  } catch (err) {
    return { ok: false, message: `Toolchain do APK incompleta: ${err instanceof Error ? err.message : String(err)}` }
  }
  onLine(`JDK do build: ${apkTools.javaHome}`)

  // Make sure npm/npx/node resolve regardless of how the app was launched: the
  // Electron process doesn't always inherit Node on its PATH (e.g. when not
  // started from start.bat). Prepend the located Node dir to the build env's PATH.
  const env: NodeJS.ProcessEnv = { ...apkTools.env }
  const nodeBin = await findNodeBin(rootDir)
  if (nodeBin) {
    env['PATH'] = nodeBin + delimiter + (env['PATH'] || '')
    onLine(`Usando Node em: ${nodeBin}`)
  } else {
    onLine('Aviso: Node não localizado; tentando usar o npm do PATH do sistema…')
  }

  // 2) npm dependencies of the Capacitor project. Also re-run when a dependency
  //    is missing (e.g. the local plugins/parakeet-stt added after the first
  //    install): `cap sync` only wires native plugins present in node_modules.
  if (await missingDependencies(rootDir)) {
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

  // 3) Phone web client: src/phone → www/ (vite build of the repo root).
  const phone = phoneBuildCommand(rootDir)
  onLine('Gerando o app do celular (npm run phone:build)…')
  if ((await run(phone.cmd, phone.args, { cwd: phone.cwd, env, onLine })) !== 0) {
    return {
      ok: false,
      message: `Build do app do celular falhou (npm run phone:build em ${phone.cwd}). Veja os logs acima.`
    }
  }

  // 4) Capacitor Android platform: (re)create when absent or from an older
  //    template, then sync the web assets.
  const androidDir = join(rootDir, 'android')
  if ((await exists(androidDir)) && (await isStaleAndroidProject(androidDir))) {
    onLine('android/ é de um template antigo do Capacitor — recriando com cap add android…')
    try {
      await rm(androidDir, { recursive: true, force: true, maxRetries: 3 })
    } catch (err) {
      return { ok: false, message: `Não foi possível apagar o android/ antigo (${String(err)}). Feche o Android Studio e tente de novo.` }
    }
  }
  if (!(await exists(androidDir))) {
    onLine('Criando plataforma Android (cap add android)…')
    const code = await run('npx', ['--yes', 'cap', 'add', 'android'], { cwd: rootDir, env, onLine })
    if (code !== 0) return { ok: false, message: 'cap add android falhou.' }
  }
  onLine('Sincronizando web → Android (cap sync)…')
  await run('npx', ['--yes', 'cap', 'sync', 'android'], { cwd: rootDir, env, onLine })
  await ensureManifestPermissions(androidDir, onLine)
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

  // 5) Gradle debug build (JDK 21 from apkTools.env).
  onLine('Compilando APK (gradlew assembleDebug)… isso pode levar alguns minutos.')
  const gradlew = WIN ? join(androidDir, 'gradlew.bat') : join(androidDir, 'gradlew')
  const code = await run(gradlew, ['assembleDebug'], { cwd: androidDir, env, onLine })
  if (code !== 0) return { ok: false, message: `Build Gradle falhou (exit ${code}).` }

  // 6) Locate and publish the APK where the bridge serves it (/download).
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
