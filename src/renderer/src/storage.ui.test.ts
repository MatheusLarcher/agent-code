import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUi, saveUi } from './storage'

const UI_KEY = 'agentcode.ui.v1'

function api(saved: string | null) {
  const kvSet = vi.fn(async (_key: string, _value: string) => undefined)
  Object.defineProperty(window, 'api', { configurable: true, value: { kvGet: vi.fn(async () => saved), kvSet } })
  return kvSet
}

describe('estado salvo do painel da direita', () => {
  beforeEach(() => localStorage.clear())

  it('estado salvo antes da troca de nome: a largura e o "recolhido" do painel não se perdem', async () => {
    api(JSON.stringify({ collapsed: true, activeId: 'c1', browserMinimized: true, browserWidth: 512 }))
    const ui = await loadUi()
    expect(ui).toMatchObject({ collapsed: true, activeId: 'c1', rightPaneMinimized: true, rightPaneWidth: 512 })
    expect(ui).not.toHaveProperty('browserMinimized')
    expect(ui).not.toHaveProperty('browserWidth')
  })

  it('o nome novo vence o antigo; sem nada salvo, painel aberto na largura padrão', async () => {
    api(JSON.stringify({ browserWidth: 512, rightPaneWidth: 640, rightPaneMinimized: false, browserMinimized: true }))
    expect(await loadUi()).toMatchObject({ rightPaneWidth: 640, rightPaneMinimized: false })
    api(null)
    expect(await loadUi()).toMatchObject({ rightPaneWidth: 720, rightPaneMinimized: false })
  })

  it('salva só com os nomes novos', async () => {
    const kvSet = api(null)
    await saveUi({ collapsed: false, activeId: null, rightPaneMinimized: true, rightPaneWidth: 480, usageProviders: { claude: true, gpt: true } })
    expect(JSON.parse(kvSet.mock.calls[0][1] as string)).toEqual({
      collapsed: false,
      activeId: null,
      rightPaneMinimized: true,
      rightPaneWidth: 480,
      usageProviders: { claude: true, gpt: true }
    })
    expect(kvSet.mock.calls[0][0]).toBe(UI_KEY)
  })
})
