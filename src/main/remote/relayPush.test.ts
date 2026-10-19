// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { AddressInfo } from 'node:net'
// @ts-expect-error — JS puro do projeto irmão broker/ (sem tipos)
import { createBroker } from '../../../broker/src/broker.js'
import { RelayClient } from './relayClient'

// O push pelo WebSocket do relay que já existe: PC → broker (FCM falso) → resultado de volta.

const TOKEN_APARELHO = 'fcm-token-do-celular-0123456789abcdef:APA91b'
let broker: ReturnType<typeof createBroker> | null = null
let relay: RelayClient | null = null

afterEach(async () => {
  relay?.stop()
  relay = null
  if (broker) await broker.close()
  broker = null
})

async function ligar(send: (m: unknown) => Promise<unknown>): Promise<RelayClient> {
  broker = createBroker({ fcm: { send } })
  await new Promise<void>((r) => broker!.listen(0, r))
  const port = (broker!.server.address() as AddressInfo).port
  const client = new RelayClient({ brokerUrl: `ws://127.0.0.1:${port}/__relay`, getToken: () => 'pc-token', getPort: () => 1 })
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (client.isConnected()) {
        clearInterval(tick)
        resolve()
      }
    }, 5)
    client.start()
  })
  relay = client
  return client
}

describe('RelayClient.push', () => {
  it('envia pelo socket do relay e devolve o resultado do FCM', async () => {
    const enviados: unknown[] = []
    const client = await ligar(async (m) => (enviados.push(m), { ok: true, status: 200 }))
    expect(await client.push({ token: TOKEN_APARELHO, title: 'Lembrete', body: 'Beber água', data: { convId: 'c1' } })).toEqual({ ok: true, status: 200 })
    expect(enviados).toEqual([{ token: TOKEN_APARELHO, title: 'Lembrete', body: 'Beber água', data: { convId: 'c1' } }])
  })

  it('erro do FCM chega ao PC; sem broker volta falha sem lançar', async () => {
    const client = await ligar(async () => ({ ok: false, status: 404, error: 'UNREGISTERED' }))
    expect(await client.push({ token: TOKEN_APARELHO, title: 'x', body: 'y' })).toEqual({ ok: false, status: 404, error: 'UNREGISTERED' })
    client.stop()
    expect(await client.push({ token: TOKEN_APARELHO, title: 'x', body: 'y' })).toEqual({ ok: false, status: 0, error: 'broker-desconectado' })
  })

  it('PC cai com o pedido em voo: a espera resolve como falha', async () => {
    const client = await ligar(() => new Promise(() => undefined)) // FCM que nunca responde
    const pending = client.push({ token: TOKEN_APARELHO, title: 'x', body: 'y' })
    await new Promise((r) => setTimeout(r, 30))
    client.kick()
    expect(await pending).toEqual({ ok: false, status: 0, error: 'broker-desconectado' })
  })
})
