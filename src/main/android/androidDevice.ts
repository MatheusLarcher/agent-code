import { spawn, type ChildProcess } from 'node:child_process'
import { detect, spawnTool, DEFAULT_AVD, type DetectResult, type Progress } from './androidEnv'

/** A frame captured from the device screen (PNG, base64-encoded). */
export interface DeviceFrame {
  data: string
  width: number
  height: number
}

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
 * One live Android device or emulator for a conversation: boots it (preferring a
 * physically-connected device, else the default AVD), streams the screen via
 * `adb exec-out screencap`, and forwards taps/keys/text via `adb shell input`.
 */
export class AndroidDevice {
  private env: NodeJS.ProcessEnv = process.env
  private adb = 'adb'
  private serial = ''
  private emulatorProc: ChildProcess | null = null
  private startedEmulator = false
  private streaming = false
  private lastSize = { width: 1080, height: 2400 }
  /** Display name for the tab title, e.g. "Pixel 6" or "emulator-5554". */
  model = 'Android'

  get deviceSerial(): string {
    return this.serial
  }

  /** Current (possibly overridden) screen size in px — drives the UI device frame. */
  get screenSize(): { width: number; height: number } {
    return { ...this.lastSize }
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
    this.emulatorProc = spawn(
      d.emulator,
      [
        '-avd',
        DEFAULT_AVD,
        '-no-snapshot',
        '-no-boot-anim',
        // -no-window: we only ever read the screen via `adb exec-out screencap` (see
        // DeviceFrame/streaming above) — the emulator's own GUI window is unused, and
        // without this flag it shows up as its own icon in the Windows taskbar.
        '-no-window',
        // -gpu host: render on the real GPU. Under -no-window, `auto` resolves to the software
        // renderer (swiftshader), which for a Mapbox-class app burned ~10 cores, grew qemu to
        // 6–22 GB until Windows ran out of virtual memory, and could not even link the map's
        // shaders (black map). `angle_indirect` no longer exists in emulator 36.
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
      ],
      { env: this.env, detached: false, stdio: 'ignore' }
    )
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

  // ---- streaming ----

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

  /** Shortest gap between two frames while someone is watching (a 1080×2400 `screencap -p`
   *  costs the device ~250 ms of one core, so ~2 fps is the most it can afford). */
  static readonly FRAME_INTERVAL_MS = 500
  /** How often an unwatched stream re-checks whether it is being watched again. */
  static readonly IDLE_INTERVAL_MS = 1000

  /** Begin pushing frames to onFrame until stop() is called — at most ~2 fps, and only while
   *  `isWatched()` is true. Without that gate an Android tab left open in a background
   *  conversation kept the device encoding PNGs forever (half a core, measured), slowing
   *  every app under test and every screenshot the agent took. */
  startStreaming(onFrame: (f: DeviceFrame) => void, isWatched: () => boolean = () => true): void {
    if (this.streaming) return
    this.streaming = true
    void (async () => {
      while (this.streaming) {
        if (!isWatched()) {
          await delay(AndroidDevice.IDLE_INTERVAL_MS)
          continue
        }
        const started = Date.now()
        try {
          const png = await this.capture(['exec-out', 'screencap', '-p'])
          const size = pngSize(png)
          if (size) this.lastSize = size
          if (png.length > 0) {
            onFrame({
              data: png.toString('base64'),
              width: size?.width ?? this.lastSize.width,
              height: size?.height ?? this.lastSize.height
            })
          }
        } catch {
          /* device busy / transient */
        }
        const rest = AndroidDevice.FRAME_INTERVAL_MS - (Date.now() - started)
        await delay(rest > 50 ? rest : 50)
      }
    })()
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

  /** Vertical wheel scroll: translate a wheel delta into a swipe gesture. */
  async wheel(nx: number, ny: number, dy: number): Promise<void> {
    const frac = Math.max(-0.4, Math.min(0.4, -dy / 1000))
    await this.swipe(nx, ny, nx, Math.max(0, Math.min(1, ny + frac)), 120)
  }

  async typeText(text: string): Promise<void> {
    // adb's `input text` uses %s for spaces; pass as a single literal arg (shell:false).
    const escaped = text.replace(/ /g, '%s')
    await this.adbRun(['-s', this.serial, 'shell', 'input', 'text', escaped])
  }

  async key(keycode: string): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'input', 'keyevent', keycode])
  }

  /** Override the device resolution (and density) so the preview shows a chosen
   *  model's screen size. screencap then returns this size, so taps stay aligned. */
  async setScreenSize(width: number, height: number, dpi?: number): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'size', `${width}x${height}`])
    if (dpi && dpi > 0) {
      await this.adbRun(['-s', this.serial, 'shell', 'wm', 'density', String(dpi)])
    }
    this.lastSize = { width, height }
  }

  /** Restore the device's native resolution/density. */
  async resetScreenSize(): Promise<void> {
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'size', 'reset']).catch(() => undefined)
    await this.adbRun(['-s', this.serial, 'shell', 'wm', 'density', 'reset']).catch(() => undefined)
    await this.refreshSize()
  }

  back(): Promise<void> {
    return this.key('KEYCODE_BACK')
  }

  home(): Promise<void> {
    return this.key('KEYCODE_HOME')
  }

  /** Map a renderer key name to an Android keyevent (best-effort). */
  async sendKeyName(key: string, text?: string): Promise<void> {
    if (text && text.length === 1) return this.typeText(text)
    const map: Record<string, string> = {
      Enter: 'KEYCODE_ENTER',
      Backspace: 'KEYCODE_DEL',
      Tab: 'KEYCODE_TAB',
      Escape: 'KEYCODE_ESCAPE',
      ArrowUp: 'KEYCODE_DPAD_UP',
      ArrowDown: 'KEYCODE_DPAD_DOWN',
      ArrowLeft: 'KEYCODE_DPAD_LEFT',
      ArrowRight: 'KEYCODE_DPAD_RIGHT'
    }
    const code = map[key]
    if (code) await this.key(code)
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
    this.streaming = false
    if (this.startedEmulator && this.serial) {
      await this.adbRun(['-s', this.serial, 'emu', 'kill']).catch(() => undefined)
    } else if (this.serial) {
      // We're leaving a pre-existing device/emulator running — restore its native
      // resolution so our preview override doesn't stick.
      await this.resetScreenSize().catch(() => undefined)
    }
    try {
      this.emulatorProc?.kill()
    } catch {
      /* already gone */
    }
    this.emulatorProc = null
    this.serial = ''
  }
}
