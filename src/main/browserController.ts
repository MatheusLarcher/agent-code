import { app } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserContext, Page } from 'playwright'
import type { TabInfo } from '../shared/ipc'
import { tabName } from '../shared/ipc'
import { nextTabId, type Tab } from './browserTabs'
import { launchAgentBrowser } from './browserLaunch'
import {
  gotoUrl,
  pageSnapshot,
  pageScreenshot,
  clickSelector as pageClick,
  fillOrType,
  readText,
  evaluateExpression
} from './pageActions'
import { collectFields, formatFields } from './browserFields'
import { runSteps } from './browserSteps'
import type { BrowserStep, RunStepsResult } from './browserStepsMatch'

/**
 * O navegador do agente de UMA conversa: uma janela real e visível do Chrome no
 * PC do usuário, com perfil próprio. As **abas** são abas de verdade dessa
 * janela; há sempre uma aba ativa, que é a que as ferramentas browser_* usam.
 * Abas que o usuário abre ou fecha na janela entram e saem da lista sozinhas.
 */
export class BrowserController {
  private context: BrowserContext | null = null
  private launching: Promise<BrowserContext> | null = null
  private tabs = new Map<string, Tab>()
  private activeTabId: string | null = null
  /** O que aconteceu ao abrir a janela (ex.: download do Chromium), ainda não contado ao modelo. */
  private notes: string[] = []

  /** `profileKey` (o id da conversa) dá a cada navegador a sua pasta de perfil:
   *  logins e cookies sobrevivem e duas conversas não disputam a trava do perfil. */
  constructor(private readonly profileKey: string = 'default') {}

  // ---- abas ----

  private activeTab(): Tab | null {
    return this.activeTabId ? this.tabs.get(this.activeTabId) ?? null : null
  }

  /** As abas abertas, na ordem em que surgiram. */
  tabsInfo(): TabInfo[] {
    return [...this.tabs.values()].map((t) => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      url: t.url,
      active: t.id === this.activeTabId
    }))
  }

  /** Listagem legível das abas (browser_list_tabs). */
  listTabsText(): string {
    if (this.tabs.size === 0) return 'Nenhuma aba aberta.'
    const lines = [...this.tabs.values()].map(
      (t) => `${t.id === this.activeTabId ? '▶' : ' '} [${t.id}] ${tabName(t)} — ${t.url || 'about:blank'}`
    )
    const active = this.activeTab()
    return `Abas abertas (${this.tabs.size}):\n${lines.join('\n')}\n\nAba ativa: ${active ? `"${tabName(active)}" (${active.id})` : 'nenhuma'}.`
  }

  // ---- janela ----

  private userDataDir(): string {
    const safeKey = this.profileKey.replace(/[^a-z0-9_-]/gi, '_') || 'default'
    let root: string
    try {
      root = app.getPath('userData')
    } catch {
      root = join(tmpdir(), 'agent-code') // testes rodam fora do Electron
    }
    return join(root, 'browser-profiles', safeKey)
  }

  /** Uma abertura por vez: duas ferramentas simultâneas não disputam a trava do perfil. */
  private ensureContext(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context)
    this.launching ??= this.launch().finally(() => {
      this.launching = null
    })
    return this.launching
  }

  private async launch(): Promise<BrowserContext> {
    const context = await launchAgentBrowser(this.userDataDir(), (line) => this.notes.push(line))
    // Esconde o último sinal óbvio de automação que alguns sites farejam.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })
    // Aba que o usuário (ou um link) abre na janela também vira aba da lista.
    context.on('page', (page) => this.adopt(page))
    // O usuário fechou a janela: a próxima ferramenta abre outra.
    context.on('close', () => this.onContextClosed(context))
    this.context = context
    // A janela nasce com uma aba em branco: ela é a primeira aba, não uma sobra.
    for (const page of context.pages()) this.adopt(page)
    return context
  }

  private onContextClosed(context: BrowserContext): void {
    if (this.context !== context) return
    this.context = null
    this.tabs.clear()
    this.activeTabId = null
  }

  /** Registra a página como aba (uma vez só) e acompanha título, endereço e fechamento. */
  private adopt(page: Page): Tab {
    const known = [...this.tabs.values()].find((t) => t.page === page)
    if (known) return known
    const tab: Tab = { id: nextTabId(), kind: 'web', page, title: '', url: page.url() }
    this.tabs.set(tab.id, tab)
    this.activeTabId ??= tab.id
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) void this.updateTabMeta(tab)
    })
    page.on('load', () => void this.updateTabMeta(tab))
    page.on('close', () => this.dropTab(tab))
    return tab
  }

  /** Tira a aba da lista; se era a ativa, a mais recente que sobrou assume. */
  private dropTab(tab: Tab): void {
    if (!this.tabs.delete(tab.id)) return
    if (this.activeTabId !== tab.id) return
    const remaining = [...this.tabs.keys()]
    this.activeTabId = remaining.length ? remaining[remaining.length - 1] : null
  }

  private async updateTabMeta(tab: Tab): Promise<void> {
    if (tab.page.isClosed()) return
    tab.url = tab.page.url()
    try {
      tab.title = await tab.page.title()
    } catch {
      /* navegando */
    }
  }

  /** A página da aba ativa, abrindo a janela (ou uma aba) se não houver nenhuma. */
  private async activePage(): Promise<Page> {
    await this.ensureContext()
    const active = this.activeTab()
    if (active) return active.page
    const last = [...this.tabs.values()].pop()
    if (last) {
      this.activeTabId = last.id
      return last.page
    }
    return (await this.openWebTab()).page
  }

  private async openWebTab(): Promise<Tab> {
    const context = await this.ensureContext()
    const tab = this.adopt(await context.newPage())
    this.activeTabId = tab.id
    // O Chrome só poupa a aba da FRENTE das economias dele (Memory Saver,
    // congelamento): uma aba que tratamos como ativa mas está atrás pode ser
    // descartada entre duas ferramentas, sem navegação nem reload do nosso lado.
    await tab.page.bringToFront().catch(() => undefined)
    return tab
  }

  /** Linhas pendentes da abertura da janela; a ferramenta que as lê as entrega uma vez só. */
  takeNotes(): string {
    const text = this.notes.join('\n')
    this.notes = []
    return text
  }

  // ---- ferramentas de aba ----

  /** Abre uma aba nova na janela e a torna ativa. */
  async newTab(kind: string = 'web', url?: string): Promise<string> {
    if (kind !== 'web') {
      return `Só existem abas web no navegador do agente (pedido: "${kind}"). Para Android, use android_open_preview: o emulador abre numa janela do PC.`
    }
    const tab = await this.openWebTab()
    if (url) await this.navigate(url)
    return `Nova aba aberta e ativada: "${tabName(tab)}" (id ${tab.id}). Reaproveite esta aba para as próximas ações; só abra outra se precisar de uma página separada.`
  }

  /** Torna uma aba a ativa (a que as ferramentas controlam) e a traz para a frente. */
  async selectTab(id: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab) return `Aba ${id} não encontrada.`
    this.activeTabId = id
    await tab.page.bringToFront().catch(() => undefined)
    return `Aba ativa agora: "${tabName(tab)}" (id ${id}).`
  }

  /** Fecha uma aba; se era a ativa, a mais recente que sobrou assume. */
  async closeTab(id: string): Promise<string> {
    const tab = this.tabs.get(id)
    if (!tab) return `Aba ${id} não encontrada.`
    const name = tabName(tab)
    this.dropTab(tab)
    await tab.page.close().catch(() => undefined)
    await this.activeTab()?.page.bringToFront().catch(() => undefined)
    return `Aba fechada: "${name}". ${this.tabs.size} aba(s) restante(s).`
  }

  // ---- ferramentas de página (agem na aba ativa) ----

  async navigate(url: string): Promise<string> {
    const page = await this.activePage()
    const tab = this.activeTab()!
    await gotoUrl(page, url)
    await this.updateTabMeta(tab)
    return `Navegou para ${page.url()} — "${tab.title}" (aba: "${tabName(tab)}").`
  }

  async back(): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    await tab.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await this.updateTabMeta(tab)
  }

  async reload(): Promise<void> {
    const tab = this.activeTab()
    if (!tab) return
    await tab.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
    await this.updateTabMeta(tab)
  }

  async snapshot(): Promise<string> {
    const page = await this.activePage()
    const tab = this.activeTab()!
    return pageSnapshot(page, tabName(tab), tab.id)
  }

  async screenshot(): Promise<string> {
    return pageScreenshot(await this.activePage())
  }

  async clickSelector(selector: string): Promise<string> {
    return pageClick(await this.activePage(), selector)
  }

  async typeText(selector: string | undefined, text: string): Promise<string> {
    return fillOrType(await this.activePage(), selector, text)
  }

  async getText(selector: string | undefined): Promise<string> {
    return readText(await this.activePage(), selector)
  }

  async evaluate(expression: string): Promise<string> {
    return evaluateExpression(await this.activePage(), expression)
  }

  async formFields(): Promise<string> {
    return formatFields(await collectFields(await this.activePage()))
  }

  async runSteps(steps: BrowserStep[], expect?: string): Promise<RunStepsResult> {
    return runSteps(await this.activePage(), steps, expect)
  }

  /** Fecha a janela (o perfil fica no disco, com os logins). */
  async close(): Promise<void> {
    const context = this.context ?? (await this.launching?.catch(() => null)) ?? null
    this.context = null
    this.tabs.clear()
    this.activeTabId = null
    // O contexto persistente é dono do processo do Chrome: fechá-lo derruba tudo.
    await context?.close().catch(() => undefined)
  }
}
