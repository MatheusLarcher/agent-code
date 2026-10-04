import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { secretPlaceholder, type ContextBlock, type ContextTurnDetail, type ContextTurnSummary } from '@shared/contextSnapshot'
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
    readContextTurn: vi.fn(async (_c: string, turnId: string) => DETAILS[turnId] ?? null),
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

  it('Contar exato: o total contado; na rota GPT, o motivo, sem erro', async () => {
    const view = render(ui())
    await screen.findByText('arruma o login')
    fireEvent.click(screen.getByRole('button', { name: /Contar exato/ }))
    expect(await screen.findByText('Contagem exata feita')).toBeTruthy()
    expect(document.querySelector('.cm-ctx-sum')!.textContent).toContain('64.360 tokens')
    view.unmount()
    api.countContextExact.mockResolvedValueOnce({ ok: false, usage: null, reason: 'Contagem exata indisponível na rota gpt.' })
    render(ui())
    await screen.findByText('arruma o login')
    fireEvent.click(screen.getByRole('button', { name: /Contar exato/ }))
    expect(await screen.findByText('Contagem exata indisponível na rota gpt.')).toBeTruthy()
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
  })

  it('sem IPC (ou sem turno gravado): diz o que falta, sem erro e sem modelo inventado', async () => {
    api.listContextTurns.mockResolvedValue([])
    render(ui(feedOf([{ kind: 'user', id: 'u', text: 'oi' }])))
    expect(await screen.findByText(/Nenhum turno gravado nesta conversa ainda/)).toBeTruthy()
    expect(document.querySelector('.cm-did .cm-mchip')).toBeNull()
  })
})
