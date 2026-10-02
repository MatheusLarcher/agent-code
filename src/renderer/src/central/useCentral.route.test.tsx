import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, waitFor } from '@testing-library/react'
import type { ImageAttachment } from '@shared/ipc'
import type { CentralRequestEntry, CentralRouteRequest, CentralRouteResult, CentralTarget } from '@shared/central'
import { ATTACHMENTS_LOST_MESSAGE, CHOSEN_WHY, TARGET_MISSING_MESSAGE } from './centralDelivery'
import { ROOT, SELF, centralConv, conv, mountCentral } from './centralHookKit'

/**
 * A ida da Central (useCentral + centralDelivery) com um App mínimo e o window.api
 * simulado: rota direta (existente, nova, sandbox novo), "Para onde vai?" e a
 * escolha, decisor fora (nada se perde), destino sumido, envio que falha, recentes.
 */

type Route = (req: CentralRouteRequest) => Promise<CentralRouteResult>

function installApi(route?: Route) {
  const api = {
    centralRoute: vi.fn(route ?? (async (): Promise<CentralRouteResult> => ({ kind: 'ask', options: [], reason: 'low-confidence' }))),
    centralCorrection: vi.fn(async () => {}),
    sandboxCreate: vi.fn(async (): Promise<{ path: string } | { error: string }> => ({ path: `${ROOT}\\2026-10-02_10-00_abcd` })),
    pathExists: vi.fn(async () => true)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

afterEach(cleanup)

const A1: CentralTarget = { kind: 'conversation', convId: 'a1', cwd: 'C:\\proj\\alpha', project: 'alpha', title: 'Filtros', sandbox: false }
const B1: CentralTarget = { kind: 'conversation', convId: 'b1', cwd: 'C:\\proj\\beta', project: 'beta', title: 'Relatório', sandbox: false }
const direct = (target: CentralTarget): CentralRouteResult => ({ kind: 'direct', target, rule: 'continua', confidence: 0.9, why: 'continua “Filtros”' })
const IMG: ImageAttachment = { mediaType: 'image/png', data: 'QUJDRA==', label: 'midia:1 = tela.png' }

const world = () => [centralConv(), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')]

async function sendAndSettle(k: ReturnType<typeof mountCentral>, text: string, images: ImageAttachment[] = []) {
  await k.run(() => k.world().central.send(text, images, images.map(() => 'data:image/png;base64,QUJDRA=='), [], []))
  await waitFor(() => expect(k.requests().at(-1)?.state).not.toBe('routing'))
  return k.requests().at(-1) as CentralRequestEntry
}

describe('rota direta', () => {
  it('conversa existente: dispatch com o id pré-definido; entrada entregue com âncora, rota e dono', async () => {
    const api = installApi(async () => direct(A1))
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'o botão ficou torto')
    expect(entry).toMatchObject({ state: 'delivered', origin: 'central', device: SELF, route: { target: A1, rule: 'continua', confidence: 0.9, why: 'continua “Filtros”' }, anchor: { convId: 'a1' } })
    expect(entry).not.toHaveProperty('ask')
    expect(k.spies.dispatch).toHaveBeenCalledWith('a1', 'o botão ficou torto', entry.anchor!.msgId, expect.anything())
    expect(k.find('a1')!.messages).toEqual([expect.objectContaining({ kind: 'user', id: entry.anchor!.msgId })])
    expect(api.centralRoute).toHaveBeenCalledWith({ text: 'o botão ficou torto', attachments: [], recent: [] })
    expect(k.spies.selectConversationAt).not.toHaveBeenCalled()
  })

  it('conversa nova: criada ao fundo na pasta do projeto (sem virar a ativa) e entregue nela', async () => {
    installApi(async () => ({ kind: 'direct', target: { kind: 'new-conversation', cwd: 'C:\\proj\\beta', project: 'beta' }, rule: 'nova', confidence: 0.8, why: 'assunto novo em beta' }))
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'cria a tela de login')
    expect(k.spies.createConversation).toHaveBeenCalledWith('C:\\proj\\beta')
    expect(entry).toMatchObject({ state: 'delivered', anchor: { convId: 'new1' }, route: { rule: 'nova' } })
    expect(k.spies.dispatch).toHaveBeenCalledWith('new1', 'cria a tela de login', entry.anchor!.msgId, expect.anything())
    expect(k.spies.selectConversationAt).not.toHaveBeenCalled()
  })

  it('sandbox novo: sandboxCreate primeiro, depois a conversa na subpasta criada', async () => {
    const api = installApi(async () => ({ kind: 'direct', target: { kind: 'new-sandbox' }, rule: 'sandbox', confidence: 1, why: 'sem projeto' }))
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'quanto tá o dólar?')
    expect(api.sandboxCreate).toHaveBeenCalledTimes(1)
    expect(k.spies.createConversation).toHaveBeenCalledWith(`${ROOT}\\2026-10-02_10-00_abcd`)
    expect(entry).toMatchObject({ state: 'delivered', anchor: { convId: 'new1' } })
  })

  it('sandbox que não pôde ser criado: aviso de erro e o pedido fica perguntando, com botões', async () => {
    const api = installApi(async () => ({ kind: 'direct', target: { kind: 'new-sandbox' }, rule: 'sandbox', confidence: 1, why: 'sem projeto' }))
    api.sandboxCreate.mockResolvedValue({ error: 'disco cheio' })
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'quanto tá o dólar?')
    expect(k.spies.notify).toHaveBeenCalledWith('erro', 'Não foi possível criar a pasta do sandbox: disco cheio')
    expect(entry.state).toBe('asking')
    expect(entry.ask?.options.map((o) => o.target)).toContainEqual({ kind: 'new-sandbox' })
    expect(k.spies.dispatch).not.toHaveBeenCalled()
    expect(k.spies.createConversation).not.toHaveBeenCalled()
  })
})

describe('"Para onde vai?"', () => {
  it('ask: a mensagem espera; escolher entrega com o anexo guardado e "escolhido por você"', async () => {
    installApi(async () => ({ kind: 'ask', options: [{ target: A1, probability: 0.5 }, { target: { kind: 'new-sandbox' }, probability: 0.3 }], reason: 'low-confidence', best: 0 }))
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'veja {{midia:1}}', [IMG])
    expect(entry).toMatchObject({ state: 'asking', ask: { reason: 'low-confidence', best: 0 }, attachments: ['tela.png'] })
    expect(k.spies.dispatch).not.toHaveBeenCalled()
    await k.run(() => k.world().central.choose(entry.id, 0))
    const done = k.requests()[0]
    expect(done).toMatchObject({ state: 'delivered', route: { target: A1, why: CHOSEN_WHY, byUser: true }, anchor: { convId: 'a1' } })
    expect(done).not.toHaveProperty('ask')
    expect(k.spies.dispatch).toHaveBeenCalledWith('a1', 'veja {{midia:1}}', done.anchor!.msgId, expect.objectContaining({ images: [IMG] }))
    // Os bytes nunca vão para a Central.
    expect(JSON.stringify(k.entries())).not.toContain('QUJDRA==')
  })

  it('TypeSafe falhou (o decisor devolve typesafe-failed): pergunta com as opções dele', async () => {
    installApi(async () => ({ kind: 'ask', options: [{ target: { kind: 'new-sandbox' } }], reason: 'typesafe-failed' }))
    const k = mountCentral(world())
    expect(await sendAndSettle(k, 'oi')).toMatchObject({ state: 'asking', ask: { reason: 'typesafe-failed', options: [{ target: { kind: 'new-sandbox' } }] } })
  })

  it('IPC rejeitado: heurística (recentes, nova no projeto do último destino, sandbox) e nada se perde', async () => {
    const api = installApi(async () => direct(A1))
    const k = mountCentral(world())
    await sendAndSettle(k, 'primeiro')
    api.centralRoute.mockRejectedValue(new Error('IPC fora'))
    const entry = await sendAndSettle(k, 'segundo', [IMG])
    expect(entry).toMatchObject({ state: 'asking', ask: { reason: 'typesafe-failed' } })
    expect(entry.ask?.options.map((o) => o.target)).toEqual([A1, { kind: 'new-conversation', cwd: 'C:\\proj\\alpha', project: 'alpha' }, { kind: 'new-sandbox' }])
    expect(entry.ask).not.toHaveProperty('best')
    await k.run(() => k.world().central.choose(entry.id, 2))
    await waitFor(() => expect(k.requests()[1].state).toBe('delivered'))
    expect(k.spies.dispatch).toHaveBeenLastCalledWith('new1', 'segundo', k.requests()[1].anchor!.msgId, expect.objectContaining({ images: [IMG] }))
  })

  it('sem o IPC no preload: a mesma heurística', async () => {
    installApi()
    ;(window as unknown as { api: Record<string, unknown> }).api.centralRoute = undefined
    const k = mountCentral(world())
    expect(await sendAndSettle(k, 'oi')).toMatchObject({ state: 'asking', ask: { reason: 'typesafe-failed', options: [{ target: { kind: 'new-sandbox' } }] } })
  })
})

describe('destino sumido e envio que falha', () => {
  it('conversa que não existe mais: aviso, pergunta de novo sem ela (target-missing)', async () => {
    const gone: CentralTarget = { ...A1, convId: 'apagada' }
    const api = installApi(async (req) => (req.forceAsk ? { kind: 'ask', options: [{ target: B1 }], reason: 'moved' } : direct(gone)))
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'arruma o filtro')
    expect(k.spies.loadByIds).toHaveBeenCalledWith(['apagada'])
    expect(k.spies.notify).toHaveBeenCalledWith('aviso', TARGET_MISSING_MESSAGE)
    expect(api.centralRoute).toHaveBeenLastCalledWith(expect.objectContaining({ forceAsk: true, exclude: gone }))
    expect(entry).toMatchObject({ state: 'asking', ask: { reason: 'target-missing', options: [{ target: B1 }] } })
    expect(k.spies.dispatch).not.toHaveBeenCalled()
  })

  it('pasta da conversa sumiu: o mesmo caminho', async () => {
    const api = installApi(async (req) => (req.forceAsk ? { kind: 'ask', options: [], reason: 'moved' } : direct(A1)))
    api.pathExists.mockResolvedValue(false)
    const k = mountCentral(world())
    const entry = await sendAndSettle(k, 'arruma o filtro')
    expect(entry.ask?.reason).toBe('target-missing')
    expect(k.spies.dispatch).not.toHaveBeenCalled()
  })

  it('conversa fora da tela que existe no banco: lida por id, entra na tela e recebe a mensagem', async () => {
    const far = conv('longe', 'C:\\proj\\gama', 'Antiga')
    installApi(async () => direct({ ...A1, convId: 'longe', cwd: 'C:\\proj\\gama' }))
    const k = mountCentral(world())
    k.spies.loadByIds.mockResolvedValue([far])
    const entry = await sendAndSettle(k, 'continua aquilo')
    expect(entry).toMatchObject({ state: 'delivered', anchor: { convId: 'longe' } })
    expect(k.find('longe')).toBeTruthy()
  })

  it('a dispatch não deixou a conversa ocupada nem pôs na fila: failed e pergunta de novo', async () => {
    const api = installApi(async (req) => (req.forceAsk ? { kind: 'ask', options: [{ target: B1 }], reason: 'moved' } : direct(A1)))
    const k = mountCentral(world(), { failDispatch: new Set(['a1']) })
    const entry = await sendAndSettle(k, 'arruma o filtro')
    expect(k.spies.dispatch).toHaveBeenCalledTimes(1)
    expect(api.centralRoute).toHaveBeenCalledTimes(2)
    expect(entry).toMatchObject({ state: 'asking', ask: { reason: 'target-missing' } })
    expect(entry).not.toHaveProperty('anchor')
  })
})

describe('recentes no pedido de rota', () => {
  it('o destino anterior vai como recente (pedido, começo da resposta, pasta e título)', async () => {
    const api = installApi(async () => direct(A1))
    const k = mountCentral(world())
    const first = await sendAndSettle(k, 'arruma o filtro')
    await k.run(() => k.world().addMessages('a1', { kind: 'assistant-text', id: 't1', text: 'Filtro arrumado.', final: true, answer: true }))
    await k.run(() => k.world().setBusy('a1', false))
    await waitFor(() => expect(k.entries().some((e) => e.kind === 'reply' && e.requestId === first.id)).toBe(true))
    await sendAndSettle(k, 'agora o botão')
    expect(api.centralRoute).toHaveBeenLastCalledWith(
      expect.objectContaining({ recent: [{ convId: 'a1', request: 'arruma o filtro', replyStart: 'Filtro arrumado.', cwd: 'C:\\proj\\alpha', title: 'Filtros' }] })
    )
  })

  it('pedido de outro reinício (sem o conteúdo em memória): escolher manda só o texto e avisa dos anexos', async () => {
    installApi()
    const stored: CentralRequestEntry = { kind: 'request', id: 'r-old', ts: 1, text: 'veja {{midia:1}}', attachments: ['tela.png'], state: 'asking', ask: { options: [{ target: B1 }], reason: 'low-confidence' } }
    const k = mountCentral([centralConv([stored]), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    await k.run(() => k.world().central.choose('r-old', 0))
    expect(k.spies.notify).toHaveBeenCalledWith('aviso', ATTACHMENTS_LOST_MESSAGE)
    expect(k.spies.dispatch).toHaveBeenCalledWith('b1', 'veja [mídia 1]', k.requests()[0].anchor!.msgId, expect.objectContaining({ images: [] }))
  })
})
