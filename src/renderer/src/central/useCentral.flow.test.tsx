import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import type { ImageAttachment, PermissionRequest } from '@shared/ipc'
import { CENTRAL_ID, type CentralReplyEntry, type CentralRequestEntry, type CentralRouteResult, type CentralTarget } from '@shared/central'
import type { UIMessage } from '../types'
import { projectColorHex } from '../office/adapter/model'
import { DISCARDED_MESSAGE, OTHER_DEVICE_MESSAGE } from './centralDelivery'
import { MIRROR_THROTTLE_MS } from './useCentral'
import { SELF, centralConv, conv, mountCentral } from './centralHookKit'

/**
 * A volta e o resto do controller: espelho (criada no 1º conteúdo, atualizada no
 * lugar, terminada, subagente fora, throttle em rajada, re-link), perguntas dos
 * destinos, "não era aqui" (fila / rodando / terminado → escolha → correção), a
 * adoção da Emenda A1, abrir o destino, trilho e cartões do turno.
 */

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const A1: CentralTarget = { kind: 'conversation', convId: 'a1', cwd: 'C:\\proj\\alpha', project: 'alpha', title: 'Filtros', sandbox: false }
const B1: CentralTarget = { kind: 'conversation', convId: 'b1', cwd: 'C:\\proj\\beta', project: 'beta', title: 'Relatório', sandbox: false }

function installApi(route: (req: { forceAsk?: boolean }) => CentralRouteResult) {
  const api = {
    centralRoute: vi.fn(async (req: { forceAsk?: boolean }) => route(req)),
    centralCorrection: vi.fn(async () => {}),
    sandboxCreate: vi.fn(async () => ({ path: 'C:\\local\\sandbox\\x' })),
    pathExists: vi.fn(async () => true)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}
/** Direto para a1; reenvio forçado ("não era aqui") pergunta com b1. */
const toA1ThenAsk = (req: { forceAsk?: boolean }): CentralRouteResult =>
  req.forceAsk ? { kind: 'ask', options: [{ target: B1 }], reason: 'moved' } : { kind: 'direct', target: A1, rule: 'continua', confidence: 0.9, why: 'continua “Filtros”' }

const text = (id: string, t: string, answer = false): UIMessage => ({ kind: 'assistant-text', id, text: t, final: true, ...(answer ? { answer: true } : {}) })
const read = (id: string, file: string, parent: string | null = null): UIMessage => ({ kind: 'tool-use', id, name: 'Read', input: { file_path: file }, parentToolUseId: parent, result: { isError: false, text: 'ok' } })
const delivered = (id: string, convId: string, msgId: string, extra: Partial<CentralRequestEntry> = {}): CentralRequestEntry => ({
  kind: 'request', id, ts: 1, text: id, state: 'delivered', origin: 'central', route: { target: A1, rule: 'continua', confidence: 0.9, why: 'x' }, anchor: { convId, msgId }, ...extra
})
const world = () => [centralConv(), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')]
const replyOf = (k: ReturnType<typeof mountCentral>, requestId: string) =>
  k.entries().find((e): e is CentralReplyEntry => e.kind === 'reply' && e.requestId === requestId)

async function sendDirect(k: ReturnType<typeof mountCentral>, t: string): Promise<CentralRequestEntry> {
  await k.run(() => k.world().central.send(t, [], [], [], []))
  await waitFor(() => expect(k.requests().at(-1)?.state).toBe('delivered'))
  return k.requests().at(-1)!
}

describe('espelho', () => {
  it('resposta criada no 1º conteúdo, atualizada no lugar e terminada no fim; subagente nunca entra', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral(world())
    const entry = await sendDirect(k, 'arruma o filtro')
    expect(replyOf(k, entry.id)).toBeUndefined()
    await k.run(() => k.world().addMessages('a1', text('t1', 'Vou olhar o filtro.')))
    await waitFor(() => expect(replyOf(k, entry.id)?.notes).toEqual(['Vou olhar o filtro.']))
    const first = replyOf(k, entry.id)!
    expect(first).toMatchObject({ id: `reply:${entry.id}`, anchor: entry.anchor, done: false, device: SELF })
    await k.run(() => k.world().addMessages('a1', read('k1', 'src/filtros.js'), read('k2', 'sub.ts', 'task1'), text('t2', 'Pronto: filtro arrumado.', true)))
    await k.run(() => k.world().setBusy('a1', false))
    await waitFor(() => expect(replyOf(k, entry.id)?.done).toBe(true))
    const last = replyOf(k, entry.id)!
    expect(last).toMatchObject({ id: first.id, ts: first.ts, notes: ['Vou olhar o filtro.'], answer: 'Pronto: filtro arrumado.' })
    expect(last.activity.count).toBe(1)
    expect(k.entries().filter((e) => e.kind === 'reply')).toHaveLength(1)
  })

  it('a resposta entra na ordem do tempo: depois de um pedido mais novo', async () => {
    installApi(toA1ThenAsk)
    const asking: CentralRequestEntry = { kind: 'request', id: 'r2', ts: 2, text: 'outra', state: 'asking', ask: { options: [], reason: 'low-confidence' } }
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1'), asking]), conv('a1', 'C:\\proj\\alpha', 'Filtros', { messages: [{ kind: 'user', id: 'u1', text: 'r1' }] })])
    await k.run(() => k.world().addMessages('a1', text('t1', 'olhando')))
    await waitFor(() => expect(k.entries().map((e) => e.id)).toEqual(['r1', 'r2', 'reply:r1']))
  })

  it('rajada: grava no começo da janela e no fim (300 ms), não a cada evento', async () => {
    vi.useFakeTimers()
    installApi(toA1ThenAsk)
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros', { messages: [{ kind: 'user', id: 'u1', text: 'r1' }] })])
    await k.run(() => k.world().setBusy('a1', true))
    await k.run(() => vi.advanceTimersByTime(MIRROR_THROTTLE_MS * 3))
    const writes = () => k.spies.patch.mock.calls.filter(([id]) => id === CENTRAL_ID).length
    k.spies.patch.mockClear()
    await k.run(() => k.world().addMessages('a1', text('t0', 'nota 0')))
    expect(writes()).toBe(1)
    for (let i = 1; i < 10; i++) await k.run(() => k.world().addMessages('a1', text(`t${i}`, `nota ${i}`)))
    expect(writes()).toBe(1)
    await k.run(() => vi.advanceTimersByTime(MIRROR_THROTTLE_MS))
    expect(writes()).toBe(2)
    expect(replyOf(k, 'r1')?.notes).toHaveLength(10)
  })

  it('depois de reiniciar: destino de turno que começou e não terminou, fora da tela, é lido por id (uma vez) e espelhado', async () => {
    installApi(toA1ThenAsk)
    const far = conv('longe', 'C:\\proj\\gama', 'Antiga', { messages: [{ kind: 'user', id: 'u9', text: 'r9' }, text('t9', 'Feito.', true)] })
    const loadByIds = vi.fn(async () => [far])
    const started: CentralReplyEntry = { kind: 'reply', id: 'reply:r9', ts: 2, requestId: 'r9', anchor: { convId: 'longe', msgId: 'u9' }, notes: [], activity: { segments: [], text: '', count: 0, errors: 0 }, done: false }
    const k = mountCentral([centralConv([delivered('r9', 'longe', 'u9'), started])], { over: { loadByIds } })
    await waitFor(() => expect(replyOf(k, 'r9')).toMatchObject({ answer: 'Feito.', done: true }))
    await k.run(() => k.world().patchConv(CENTRAL_ID, (c) => ({ ...c, updatedAt: 2 })))
    expect(loadByIds).toHaveBeenCalledTimes(1)
    expect(loadByIds).toHaveBeenCalledWith(['longe'])
    expect(k.find('longe')).toBeTruthy()
  })
})

describe('perguntas dos destinos', () => {
  const ask: PermissionRequest = { id: 'p1', toolName: 'AskUserQuestion', input: {}, questions: [{ header: 'Cor', question: 'Qual cor?', multiSelect: false, options: [{ label: 'Azul', description: '' }] }] }

  it('só as das conversas com turno em aberto; responder chama respondToPermission(convId) e guarda a pergunta', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    k.inflightRef.current = { a1: { msgId: 'u1' } }
    await k.run(() => k.world().setPermissions({ a1: ask, b1: { id: 'p2', toolName: 'Bash', input: { command: 'ls' } } }))
    expect(k.world().central.pending).toEqual([{ convId: 'a1', label: k.world().central.labelFor('a1'), request: ask }])
    expect(k.world().central.hasActiveAnchor('a1')).toBe(true)
    expect(k.world().central.hasActiveAnchor('b1')).toBe(false)
    const res = { id: 'p1', behavior: 'allow' as const, answers: [{ header: 'Cor', question: 'Qual cor?', selected: ['Azul'] }] }
    await k.run(() => k.world().central.answer('a1', res))
    expect(k.spies.respondToPermission).toHaveBeenCalledWith('a1', res)
    expect(k.entries().at(-1)).toMatchObject({ kind: 'question', convId: 'a1', question: 'Qual cor?', answer: 'Azul', device: SELF })
  })

  it('pedido entregue sem turno vivo (descartado, parado antes do 1º evento) não prende a conversa; fila e recuperação contam', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros')])
    await k.run(() => k.world().setPermissions({ a1: ask }))
    expect(k.world().central.pending).toEqual([])
    expect(k.world().central.hasActiveAnchor('a1')).toBe(false)
    k.queueRef.current = [{ id: 'q1', convId: 'a1', msgId: 'u1' }]
    expect(k.world().central.hasActiveAnchor('a1')).toBe(true)
    k.queueRef.current = []
    const recovery = { id: 'rec', reason: 'transient' as const, scheduledAt: 1, attempt: 1, maxAttempts: 3, errorText: 'x', messageId: 'u1' }
    await k.run(() => k.world().patchConv('a1', (c) => ({ ...c, recovery })))
    expect(k.world().central.hasActiveAnchor('a1')).toBe(true)
  })

  it('resposta que falha: aviso de erro e nada guardado', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros')])
    k.spies.respondToPermission.mockRejectedValue(new Error('sessão caiu'))
    await k.run(() => k.world().setPermissions({ a1: ask }))
    await k.run(() => k.world().central.answer('a1', { id: 'p1', behavior: 'deny' }))
    expect(k.spies.notify).toHaveBeenCalledWith('erro', 'Não foi possível responder: sessão caiu')
    expect(k.entries().some((e) => e.kind === 'question')).toBe(false)
  })
})

describe('"não era aqui"', () => {
  it('na fila: tira SÓ aquele item, pergunta sem o destino errado; escolher entrega e grava a correção', async () => {
    const api = installApi(toA1ThenAsk)
    const k = mountCentral(world())
    await k.run(() => k.world().setBusy('a1', true))
    const entry = await sendDirect(k, 'arruma o filtro')
    expect(k.queueRef.current).toEqual([{ id: `q-${entry.anchor!.msgId}`, convId: 'a1', msgId: entry.anchor!.msgId }])
    await k.run(() => k.world().central.notHere(entry.id))
    expect(k.spies.deleteQueued).toHaveBeenCalledWith(`q-${entry.anchor!.msgId}`)
    expect(k.spies.stopKeepingQueue).not.toHaveBeenCalled()
    expect(api.centralRoute).toHaveBeenLastCalledWith(expect.objectContaining({ forceAsk: true, exclude: A1 }))
    const moved = k.requests()[0]
    expect(moved).toMatchObject({ state: 'asking', movedFrom: A1, ask: { reason: 'moved', options: [{ target: B1 }] } })
    expect(moved).not.toHaveProperty('anchor')
    expect(moved).not.toHaveProperty('route')
    await k.run(() => k.world().central.choose(entry.id, 0))
    expect(k.requests()[0]).toMatchObject({ state: 'delivered', anchor: { convId: 'b1' }, route: { target: B1, byUser: true } })
    expect(api.centralCorrection).toHaveBeenCalledWith({ ts: expect.any(Number), text: 'arruma o filtro', attachments: [], from: A1, fromRule: 'continua', fromConfidence: 0.9, to: B1 })
  })

  it('rodando: para o turno mantendo a fila dele; a resposta espelhada sai', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral(world())
    const entry = await sendDirect(k, 'arruma o filtro')
    await k.run(() => k.world().addMessages('a1', text('t1', 'olhando')))
    await waitFor(() => expect(replyOf(k, entry.id)).toBeTruthy())
    await k.run(() => k.world().central.notHere(entry.id))
    expect(k.spies.stopKeepingQueue).toHaveBeenCalledWith('a1')
    expect(k.spies.deleteQueued).not.toHaveBeenCalled()
    expect(replyOf(k, entry.id)).toBeUndefined()
    expect(k.requests()[0].state).toBe('asking')
  })

  it('em recuperação automática (o turno dela falhou e vai ser retomado): para também, mantendo a fila', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral(world())
    const entry = await sendDirect(k, 'arruma o filtro')
    k.inflightRef.current = {}
    const recovery = { id: 'rec', reason: 'transient' as const, scheduledAt: Date.now() + 60_000, attempt: 1, maxAttempts: 3, errorText: 'x', messageId: entry.anchor!.msgId }
    await k.run(() => k.world().patchConv('a1', (c) => ({ ...c, recovery })))
    await k.run(() => k.world().central.notHere(entry.id))
    expect(k.spies.stopKeepingQueue).toHaveBeenCalledWith('a1')
    expect(k.spies.deleteQueued).not.toHaveBeenCalled()
    expect(k.requests()[0].state).toBe('asking')
  })

  it('enquanto o destino conecta: a entrega antiga, quando volta, não mexe na âncora nova nem pergunta de novo', async () => {
    const api = installApi(toA1ThenAsk)
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const k = mountCentral(world(), { dispatchGate: (id) => (id === 'a1' ? gate : undefined) })
    // Como no App: o Stop sem query viva deixa a conversa parada, e a mensagem não sai.
    k.spies.stopKeepingQueue.mockImplementation((cid) => {
      k.inflightRef.current[cid] = undefined
      k.world().setBusy(cid, false)
    })
    await k.run(() => k.world().central.send('arruma o filtro', [], [], [], []))
    await waitFor(() => expect(k.requests()[0]?.state).toBe('delivered'))
    const first = k.requests()[0]
    await k.run(() => k.world().central.notHere(first.id))
    expect(k.spies.stopKeepingQueue).toHaveBeenCalledWith('a1')
    await waitFor(() => expect(k.requests()[0].state).toBe('asking'))
    await k.run(() => k.world().central.choose(first.id, 0))
    await waitFor(() => expect(k.requests()[0]).toMatchObject({ state: 'delivered', anchor: { convId: 'b1' } }))
    const anchorB = k.requests()[0].anchor!
    await k.run(async () => {
      open()
      await gate
    })
    expect(k.requests()[0]).toMatchObject({ state: 'delivered', anchor: anchorB })
    expect(api.centralRoute).toHaveBeenCalledTimes(2)
    expect(k.sent).toEqual([['b1', anchorB.msgId]])
  })

  it('já terminado: nada a parar, mas pergunta de novo; entrada adotada nunca oferece', async () => {
    const api = installApi(toA1ThenAsk)
    const adopted = delivered('ad', 'b1', 'u5', { origin: 'conversation' })
    const k = mountCentral([centralConv([adopted]), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    const entry = await sendDirect(k, 'arruma o filtro')
    await k.run(() => k.world().setBusy('a1', false))
    k.inflightRef.current = {}
    await k.run(() => k.world().central.notHere(entry.id))
    expect(k.spies.stopKeepingQueue).not.toHaveBeenCalled()
    expect(k.spies.deleteQueued).not.toHaveBeenCalled()
    expect(k.requests().find((e) => e.id === entry.id)?.state).toBe('asking')
    const calls = api.centralRoute.mock.calls.length
    await k.run(() => k.world().central.notHere('ad'))
    expect(api.centralRoute.mock.calls.length).toBe(calls)
    expect(k.requests().find((e) => e.id === 'ad')?.state).toBe('delivered')
  })
})

describe('descarte sem rodar (Stop comum, lixeira, conversa apagada)', () => {
  it('pedido da Central descartado volta a perguntar (sem o destino); adotado vira falha; o do outro PC fica', async () => {
    const api = installApi(toA1ThenAsk)
    const adopted = delivered('ad', 'a1', 'u5', { origin: 'conversation' })
    const other = delivered('outro', 'a1', 'u6', { device: 'pc-2' })
    const k = mountCentral([centralConv([adopted, other]), conv('a1', 'C:\\proj\\alpha', 'Filtros'), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    await k.run(() => k.world().setBusy('a1', true))
    const entry = await sendDirect(k, 'arruma o filtro')
    await k.run(() => k.world().central.dropped('a1', [entry.anchor!.msgId, 'u5', 'u6']))
    await waitFor(() => expect(k.requests().find((e) => e.id === entry.id)?.state).toBe('asking'))
    expect(api.centralRoute).toHaveBeenLastCalledWith(expect.objectContaining({ forceAsk: true, exclude: A1 }))
    const moved = k.requests().find((e) => e.id === entry.id)!
    expect(moved).toMatchObject({ ask: { reason: 'target-missing', options: [{ target: B1 }] } })
    expect(moved).not.toHaveProperty('anchor')
    expect(moved).not.toHaveProperty('movedFrom')
    expect(k.requests().find((e) => e.id === 'ad')).toMatchObject({ state: 'failed' })
    expect(k.requests().find((e) => e.id === 'ad')).not.toHaveProperty('anchor')
    expect(k.requests().find((e) => e.id === 'outro')).toMatchObject({ state: 'delivered', anchor: { msgId: 'u6' } })
    expect(k.spies.notify).toHaveBeenCalledWith('aviso', DISCARDED_MESSAGE)
  })
})

describe('dono da entrada (os dois PCs dividem a Central)', () => {
  it('escolher ou "não era aqui" num pedido do outro PC não age aqui: nada despachado, nada parado, aviso', async () => {
    const api = installApi(toA1ThenAsk)
    const asking: CentralRequestEntry = { kind: 'request', id: 'r-outro', ts: 1, text: 'do outro', state: 'asking', origin: 'central', device: 'pc-2', ask: { options: [{ target: B1 }], reason: 'low-confidence' } }
    const running = delivered('r-rodando', 'a1', 'u1', { device: 'pc-2' })
    const k = mountCentral([centralConv([asking, running]), conv('a1', 'C:\\proj\\alpha', 'Filtros', { messages: [{ kind: 'user', id: 'u1', text: 'x' }] }), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    await k.run(() => k.world().setBusy('a1', true))
    k.inflightRef.current = { a1: { msgId: 'u1' } }
    await k.run(() => k.world().central.choose('r-outro', 0))
    await k.run(() => k.world().central.notHere('r-rodando'))
    expect(k.spies.dispatch).not.toHaveBeenCalled()
    expect(k.spies.stopKeepingQueue).not.toHaveBeenCalled()
    expect(api.centralRoute).not.toHaveBeenCalled()
    expect(k.requests().map((e) => e.state)).toEqual(['asking', 'delivered'])
    expect(k.spies.notify).toHaveBeenCalledWith('aviso', OTHER_DEVICE_MESSAGE)
  })
})

describe('adoção (Emenda A1)', () => {
  const IMG: ImageAttachment = { mediaType: 'image/png', data: 'QUJDRA==', label: 'midia:1 = tela.png' }
  const turn = (over: Record<string, unknown> = {}) => ({ conv: conv('a1', 'C:\\proj\\alpha', 'Filtros'), msgId: 'u7', text: 'o botão {{midia:1}}', images: [IMG], files: [], fileRefs: [], ...over })

  it('turno enviado na conversa vira pedido entregue (origem conversation, device, aviso, âncora) — uma vez só', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral(world())
    await k.run(() => k.world().central.adopt(turn()))
    await k.run(() => k.world().central.adopt(turn()))
    expect(k.requests()).toHaveLength(1)
    expect(k.requests()[0]).toMatchObject({ state: 'delivered', origin: 'conversation', device: SELF, text: 'o botão {{midia:1}}', attachments: ['tela.png'], route: { target: A1, why: 'enviada na própria conversa' }, anchor: { convId: 'a1', msgId: 'u7' } })
    expect(JSON.stringify(k.entries())).not.toContain('QUJDRA==')
  })

  it('id pré-definido (entregue pela Central) não é adotado; injetado marca o pedido dela; planejamento e Central ficam de fora', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros')])
    await k.run(() => k.world().central.adopt(turn({ msgId: 'u1', preset: true })))
    expect(k.requests()).toHaveLength(1)
    await k.run(() => k.world().central.adopt(turn({ msgId: 'u1', preset: true, injected: true })))
    expect(k.requests()[0]).toMatchObject({ id: 'r1', injected: true })
    await k.run(() => k.world().central.adopt(turn({ conv: conv('p1', 'C:\\proj\\alpha', 'Plano', { mode: 'planning' }) })))
    await k.run(() => k.world().central.adopt(turn({ conv: centralConv() })))
    expect(k.requests()).toHaveLength(1)
    await k.run(() => k.world().central.adopt(turn({ msgId: 'u8', injected: true })))
    expect(k.requests()[1]).toMatchObject({ origin: 'conversation', injected: true, anchor: { msgId: 'u8' } })
  })
})

describe('abrir, trilho e cartões do turno', () => {
  it('openDestination abre no turno e lembra que veio da Central; fora da tela, lê por id', async () => {
    installApi(toA1ThenAsk)
    const k = mountCentral(world())
    act(() => k.world().central.openDestination('a1', 'u1'))
    expect(k.spies.selectConversationAt).toHaveBeenCalledWith('a1', 'u1')
    expect(k.world().central.openedFromCentral).toBe('a1')
    k.spies.loadByIds.mockResolvedValue([conv('longe', 'C:\\proj\\gama', 'Antiga')])
    await k.run(() => k.world().central.openDestination('longe'))
    await waitFor(() => expect(k.spies.selectConversationAt).toHaveBeenLastCalledWith('longe', null))
    k.spies.loadByIds.mockResolvedValue([])
    await k.run(() => k.world().central.openDestination('sumiu'))
    await waitFor(() => expect(k.spies.notify).toHaveBeenCalledWith('aviso', 'A conversa não existe mais.'))
  })

  it('trilho = destinos ancorados ocupados, com rótulo; turnTools lê os cartões do destino (só trilha principal)', async () => {
    installApi(toA1ThenAsk)
    const msgs: UIMessage[] = [{ kind: 'user', id: 'u1', text: 'r1' }, read('k1', 'a.ts'), read('k2', 'b.ts', 'sub'), { kind: 'user', id: 'u2', text: 'depois' }, read('k3', 'c.ts')]
    const k = mountCentral([centralConv([delivered('r1', 'a1', 'u1')]), conv('a1', 'C:\\proj\\alpha', 'Filtros', { messages: msgs }), conv('b1', 'C:\\proj\\beta', 'Relatório')])
    await k.run(() => k.world().setBusy('a1', true))
    await k.run(() => k.world().setBusy('b1', true))
    expect(k.world().central.rail).toEqual([{ convId: 'a1', project: 'alpha', title: 'Filtros', color: projectColorHex(null, 'C:\\proj\\alpha'), icon: null, sandbox: false }])
    expect(k.world().central.turnTools({ convId: 'a1', msgId: 'u1' }).map((m) => ('id' in m ? m.id : ''))).toEqual(['k1'])
    expect(k.world().central.turnTools({ convId: 'fora', msgId: 'u1' })).toEqual([])
  })
})
