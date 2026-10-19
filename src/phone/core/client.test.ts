import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { RemoteClient } from './client'
import { CONFIG_KEY, saveConfig, type PairConfig } from './config'
import { PENDING_KEY, activePc, loadPcs, renamePc, setActivePc, setPendingSwitch, takePendingSwitch, upsertPc, type SavedPc } from './pcs'
import type { ToastTipo } from './types'

class FakeEventSource {
  static last: FakeEventSource | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.last = this
  }
  close(): void {
    this.closed = true
  }
}

type Handler = (url: URL, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>

function mockFetch(handler: Handler): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const r = await handler(new URL(input), init)
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const STATE = {
  conversations: [
    { id: 'c1', title: 'Um', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 2, queued: [] },
    { id: 'c2', title: 'Dois', cwd: 'C:\\p', busy: false, connected: true, updatedAt: 1, queued: [] }
  ]
}

/** Deixa as promessas (fetch → json → estado) andarem sem disparar os timers longos. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

describe('RemoteClient', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    saveConfig({ base: 'http://pc:8765', token: 'tok', lan: '' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('abre no pareamento salvo, sem POST /api/pair (auto-conexão nunca toma o lugar de outro celular)', async () => {
    const calls: string[] = []
    mockFetch((u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      return { status: 200, body: { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    expect(client.state.screen).toBe('main')
    expect(calls).not.toContain('POST /api/pair')
    expect(calls).toContain('GET /api/history')
    expect(FakeEventSource.last?.url).toContain('/api/events?token=tok')
  })

  it('as tarefas do /api/state vão para o estado; PC antigo (sem o campo) zera a lista', async () => {
    let comTarefas = true
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: comTarefas ? { ...STATE, tarefas: [{ id: 't1', convId: 'c1' }] } : STATE }
      return { status: 200, body: { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    expect(client.state.tarefas.map((t) => t.id)).toEqual(['t1'])
    comTarefas = false
    await client.fetchState()
    expect(client.state.tarefas).toEqual([])
  })

  it('409 de outro celular → tela própria; "Usar este celular" faz POST /api/pair', async () => {
    let paired = false
    const calls: string[] = []
    mockFetch((u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${u.pathname}`)
      if (u.pathname === '/api/pair') {
        paired = true
        return { status: 200, body: { ok: true } }
      }
      if (!paired) return { status: 409, body: { error: 'another-device', pairedName: 'Galaxy do vizinho' } }
      return { status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    expect(client.state.screen).toBe('blocked')
    expect(client.state.blockedName).toBe('Galaxy do vizinho')
    client.takeover()
    await flush()
    expect(calls).toContain('POST /api/pair')
    expect(client.state.screen).toBe('main')
  })

  it('PC fora do ar: continua tentando com o motivo legível, sem apagar o pareamento', async () => {
    mockFetch(() => ({ status: 503, body: { error: 'pc offline' } }))
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    expect(client.state.screen).toBe('pairing')
    expect(client.state.pairingDetail).toMatch(/não está conectado/)
    expect(localStorage.getItem('agent-remote-config')).toContain('tok')
  })

  it('historyReq: trocar rápido de conversa — só a resposta mais recente vale', async () => {
    const pending: Record<string, (v: { status: number; body: unknown }) => void> = {}
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      const conv = u.searchParams.get('conv')!
      return new Promise((resolve) => (pending[conv] = resolve))
    })
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    client.selectConv('c1')
    client.selectConv('c2')
    pending.c2({ status: 200, body: { messages: [{ kind: 'user', id: 'm2', text: 'dois' }] } })
    await flush()
    pending.c1({ status: 200, body: { messages: [{ kind: 'user', id: 'm1', text: 'um' }] } })
    await flush()
    expect(client.state.convId).toBe('c2')
    expect(client.state.messages.map((m) => m.id)).toEqual(['m2'])
    expect(client.state.historyLoading).toBe(false)
  })

  it('histórico em páginas: as últimas 50 com hasOlder; "carregar anteriores" pede before= e põe na frente', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({ kind: 'user', id: `m${i}`, text: `msg ${i}` }))
    const calls: string[] = []
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      calls.push(u.pathname + '?' + [...u.searchParams].filter(([k]) => k !== 'token' && k !== 'dev' && k !== 'devname').map(([k, v]) => `${k}=${v}`).join('&'))
      const limit = Number(u.searchParams.get('limit') ?? 50)
      const before = u.searchParams.get('before')
      const end = before ? all.findIndex((m) => m.id === before) : all.length
      const start = Math.max(0, end - limit)
      return { status: 200, body: { messages: all.slice(start, end), hasOlder: start > 0 } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    expect(calls).toEqual(['/api/history?conv=c1&limit=50'])
    expect(client.state.messages).toHaveLength(50)
    expect(client.state.messages[0].id).toBe('m70')
    expect(client.state.hasOlder).toBe(true)
    await client.loadOlder()
    expect(calls[1]).toBe('/api/history?conv=c1&limit=50&before=m70')
    expect(client.state.messages).toHaveLength(100)
    expect(client.state.messages[0].id).toBe('m20')
    expect(client.state).toMatchObject({ hasOlder: true, olderLoading: false })
    await client.loadOlder()
    expect(client.state.messages).toHaveLength(120)
    expect(client.state.hasOlder).toBe(false)
    await client.loadOlder() // sem mais antigas: nada pedido
    expect(calls).toHaveLength(3)
    // Ressincronização em silêncio: pede o tanto que já está na tela (até 200), não só 50.
    await client.loadHistory('c1', true)
    expect(calls[3]).toBe('/api/history?conv=c1&limit=120')
    expect(client.state.messages).toHaveLength(120)
  })

  it('histórico leve: ao abrir, loadDetails pede /api/history-details uma vez por id e troca a versão cortada; a ressincronização mantém o detalhe', async () => {
    const big = 'z'.repeat(3000)
    const light = [
      { kind: 'user', id: 'u1', text: 'faz' },
      { kind: 'tool-use', id: 't1', name: 'Write', input: { file_path: 'a.ts', content: 'zzz…' }, parentToolUseId: null, result: { isError: false, text: 'c…' }, light: true },
      { kind: 'thinking', id: 'th', text: 'pens…', light: true }
    ]
    const full: Record<string, unknown> = {
      t1: { kind: 'tool-use', id: 't1', name: 'Write', input: { file_path: 'a.ts', content: big }, parentToolUseId: null, result: { isError: false, text: big } },
      th: { kind: 'thinking', id: 'th', text: big }
    }
    const detailCalls: string[] = []
    let pending: ((v: { status: number; body: unknown }) => void) | null = null
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      if (u.pathname === '/api/history-details') {
        const ids = (u.searchParams.get('ids') ?? '').split(',')
        detailCalls.push(ids.join(','))
        return new Promise((resolve) => (pending = () => resolve({ status: 200, body: { messages: ids.map((id) => full[id]).filter(Boolean) } })))
      }
      return { status: 200, body: { messages: light, hasOlder: false } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    expect(client.state.messages[1]).toMatchObject({ light: true })
    const p1 = client.loadDetails(['t1', 'th'])
    const p2 = client.loadDetails(['t1']) // em voo: não pede de novo
    await flush()
    expect(detailCalls).toEqual(['t1,th'])
    pending!({ status: 200, body: {} })
    await Promise.all([p1, p2])
    expect(client.state.messages[1]).toMatchObject({ light: false, input: { content: big }, result: { text: big } })
    expect(client.state.messages[2]).toMatchObject({ light: false, text: big })
    await client.loadDetails(['t1']) // já inteira: nada pedido
    expect(detailCalls).toHaveLength(1)
    await client.loadHistory('c1', true) // a lista leve de novo não apaga o detalhe já carregado
    expect(client.state.messages[1]).toMatchObject({ light: false, input: { content: big } })
  })

  it('loadDetails falhou: o id vai para detailsFailed e a próxima tentativa pede de novo', async () => {
    const light = [{ kind: 'tool-use', id: 't1', name: 'Read', input: {}, parentToolUseId: null, light: true }]
    let fail = true
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      if (u.pathname === '/api/history-details') return fail ? { status: 503, body: { error: 'x' } } : { status: 200, body: { messages: [{ ...light[0], light: undefined, input: { file_path: 'a' } }] } }
      return { status: 200, body: { messages: light } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    await expect(client.loadDetails(['t1'])).rejects.toBeTruthy()
    expect(client.state.detailsFailed.has('t1')).toBe(true)
    fail = false
    await client.loadDetails(['t1'])
    expect(client.state.detailsFailed.has('t1')).toBe(false)
    expect(client.state.messages[0]).toMatchObject({ light: false, input: { file_path: 'a' } })
  })

  it('mapa de perguntas: a janela em volta de uma pergunta fora da tela traz hasOlder/hasNewer; "ir para o final" recarrega as últimas', async () => {
    const all = Array.from({ length: 100 }, (_, i) => ({ kind: 'user', id: `m${i}`, text: `msg ${i}` }))
    mockFetch((u) => {
      if (u.pathname === '/api/state') return { status: 200, body: STATE }
      if (u.pathname === '/api/history-window') {
        const c = all.findIndex((m) => m.id === u.searchParams.get('message'))
        return { status: 200, body: { messages: all.slice(c - 12, c + 18), targetId: u.searchParams.get('message'), hasOlder: true, hasNewer: true } }
      }
      return { status: 200, body: { messages: all.slice(-50), hasOlder: true } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    await client.goToMessage('m90') // já na tela: só rola
    expect(client.state.scrollToMsg).toBe('m90')
    expect(client.state.hasNewer).toBe(false)
    await client.goToMessage('m30')
    expect(client.state.messages.some((m) => m.id === 'm30')).toBe(true)
    expect(client.state).toMatchObject({ scrollToMsg: 'm30', hasOlder: true, hasNewer: true })
    await client.loadHistory('c1', true)
    expect(client.state.messages[0].id).toBe('m50')
    expect(client.state.hasNewer).toBe(false)
  })

  it('evento ao vivo da conversa aberta entra no feed; o fim do turno libera a conversa', async () => {
    mockFetch((u) => ({ status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }))
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event: { kind: 'assistant-text', id: 'a1', text: 'oi', final: false } }) })
    expect(client.state.messages).toHaveLength(1)
    expect(client.current()?.busy).toBe(true)
    es.onmessage?.({ data: JSON.stringify({ convId: 'c1', event: { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 } }) })
    expect(client.current()?.busy).toBe(false)
    // Avisos do escritório (fase 2) não mexem no chat.
    es.onmessage?.({ data: JSON.stringify({ convId: 'office', event: { kind: 'office-call', id: 'x' } }) })
    expect(client.state.messages).toHaveLength(1)
  })

  it('modelo/esforço com a conversa ocupada: o POST sai, e um retrato velho não desfaz a escolha', async () => {
    const busy = { conversations: [{ ...STATE.conversations[0], busy: true, model: 'opus', effort: 'high' }, STATE.conversations[1]] }
    let echo = false
    const posts: unknown[] = []
    mockFetch((u, init) => {
      if (u.pathname === '/api/set-model') {
        posts.push(JSON.parse(String(init?.body)))
        return { status: 200, body: { ok: true } }
      }
      if (u.pathname === '/api/state') {
        // O 1º retrato depois da troca ainda é o velho; o seguinte já traz o eco do PC.
        const c = { ...busy.conversations[0], effort: echo ? 'max' : 'high' }
        echo = true
        return { status: 200, body: { conversations: [c, busy.conversations[1]] } }
      }
      return { status: 200, body: { messages: [] } }
    })
    const client = new RemoteClient({ pickInitialConv: () => 'c1' })
    client.start()
    await flush()
    echo = false
    client.setModel({ effort: 'max' })
    expect(client.current()?.effort).toBe('max')
    await flush()
    expect(posts).toEqual([{ convId: 'c1', effort: 'max' }])
    expect(client.current()?.effort).toBe('max')
    await client.fetchState()
    expect(client.current()?.effort).toBe('max')
  })

  it('handoff-aviso da ponte vira toast (com o nome da conversa) e não mexe no chat', async () => {
    mockFetch((u) => ({ status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }))
    const notify = vi.fn()
    const client = new RemoteClient({ pickInitialConv: () => 'c1', notify })
    client.start()
    await flush()
    const es = FakeEventSource.last!
    const send = (event: unknown): void => es.onmessage?.({ data: JSON.stringify({ convId: 'office', event }) })
    send({ kind: 'handoff-aviso', convId: 'c2', tipo: 'decisao', texto: 'Decidido sozinho: Zod (recomendada) — pergunta: Lib', at: 1 })
    send({ kind: 'handoff-aviso', convId: 'c1', tipo: 'fila', texto: 'Envio 2/3 retomado depois de parar por inatividade', at: 2 })
    send({ kind: 'handoff-aviso', convId: 'c1', tipo: 'bogus', texto: 'x', at: 3 })
    expect(notify.mock.calls).toEqual([
      ['Decidido sozinho em Dois: Zod (recomendada) — pergunta: Lib', 'aviso'],
      ['Envio 2/3 retomado depois de parar por inatividade', 'aviso']
    ])
    expect(client.state.messages).toHaveLength(0)
  })

  it('SSE caiu: faixa "reconectando…" e religa com backoff depois de conferir o estado', async () => {
    mockFetch((u) => ({ status: 200, body: u.pathname === '/api/state' ? STATE : { messages: [] } }))
    const client = new RemoteClient({ pickInitialConv: () => null })
    client.start()
    await flush()
    const first = FakeEventSource.last!
    first.onerror?.()
    expect(client.state.online).toBe(false)
    expect(client.state.reconnectText).toMatch(/reconectando/)
    await vi.advanceTimersByTimeAsync(900)
    await flush()
    expect(FakeEventSource.last).not.toBe(first)
    FakeEventSource.last!.onopen?.()
    expect(client.state.reconnectText).toBeNull()
    expect(client.state.online).toBe(true)
  })
})

describe('RemoteClient — filiais', () => {
  const A: PairConfig = { base: 'http://pc-a:8765', token: 'tA', lan: '' }
  const B: PairConfig = { base: 'http://pc-b:8765', token: 'tB', lan: '' }
  const C: PairConfig = { base: 'http://pc-c:8765', token: 'tC', lan: '' }
  let calls: string[] // "MÉTODO origem/rota" de cada chamada à ponte
  let reload: Mock<() => void>
  let notify: Mock<(text: string, tipo?: ToastTipo) => void>
  let pcName: string | undefined // o que o /api/state diz
  let conflict: string // a origem que responde 409 (outro celular pareado)
  let down: string // a origem que responde 503 (PC fora do ar)

  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    calls = []
    reload = vi.fn()
    notify = vi.fn()
    pcName = undefined
    conflict = ''
    down = ''
    mockFetch((u, init) => {
      calls.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`)
      if (u.pathname === '/api/pair') return { status: 200, body: { ok: true } }
      if (u.origin === down) return { status: 503, body: { error: 'pc offline' } }
      if (u.origin === conflict) return { status: 409, body: { error: 'another-device', pairedName: 'Galaxy do vizinho' } }
      return { status: 200, body: u.pathname === '/api/state' ? { ...STATE, pcName } : { messages: [] } }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Salva as filiais pela API do pcs.ts (usadas em 100, 200, …) e ativa a `active`-ésima, a mais recente (1000). */
  const save = (cfgs: PairConfig[], active = 0): SavedPc[] => {
    const pcs = cfgs.map((cfg, i) => upsertPc(cfg, (i + 1) * 100).pc)
    setActivePc(pcs[active].id, 1000)
    return pcs
  }
  /** Uma carga da página: um cliente novo que abre o app e conecta (ou para na tela que o PC ditar). */
  const load = async (): Promise<RemoteClient> => {
    const client = new RemoteClient({ pickInitialConv: () => null, reload, notify })
    client.start()
    await flush()
    return client
  }
  const pairs = (): string[] => calls.filter((c) => c.startsWith('POST') && c.endsWith('/api/pair'))

  it('abre na filial ativa (a última usada): sem POST /api/pair e sem avisos', async () => {
    save([A, B], 1)
    const page = await load()
    expect(page.state).toMatchObject({ screen: 'main', base: B.base, token: 'tB' })
    expect(calls).toContain('GET http://pc-b:8765/api/state')
    expect(calls.filter((c) => c.includes('pc-a'))).toEqual([])
    expect(pairs()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  it('adicionar por QR: ativa e recarrega; o sinal de uso único faz só a 1ª carga seguinte parear (POST /api/pair)', async () => {
    save([A])
    const page = await load()
    page.addPc(B)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadPcs().pcs.map((p) => p.token)).toEqual(['tA', 'tB'])
    expect(activePc(loadPcs())?.token).toBe('tB')
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual(B) // o espelho do app antigo
    expect(pairs()).toEqual([]) // o POST só acontece na carga seguinte
    expect((await load()).state).toMatchObject({ screen: 'main', base: B.base })
    expect(pairs()).toEqual(['POST http://pc-b:8765/api/pair'])
    await load()
    expect(pairs()).toHaveLength(1) // a 3ª carga já não pareia
  })

  it('addPc ignora QR sem endereço ou sem token', async () => {
    save([A])
    const page = await load()
    page.addPc({ base: '', token: 'tX', lan: '' })
    page.addPc({ base: 'http://pc-x:8765', token: '', lan: '' })
    expect(reload).not.toHaveBeenCalled()
    expect(loadPcs().pcs).toHaveLength(1)
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('QR de filial já salva não duplica: atualiza a lan e avisa depois do reload', async () => {
    save([A, B])
    const page = await load()
    page.addPc({ ...A, lan: '10.0.0.9:8765' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadPcs().pcs.map((p) => [p.token, p.lan])).toEqual([['tA', '10.0.0.9:8765'], ['tB', '']])
    await load()
    expect(notify.mock.calls).toEqual([['Esta filial já estava salva', 'aviso'], ['Filial PC 1 conectada', 'sucesso']])
  })

  it('trocar: grava a nova ativa e recarrega; a carga seguinte conecta nela sem POST /api/pair e avisa', async () => {
    const [, b] = save([A, B])
    renamePc(b.id, 'Casa')
    vi.setSystemTime(9_000)
    const page = await load()
    page.switchPc('nao-existe')
    expect(reload).not.toHaveBeenCalled()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
    page.switchPc(b.id)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(activePc(loadPcs())).toMatchObject({ id: b.id, lastUsedAt: 9_000 })
    expect(notify).not.toHaveBeenCalled()
    expect((await load()).state).toMatchObject({ screen: 'main', token: 'tB' })
    expect(pairs()).toEqual([])
    expect(notify.mock.calls).toEqual([['Filial Casa conectada', 'sucesso']])
  })

  it('os avisos esperam a 1ª conexão bem-sucedida da carga e saem uma vez só', async () => {
    const [, b] = save([A, B])
    const page = await load()
    page.switchPc(b.id)
    down = B.base
    const next = await load()
    expect(next.state.screen).toBe('pairing') // PC fora do ar: continua tentando, sem avisar
    expect(notify).not.toHaveBeenCalled()
    down = ''
    await vi.advanceTimersByTimeAsync(1100) // o backoff de 1 s
    await flush()
    expect(next.state.screen).toBe('main')
    expect(notify.mock.calls).toEqual([['Filial PC 2 conectada', 'sucesso']])
    conflict = B.base
    await next.fetchState().catch(() => undefined) // outro celular tomou o lugar…
    expect(next.state.screen).toBe('blocked')
    conflict = ''
    next.takeover() // …e este o retoma: conectou de novo, mas já avisou
    await flush()
    expect(next.state.screen).toBe('main')
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('esquecer a ativa: vai para a usada mais recentemente, recarrega e avisa depois do reload', async () => {
    const [a, b, c] = save([A, B, C], 1) // B ativa (1000); C (300) é mais recente que A (100)
    renamePc(c.id, 'Casa')
    const page = await load()
    page.forgetPc(b.id)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadPcs()).toMatchObject({ activeId: c.id, pcs: [{ id: a.id }, { id: c.id }] })
    expect(notify).not.toHaveBeenCalled() // o aviso sai depois do reload
    await load()
    expect(notify.mock.calls).toEqual([['Filial PC 2 esquecida', 'aviso'], ['Filial Casa conectada', 'sucesso']])
  })

  it('esquecer a última: tela do QR, sem pareamento salvo e sem reload', async () => {
    const [a] = save([A])
    const page = await load()
    page.forgetPc(a.id)
    expect(page.state).toMatchObject({ screen: 'pair', base: '', token: '' })
    expect(loadPcs().pcs).toEqual([])
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    expect(notify.mock.calls).toEqual([['Filial PC 1 esquecida', 'aviso']])
  })

  it('esquecer a última com o /api/state em voo: a resposta tardia não "conecta" a filial esquecida', async () => {
    const [a] = save([A])
    let answer = (): void => {} // solta o /api/state que ficou em voo
    mockFetch((u) => {
      if (u.pathname !== '/api/state') return { status: 200, body: { messages: [] } }
      return new Promise((resolve) => (answer = () => resolve({ status: 200, body: STATE })))
    })
    const page = await load()
    expect(page.state.screen).toBe('pairing') // Reconectando, com o /api/state ainda sem resposta
    FakeEventSource.last = null
    page.forgetPc(a.id) // o confirm segurou o JS; era a última: tela do QR
    expect(page.state.screen).toBe('pair')
    answer() // só agora o PC responde 200
    await flush()
    expect(page.state).toMatchObject({ screen: 'pair', base: '', token: '' }) // continua na tela do QR, não vai para o chat
    expect(FakeEventSource.last).toBeNull() // sem SSE novo
    expect(notify.mock.calls).toEqual([['Filial PC 1 esquecida', 'aviso']]) // e sem aviso de "conectada"
  })

  it('esquecer uma que não é a ativa só a remove e avisa; esquecer de novo não faz nada', async () => {
    const [a, b] = save([A, B])
    const page = await load()
    page.forgetPc(b.id)
    page.forgetPc(b.id)
    expect(reload).not.toHaveBeenCalled()
    expect(page.state.screen).toBe('main')
    expect(loadPcs().pcs.map((p) => p.id)).toEqual([a.id])
    expect(notify.mock.calls).toEqual([['Filial PC 2 esquecida', 'aviso']])
  })

  it('"Outro celular pareado" → Cancelar vai para outra filial salva, sem apagar a bloqueada', async () => {
    const [a, b] = save([A, B])
    conflict = A.base
    const page = await load()
    expect(page.state.screen).toBe('blocked')
    page.leaveBlocked()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(loadPcs()).toMatchObject({ activeId: b.id, pcs: [{ id: a.id }, { id: b.id }] })
  })

  it('"Outro celular pareado" → Cancelar sem outra filial: tela do QR, e a bloqueada continua salva e espelhada', async () => {
    save([A])
    conflict = A.base
    const page = await load()
    page.leaveBlocked()
    expect(page.state.screen).toBe('pair')
    expect(reload).not.toHaveBeenCalled()
    expect(loadPcs().pcs).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(CONFIG_KEY)!)).toEqual(A)
    expect((await load()).state.screen).toBe('blocked') // ao reabrir o app, tenta esta de novo
  })

  it('nome padrão: o pcName do /api/state nomeia a filial nova e nunca sobrescreve um nome editado', async () => {
    save([A])
    const page = await load()
    pcName = 'Matheus-2D'
    page.addPc(B)
    await load()
    expect(loadPcs().pcs.map((p) => p.nome)).toEqual([null, 'Matheus-2D']) // só a conectada (escopo por token)
    expect(notify).toHaveBeenLastCalledWith('Filial Matheus-2D conectada', 'sucesso')
    renamePc(activePc(loadPcs())!.id, 'Casa')
    pcName = 'Outro'
    await load()
    expect(activePc(loadPcs())?.nome).toBe('Casa')
  })

  const stale: Array<[string, () => void]> = [
    ['de outra filial', () => setPendingSwitch({ pcId: 'pc-outra', explicit: true, notices: [{ tipo: 'aviso', text: 'velho' }] })],
    ['corrompido', () => localStorage.setItem(PENDING_KEY, '{nope')]
  ]
  it.each(stale)('sinal %s: ignorado e apagado — sem POST /api/pair e sem avisos', async (_nome, put) => {
    save([A, B], 1)
    put()
    expect((await load()).state.screen).toBe('main')
    expect(pairs()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
    expect(localStorage.getItem(PENDING_KEY)).toBeNull()
  })

  it('última conversa por filial: selectConv grava na filial do token conectado, sem mexer na outra', async () => {
    save([A, B], 1)
    const page = await load()
    page.selectConv('c2')
    expect(loadPcs().pcs.map((p) => p.lastConv)).toEqual([null, 'c2'])
  })

  it('navegador (/app/?token=): sem filial salva conecta como antes, sem POST e sem gravar nada; esquecer volta ao QR', async () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'relay.x', search: '?token=tW' })
    const page = await load()
    expect(page.state).toMatchObject({ screen: 'main', base: 'https://relay.x', token: 'tW' })
    expect(pairs()).toEqual([])
    expect(loadPcs().pcs).toEqual([])
    page.forgetPc(null)
    expect(page.state).toMatchObject({ screen: 'pair', base: '', token: '' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('o sinal salvo é fronteira: lido uma vez só, formato errado vira null e item inválido some', () => {
    const take = (v: unknown): ReturnType<typeof takePendingSwitch> => {
      localStorage.setItem(PENDING_KEY, typeof v === 'string' ? v : JSON.stringify(v))
      const got = takePendingSwitch()
      expect(localStorage.getItem(PENDING_KEY)).toBeNull() // sempre apagado
      return got
    }
    const ok = { tipo: 'sucesso', text: 'ok' }
    setPendingSwitch({ pcId: 'p', explicit: true, notices: [{ tipo: 'erro', text: 'x' }] })
    expect(takePendingSwitch()).toEqual({ pcId: 'p', explicit: true, notices: [{ tipo: 'erro', text: 'x' }] })
    expect(takePendingSwitch()).toBeNull() // uso único
    expect(take({ pcId: 'p', explicit: 'true', notices: [{ tipo: 'x', text: 'a' }, { tipo: 'aviso', text: '' }, 7, null, ok] })).toEqual({ pcId: 'p', explicit: false, notices: [ok] })
    expect(take({ pcId: 'p' })).toEqual({ pcId: 'p', explicit: false, notices: [] })
    for (const bad of ['{nope', 'null', '[]', '"s"', '7', { pcId: '' }, { pcId: 7 }, { explicit: true }]) expect(take(bad)).toBeNull()
  })
})
