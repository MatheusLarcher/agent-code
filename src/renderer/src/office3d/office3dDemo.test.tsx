import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { InstancedMesh, Matrix4, Mesh, Texture, type Object3D } from 'three'
import { deriveOfficeModel } from '../office/adapter/model'
import { officeStore } from '../office/officeStore'
import { DEMO_PER_ROOM, DEMO_ROOMS, demoFeed } from './demoFeed'
import type { FeedSource, RendererLike } from './engine'
import { layoutOffice } from './layout'
import { Office3DWorkspace } from './Office3DWorkspace'
import { OfficeScene, screenPageFor } from './scene'

const renderer = (): RendererLike => ({ setPixelRatio() {}, setSize() {}, render() {}, dispose() {} })
const staticSource = (feed = demoFeed()): FeedSource => ({ getSnapshot: () => feed, subscribe: () => () => {} })

beforeEach(() => {
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

  it('a tela do agente ativo mostra o código real da ferramenta atual', () => {
    const feed = demoFeed()
    const chars = deriveOfficeModel(feed, Date.now()).characters
    const edit = screenPageFor(feed, chars.find((c) => c.convId === 'demo-0-0')!)
    expect(edit.title).toBe('Edit')
    expect(edit.lines.some((l) => l.kind === 'del')).toBe(true)
    expect(edit.lines.some((l) => l.kind === 'add' && l.text.includes('discount'))).toBe(true)
    const bash = screenPageFor(feed, chars.find((c) => c.convId === 'demo-0-2')!)
    expect(bash.lines[0]).toEqual({ kind: 'cmd', text: '$ npm test -- --run' })
    const write = screenPageFor(feed, chars.find((c) => c.convId === 'demo-0-1')!)
    expect(write.subtitle).toBe('Cart.tsx')
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

  it('foco abre o cartão da ferramenta como no chat (diff com +/−, código realçado)', () => {
    const feed = demoFeed()
    const target = layoutOffice(deriveOfficeModel(feed, Date.now())).characters.find((c) => c.model.convId === 'demo-0-0')!
    vi.spyOn(OfficeScene.prototype, 'pick').mockReturnValue(target.key)
    const onOpenFile = vi.fn()
    render(<Office3DWorkspace chat={null} onOpenConversation={vi.fn()} onOpenFile={onOpenFile} engineOptions={{ source: staticSource(feed), createRenderer: renderer, raf: () => 1, caf: () => {} }} />)
    const canvas = screen.getByTestId('office3d-canvas')
    fireEvent.pointerDown(canvas, { button: 0, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(window, { button: 0, clientX: 50, clientY: 50 })
    const card = screen.getByTestId('office-screen')
    expect(card.dataset.kind).toBe('diff')
    expect(card.querySelector('.tool-card .tool-head .tool-name')?.textContent).toBe('Edit')
    expect(card.querySelector('.diff-add')?.textContent).toBe('+5')
    expect(card.querySelector('.diff-del')?.textContent).toBe('−5')
    expect(card.querySelector('pre.code-block')).toBeTruthy()
    expect(card.querySelector('.tool-badge.run')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'total.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('C:\\demo\\agent-code\\src\\total.ts')
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
