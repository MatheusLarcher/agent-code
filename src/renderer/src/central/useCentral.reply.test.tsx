import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import { CENTRAL_REPLY_WHY, type CentralEntry, type CentralRequestEntry, type CentralRouteResult } from '@shared/central'
import { TARGET_MISSING_MESSAGE } from './centralDelivery'
import { replyQuoteOf } from './centralReplyTo'
import { SELF, centralConv, conv, mountCentral } from './centralHookKit'

/** Responder uma mensagem da Central: vai direto à conversa dela, sem o decisor. */

function installApi() {
  const api = {
    centralRoute: vi.fn(async (): Promise<CentralRouteResult> => ({ kind: 'ask', options: [], reason: 'low-confidence' })),
    centralCorrection: vi.fn(async () => {}),
    sandboxCreate: vi.fn(async () => ({ path: 'x' })),
    pathExists: vi.fn(async () => true)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

afterEach(cleanup)

const delivered: CentralRequestEntry = {
  kind: 'request',
  id: 'r1',
  ts: 1,
  text: 'arruma o filtro',
  state: 'delivered',
  origin: 'central',
  device: SELF,
  anchor: { convId: 'a1', msgId: 'u-a' }
}
const reply: CentralEntry = {
  kind: 'reply',
  id: 'reply:r2',
  ts: 2,
  requestId: 'r2',
  anchor: { convId: 'b1', msgId: 'u-b' },
  notes: [],
  answer: 'Relatório pronto.',
  activity: { segments: [], text: '', count: 0, errors: 0 },
  done: true,
  device: SELF
}
const foreign: CentralRequestEntry = { ...delivered, id: 'r3', device: 'pc-2' }
const asking: CentralRequestEntry = { kind: 'request', id: 'r4', ts: 4, text: 'oi', state: 'asking', device: SELF }

const world = () => [
  centralConv([delivered, reply, foreign, asking]),
  conv('a1', 'C:\\proj\\alpha', 'Filtros'),
  conv('b1', 'C:\\proj\\beta', 'Relatório')
]

async function sendReply(k: ReturnType<typeof mountCentral>, text: string, replyTo: string) {
  const before = k.requests().length
  await k.run(() => k.world().central.send(text, [], [], [], [], replyTo))
  await waitFor(() => expect(k.requests().length).toBe(before + 1))
  await waitFor(() => expect(k.requests().at(-1)?.state).not.toBe('routing'))
  return k.requests().at(-1) as CentralRequestEntry
}

describe('responder uma mensagem', () => {
  it('resposta a um pedido entregue: entrega na conversa dele sem chamar o decisor, com a citação', async () => {
    const api = installApi()
    const k = mountCentral(world())
    const entry = await sendReply(k, 'e o do mês também', 'r1')
    expect(api.centralRoute).not.toHaveBeenCalled()
    expect(entry).toMatchObject({
      state: 'delivered',
      anchor: { convId: 'a1' },
      route: { target: { kind: 'conversation', convId: 'a1' }, why: CENTRAL_REPLY_WHY, byUser: true },
      replyTo: { id: 'r1', convId: 'a1', text: 'arruma o filtro' }
    })
    expect(k.spies.dispatch).toHaveBeenCalledWith('a1', 'e o do mês também', entry.anchor!.msgId, expect.anything())
  })

  it('resposta ao bloco do agente: vai à conversa dele (b1)', async () => {
    const api = installApi()
    const k = mountCentral(world())
    const entry = await sendReply(k, 'manda em PDF', 'reply:r2')
    expect(api.centralRoute).not.toHaveBeenCalled()
    expect(entry).toMatchObject({ anchor: { convId: 'b1' }, replyTo: { id: 'reply:r2', convId: 'b1', text: 'Relatório pronto.' } })
  })

  it('destino sumido: aviso e o fluxo normal de destino ausente (pergunta, sem a conversa sumida)', async () => {
    const api = installApi()
    const k = mountCentral([centralConv([{ ...delivered, anchor: { convId: 'gone', msgId: 'u' } }]), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    const entry = await sendReply(k, 'e aí?', 'r1')
    expect(k.spies.notify).toHaveBeenCalledWith('aviso', TARGET_MISSING_MESSAGE)
    expect(entry.state).toBe('asking')
    expect(entry.ask?.reason).toBe('target-missing')
    expect(api.centralRoute).toHaveBeenCalledWith(expect.objectContaining({ forceAsk: true, exclude: expect.objectContaining({ convId: 'gone' }) }))
    expect(k.spies.dispatch).not.toHaveBeenCalled()
  })

  it('id de outro PC, sem destino ou inexistente: envio normal pelo decisor, sem citação', async () => {
    for (const id of ['r3', 'r4', 'nada']) {
      const api = installApi()
      const k = mountCentral(world())
      const entry = await sendReply(k, 'oi', id)
      expect(api.centralRoute).toHaveBeenCalledTimes(1)
      expect(entry).not.toHaveProperty('replyTo')
      cleanup()
    }
  })

  it('replyQuoteOf: só pedido entregue e resposta deste PC', () => {
    expect(replyQuoteOf(delivered, SELF)).not.toBeNull()
    expect(replyQuoteOf(reply, SELF)).not.toBeNull()
    expect(replyQuoteOf(foreign, SELF)).toBeNull()
    expect(replyQuoteOf(asking, SELF)).toBeNull()
    expect(replyQuoteOf({ ...reply, device: 'pc-2' }, SELF)).toBeNull()
  })
})
