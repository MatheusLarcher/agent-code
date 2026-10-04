import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InstancedMesh, Matrix4, Mesh, Texture, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import type { OfficeFeed } from '../office/adapter/feed'
import { UiProvider } from '../ui/UiProvider'
import { DEMO_APP, DEMO_PAGE_TITLE, DEMO_URL } from './demoDevices'
import { DEMO_PER_ROOM, DEMO_ROOMS, demoFeed } from './demoFeed'
import { DEMO_LOOP_MS } from './demoTimeline'
import type { FeedSource, RendererLike } from './engine'
import { snapshotOf } from './events'
import { layoutOffice } from './layout'
import type { ScreenPage } from './monitorTexture'
import { Office3DWorkspace } from './Office3DWorkspace'
import { PROJECTOR_IDLE_MS, scanDeviceUse } from './projectorUse'
import { OfficeScene, screenPageFor } from './scene'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const staticSource = (feed = demoFeed()): FeedSource => ({ getSnapshot: () => feed, subscribe: () => () => {} })

beforeEach(() => {
  // A tela do monitor lembra o último app no localStorage: cada teste começa do zero.
  localStorage.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  cleanup()
  officeStore.setOverride(null)
  vi.restoreAllMocks()
})

function find(root: Object3D, pred: (o: Object3D) => boolean): Object3D[] {
  const out: Object3D[] = []
  root.traverse((o) => {
    if (pred(o)) out.push(o)
  })
  return out
}

describe('feed de demonstração', () => {
  it('5 salas, 20 agentes, ícones nos três formatos e a janela de 5h', () => {
    const feed = demoFeed(1_000)
    const model = deriveOfficeModel(feed, 1_000)
    expect(model.rooms).toHaveLength(DEMO_ROOMS)
    expect(model.characters).toHaveLength(DEMO_ROOMS * DEMO_PER_ROOM)
    const icons = model.rooms.map((r) => r.icon)
    expect(icons.some((i) => i?.startsWith('data:image/'))).toBe(true)
    expect(icons).toContain(null)
    expect(icons).toContain('🚀')
    expect(feed.usageLimits?.five_hour?.utilization).toBeGreaterThan(0)
    // Contexto variado: há baterias nos três níveis.
    const fr = model.characters.map((c) => 1 - c.context!.tokens / c.context!.max)
    expect(fr.some((f) => f > 0.5) && fr.some((f) => f <= 0.5 && f > 0.2) && fr.some((f) => f <= 0.2)).toBe(true)
  })

  it('a tela do agente ativo mostra o chat encolhido do turno, com os rótulos do cartão do chat', () => {
    const feed = demoFeed()
    const chars = deriveOfficeModel(feed, Date.now()).characters
    const page = (id: string): ScreenPage => screenPageFor(feed, chars.find((c) => c.convId === id)!)
    const lastTool = (id: string): ScreenPage['lines'][number] | undefined => page(id).lines.filter((l) => l.kind === 'tool').at(-1)
    const dev = page('demo-0-0')
    expect(dev.title).toBe('Demo 1.1')
    expect(dev.lines[0]).toEqual({ kind: 'user', text: 'Adiciona desconto percentual no total do carrinho, sem deixar o valor ficar negativo.' })
    expect(lastTool('demo-0-0')).toMatchObject({ verb: 'Edit', detail: 'total.ts', added: 5, removed: 5, badge: { kind: 'run', text: 'running…' } })
    expect(lastTool('demo-0-2')).toMatchObject({ verb: 'Bash', detail: 'npm test -- --run', badge: { kind: 'ok', text: 'done' } })
    expect(lastTool('demo-0-1')).toMatchObject({ verb: 'Write', detail: 'Cart.tsx', badge: { kind: 'run' } })
  })
})

describe('demonstração: navegador e Android no projetor', () => {
  it('o dev da loja testa no navegador e o do portal no Android; o projetor da sala desce e sobe 90 s depois do último uso', () => {
    const T0 = 14_916_667 * DEMO_LOOP_MS
    const at = (ms: number): { feed: OfficeFeed; model: ReturnType<typeof deriveOfficeModel> } => {
      const feed = demoFeed(T0 + ms)
      return { feed, model: deriveOfficeModel(feed, T0 + ms) }
    }
    // Aos 14 s: o navigate já voltou (o título vem dele) e o print está saindo.
    const a = at(14_000)
    const uses = scanDeviceUse(a.feed, a.model.characters)
    expect(uses.find((u) => u.kind === 'web')).toMatchObject({ convId: 'demo-1-0', url: DEMO_URL, title: DEMO_PAGE_TITLE, open: true })
    expect(uses.find((u) => u.kind === 'android')).toMatchObject({ convId: 'demo-3-0', title: DEMO_APP })
    const scene = new OfficeScene()
    scene.projectors.demo = true
    const layout = layoutOffice(a.model)
    const sync = (x: ReturnType<typeof at>, ms: number): void =>
      scene.sync(layoutOffice(x.model, layout), x.feed, { snapshot: snapshotOf(x.feed, x.model, T0 + ms), events: [], wallNow: T0 + ms, t: ms / 1000 })
    sync(a, 14_000)
    const shop = layout.rooms.find((r) => r.name === 'loja-virtual')!.id
    const portal = layout.rooms.find((r) => r.name === 'portal-aluno')!.id
    expect([scene.projectors.isDown(shop), scene.projectors.isDown(portal)]).toEqual([true, true])
    expect(layout.rooms.filter((r) => scene.projectors.isDown(r.id))).toHaveLength(2)
    // O último print sai aos ~20 s; o turno seguinte já não usa o navegador.
    sync(at(21_000), 21_000)
    expect(scene.projectors.tick(T0 + 21_000 + PROJECTOR_IDLE_MS - 1_000)).toBe(false)
    expect(scene.projectors.isDown(shop)).toBe(true)
    scene.projectors.tick(T0 + 21_000 + PROJECTOR_IDLE_MS + 1_000)
    expect(scene.projectors.isDown(shop)).toBe(false)
    scene.dispose()
  })
})

describe('OfficeScene com o feed de demonstração', () => {
  it('telas acesas = agentes ativos; ociosos com protetor; foco esconde personagem e cadeira', () => {
    const feed = demoFeed()
    const layout = layoutOffice(deriveOfficeModel(feed, Date.now()))
    const s = new OfficeScene()
    s.sync(layout, feed)
    const active = layout.characters.filter((c) => c.deskIndex !== null && c.model.active)
    const idle = layout.characters.filter((c) => c.deskIndex !== null && !c.model.active)
    expect(find(s.scene, (o) => o.userData.screen === 'on')).toHaveLength(active.length)
    expect(find(s.scene, (o) => o.userData.screen === 'saver')).toHaveLength(idle.length)

    const target = active[0]
    const zeroAt = (): number =>
      find(s.scene, (o) => o instanceof InstancedMesh).filter((im) => {
        const m = new Matrix4()
        ;(im as InstancedMesh).getMatrixAt(target.deskIndex!, m)
        return m.determinant() === 0
      }).length
    expect(zeroAt()).toBe(0)
    s.setFocus(target.key)
    const body = find(s.scene, (o) => o instanceof Mesh && o.userData.charKey === target.key && !(o.parent && o.parent.userData.isRoom))
    const groupVisible = (o: Object3D): boolean => {
      let p: Object3D | null = o
      while (p) {
        if (!p.visible) return false
        p = p.parent
      }
      return true
    }
    const charMeshes = body.filter((m) => !(m.userData.screen !== undefined))
    expect(charMeshes.length).toBeGreaterThan(0)
    expect(charMeshes.every((m) => !groupVisible(m))).toBe(true)
    // Assento, encosto, coluna e base da cadeira daquela mesa.
    expect(zeroAt()).toBe(4)
    s.setFocus(null)
    expect(charMeshes.every((m) => groupVisible(m))).toBe(true)
    expect(zeroAt()).toBe(0)
    s.dispose()
  })

  it('dispose libera geometrias e texturas', () => {
    const feed = demoFeed()
    const s = new OfficeScene()
    s.sync(layoutOffice(deriveOfficeModel(feed, Date.now())), feed)
    const textures = new Set<Texture>()
    s.scene.traverse((o) => {
      const mat = (o as Mesh).material as { map?: Texture | null } | undefined
      if (mat && !Array.isArray(mat) && mat.map) textures.add(mat.map)
    })
    expect(textures.size).toBeGreaterThan(3)
    const freed = new Set<Texture>()
    for (const t of textures) t.addEventListener('dispose', () => freed.add(t))
    s.dispose()
    expect(freed.size).toBe(textures.size)
  })
})

describe('Office3DWorkspace com o feed de demonstração', () => {
  it('pílula: "⚡ Energia do escritório" com a %, o nível e a hora em que recarrega; o título explica que são os tokens da sessão de 5h', () => {
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    const b = screen.getByTestId('o3d-session-battery')
    expect(b.textContent).toContain('⚡ Energia do escritório')
    expect(b.textContent).toContain('85%')
    expect(b.textContent).toContain('Energia cheia')
    expect(b.textContent).toMatch(/recarrega às \d\d:\d\d/)
    expect(b.textContent).not.toMatch(/reseta/)
    expect(b.dataset.level).toBe('cheia')
    expect(b.title).toContain('tokens da sessão de 5h')
    expect(b.title).toMatch(/85% restantes \(15% usados\)/)
    expect(b.title).toMatch(/A janela recarrega às \d\d:\d\d\./)
    // A pílula de vidro mora no HUD, no canto esquerdo da faixa de cima.
    expect(b.closest('.o3d-hud')).toBeTruthy()
    expect(b.classList.contains('o3d-glass')).toBe(true)
  })

  it('pílula no apagão: "Apagão — recarrega às HH:MM"', () => {
    const feed = demoFeed()
    const resetsAt = Date.now() + 40 * 60_000
    const out = { ...feed, usageLimits: { five_hour: { rateLimitType: 'five_hour' as const, status: 'rejected' as const, utilization: 1, resetsAt } } }
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(out), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    const b = screen.getByTestId('o3d-session-battery')
    const hhmm = new Date(resetsAt).toTimeString().slice(0, 5)
    expect(b.textContent).toContain('0%')
    expect(b.textContent).toContain(`Apagão — recarrega às ${hhmm}`)
    expect(b.dataset.level).toBe('apagao')
  })

  it('Ctrl+Alt+Shift+B (DEV) força o próximo nível de energia em ciclo e volta à leitura real', () => {
    if (!import.meta.env.DEV) return
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    const level = (): string | undefined => screen.getByTestId('o3d-session-battery').dataset.level
    const press = (): void => {
      act(() => void fireEvent.keyDown(window, { key: 'B', ctrlKey: true, altKey: true, shiftKey: true }))
    }
    expect(level()).toBe('cheia')
    const seen: Array<string | undefined> = []
    for (let i = 0; i < 4; i++) {
      press()
      seen.push(level())
    }
    expect(seen).toEqual(['economia', 'alerta', 'apagao', 'cheia'])
    expect(screen.getByTestId('o3d-session-battery').textContent).toContain('85%')
  })

  it('sem usageLimits a bateria da sessão não aparece', () => {
    const feed = { ...demoFeed(), usageLimits: undefined }
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(feed), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    expect(screen.queryByTestId('o3d-session-battery')).toBeNull()
  })

  it('foco abre o monitor no Chat; a um clique, o Código: a aba do arquivo que o agente edita e o diff (verde/vermelho) dos trechos', () => {
    const feed = demoFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === 'demo-0-0')!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    render(
      <UiProvider>
        <Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(feed), createRenderer: renderer, raf: () => 1, caf: () => {} }} />
      </UiProvider>
    )
    fireEvent.pointerDown(screen.getByTestId('office3d-canvas'), { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    const card = screen.getByTestId('office-screen')
    expect([card.dataset.mode, card.dataset.kind]).toEqual(['chat', 'chat'])
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(card.dataset.kind).toBe('code')
    const tab = screen.getByRole('tab', { name: 'total.ts, modificado' })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    // Sem o arquivo do disco (sem window.api), os trechos da própria edição, sem número inventado.
    const editor = screen.getByRole('tabpanel')
    expect(editor.querySelector('.cm-hunk')).toBeTruthy()
    expect(editor.querySelectorAll('.cm-row.cm-add')).toHaveLength(4)
    expect(editor.querySelectorAll('.cm-row.cm-del')).toHaveLength(4)
    expect(editor.querySelector('.cm-row.cm-add .cm-code')?.textContent).toContain('discount = 0')
    expect([...editor.querySelectorAll('.cm-row.cm-add .cm-num')].every((n) => n.textContent === '')).toBe(true)
    expect(card.querySelector('.cm-statusbar')?.textContent).toContain('1 arquivo alterado')
    expect(card.querySelector('.cm-statusbar')?.textContent).toContain('TypeScript')
  })

  it('o Chat da tela mostra o turno da conversa como no chat: o pedido em balão e os cartões recolhidos, que abrem ao clicar', () => {
    const feed = demoFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === 'demo-0-0')!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    render(
      <UiProvider>
        <Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(feed), createRenderer: renderer, raf: () => 1, caf: () => {} }} />
      </UiProvider>
    )
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    // Abre no Chat (o padrão do Escritório).
    const card = screen.getByTestId('office-screen')
    expect(card.dataset.kind).toBe('chat')
    expect(card.querySelector('.o3d-turn-title')?.textContent).toBe('Demo 1.1')
    expect(card.querySelector('.msg.user .bubble')?.textContent).toContain('desconto percentual')
    const cards = [...card.querySelectorAll<HTMLElement>('.tool-card')]
    expect(cards.map((c) => c.querySelector('.tool-name')?.textContent)).toEqual(['Read', 'Edit'])
    const edit = cards[1]
    expect(edit.querySelector('.tool-detail')?.textContent).toBe('total.ts')
    expect(edit.querySelector('.diff-add')?.textContent).toBe('+5')
    expect(edit.querySelector('.diff-del')?.textContent).toBe('−5')
    expect(edit.querySelector('.tool-badge.run')?.textContent).toBe('running…')
    expect(cards[0].querySelector('.tool-badge.ok')?.textContent).toBe('done')
    // Recolhido como no chat; o clique abre o diff realçado.
    expect(edit.querySelector('pre.code-block')).toBeNull()
    fireEvent.click(edit.querySelector('.tool-head')!)
    expect(edit.querySelector('pre.code-block')).toBeTruthy()
    // Trabalhando: o "digitando" do chat no fim. Só leitura: sem "Tentar de novo" nem "Ouvir".
    expect(card.querySelector('.bubble.typing')).toBeTruthy()
    expect(card.querySelector('.msg-retry, .msg-speak')).toBeNull()
    // A alternância volta ao Código.
    expect(screen.getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Código' }))
    expect(card.dataset.kind).toBe('code')
    expect(screen.getByRole('tab', { name: 'total.ts, modificado' })).toBeTruthy()
  })

  it('Ctrl+Alt+Shift+D liga e desliga o feed de demonstração (DEV)', () => {
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={vi.fn()} engineOptions={{ source: staticSource(), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    act(() => void fireEvent.keyDown(window, { key: 'D', ctrlKey: true, altKey: true, shiftKey: true }))
    expect(officeStore.overridden).toBe(true)
    expect(officeStore.getSnapshot()?.conversations[0].id).toBe('demo-0-0')
    act(() => void fireEvent.keyDown(window, { key: 'D', ctrlKey: true, altKey: true, shiftKey: true }))
    expect(officeStore.overridden).toBe(false)
  })
})
