import { createRef } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { CENTRAL_ID, type CentralEntry, type CentralReplyEntry, type CentralRequestEntry } from '@shared/central'
import type { PermissionRequest } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import type { Conversation, UIMessage } from '../types'
import { CentralPanel } from './CentralPanel'
import { centralColor } from './centralColor'
import { fakeController, fakeLabel, railCard, type FakeInit } from './centralFakeController'

/**
 * A tela da Central (mockup v3) com um controller falso: aviso do destino,
 * porquê e "não era aqui", adotado/injetado (A1), "Para onde vai?", pedido de
 * outro PC, resposta com a linha-resumo e os cartões do turno, "abrir conversa",
 * trilho e as perguntas/permissões dos destinos.
 */

const SELF = 'pc-a'
const central = (): Conversation =>
  ({ id: CENTRAL_ID, title: 'Central', cwd: '', mode: 'central', model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1 }) as Conversation

const C = (convId: string) => ({ kind: 'conversation' as const, convId, cwd: `/p/${convId}`, project: fakeLabel(convId).project, title: fakeLabel(convId).title, sandbox: false })

const routed = (over: Partial<CentralRequestEntry> = {}): CentralRequestEntry => ({
  kind: 'request',
  id: 'r1',
  ts: 1,
  text: 'no gerar_darj, aquele filtro de CNPJ tem que ignorar a máscara',
  state: 'delivered',
  origin: 'central',
  device: SELF,
  route: { target: C('darj'), rule: 'conversa-antiga', confidence: 0.9, why: 'continua “Filtro de CNPJ”' },
  anchor: { convId: 'darj', msgId: 'u1' },
  ...over
})

const reply = (over: Partial<CentralReplyEntry> = {}): CentralReplyEntry => ({
  kind: 'reply',
  id: 'reply:r1',
  ts: 2,
  requestId: 'r1',
  anchor: { convId: 'darj', msgId: 'u1' },
  notes: ['Achei o filtro em `filtros.js`, vou normalizar os dois lados.', 'Testes passaram.'],
  answer: 'Pronto: o filtro agora acha **12.345.678/0001-90**.',
  activity: {
    segments: [
      { text: 'Procurou "cnpj" · editou ' },
      { text: 'filtros.js', tone: 'strong' },
      { text: ' ' },
      { text: '+6', tone: 'add' },
      { text: ' ' },
      { text: '−2', tone: 'rem' },
      { text: ' · rodou os testes ' },
      { text: '✓', tone: 'ok' }
    ],
    text: 'Procurou "cnpj" · editou filtros.js +6 −2 · rodou os testes ✓ (inteira)',
    count: 6,
    errors: 0
  },
  done: true,
  ...over
})

const tool = (id: string, name: string, input: unknown): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } }) as UIMessage

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []), resolvePastedPath: vi.fn(), downloadPastedUrl: vi.fn(), readFileBytes: vi.fn() }
})
afterEach(cleanup)

function setup(init: FakeInit, extra: { onOpenQuestion?: (id: string) => void } = {}) {
  const controller = fakeController(init)
  const r = render(
    <UiProvider>
      <CentralPanel
        conversation={central()}
        controller={controller}
        self={SELF}
        onOpenQuestion={extra.onOpenQuestion}
        ready
        onNeedTypesafe={vi.fn()}
        onSend={vi.fn()}
        onDraftChange={vi.fn()}
        composerRef={createRef<HTMLElement>()}
        projects={[]}
      />
    </UiProvider>
  )
  return { controller, container: r.container }
}

const colorOf = (el: Element | null): string => (el as HTMLElement | null)?.closest<HTMLElement>('[style]')?.style.getPropertyValue('--c') ?? ''

describe('CentralPanel — pedido e aviso do destino', () => {
  it('bolha + "→ projeto · conversa" na cor do destino; o clique abre o turno', () => {
    const { controller } = setup({ entries: [routed()] })
    expect(screen.getByText(/filtro de CNPJ tem que ignorar/).closest('.central-bubble')).not.toBeNull()
    const to = screen.getByRole('button', { name: 'gerar_darj · Filtro de CNPJ' })
    expect(colorOf(to)).toBe(centralColor('darj'))
    fireEvent.click(to)
    expect(controller.openDestination).toHaveBeenCalledWith('darj', 'u1')
  })

  it('o porquê e "não era aqui" só aparecem no hover (CSS) e o clique chama notHere', () => {
    const { controller, container } = setup({ entries: [routed()] })
    expect(container.querySelector('.central-why')?.textContent).toBe('continua “Filtro de CNPJ” ·')
    fireEvent.click(screen.getByRole('button', { name: '· não era aqui' }))
    expect(controller.notHere).toHaveBeenCalledWith('r1')
    const css = readFileSync(resolve(__dirname, 'centralFeed.css'), 'utf8')
    expect(css).toMatch(/\.central-why,\s*\.central-move \{\s*opacity: 0;/)
    expect(css).toMatch(/\.central-me:hover \.central-why,\s*\.central-me:hover \.central-move,/)
  })

  it('nova conversa e sandbox novo: "→ nova conversa em <projeto>" / "→ sandbox"', () => {
    setup({
      entries: [
        routed({ id: 'a', route: { target: { kind: 'new-conversation', cwd: '/p/ac', project: 'agent-code' }, why: 'assunto novo' }, anchor: { convId: 'sso', msgId: 'u2' } }),
        routed({ id: 'b', route: { target: { kind: 'new-sandbox' }, why: 'sem projeto' }, anchor: { convId: 'dolar', msgId: 'u3' } })
      ]
    })
    expect(screen.getByRole('button', { name: 'nova conversa em agent-code' })).toBeTruthy()
    expect(colorOf(screen.getByRole('button', { name: 'sandbox' }))).toBe(centralColor('dolar'))
  })

  it('adotado (A1): "em projeto · conversa", sem porquê nem "não era aqui"', () => {
    const { container } = setup({ entries: [routed({ origin: 'conversation', route: { target: C('darj'), why: 'enviada na própria conversa' } })] })
    expect(container.querySelector('.central-route')?.textContent).toBe('emgerar_darj · Filtro de CNPJ')
    expect(container.querySelector('.central-why')).toBeNull()
    expect(screen.queryByText('· não era aqui')).toBeNull()
  })

  it('injetado (A1): bolha e aviso, sem bloco de resposta', () => {
    const { container } = setup({ entries: [routed({ origin: 'conversation', injected: true }), reply()] })
    expect(container.querySelector('.central-bubble')).not.toBeNull()
    expect(container.querySelector('.central-agent')).toBeNull()
    expect(screen.queryByText('· não era aqui')).toBeNull()
  })

  it('decidindo e não entregue', () => {
    setup({ entries: [routed({ id: 'x', state: 'routing', route: undefined, anchor: undefined }), routed({ id: 'y', state: 'failed', anchor: undefined })] })
    expect(screen.getByText('decidindo…')).toBeTruthy()
    expect(screen.getByText('não foi entregue')).toBeTruthy()
  })
})

describe('CentralPanel — "Para onde vai?"', () => {
  const asking = (over: Partial<CentralRequestEntry> = {}): CentralRequestEntry =>
    routed({
      id: 'q1',
      text: 'deixa mais escuro',
      state: 'asking',
      route: undefined,
      anchor: undefined,
      ask: {
        reason: 'low-confidence',
        best: 0,
        options: [{ target: C('sso') }, { target: C('e3d') }, { target: { kind: 'new-conversation', cwd: '/p/ac', project: 'agent-code' } }, { target: { kind: 'new-sandbox' } }]
      },
      ...over
    })

  it('motivo apagado, um botão por opção (a mais provável com a borda laranja) e o clique chama choose', () => {
    const { controller } = setup({ entries: [asking()] })
    const card = screen.getByRole('group', { name: 'Para onde vai?' })
    expect(card.textContent).toContain('não tenho certeza — a mensagem está esperando')
    const buttons = within(card).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Tela de login com SSOagent-code', 'Escritório 3Dagent-code', 'nova em agent-code', 'sandbox'])
    expect(buttons[0].classList.contains('best')).toBe(true)
    expect(buttons[1].classList.contains('best')).toBe(false)
    fireEvent.click(buttons[2])
    expect(controller.choose).toHaveBeenCalledWith('q1', 2)
  })

  it('"não era aqui — escolha o destino" no motivo moved', () => {
    setup({ entries: [asking({ ask: { reason: 'moved', options: [{ target: { kind: 'new-sandbox' } }] } })] })
    expect(screen.getByText('(não era aqui — escolha o destino)')).toBeTruthy()
  })

  it('pedido de outro PC: sem botões, "aguardando o outro PC"; roteado de outro PC: sem "não era aqui"', () => {
    const { controller } = setup({ entries: [asking({ device: 'pc-b' }), routed({ id: 'r9', device: 'pc-b' })] })
    const card = screen.getByRole('group', { name: 'Para onde vai?' })
    expect(within(card).queryAllByRole('button')).toHaveLength(0)
    expect(card.textContent).toContain('aguardando o outro PC')
    fireEvent.click(within(card).getByText('nova em agent-code'))
    expect(controller.choose).not.toHaveBeenCalled()
    expect(screen.queryByText('· não era aqui')).toBeNull()
    expect(screen.getByRole('button', { name: 'gerar_darj · Filtro de CNPJ' })).toBeTruthy()
  })
})

describe('CentralPanel — resposta do destino', () => {
  it('quem, comentários, resposta em Markdown e a linha-resumo com tons e "N ações"', () => {
    const { container } = setup({ entries: [routed(), reply()] })
    const block = container.querySelector('.central-agent') as HTMLElement
    expect(block.style.getPropertyValue('--c')).toBe(centralColor('darj'))
    expect(block.querySelector('.central-who')?.textContent).toBe('gerar_darj · Filtro de CNPJ')
    expect([...block.querySelectorAll('.central-note')].map((n) => n.textContent)).toEqual(['Achei o filtro em filtros.js, vou normalizar os dois lados.', 'Testes passaram.'])
    expect(block.querySelector('.central-note code')?.textContent).toBe('filtros.js')
    expect(block.querySelector('.central-answer strong')?.textContent).toBe('12.345.678/0001-90')
    const act = block.querySelector('.central-act') as HTMLElement
    expect(act.title).toBe('Procurou "cnpj" · editou filtros.js +6 −2 · rodou os testes ✓ (inteira)')
    expect(act.querySelector('.central-chev')?.textContent).toBe('▸')
    expect(act.querySelector('b')?.textContent).toBe('filtros.js')
    expect(act.querySelector('.add')?.textContent).toBe('+6')
    expect(act.querySelector('.rem')?.textContent).toBe('−2')
    expect(act.querySelector('.okc')?.textContent).toBe('✓')
    expect(act.querySelector('.central-count')?.textContent).toBe('6 ações')
  })

  it('rodando: spinner na cor do destino, o resumo até ali e "agora"; sem ações, "trabalhando…"', () => {
    const running = reply({ done: false, answer: undefined, notes: [], activity: { segments: [{ text: 'Leu 3 arquivos' }], text: 'Leu 3 arquivos', count: 5, errors: 0, now: 'lendo auth.ts…' } })
    const idle = reply({ id: 'reply:r2', requestId: 'r2', anchor: { convId: 'sso', msgId: 'u9' }, done: false, notes: [], answer: undefined, activity: { segments: [], text: '', count: 0, errors: 0 } })
    const { container } = setup({ entries: [routed(), running, routed({ id: 'r2', anchor: { convId: 'sso', msgId: 'u9' } }), idle] })
    const [a, b] = [...container.querySelectorAll('.central-act')]
    expect(a.querySelector('.central-spin')).not.toBeNull()
    expect(a.querySelector('.central-chev')).toBeNull()
    expect(a.querySelector('.central-sum')?.textContent).toBe('Leu 3 arquivos · agora: lendo auth.ts…')
    expect(b.querySelector('.central-sum')?.textContent).toBe('trabalhando…')
    expect(b.querySelector('.central-count')).toBeNull()
  })

  it('clique na linha mostra os cartões DO turno (turnTools da âncora) e outro clique esconde', () => {
    const tools = { 'darj:u1': [tool('t1', 'Grep', { pattern: 'cnpj', path: 'src/' }), tool('t2', 'Read', { file_path: 'src/filtros.js' })] }
    const { controller, container } = setup({ entries: [routed(), reply()], tools })
    const act = container.querySelector('.central-act') as HTMLElement
    expect(container.querySelector('.central-tools')).toBeNull()
    fireEvent.click(act)
    expect(controller.turnTools).toHaveBeenCalledWith({ convId: 'darj', msgId: 'u1' })
    expect(container.querySelectorAll('.central-tools .tool-card')).toHaveLength(2)
    expect(act.getAttribute('aria-expanded')).toBe('true')
    expect(act.querySelector('.central-chev')?.textContent).toBe('▾')
    fireEvent.click(act)
    expect(container.querySelector('.central-tools')).toBeNull()
  })

  it('"abrir conversa ↗" abre o destino na âncora do turno', () => {
    const { controller } = setup({ entries: [routed(), reply()] })
    fireEvent.click(screen.getByRole('button', { name: 'abrir conversa ↗' }))
    expect(controller.openDestination).toHaveBeenCalledWith('darj', 'u1')
  })
})

describe('CentralPanel — trilho', () => {
  it('um cartão por destino trabalhando, com o fio na cor e o clique no último turno', () => {
    const { controller, container } = setup({ entries: [routed(), routed({ id: 'r2', anchor: { convId: 'darj', msgId: 'u7' } })], rail: [railCard('darj'), railCard('dolar')] })
    const cards = container.querySelectorAll<HTMLElement>('.central-head-rail > .central-run')
    expect(cards).toHaveLength(2)
    expect(cards[0].style.getPropertyValue('--c')).toBe(centralColor('darj'))
    expect(cards[0].textContent).toBe('gerar_darj·Filtro de CNPJ')
    expect(cards[1].querySelector('.central-pi')).not.toBeNull()
    fireEvent.click(cards[0])
    expect(controller.openDestination).toHaveBeenCalledWith('darj', 'u7')
  })

  it('sem destino trabalhando, o trilho fica sem filhos (o Escritório esconde o cabeçalho)', () => {
    const { container } = setup({ entries: [] })
    expect(container.querySelector('.central-head-rail')?.children).toHaveLength(0)
  })
})

describe('CentralPanel — perguntas e permissões dos destinos', () => {
  const ask = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
    id: 'p1',
    toolName: 'AskUserQuestion',
    input: {},
    questions: [{ header: 'SSO', question: 'Qual provedor de SSO?', multiSelect: false, options: [{ label: 'Google', description: '' }, { label: 'Microsoft', description: '' }] }],
    ...over
  })

  it('pergunta simples: o clique na opção responde com o convId do destino', () => {
    const { controller } = setup({ pending: [{ convId: 'sso', label: fakeLabel('sso'), request: ask() }] })
    const card = screen.getByRole('group', { name: 'agent-code · Tela de login com SSO pergunta' })
    expect(card.querySelector('b')?.textContent).toBe('Qual provedor de SSO?')
    fireEvent.click(within(card).getByRole('button', { name: 'Microsoft' }))
    expect(controller.answer).toHaveBeenCalledWith('sso', { id: 'p1', behavior: 'allow', answers: [{ header: 'SSO', question: 'Qual provedor de SSO?', selected: ['Microsoft'] }] })
  })

  it('"outro…" e múltipla escolha abrem o QuestionModal daquele destino', () => {
    const onOpenQuestion = vi.fn()
    const multi = ask({ id: 'p2', questions: [{ header: 'X', question: 'Quais?', multiSelect: true, options: [{ label: 'A', description: '' }] }] })
    const { controller } = setup({ pending: [{ convId: 'sso', label: fakeLabel('sso'), request: ask() }, { convId: 'darj', label: fakeLabel('darj'), request: multi }] }, { onOpenQuestion })
    fireEvent.click(screen.getByRole('button', { name: 'outro…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Responder…' }))
    expect(onOpenQuestion.mock.calls).toEqual([['sso'], ['darj']])
    expect(controller.answer).not.toHaveBeenCalled()
  })

  it('permissão de ferramenta: Permitir / Sempre / Negar', () => {
    const perm: PermissionRequest = { id: 'k1', toolName: 'Bash', input: { command: 'npm test' } }
    const { controller } = setup({ pending: [{ convId: 'darj', label: fakeLabel('darj'), request: perm }] })
    const card = screen.getByRole('group', { name: 'gerar_darj · Filtro de CNPJ pede permissão' })
    expect(card.textContent).toContain('gerar_darj · Filtro de CNPJ pede permissão:')
    fireEvent.click(within(card).getByRole('button', { name: 'Permitir' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Sempre' }))
    fireEvent.click(within(card).getByRole('button', { name: 'Negar' }))
    expect(controller.answer.mock.calls).toEqual([
      ['darj', { id: 'k1', behavior: 'allow' }],
      ['darj', { id: 'k1', behavior: 'allow', always: true }],
      ['darj', { id: 'k1', behavior: 'deny' }]
    ])
  })

  it('pergunta respondida: uma linha apagada', () => {
    const entries: CentralEntry[] = [{ kind: 'question', id: 'q', ts: 3, convId: 'sso', question: 'Qual provedor de SSO?', answer: 'Google' }]
    const { container } = setup({ entries })
    expect(container.querySelector('.central-answered')?.textContent).toBe('agent-code · Tela de login com SSO · Qual provedor de SSO? → Google')
  })
})
