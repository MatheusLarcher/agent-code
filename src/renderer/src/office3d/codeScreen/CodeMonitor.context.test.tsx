import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { secretPlaceholder, type ContextBlock, type ContextTurnChanged, type ContextTurnDetail, type ContextTurnSummary, type ContextUsageSnapshot } from '@shared/contextSnapshot'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { OfficeCharacterModel } from '../../office/adapter/model'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { UiProvider } from '../../ui/UiProvider'
import { CodeMonitor } from './CodeMonitor'
import { REVEAL_MS } from './ContextRecv'

const CWD = 'C:\\proj\\loja'
const OPUS = 'claude-opus-5-5'
const SOL = 'gpt-6.1-sol'
const SECRET = 'S3NHA-de-teste'
const model = (over: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel => ({
  key: 'conv:a', convId: 'a', roomId: 'c:/proj/loja', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a', active: true, activity: null, bubble: null, label: 'x', ...over
})
const block = (kind: ContextBlock['kind'], text: string, source: ContextBlock['source'] = 'prompt'): ContextBlock => ({
  kind, label: kind, source, hash: `h:${kind}:${text}`, bytes: text.length, at: 1_700_000_000_000, text
})
const summary = (turnId: string, startedAt: number, models: ContextTurnSummary['models']): ContextTurnSummary => ({
  convId: 'a', turnId, pc: 'PC-A', startedAt, model: OPUS, models, provider: 'claude', request: `pedido ${turnId}`, blockCount: 3, totalBytes: 10, memoriesSent: ['office3d/monitor.md'], complete: true
})
const T2 = summary('T2', new Date(2026, 9, 3, 16, 42).getTime(), [{ model: OPUS, calls: 13, node: null }, { model: SOL, calls: 4, node: null }])
const T1 = summary('T1', new Date(2026, 9, 3, 16, 12).getTime(), [{ model: 'claude-sonnet-5-5', calls: 3, node: null }])
const detailOf = (s: ContextTurnSummary, blocks: ContextBlock[]): ContextTurnDetail => ({ ...s, blocks, usage: null, secrets: [{ name: 'vault', length: SECRET.length }] })
const DETAILS: Record<string, ContextTurnDetail> = {
  T2: detailOf(T2, [block('system-append', `Use a senha:\n- vault: ${secretPlaceholder('vault')}`, 'system'), block('user-request', 'arruma o login'), block('memory-excerpts', '--- Memória relevante: office3d/monitor.md ---\nx', 'hook-start')]),
  T1: detailOf(T1, [block('system-append', `Use a senha:\n- vault: ${secretPlaceholder('vault')}`, 'system'), block('user-request', 'pedido antigo')])
}

let seq = 0
const tool = (name: string, input: unknown, turn: string, m?: string): UIMessage => ({
  kind: 'tool-use', id: `t${seq++}`, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' }, turnIds: [turn], ...(m ? { model: m } : {})
}) as UIMessage
const turnMsgs: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'pedido antigo' },
  tool('Edit', { file_path: `${CWD}\\src\\old.ts`, old_string: 'a', new_string: 'b' }, 'T1', 'claude-sonnet-5-5'),
  { kind: 'user', id: 'u2', text: 'arruma o login' },
  tool('Edit', { file_path: `${CWD}\\src\\login.ts`, old_string: 'a', new_string: 'b\nc' }, 'T2', OPUS),
  tool('Read', { file_path: `${CWD}\\src\\auth.ts` }, 'T2', OPUS),
  tool('Bash', { command: 'npm test' }, 'T2', SOL)
]
const feedOf = (messages = turnMsgs, extra: Partial<OfficeFeed> = {}): OfficeFeed =>
  feed({ conversations: [conv('a', { title: 'Login', cwd: CWD, messages })], busyIds: new Set(), ...extra })

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('agentcode.monitor.app', 'ctx')
  api = {
    readFile: vi.fn(async () => 'x\n'),
    getCacheInfo: vi.fn(async () => ({ memoriesDir: 'D:\\mem' })),
    listContextTurns: vi.fn(async () => [T2, T1]),
    // Como o IPC: um objeto novo a cada leitura (a releitura do mesmo turno não é o mesmo objeto).
    readContextTurn: vi.fn(async (_c: string, turnId: string) => (DETAILS[turnId] ? { ...DETAILS[turnId] } : null)),
    countContextExact: vi.fn(async () => ({ ok: true, usage: { detail: 'full', at: 1, totalTokens: 64360, maxTokens: 200000, percentage: 32, categories: [] } })),
    revealSecret: vi.fn(async () => SECRET),
    onContextTurnsChanged: vi.fn(() => () => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

const ui = (f: OfficeFeed = feedOf(), m: OfficeCharacterModel = model()): JSX.Element => (
  <UiProvider>
    <CodeMonitor feed={f} model={m} />
  </UiProvider>
)

// A contagem exata (countContextExact): o resultado do SDK e o turno novo que chega com a tela aberta.
const usage = (totalTokens: number): ContextUsageSnapshot => ({ detail: 'full', at: 1, totalTokens, maxTokens: 200000, percentage: 32, categories: [] })
const T3 = summary('T3', new Date(2026, 9, 3, 17, 5).getTime(), [{ model: OPUS, calls: 2, node: null }])
const withT3 = (): void => {
  api.listContextTurns.mockResolvedValue([T3, T2, T1])
  api.readContextTurn.mockImplementation(async (_c: string, turnId: string) =>
    turnId === 'T3' ? detailOf(T3, [block('user-request', 'outro pedido')]) : DETAILS[turnId] ? { ...DETAILS[turnId] } : null
  )
}
/** Deixa as promessas em voo (o IPC fingido) terminarem. */
const settle = (): Promise<void> => act(async () => {
  await new Promise((r) => setTimeout(r, 0))
})
const sum = (): string => document.querySelector('.cm-ctx-sum')?.textContent ?? ''
const toastTitles = (): string[] => [...document.querySelectorAll('.cm-toast b')].map((b) => b.textContent ?? '')
/** O botão da contagem: "Contar exato" ou, contado, "Contado". */
const exactBtn = (): HTMLButtonElement => screen.getByRole('button', { name: /^(Contar exato|Contado)$/ }) as HTMLButtonElement
/** O aviso "mudou" do main: a tela relê a lista e o turno à vista (espera a releitura acontecer). */
function turnsChanged(): (turnId: string) => Promise<void> {
  const subs = new Set<(e: ContextTurnChanged) => void>()
  api.onContextTurnsChanged.mockImplementation((f: (e: ContextTurnChanged) => void) => {
    subs.add(f)
    return () => void subs.delete(f)
  })
  return async (turnId) => {
    const reads = api.listContextTurns.mock.calls.length
    act(() => [...subs].forEach((f) => f({ convId: 'a', turnId })))
    await waitFor(() => expect(api.listContextTurns.mock.calls.length).toBeGreaterThan(reads), { timeout: 2000 })
    await settle()
    await settle()
  }
}

describe('CodeMonitor — app Contexto', () => {
  it('Recebeu: o texto exato, com a senha mascarada do tamanho real; o olho mostra o valor de agora e esconde em 30 s', async () => {
    render(ui())
    expect(await screen.findByText('arruma o login')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Instruções do app/ }))
    const masked = await screen.findByText('•'.repeat(SECRET.length))
    expect(document.body.textContent).not.toContain(SECRET)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mostrar a senha vault' }))
    })
    expect(api.revealSecret).toHaveBeenCalledWith('vault')
    expect(screen.getByText(SECRET)).toBeTruthy()
    act(() => void vi.advanceTimersByTime(REVEAL_MS))
    expect(document.body.textContent).not.toContain(SECRET)
    expect(masked).toBeTruthy()
  })

  it('Fez: "feito por A → B" e, num turno com dois modelos, a etiqueta de cada item; memória enviada sem etiqueta', async () => {
    render(ui())
    await screen.findByText('arruma o login')
    const did = document.querySelector('.cm-did') as HTMLElement
    expect(within(did).getByTitle('Lido da resposta da API, não do seletor de modelo').textContent).toBe('feito por Opus 5.5 → GPT-6.1 Sol')
    const file = within(did).getByRole('button', { name: /login\.ts/ })
    expect([...file.querySelectorAll('.cm-mt')].map((t) => t.textContent)).toEqual(['Opus'])
    const sent = did.querySelector('[data-tag="sent"]') as HTMLElement
    expect([sent.textContent?.includes('enviada'), sent.querySelector('.cm-mt')]).toEqual([true, null])
    fireEvent.click(within(did).getByRole('button', { name: /Comandos/ }))
    expect(did.querySelector('.cm-act-list .cm-mt')?.textContent).toBe('Sol')
    // Clique no arquivo abre no Código.
    fireEvent.click(file)
    expect(screen.getByTestId('office-screen').dataset.mode).toBe('code')
  })

  it('seletor: os 10 últimos turnos com o modelo de cada um; turno antigo lido do banco, um modelo só e sem etiqueta', async () => {
    render(ui())
    await screen.findByText('arruma o login')
    fireEvent.click(screen.getByRole('button', { name: /Turno das 16:42 · atual/ }))
    const menu = screen.getByRole('menu', { name: 'Turnos desta conversa' })
    expect(within(menu).getAllByRole('menuitem').map((i) => i.querySelector('.cm-tmm')?.textContent)).toEqual(['Opus 5.5 → GPT-6.1 Sol', 'Sonnet 5.5'])
    fireEvent.click(within(menu).getAllByRole('menuitem')[1])
    expect(await screen.findByText('pedido antigo')).toBeTruthy()
    expect(document.querySelector('.cm-recv')!.textContent).toContain('lido do banco')
    expect(document.querySelector('.cm-recv')!.textContent).toContain('igual às 16:42')
    expect(document.querySelector('.cm-did .cm-mchip')?.textContent).toBe('feito por Sonnet 5.5')
    expect(document.querySelectorAll('.cm-did .cm-mt')).toHaveLength(0)
  })

  it('abrir o Contexto conta exato sozinho, uma vez e calado: o total contado no topo e "Contado", sem aviso', async () => {
    render(ui())
    await screen.findByText('arruma o login')
    await waitFor(() => expect(sum()).toContain('64.360 tokens'))
    await settle()
    expect(api.countContextExact.mock.calls).toEqual([['a']])
    expect([exactBtn().textContent, exactBtn().disabled, toastTitles()]).toEqual(['Contado', true, []])
  })

  it('a contagem sozinha que falha fica calada: o resumo do SDK, "Contar exato" livre e sem repetir; à mão, os avisos de hoje', async () => {
    const changed = turnsChanged()
    api.countContextExact.mockResolvedValueOnce({ ok: false, usage: null, reason: 'Não há sessão viva nesta conversa.' })
    const view = render(ui())
    await screen.findByText('arruma o login')
    await waitFor(() => expect(api.countContextExact).toHaveBeenCalledTimes(1))
    await settle()
    expect([toastTitles(), exactBtn().textContent, exactBtn().disabled, sum().includes('64.360')]).toEqual([[], 'Contar exato', false, false])
    // A releitura do mesmo turno não tenta de novo (nada de laço).
    await changed('T2')
    expect(api.countContextExact).toHaveBeenCalledTimes(1)
    // À mão (a sessão voltou): o total e o aviso de sempre.
    fireEvent.click(exactBtn())
    expect(await screen.findByText('Contagem exata feita')).toBeTruthy()
    expect([sum().includes('64.360 tokens'), exactBtn().textContent]).toEqual([true, 'Contado'])
    view.unmount()
    // Na rota GPT nunca dá: calado ao abrir; o botão diz o motivo.
    api.countContextExact.mockResolvedValue({ ok: false, usage: null, reason: 'Contagem exata indisponível na rota gpt.' })
    render(ui())
    await screen.findByText('arruma o login')
    await waitFor(() => expect(api.countContextExact).toHaveBeenCalledTimes(3))
    await settle()
    expect(toastTitles()).toEqual([])
    fireEvent.click(exactBtn())
    expect(await screen.findByText('Contagem exata indisponível na rota gpt.')).toBeTruthy()
    expect(toastTitles()).toEqual(['Contagem exata indisponível'])
  })

  it('turno antigo não conta sozinho (o botão fica desligado); voltar ao mais novo conta de novo', async () => {
    render(ui())
    await screen.findByRole('button', { name: 'Contado' })
    fireEvent.click(screen.getByRole('button', { name: /Turno das 16:42 · atual/ }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Turnos desta conversa' })).getAllByRole('menuitem')[1])
    expect(await screen.findByText('pedido antigo')).toBeTruthy()
    await settle()
    expect([api.countContextExact.mock.calls.length, exactBtn().textContent, exactBtn().disabled]).toEqual([1, 'Contar exato', true])
    fireEvent.click(screen.getByRole('button', { name: /Turno das 16:12/ }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Turnos desta conversa' })).getAllByRole('menuitem')[0])
    await screen.findByRole('button', { name: 'Contado' })
    expect(api.countContextExact).toHaveBeenCalledTimes(2)
  })

  it('a releitura do mesmo turno não conta de novo; um turno novo com a tela aberta, sim', async () => {
    const changed = turnsChanged()
    render(ui())
    await screen.findByRole('button', { name: 'Contado' })
    await changed('T2')
    expect([api.countContextExact.mock.calls.length, exactBtn().textContent]).toEqual([1, 'Contado'])
    withT3()
    api.countContextExact.mockResolvedValueOnce({ ok: true, usage: usage(70000) })
    await changed('T3')
    expect(await screen.findByText('outro pedido')).toBeTruthy()
    await waitFor(() => expect(sum()).toContain('70.000 tokens'))
    expect([api.countContextExact.mock.calls.length, exactBtn().textContent, toastTitles()]).toEqual([2, 'Contado', []])
  })

  it('a contagem que chega depois de o turno mudar não vale para o turno novo', async () => {
    const changed = turnsChanged()
    let late: (v: unknown) => void = () => undefined
    api.countContextExact.mockImplementationOnce(() => new Promise((r) => (late = r)))
    api.countContextExact.mockResolvedValueOnce({ ok: true, usage: usage(70000) })
    render(ui())
    await screen.findByText('arruma o login')
    await waitFor(() => expect(api.countContextExact).toHaveBeenCalledTimes(1))
    withT3()
    await changed('T3')
    await waitFor(() => expect(sum()).toContain('70.000 tokens'))
    late({ ok: true, usage: usage(64360) })
    await settle()
    expect([sum().includes('70.000 tokens'), sum().includes('64.360')]).toEqual([true, false])
  })

  it('subagente: as instruções do especialista e o pedido do principal, com o modelo dele', async () => {
    const spawn: UIMessage = { kind: 'tool-use', id: 'task-1', name: 'Agent', input: { subagent_type: 'executor', prompt: 'faça X' }, parentToolUseId: null, turnIds: ['T2'] } as UIMessage
    const tracks = { a: { 'task-1': { id: 'task-1', label: 'executor: faça X', subagentType: 'executor', status: 'running' as const, startedAt: 1, stepCount: 1, steps: [{ id: 's1', name: 'Grep', input: { pattern: 'x' }, startedAt: 2, model: 'claude-haiku-4-5' }] } } }
    api.readContextTurn.mockImplementation(async (_c: string, turnId: string, parent?: string) =>
      parent === 'task-1' && turnId === 'T2'
        ? { ...DETAILS.T2, models: [{ model: 'claude-haiku-4-5', calls: 2, node: 'task-1' }], blocks: [block('subagent-instructions', 'você é o executor', 'subagent'), block('subagent-request', 'faça X', 'subagent')] }
        : null
    )
    render(ui(feedOf([...turnMsgs, spawn], { tracks }), model({ key: 'track:task-1', trackId: 'task-1', role: 'executor' })))
    expect(await screen.findByText('faça X')).toBeTruthy()
    expect(api.readContextTurn).toHaveBeenCalledWith('a', 'T2', 'task-1')
    expect(document.querySelector('.cm-recv')!.textContent).toContain('Instruções do especialista')
    expect(document.querySelector('.cm-recv')!.textContent).toContain('O que o motor carrega para o subagente')
    expect(document.querySelector('.cm-did .cm-mchip')?.textContent).toBe('feito por claude-haiku-4-5')
    // A contagem exata é a da sessão do principal: o subagente não conta sozinho.
    await settle()
    expect(api.countContextExact).not.toHaveBeenCalled()
  })

  it('sem IPC (ou sem turno gravado): diz o que falta, sem erro e sem modelo inventado', async () => {
    api.listContextTurns.mockResolvedValue([])
    render(ui(feedOf([{ kind: 'user', id: 'u', text: 'oi' }])))
    expect(await screen.findByText(/Nenhum turno gravado nesta conversa ainda/)).toBeTruthy()
    expect(document.querySelector('.cm-did .cm-mchip')).toBeNull()
    await settle()
    expect(api.countContextExact).not.toHaveBeenCalled()
  })
})
