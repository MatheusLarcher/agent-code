import { describe, it, expect, afterAll } from 'vitest'
import type { BrowserState } from '../shared/ipc'
import { BrowserController } from './browserController'

// Offline, deterministic pages (no network) so the test is fast and reliable.
const pageUrl = (t: string): string =>
  'data:text/html,' + encodeURIComponent(`<title>${t}</title><h1>${t}</h1>`)

describe('BrowserController — múltiplas abas (o que o LLM controla)', () => {
  const ctrl = new BrowserController({ onFrame: () => {}, onState: () => {}, onPicked: () => {} })
  afterAll(async () => {
    await ctrl.close()
  })

  it('abre várias abas, lista e enxerga/controla a aba ativa correta', async () => {
    // Primeira aba (criada sob demanda) navega para Alpha e fica ativa.
    await ctrl.navigate(pageUrl('Alpha'))
    let tabs = ctrl.tabsInfo()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].active).toBe(true)
    expect(tabs[0].title).toBe('Alpha')

    // Abre uma SEGUNDA aba já navegando para Beta — vira a ativa.
    await ctrl.newTab('web', pageUrl('Beta'))
    tabs = ctrl.tabsInfo()
    expect(tabs).toHaveLength(2)
    expect(tabs.find((t) => t.active)?.title).toBe('Beta')

    // O snapshot (o que o LLM "enxerga") reflete a aba ATIVA (Beta), não a Alpha.
    const snapBeta = await ctrl.snapshot()
    expect(snapBeta).toContain('Beta')
    expect(snapBeta).not.toContain('Alpha')
    expect(snapBeta).toContain('web - Beta')

    // Troca de volta para a aba Alpha pelo id e confirma que o controle a seguiu.
    const alpha = tabs.find((t) => t.title === 'Alpha')!
    await ctrl.selectTab(alpha.id)
    expect(ctrl.tabsInfo().find((t) => t.active)?.title).toBe('Alpha')
    const snapAlpha = await ctrl.snapshot()
    expect(snapAlpha).toContain('Alpha')
    expect(snapAlpha).not.toContain('Beta')

    // A listagem mostra as duas abas e marca a ativa.
    const list = ctrl.listTabsText()
    expect(list).toContain('web - Alpha')
    expect(list).toContain('web - Beta')
    expect(list).toMatch(/▶.*Alpha/)

    // iPhone segue reservado: recusado e sem criar aba. (Android agora é suportado,
    // mas seu boot real de device/emulador não é exercitado neste teste de abas web.)
    const iphone = await ctrl.newTab('iphone')
    expect(iphone.toLowerCase()).toContain('implement')
    expect(ctrl.tabsInfo()).toHaveLength(2)

    // Fechar a aba ativa (Alpha) faz a outra assumir o controle.
    await ctrl.closeTab(alpha.id)
    const after = ctrl.tabsInfo()
    expect(after).toHaveLength(1)
    expect(after[0].title).toBe('Beta')
    expect(after[0].active).toBe(true)
  }, 120000)
})

describe('BrowserController — regressões das ferramentas web', () => {
  it('troca uma aba de arquivo por uma aba web segura ao receber snapshot', async () => {
    const states: BrowserState[] = []
    const ctrl = new BrowserController({ onFrame: () => {}, onState: (state) => states.push(state), onPicked: () => {} }, 'file-regression')
    try {
      await ctrl.newTab('file', 'C:/tmp/exemplo.pdf')
      const snapshot = await ctrl.snapshot()
      expect(snapshot).toContain('web -')
      expect(ctrl.tabsInfo().find((tab) => tab.active)?.kind).toBe('web')
      expect(states.at(-1)?.launched).toBe(true)
    } finally {
      await ctrl.close()
    }
  }, 120000)

  it('publica launched na primeira ferramenta e reflete o histórico real', async () => {
    const states: BrowserState[] = []
    const ctrl = new BrowserController({ onFrame: () => {}, onState: (state) => states.push(state), onPicked: () => {} }, 'history-regression')
    try {
      await ctrl.snapshot()
      expect(states.some((state) => state.launched)).toBe(true)
      expect(states.at(-1)?.canGoBack).toBe(false)
      expect(states.at(-1)?.canGoForward).toBe(false)
      await ctrl.navigate(pageUrl('Primeira'))
      await ctrl.navigate(pageUrl('Segunda'))
      expect(states.at(-1)?.canGoBack).toBe(true)
      expect(states.at(-1)?.canGoForward).toBe(false)
      await ctrl.back()
      expect(states.at(-1)?.canGoForward).toBe(true)
    } finally {
      await ctrl.close()
    }
  }, 120000)
})
