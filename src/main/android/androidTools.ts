import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AndroidDevice } from './androidDevice'
import type { AndroidSession } from './androidSession'
import { detect, ensureInstalled, spawnTool, TIMEOUT_EXIT_CODE } from './androidEnv'
import { DEVICE_OPTIONS, findDevice } from '../../shared/devices'

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const WIN = process.platform === 'win32'

/** A full build of a Mapbox-sized app takes 1–3 min here; a build still running after this long
 *  is stuck (another Gradle build holding the lock, or a machine out of memory) — kill it and say
 *  so instead of blocking the agent's turn for the rest of the day. */
export const APK_BUILD_TIMEOUT_MS = 25 * 60_000

/** Rank for ordering split APKs: the preview runs on the x86_64 emulator, the universal one
 *  works everywhere, arm64 only on a phone. */
function apkRank(path: string): number {
  if (/x86_64/i.test(path)) return 0
  if (/universal/i.test(path)) return 1
  return 2
}

/** Debug .apks under a Gradle project's build outputs, newest first (x86_64 → universal →
 *  others within the same build). With ABI splits a single assembleDebug yields several. */
export async function findApks(projectDir: string): Promise<string[]> {
  const stack = [projectDir]
  const found: { path: string; mtime: number }[] = []
  let depth = 0
  while (stack.length && depth < 6000) {
    depth++
    const dir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', '.git', '.gradle'].includes(e.name)) stack.push(full)
      } else if (e.name.endsWith('.apk') && /[\\/]debug[\\/]/.test(full + '/')) {
        const mtime = await stat(full)
          .then((s) => s.mtimeMs)
          .catch(() => 0)
        found.push({ path: full, mtime })
      }
    }
  }
  // Same build = same second; compare mtimes coarsely so the ABI rank decides within a build.
  const bucket = (ms: number): number => Math.floor(ms / 5000)
  return found
    .sort((a, b) => bucket(b.mtime) - bucket(a.mtime) || apkRank(a.path) - apkRank(b.path))
    .map((f) => f.path)
}

/**
 * In-process MCP server exposing the Android device/emulator + build pipeline to
 * the agent. Interaction acts on this conversation's active device (the emulator
 * in its own window on the PC, or a phone over USB); setup/build are toolchain-level.
 */
export function createAndroidMcpServer(session: AndroidSession): ReturnType<typeof createSdkMcpServer> {
  const requireDevice = (): AndroidDevice => {
    const d = session.device
    if (!d) throw new Error('Nenhum aparelho Android ligado. Ligue com android_open_preview primeiro.')
    return d
  }
  const resize = async (device: AndroidDevice, w: number, h: number, dpi?: number): Promise<string> => {
    await device.setScreenSize(w, h, dpi)
    return `Tela ajustada para ${w}×${h}${dpi ? ` @ ${dpi}dpi` : ''}.`
  }

  return createSdkMcpServer({
    name: 'android',
    version: '1.0.0',
    tools: [
      tool(
        'android_setup',
        'Detect and install the Android toolchain (JDK 17, Android SDK command-line tools, platform-tools/adb, emulator, a system image, build-tools and a default AVD). Idempotent — only downloads what is missing. Run this once before building/previewing if the toolchain is not installed.',
        {},
        async () => {
          const lines: string[] = []
          const before = await detect()
          if (before.ready) return text('Toolchain Android já está instalada e pronta.')
          const after = await ensureInstalled((l) => lines.push(l))
          const tail = lines.slice(-25).join('\n')
          return text(
            after.ready
              ? `Toolchain Android instalada com sucesso.\n\nÚltimos passos:\n${tail}`
              : `Instalação incompleta. Ainda faltam: ${after.missing.join(', ')}.\n\n${tail}`
          )
        }
      ),
      tool(
        'android_open_preview',
        "Boot a device/emulator (uses a connected phone if present, otherwise the default AVD). The emulator opens in its own window on the user's PC — nothing is drawn inside the app. Returns once Android has finished booting, with the boot progress lines.",
        {},
        async () => {
          const lines: string[] = []
          const device = await session.open((l) => lines.push(l))
          return text(`Android ligado: ${device.model}.\n${lines.slice(-12).join('\n')}`)
        }
      ),
      tool(
        'android_list_devices',
        'List Android devices/emulators currently visible to adb.',
        {},
        async () => {
          const d = await detect()
          if (!d.adb) return text('adb não encontrado. Rode android_setup primeiro.')
          const r = await spawnTool(d.adb, ['devices', '-l'], { env: d.env })
          return text(r.out.trim() || 'Nenhum device.')
        }
      ),
      tool(
        'android_list_device_models',
        'List the available device presets (phones/tablets) with their screen resolutions, to use with android_set_device for testing the app at different screen sizes.',
        {},
        async () =>
          text(
            DEVICE_OPTIONS.map(
              (d) => `${d.id} — ${d.name} (${d.type}, ${d.width}x${d.height} @ ${d.dpi}dpi)`
            ).join('\n')
          )
      ),
      tool(
        'android_set_device',
        'Resize the active Android device to a device model (modelId from android_list_device_models) OR a custom resolution (width+height). Changes the emulator screen size so you can test the app at that exact size. Boots the device first if none is running.',
        {
          modelId: z.string().optional().describe('Preset id, e.g. "s26-ultra" or "tab-s9". Omit to use width/height.'),
          width: z.number().optional().describe('Custom screen width in px (used when modelId is omitted).'),
          height: z.number().optional().describe('Custom screen height in px (used when modelId is omitted).'),
          dpi: z.number().optional().describe('Optional density (dpi) for the custom size.')
        },
        async ({ modelId, width, height, dpi }) => {
          let device: AndroidDevice
          try {
            device = await session.open()
          } catch (e) {
            return text(`Não foi possível ligar o Android: ${e instanceof Error ? e.message : String(e)}`)
          }
          if (modelId) {
            const d = findDevice(modelId)
            if (!d) return text(`Modelo "${modelId}" não encontrado. Use android_list_device_models para ver os ids.`)
            return text(`${d.name}: ${await resize(device, d.width, d.height, d.dpi)}`)
          }
          if (width && height) return text(await resize(device, Math.round(width), Math.round(height), dpi))
          return text('Informe um modelId OU width e height.')
        }
      ),
      tool(
        'android_screenshot',
        'Capture a PNG screenshot of the active Android device and return it as an image.',
        {},
        async () => {
          const data = await requireDevice().screenshot()
          return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
        }
      ),
      tool(
        'android_tap',
        'Tap the Android screen at a normalized position (nx/ny are fractions 0..1 of width/height — e.g. center is 0.5, 0.5). Coordinates match the screenshot you capture.',
        {
          nx: z.number().min(0).max(1).describe('Horizontal position, 0 (left) .. 1 (right).'),
          ny: z.number().min(0).max(1).describe('Vertical position, 0 (top) .. 1 (bottom).')
        },
        async ({ nx, ny }) => {
          await requireDevice().tap(nx, ny)
          return text(`Toque em (${nx.toFixed(3)}, ${ny.toFixed(3)}).`)
        }
      ),
      tool(
        'android_swipe',
        'Swipe/scroll on the Android screen from one normalized point to another (fractions 0..1).',
        {
          nx1: z.number().min(0).max(1),
          ny1: z.number().min(0).max(1),
          nx2: z.number().min(0).max(1),
          ny2: z.number().min(0).max(1),
          durationMs: z.number().optional().describe('Gesture duration in ms (default 200).')
        },
        async ({ nx1, ny1, nx2, ny2, durationMs }) => {
          await requireDevice().swipe(nx1, ny1, nx2, ny2, durationMs ?? 200)
          return text('Swipe realizado.')
        }
      ),
      tool(
        'android_type',
        'Type text into the focused field on the Android screen.',
        { text: z.string().describe('The text to type.') },
        async ({ text: value }) => {
          await requireDevice().typeText(value)
          return text('Texto digitado.')
        }
      ),
      tool(
        'android_key',
        'Send an Android key event to the device (e.g. KEYCODE_ENTER, KEYCODE_BACK, KEYCODE_HOME, KEYCODE_DEL).',
        { keycode: z.string().describe('Android keycode, e.g. "KEYCODE_ENTER".') },
        async ({ keycode }) => {
          await requireDevice().key(keycode)
          return text(`Keyevent ${keycode} enviado.`)
        }
      ),
      tool(
        'android_build_apk',
        'Build a debug APK for an Android Gradle project (runs ./gradlew assembleDebug, killed after 25 min if stuck). Works for native projects and for the android/ folder of a Capacitor project. Returns the generated .apk path(s): with ABI splits, the x86_64 one (emulator) first, then universal, then arm64 (phone).',
        {
          projectDir: z.string().describe('Absolute path to the Gradle project root (the folder containing gradlew).')
        },
        async ({ projectDir }) => {
          const d = await detect()
          if (!d.hasJava || !d.hasSdk) {
            return text(`Toolchain incompleta (${d.missing.join(', ')}). Rode android_setup primeiro.`)
          }
          const gradlew = WIN ? join(projectDir, 'gradlew.bat') : join(projectDir, 'gradlew')
          const lines: string[] = []
          const r = await spawnTool(gradlew, ['assembleDebug', '--console=plain'], {
            env: d.env,
            cwd: projectDir,
            onLine: (l) => lines.push(l),
            timeoutMs: APK_BUILD_TIMEOUT_MS
          })
          if (r.code === TIMEOUT_EXIT_CODE) {
            return text(
              `Build não terminou em ${APK_BUILD_TIMEOUT_MS / 60_000} min e foi encerrado. Causas comuns: outro build do mesmo projeto rodando ao mesmo tempo (o Gradle espera o lock dele) ou máquina sem memória (emulador em renderização por software). Confira com "gradlew --status" e tente de novo com um build por vez.\n${lines.slice(-30).join('\n')}`
            )
          }
          if (r.code !== 0) {
            return text(`Build falhou (exit ${r.code}).\n${lines.slice(-30).join('\n')}`)
          }
          const apks = await findApks(projectDir)
          if (!apks.length) return text(`Build concluído, mas nenhum .apk encontrado em ${projectDir}.`)
          const outros = apks.length > 1 ? `\nOutros APKs do mesmo build:\n${apks.slice(1).join('\n')}` : ''
          const dica =
            apks.length > 1
              ? '\nSplits por ABI: no emulador use o x86_64; no celular, o arm64-v8a; o universal serve nos dois (mas é bem maior).'
              : ''
          return text(`APK gerado: ${apks[0]}${outros}${dica}\nUse android_install_run para instalar e abrir no aparelho.`)
        }
      ),
      tool(
        'android_install_run',
        'Install an APK on the device/emulator and launch it, so the user can see and test it in the emulator window (or on the connected phone). Boots a device first if none is running.',
        {
          apkPath: z.string().describe('Absolute path to the .apk to install.'),
          appName: z.string().optional().describe('App name, used only in the reply.')
        },
        async ({ apkPath, appName }) => {
          const device = await session.open()
          const pkg = await device.install(apkPath)
          if (pkg) await device.launch(pkg)
          return text(
            `APK${appName ? ` "${appName}"` : ''} instalado${pkg ? ` (${pkg})` : ''} e iniciado em ${device.model}.`
          )
        }
      )
    ]
  })
}
