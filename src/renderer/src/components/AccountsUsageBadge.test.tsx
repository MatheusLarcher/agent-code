import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ClaudeAccountView } from '@shared/claudeAccounts'
import type { RateLimitStatus } from '@shared/ipc'
import { AccountsUsageBadge } from './AccountsUsageBadge'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const FUTURE = Date.now() + 3_600_000
const account = (id: string, label: string, pct: number, status: ClaudeAccountView['status'] = 'connected'): ClaudeAccountView => ({
  id,
  label,
  email: `${id}@exemplo.com`,
  plan: 'max',
  rateLimitTier: null,
  status,
  isDefault: id === 'default',
  usage: { at: Date.now() - 5 * 60_000, windows: { five_hour: { utilization: pct, resetsAt: FUTURE } } }
})
const gpt: RateLimitStatus = { rateLimitType: 'gpt_primary', status: 'allowed', utilization: 0.3, windowMinutes: 300 }

function setup(accounts: ClaudeAccountView[], usage = vi.fn()) {
  vi.stubGlobal('api', { claudeAccountsUsage: usage })
  Object.assign(window, { api: { claudeAccountsUsage: usage } })
  const props = {
    accounts,
    activeAccountId: 'default',
    canUseInConversation: true,
    gptLimits: [gpt],
    shownInBar: {},
    onShownInBarChange: vi.fn(),
    onUseAccount: vi.fn(),
    onRelogin: vi.fn(),
    onManage: vi.fn()
  }
  return { ...render(<AccountsUsageBadge {...props} />), props, usage }
}

describe('painel de consumo com várias contas', () => {
  it('barra fechada mostra a conta da conversa aberta, com o apelido', () => {
    const { getByText } = setup([account('default', 'Pessoal', 40), account('b', 'Trabalho', 90)])
    expect(getByText('Claude · Pessoal')).toBeTruthy()
    expect(getByText('40%')).toBeTruthy()
  })

  it('2 contas Claude + GPT = 3 seções; consulta cada conta uma vez e atualiza a seção', async () => {
    const usage = vi.fn(async (_force: boolean, id: string) => [
      { accountId: id, reading: { at: Date.now(), windows: { five_hour: { utilization: id === 'b' ? 91 : 41, resetsAt: FUTURE } } }, fresh: true }
    ])
    const { container, getByLabelText, getAllByText, getByText } = setup([account('default', 'Pessoal', 40), account('b', 'Trabalho', 90)], usage)
    fireEvent.click(getByLabelText('Detalhar consumo'))
    expect(container.querySelectorAll('.usage-popover-section')).toHaveLength(3)
    expect(getAllByText('atualizando…').length).toBe(2)
    await waitFor(() => expect(getByText('91%')).toBeTruthy())
    expect(usage).toHaveBeenCalledTimes(2)
    expect(usage.mock.calls.map(([force, id]) => [force, id])).toEqual([[false, 'default'], [false, 'b']])
    // A conta da conversa fica marcada; a outra tem a troca manual.
    expect(container.querySelector('.usage-account-active')?.textContent).toContain('Pessoal')
    fireEvent.click(getByText('Usar nesta conversa'))
  })

  it('consulta falhando mantém o valor antigo com a idade da leitura', async () => {
    const usage = vi.fn(async (_force: boolean, id: string) => [{ accountId: id, reading: null, fresh: false }])
    const { getByLabelText, getAllByText } = setup([account('default', 'Pessoal', 40), account('b', 'Trabalho', 90)], usage)
    fireEvent.click(getByLabelText('Detalhar consumo'))
    await waitFor(() => expect(getAllByText('atualizado há 5 min').length).toBe(2))
  })

  it('login expirado aparece com "Entrar de novo" e não é consultado', async () => {
    const usage = vi.fn(async (_force: boolean, id: string) => [{ accountId: id, reading: null, fresh: true }])
    const { getByLabelText, getByText, props } = setup([account('default', 'Pessoal', 40), account('b', 'Trabalho', 90, 'expired')], usage)
    await act(async () => {
      fireEvent.click(getByLabelText('Detalhar consumo'))
    })
    expect(usage).toHaveBeenCalledTimes(1)
    fireEvent.click(getByText('Entrar de novo'))
    expect(props.onRelogin).toHaveBeenCalledWith('b')
    fireEvent.click(getByText('Gerenciar contas'))
    expect(props.onManage).toHaveBeenCalled()
  })
})
