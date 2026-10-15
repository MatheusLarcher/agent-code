// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po } from './po'
import {
  buildPoDigest,
  PO_MAX_SECTION_CHARS,
  PO_MESSAGES_SECTION,
  PO_PREVIOUS_REPLY_SECTION,
  PO_REPLY_SECTION,
  PO_USER_SECTION
} from './poPrompt'
import { defer, mergeDeferred } from './poQueue'
import { cutMiddle, formatTurnMessages, omittedNote, splitTurnText } from './poTurnText'

/**
 * O turno inteiro para o PO: a mensagem do usuário, as mensagens do agente ao
 * longo do turno e a resposta final, cada uma na sua seção — sem o corte de
 * 1.200/1.000 caracteres de antes. Só um teto de segurança, por seção, corta.
 */

describe('cutMiddle — o teto de segurança', () => {
  it('abaixo do teto, devolve o texto inteiro', () => {
    expect(cutMiddle('  abc  ', 10)).toBe('abc')
  })

  it('acima do teto, corta do MEIO com o aviso e fecha exatamente no teto', () => {
    const text = `INICIO${'x'.repeat(100_000)}FIM`
    const out = cutMiddle(text, PO_MAX_SECTION_CHARS)
    expect(out.length).toBe(PO_MAX_SECTION_CHARS)
    expect(out.startsWith('INICIO')).toBe(true)
    expect(out.endsWith('FIM')).toBe(true)
    const omitted = Number(/\[… (\d+) caracteres omitidos\]/.exec(out)?.[1])
    // O que saiu + o que ficou = o texto inteiro.
    expect(out.length - omittedNote(omitted).length - 2 + omitted).toBe(text.length)
  })
})

describe('splitTurnText — intermediárias e resposta final', () => {
  it('o último texto é a resposta final e não se repete nas intermediárias', () => {
    expect(splitTurnText(['vou olhar', 'achei', 'Pronto.'])).toEqual({ messages: ['vou olhar', 'achei'], reply: 'Pronto.' })
  })

  it('o texto do result tem preferência', () => {
    expect(splitTurnText(['vou olhar'], 'Resumo final')).toEqual({ messages: ['vou olhar'], reply: 'Resumo final' })
  })

  it('turno sem texto: sem resposta e sem mensagens', () => {
    expect(splitTurnText([], '')).toEqual({ messages: [], reply: null })
  })
})

describe('digest — as três seções do texto do turno', () => {
  const LONGO_USUARIO = `pedido: ${'detalhe do pedido '.repeat(800)}FIM-DO-PEDIDO`
  const LONGA_MSG = `investigando: ${'linha do log '.repeat(600)}FIM-DA-MSG`
  const LONGA_RESPOSTA = `Fiz A e B. ${'explicação '.repeat(1_500)}Falta C: o deploy na VPS.`

  const close = buildPoDigest({
    phase: 'close',
    userText: LONGO_USUARIO,
    cards: [],
    calls: [],
    agentMessages: ['Vou olhar o código.', LONGA_MSG],
    agentReply: LONGA_RESPOSTA
  })

  it('textos longos vão INTEIROS (bem acima do corte antigo de 1.200/1.000)', () => {
    expect(LONGO_USUARIO.length).toBeGreaterThan(10_000)
    expect(close).toContain(`${PO_USER_SECTION}\n${LONGO_USUARIO}\n`)
    expect(close).toContain(LONGA_MSG)
    expect(close.endsWith(`${PO_REPLY_SECTION}\n${LONGA_RESPOSTA}`)).toBe(true)
    expect(close).not.toContain('caracteres omitidos')
  })

  it('cada texto vem catalogado: usuário, mensagens em ordem, resposta final', () => {
    const user = close.indexOf(PO_USER_SECTION)
    const messages = close.indexOf(PO_MESSAGES_SECTION)
    const reply = close.indexOf(PO_REPLY_SECTION)
    expect(user).toBeGreaterThanOrEqual(0)
    expect(messages).toBeGreaterThan(user)
    expect(reply).toBeGreaterThan(messages)
    expect(close).toContain(`${PO_MESSAGES_SECTION}\n[mensagem 1]\nVou olhar o código.\n\n[mensagem 2]\n${LONGA_MSG}`)
  })

  it('a abertura não leva mensagens do turno, e a resposta vem rotulada como a do turno anterior', () => {
    const open = buildPoDigest({ phase: 'open', userText: 'pode fazer', cards: [], calls: [], agentMessages: ['x'], agentReply: 'Posso corrigir?' })
    expect(open).not.toContain(PO_MESSAGES_SECTION)
    expect(open).toContain(`${PO_PREVIOUS_REPLY_SECTION}\nPosso corrigir?`)
  })

  it('o teto de segurança corta do meio das intermediárias e nunca a resposta final', () => {
    const reply = `R-INICIO${'r'.repeat(150_000)}R-FIM`
    const digest = buildPoDigest({
      phase: 'close',
      userText: 'faz',
      cards: [],
      calls: [],
      agentMessages: [`M-INICIO${'m'.repeat(80_000)}`, `${'n'.repeat(80_000)}M-FIM`],
      agentReply: reply
    })
    const body = digest.split(`${PO_MESSAGES_SECTION}\n`)[1].split(`\n\n${PO_REPLY_SECTION}`)[0]
    expect(body.length).toBe(PO_MAX_SECTION_CHARS)
    expect(body).toMatch(/\n\[… \d+ caracteres omitidos\]\n/)
    expect(body.startsWith('[mensagem 1]\nM-INICIO')).toBe(true)
    expect(body.endsWith('M-FIM')).toBe(true)
    expect(digest.endsWith(`${PO_REPLY_SECTION}\n${reply}`)).toBe(true)
  })

  it('turnos adiados pelo cooldown entram em ordem, cada um com rótulo', () => {
    const text = formatTurnMessages(
      [
        { messages: ['olhando o um'], reply: 'Terminei o um.' },
        { messages: [], reply: 'Terminei o dois.' }
      ],
      ['olhando o três']
    )
    expect(text).toBe(
      [
        '[turno anterior 1 de 2, adiado pelo cooldown]',
        '[mensagem 1]\nolhando o um',
        '[resposta final daquele turno]\nTerminei o um.',
        '[turno anterior 2 de 2, adiado pelo cooldown]',
        '[resposta final daquele turno]\nTerminei o dois.',
        '[este turno]',
        '[mensagem 1]\nolhando o três'
      ].join('\n\n')
    )
  })
})

describe('fila — os turnos adiados levam o próprio texto', () => {
  const turn = (userText: string, messages: string[], reply: string | null) =>
    Object.freeze({ userText, cwd: 'C:/p', calls: [], messages, reply })

  it('a mescla põe o turno atual por último e os adiados em earlier, sem repetir a resposta final', () => {
    let queue = defer(null, turn('um', ['m1'], 'R1'))
    queue = defer(queue, turn('dois', [], 'R2'))
    const merged = mergeDeferred(queue, turn('três', ['m3'], 'R3'))
    expect(merged.reply).toBe('R3')
    expect(merged.messages).toEqual(['m3'])
    expect(merged.earlier).toEqual([
      { messages: ['m1'], reply: 'R1' },
      { messages: [], reply: 'R2' }
    ])
  })

  it('no flush (turno sintético) o último adiado é o atual', () => {
    let queue = defer(null, turn('um', ['m1'], 'R1'))
    queue = defer(queue, turn('dois', ['m2'], 'R2'))
    const merged = mergeDeferred(queue, Object.freeze({ userText: '', cwd: 'C:/p', calls: [] }))
    expect(merged.reply).toBe('R2')
    expect(merged.messages).toEqual(['m2'])
    expect(merged.earlier).toEqual([{ messages: ['m1'], reply: 'R1' }])
  })
})

// ---- O Po de ponta a ponta -------------------------------------------------

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'Pesquisar cadastro',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })

function fakeBoard(cards: BoardItem[]) {
  return {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => [...cards]),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => null),
    createPoItem: vi.fn(async () => card({ id: 'bi-novo' }))
  } as unknown as BoardService & { applyPo: ReturnType<typeof vi.fn> }
}

const isClose = (prompt: string): boolean => prompt.includes('AÇÕES DESTE TURNO')
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const text = (value: string, final = true): ChatEvent => ({ kind: 'assistant-text', id: 'a', text: value, final })

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Po — o fechamento recebe o turno completo', () => {
  it('leva a mensagem do usuário, as mensagens do turno e a resposta final DESTE turno, inteiras', async () => {
    const ask = vi.fn(async (prompt: string) => (isClose(prompt) ? 'PENDENTE bi-1 | a resposta diz que falta o deploy' : 'OK'))
    const board = fakeBoard([card()])
    const po = new Po({ config, board, ask, gateActive: async () => false })
    const pedido = `pesquisa o cadastro ${'com todos os detalhes '.repeat(200)}e me diz o que falta`
    const resposta = `Resultado: ${'item verificado; '.repeat(300)}Falta: o deploy na VPS.`

    po.noteUserMessage('conv-1', 'C:/p', pedido)
    po.observe('conv-1', text('ao vivo, não entra', false))
    po.observe('conv-1', text('Vou consultar a API.'))
    po.observe('conv-1', text(resposta))
    po.observe('conv-1', result)
    await flush()

    const close = ask.mock.calls.map((call) => String(call[0])).filter(isClose)
    expect(close).toHaveLength(1)
    expect(close[0]).toContain(`${PO_USER_SECTION}\n${pedido}\n`)
    expect(close[0]).toContain(`${PO_MESSAGES_SECTION}\n[mensagem 1]\nVou consultar a API.\n`)
    expect(close[0]).toContain(`${PO_REPLY_SECTION}\n${resposta}`)
    expect(close[0]).not.toContain('ao vivo, não entra')
    // A resposta final não aparece também como intermediária.
    expect(close[0].split(resposta)).toHaveLength(2)
    // O PENDENTE, decidido pela resposta final, chega ao quadro.
    expect(board.applyPo).toHaveBeenCalledWith(expect.objectContaining({ id: 'bi-1', eventNote: 'a resposta diz que falta o deploy' }))
  })

  it('turnos adiados pelo cooldown chegam ao fechamento seguinte, em ordem e rotulados', async () => {
    let clock = 1_000_000
    const ask = vi.fn(async (_prompt: string) => 'OK')
    const po = new Po({ config, board: fakeBoard([card()]), ask, gateActive: async () => false, now: () => clock })

    po.noteUserMessage('conv-1', 'C:/p', 'um')
    po.observe('conv-1', text('Terminei o um.'))
    po.observe('conv-1', result)
    await flush()
    clock += 1_000
    po.noteUserMessage('conv-1', 'C:/p', 'dois')
    po.observe('conv-1', text('olhando o dois'))
    po.observe('conv-1', text('Terminei o dois.'))
    po.observe('conv-1', result)
    await flush()
    clock += 120_000
    po.noteUserMessage('conv-1', 'C:/p', 'três')
    po.observe('conv-1', text('Terminei o três.'))
    po.observe('conv-1', result)
    await flush()

    const closes = ask.mock.calls.map((call) => String(call[0])).filter(isClose)
    const last = closes.at(-1) ?? ''
    expect(last).toContain(
      `${PO_MESSAGES_SECTION}\n[turno anterior 1 de 1, adiado pelo cooldown]\n\n[mensagem 1]\nolhando o dois\n\n` +
        '[resposta final daquele turno]\nTerminei o dois.\n\n[este turno]\n\n(nenhuma mensagem antes da resposta final)'
    )
    expect(last).toContain(`${PO_REPLY_SECTION}\nTerminei o três.`)
  })
})
