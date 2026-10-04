// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskFn } from '../centralDecider'
import type { VersionedConversationLike } from '../centralIndex'
import { NO_PROJECT, Q_CONVERSA, type CentralAskRequest } from '../centralPrompts'
import { buildHistory, cutTimes, userTimes, type ExportRows } from './history'
import { createMemoAsk, requestHash } from './memoAsk'
import { candidatesMarkdown, phaseACandidates, phaseASelection, scanFirstCalls, snippet, type Scanned } from './phaseA'
import { createReplay } from './replay'

// O harness da calibração com dados sintéticos: exclusões, horas, replay sem vazamento,
// gabarito, memoização do `ask` e a fase A. Nada de rede nem do histórico real.

const ROOT = 'C:\\local\\sandbox'
const A = 'C:\\work\\alpha'
const B = 'C:\\work\\beta'
const GONE = 'C:\\work\\gone'
const isSandbox = (cwd: string): boolean => cwd.toLowerCase().startsWith(`${ROOT.toLowerCase()}\\`)
const exists = (path: string): boolean => path !== GONE
const deps = { exists, isSandbox }

const user = (id: string, text: string, ts?: number, extra: Record<string, unknown> = {}) => ({
  kind: 'user',
  id,
  text,
  ...(ts === undefined ? {} : { ts }),
  ...extra
})
const answer = (text: string, ts: number) => ({ kind: 'assistant-text', id: `r${ts}`, text, answer: true, final: true, ts })
const edit = (file: string) => ({ kind: 'tool-use', id: `e:${file}`, name: 'Edit', input: { file_path: file }, parentToolUseId: null })

function row(id: string, payload: Record<string, unknown>): VersionedConversationLike {
  return { id, payload: { id, title: `T ${id}`, cwd: A, createdAt: 0, updatedAt: 0, messages: [], ...payload } }
}
const source = (rows: VersionedConversationLike[], malformed = 0): ExportRows => ({ rows, total: rows.length + malformed, malformed })

/** alpha (a1, a2, e uma criada no futuro), beta (b1) e o sandbox (s1). */
function sample() {
  return buildHistory(
    source([
      row('a1', {
        createdAt: 0,
        updatedAt: 460,
        messages: [
          user('a1-1', 'arruma o login', 100),
          edit(`${A}\\src\\login.tsx`),
          answer('login arrumado', 150),
          user('a1-2', 'o botão ainda torto', 400),
          edit(`${A}\\src\\button.tsx`),
          answer('botão ok', 450)
        ]
      }),
      row('b1', {
        cwd: B,
        createdAt: 200,
        updatedAt: 510,
        messages: [user('b1-1', 'api de pagamentos', 250), answer('feito', 260), user('b1-2', 'e o webhook?', 500)]
      }),
      row('a2', { createdAt: 350, updatedAt: 430, messages: [user('a2-1', 'gera o pdf', 360), answer('pdf pronto', 420)] }),
      row('late', { createdAt: 600, updatedAt: 700, messages: [user('late-1', 'do futuro', 650)] }),
      row('s1', { cwd: `${ROOT}\\x1`, createdAt: 10, updatedAt: 40, messages: [user('s1-1', 'cotação do dólar', 20), answer('5,40', 30)] })
    ]),
    deps
  )
}
const requestOf = (history: ReturnType<typeof sample>, id: string) => history.requests.find((r) => r.id === id)!

describe('histórico', () => {
  it('fica de fora o que o índice não oferece, contado por motivo', () => {
    const h = buildHistory(
      source(
        [
          row('ok', { createdAt: 5, updatedAt: 20, messages: [user('u1', 'oi', 10)] }),
          row('central', { mode: 'central' }),
          row('plan', { mode: 'planning', messages: [user('u2', 'x', 10)] }),
          row('del', { deletedAt: 123 }),
          row('nocwd', { cwd: '  ' }),
          row('gone', { cwd: GONE, messages: [user('u3', 'x', 10)] })
        ],
        1
      ),
      deps
    )
    expect(h.conversations.map((c) => c.id)).toEqual(['ok'])
    expect(h.stats.excluded).toEqual({ malformed: 1, deleted: 1, central: 1, planning: 1, 'empty-cwd': 1, 'folder-missing': 1 })
  })

  it('pedidos: sem cancelados nem vazios, hora interpolada, só anexos vira os nomes, cópia de conflito não repete', () => {
    const msgs = [
      user('u1', 'primeiro', 100),
      user('x', 'cancelado', 150, { canceled: true }),
      user('u2', 'sem hora'),
      user('u3', 'terceiro', 300),
      user('u4', '  ', 320, { files: [{ name: 'a.png', size: 1 }] }),
      user('u5', '', 330)
    ]
    const h = buildHistory(
      source([
        row('orig', { createdAt: 50, updatedAt: 400, messages: msgs }),
        row('copy', { createdAt: 50, updatedAt: 600, legacyConflictOf: 'orig', messages: [...msgs, user('u6', 'só na cópia', 500)] })
      ]),
      deps
    )
    const byConv = (id: string) => h.conversations.find((c) => c.id === id)!.requests
    expect(byConv('orig').map((r) => [r.id, r.t, r.interpolated, r.first, r.text])).toEqual([
      ['u1', 100, false, true, 'primeiro'],
      ['u2', 200, true, false, 'sem hora'],
      ['u3', 300, false, false, 'terceiro'],
      ['u4', 320, false, false, '[anexos: a.png]']
    ])
    expect(byConv('copy').map((r) => [r.id, r.first])).toEqual([['u6', false]])
    expect(h.stats).toMatchObject({ userMessages: 13, canceled: 2, withoutContent: 2, duplicates: 4, interpolated: 1, requests: 5 })
  })

  it('hora de corte: a da mensagem ou a da próxima com hora, sem voltar; interpolação entre vizinhos', () => {
    expect(cutTimes([{ kind: 'tool-use' }, { ts: 10 }, {}, { ts: 5 }, {}], 99)).toEqual([10, 10, 10, 10, 99])
    expect(userTimes([null, null, 40, null], 10, 100).map((x) => x.t)).toEqual([20, 30, 40, 70])
  })
})

describe('replay no tempo', () => {
  it('o índice em t só tem o passado: conversa futura, mensagem futura e conversa sem pedido ficam de fora', () => {
    const h = sample()
    const replay = createReplay(h, { sandboxRoot: ROOT, ...deps })
    const { index } = replay.at(requestOf(h, 'a1-2'))
    expect([...index.byId.keys()].sort()).toEqual(['a1', 'a2', 'b1', 's1'])
    expect(index.byId.get('a1')).toMatchObject({ files: ['src/login.tsx'], lastRequests: [], answerStart: 'login arrumado', updatedAt: 150 })
    expect(index.byId.get('a2')).toMatchObject({ answerStart: '' })
    expect(index.byId.get('b1')?.lastRequests).toEqual([])
    expect(replay.indexAt(355).byId.has('a2')).toBe(false)
  })

  it('recentes: os 5 últimos destinos antes de t, com o último pedido e a resposta como estava em t', () => {
    const h = sample()
    const replay = createReplay(h, { sandboxRoot: ROOT, ...deps })
    expect(replay.recentAt(requestOf(h, 'a1-2')).map((r) => [r.convId, r.request, r.replyStart])).toEqual([
      ['a2', 'gera o pdf', ''],
      ['b1', 'api de pagamentos', 'feito'],
      ['a1', 'arruma o login', 'login arrumado'],
      ['s1', 'cotação do dólar', '5,40']
    ])
    expect(replay.recentAt(requestOf(h, 'b1-2'))[0]).toMatchObject({ convId: 'a1', replyStart: 'botão ok' })
  })

  it('gabarito: 1ª mensagem = nova (ou sandbox); as seguintes = continua se está nos recentes, senão conversa antiga', () => {
    const h = sample()
    const replay = createReplay(h, { sandboxRoot: ROOT, ...deps })
    expect(replay.gold(requestOf(h, 'late-1'))).toEqual({ rule: 'nova', target: { kind: 'new-conversation', cwd: A, project: 'alpha' }, first: true })
    expect(replay.gold(requestOf(h, 's1-1'))).toEqual({ rule: 'sandbox', target: { kind: 'new-sandbox' }, first: true })
    expect(replay.gold(requestOf(h, 'a1-2'))).toMatchObject({ rule: 'continua', target: { kind: 'conversation', convId: 'a1' } })

    const others = [1, 2, 3, 4, 5].map((i) => row(`c${i}`, { createdAt: i * 100, updatedAt: i * 100 + 50, messages: [user(`c${i}-1`, `assunto ${i}`, i * 100 + 10)] }))
    const old = row('old', { createdAt: 0, updatedAt: 1000, messages: [user('o-1', 'começo', 10), user('o-2', 'voltando', 1000)] })
    const h2 = buildHistory(source([old, ...others]), deps)
    expect(createReplay(h2, { sandboxRoot: ROOT, ...deps }).gold(requestOf(h2, 'o-2')).rule).toBe('conversa-antiga')
  })
})

describe('ask memoizado', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('o mesmo pedido é pago uma vez; o cache em arquivo (sem o state) serve a rodada seguinte; falha não é guardada', async () => {
    dir = mkdtempSync(join(tmpdir(), 'central-calib-'))
    const file = join(dir, 'cache.jsonl')
    const request: CentralAskRequest = {
      state: { message: { text: 'texto do usuário' } },
      questions: { projeto: { type: 'choice', criteria: { p1: 'alpha', sem_projeto: 'nenhum' } } }
    }
    const reply = { projeto: { type: 'choice', choice: 'p1', confidence: 0.9, probabilities: { p1: 0.9, sem_projeto: 0.1 }, extra: 'x' } }
    const call = vi.fn(async () => ({ answers: reply, usage: { input_tokens: 10, output_tokens: 1 } }))
    const memo = createMemoAsk(call, file)
    const [a, b] = await Promise.all([memo.ask(request), memo.ask(request)])
    expect(a).toEqual({ projeto: { type: 'choice', choice: 'p1', confidence: 0.9, probabilities: { p1: 0.9, sem_projeto: 0.1 } } })
    expect(b).toEqual(a)
    expect(call).toHaveBeenCalledTimes(1)
    expect(memo.stats()).toMatchObject({ network: 1, ok: 1, hits: 1, inputTokens: 10, outputTokens: 1 })
    const cached = readFileSync(file, 'utf8')
    expect(cached).toContain(requestHash(request))
    expect(cached).not.toContain('texto do usuário')

    const next = createMemoAsk(call, file)
    expect(await next.ask(request)).toEqual(a)
    expect(call).toHaveBeenCalledTimes(1)
    expect(next.stats()).toMatchObject({ network: 0, hits: 1 })

    const other = join(dir, 'other.jsonl')
    const failing = createMemoAsk(vi.fn(async () => Promise.reject(new TypeError('caiu'))), other)
    expect(await failing.ask(request)).toBeNull()
    expect(await failing.ask(request)).toBeNull()
    expect(failing.stats()).toMatchObject({ network: 2, failed: 2, failures: { TypeError: 2 } })
    expect(existsSync(other)).toBe(false)
  })
})

describe('fase A', () => {
  it('escaneia as não-primeiras de projeto (a mais recente primeiro), só a 1ª chamada, e separa as sem_projeto', async () => {
    const h = sample()
    const replay = createReplay(h, { sandboxRoot: ROOT, ...deps })
    const selection = phaseASelection(h)
    expect(selection.map((r) => r.id)).toEqual(['b1-2', 'a1-2'])
    expect(phaseASelection(h, 1).map((r) => r.id)).toEqual(['b1-2'])

    const ask = vi.fn<AskFn>(async (request) => {
      const q = request.questions.projeto
      const keys = q?.type === 'choice' ? Object.keys(q.criteria) : []
      const text = (request.state as { message: { text: string } }).message.text
      const choice = text.includes('webhook') ? NO_PROJECT : 'p1'
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.1]))
      return { projeto: { type: 'choice', choice, confidence: 0.8, probabilities } }
    })
    const scanned = await scanFirstCalls(selection, h, replay, ask, { lang: 'en', concurrency: 2, ...deps })
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls.some(([request]) => Q_CONVERSA in request.questions)).toBe(false)
    expect(scanned[0]).toMatchObject({ status: 'ok', choice: NO_PROJECT, pNoProject: 0.8, ownOption: 'p2', pOwnProject: 0.1, project: 'beta' })
    expect(scanned[1]).toMatchObject({ status: 'ok', choice: 'p1', ownOption: 'p1', gold: { rule: 'continua' } })
    expect(phaseACandidates(scanned).map((s) => s.request.id)).toEqual(['b1-2'])
  })

  it('o arquivo de candidatas: ordenado pela probabilidade, trecho mascarado de até 160 caracteres, | escapado', () => {
    const s = snippet(`minha senha=hunter2222 e depois\n${'x'.repeat(300)}`)
    expect(s).toContain('[segredo]')
    expect(s).not.toContain('hunter')
    expect(s.length).toBeLessThanOrEqual(160)
    expect(s.endsWith('…')).toBe(true)

    const h = sample()
    const base = (id: string, p: number): Scanned => ({
      request: { ...requestOf(h, id), text: `pergunta | ${id}` },
      project: 'alpha',
      title: 'Título',
      gold: { rule: 'continua', target: { kind: 'new-sandbox' }, first: false },
      status: 'ok',
      choice: NO_PROJECT,
      pNoProject: p
    })
    const calls = { network: 2, ok: 2, failed: 0, hits: 0, failures: {}, inputTokens: 0, outputTokens: 0 }
    const md = candidatesMarkdown(phaseACandidates([base('a1-2', 0.6), base('b1-2', 0.9)]), {
      exportName: 'x.parquet',
      lang: 'en',
      budget: 1500,
      scanned: 2,
      status: { ok: 2, failed: 0, 'no-question': 0 },
      calls,
      generatedAt: new Date(0)
    })
    const rows = md.split('\n').filter((line) => /^\| \d+ \|/.test(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^\| 1 \| alpha \| Título \| .* \| pergunta \\\| b1-2 \| 0\.90 \|$/)
    expect(rows[1]).toContain('| 0.60 |')
    expect(md).toContain('Mensagens escaneadas: **2**')
  })
})
