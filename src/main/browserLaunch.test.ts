// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from 'playwright'
import { NO_BROWSER_MESSAGE, failureReason, progressLines, summarizeProgress } from './browserInstall'
import { chooseBrowser, isChromeMissing, type LaunchDeps } from './browserLaunch'

const CHROME = { id: 'chrome' } as unknown as BrowserContext
const CHROMIUM = { id: 'chromium' } as unknown as BrowserContext
const missing = (): Error => new Error("browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at C:\\x\\chrome.exe")

function deps(over: Partial<LaunchDeps> = {}): LaunchDeps & { installed: { value: boolean } } {
  const installed = { value: false }
  return {
    installed,
    launchChrome: vi.fn(async () => CHROME),
    launchChromium: vi.fn(async () => CHROMIUM),
    chromiumInstalled: vi.fn(async () => installed.value),
    installChromium: vi.fn(async (onLine: (l: string) => void) => {
      onLine('Downloading Chromium 150.0 from https://cdn.playwright.dev/x.zip')
      onLine('|■■■■        |  40% of 150 MiB')
      onLine('|■■■■■■■■■■■■| 100% of 150 MiB')
      onLine('Chromium 150.0 downloaded to C:\\local\\ms-playwright\\chromium-1')
      installed.value = true
    }),
    ...over
  }
}

describe('escolha do navegador do agente', () => {
  it('1) com Google Chrome instalado: usa o Chrome e não baixa nada', async () => {
    const d = deps()
    const r = await chooseBrowser(d)
    expect(r).toEqual({ context: CHROME, source: 'chrome' })
    expect(d.chromiumInstalled).not.toHaveBeenCalled()
    expect(d.installChromium).not.toHaveBeenCalled()
  })

  it('2) sem Chrome, com o Chromium já baixado: usa o Chromium sem baixar', async () => {
    const d = deps({ launchChrome: vi.fn(async () => Promise.reject(missing())) })
    d.installed.value = true
    const r = await chooseBrowser(d)
    expect(r).toEqual({ context: CHROMIUM, source: 'chromium' })
    expect(d.installChromium).not.toHaveBeenCalled()
  })

  it('3) sem Chrome e sem Chromium: baixa uma vez, conta o progresso e segue', async () => {
    const d = deps({ launchChrome: vi.fn(async () => Promise.reject(missing())) })
    const lines: string[] = []
    const r = await chooseBrowser(d, (l) => lines.push(l))
    expect(r).toEqual({ context: CHROMIUM, source: 'chromium-baixado' })
    expect(d.installChromium).toHaveBeenCalledTimes(1)
    expect(lines[0]).toContain('Google Chrome não encontrado')
    expect(lines.join('\n')).toContain('100% of 150 MiB')
    expect(lines.join('\n')).not.toContain('40% of 150 MiB') // a barra vira uma linha só
    expect(lines.at(-1)).toContain('downloaded to')
  })

  it('4) sem Chrome e sem internet: pede o Chrome ou a internet', async () => {
    const d = deps({
      launchChrome: vi.fn(async () => Promise.reject(missing())),
      installChromium: vi.fn(async () => Promise.reject(new Error('getaddrinfo ENOTFOUND cdn.playwright.dev')))
    })
    await expect(chooseBrowser(d)).rejects.toThrow(NO_BROWSER_MESSAGE)
    expect(d.launchChromium).not.toHaveBeenCalled()
  })

  it('download que "termina" sem deixar o Chromium no disco também vira o erro claro', async () => {
    const d = deps({
      launchChrome: vi.fn(async () => Promise.reject(missing())),
      installChromium: vi.fn(async () => undefined)
    })
    await expect(chooseBrowser(d)).rejects.toThrow(NO_BROWSER_MESSAGE)
  })

  it('Chrome instalado que falha ao abrir NÃO dispara download: devolve o erro dele', async () => {
    const locked = new Error('Failed to create a ProcessSingleton for your profile directory')
    const d = deps({ launchChrome: vi.fn(async () => Promise.reject(locked)) })
    await expect(chooseBrowser(d)).rejects.toBe(locked)
    expect(d.installChromium).not.toHaveBeenCalled()
  })

  it('Chrome que falha, mas com Chromium já no disco: abre no Chromium', async () => {
    const d = deps({ launchChrome: vi.fn(async () => Promise.reject(new Error('crash'))) })
    d.installed.value = true
    expect((await chooseBrowser(d)).source).toBe('chromium')
  })

  it('variável de teste "sem Chrome" nem tenta o canal chrome', async () => {
    const d = deps({ skipChrome: true })
    const r = await chooseBrowser(d)
    expect(r.source).toBe('chromium-baixado')
    expect(d.launchChrome).not.toHaveBeenCalled()
  })
})

describe('mensagens do Playwright', () => {
  it('reconhece "Chrome não instalado"', () => {
    expect(isChromeMissing(missing())).toBe(true)
    expect(isChromeMissing(new Error('Target page, context or browser has been closed'))).toBe(false)
  })

  it('quebra a barra de progresso (\\r) em linhas e resume', () => {
    const lines = progressLines('Downloading X\r\n|■ | 10% of 9 MiB\r|■■| 90% of 9 MiB\r\u001b[1A|■■■| 100% of 9 MiB\nX downloaded to C:\\p\n')
    expect(lines).toEqual(['Downloading X', '|■ | 10% of 9 MiB', '|■■| 90% of 9 MiB', '|■■■| 100% of 9 MiB', 'X downloaded to C:\\p'])
    expect(summarizeProgress(lines)).toEqual(['Downloading X', '|■■■| 100% of 9 MiB', 'X downloaded to C:\\p'])
  })

  it('motivo da falha do download sai sem a pilha do CLI', () => {
    expect(
      failureReason([
        'Error: Download failed: server returned code ECONNREFUSED. URL: http://127.0.0.1:9/x.zip',
        'at ChildProcess.<anonymous> (C:\\app\\coreBundle.js:27788:32)',
        'at ChildProcess.emit (node:events:509:28)'
      ])
    ).toBe('Error: Download failed: server returned code ECONNREFUSED. URL: http://127.0.0.1:9/x.zip')
  })
})
