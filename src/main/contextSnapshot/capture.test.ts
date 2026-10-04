// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ContextCapture, readLiveContext, countLiveContext } from './capture'
import type { ContextHistoryRepository, ContextTurnWrite } from '../persistence/types'
import { composeFromPromptBlocks } from './blocks'
const parts = { stamp: 'stamp', memory: '', skills: '', projects: '', reminder: '' }
function setup(provider: 'claude' | 'gpt' | 'ollama' = 'claude') {
  const writes: ContextTurnWrite[] = []
  const repository = { saveContextTurn: vi.fn(async (w: ContextTurnWrite) => { writes.push(w) }) } as unknown as ContextHistoryRepository
  const usage = vi.fn(async () => ({ totalTokens: 42, maxTokens: 200, percentage: 21, categories: [{ name: 'Messages', kind: 'used', tokens: 42 }] }))
  const changed = vi.fn()
  const c = new ContextCapture({ convId: 'c1', pc: 'PC', model: 'model', provider }, repository, changed, () => ({ getContextUsage: usage }))
  return { c, writes, repository, usage, changed }
}
describe('context capture', () => {
  it('segundo envio em fila não rouba hooks do turno ainda em execução', async () => {
    const { c } = setup()
    c.sent('a', 'primeiro', 'primeiro', parts); c.activate('a')
    c.hook({ docs: 'início a', memory: '' }, 'hook-start')
    c.sent('b', 'segundo', 'segundo', parts); c.activate('b')
    c.hook({ docs: 'meio a', memory: '' }, 'hook-mid')
    expect(readLiveContext('c1', 'a')!.blocks.some((b) => b.text === 'meio a')).toBe(true)
    expect(readLiveContext('c1', 'b')!.blocks.some((b) => b.text === 'meio a')).toBe(false)
    await c.finish(['a'])
    c.hook({ docs: 'início b', memory: '' }, 'hook-start')
    expect(readLiveContext('c1', 'b')!.blocks.some((b) => b.text === 'início b')).toBe(true)
    c.dispose()
  })
  it('grava prompt, hooks realmente retornados e resultado sob uuid do envio', async () => {
    const { c, writes, usage } = setup()
    c.configure('append', [], { executor: { prompt: 'instruções' } })
    c.sent('uuid', 'pedido', 'pedido', parts)
    c.activate('uuid')
    c.hook({ docs: 'docs', memory: '--- Memória relevante: lexical.md ---\nmemória' }, 'hook-start')
    c.hook({ docs: 'docs2', memory: '' }, 'hook-mid')
    c.subagent('tool-id', { subagent_type: 'executor', prompt: 'delegação' })
    await c.finish(['uuid'])
    await c.flush()
    const detail = readLiveContext('c1', 'uuid')!
    expect(detail).toMatchObject({ turnId: 'uuid', complete: true, pc: 'PC', memoriesSent: ['lexical.md'], usage: { totalTokens: 42, detail: 'summary' } })
    expect(composeFromPromptBlocks(detail.blocks.filter((b) => b.source === 'prompt'))).toBe('stamp\n\npedido')
    expect(detail.blocks.filter((b) => b.source === 'hook-start').map((b) => b.text).join('\n\n')).toBe('docs\n\n--- Memória relevante: lexical.md ---\nmemória')
    expect(detail.blocks.some((b) => b.source === 'hook-mid' && b.text === 'docs2')).toBe(true)
    expect(readLiveContext('c1', 'uuid', 'tool-id')!.blocks.map((b) => b.text)).toEqual(['instruções', 'delegação'])
    expect(writes[0].complete).toBe(false)
    expect(writes.at(-1)!.complete).toBe(true)
    expect(usage).toHaveBeenCalledWith({ detail: 'summary' })
    expect((await countLiveContext('c1'))!.usage?.detail).toBe('full')
    c.dispose()
  })
  it.each(['X', 'YZ', 'UVW', 'senha-real'])('nenhum valor %s vai ao banco ou à leitura', async (value) => {
    const { c, writes } = setup()
    c.configure(`append ${value}`, [{ name: 'vault', value }], {})
    c.sent('u', `pedido ${value}`, `pedido ${value}`, parts)
    c.activate('u')
    c.hook({ docs: `docs ${value}`, memory: `trecho ${value}` }, 'hook-start')
    await c.finish(['u'])
    await c.flush()
    expect(JSON.stringify(writes)).not.toContain(value)
    expect(JSON.stringify(readLiveContext('c1', 'u'))).not.toContain(value)
    c.dispose()
  })
  it.each(['gpt', 'ollama'] as const)('não conta exato pela rota %s', async (provider) => {
    const { c, usage } = setup(provider)
    c.configure('', [], {})
    expect(await countLiveContext('c1')).toMatchObject({ ok: false, reason: expect.stringContaining(provider) })
    expect(usage).not.toHaveBeenCalled()
    c.dispose()
  })
  it('timeout de contagem devolve último resumo, nunca rejeita IPC', async () => {
    const { c, usage } = setup()
    c.sent('u', 'p', 'p', parts); c.activate('u')
    await c.finish(['u'])
    usage.mockImplementationOnce(() => new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const counting = c.countExact()
      await vi.advanceTimersByTimeAsync(8001)
      expect(await counting).toMatchObject({ ok: false, usage: { detail: 'summary', totalTokens: 42 }, reason: expect.any(String) })
    } finally { vi.useRealTimers(); c.dispose() }
  })
  it('falha do resumo não atrasa conclusão best-effort', async () => {
    const { c, usage } = setup()
    c.sent('u', 'p', 'p', parts); c.activate('u')
    usage.mockImplementationOnce(() => new Promise(() => {}))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      const finishing = c.finish(['u'])
      expect(readLiveContext('c1', 'u')!.complete).toBe(true)
      await vi.advanceTimersByTimeAsync(1501)
      await finishing
      expect(readLiveContext('c1', 'u')!.usage).toBeNull()
    } finally { vi.useRealTimers(); c.dispose(); warn.mockRestore() }
  })
  it('falha do repositório não rejeita hook nem resultado', async () => {
    const { c, repository } = setup()
    vi.mocked(repository.saveContextTurn).mockRejectedValue(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    c.sent('u', 'p', 'p', parts)
    c.activate('u')
    c.hook({ docs: 'd', memory: '' }, 'hook-start')
    await expect(c.finish(['u'])).resolves.toBeUndefined()
    await c.flush()
    expect(warn).toHaveBeenCalled()
    c.dispose(); warn.mockRestore()
  })
})
