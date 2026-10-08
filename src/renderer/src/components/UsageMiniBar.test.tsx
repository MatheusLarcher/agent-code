/**
 * A barrinha de consumo do chat flutuante do Escritório (UsageMiniBar): a barra
 * fatiada por tipo de consumo, o cartão ao passar o mouse (ou focar), o clique que
 * abre o painel por agente e o nível do contexto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { contextLimitFor, type TokenUsageHistory } from '@shared/ipc'
import { emptyUsageMap, reduceUsage } from '../tokenUsageTree'
import { UsageMiniBar, type UsageMiniBarProps } from './UsageMiniBar'

const MODEL = 'claude-opus-5-5'
const LIMIT = contextLimitFor(MODEL)
const HISTORY: TokenUsageHistory = {
  calls: [],
  totals: [{ convId: 'c1', day: '2026-10-05', model: MODEL, subagentType: null, sumInput: 12_304, sumOutput: 9_870, sumCacheRead: 450_211, sumCacheWrite: 30_022, sumCost: null, callCount: 18 }]
}

let getHistory: ReturnType<typeof vi.fn>

function setup(over: Partial<UsageMiniBarProps> = {}, history: TokenUsageHistory = HISTORY) {
  getHistory = vi.fn(async () => history)
  ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: getHistory }
  const onToggle = vi.fn()
  const props: UsageMiniBarProps = {
    convId: 'c1',
    tokens: { context: 45_231, output: 9_870, cost: 0.4234, lastOutput: 1_204, lastCost: 0.031 },
    usageMap: emptyUsageMap,
    model: MODEL,
    runningSince: null,
    lastDurationMs: 62_000,
    timeTotals: null,
    open: false,
    onToggle,
    ...over
  }
  const view = render(<UsageMiniBar {...props} />)
  return { onToggle, props, view, root: screen.getByTestId('usage-mini'), button: screen.getByRole('button') }
}

const slices = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.um-slice')]
/** O histórico chegou: a barra tem as fatias. */
const loaded = async (root: HTMLElement): Promise<void> => {
  await waitFor(() => expect(slices(root).length).toBeGreaterThan(0))
}

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (window as unknown as { api?: unknown }).api
})

describe('UsageMiniBar — a barra fatiada', () => {
  it('uma fatia por tipo de consumo, do tamanho do que ele consumiu (entrada, cache lido, cache escrito, saída); o rótulo diz o total, o contexto e o custo', async () => {
    const { root, button } = setup()
    await loaded(root)
    expect(getHistory).toHaveBeenCalledWith('c1')
    expect(slices(root).map((s) => [s.className.replace('um-slice ', ''), s.style.flexGrow])).toEqual([
      ['um-input', '12304'],
      ['um-cacheRead', '450211'],
      ['um-cacheWrite', '30022'],
      ['um-output', '9870']
    ])
    const pct = Math.round((45_231 / LIMIT) * 100)
    expect(button.getAttribute('aria-label')).toBe(`Consumo de tokens: 502.407 no total, contexto em ${pct}%, ~US$ 0,42. Clique para detalhar por agente e subagente.`)
    expect(root.querySelector('.token-meter')).toBeNull()
  })

  it('sem consumo: a barra vazia; o tipo que não consumiu não ganha fatia', async () => {
    const { root } = setup({}, { calls: [], totals: [] })
    await act(async () => {})
    expect(root.querySelector('.um-track')?.classList.contains('um-none')).toBe(true)
    expect(slices(root)).toHaveLength(0)
    cleanup()
    const only = setup({}, { calls: [], totals: [{ ...HISTORY.totals[0], sumCacheRead: 0, sumCacheWrite: 0 }] })
    await loaded(only.root)
    expect(slices(only.root).map((s) => s.className)).toEqual(['um-slice um-input', 'um-slice um-output'])
  })

  it('as chamadas ao vivo entram na barra (sem histórico no banco, ou sem window.api, vale só o ao vivo)', async () => {
    const usageMap = reduceUsage(emptyUsageMap, { kind: 'llm-call', node_id: 'n1', parent_node_id: null, seq: 0, model: MODEL, tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, inputPreview: '', outputPreview: '', createdAt: 1 } as never)
    const { root } = setup({ usageMap }, { calls: [], totals: [] })
    await loaded(root)
    expect(slices(root).map((s) => [s.className.replace('um-slice ', ''), s.style.flexGrow])).toEqual([['um-input', '100'], ['um-output', '50']])
    cleanup()
    delete (window as unknown as { api?: unknown }).api
    render(<UsageMiniBar {...({ convId: 'c1', tokens: { context: 0, output: 0, cost: 0 }, usageMap, model: MODEL, runningSince: null, lastDurationMs: null, timeTotals: null, open: false, onToggle: () => {} } as UsageMiniBarProps)} />)
    expect([...document.querySelectorAll('.um-slice')]).toHaveLength(2)
  })

  it('o contexto perto do limite pinta a barra sem precisar do mouse: ok, âmbar a partir de 80% e vermelho a partir de 95%', async () => {
    const level = (ctx: number): string | null => {
      const { root } = setup({ tokens: { context: ctx, output: 0, cost: 0 } })
      const lvl = root.getAttribute('data-level')
      cleanup()
      return lvl
    }
    expect([level(LIMIT * 0.5), level(LIMIT * 0.8), level(LIMIT * 0.95), level(LIMIT * 2)]).toEqual(['ok', 'warn', 'crit', 'crit'])
  })
})

describe('UsageMiniBar — o cartão ao passar o mouse', () => {
  it('cada fatia com o que é, o número exato e a parte do total; o contexto agora contra o limite; o tempo; o custo da conversa e o da última resposta', async () => {
    const { root } = setup()
    await loaded(root)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.mouseEnter(root)
    const tip = screen.getByRole('tooltip')
    expect(within(tip).getByText('Consumo desta conversa')).toBeTruthy()
    expect(within(tip).getByText('18 chamadas')).toBeTruthy()
    const rows = [...tip.querySelectorAll('.um-legend li')].map((li) => [li.querySelector('.um-name')?.textContent, li.querySelector('.um-num')?.textContent, li.querySelector('.um-pct')?.textContent])
    expect(rows).toEqual([['Entrada', '12.304', '2,4%'], ['Cache lido', '450.211', '89,6%'], ['Cache escrito', '30.022', '6%'], ['Saída', '9.870', '2%']])
    expect(within(tip).getByText('reaproveitados do cache, bem mais baratos')).toBeTruthy()
    const ctx = tip.querySelector('.um-ctx')!
    expect(ctx.textContent).toContain(`45.231 / ${LIMIT.toLocaleString('pt-BR')}`)
    expect(ctx.textContent).toContain(`${((45_231 / LIMIT) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`)
    const foot = tip.querySelector('.um-foot')!
    expect(foot.textContent).toContain('⏱ 1m 02s')
    expect(foot.textContent).toContain('última tarefa')
    expect(foot.textContent).toContain('~US$ 0,42')
    expect(foot.textContent).toContain('nesta conversa')
    expect(foot.textContent).toContain('Última resposta')
    expect(foot.textContent).toContain('~US$ 0,03')
    expect(foot.textContent).toContain('1.204 tokens de saída')
    expect(within(tip).getByText('Clique para ver por agente e subagente')).toBeTruthy()
    expect(screen.getByRole('button').getAttribute('aria-describedby')).toBe(tip.id)
    fireEvent.mouseLeave(root)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('sem consumo: o cartão diz que não há; sem a última resposta, a linha dela não aparece', async () => {
    const { root } = setup({ tokens: { context: 0, output: 0, cost: 0 } }, { calls: [], totals: [] })
    await act(async () => {})
    fireEvent.mouseEnter(root)
    const tip = screen.getByRole('tooltip')
    expect(within(tip).getByText('Nenhum consumo ainda nesta conversa.')).toBeTruthy()
    expect(tip.textContent).toContain('0 chamadas')
    expect(tip.textContent).toContain('US$ 0,00')
    expect(tip.textContent).not.toContain('Última resposta')
  })

  it('o teclado também vê: focar mostra o cartão e sair do foco o esconde; Esc o fecha sem passar adiante, e só então', () => {
    const outer = vi.fn()
    ;(window as unknown as { api: unknown }).api = { getTokenUsageHistory: vi.fn(async () => HISTORY) }
    // Um ouvinte acima, como o do palco: o Esc do cartão não pode chegar nele.
    render(
      <div onKeyDown={outer}>
        <UsageMiniBar convId="c1" tokens={{ context: 1, output: 1, cost: 0 }} usageMap={emptyUsageMap} model={MODEL} runningSince={null} lastDurationMs={null} timeTotals={null} open={false} onToggle={() => {}} />
      </div>
    )
    const btn = screen.getByRole('button')
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(outer).toHaveBeenCalledTimes(1) // sem cartão, o Esc segue o caminho dele
    fireEvent.focus(btn)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(btn, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(outer).toHaveBeenCalledTimes(1)
    fireEvent.blur(btn)
    fireEvent.focus(btn)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.blur(btn)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('o relógio da tarefa em execução corre só com o cartão à vista', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const { root } = setup({ runningSince: 1_000_000 - 5_000 })
    expect(root.classList.contains('running')).toBe(true)
    fireEvent.mouseEnter(root)
    expect(screen.getByRole('tooltip').textContent).toContain('⏱ 5s')
    expect(screen.getByRole('tooltip').textContent).toContain('em execução')
    act(() => {
      vi.advanceTimersByTime(3_000)
    })
    expect(screen.getByRole('tooltip').textContent).toContain('⏱ 8s')
    fireEvent.mouseLeave(root)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('UsageMiniBar — o clique', () => {
  it('abre e fecha o painel por agente (quem hospeda decide); com ele aberto o cartão não aparece e o botão diz que está expandido', async () => {
    const { root, button, onToggle, view, props } = setup()
    await loaded(root)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.mouseEnter(root)
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
    view.rerender(<UsageMiniBar {...props} open />)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Clique para esconder por agente e subagente')
  })
})
