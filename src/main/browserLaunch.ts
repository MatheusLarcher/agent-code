import type { BrowserContext } from 'playwright'
import { TEST_VIEWPORT } from './browserTabs'
import { NO_BROWSER_MESSAGE, chromiumInstalled, installChromium, summarizeProgress } from './browserInstall'
import { windowPlacementArgs } from './browserWindowPlacement'

/** De onde veio o navegador desta abertura. */
export type BrowserSource = 'chrome' | 'chromium' | 'chromium-baixado'

export interface LaunchDeps {
  launchChrome: () => Promise<BrowserContext>
  launchChromium: () => Promise<BrowserContext>
  chromiumInstalled: () => Promise<boolean>
  installChromium: (onLine: (line: string) => void) => Promise<void>
  /** Só para teste: finge um PC sem Google Chrome. */
  skipChrome?: boolean
}

/** O Playwright não achou o Chrome instalado (≠ o Chrome existir e falhar ao abrir). */
export function isChromeMissing(error: unknown): boolean {
  return /is not found at|distribution 'chrome' is not found|executable doesn't exist/i.test(
    error instanceof Error ? error.message : String(error)
  )
}

/**
 * A escolha do navegador, nesta ordem: 1) Google Chrome instalado; 2) sem Chrome,
 * o Chromium do Playwright já baixado; 3) baixa o Chromium (só na primeira vez) e
 * segue; 4) sem Chrome e sem download, erro pedindo um dos dois. `onLine` recebe
 * o que aconteceu, para a ferramenta que disparou contar ao modelo.
 */
export async function chooseBrowser(
  deps: LaunchDeps,
  onLine: (line: string) => void = () => undefined
): Promise<{ context: BrowserContext; source: BrowserSource }> {
  let chromeError: unknown = null
  if (!deps.skipChrome) {
    try {
      return { context: await deps.launchChrome(), source: 'chrome' }
    } catch (error) {
      chromeError = error
    }
  }
  const missing = deps.skipChrome || isChromeMissing(chromeError)
  if (await deps.chromiumInstalled()) return { context: await deps.launchChromium(), source: 'chromium' }
  // O Chrome existe mas não abriu (perfil travado, janela fechada no meio…):
  // baixar 150 MB não conserta isso — devolve o erro de verdade.
  if (!missing) throw chromeError
  onLine('Google Chrome não encontrado: baixando o Chromium (só nesta primeira vez)…')
  const lines: string[] = []
  try {
    await deps.installChromium((line) => lines.push(line))
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`${NO_BROWSER_MESSAGE}. (${why})`)
  }
  for (const line of summarizeProgress(lines)) onLine(line)
  if (!(await deps.chromiumInstalled())) throw new Error(`${NO_BROWSER_MESSAGE}.`)
  return { context: await deps.launchChromium(), source: 'chromium-baixado' }
}

/**
 * Abre o navegador do agente: uma janela NORMAL e visível, com perfil próprio por
 * conversa (logins sobrevivem). Chrome de verdade + sem as flags de automação =
 * parece um navegador comum para os sites. Nos testes (VITEST) roda headless com
 * o Chromium do Playwright, por velocidade e determinismo.
 */
export async function launchAgentBrowser(userDataDir: string, onLine?: (line: string) => void): Promise<BrowserContext> {
  const { chromium } = await import('playwright')
  const isTest = !!process.env.VITEST
  const opts = {
    headless: isTest,
    // No app a página acompanha o tamanho da janela (viewport null).
    viewport: isTest ? TEST_VIEWPORT : null,
    locale: 'pt-BR',
    // Tira a faixa "controlado por software de teste", que também expõe navigator.webdriver.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      ...(isTest ? [] : windowPlacementArgs(userDataDir))
    ]
  }
  if (isTest) return chromium.launchPersistentContext(userDataDir, opts)
  const { context } = await chooseBrowser(
    {
      launchChrome: () => chromium.launchPersistentContext(userDataDir, { ...opts, channel: 'chrome' }),
      launchChromium: () => chromium.launchPersistentContext(userDataDir, opts),
      chromiumInstalled,
      installChromium,
      skipChrome: process.env.AGENT_CODE_TEST_NO_CHROME === '1'
    },
    onLine
  )
  return context
}
