// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  RUN_STEPS_TIMEOUT_MS,
  WindowsControlService,
  sourceWindowId,
  type WindowEntry,
  type WindowsControlBridge
} from './service'

const windowEntry: WindowEntry = {
  id: '1234',
  title: 'Janela de teste',
  processId: 99,
  processName: 'teste',
  executablePath: 'C:\\teste.exe',
  isMinimized: false,
  bounds: { x: 10, y: 20, width: 800, height: 600 }
}

type RecordedRequest = { method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }

function fakeBridge(): WindowsControlBridge & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  return {
    requests,
    stop: vi.fn(),
    async request<T>(
      method: string,
      params: Record<string, unknown> = {},
      _signal?: AbortSignal,
      options?: { timeoutMs?: number }
    ): Promise<T> {
      requests.push(options ? { method, params, options } : { method, params })
      if (method === 'form_fields') return { text: '0 Edit "Nome" = ""', count: 1, targetWindowId: '1234' } as T
      if (method === 'run_steps') return { ok: true, done: 1, total: 1, targetWindowId: '1234', state: 'ativo: "x"' } as T
      if (method === 'list_windows') return [windowEntry] as T
      if (method === 'get_accessibility') {
        return { tree: '[0] Window', elementCount: 1, focusedElement: '[0] Window' } as T
      }
      return { ok: true } as T
    }
  }
}

function makeService(enabled = true): { service: WindowsControlService; bridge: ReturnType<typeof fakeBridge> } {
  const bridge = fakeBridge()
  const service = new WindowsControlService({
    client: bridge,
    enabled: () => enabled,
    platform: 'win32',
    sources: async (withThumbnails) => withThumbnails
      ? [{ id: 'window:1234:0', data: 'cG5n', width: 400, height: 300 }]
      : [{ id: 'window:1234:0' }]
  })
  return { service, bridge }
}

describe('WindowsControlService', () => {
  it('nega tudo quando o toggle independente está desligado', async () => {
    const { service, bridge } = makeService(false)
    await expect(service.listWindows()).rejects.toThrow('Controle do Windows desativado')
    expect(bridge.requests).toHaveLength(0)
  })

  it('marca somente HWNDs que o Electron consegue capturar', async () => {
    const { service } = makeService()
    await expect(service.listWindows()).resolves.toEqual([{ ...windowEntry, capturable: true }])
  })

  it('captura estado, devolve acessibilidade e escala coordenadas pelo screenshotId', async () => {
    const { service, bridge } = makeService()
    const state = await service.getWindowState('1234', { includeScreenshot: true, includeText: true })
    expect(state.accessibility?.tree).toBe('[0] Window')
    expect(state.screenshot).toMatchObject({ width: 400, height: 300, data: 'cG5n' })

    await service.click('1234', state.screenshot!.id, 200, 150, 'left', 1)
    expect(bridge.requests.at(-1)).toEqual({
      method: 'click',
      params: { windowId: '1234', x: 400, y: 300, button: 'left', clickCount: 1 }
    })
    await expect(service.click('1234', state.screenshot!.id, 200, 150, 'left', 1)).rejects.toThrow('screenshotId expirou')
  })

  it('recusa coordenadas antigas ou ligadas a outra janela', async () => {
    const { service } = makeService()
    await expect(service.click('1234', crypto.randomUUID(), 1, 1, 'left', 1)).rejects.toThrow('screenshotId expirou')
  })

  it('desativar encerra o helper e limpa o estado de captura', async () => {
    const { service, bridge } = makeService()
    const state = await service.getWindowState('1234', { includeScreenshot: true, includeText: false })
    service.setEnabled(false)
    expect(bridge.stop).toHaveBeenCalledTimes(1)
    await expect(service.click('1234', state.screenshot!.id, 1, 1, 'left', 1)).rejects.toThrow('screenshotId expirou')
  })

  it('fill envia text/mode e só inclui elementIndex quando informado', async () => {
    const { service, bridge } = makeService()
    await service.fill('1234', 'teste de velocidade')
    expect(bridge.requests.at(-1)).toEqual({
      method: 'fill',
      params: { windowId: '1234', text: 'teste de velocidade', mode: 'replace' }
    })
    await service.fill('1234', ' fim', { elementIndex: 4, mode: 'append' })
    expect(bridge.requests.at(-1)).toEqual({
      method: 'fill',
      params: { windowId: '1234', text: ' fim', mode: 'append', elementIndex: 4 }
    })
  })

  it('form_fields envia windowId e só inclui maxElements quando informado, com o timeout padrão', async () => {
    const { service, bridge } = makeService()
    await expect(service.formFields('1234')).resolves.toMatchObject({ count: 1, targetWindowId: '1234' })
    expect(bridge.requests.at(-1)).toEqual({ method: 'form_fields', params: { windowId: '1234' } })
    await service.formFields('1234', 80)
    expect(bridge.requests.at(-1)).toEqual({ method: 'form_fields', params: { windowId: '1234', maxElements: 80 } })
  })

  it('run_steps envia passos/expect com timeout de 135 s e invalida o screenshot da janela', async () => {
    const { service, bridge } = makeService()
    const state = await service.getWindowState('1234', { includeScreenshot: true, includeText: false })
    const steps = [{ action: 'click' as const, target: { name: 'Salvar' } }]
    await expect(service.runSteps('1234', steps, 'nota.txt')).resolves.toMatchObject({ ok: true, state: 'ativo: "x"' })
    expect(bridge.requests.at(-1)).toEqual({
      method: 'run_steps',
      params: { windowId: '1234', steps, expect: 'nota.txt' },
      options: { timeoutMs: RUN_STEPS_TIMEOUT_MS }
    })
    expect(RUN_STEPS_TIMEOUT_MS).toBe(135_000)
    await service.runSteps('1234', steps)
    expect(bridge.requests.at(-1)?.params).toEqual({ windowId: '1234', steps })
    await expect(service.click('1234', state.screenshot!.id, 1, 1, 'left', 1)).rejects.toThrow('screenshotId expirou')
  })

  it('form_fields e run_steps respeitam o toggle desligado', async () => {
    const { service, bridge } = makeService(false)
    await expect(service.formFields('1234')).rejects.toThrow('Controle do Windows desativado')
    await expect(service.runSteps('1234', [{ action: 'press', value: 'Tab' }])).rejects.toThrow('Controle do Windows desativado')
    expect(bridge.requests).toHaveLength(0)
  })

  it('cancelamento de escopo aborta uma operação em andamento', async () => {
    const { service } = makeService()
    const scope = service.createScope()
    const operation = (): Promise<void> => scope.run((signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('abortado')), { once: true })
    }))
    const pending = [operation(), operation()]
    scope.cancel()
    await Promise.all(pending.map((request) => expect(request).rejects.toThrow('abortado')))
  })
})

describe('sourceWindowId', () => {
  it('extrai somente o HWND documentado pelo Electron', () => {
    expect(sourceWindowId('window:1234:0')).toBe('1234')
    expect(sourceWindowId('window:88:1')).toBe('88')
    expect(sourceWindowId('screen:1:0')).toBeNull()
    expect(sourceWindowId('window:abc:0')).toBeNull()
  })
})
