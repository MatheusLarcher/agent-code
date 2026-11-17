import { spawn, type ChildProcess } from 'node:child_process'
import { detect, spawnTool, DEFAULT_AVD, type DetectResult, type Progress } from './androidEnv'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Every adb call gets a deadline: when the emulator dies or freezes mid-command, adb never
 *  returns on its own, and a tool call that never returns stalls the agent's whole turn. */
const ADB_TIMEOUT_MS = 20_000
/** Installing a 100–300 MB APK on the emulator takes seconds, on a phone over USB minutes. */
const INSTALL_TIMEOUT_MS = 10 * 60_000

/** Read width/height from a PNG buffer's IHDR chunk (bytes 16..24, big-endian). */
function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * Arguments of the emulator the app boots. No `-no-window`: the emulator shows up
 * as a normal window on the user's PC (nothing is mirrored inside the app).
 */
export function emulatorArgs(avd: string = DEFAULT_AVD): string[] {
  return [
    '-avd',
    avd,
    '-no-snapshot',
    '-no-boot-anim',
    // -gpu host: render on the real GPU. The software renderer (swiftshader), for a
    // Mapbox-class app, burned ~10 cores, grew qemu to 6–22 GB until Windows ran out of
    // virtual memory, and could not even link the map's shaders (black map).
    // `angle_indirect` no longer exists in emulator 36.
    '-gpu',
    'host',
    // Host Vulkan off: apps use GLES, and the NVIDIA GL/Vulkan driver crashed qemu once
    // while an app was being torn down (nvoglv64.dll, 0xc0000409).
    '-feature',
    '-Vulkan',
    // Emulator 36 ignores hw.ramSize from config.ini; with the 2.5 GB it picks, Android 14
    // keeps ~700 MB in zram swap and the app under test stutters. 4 GB keeps it off swap.
    '-memory',
    '4096',
    '-netdelay',
    'none',
    '-netspeed',
    'full'
  ]
}

/**
 * One live Android device or emulator for a conversation: boots it (preferring a
 * physically-connected device, else the default AVD in its own window), captures
 * the screen on demand via `adb exec-out screencap`, and sends taps/keys/text via
 * `adb shell input`.
 */
export class AndroidDevice {
  private env: NodeJS.ProcessEnv = process.env
  private adb = 'adb'
  private serial = ''
  private emulatorProc: ChildProcess | null = null
  private startedEmulator = false
  private lastSize = { width: 1080, height: 2400 }
  /** True once android_set_device changed the resolution — only then stop() restores it. */
  private sizeOverridden = false
  /** Display name, e.g. "Pixel 6" or "emulator-5554". */
  model = 'Android'

  get deviceSerial(): string {
    return this.serial
  }

  /** Make sure a device is online and ready. Throws (with a helpful message) if the
   *  toolchain isn't installed yet — the caller should run android_setup first. */
  async ensureBooted(onProgress: Progress = () => undefined): Promise<void> {
    if (this.serial) return
    const d = await detect()
    if (!d.hasSdk || !d.adb) {
      throw new Error(
        `Toolchain Android ausente (${d.missing.join(', ')}). Rode "android_setup" para instalar.`
      )
    }
    this.env = d.env
    this.adb = d.adb

    await this.adbRun(['start-server'], 60_000)
    const existing = await this.onlineDevices()
    if (existing.length > 0) {
      this.serial = existing[0]
      onProgress(`Usando device conectado: ${this.serial}`)
    } else {
      await this.bootEmulator(d, onProgress)
    }

    onProgress('Aguardando o Android terminar de iniciar…')
    await this.adbRun(['-s', this.serial, 'wait-for-device'], 180_000)
    await this.waitBootComplete()
    this.model = (await this.prop('ro.product.model')) || this.serial
    await this.refreshSize()
    onProgress(`Android pronto: ${this.model} (${this.serial}).`)
  }

  /** adb with the toolchain env and a deadline (see ADB_TIMEOUT_MS). */
  private adbRun(args: string[], timeoutMs = ADB_TIMEOUT_MS): ReturnType<typeof spawnTool> {
    return spawnTool(this.adb, args, { env: this.env, timeoutMs })
  }

  /** Serials currently in "device" state (excludes "offline"/"unauthorized"). */
  private async onlineDevices(): Promise<string[]> {
    const r = await this.adbRun(['devices'])
    return r.out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => /\tdevice$/.test(l))
      .map((l) => l.split('\t')[0])
  }

  private async bootEmulator(d: DetectResult, onProgress: Progress): Promise<void> {
    if (!d.emulator || !d.hasAvd) {
      throw new Error(`Emulador indisponível (${d.missing.join(', ')}). Rode "android_setup".`)
    }
    onProgress(`Iniciando emulador (${DEFAULT_AVD})…`)
    const before = new Set(await this.onlineDevices())
    this.emulatorProc = spawn(d.emulator, emulatorArgs(), { env: this.env, detached: false, stdio: 'ignore' })
    this.emulatorProc.on('error', () => undefined)
    this.startedEmulator = true
    // Wait (up to ~120s) for a NEW emulator serial to appear.
    for (let i = 0; i < 120; i++) {
      await delay(1000)
      const now = await this.onlineDevices()
      const fresh = now.find((s) => !before.has(s)) || now.find((s) => /^emulator-/.test(s))
      if (fresh) {
        this.serial = fresh
        return
      }
      if (this.emulatorProc?.exitCode != null) {
        throw new Error(
          'O emulador encerrou ao iniciar (verifique a virtualização/WHPX no Windows e o driver de vídeo da GPU).'
        )
      }
    }
    throw new Error('Tempo esgotado aguardando o emulador aparecer no adb.')
  }

  private async waitBootComplete(): Promise<void> {
    for (let i = 0; i < 120; i++) {
      if ((await this.prop('sys.boot_completed')) === '1') return
      await delay(1000)
    }
  }

  private async prop(name: string): Promise<string> {
    const r = await this.adbRun(['-s', this.serial, 'shell', 'getprop', name])
    return r.out.trim()
  }

  private async refreshSize(): Promise<void> {
    const r = await this.adbRun(['-s', this.serial, 'shell', 'wm', 'size'])
    const m = r.out.match(/(\d+)x(\d+)/)
    if (m) this.lastSize = { width: Number(m[1]), height: Number(m[2]) }
  }

  // ---- captura ----

  /** Run an adb command and collect its raw binary stdout. Killed (and rejected) after
   *  `timeoutMs`: adb hangs forever when the emulator dies mid-transfer. */
  private capture(args: string[], timeoutMs = 15_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.adb, ['-s', this.serial, ...args], { env: this.env })
      const chunks: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`adb ${args.join(' ')} não respondeu em ${timeoutMs / 1000}s`))
      }, timeoutMs)
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks))
      })
    })
  }

  /** Capture a single PNG screenshot (base64) — used by android_screenshot. */
  async screenshot(): Promise<string> {
    const png = await this.capture(['exec-out', 'screencap', '-p'])
    const size = pngSize(png)
    if (size) this.lastSize = size
    return png.toString('base64')
  }

  // ---- input (normalized coords 0..1 → device pixels) ----

  private px(nx: number, ny: number): [number, number] {
    return [Math.round(nx * this.lastSize.width), Math.round(ny * this.lastSize.height)]
  }

  async tap(nx: number, ny: number): Promise<void> {
    const [x, y] = this.px(nx, ny)
    await this.adbRun(['-s', this.serial, 'shell', 'input', 'tap', String(x), String(y)])
  }

  async swipe(nx1: number, ny1: number, nx2: number, ny2: number, ms = 200): Promise<void> {
    const [x1, y1] = this.px(nx1, ny1)
    const [x2, y2] = this.px(nx2, ny2)
    await this.adbRun([
      '-s',
      this.serial,
      'shell',
      'input',
      'swipe',
      String(x1),
      String(y1),
      String(x2),
      String(y2),
      String(ms)
    ])
  }

  async typeText(text: string): Promise<void> {
    // adb's `input text` uses %s for spaces; pass as a single literal arg (shell:false).
    const escaped = text.replace(/ /g, '%s')
    await this.adbRun(['-s', this.serial, 'shell', 'input', 'text', escaped])
  }

  async key(keycode: string): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'input', 'keyevent', keycode])
  }

  /** Override the device resolution (and density) to a chosen model's screen size.
   *  screencap then returns this size, so taps stay aligned. */
  async setScreenSize(width: number, height: number, dpi?: number): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'size', `${width}x${height}`])
    if (dpi && dpi > 0) {
      await this.adbRun(['-s', this.serial, 'shell', 'wm', 'density', String(dpi)])
    }
    this.lastSize = { width, height }
    this.sizeOverridden = true
  }

  /** Restore the device's native resolution/density. */
  async resetScreenSize(): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'size', 'reset']).catch(() => undefined)
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'density', 'reset']).catch(() => undefined)
    await this.refreshSize()
  }

  // ---- app lifecycle ----

  /** Install (or replace) an APK and return its package name (via pm/dumpsys). */
  async install(apkPath: string): Promise<string> {
    const r = await this.adbRun(['-s', this.serial, 'install', '-r', '-t', apkPath], INSTALL_TIMEOUT_MS)
    if (!/Success/i.test(r.out)) throw new Error(`adb install falhou: ${r.out.slice(-300)}`)
    // Most-recently installed 3rd-party package.
    const pkgs = await this.adbRun(['-s', this.serial, 'shell', 'pm', 'list', 'packages', '-3', '-U'])
    const last = pkgs.out.split(/\r?\n/).map((l) => l.match(/package:(\S+)/)?.[1]).filter(Boolean).pop()
    return last ?? ''
  }

  /** Launch the default/launcher activity of a package. */
  async launch(pkg: string): Promise<void> {
    await this.adbRun(
      ['-s', this.serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
      60_000
    )
  }

  // ---- teardown ----

  async stop(): Promise<void> {
    if (this.startedEmulator && this.serial) {
      await this.adbRun(['-s', this.serial, 'emu', 'kill']).catch(() => undefined)
    } else if (this.serial && this.sizeOverridden) {
      // We're leaving a pre-existing device/emulator running — restore its native
      // resolution so an android_set_device override doesn't stick.
      await this.resetScreenSize().catch(() => undefined)
    }
    this.sizeOverridden = false
    try {
      this.emulatorProc?.kill()
    } catch {
      /* already gone */
    }
    this.emulatorProc = null
    this.serial = ''
  }
}
