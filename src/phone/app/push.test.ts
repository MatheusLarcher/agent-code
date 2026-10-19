import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Channels } from '@shared/ipc'

// O push com a ponte nativa do Capacitor simulada: permissão, token ao PC, toque abre a conversa.

const h = vi.hoisted(() => ({
  conectar: [] as Array<() => void>,
  state: { screen: 'main' as string },
  openConversation: vi.fn(),
  toast: vi.fn(),
  invokeIpc: vi.fn(async () => ({ ok: true }))
}))

vi.mock('./runtime', () => ({
  client: { state: h.state },
  openConversation: h.openConversation,
  toast: h.toast,
  quandoConectar: (fn: () => void) => h.conectar.push(fn)
}))
vi.mock('../office/bridgeApi', () => ({ invokeIpc: h.invokeIpc }))

type Ouvinte = (data: unknown) => void
const TOKEN = 'fcm-token-do-celular-0123456789abcdef:APA91b'

function ponte(receive: string) {
  const ouvintes = new Map<string, Ouvinte>()
  const chamadas: Array<[string, unknown]> = []
  window.Capacitor = {
    PluginHeaders: [{ name: 'PushNotifications' }],
    addListener: (_p: string, ev: string, cb: Ouvinte) => ouvintes.set(ev, cb),
    nativePromise: async (_p: string, method: string, opts?: unknown) => {
      chamadas.push([method, opts])
      if (method === 'checkPermissions') return { receive: 'prompt' }
      if (method === 'requestPermissions') return { receive }
      if (method === 'register') ouvintes.get('registration')?.({ value: TOKEN })
      return {}
    }
  }
  return { ouvintes, chamadas }
}

const espera = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.resetModules()
  h.conectar.length = 0
  h.state.screen = 'main'
  h.openConversation.mockClear()
  h.toast.mockClear()
  h.invokeIpc.mockClear()
  delete window.Capacitor
})

describe('push no celular', () => {
  it('fora do APK não liga nada', async () => {
    const { ligarPush, pushDisponivel } = await import('./push')
    expect(pushDisponivel()).toBe(false)
    ligarPush()
    expect(h.conectar).toHaveLength(0)
  })

  it('ao conectar: pede a permissão, cria o canal, registra e manda o token ao PC', async () => {
    const p = ponte('granted')
    const { ligarPush } = await import('./push')
    ligarPush()
    h.conectar[0]()
    await espera()
    await espera()
    expect(p.chamadas.map(([m]) => m)).toEqual(['checkPermissions', 'requestPermissions', 'createChannel', 'register'])
    expect(p.chamadas[2][1]).toMatchObject({ id: 'avisos', importance: 4 })
    expect(h.invokeIpc).toHaveBeenCalledWith(expect.anything(), Channels.celularPushToken, [{ token: TOKEN }])
  })

  it('permissão recusada: aviso claro uma vez, sem registrar', async () => {
    const p = ponte('denied')
    const { ligarPush } = await import('./push')
    ligarPush()
    h.conectar[0]()
    await espera()
    h.conectar[0]()
    await espera()
    expect(p.chamadas.some(([m]) => m === 'register')).toBe(false)
    expect(h.toast).toHaveBeenCalledTimes(1)
    expect(h.toast.mock.calls[0][0]).toMatch(/Notificações desligadas/)
  })

  it('tocar no aviso abre a conversa; antes de conectar, abre quando conectar', async () => {
    const p = ponte('granted')
    const { ligarPush } = await import('./push')
    ligarPush()
    p.ouvintes.get('pushNotificationActionPerformed')!({ notification: { data: { convId: 'c7' } } })
    expect(h.openConversation).toHaveBeenCalledWith('c7')
    h.state.screen = 'boot'
    p.ouvintes.get('pushNotificationActionPerformed')!({ notification: { data: { convId: 'c8' } } })
    expect(h.openConversation).toHaveBeenCalledTimes(1)
    h.state.screen = 'main'
    h.conectar[0]()
    expect(h.openConversation).toHaveBeenLastCalledWith('c8')
  })

  it('com o app aberto, o aviso vira um toast', async () => {
    const p = ponte('granted')
    const { ligarPush } = await import('./push')
    ligarPush()
    p.ouvintes.get('pushNotificationReceived')!({ title: 'Passagem · bateu', body: 'R$ 2.890' })
    expect(h.toast).toHaveBeenCalledWith('Passagem · bateu — R$ 2.890', 'sucesso', 6000)
  })
})
