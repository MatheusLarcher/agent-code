import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Group, PerspectiveCamera } from 'three'
import type { HandoffChangedMsg } from '@shared/api'
import type { HandoffProjectSnapshot } from '@shared/handoffProject'
import type { HandoffEnvio, HandoffQueueItem } from '@shared/handoffTracking'
import { HANDOFF_REMOVED_MOTIVO } from '@shared/handoffTracking'
import { createKit } from '../kit'
import type { OfficeScene } from '../scene'
import type { BoardSeals } from './boardSeals'
import { BoardTips } from './boardTips'
import { leftQueue, QueueTraySync, TRAY_KEY, TRAY_SHOWN, trayLook, trayRooms, type TrayApi } from './queueTray'
import { TrayView } from './trayView'

const item = (n: number, o: Partial<HandoffQueueItem> = {}): HandoffQueueItem => ({
  envioId: `e${n}`,
  conversationId: 'k1',
  conversationTitle: 'Conversa 1',
  projectCwd: 'C:\\proj\\a',
  planSlug: 'plano-a',
  planTitulo: 'Plano A',
  loteId: 'lote-a',
  ordem: n,
  arquivo: `p${n}.md`,
  estado: 'esperando',
  motivo: null,
  estimativaTotal: 20,
  planPosicao: 1,
  etapas: [],
  totalPrompts: 9,
  conteudo: `prompt ${n}`,
  ...o
})

const envio = (id: string, o: Partial<HandoffEnvio> = {}): HandoffEnvio =>
  ({ id, conversationId: 'k1', status: 'enviado', enviadoEm: '2026-10-07T09:00:00.000Z', motivo: null, ...o }) as HandoffEnvio

/** Uma fila de mentira: a lista e os envios são trocados pelo teste; `poke` é o aviso do main. */
function fakeApi(): TrayApi & { items: HandoffQueueItem[]; envios: HandoffEnvio[]; poke(): void } {
  const cbs = new Set<() => void>()
  const on = (cb: () => void): (() => void) => {
    cbs.add(cb)
    return () => cbs.delete(cb)
  }
  const api = {
    items: [] as HandoffQueueItem[],
    envios: [] as HandoffEnvio[],
    poke: () => cbs.forEach((cb) => cb()),
    handoffQueueList: async () => ({ ok: true as const, items: api.items }),
    handoffList: async () => ({ ok: true as const, envios: api.envios }),
    onHandoffChanged: (cb: (msg: HandoffChangedMsg) => void) => on(() => cb({ conversationId: 'k1' })),
    onHandoffProjectChanged: (cb: (snapshot: HandoffProjectSnapshot) => void) => on(() => cb({ caseInsensitive: true, folders: [] }))
  }
  return api
}

describe('a fila na bandeja: folhas = envios na fila, na ordem da faixa', () => {
  it('agrupa pela sala do escritório e põe por cima o próximo a sair (plano da vez, ordem do prompt)', () => {
    const rooms = trayRooms([
      item(3, { loteId: 'lote-b', planPosicao: 2, envioId: 'b3' }),
      item(2),
      item(1),
      item(1, { projectCwd: 'C:\\proj\\outro', envioId: 'x1' })
    ])
    expect([...rooms.keys()].sort()).toEqual(['c:/proj/a', 'c:/proj/outro'])
    expect(rooms.get('c:/proj/a')!.map((i) => i.envioId)).toEqual(['e1', 'e2', 'b3'])
  })

  it('uma folha por envio até TRAY_SHOWN; passou disso, "+K"', () => {
    expect(trayLook([])).toEqual({ sheets: 0, more: 0, stopped: false, tip: '' })
    expect(trayLook([item(1), item(2), item(3)])).toMatchObject({ sheets: 3, more: 0, stopped: false })
    const six = Array.from({ length: 6 }, (_, i) => item(i + 1))
    expect(trayLook(six)).toMatchObject({ sheets: TRAY_SHOWN, more: 6 - TRAY_SHOWN })
    expect(trayLook([item(1)]).tip).toBe('1 prompt na fila — o próximo vai para "Conversa 1" (Plano A)')
  })

  it('fila parada ou segurada pelo PO: clipe vermelho na folha de cima e o motivo na dica', () => {
    const stopped = trayLook([item(1, { estado: 'parada', motivo: 'falta o commit' }), item(2)])
    expect(stopped).toMatchObject({ sheets: 2, stopped: true })
    expect(stopped.tip).toBe('Fila parada: falta o commit · 2 na fila')
    const held = trayLook([item(1, { estado: 'segurada', motivo: 'a resposta contradiz o próximo prompt' })])
    expect(held).toMatchObject({ stopped: true, tip: 'Fila segurada pelo PO: a resposta contradiz o próximo prompt' })
    // Só a folha de cima conta: parada mais embaixo não prende o clipe.
    expect(trayLook([item(1), item(2, { estado: 'parada', motivo: 'x' })]).stopped).toBe(false)
  })

  it('a folha que saiu e espera o PO pegar continua por cima, sem clipe', () => {
    const look = trayLook([item(2, { estado: 'parada', motivo: 'x' })], item(1))
    expect(look).toMatchObject({ sheets: 2, stopped: false })
    expect(look.tip).toContain('O PO está levando o próximo prompt para "Conversa 1"')
  })

  it('leftQueue: o que estava antes e não está mais', () => {
    expect(leftQueue([item(1), item(2), item(3)], [item(2)]).map((i) => i.envioId)).toEqual(['e1', 'e3'])
  })
})

describe('QueueTraySync: relê a cada aviso e conta quem o despachante soltou', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saiu da fila e consta como enviado → onRelease; tirado da fila pelo usuário → não', async () => {
    const api = fakeApi()
    api.items = [item(1), item(2), item(3)]
    const sync = new QueueTraySync(api)
    const released: string[] = []
    let changes = 0
    sync.onRelease = (room, i) => released.push(`${room}|${i.envioId}`)
    sync.onChange = () => changes++
    await vi.runAllTimersAsync()
    expect(sync.list('c:/proj/a').map((i) => i.envioId)).toEqual(['e1', 'e2', 'e3'])
    expect(released).toEqual([])
    // O despachante soltou o e1.
    api.items = [item(2), item(3)]
    api.envios = [envio('e1')]
    api.poke()
    await vi.runAllTimersAsync()
    expect(released).toEqual(['c:/proj/a|e1'])
    // O usuário tirou o e2 da fila: some sem entrega.
    api.items = [item(3)]
    api.envios = [envio('e1'), envio('e2', { status: 'parada', enviadoEm: null, motivo: HANDOFF_REMOVED_MOTIVO })]
    api.poke()
    await vi.runAllTimersAsync()
    expect(released).toEqual(['c:/proj/a|e1'])
    expect(sync.list('c:/proj/a').map((i) => i.envioId)).toEqual(['e3'])
    expect(changes).toBe(3)
    sync.dispose()
  })

  it('vários avisos seguidos viram uma leitura só (debounce); sem API, fila vazia', async () => {
    const api = fakeApi()
    const read = vi.spyOn(api, 'handoffQueueList')
    const sync = new QueueTraySync(api)
    await vi.runAllTimersAsync()
    api.poke()
    api.poke()
    api.poke()
    await vi.runAllTimersAsync()
    expect(read).toHaveBeenCalledTimes(2)
    sync.dispose()
    expect(new QueueTraySync(null).list('c:/proj/a')).toEqual([])
  })
})

describe('a dica da bandeja', () => {
  it('quebra a linha (o motivo da fila parada vai inteiro); a do papel continua numa linha só', () => {
    const container = document.createElement('div')
    const tips = new BoardTips(container, {} as OfficeScene, new PerspectiveCamera(), {} as BoardSeals, () => null)
    const el = container.querySelector<HTMLElement>('.o3d-board-tip')!
    tips.tip(TRAY_KEY, 'Fila parada: o prompt anterior terminou com pendência: falta o commit · 4 na fila')
    expect([el.hidden, el.classList.contains('o3d-board-tip-wrap')]).toEqual([false, true])
    tips.tip('card:a', 'Conversa 1')
    expect(el.classList.contains('o3d-board-tip-wrap')).toBe(false)
    tips.dispose()
  })
})

describe('TrayView: a bandeja na cena', () => {
  it('liga as folhas da fila, o "+K" e o clipe vermelho da fila parada', () => {
    const parent = new Group()
    const view = new TrayView(createKit(1), parent)
    expect(parent.children).toContain(view.root)
    expect(view.pick.userData.charKey).toBe('office-tray')
    expect([view.visibleSheets, view.clipped]).toEqual([0, false])
    view.set(trayLook([item(1), item(2), item(3)]))
    expect([view.visibleSheets, view.clipped]).toEqual([3, false])
    view.set(trayLook([item(1, { estado: 'parada', motivo: 'x' }), ...Array.from({ length: 6 }, (_, i) => item(i + 2))]))
    expect([view.visibleSheets, view.clipped]).toEqual([TRAY_SHOWN, true])
    view.dispose()
    expect(parent.children).not.toContain(view.root)
  })
})
