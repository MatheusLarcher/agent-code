import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserController } from '../browserController'
import { detect, ensureInstalled, spawnTool } from './androidEnv'
import { DEVICE_OPTIONS, findDevice } from '../../shared/devices'

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const WIN = process.platform === 'win32'

/** Find the freshest debug .apk under a Gradle project's build outputs. */
async function findApk(projectDir: string): Promise<string | null> {
  const stack = [projectDir]
  let best: string | null = null
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
        best = full
      }
    }
  }
  // Fall back to any apk if no debug-specific path matched.
  return best
}

/**
 * In-process MCP server exposing the Android device/emulator + build pipeline to
 * the agent. Interaction acts on the active Android preview tab of this
 * conversation's BrowserController; setup/build are toolchain-level.
 */
export function createAndroidMcpServer(
  browser: BrowserController
): ReturnType<typeof createSdkMcpServer> {
  const requireDevice = (): ReturnType<BrowserController['activeAndroidDevice']> => {
    const d = browser.activeAndroidDevice()
    if (!d) throw new Error('Nenhuma aba Android ativa. Abra o preview com android_open_preview primeiro.')
    return d
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
        'Boot a device/emulator (uses a connected phone if present, otherwise the default AVD) and open an Android preview tab streaming its screen in the side panel. Returns once the screen is live.',
        {},
        async () => {
          const lines: string[] = []
          const device = await browser.openAndroidPreview((l) => lines.push(l))
          return text(`Preview Android aberto: ${device.model}.\n${lines.slice(-12).join('\n')}`)
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
        'Resize the active Android preview to a device model (modelId from android_list_device_models) OR a custom resolution (width+height). Changes the emulator screen size so you can test the app at that exact size. Opens the preview first if none is active.',
        {
          modelId: z.string().optional().describe('Preset id, e.g. "s26-ultra" or "tab-s9". Omit to use width/height.'),
          width: z.number().optional().describe('Custom screen width in px (used when modelId is omitted).'),
          height: z.number().optional().describe('Custom screen height in px (used when modelId is omitted).'),
          dpi: z.number().optional().describe('Optional density (dpi) for the custom size.')
        },
        async ({ modelId, width, height, dpi }) => {
          if (!browser.activeAndroidDevice()) {
            try {
              await browser.openAndroidPreview()
            } catch (e) {
              return text(`Não foi possível abrir o preview Android: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
          if (modelId) {
            const d = findDevice(modelId)
            if (!d) return text(`Modelo "${modelId}" não encontrado. Use android_list_device_models para ver os ids.`)
            return text(`${d.name}: ${await browser.setAndroidSize(d.width, d.height, d.dpi)}`)
          }
          if (width && height) {
            return text(await browser.setAndroidSize(Math.round(width), Math.round(height), dpi))
          }
          return text('Informe um modelId OU width e height.')
        }
      ),
      tool(
        'android_screenshot',
        'Capture a PNG screenshot of the active Android preview and return it as an image.',
        {},
        async () => {
          const data = await requireDevice()!.screenshot()
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
          await requireDevice()!.tap(nx, ny)
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
          await requireDevice()!.swipe(nx1, ny1, nx2, ny2, durationMs ?? 200)
          return text('Swipe realizado.')
        }
      ),
      tool(
        'android_type',
        'Type text into the focused field on the Android screen.',
        { text: z.string().describe('The text to type.') },
        async ({ text: value }) => {
          await requireDevice()!.typeText(value)
          return text('Texto digitado.')
        }
      ),
      tool(
        'android_key',
        'Send an Android key event to the device (e.g. KEYCODE_ENTER, KEYCODE_BACK, KEYCODE_HOME, KEYCODE_DEL).',
        { keycode: z.string().describe('Android keycode, e.g. "KEYCODE_ENTER".') },
        async ({ keycode }) => {
          await requireDevice()!.key(keycode)
          return text(`Keyevent ${keycode} enviado.`)
        }
      ),
      tool(
        'android_build_apk',
        'Build a debug APK for an Android Gradle project (runs ./gradlew assembleDebug). Works for native projects and for the android/ folder of a Capacitor project. Returns the path to the generated .apk.',
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
          const r = await spawnTool(gradlew, ['assembleDebug'], {
            env: d.env,
            cwd: projectDir,
            onLine: (l) => lines.push(l)
          })
          if (r.code !== 0) {
            return text(`Build falhou (exit ${r.code}).\n${lines.slice(-30).join('\n')}`)
          }
          const apk = await findApk(projectDir)
          return text(
            apk
              ? `APK gerado: ${apk}\nUse android_install_run para instalar e abrir no preview.`
              : `Build concluído, mas nenhum .apk encontrado em ${projectDir}.`
          )
        }
      ),
      tool(
        'android_install_run',
        'Install an APK on the device/emulator and launch it, opening the Android preview tab so the user can see and test it. Boots a device first if none is running.',
        {
          apkPath: z.string().describe('Absolute path to the .apk to install.'),
          appName: z.string().optional().describe('App name to show on the preview tab (android - <appName>).')
        },
        async ({ apkPath, appName }) => {
          const lines: string[] = []
          const device = await browser.openAndroidPreview((l) => lines.push(l))
          const pkg = await device.install(apkPath)
          if (pkg) await device.launch(pkg)
          if (appName) browser.setAndroidTabTitle(device, appName)
          return text(
            `APK instalado${pkg ? ` (${pkg})` : ''} e iniciado no preview${appName ? ` "android - ${appName}"` : ''}.`
          )
        }
      )
    ]
  })
}
