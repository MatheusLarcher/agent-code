import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { WindowsControlClient, type RequestOptions } from './client'

export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface WindowEntry {
  id: string
  title: string
  processId: number
  processName: string
  executablePath?: string | null
  isMinimized: boolean
  bounds: WindowBounds
  capturable?: boolean
}
export interface AppEntry {
  id: string
  displayName: string
  executablePath?: string | null
  windows: WindowEntry[]
}
export interface AccessibilitySnapshot {
  tree: string
  focusedElement?: string | null
  documentText?: string | null
  elementCount: number
}
export interface WindowStateResult {
  window: WindowEntry
  accessibility?: AccessibilitySnapshot
  screenshot?: { id: string; data: string; mimeType: 'image/png'; width: number; height: number }
}

export interface FormFieldsResult {
  /** Uma linha por controle útil, seções `# janela …` e última linha `ativo: …`. */
  text: string
  count: number
  targetWindowId: string
}

export type RunStepAction = 'fill' | 'click' | 'toggle' | 'select' | 'expand' | 'focus' | 'press' | 'wait_for'
export interface RunStepTarget {
  index?: number
  name?: string
  automationId?: string
  type?: string
  gone?: string
}
export interface RunStep {
  action: RunStepAction
  target?: RunStepTarget
  value?: string
  timeoutMs?: number
}
export interface RunStepsResult {
  ok: boolean
  done: number
  total: number
  failedStep?: { i: number; action: string; target?: unknown; error: string; candidates?: unknown }
  expectFound?: boolean
  targetWindowId: string
  /** Estado compacto da janela ao final (mesmo formato de FormFieldsResult.text). */
  state: string
}

/** Maior que os 120 s que o nativo concede a uma chamada de run_steps. */
export const RUN_STEPS_TIMEOUT_MS = 135_000

interface ScreenshotRef {
  windowId: string
  imageWidth: number
  imageHeight: number
  windowWidth: number
  windowHeight: number
}

export interface WindowsControlBridge {
  request<T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal, options?: RequestOptions): Promise<T>
  stop(reason?: string): void
}

export interface WindowCaptureSource {
  id: string
  data?: string
  width?: number
  height?: number
  empty?: boolean
}

export interface WindowsControlDependencies {
  client?: WindowsControlBridge
  sources?: (withThumbnails: boolean) => Promise<WindowCaptureSource[]>
  enabled?: () => boolean
  platform?: NodeJS.Platform
}

export class WindowsControlService {
  private readonly client: WindowsControlBridge
  private readonly sources: (withThumbnails: boolean) => Promise<WindowCaptureSource[]>
  private readonly enabled: () => boolean
  private readonly platform: NodeJS.Platform
  private screenshots = new Map<string, ScreenshotRef>()

  constructor(deps: WindowsControlDependencies = {}) {
    this.client = deps.client ?? new WindowsControlClient(resolveHelperPath)
    this.sources = deps.sources ?? electronSources
    this.enabled = deps.enabled ?? (() => loadConfig().windowsControlEnabled === true)
    this.platform = deps.platform ?? process.platform
  }

  createScope(): WindowsControlScope {
    return new WindowsControlScope(this)
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.stop()
  }

  stop(): void {
    this.screenshots.clear()
    this.client.stop()
  }

  async listWindows(signal?: AbortSignal): Promise<WindowEntry[]> {
    this.assertEnabled()
    const [windows, sources] = await Promise.all([
      this.client.request<WindowEntry[]>('list_windows', {}, signal),
      this.sources(false)
    ])
    const sourceIds = new Set(sources.map((source) => sourceWindowId(source.id)).filter((id): id is string => !!id))
    return windows.map((window) => ({ ...window, capturable: sourceIds.has(window.id) }))
  }

  async listApps(signal?: AbortSignal): Promise<AppEntry[]> {
    this.assertEnabled()
    return this.client.request<AppEntry[]>('list_apps', {}, signal)
  }

  async launchApp(appId: string, args: string[], signal?: AbortSignal): Promise<unknown> {
    this.assertEnabled()
    return this.client.request('launch_app', { app: appId, arguments: args }, signal)
  }

  async activateWindow(windowId: string, signal?: AbortSignal): Promise<unknown> {
    this.assertEnabled()
    return this.client.request('activate_window', { windowId }, signal)
  }

  async getWindowState(
    windowId: string,
    options: { includeScreenshot: boolean; includeText: boolean; maxDepth?: number; maxElements?: number },
    signal?: AbortSignal
  ): Promise<WindowStateResult> {
    this.assertEnabled()
    this.forgetScreenshots(windowId)
    const windowsPromise = this.client.request<WindowEntry[]>('list_windows', {}, signal)
    const accessibilityPromise = options.includeText
      ? this.client.request<AccessibilitySnapshot>('get_accessibility', {
          windowId,
          maxDepth: options.maxDepth ?? 7,
          maxElements: options.maxElements ?? 350
        }, signal)
      : Promise.resolve(undefined)
    const screenshotPromise = options.includeScreenshot ? this.capture(windowId, signal) : Promise.resolve(undefined)
    const [windows, accessibility, screenshot] = await Promise.all([
      windowsPromise,
      accessibilityPromise,
      screenshotPromise
    ])
    const window = windows.find((candidate) => candidate.id === windowId)
    if (!window) throw new Error('A janela não existe mais; liste as janelas novamente.')
    if (screenshot) {
      this.rememberScreenshot(screenshot.id, {
        windowId,
        imageWidth: screenshot.width,
        imageHeight: screenshot.height,
        windowWidth: window.bounds.width,
        windowHeight: window.bounds.height
      })
    }
    return { window, accessibility, screenshot }
  }

  async clickElement(windowId: string, elementIndex: number, signal?: AbortSignal): Promise<unknown> {
    return this.nativeAction('click_element', { windowId, elementIndex }, signal)
  }

  async click(
    windowId: string,
    screenshotId: string,
    x: number,
    y: number,
    button: string,
    clickCount: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const point = this.scalePoint(windowId, screenshotId, x, y)
    return this.nativeAction('click', { windowId, ...point, button, clickCount }, signal)
  }

  async typeText(windowId: string, text: string, signal?: AbortSignal): Promise<unknown> {
    return this.nativeAction('type_text', { windowId, text }, signal)
  }

  async pressKey(windowId: string, key: string, signal?: AbortSignal): Promise<unknown> {
    return this.nativeAction('press_key', { windowId, key }, signal)
  }

  async scroll(
    windowId: string,
    screenshotId: string,
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const point = this.scalePoint(windowId, screenshotId, x, y)
    return this.nativeAction('scroll', { windowId, ...point, scrollX, scrollY }, signal)
  }

  async drag(
    windowId: string,
    screenshotId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const from = this.scalePoint(windowId, screenshotId, fromX, fromY)
    const to = this.scalePoint(windowId, screenshotId, toX, toY)
    return this.nativeAction('drag', { windowId, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y }, signal)
  }

  async setValue(windowId: string, elementIndex: number, value: string, signal?: AbortSignal): Promise<unknown> {
    return this.nativeAction('set_value', { windowId, elementIndex, value }, signal)
  }

  async fill(
    windowId: string,
    text: string,
    options: { elementIndex?: number; mode?: 'replace' | 'append' } = {},
    signal?: AbortSignal
  ): Promise<unknown> {
    const params: Record<string, unknown> = { windowId, text, mode: options.mode ?? 'replace' }
    if (options.elementIndex !== undefined) params.elementIndex = options.elementIndex
    return this.nativeAction('fill', params, signal)
  }

  async secondaryAction(windowId: string, elementIndex: number, action: string, signal?: AbortSignal): Promise<unknown> {
    return this.nativeAction('secondary_action', { windowId, elementIndex, action }, signal)
  }

  async formFields(windowId: string, maxElements?: number, signal?: AbortSignal): Promise<FormFieldsResult> {
    const params: Record<string, unknown> = { windowId }
    if (maxElements !== undefined) params.maxElements = maxElements
    return this.nativeAction<FormFieldsResult>('form_fields', params, signal)
  }

  async runSteps(windowId: string, steps: RunStep[], expect?: string, signal?: AbortSignal): Promise<RunStepsResult> {
    const params: Record<string, unknown> = { windowId, steps }
    if (expect !== undefined) params.expect = expect
    return this.nativeAction<RunStepsResult>('run_steps', params, signal, { timeoutMs: RUN_STEPS_TIMEOUT_MS })
  }

  private async nativeAction<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    options?: RequestOptions
  ): Promise<T> {
    this.assertEnabled()
    const windowId = typeof params.windowId === 'string' ? params.windowId : null
    try {
      return await this.client.request<T>(method, params, signal, options)
    } finally {
      if (windowId) this.forgetScreenshots(windowId)
    }
  }

  private async capture(windowId: string, signal?: AbortSignal): Promise<WindowStateResult['screenshot']> {
    if (signal?.aborted) throw abortError()
    const sources = await this.sources(true)
    if (signal?.aborted) throw abortError()
    const source = sources.find((candidate) => sourceWindowId(candidate.id) === windowId)
    if (!source) throw new Error('Essa janela não pôde ser capturada; liste as janelas novamente.')
    if (source.empty || !source.data || !source.width || !source.height)
      throw new Error('O Windows retornou uma captura vazia para essa janela.')
    return {
      id: randomUUID(),
      data: source.data,
      mimeType: 'image/png',
      width: source.width,
      height: source.height
    }
  }

  private scalePoint(windowId: string, screenshotId: string, x: number, y: number): { x: number; y: number } {
    this.assertEnabled()
    const ref = this.screenshots.get(screenshotId)
    if (!ref || ref.windowId !== windowId)
      throw new Error('screenshotId expirou ou pertence a outra janela; capture o estado novamente.')
    if (x < 0 || y < 0 || x >= ref.imageWidth || y >= ref.imageHeight)
      throw new Error('As coordenadas estão fora da captura informada.')
    return {
      x: x * ref.windowWidth / ref.imageWidth,
      y: y * ref.windowHeight / ref.imageHeight
    }
  }

  private rememberScreenshot(id: string, ref: ScreenshotRef): void {
    this.forgetScreenshots(ref.windowId)
    this.screenshots.set(id, ref)
    while (this.screenshots.size > 25) {
      const oldest = this.screenshots.keys().next().value
      if (oldest) this.screenshots.delete(oldest)
      else break
    }
  }

  private forgetScreenshots(windowId: string): void {
    for (const [id, ref] of this.screenshots) {
      if (ref.windowId === windowId) this.screenshots.delete(id)
    }
  }

  private assertEnabled(): void {
    if (this.platform !== 'win32') throw new Error('O controle de aplicativos está disponível apenas no Windows.')
    if (!this.enabled())
      throw new Error('Controle do Windows desativado. Ative “Permitir controle do Windows” nas Configurações.')
  }
}

export class WindowsControlScope {
  private active = new Set<AbortController>()
  constructor(private readonly service: WindowsControlService) {}
  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    this.active.add(controller)
    try { return await operation(controller.signal) }
    finally { this.active.delete(controller) }
  }
  cancel(): void {
    for (const controller of this.active) controller.abort()
    this.active.clear()
  }
}

export const windowsControl = new WindowsControlService()

export function sourceWindowId(sourceId: string): string | null {
  const match = /^window:(\d+):\d+$/.exec(sourceId)
  return match?.[1] ?? null
}

async function electronSources(withThumbnails: boolean): Promise<WindowCaptureSource[]> {
  const { desktopCapturer } = await import('electron')
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: withThumbnails ? { width: 1600, height: 1200 } : { width: 0, height: 0 }
  })
  return sources.map((source) => {
    if (!withThumbnails) return { id: source.id }
    const size = source.thumbnail.getSize()
    return {
      id: source.id,
      empty: source.thumbnail.isEmpty(),
      data: source.thumbnail.isEmpty() ? undefined : source.thumbnail.toPNG().toString('base64'),
      width: size.width,
      height: size.height
    }
  })
}

function resolveHelperPath(): string {
  const name = 'AgentCode.WindowsControl.exe'
  const candidates = [
    join(process.resourcesPath || process.cwd(), 'windows-control', name),
    join(process.cwd(), 'out', 'windows-control', name),
    join(process.cwd(), 'src', 'main', 'windowsControl', 'native', 'bin', 'Release', 'net8.0-windows', name)
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('Helper do controle do Windows não foi compilado. Execute npm run windows-control:build.')
  return found
}

function abortError(): Error {
  const error = new Error('A ação do Windows foi interrompida.')
  error.name = 'AbortError'
  return error
}
