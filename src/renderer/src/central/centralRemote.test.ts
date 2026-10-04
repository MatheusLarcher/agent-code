import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/ipc'
import type { CentralEntry, CentralReplyEntry, CentralRequestEntry, CentralTarget, RemoteCentralRequest } from '@shared/central'
import type { CentralLabel } from './centralRecents'
import {
  buildRemoteCentral,
  remoteIcon,
  REMOTE_CENTRAL_MAX_ENTRIES,
  REMOTE_ICON_MAX_CHARS,
  type CentralRemoteSource
} from './centralRemote'

/**
 * O retrato da Central para o celular (puro): as últimas entradas, o aviso e o
 * "Para onde vai?" prontos, a linha de atividade como a tela guardou, as
 * perguntas com o convId DO DESTINO — nenhuma imagem de mensagem ou anexo, e o
 * ícone do projeto só quando pequeno (até 12 KB).
 */

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

const LABELS: Record<string, CentralLabel> = {
  c1: { project: 'agent-code', title: 'Tela de login', color: '#7fb3d5', icon: ICON, sandbox: false },
  s1: { project: 'sandbox', title: 'Cotação do dólar', color: '#8fc89a', icon: null, sandbox: true }
}
const labelFor = (convId: string): CentralLabel =>
  LABELS[convId] ?? { project: '', title: 'conversa', color: '#9aa8e8', icon: null, sandbox: false }

const source = (entries: CentralEntry[], extra: Partial<CentralRemoteSource> = {}): CentralRemoteSource => ({
  entries,
  rail: [],
  pending: [],
  labelFor,
  ...extra
})

const toC1: CentralTarget = { kind: 'conversation', convId: 'c1', cwd: 'C:\\p\\agent-code', project: 'agent-code', title: 'Tela de login', sandbox: false }
const newInProject: CentralTarget = { kind: 'new-conversation', cwd: 'C:\\p\\agent-code', project: 'agent-code' }

const routed: CentralRequestEntry = {
  kind: 'request',
  id: 'r1',
  ts: 1,
  text: 'faz o login aceitar SSO',
  attachments: ['print.png'],
  state: 'delivered',
  origin: 'central',
  route: { target: toC1, rule: 'continua', confidence: 0.9, why: 'continua "Tela de login"' },
  anchor: { convId: 'c1', msgId: 'u1' }
}
const asking: CentralRequestEntry = {
  kind: 'request',
  id: 'r2',
  ts: 2,
  text: 'deixa mais escuro',
  state: 'asking',
  origin: 'central',
  ask: { reason: 'low-confidence', best: 0, options: [{ target: toC1, probability: 0.5 }, { target: newInProject }, { target: { kind: 'new-sandbox' } }] }
}

describe('buildRemoteCentral', () => {
  it('leva só as últimas 60 entradas, na ordem do tempo', () => {
    const many: CentralEntry[] = Array.from({ length: 75 }, (_, i) => ({
      kind: 'request' as const,
      id: `r${i}`,
      ts: i,
      text: `pedido ${i}`,
      state: 'routing' as const
    }))
    const out = buildRemoteCentral(source(many))
    expect(REMOTE_CENTRAL_MAX_ENTRIES).toBe(60)
    expect(out.entries).toHaveLength(60)
    expect(out.entries[0].id).toBe('r15')
    expect(out.entries.at(-1)?.id).toBe('r74')
    expect(buildRemoteCentral(source(many), 5).entries.map((e) => e.id)).toEqual(['r70', 'r71', 'r72', 'r73', 'r74'])
  })

  it('anexo, mensagem e permissão nunca levam imagem: anexo é nome e a entrada da ferramenta vai enxuta', () => {
    const write: PermissionRequest = {
      id: 'p1',
      toolName: 'Write',
      input: { file_path: 'C:\\p\\logo.png', content: ICON, url: ICON, nested: { data: ICON }, list: [ICON] }
    }
    // Sem ícone de projeto em jogo: assim qualquer `data:` no retrato seria vazamento.
    const noIcon = (convId: string): CentralLabel => ({ ...labelFor(convId), icon: null })
    const out = buildRemoteCentral(
      source([routed, asking], {
        labelFor: noIcon,
        rail: [{ convId: 'c1', ...noIcon('c1') }],
        pending: [{ convId: 'c1', label: noIcon('c1'), request: write }]
      })
    )
    const json = JSON.stringify(out)
    expect(json).not.toContain('data:')
    expect(json).not.toContain('base64')
    expect(json).not.toContain('iVBORw0KGgo')
    expect(out.questions[0].request).toEqual({ id: 'p1', toolName: 'Write', input: { file_path: 'C:\\p\\logo.png' } })
    expect(out.entries[0]).toMatchObject({ attachments: ['print.png'] })
  })

  it('ícone do projeto: só data:image/ até 12 KB, nos cards e nas opções; senão null e o celular desenha o traço', () => {
    const prefix = 'data:image/png;base64,'
    const edge = prefix + 'A'.repeat(REMOTE_ICON_MAX_CHARS - prefix.length)
    const big = edge + 'A'
    expect(REMOTE_ICON_MAX_CHARS).toBe(12 * 1024)
    expect(remoteIcon(edge)).toBe(edge)
    expect(remoteIcon(big)).toBeNull()
    expect(remoteIcon('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(remoteIcon('C:\\p\\agent-code\\logo.png')).toBeNull()
    expect(remoteIcon(null)).toBeNull()

    const labels: Record<string, CentralLabel> = {
      a: { project: 'agent-code', title: 'Login', color: '#7fb3d5', icon: edge, sandbox: false },
      b: { project: 'gerar_darj', title: 'CNPJ', color: '#c39bd3', icon: big, sandbox: false },
      s: { project: 'sandbox', title: 'Dólar', color: '#8fc89a', icon: ICON, sandbox: true }
    }
    const conv = (id: string, sandbox = false): CentralTarget => ({
      kind: 'conversation',
      convId: id,
      cwd: `C:\\p\\${id}`,
      project: labels[id].project,
      title: labels[id].title,
      sandbox
    })
    const ask: CentralRequestEntry = {
      ...asking,
      ask: {
        reason: 'low-confidence',
        best: 1,
        options: [{ target: conv('a') }, { target: conv('b') }, { target: conv('s', true) }, { target: newInProject }, { target: { kind: 'new-sandbox' } }]
      }
    }
    const out = buildRemoteCentral({
      entries: [ask],
      rail: (['a', 'b', 's'] as const).map((id) => ({ convId: id, ...labels[id] })),
      pending: [],
      labelFor: (id) => labels[id]
    })
    expect(out.rail.map((c) => [c.convId, c.icon, c.sandbox])).toEqual([
      ['a', edge, false],
      ['b', null, false],
      ['s', null, true]
    ])
    const options = (out.entries[0] as RemoteCentralRequest).ask?.options ?? []
    expect(options.map((o) => [o.icon, o.glyph, o.best])).toEqual([
      [edge, 'project', false],
      [null, 'project', true],
      [null, 'sandbox', false],
      [null, 'new', false],
      [null, 'sandbox', false]
    ])
    // O grande não viaja em lugar nenhum.
    expect(JSON.stringify(out)).not.toContain(big)
  })

  it('perguntas pendentes levam o convId DO DESTINO, quem pergunta, a cor e o pedido para responder', () => {
    const ask: PermissionRequest = {
      id: 'p9',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'Qual provedor?' }] },
      questions: [
        { header: 'SSO', question: 'Qual provedor?', multiSelect: false, options: [{ label: 'Google', description: '' }, { label: 'Microsoft', description: 'Azure AD' }] }
      ],
      deadline: 123
    }
    const bash: PermissionRequest = { id: 'p8', toolName: 'Bash', input: { command: 'npm test', description: 'roda os testes', timeout: 5 } }
    const out = buildRemoteCentral(
      source([], {
        pending: [
          { convId: 'c1', label: LABELS.c1, request: ask },
          { convId: 's1', label: LABELS.s1, request: bash }
        ]
      })
    )
    expect(out.questions).toEqual([
      {
        convId: 'c1',
        who: 'agent-code · Tela de login',
        color: '#7fb3d5',
        request: { id: 'p9', toolName: 'AskUserQuestion', input: {}, questions: ask.questions, deadline: 123 }
      },
      {
        convId: 's1',
        who: 'sandbox · Cotação do dólar',
        color: '#8fc89a',
        request: { id: 'p8', toolName: 'Bash', input: { command: 'npm test', description: 'roda os testes' } }
      }
    ])
  })

  it('resposta: a linha de atividade vai PRONTA (segmentos, texto, contagem, erros, agora) com o fim do turno', () => {
    const running: CentralReplyEntry = {
      kind: 'reply',
      id: 'reply:r1',
      ts: 3,
      requestId: 'r1',
      anchor: { convId: 'c1', msgId: 'u1' },
      notes: ['Vou usar o OAuth de auth.ts.'],
      activity: {
        segments: [{ text: 'Leu ' }, { text: 'auth.ts', tone: 'strong' }, { text: ' · 1 erro', tone: 'bad' }],
        text: 'Leu auth.ts · 1 erro',
        count: 5,
        errors: 1,
        now: 'lendo login.ts…'
      },
      done: false
    }
    const out = buildRemoteCentral(source([routed, running]))
    expect(out.entries[1]).toEqual({
      kind: 'reply',
      id: 'reply:r1',
      ts: 3,
      requestId: 'r1',
      anchor: { convId: 'c1', msgId: 'u1' },
      who: 'agent-code · Tela de login',
      color: '#7fb3d5',
      notes: ['Vou usar o OAuth de auth.ts.'],
      activity: {
        segments: [{ text: 'Leu ' }, { text: 'auth.ts', tone: 'strong' }, { text: ' · 1 erro', tone: 'bad' }],
        text: 'Leu auth.ts · 1 erro',
        count: 5,
        errors: 1,
        now: 'lendo login.ts…',
        done: false
      }
    })
    const finished: CentralReplyEntry = {
      ...running,
      answer: 'Pronto: SSO no login.',
      activity: { segments: [{ text: 'Editou ' }], text: 'Editou login.ts', count: 6, errors: 0 },
      done: true
    }
    const done = buildRemoteCentral(source([routed, finished])).entries[1]
    expect(done).toMatchObject({ answer: 'Pronto: SSO no login.', activity: { text: 'Editou login.ts', count: 6, errors: 0, done: true } })
    expect(done.kind === 'reply' && 'now' in done.activity).toBe(false)
  })

  it('A1: origin e injected passam; o adotado avisa onde está e o injetado não tem bloco de resposta', () => {
    const adopted: CentralRequestEntry = {
      kind: 'request',
      id: 'a1',
      ts: 1,
      text: 'roda os testes',
      state: 'delivered',
      origin: 'conversation',
      route: { target: toC1, why: 'enviada na própria conversa' },
      anchor: { convId: 'c1', msgId: 'u5' }
    }
    const injected: CentralRequestEntry = { ...adopted, id: 'a2', ts: 2, text: 'agora com cobertura', injected: true, anchor: { convId: 'c1', msgId: 'u6' } }
    const staleReply: CentralEntry = {
      kind: 'reply',
      id: 'reply:a2',
      ts: 3,
      requestId: 'a2',
      anchor: { convId: 'c1', msgId: 'u6' },
      notes: [],
      activity: { segments: [], text: '', count: 0, errors: 0 },
      done: true
    }
    const out = buildRemoteCentral(source([adopted, injected, staleReply]))
    expect(out.entries.map((e) => e.id)).toEqual(['a1', 'a2'])
    expect(out.entries[0]).toEqual({
      kind: 'request',
      id: 'a1',
      ts: 1,
      text: 'roda os testes',
      state: 'delivered',
      origin: 'conversation',
      notice: { to: 'agent-code · Tela de login', why: 'enviada na própria conversa', color: '#7fb3d5' },
      anchor: { convId: 'c1', msgId: 'u5' }
    })
    expect(out.entries[1]).toMatchObject({ origin: 'conversation', injected: true })
    // Adotado nunca pergunta "Para onde vai?" (nem com um `ask` velho gravado).
    const oddAsk = buildRemoteCentral(source([{ ...adopted, state: 'asking', ask: asking.ask }])).entries[0]
    expect((oddAsk as RemoteCentralRequest).ask).toBeUndefined()
  })

  it('"Para onde vai?": rótulos prontos, a melhor marcada e os índices do PC; o aviso de destino novo', () => {
    const out = buildRemoteCentral(source([asking]))
    expect((out.entries[0] as RemoteCentralRequest).ask).toEqual({
      reason: 'low-confidence',
      options: [
        { label: 'Tela de login', sub: 'agent-code', icon: ICON, glyph: 'project', best: true },
        { label: 'nova em agent-code', icon: null, glyph: 'new', best: false },
        { label: 'sandbox', sub: 'nova conversa', icon: null, glyph: 'sandbox', best: false }
      ]
    })
    const toNew: CentralRequestEntry = { ...routed, id: 'r3', route: { target: newInProject, rule: 'nova', why: 'assunto novo' }, anchor: { convId: 'c7', msgId: 'u7' } }
    const toSandbox: CentralRequestEntry = { ...routed, id: 'r4', route: { target: { kind: 'new-sandbox' }, rule: 'sandbox', why: 'sem projeto' }, anchor: { convId: 's1', msgId: 'u8' } }
    const [a, b] = buildRemoteCentral(source([toNew, toSandbox])).entries as RemoteCentralRequest[]
    expect(a.notice).toEqual({ to: 'nova conversa em agent-code', why: 'assunto novo', color: '#9aa8e8' })
    expect(b.notice).toEqual({ to: 'sandbox', why: 'sem projeto', color: '#8fc89a' })
    // Pedido ainda decidindo: sem aviso nem pergunta.
    const routing = buildRemoteCentral(source([{ kind: 'request', id: 'r5', ts: 5, text: 'oi', state: 'routing' }])).entries[0]
    expect(routing).toEqual({ kind: 'request', id: 'r5', ts: 5, text: 'oi', state: 'routing' })
  })

  it('pedido de outro PC sai foreign (só o dono entrega); mesmo PC, legado sem device ou sem self não marca', () => {
    const fromB: CentralRequestEntry = { ...asking, id: 'b1', device: 'pc-B' }
    const fromA: CentralRequestEntry = { ...asking, id: 'a1', device: 'pc-A' }
    const legacy: CentralRequestEntry = { ...asking, id: 'l1' }
    const blank: CentralRequestEntry = { ...asking, id: 'e1', device: '' }
    const deliveredB: CentralRequestEntry = { ...routed, id: 'b2', device: 'pc-B' }
    const flags = (self: string | null | undefined): Array<[string, boolean]> =>
      buildRemoteCentral(source([fromB, fromA, legacy, blank, deliveredB], { self })).entries.map((e) => [
        e.id,
        (e as RemoteCentralRequest).foreign === true
      ])
    expect(flags('pc-A')).toEqual([
      ['b1', true],
      ['a1', false],
      ['l1', false],
      ['e1', false],
      ['b2', true]
    ])
    // Sem saber quem é este PC (ou com id vazio), ninguém é marcado — como antes.
    for (const self of [undefined, null, '']) expect(flags(self).every(([, foreign]) => !foreign)).toBe(true)
    // O pedido de fora continua mostrando a pergunta (o celular desenha sem botões).
    const out = buildRemoteCentral(source([fromB], { self: 'pc-A' })).entries[0] as RemoteCentralRequest
    expect(out).toMatchObject({ foreign: true, state: 'asking', ask: { reason: 'low-confidence' } })
    expect(out.ask?.options).toHaveLength(3)
    expect(buildRemoteCentral(source([fromA], { self: 'pc-A' })).entries[0]).not.toHaveProperty('foreign')
  })

  it('pergunta já respondida leva quem e a cor do destino', () => {
    const out = buildRemoteCentral(source([{ kind: 'question', id: 'q1', ts: 5, convId: 'c1', question: 'Qual provedor?', answer: 'Google', device: 'pc-1' }]))
    expect(out.entries).toEqual([
      { kind: 'question', id: 'q1', ts: 5, convId: 'c1', who: 'agent-code · Tela de login', color: '#7fb3d5', question: 'Qual provedor?', answer: 'Google' }
    ])
  })

  it('dado torto de outra versão não derruba o retrato', () => {
    const broken = [
      { kind: 'request', id: 'x1', ts: 1, text: 'a', state: 'delivered', route: { why: 1 }, anchor: { convId: 'c1', msgId: 'u1' } },
      { kind: 'request', id: 'x2', ts: 2, text: 'b', state: 'delivered', route: { target: toC1, why: 'w' }, anchor: { convId: 5 } },
      { kind: 'request', id: 'x3', ts: 3, text: 'c', state: 'asking', ask: { reason: 'moved', options: [{ target: { kind: 'conversation' } }, null, { target: toC1 }] } },
      { kind: 'reply', id: 'reply:x1', ts: 4, requestId: 'x1', anchor: { convId: 'c1', msgId: 'u1' }, notes: ['ok', 3], activity: {}, done: 'sim' }
    ] as unknown as CentralEntry[]
    const out = buildRemoteCentral(source(broken))
    expect(out.entries[0]).toMatchObject({ notice: { to: 'agent-code · Tela de login', why: '' } })
    expect(out.entries[1]).not.toHaveProperty('anchor')
    expect(out.entries[1]).not.toHaveProperty('notice')
    expect((out.entries[2] as RemoteCentralRequest).ask?.options.map((o) => o.label)).toEqual(['destino', 'destino', 'Tela de login'])
    expect(out.entries[3]).toMatchObject({ notes: ['ok'], activity: { segments: [], text: '', count: 0, errors: 0, done: false } })
  })
})
