import { describe, it, expect, afterAll } from 'vitest'
import type { BrowserContext } from 'playwright'
import { BrowserController } from './browserController'

// Offline, deterministic pages (no network) so the test is fast and reliable.
const pageUrl = (t: string): string =>
  'data:text/html,' + encodeURIComponent(`<title>${t}</title><h1>${t}</h1>`)

describe('BrowserController — múltiplas abas (o que o LLM controla)', () => {
  const ctrl = new BrowserController('tabs-test')
  afterAll(async () => {
    await ctrl.close()
  })

  it('abre várias abas, lista e enxerga/controla a aba ativa correta', async () => {
    // A janela nasce com uma aba em branco: a primeira navegação a reaproveita.
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

    // Só existem abas web: Android/iPhone são recusados e não criam aba.
    for (const kind of ['android', 'iphone', 'file']) {
      expect(await ctrl.newTab(kind)).toContain('Só existem abas web')
    }
    expect(ctrl.tabsInfo()).toHaveLength(2)

    // Fechar a aba ativa (Alpha) faz a outra assumir o controle.
    await ctrl.closeTab(alpha.id)
    const after = ctrl.tabsInfo()
    expect(after).toHaveLength(1)
    expect(after[0].title).toBe('Beta')
    expect(after[0].active).toBe(true)
  }, 120000)
})

describe('BrowserController — a janela é do usuário também', () => {
  it('aba aberta e fechada por fora das ferramentas entra e sai da lista', async () => {
    const ctrl = new BrowserController('window-user-tabs')
    try {
      await ctrl.navigate(pageUrl('Minha'))
      // Página criada direto no contexto = o usuário abrindo uma aba (Ctrl+T) na janela.
      const { context } = ctrl as unknown as { context: BrowserContext }
      const userPage = await context.newPage()
      await userPage.goto(pageUrl('Popup'))
      await expect.poll(() => ctrl.tabsInfo().length, { timeout: 15000 }).toBe(2)
      // A aba nova entra na lista, mas a ativa continua sendo a do agente.
      expect(ctrl.tabsInfo().find((t) => t.active)?.title).toBe('Minha')
      await expect.poll(() => ctrl.tabsInfo().some((t) => t.title === 'Popup'), { timeout: 15000 }).toBe(true)

      const popup = ctrl.tabsInfo().find((t) => t.title === 'Popup')!
      await ctrl.selectTab(popup.id)
      await userPage.close() // o "usuário" fecha a aba ativa
      await expect.poll(() => ctrl.tabsInfo().length, { timeout: 15000 }).toBe(1)
      expect(ctrl.tabsInfo()[0]).toMatchObject({ title: 'Minha', active: true })
    } finally {
      await ctrl.close()
    }
  }, 120000)

  it('janela fechada pelo usuário reabre na próxima ferramenta, com histórico novo', async () => {
    const ctrl = new BrowserController('window-reopen')
    try {
      await ctrl.navigate(pageUrl('Primeira'))
      await ctrl.navigate(pageUrl('Segunda'))
      await ctrl.back()
      expect(ctrl.tabsInfo()[0].title).toBe('Primeira')

      // Fechar a janela inteira = fechar o contexto por fora do controller.
      await (ctrl as unknown as { context: BrowserContext }).context.close()
      await expect.poll(() => ctrl.tabsInfo().length, { timeout: 15000 }).toBe(0)

      expect(await ctrl.navigate(pageUrl('Depois'))).toContain('Depois')
      expect(ctrl.tabsInfo()).toHaveLength(1)
      expect(ctrl.tabsInfo()[0]).toMatchObject({ title: 'Depois', active: true })
    } finally {
      await ctrl.close()
    }
  }, 120000)
})
