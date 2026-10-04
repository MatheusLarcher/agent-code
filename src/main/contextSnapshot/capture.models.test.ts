// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { ContextCapture, readLiveContext } from './capture'
import { composeFromPromptBlocks } from './blocks'
import type { ContextHistoryRepository, ContextTurnWrite } from '../persistence/types'

const parts = { stamp: 'stamp', memory: '', skills: '', projects: '', reminder: '' }
const OPUS = 'claude-opus-5-5'
const SOL = 'gpt-6.1-sol'

function capture(convId: string, model = OPUS, provider: 'claude' | 'gpt' = 'claude') {
  const writes: ContextTurnWrite[] = []
  const repository = { saveContextTurn: vi.fn(async (w: ContextTurnWrite) => { writes.push(w) }) } as unknown as ContextHistoryRepository
  const changed = vi.fn()
  const c = new ContextCapture({ convId, pc: 'PC', model, provider }, repository, changed, () => null)
  return { c, writes, changed }
}

describe('ContextCapture — modelos do turno', () => {
  it('soma as chamadas por (nó, modelo) na ordem de entrada, grava no fim e avisa só o que é novo', async () => {
    const { c, writes, changed } = capture('m-ordem')
    c.sent('u', 'pedido', 'pedido', parts); c.activate('u')
    changed.mockClear()
    c.llmCall(OPUS, null)
    c.llmCall(OPUS, null)
    c.llmCall('claude-haiku-4-5', 'task-1')
    c.llmCall(SOL, null)
    c.llmCall(OPUS, null)
    expect(changed).toHaveBeenCalledTimes(3)
    expect(readLiveContext('m-ordem', 'u')!.models).toEqual([
      { model: OPUS, calls: 3, node: null },
      { model: 'claude-haiku-4-5', calls: 1, node: 'task-1' },
      { model: SOL, calls: 1, node: null }
    ])
    await c.finish(['u']); await c.flush()
    expect(writes.at(-1)!.models).toHaveLength(3)
    // o subagente vê só o nó dele
    expect(readLiveContext('m-ordem', 'u', 'task-1')!.models).toEqual([{ model: 'claude-haiku-4-5', calls: 1, node: 'task-1' }])
    c.dispose()
  })

  it('ignora vazio, o sentinela do Automático e chamada sem turno ativo', () => {
    const { c } = capture('m-ignora')
    c.llmCall(OPUS, null)
    c.sent('u', 'p', 'p', parts); c.activate('u')
    c.llmCall('', null)
    c.llmCall('auto', null)
    c.llmCall('  ', 'task')
    expect(readLiveContext('m-ignora', 'u')!.models).toEqual([])
    c.dispose()
  })

  it('o modelo do resumo é o da sessão e nunca o sentinela do Automático', () => {
    const fixed = capture('m-sessao', SOL)
    fixed.c.sent('u', 'p', 'p', parts)
    expect(readLiveContext('m-sessao', 'u')).toMatchObject({ model: SOL, models: [] })
    fixed.c.dispose()
    const auto = capture('m-auto', 'auto')
    auto.c.sent('u', 'p', 'p', parts)
    expect(readLiveContext('m-auto', 'u')!.model).toBe('')
    auto.c.dispose()
  })

  it('continuação da troca de sessão (recovery) segue o MESMO turno, com os dois modelos', async () => {
    // Sessão 1 (Opus): o turno do usuário, que termina na cota.
    const first = capture('m-troca', OPUS)
    first.c.configure('append da sessão 1', [], {})
    first.c.sent('user-1', 'arruma o login', 'arruma o login', parts); first.c.activate('user-1')
    first.c.hook({ docs: 'docs', memory: '' }, 'hook-start')
    first.c.llmCall(OPUS, null); first.c.llmCall(OPUS, null)
    await first.c.finish(['user-1']); await first.c.flush()
    first.c.dispose()

    // Sessão 2 (GPT), criada pela troca: manda a continuação interna.
    const second = capture('m-troca', SOL, 'gpt')
    second.c.configure('append da sessão 2', [], {})
    second.c.sent('cont-1', 'Continue a tarefa', 'Continue a tarefa', parts, undefined, 0, false, 'recovery')
    second.c.activate('cont-1')
    second.c.hook({ docs: 'docs de novo', memory: '' }, 'hook-start')
    second.c.llmCall(SOL, null)
    const live = readLiveContext('m-troca', 'user-1')!
    expect(live).toMatchObject({ turnId: 'user-1', complete: false, request: 'arruma o login' })
    expect(live.models).toEqual([{ model: OPUS, calls: 2, node: null }, { model: SOL, calls: 1, node: null }])
    // os blocos do envio original ficam intactos; a continuação entra como tal
    expect(composeFromPromptBlocks(live.blocks.filter((b) => b.source === 'prompt'))).toBe('stamp\n\narruma o login')
    const cont = live.blocks.filter((b) => b.source === 'continuation')
    expect(cont.map((b) => b.text)).toEqual(['stamp', 'Continue a tarefa', 'docs de novo'])
    expect(cont.find((b) => b.text === 'Continue a tarefa')!.label).toBe('Continuação automática')
    expect(live.blocks.filter((b) => b.kind === 'system-append').map((b) => b.text)).toEqual(['append da sessão 1', 'append da sessão 2'])
    // o uuid da continuação é apelido do turno do usuário
    expect(readLiveContext('m-troca', 'cont-1')!.turnId).toBe('user-1')
    await second.c.finish(['cont-1']); await second.c.flush()
    const saved = second.writes.at(-1)!
    expect(saved).toMatchObject({ turnId: 'user-1', complete: true })
    expect(saved.models.map((m) => m.model)).toEqual([OPUS, SOL])
    expect(second.writes.every((w) => w.turnId === 'user-1')).toBe(true)
    second.c.dispose()
  })

  it('continuação sem turno anterior conhecido abre turno novo; envio normal nunca adota', () => {
    const { c } = capture('m-sem-anterior')
    c.sent('cont', 'Continue', 'Continue', parts, undefined, 0, false, 'recovery')
    expect(readLiveContext('m-sem-anterior', 'cont')).toMatchObject({ turnId: 'cont', request: 'Continue' })
    c.sent('outro', 'novo pedido', 'novo pedido', parts, undefined, 0, false, 'normal')
    expect(readLiveContext('m-sem-anterior', 'outro')!.turnId).toBe('outro')
    c.dispose()
  })
})
