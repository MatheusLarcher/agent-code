// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { BoardItem } from '../../shared/ipc'
import type { PoChatMessage } from '../../shared/poChat'
import { poAgentOptions, type PoAgentResult } from '../po/poAgentQuery'
import { PoChatService, type PoChatDeps } from './poChatService'
import { PoChatStore } from './poChatStore'
import { quietCommandAllowed, verifyGuard, verifyTimeoutMs } from './poChatVerify'

/**
 * "Verificar de verdade" com o SDK simulado: o teto de tempo, a trava de
 * código com agente rodando no projeto (só leitura de arquivo e git de
 * leitura), a correção do quadro só no clique, cancelar e falhar sem mudar nada.
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0)
let dir = ''

function item(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id, projectId: 'p1', projectCwd: 'C:/loja', conversationId: 'conv-a', origin: 'agent', sourceId: id, sourceTitle: `Tarefa ${id}`,
    sourceStatus: 'completed', activeForm: null, seq: 0, poTitle: null, poNote: null, poStatus: null, poReason: null, poAt: null,
    dismissedAt: null, revision: 1, createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T11:58:00.000Z', ...over
  }
}

const quick: PoChatMessage = {
  id: 'quick',
  role: 'po',
  text: 'A tarefa a está concluída.',
  at: NOW,
  sources: [{ kind: 'conversa', conversationId: 'conv-a', title: 'Implementação', at: NOW }],
  unconfirmed: 'ninguém viu no código',
  options: [{ kind: 'verificar', minutes: 4, question: 'Está pronto?' }]
}

function result(over: Partial<PoAgentResult> = {}): PoAgentResult {
  return { state: 'completed', text: '', transcript: '', tools: [], turns: 3, ...over }
}

async function setup(over: Partial<PoChatDeps> = {}) {
  const store = new PoChatStore(dir)
  await store.append('c:/loja', quick)
  const applyCorrection = vi.fn(async () => undefined)
  const verify = vi.fn(async (_input: Parameters<NonNullable<PoChatDeps['verify']>>[0]) =>
    result({
      text: [
        'A tarefa a NÃO está pronta [K1]: o teste do login falha.',
        'EVIDENCIA: li src/login.ts',
        'EVIDENCIA: rodei npm test (2 falhas)',
        'DIFERENCA: o agente disse que terminou, mas o teste falha',
        'REABRIR: K1 | o teste do login falha',
        'CRIAR: C1 | Corrigir o teste do login'
      ].join('\n')
    })
  )
  const d: PoChatDeps = {
    store,
    key: (cwd) => cwd.toLowerCase(),
    board: async () => ({ projectId: 'p1', items: [item('a')] }),
    prints: async () => [],
    envios: async () => [],
    queue: async () => [],
    conversations: async () => [{ id: 'conv-a', payload: { title: 'Implementação', messages: [] } }],
    tasks: async () => [],
    ask: async () => '',
    projectBusy: () => false,
    verify,
    applyCorrection,
    now: () => NOW,
    ...over
  }
  return { service: new PoChatService(d), verify, applyCorrection, store }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-po-verify-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const pre = (tool_name: string, tool_input: unknown): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: 'C:/loja' }) as unknown as HookInput
const signal = (): AbortSignal => new AbortController().signal
type Deny = { hookSpecificOutput?: { permissionDecision?: string } }

describe('trava e teto da verificação', () => {
  it('teto: o dobro do que o PO avisou, entre 3 e 15 min', () => {
    expect(verifyTimeoutMs(1)).toBe(3 * 60_000)
    expect(verifyTimeoutMs(4)).toBe(8 * 60_000)
    expect(verifyTimeoutMs(40)).toBe(15 * 60_000)
  })

  it('com agente rodando: só leitura de arquivo e git de leitura (sem encadear); sem agente, a trava não age', async () => {
    let busy = true
    const guard = verifyGuard(() => busy)
    const run = async (name: string, input: unknown): Promise<string | undefined> => ((await guard(pre(name, input), 't', { signal: signal() })) as Deny).hookSpecificOutput?.permissionDecision
    expect(await run('Bash', { command: 'npm test' })).toBe('deny')
    expect(await run('Bash', { command: 'npm run build' })).toBe('deny')
    expect(await run('Bash', { command: 'git status' })).toBeUndefined()
    expect(await run('Bash', { command: 'git diff HEAD~1 -- src/login.ts' })).toBeUndefined()
    expect(await run('Bash', { command: 'git log && npm test' })).toBe('deny')
    expect(await run('Write', { file_path: 'x' })).toBe('deny')
    expect(await run('Read', { file_path: 'src/login.ts' })).toBeUndefined()
    expect(await run('mcp__app__app_anexar_print', { arquivo: 'a.png' })).toBeUndefined()
    busy = false
    expect(await run('Bash', { command: 'npm test' })).toBeUndefined()
    expect(quietCommandAllowed('git status | head')).toBe(false)
  })

  it('as opções do SDK levam a trava (PreToolUse) e o servidor do print, além das travas do PO', () => {
    const hook = verifyGuard(() => true)
    const options = poAgentOptions({ prompt: 'p', cwd: 'C:/loja', model: 'm', hooks: { PreToolUse: [{ hooks: [hook] }] }, mcpServers: { app: { type: 'stdio', command: 'x' } } }, new AbortController())
    expect(options.hooks?.PreToolUse?.[0].hooks[0]).toBe(hook)
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['app'])
    expect(options.disallowedTools).toContain('Bash(git commit*)')
    expect(options.permissionMode).toBe('auto')
  })
})

describe('PoChatService.verify / apply', () => {
  it('a resposta verificada traz evidências, a diferença e as correções como botões — o quadro não muda até o clique', async () => {
    const { service, verify, applyCorrection } = await setup()
    const res = await service.verify('C:/loja', 'quick', signal())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const v = res.messages.at(-1)!
    expect(v).toMatchObject({
      verified: true,
      text: 'A tarefa a NÃO está pronta: o teste do login falha.',
      evidence: ['li src/login.ts', 'rodei npm test (2 falhas)'],
      difference: 'o agente disse que terminou, mas o teste falha'
    })
    expect(v.options).toEqual([
      { kind: 'corrigir', action: 'reabrir', cardId: 'a', conversationId: 'conv-a', title: 'Tarefa a', reason: 'o teste do login falha' },
      { kind: 'corrigir', action: 'criar', conversationId: 'conv-a', conversationTitle: 'Implementação', title: 'Corrigir o teste do login', reason: 'o PO verificou que falta' }
    ])
    expect(applyCorrection).not.toHaveBeenCalled()
    expect(verify.mock.calls[0][0]).toMatchObject({ cwd: 'C:/loja', timeoutMs: 8 * 60_000, conversationId: 'conv-a' })
    expect(verify.mock.calls[0][0].prompt).toMatch(/Nenhum agente está rodando/)
    // O clique aplica uma vez; o segundo é recusado.
    const applied = await service.apply('C:/loja', v.id, 0)
    expect(applyCorrection).toHaveBeenCalledWith('C:/loja', expect.objectContaining({ action: 'reabrir', cardId: 'a' }))
    expect(applied.ok && applied.messages.at(-1)!.options![0]).toMatchObject({ applied: true })
    expect(await service.apply('C:/loja', v.id, 0)).toEqual({ ok: false, message: 'essa correção já foi aplicada' })
    expect(applyCorrection).toHaveBeenCalledTimes(1)
  })

  it('com agente rodando no projeto, o pedido diz que só pode ler — e a trava recebe o mesmo estado', async () => {
    const { service, verify } = await setup({ projectBusy: () => true })
    await service.verify('C:/loja', 'quick', signal())
    const input = verify.mock.calls[0][0]
    expect(input.prompt).toMatch(/Um agente está trabalhando neste projeto AGORA/)
    expect(input.busy()).toBe(true)
  })

  it('cancelar, estourar o tempo ou falhar: um aviso, a resposta rápida fica como estava e o quadro não muda', async () => {
    for (const [state, why] of [['aborted', 'A verificação foi cancelada.'], ['timeout', 'A verificação não terminou a tempo.'], ['failed', 'A verificação falhou: sem conta']] as const) {
      const { service, applyCorrection, store } = await setup({ verify: vi.fn(async () => result({ state, error: state === 'failed' ? 'sem conta' : undefined })) })
      const res = await service.verify('C:/loja', 'quick', signal())
      expect(res.ok && res.messages.at(-1)).toMatchObject({ role: 'po', error: why, text: 'A resposta rápida continua como estava.' })
      expect((await store.read('c:/loja')).find((m) => m.id === 'quick')).toEqual(quick)
      expect(applyCorrection).not.toHaveBeenCalled()
      await rm(dir, { recursive: true, force: true })
      dir = await mkdtemp(join(tmpdir(), 'agent-code-po-verify-'))
    }
  })

  it('resposta sem o botão de verificar: recusa sem rodar nada', async () => {
    const { service, verify, store } = await setup()
    await store.append('c:/loja', { id: 'outra', role: 'po', text: 'ok', at: NOW })
    expect(await service.verify('C:/loja', 'outra', signal())).toEqual({ ok: false, message: 'essa resposta não tem o que verificar' })
    expect(verify).not.toHaveBeenCalled()
  })
})
