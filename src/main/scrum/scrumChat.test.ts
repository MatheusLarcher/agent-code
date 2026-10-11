import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ScrumChatMessage, ScrumDecisao } from '../../shared/scrumPanel'
import { SCRUM_CONTEST_ANSWER, SCRUM_NO_ANSWER, ScrumChatService, scrumChatPrompt, type ScrumChatDeps } from './scrumChatService'
import { ScrumChatStore, parseScrumChat } from './scrumChatStore'
import { decideDeclaration, type ScrumIpcDeps } from './scrumIpc'

const AT = '2026-10-11T12:00:00.000Z'

function d(over: Partial<ScrumDecisao> = {}): ScrumDecisao {
  return {
    id: 'corte-1',
    at: AT,
    tipo: 'parou',
    convId: 'conv-1',
    conversationTitle: 'Checkout',
    envioId: 'env-1',
    entregaId: 'ent-1',
    etapaId: 'visual',
    etapaN: 4,
    projectCwd: 'C:/proj/loja',
    marco: 300,
    veredito: 'parar',
    tipoDesvio: 'laco-de-teste',
    motivo: 'rodou o mesmo teste 9 vezes',
    cobranca: null,
    tempoAtivoMs: 62 * 60_000,
    prazoMin: 20,
    declaradoMin: null,
    decorridoMs: null,
    rota: 'claude-sonnet-5-5',
    durationMs: 10,
    ...over
  }
}

function msg(i: number): ScrumChatMessage {
  return { id: `m-${i}`, at: AT, role: i % 2 ? 'sm' : 'usuario', text: `mensagem ${i}`, sobre: null, projectCwd: null }
}

describe('ScrumChatStore — a conversa guardada inteira', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrum-chat-'))
    file = join(dir, 'sub', 'scrum-chat.jsonl')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('mais de 1000 mensagens sem corte, paginadas a partir do fim', async () => {
    const store = new ScrumChatStore(async () => file)
    const all = Array.from({ length: 1205 }, (_, i) => msg(i))
    for (let i = 0; i < all.length; i += 100) await store.append(...all.slice(i, i + 100))
    expect((await store.all()).length).toBe(1205)
    const last = await store.page(0, 200)
    expect(last.messages.map((m) => m.id)).toEqual(all.slice(1005).map((m) => m.id))
    expect(last.hasMore).toBe(true)
    const first = await store.page(1200, 200)
    expect(first.messages.map((m) => m.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4'])
    expect(first.hasMore).toBe(false)
  })

  it('escritas em fila: duas seguidas sem atropelo, na ordem', async () => {
    const store = new ScrumChatStore(async () => file)
    await Promise.all([store.append(msg(1), msg(2)), store.append(msg(3)), store.append(msg(4), msg(5))])
    expect((await store.all()).map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5'])
  })

  it('arquivo ausente = vazia; linha quebrada é pulada; sem destino, append lança', async () => {
    expect(await new ScrumChatStore(async () => join(dir, 'nada.jsonl')).all()).toEqual([])
    await writeFile(join(dir, 'x.jsonl'), `${JSON.stringify(msg(1))}\n{"id":"cort\n[1]\n${JSON.stringify(msg(2))}\n`, 'utf8')
    expect((await new ScrumChatStore(async () => join(dir, 'x.jsonl')).all()).map((m) => m.id)).toEqual(['m-1', 'm-2'])
    expect(parseScrumChat('')).toEqual([])
    await expect(new ScrumChatStore(async () => null).append(msg(1))).rejects.toThrow()
  })
})

function memoryStore(): ScrumChatDeps['store'] & { messages: ScrumChatMessage[] } {
  const messages: ScrumChatMessage[] = []
  return {
    messages,
    append: async (...m) => {
      messages.push(...m)
    },
    all: async () => [...messages]
  }
}

function service(over: Partial<ScrumChatDeps> = {}) {
  const store = memoryStore()
  const logged: ScrumDecisao[] = []
  const prompts: string[] = []
  let n = 0
  const deps: ScrumChatDeps = {
    store,
    history: async () => [d(), d({ id: 'resp', tipo: 'resposta', refId: 'corte-1', texto: 'eu estava quase lá' })],
    log: (x) => logged.push(x),
    config: () => ({ enabled: true, model: 'claude-sonnet-5-5', podeParar: true }),
    ask: async (prompt) => {
      prompts.push(prompt)
      return 'Parei porque o mesmo teste rodou 9 vezes.'
    },
    newId: () => `id-${++n}`,
    now: () => Date.parse(AT),
    ...over
  }
  return { svc: new ScrumChatService(deps), store, logged, prompts }
}

describe('ScrumChatService — a conversa com o SM', () => {
  it('Questionar prende `sobre`: a pergunta leva a decisão e o que está ligado a ela', async () => {
    const { svc, store, prompts, logged } = service()
    const r = await svc.ask({ text: 'Por que você parou?', sobre: 'corte-1' })
    expect(r.ok && r.messages.map((m) => [m.role, m.sobre, m.projectCwd])).toEqual([
      ['usuario', 'corte-1', 'C:/proj/loja'],
      ['sm', 'corte-1', 'C:/proj/loja']
    ])
    expect(r.ok && r.contestado).toBe(false)
    expect(prompts[0]).toContain('A pergunta é sobre esta decisão:')
    expect(prompts[0]).toContain('rodou o mesmo teste 9 vezes')
    expect(prompts[0]).toContain('eu estava quase lá')
    expect(prompts[0]).toContain('NÃO corta, NÃO retoma')
    expect(store.messages).toHaveLength(2)
    expect(logged).toEqual([])
  })

  it('"Marcar como corte errado" grava `contestado` com a frase do usuário, sem chamar o modelo', async () => {
    const { svc, logged, prompts } = service()
    const r = await svc.ask({ text: 'ele estava quase terminando', sobre: 'corte-1', contestar: true })
    expect(r.ok && r.contestado).toBe(true)
    expect(r.ok && r.messages[1].text).toBe(SCRUM_CONTEST_ANSWER)
    expect(prompts).toEqual([])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ tipo: 'contestado', refId: 'corte-1', texto: 'ele estava quase terminando', envioId: 'env-1', convId: 'conv-1' })
  })

  it('campo vazio no corte errado vale "corte errado"; "corte errado" no texto também contesta', async () => {
    const a = service()
    await a.svc.ask({ text: '  ', sobre: 'corte-1', contestar: true })
    expect(a.logged[0].texto).toBe('corte errado')
    const b = service()
    await b.svc.ask({ text: 'isso foi um Corte Errado', sobre: 'corte-1' })
    expect(b.logged.map((x) => x.tipo)).toEqual(['contestado'])
  })

  it('contestar sem decisão é recusado; pergunta vazia também', async () => {
    const { svc, store } = service()
    expect(await svc.ask({ text: 'x', sobre: null, contestar: true })).toMatchObject({ ok: false })
    expect(await svc.ask({ text: '   ', sobre: null })).toMatchObject({ ok: false })
    expect(store.messages).toEqual([])
  })

  it('duas perguntas seguidas não se atropelam: usuário, SM, usuário, SM', async () => {
    let calls = 0
    const { svc, store } = service({
      ask: async () => {
        calls += 1
        const mine = calls
        await new Promise((r) => setTimeout(r, mine === 1 ? 30 : 1))
        return `resposta ${mine}`
      }
    })
    const [a, b] = await Promise.all([svc.ask({ text: 'primeira', sobre: null }), svc.ask({ text: 'segunda', sobre: null })])
    expect(a.ok && b.ok).toBe(true)
    expect(store.messages.map((m) => m.text)).toEqual(['primeira', 'resposta 1', 'segunda', 'resposta 2'])
  })

  it('modelo mudo ou lento: a resposta é o aviso de falha (a pergunta fica guardada)', async () => {
    const { svc, store } = service({ ask: () => new Promise(() => undefined), timeoutMs: 10 })
    const r = await svc.ask({ text: 'oi', sobre: null })
    expect(r.ok && r.messages[1].text).toBe(SCRUM_NO_ANSWER)
    expect(store.messages.map((m) => m.role)).toEqual(['usuario', 'sm'])
  })

  it('o prompt sem decisão presa traz o diário recente e a conversa anterior', () => {
    const p = scrumChatPrompt({ question: 'e hoje?', sobre: null, ligadas: [], recentes: [d()], chat: [msg(0), msg(1)] })
    expect(p).not.toContain('A pergunta é sobre esta decisão')
    expect(p).toContain('id corte-1 · parou')
    expect(p).toContain('Usuário: mensagem 0')
    expect(p).toContain('Scrum Master: mensagem 1')
    expect(p).toContain('Pergunta do usuário: e hoje?')
  })
})

describe('decideDeclaration — Aprovar/Recusar a declaração acima do teto', () => {
  function deps(decided: boolean) {
    const logged: ScrumDecisao[] = []
    const ipc = {
      master: {
        pendingDeclarations: () => [],
        decideDeclaration: (envioId: string, entregaId: string, aprovar: boolean) =>
          decided ? { envioId, entregaId, pedidoMin: 90, validoMin: aprovar ? 90 : 60, motivo: 'build', at: 0, acimaDoTeto: true, decidida: aprovar ? 'aprovou' : 'recusou' } : null
      },
      log: (x: ScrumDecisao) => logged.push(x),
      now: () => Date.parse(AT)
    } as unknown as ScrumIpcDeps
    return { ipc, logged }
  }

  it('aprovar grava `aprovou` ligado à declaração', () => {
    const { ipc, logged } = deps(true)
    const declarou = d({ id: 'decl', tipo: 'declarou', declaradoMin: 60 })
    expect(decideDeclaration(ipc, [declarou], { envioId: 'env-1', entregaId: 'ent-1', aprovar: true })).toEqual({ ok: true })
    expect(logged[0]).toMatchObject({ tipo: 'aprovou', refId: 'decl', declaradoMin: 90, texto: null })
  })

  it('já decidida (ou o app reiniciou) = recusa explicada, nada gravado', () => {
    const { ipc, logged } = deps(false)
    expect(decideDeclaration(ipc, [], { envioId: 'env-1', entregaId: 'ent-1', aprovar: false })).toMatchObject({ ok: false })
    expect(logged).toEqual([])
  })
})

describe('arquivo real da conversa', () => {
  it('a pergunta e a resposta vão ao jsonl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scrum-chat-svc-'))
    try {
      const file = join(dir, 'scrum-chat.jsonl')
      const store = new ScrumChatStore(async () => file)
      const svc = new ScrumChatService({
        store,
        history: async () => [d()],
        log: () => undefined,
        config: () => ({ enabled: true, model: 'm', podeParar: false }),
        ask: async () => 'ok'
      })
      await svc.ask({ text: 'oi', sobre: null })
      expect(parseScrumChat(await readFile(file, 'utf8')).map((m) => [m.role, m.text])).toEqual([
        ['usuario', 'oi'],
        ['sm', 'ok']
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
