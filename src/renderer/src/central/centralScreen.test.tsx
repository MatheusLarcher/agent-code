/**
 * A tela da Central (Etapa 5) no App inteiro, com o painel DE VERDADE e o
 * window.api falso: rota direta → resposta espelhada → linha-resumo expandindo
 * os cartões do turno → "abrir conversa ↗" com "← Central" e a volta; pergunta
 * e permissão do destino respondidas da Central (convId do destino); a fiação
 * do celular (escolha remota, retrato publicado, resposta remota registrada).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CentralRouteRequest, CentralRouteResult } from '@shared/central'
import type { PermissionRequest } from '@shared/ipc'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { C1, cbs, centralRequests, emit, installApi, openCentral, result, seedStorage, sentTexts, stored, type FakeApi } from './centralAppKit'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
// jsdom sem CSS.escape: a lista rola até a âncora por seletor.
;(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s }
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const direct = (): CentralRouteResult => ({ kind: 'direct', target: C1, rule: 'continua', confidence: 0.9, why: 'continua “Conversa”' })
const asking = (): CentralRouteResult => ({ kind: 'ask', options: [{ target: C1 }, { target: { kind: 'new-sandbox' } }], reason: 'low-confidence', best: 0 })

let api: FakeApi
let route: (req: CentralRouteRequest) => CentralRouteResult = direct
beforeEach(() => {
  seedStorage()
  route = direct
  api = installApi((req) => route(req))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function send(text: string): Promise<void> {
  await openCentral()
  const region = await screen.findByRole('region', { name: 'Central' })
  const box = await within(region).findByRole('textbox', { name: 'Mensagem' })
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBeFalsy())
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}
const centralPanel = (): HTMLElement => screen.getByRole('region', { name: 'Central' })
const centralEntries = () => (stored().find((c) => c.id === 'central') as { central?: { entries: { kind: string }[] } }).central?.entries ?? []

const question = (id = 'p1'): PermissionRequest => ({
  id,
  toolName: 'AskUserQuestion',
  input: {},
  questions: [{ header: 'Cor', question: 'Qual tom?', multiSelect: false, options: [{ label: 'Escuro', description: '' }, { label: 'Claro', description: '' }] }]
})

describe('tela da Central no App', () => {
  it('direto → resposta espelhada → expandir as ações → abrir conversa com "← Central" → voltar', async () => {
    render(<UiProvider><App /></UiProvider>)
    await send('o botão ficou torto')
    await waitFor(() => expect(sentTexts(api)).toEqual(['o botão ficou torto']))
    const anchor = await waitFor(() => {
      const a = centralRequests()[0]?.anchor
      expect(a).toBeTruthy()
      return a!
    })
    // O aviso do destino, na Central.
    expect(await within(centralPanel()).findByRole('button', { name: '· não era aqui' })).toBeTruthy()
    await emit({ kind: 'tool-use', id: 't1', name: 'Read', input: { file_path: '/proj/botao.css' }, parentToolUseId: null })
    await emit({ kind: 'tool-result', id: 'tr1', toolUseId: 't1', isError: false, text: 'ok', parentToolUseId: null })
    await emit({ kind: 'assistant-text', id: 'a1', text: 'Pronto: **alinhado**.', final: true })
    await emit(result)
    const panel = centralPanel()
    await waitFor(() => expect(panel.querySelector('.central-answer strong')?.textContent).toBe('alinhado'))
    const act1 = await waitFor(() => {
      const el = panel.querySelector<HTMLElement>('.central-act')
      expect(el?.textContent).toContain('botao.css')
      return el!
    })
    fireEvent.click(act1)
    expect(panel.querySelectorAll('.central-tools .tool-card')).toHaveLength(1)
    fireEvent.click(act1)
    expect(panel.querySelector('.central-tools')).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: 'abrir conversa ↗' }))
    const back = await screen.findByRole('button', { name: 'Voltar para a Central' })
    expect(screen.queryByRole('region', { name: 'Central' })).toBeNull()
    expect(anchor.convId).toBe('c1')
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByRole('region', { name: 'Central' })).toBeTruthy())
  })

  it('abrir outra conversa por fora apaga o "← Central"', async () => {
    render(<UiProvider><App /></UiProvider>)
    await send('oi')
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('delivered'))
    fireEvent.click(await within(centralPanel()).findByRole('button', { name: 'proj · Conversa' }))
    expect(await screen.findByRole('button', { name: 'Voltar para a Central' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: /Central.*fale com o agent/ }))
    fireEvent.click((await screen.findAllByTitle(/^Conversa — duplo-clique para renomear$/))[0])
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Central' })).toBeNull())
    expect(screen.queryByRole('button', { name: 'Voltar para a Central' })).toBeNull()
  })

  it('pergunta do destino com a Central aberta: aparece no painel (sem toast) e o clique responde no convId do destino', async () => {
    render(<UiProvider><App /></UiProvider>)
    await send('escurece o tema')
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('delivered'))
    await act(async () => cbs.perm?.({ convId: 'c1', req: question() }))
    const card = await within(centralPanel()).findByRole('group', { name: 'proj · Conversa pergunta' })
    expect(screen.queryByText(/está aguardando/)).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Escuro' }))
    await waitFor(() =>
      expect(api.respondPermission).toHaveBeenCalledWith('c1', { id: 'p1', behavior: 'allow', answers: [{ header: 'Cor', question: 'Qual tom?', selected: ['Escuro'] }] })
    )
    await waitFor(() => expect(centralEntries().some((e) => e.kind === 'question')).toBe(true))
  })

  it('"outro…" abre o QuestionModal do destino a partir da Central', async () => {
    render(<UiProvider><App /></UiProvider>)
    await send('escurece o tema')
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('delivered'))
    await act(async () => cbs.perm?.({ convId: 'c1', req: question() }))
    fireEvent.click(await within(centralPanel()).findByRole('button', { name: 'outro…' }))
    expect(await screen.findByText('Qual tom?', { selector: '.question-modal *, [role="dialog"] *' }).catch(() => screen.findAllByText('Qual tom?'))).toBeTruthy()
    expect(screen.getAllByText('Qual tom?').length).toBeGreaterThan(1)
  })
})

describe('fiação do celular', () => {
  it('a escolha remota chama choose (entrega no destino) e o retrato publicado inclui a Central', async () => {
    route = asking
    api.remoteStatus.mockResolvedValue({ running: true, url: '', ip: '', port: 0, token: '', clients: 1, relayConnected: false })
    render(<UiProvider><App /></UiProvider>)
    await send('deixa mais escuro')
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('asking'))
    const id = centralRequests()[0].id
    await act(async () => cbs.remoteChoose?.({ entryId: id, option: 0 }))
    await waitFor(() => expect(sentTexts(api)).toEqual(['deixa mais escuro']))
    await waitFor(() => {
      const calls = api.publishRemoteState.mock.calls as unknown as Array<[{ conversations: Array<{ id: string; central?: { entries: { id: string }[] } }> }]>
      const last = calls.at(-1)?.[0].conversations.find((c) => c.id === 'central')
      expect(last?.central?.entries.map((e) => e.id)).toContain(id)
    })
  })

  it('resposta do celular a pergunta de destino ancorado: responde uma vez e registra a linha na Central', async () => {
    render(<UiProvider><App /></UiProvider>)
    await send('escurece o tema')
    await waitFor(() => expect(centralRequests()[0]?.state).toBe('delivered'))
    await act(async () => cbs.perm?.({ convId: 'c1', req: question('p9') }))
    await within(centralPanel()).findByRole('group', { name: 'proj · Conversa pergunta' })
    const res = { id: 'p9', behavior: 'allow' as const, answers: [{ header: 'Cor', question: 'Qual tom?', selected: ['Claro'] }] }
    await act(async () => cbs.remotePerm?.({ convId: 'c1', res }))
    await waitFor(() => expect(centralEntries().some((e) => e.kind === 'question')).toBe(true))
    expect(api.respondPermission).toHaveBeenCalledTimes(1)
    expect(api.respondPermission).toHaveBeenCalledWith('c1', res)
  })
})
